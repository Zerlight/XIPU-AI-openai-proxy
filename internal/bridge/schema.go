package bridge

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

// Decode JSON without ambiguous duplicate keys, lossy numbers, or trailing values.
func exactJSON(raw []byte) (any, error) {
	if !utf8.Valid(raw) {
		return nil, errors.New("JSON must be valid UTF-8")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var read func(int) (any, error)
	read = func(depth int) (any, error) {
		if depth > 64 {
			return nil, errors.New("JSON nesting exceeds 64 levels")
		}
		token, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		delim, ok := token.(json.Delim)
		if !ok {
			if number, numeric := token.(json.Number); numeric {
				// Bound arbitrary-precision work before handing numbers to JSON Schema.
				value := string(number)
				if len(value) > 1024 {
					return nil, errors.New("JSON number exceeds 1024 characters")
				}
				if index := strings.IndexAny(value, "eE"); index >= 0 {
					exponent, err := strconv.Atoi(value[index+1:])
					if err != nil || exponent < -1000 || exponent > 1000 {
						return nil, errors.New("JSON number exponent exceeds the supported range -1000 to 1000")
					}
				}
			}
			return token, nil
		}
		switch delim {
		case '{':
			object := map[string]any{}
			for decoder.More() {
				key, err := decoder.Token()
				if err != nil {
					return nil, err
				}
				name, ok := key.(string)
				if !ok {
					return nil, errors.New("Invalid JSON object key")
				}
				if _, ok := object[name]; ok {
					return nil, errors.New("Duplicate JSON object key")
				}
				value, err := read(depth + 1)
				if err != nil {
					return nil, err
				}
				object[name] = value
			}
			_, err = decoder.Token()
			return object, err
		case '[':
			list := []any{}
			for decoder.More() {
				value, err := read(depth + 1)
				if err != nil {
					return nil, err
				}
				list = append(list, value)
			}
			_, err = decoder.Token()
			return list, err
		default:
			return nil, errors.New("Unexpected JSON delimiter")
		}
	}
	value, err := read(0)
	if err != nil {
		return nil, err
	}
	if _, err = decoder.Token(); err != io.EOF {
		return nil, errors.New("JSON must contain one value")
	}
	return value, nil
}

func decodeObject(raw []byte, target any, fields ...string) error {
	value, err := exactJSON(raw)
	if err != nil {
		return errors.New("Invalid JSON object")
	}
	object, ok := value.(map[string]any)
	if !ok {
		return errors.New("Expected a JSON object")
	}
	allowed := map[string]bool{}
	for _, field := range fields {
		allowed[field] = true
	}
	for field := range object {
		if !allowed[field] {
			return fmt.Errorf("Unsupported field: %s", field)
		}
	}
	if err := json.Unmarshal(raw, target); err != nil {
		return errors.New("Invalid field type")
	}
	return nil
}

type denySchemaLoader struct{}

func (denySchemaLoader) Load(string) (any, error) {
	return nil, errors.New("External schema resources are not supported")
}

func compileSchema(raw json.RawMessage) (*jsonschema.Schema, error) {
	if len(raw) == 0 || len(raw) > 64<<10 {
		return nil, errors.New("Schema must be present and at most 64 KiB")
	}
	value, err := exactJSON(raw)
	if err != nil {
		return nil, errors.New("Invalid JSON schema")
	}
	count := 0
	var check func(any) error
	check = func(value any) error {
		count++
		if count > 4096 {
			return errors.New("Schema is too complex")
		}
		switch value := value.(type) {
		case map[string]any:
			for _, item := range value {
				if err := check(item); err != nil {
					return err
				}
			}
		case []any:
			for _, item := range value {
				if err := check(item); err != nil {
					return err
				}
			}
		}
		return nil
	}
	if err := check(value); err != nil {
		return nil, err
	}
	compiler := jsonschema.NewCompiler()
	compiler.UseLoader(denySchemaLoader{})
	compiler.DefaultDraft(jsonschema.Draft2020)
	compiler.AssertFormat()
	const location = "https://bridge.invalid/schema.json"
	if err := compiler.AddResource(location, value); err != nil {
		return nil, errors.New("Invalid JSON schema")
	}
	schema, err := compiler.Compile(location)
	if err != nil {
		return nil, errors.New("Invalid or unsupported JSON schema")
	}
	return schema, nil
}

type outputFormat struct {
	kind   string
	schema *jsonschema.Schema
	raw    json.RawMessage
}

func parseFormat(raw json.RawMessage, responses bool) (outputFormat, error) {
	format := outputFormat{kind: "text"}
	if len(raw) == 0 || string(raw) == "null" {
		return format, nil
	}
	var body struct {
		Type        string          `json:"type"`
		JSONSchema  json.RawMessage `json:"json_schema"`
		Name        string          `json:"name"`
		Description string          `json:"description"`
		Schema      json.RawMessage `json:"schema"`
		Strict      *bool           `json:"strict"`
	}
	fields := []string{"type", "json_schema"}
	if responses {
		fields = []string{"type", "name", "description", "schema", "strict"}
	}
	if err := decodeObject(raw, &body, fields...); err != nil {
		return format, err
	}
	switch body.Type {
	case "text":
		return format, nil
	case "json_object":
		format.kind = body.Type
		return format, nil
	case "json_schema":
		if !responses {
			if err := decodeObject(body.JSONSchema, &body, "name", "description", "schema", "strict"); err != nil {
				return format, err
			}
		}
		if !validName(body.Name) {
			return format, errors.New("JSON schema name must contain 1-64 letters, digits, underscores, or hyphens")
		}
		schema, err := compileSchema(body.Schema)
		if err != nil {
			return format, err
		}
		format.kind = "json_schema"
		format.schema = schema
		format.raw = body.Schema
		return format, nil
	default:
		return format, errors.New("Unsupported output format")
	}
}
func (format outputFormat) validate(text string) error {
	if format.kind == "text" {
		return nil
	}
	value, err := exactJSON([]byte(text))
	if err != nil {
		return fmt.Errorf("%w: output is not valid JSON", errInvalidGeneration)
	}
	if format.kind == "json_object" {
		if _, ok := value.(map[string]any); !ok {
			return fmt.Errorf("%w: output must be a JSON object", errInvalidGeneration)
		}
	}
	if format.schema != nil {
		if err := format.schema.Validate(value); err != nil {
			return fmt.Errorf("%w: output violates the JSON schema", errInvalidGeneration)
		}
	}
	return nil
}
