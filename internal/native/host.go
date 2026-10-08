package native

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"time"

	"github.com/zerlight/XIPU-AI-openai-proxy/internal/bridge"
	"github.com/zerlight/XIPU-AI-openai-proxy/internal/config"
)

// Run keeps stdout reserved for protocol frames and never handles school credentials.
func Run(ctx context.Context, input io.Reader, output io.Writer, origin, dir string) error {
	settings, err := config.Load(dir)
	if err != nil {
		return err
	}
	allowed := false
	for _, entry := range settings.AllowedOrigins {
		if entry == origin {
			allowed = true
			break
		}
	}
	if !allowed {
		return errors.New("Host must be launched by a registered extension origin")
	}
	key, err := ClientKey(dir)
	if err != nil {
		return fmt.Errorf("load local API key: %w", err)
	}
	listener, err := net.Listen("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(settings.Port)))
	if err != nil {
		return fmt.Errorf("listen on loopback: %w", err)
	}
	writer := &Writer{Output: output}
	handler := bridge.New(bridge.Options{Key: key, Settings: settings.Settings, Send: writer.Send})
	server := &http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 1810 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
	defer func() { handler.Close(); server.Close(); listener.Close() }()
	serveErr := make(chan error, 1)
	go func() { serveErr <- server.Serve(listener) }()
	if err := writer.Send(map[string]any{"type": "ready", "base_url": "http://" + listener.Addr().String() + "/v1", "api_key": key, "config": settings.Settings}); err != nil {
		return err
	}
	type incoming struct {
		message map[string]json.RawMessage
		err     error
	}
	messages := make(chan incoming)
	readCtx, stopReading := context.WithCancel(ctx)
	defer stopReading()
	go func() {
		for {
			message, err := Read(input)
			select {
			case messages <- incoming{message, err}:
			case <-readCtx.Done():
				return
			}
			if err != nil {
				return
			}
		}
	}()
	for {
		select {
		case <-ctx.Done():
			return nil
		case err := <-serveErr:
			if errors.Is(err, http.ErrServerClosed) {
				return nil
			}
			return err
		case item := <-messages:
			if errors.Is(item.err, io.EOF) {
				return nil
			}
			if item.err != nil {
				return fmt.Errorf("read native message: %w", item.err)
			}
			if handled, err := handleRPC(item.message, writer, handler, &settings, dir, listener.Addr().(*net.TCPAddr).Port); handled {
				if err != nil {
					return err
				}
				continue
			}
			if err := handler.Receive(item.message); err != nil {
				return err
			}
		}
	}
}
