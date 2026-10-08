// Package native implements Chrome's length-prefixed JSON transport.
package native

import (
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"sync"
	"unicode/utf8"
)

const MaxInbound = 8 << 20
const MaxOutbound = 1 << 20
const MaxRequest = 24 << 20
const RequestChunkBytes = 256 << 10

func Read(r io.Reader) (map[string]json.RawMessage, error) {
	var header [4]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return nil, err
	}
	n := binary.NativeEndian.Uint32(header[:])
	if n == 0 || n > MaxInbound {
		return nil, errors.New("invalid native message length")
	}
	body := make([]byte, n)
	if _, err := io.ReadFull(r, body); err != nil {
		return nil, err
	}
	if !utf8.Valid(body) {
		return nil, errors.New("native message is not valid UTF-8")
	}
	var message map[string]json.RawMessage
	if err := json.Unmarshal(body, &message); err != nil || message == nil {
		return nil, errors.New("native message must be a JSON object")
	}
	return message, nil
}

type Writer struct {
	mu     sync.Mutex
	Output io.Writer
}

func (w *Writer) Send(message any) error {
	body, err := json.Marshal(message)
	if err != nil {
		return err
	}
	if len(body) > MaxRequest {
		return errors.New("request exceeds the 24 MiB native transfer limit")
	}
	var header struct {
		Type string `json:"type"`
		Job  string `json:"job"`
	}
	if len(body) > MaxOutbound {
		if err := json.Unmarshal(body, &header); err != nil || header.Type != "req" || header.Job == "" || len(header.Job) > 128 {
			return errors.New("only requests can exceed the 1 MiB native message limit")
		}
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if len(body) <= MaxOutbound {
		return w.writeFrame(body)
	}
	total := (len(body) + RequestChunkBytes - 1) / RequestChunkBytes
	for index, start := 0, 0; start < len(body); index, start = index+1, start+RequestChunkBytes {
		end := min(start+RequestChunkBytes, len(body))
		chunk, err := json.Marshal(struct {
			Type  string `json:"type"`
			Job   string `json:"job"`
			Index int    `json:"index"`
			Total int    `json:"total"`
			Size  int    `json:"size"`
			Data  string `json:"data"`
		}{"req_chunk", header.Job, index, total, len(body), base64.StdEncoding.EncodeToString(body[start:end])})
		if err != nil {
			return err
		}
		if err := w.writeFrame(chunk); err != nil {
			return err
		}
	}
	return nil
}

func (w *Writer) writeFrame(body []byte) error {
	if len(body) > MaxOutbound {
		return errors.New("native frame exceeds 1 MiB")
	}
	frame := make([]byte, 4+len(body))
	binary.NativeEndian.PutUint32(frame[:4], uint32(len(body)))
	copy(frame[4:], body)
	for len(frame) > 0 {
		n, err := w.Output.Write(frame)
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrShortWrite
		}
		frame = frame[n:]
	}
	return nil
}
