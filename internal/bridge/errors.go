package bridge

import (
	"encoding/json"
	"errors"
	"net/http"
)

type parameterError struct {
	err   error
	param string
}

func (err *parameterError) Error() string { return err.err.Error() }
func (err *parameterError) Unwrap() error { return err.err }

func atParameter(err error, param string) error {
	if err == nil {
		return nil
	}
	var existing *parameterError
	if errors.As(err, &existing) {
		return err
	}
	return &parameterError{err: err, param: param}
}

func requestError(w http.ResponseWriter, code string, err error) {
	details := map[string]any{"message": err.Error(), "code": code, "type": "invalid_request_error", "stage": "request_validation"}
	var parameter *parameterError
	if errors.As(err, &parameter) {
		details["param"] = parameter.param
	}
	writeAPIError(w, 400, details)
}

type schoolRequestError struct {
	err      error
	code     string
	stage    string
	upstream map[string]int64
}

func (err *schoolRequestError) Error() string { return err.err.Error() }
func (err *schoolRequestError) Unwrap() error { return err.err }

func invalidSchoolResponse(stage, message string) error {
	return &schoolRequestError{err: errors.New(message), code: "school_invalid_response", stage: stage}
}

func safeInteger(raw json.RawMessage, minimum, maximum int64) *int64 {
	var value *int64
	if json.Unmarshal(raw, &value) != nil || value == nil || *value < minimum || *value > maximum {
		return nil
	}
	return value
}

func schoolFailure(event Event, cause error) error {
	switch event.Code {
	case "school_auth_required", "school_rate_limited", "school_http_error", "school_rejected", "school_invalid_response", "school_network_error", "school_stream_incomplete", "school_stream_error", "school_session_not_found", "school_session_ambiguous", "school_session_unsafe", "school_session_update_failed", "school_model_unavailable", "attachment_upload_failed", "unsupported_image_model", "unsupported_file_frontend", "attachment_limit_exceeded", "debug_web_session_unavailable", "bridge_busy", "tab_unavailable", "school_tab_disconnected", "native_request_invalid", "native_request_timeout":
	default:
		return cause
	}
	failure := &schoolRequestError{err: cause, code: event.Code, upstream: map[string]int64{}}
	var stage string
	if json.Unmarshal(event.Stage, &stage) == nil {
		switch stage {
		case "authentication", "model_catalog", "session_read", "session_create", "session_configure", "session_update", "attachment_upload", "generation", "stream", "connection":
			failure.stage = stage
		}
	}
	if status := safeInteger(event.HTTPStatus, 100, 599); status != nil {
		failure.upstream["http_status"] = *status
	}
	if code := safeInteger(event.SchoolCode, -9007199254740991, 9007199254740991); code != nil {
		failure.upstream["school_code"] = *code
	}
	return failure
}
