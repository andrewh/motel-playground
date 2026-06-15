//go:build js && wasm

package main

import (
	"math"
	"strconv"
	"syscall/js"
	"time"

	"github.com/andrewh/motel-playground/internal/playground"
)

func main() {
	done := make(chan struct{})
	js.Global().Set("motelValidate", async(func(args []js.Value) (string, error) {
		return playground.ToJSON(playground.Validate(args[0].String())), nil
	}))
	js.Global().Set("motelRun", async(func(args []js.Value) (string, error) {
		duration := secondsArg(args, 1, 1)
		seed := uint64(numberArg(args, 2, 1))
		signals := runSignalsArg(args, 3)
		return playground.ToJSON(playground.Run(args[0].String(), duration, seed, signals)), nil
	}))
	js.Global().Set("motelPreview", async(func(args []js.Value) (string, error) {
		duration := secondsArg(args, 1, 300)
		return playground.Preview(args[0].String(), duration)
	}))
	<-done
}

func runSignalsArg(args []js.Value, index int) playground.RunSignals {
	signals := playground.DefaultRunSignals()
	if len(args) <= index {
		return signals
	}
	value := args[index]
	if value.IsUndefined() || value.IsNull() || value.Type() != js.TypeObject {
		return signals
	}
	signals.Traces = boolProperty(value, "traces", signals.Traces)
	signals.Metrics = boolProperty(value, "metrics", signals.Metrics)
	signals.Logs = boolProperty(value, "logs", signals.Logs)
	return signals
}

func boolProperty(value js.Value, name string, fallback bool) bool {
	property := value.Get(name)
	if property.Type() != js.TypeBoolean {
		return fallback
	}
	return property.Bool()
}

type asyncFunc func(args []js.Value) (string, error)

func async(fn asyncFunc) js.Func {
	return js.FuncOf(func(this js.Value, args []js.Value) any {
		promise := js.Global().Get("Promise")
		return promise.New(js.FuncOf(func(this js.Value, callbacks []js.Value) any {
			resolve := callbacks[0]
			reject := callbacks[1]
			go func() {
				result, err := fn(args)
				if err != nil {
					reject.Invoke(err.Error())
					return
				}
				resolve.Invoke(result)
			}()
			return nil
		}))
	})
}

func secondsArg(args []js.Value, index int, fallback float64) time.Duration {
	value := floatArg(args, index, fallback)
	if value <= 0 {
		value = fallback
	}
	return time.Duration(value * float64(time.Second))
}

func floatArg(args []js.Value, index int, fallback float64) float64 {
	if len(args) <= index {
		return fallback
	}
	value := args[index]
	if value.Type() == js.TypeNumber {
		n := value.Float()
		if !math.IsNaN(n) && !math.IsInf(n, 0) {
			return n
		}
	}
	if value.Type() == js.TypeString {
		parsed, err := strconv.ParseFloat(value.String(), 64)
		if err == nil && !math.IsNaN(parsed) && !math.IsInf(parsed, 0) {
			return parsed
		}
	}
	return fallback
}

func numberArg(args []js.Value, index int, fallback int) int {
	if len(args) <= index {
		return fallback
	}
	value := args[index]
	if value.Type() == js.TypeNumber {
		return value.Int()
	}
	if value.Type() == js.TypeString {
		parsed, err := strconv.Atoi(value.String())
		if err == nil {
			return parsed
		}
	}
	return fallback
}
