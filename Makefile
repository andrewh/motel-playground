.PHONY: build wasm serve test lint clean

GOROOT := $(shell go env GOROOT)

build: wasm

wasm:
	cp "$(GOROOT)/lib/wasm/wasm_exec.js" web/wasm_exec.js
	GOOS=js GOARCH=wasm go build -o web/motel.wasm ./cmd/motel-wasm

serve: wasm
	python3 -m http.server 8080 --directory web

test: wasm
	go test ./...
	node scripts/share-state-test.mjs
	node scripts/result-snapshot-test.mjs
	node scripts/telemetry-test.mjs
	node scripts/smoke-wasm.mjs
	node scripts/smoke-browser.mjs

lint:
	test -z "$$(gofmt -l cmd internal)"
	go vet ./...
	node --check scripts/smoke-browser.mjs
	node --check scripts/result-snapshot-test.mjs
	node --check scripts/share-state-test.mjs
	node --check scripts/telemetry-test.mjs
	node --check scripts/smoke-wasm.mjs
	node --check web/app.js
	node --check web/graph.js
	node --check web/result-snapshot.mjs
	node --check web/run-worker.js
	node --check web/share-state.mjs
	node --check web/telemetry.mjs
	node --check web/topology-generator.mjs

clean:
	rm -f web/motel.wasm web/wasm_exec.js
