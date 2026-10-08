package bridge

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/zerlight/XIPU-AI-openai-proxy/internal/config"
)

type Event struct {
	Job     string          `json:"job"`
	Kind    string          `json:"kind"`
	Message string          `json:"message"`
	Event   json.RawMessage `json:"event"`
	Result  json.RawMessage `json:"result"`
}

type job struct {
	id       string
	events   chan Event
	finished chan struct{}
	settings config.Settings
}

type Options struct {
	Key      string
	Settings config.Settings
	Send     func(any) error
}

var errTimeout = errors.New("Request timed out and was cancelled; request was not retried")
var errIdle = errors.New("Request was idle and was cancelled; request was not retried")
var errMissingText = errors.New("School did not return any text or reasoning")
var errInvalidGeneration = errors.New("School output did not satisfy the requested format")

func errorStatus(err error) (int, string) {
	if errors.Is(err, errInvalidGeneration) {
		return 502, "invalid_generation"
	}
	if errors.Is(err, errTimeout) || errors.Is(err, errIdle) {
		return 504, "bridge_timeout"
	}
	if errors.Is(err, errMissingText) {
		return 502, "missing_result"
	}
	return 502, "upstream_error"
}

type Server struct {
	options Options
	mu      sync.Mutex
	tabs    int
	current *job
	closed  bool
	stopped chan struct{}
}

func New(options Options) *Server {
	return &Server{options: options, stopped: make(chan struct{})}
}

func (s *Server) Settings() config.Settings {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.options.Settings
}

func (s *Server) UpdateSettings(settings config.Settings, persist func() error) error {
	if err := config.ValidateSettings(settings); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.current != nil || s.closed {
		return errors.New("Settings can only be changed while the bridge is idle")
	}
	if err := persist(); err != nil {
		return err
	}
	s.options.Settings = settings
	return nil
}

func (s *Server) RotateKey(persist func() (string, error)) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.current != nil || s.closed {
		return "", errors.New("The API key can only be changed while the bridge is idle")
	}
	key, err := persist()
	if err != nil {
		return "", err
	}
	s.options.Key = key
	return key, nil
}

func (s *Server) authorized(header string) bool {
	return s.options.Key != "" && subtle.ConstantTimeCompare([]byte(header), []byte("Bearer "+s.options.Key)) == 1
}

func (s *Server) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.closed {
		s.closed = true
		close(s.stopped)
	}
}

func (s *Server) Receive(message map[string]json.RawMessage) error {
	var kind string
	json.Unmarshal(message["type"], &kind)
	if kind == "status" {
		var tabs int
		if string(message["tabs"]) == "null" || json.Unmarshal(message["tabs"], &tabs) != nil || tabs < 0 || tabs > 1024 {
			return errors.New("invalid tab count")
		}
		s.mu.Lock()
		s.tabs = tabs
		s.mu.Unlock()
		return nil
	}
	if kind != "evt" {
		return errors.New("invalid native event type")
	}
	var event Event
	if json.Unmarshal(message["evt"], &event) != nil {
		return errors.New("invalid native event")
	}
	switch event.Kind {
	case "event", "result", "lifecycle", "done", "error":
	default:
		return errors.New("invalid native event kind")
	}
	s.mu.Lock()
	active := s.current
	s.mu.Unlock()
	if active == nil || event.Job != active.id {
		return nil
	}
	select {
	case active.events <- event:
	case <-active.finished:
	case <-s.stopped:
	}
	return nil
}

func apiError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{"error": map[string]any{"message": message, "type": "bridge_error", "code": code}})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(value)
}

func loopbackHost(host string) bool {
	if name, _, err := net.SplitHostPort(host); err == nil {
		host = name
	}
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	return ip != nil && ip.IsLoopback()
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Cache-Control", "no-store")
	if !loopbackHost(r.Host) {
		apiError(w, 403, "invalid_host", "Use the loopback endpoint")
		return
	}
	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.URL.Path == "/health" && r.Method == http.MethodGet {
		s.mu.Lock()
		health := map[string]any{"ok": !s.closed, "transport": "native-messaging", "tabs": s.tabs, "busy": s.current != nil}
		s.mu.Unlock()
		writeJSON(w, 200, health)
		return
	}
	chat := r.URL.Path == "/v1/chat/completions" && r.Method == http.MethodPost
	catalog := r.URL.Path == "/v1/models" && r.Method == http.MethodGet
	responses := r.URL.Path == "/v1/responses" && r.Method == http.MethodPost
	if !chat && !catalog && !responses {
		apiError(w, 404, "not_found", "Endpoint not found")
		return
	}
	s.mu.Lock()
	authorized := s.authorized(r.Header.Get("Authorization"))
	s.mu.Unlock()
	if !authorized {
		apiError(w, 401, "invalid_api_key", "Use the local API key shown in the extension popup")
		return
	}
	if responses {
		s.responses(w, r)
	} else if chat {
		s.chat(w, r)
	} else {
		s.catalog(w, r)
	}
}

