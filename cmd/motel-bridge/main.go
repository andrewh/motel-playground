//go:build darwin && cgo

// Package main builds as a C archive (go build -buildmode=c-archive) so
// native desktop shells can call the playground engine directly, without a
// web view or JavaScript runtime. Strings returned to the caller are heap
// allocated and must be released with MotelFree.
package main

/*
#include <stdlib.h>
*/
import "C"

import (
	"time"
	"unsafe"

	"github.com/andrewh/motel-playground/internal/playground"
)

// MotelValidate validates topology YAML and returns a ValidationResult as a
// JSON string.
//
//export MotelValidate
func MotelValidate(source *C.char) *C.char {
	return C.CString(playground.ToJSON(playground.Validate(C.GoString(source))))
}

// MotelRun executes a bounded run and returns a RunResult as a JSON string.
// Non-positive seconds fall back to one second; a non-positive slowMs
// disables the slow-span threshold. traces, metrics, and logs are booleans
// (zero is false).
//
//export MotelRun
func MotelRun(source *C.char, seconds C.double, seed C.ulonglong, traces, metrics, logs C.int, slowMs C.double) *C.char {
	duration := time.Duration(float64(seconds) * float64(time.Second))
	if duration <= 0 {
		duration = time.Second
	}
	var slowThreshold time.Duration
	if slowMs > 0 {
		slowThreshold = time.Duration(float64(slowMs) * float64(time.Millisecond))
	}
	signals := playground.RunSignals{
		Traces:  traces != 0,
		Metrics: metrics != 0,
		Logs:    logs != 0,
	}
	result := playground.Run(C.GoString(source), duration, uint64(seed), signals, slowThreshold)
	return C.CString(playground.ToJSON(result))
}

// MotelFree releases a string previously returned by this library.
//
//export MotelFree
func MotelFree(ptr *C.char) {
	C.free(unsafe.Pointer(ptr))
}

func main() {}
