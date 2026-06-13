.PHONY: build wasm serve test clean

GOROOT := $(shell go env GOROOT)

build: wasm

wasm:
	cp "$(GOROOT)/lib/wasm/wasm_exec.js" web/wasm_exec.js
	GOOS=js GOARCH=wasm go build -o web/motel.wasm ./cmd/motel-wasm

serve: wasm
	python3 -m http.server 8080 --directory web

test:
	go test ./...

clean:
	rm -f web/motel.wasm web/wasm_exec.js