func (s *Server) start(w http.ResponseWriter, r *http.Request, op string, makePayload func(config.Settings) (any, error)) *job {
	var entropy [16]byte
	if _, err := rand.Read(entropy[:]); err != nil {
		apiError(w, 500, "local_error", "Could not create request identifier")
		return nil
	}
	active := &job{id: hex.EncodeToString(entropy[:]), events: make(chan Event, 32), finished: make(chan struct{})}
	s.mu.Lock()
	if !s.authorized(r.Header.Get("Authorization")) {
		s.mu.Unlock()
		apiError(w, 401, "invalid_api_key", "The local API key changed; update your client configuration")
		return nil
	}
	if s.closed || s.tabs == 0 {
		s.mu.Unlock()
		apiError(w, 503, "tab_unavailable", "Open the logged-in XIPU AI chat tab")
		return nil
	}
	if s.current != nil {
		s.mu.Unlock()
		apiError(w, 503, "bridge_busy", "Another request is in progress; this request was not sent")
		return nil
	}
	active.settings = s.options.Settings
	s.current = active
	s.mu.Unlock()
	// Preparation may fetch images; hold the slot without holding the settings mutex.
	payload, err := makePayload(active.settings)
	if err != nil {
		s.release(active, false)
		if r.Context().Err() != nil {
			return nil
		}
		if errors.Is(err, errTimeout) {
			status, code := errorStatus(err)
			apiError(w, status, code, err.Error())
			return nil
		}
		apiError(w, 400, "invalid_request", err.Error())
		return nil
	}
	if r.Context().Err() != nil {
		s.release(active, false)
		return nil
	}
	request := map[string]any{"type": "req", "job": active.id, "op": op, "payload": payload}
	encoded, err := json.Marshal(request)
	if err != nil || len(encoded) > 24<<20 {
		s.release(active, false)
		apiError(w, 413, "request_too_large", "Request exceeds the native message limit")
		return nil
	}
	if err := s.options.Send(request); err != nil {
		s.release(active, true)
		apiError(w, 502, "native_disconnected", "The native connection could not send this request")
		return nil
	}
	return active
}

func (s *Server) release(active *job, cancel bool) {
	// Send cancellation before another HTTP request can acquire the slot.
	if cancel {
		s.options.Send(map[string]any{"type": "cancel", "job": active.id})
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.current == active {
		close(active.finished)
		s.current = nil
	}
}

func (s *Server) wait(ctx context.Context, active *job, timeout time.Duration, consume func(Event) error) (bool, error) {
	overall := time.NewTimer(timeout)
	defer overall.Stop()
	idleTimeout := time.Duration(active.settings.IdleTimeoutSeconds) * time.Second
	idle := time.NewTimer(idleTimeout)
	defer idle.Stop()
	for {
		select {
		case <-ctx.Done():
			return false, ctx.Err()
		case <-s.stopped:
			return false, errors.New("Native connection closed; request was not retried")
		case <-overall.C:
			return false, errTimeout
		case <-idle.C:
			return false, errIdle
		case event := <-active.events:
			if !idle.Stop() {
				select {
				case <-idle.C:
				default:
				}
			}
			idle.Reset(idleTimeout)
			if event.Kind == "error" || (event.Kind == "done" && event.Message != "") {
				text := event.Message
				if text == "" {
					text = "School request failed"
				}
				return true, errors.New(text)
			}
			if err := consume(event); err != nil {
				return false, err
			}
			if event.Kind == "done" {
				return true, nil
			}
		}
	}
}

func (s *Server) catalog(w http.ResponseWriter, r *http.Request) {
	active := s.start(w, r, "models", func(config.Settings) (any, error) { return map[string]any{}, nil })
	if active == nil {
		return
	}
	var result map[string]any
	complete, err := s.wait(r.Context(), active, time.Duration(active.settings.ModelTimeoutSeconds)*time.Second, func(event Event) error {
		if event.Kind == "result" {
			var err error
			result, err = models(event.Result)
			return err
		}
		return nil
	})
	s.release(active, !complete)
	if r.Context().Err() != nil {
		return
	}
	if err != nil {
		status, code := errorStatus(err)
		apiError(w, status, code, err.Error())
		return
	}
	if result == nil {
		apiError(w, 502, "missing_result", "School did not return a model catalog")
		return
	}
	writeJSON(w, 200, result)
}

func writeSSE(w http.ResponseWriter, event string, value any) error {
	// A stalled local client must not hold the native request slot indefinitely.
	controller := http.NewResponseController(w)
	controller.SetWriteDeadline(time.Now().Add(10 * time.Second))
	defer controller.SetWriteDeadline(time.Time{})
	body, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if event != "" {
		if _, err := io.WriteString(w, "event: "+event+"\n"); err != nil {
			return err
		}
	}
	if _, err := io.WriteString(w, "data: "+string(body)+"\n\n"); err != nil {
		return err
	}
	return controller.Flush()
}

func writeDone(w http.ResponseWriter) {
	controller := http.NewResponseController(w)
	controller.SetWriteDeadline(time.Now().Add(10 * time.Second))
	defer controller.SetWriteDeadline(time.Time{})
	io.WriteString(w, "data: [DONE]\n\n")
	controller.Flush()
}
