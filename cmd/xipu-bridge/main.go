package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"strings"

	"github.com/zerlight/XIPU-AI-openai-proxy/internal/config"
	"github.com/zerlight/XIPU-AI-openai-proxy/internal/install"
	"github.com/zerlight/XIPU-AI-openai-proxy/internal/native"
)

func main() {
	if len(os.Args) == 1 || os.Args[1] == "--help" || os.Args[1] == "-h" || os.Args[1] == "help" {
		fmt.Println("XIPU AI Bridge\n\nUsage:\n  xipu-bridge install [options]\n  xipu-bridge uninstall [options]\n\nThe browser launches the native host automatically after installation.\nUse 'install --help' or 'uninstall --help' for options.")
		return
	}
	if len(os.Args) > 1 && (os.Args[1] == "install" || os.Args[1] == "uninstall") {
		if err := install.Run(os.Args[1:]); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	args := os.Args[1:]
	if len(args) == 0 || !strings.HasPrefix(args[0], "chrome-extension://") {
		fmt.Fprintln(os.Stderr, "Usage: xipu-bridge install|uninstall [options]\nThe browser launches the native host with its registered extension origin.")
		os.Exit(2)
	}
	dir, err := config.ConfigDir()
	if err == nil {
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
		defer stop()
		err = native.Run(ctx, os.Stdin, os.Stdout, args[0], dir)
	}
	if err != nil {
		// The error frame contains no configuration values or credentials.
		writer := &native.Writer{Output: os.Stdout}
		writer.Send(map[string]any{"type": "error", "message": err.Error()})
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
