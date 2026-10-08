package native

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"

	"github.com/zerlight/XIPU-AI-openai-proxy/internal/bridge"
	"github.com/zerlight/XIPU-AI-openai-proxy/internal/config"
)

func handleRPC(message map[string]json.RawMessage, writer *Writer, handler *bridge.Server, current *config.Config, dir string, runningPort int) (bool, error) {
	var kind string
	json.Unmarshal(message["type"], &kind)
	if kind != "config_get" && kind != "config_set" && kind != "rotate_key" {
		return false, nil
	}
	var id string
	idErr := json.Unmarshal(message["request_id"], &id)
	fail := func(err error) (bool, error) {
		return true, writer.Send(map[string]any{"type": "rpc_error", "request_id": id, "message": err.Error()})
	}
	if idErr != nil || strings.TrimSpace(id) == "" || len(id) > 128 {
		return fail(errors.New("request_id must be a nonempty string of at most 128 bytes"))
	}
	for key := range message {
		if key != "type" && key != "request_id" && !(kind == "config_set" && key == "config") {
			return fail(errors.New("unexpected settings request field"))
		}
	}
	if kind == "rotate_key" {
		key, err := handler.RotateKey(func() (string, error) { return RotateKey(dir) })
		if err != nil {
			return fail(err)
		}
		return true, writer.Send(map[string]any{"type": "key", "request_id": id, "api_key": key})
	}
	if kind == "config_set" {
		updated, err := config.DecodeSettings(message["config"], current.Settings)
		if err != nil {
			return fail(err)
		}
		next := *current
		next.Settings = updated
		if err := handler.UpdateSettings(updated, func() error {
			if updated.Port != runningPort {
				probe, err := net.Listen("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(updated.Port)))
				if err != nil {
					return fmt.Errorf("port %d is unavailable; settings were not saved: %w", updated.Port, err)
				}
				defer probe.Close()
			}
			return config.Save(dir, next)
		}); err != nil {
			return fail(err)
		}
		*current = next
	}
	return true, writer.Send(map[string]any{"type": "config", "request_id": id, "config": current.Settings, "restart_required": current.Port != runningPort})
}
