//go:build js && wasm

package main

import (
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
		duration := secondsArg(args, 1, 2)
		seed := uint64(numberArg(args, 2, 1))
		return playground.ToJSON(playground.Run(args[0].String(), duration, seed)), nil
	}))
	js.Global().Set("motelPreview", async(func(args []js.Value) (string, error) {
		duration := secondsArg(args, 1, 300)
		return playground.Preview(args[0].String(), duration)
	}))
	<-done
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

func secondsArg(args []js.Value, index int, fallback int) time.Duration {
	value := numberArg(args, index, fallback)
	if value <= 0 {
		value = fallback
	}
	return time.Duration(value) * time.Second
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
