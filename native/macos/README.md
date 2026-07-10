# Native macOS playground (proof of concept)

A SwiftUI desktop shell for the motel playground engine, addressing the
"native macOS version (Swift etc.)" acceptance criterion of issue #57.

Unlike the Electron and Tauri candidates, this app embeds no web content at
all: the Go engine is compiled as a C archive (`go build
-buildmode=c-archive`, see [Go build modes](https://pkg.go.dev/cmd/go#hdr-Build_modes))
and linked directly into a Swift binary. The UI is plain SwiftUI and the
engine is called through three exported C functions.

## Architecture

- `cmd/motel-bridge` — cgo bridge over `internal/playground`, exporting
  `MotelValidate`, `MotelRun`, and `MotelFree`. Results cross the FFI
  boundary as JSON strings, the same contract the WASM bridge uses.
- `Sources/Engine.swift` — Swift wrapper handling C string ownership and
  JSON decoding into the record types the views consume.
- `Sources/ContentView.swift` — window layout: topology YAML editor,
  toolbar (open, save, sample, validate, run), run controls (duration,
  seed, slow-span threshold, signal toggles), result tabs, status bar.
- Result views, one per tab, mirroring the web playground: `SummaryView`
  (run statistics, topology facts, diagnostics), `WaterfallView` (trace
  picker plus span waterfall), `MetricsView` (Swift Charts time series and
  bar charts with the web's series-capping rule), `LogsView` (table),
  `ServiceMapView` (node-link diagram drawn from the engine's grid
  placement), and the raw JSON view.
- `Sources/SelfTest.swift` — headless `--selftest` mode used by
  `make native-macos-test`.
- `Sources/Snapshot.swift` — `--snapshot <dir>` runs the sample topology
  and writes one PNG per result tab from the app's own view tree, so it
  needs no screen-recording permission. Caveat: the capture path misses
  SwiftUI-drawn chrome (pane headers, toggles, the tab picker); the six
  result views capture fully. Check chrome by launching the app.

## Build and run

Requires the Go toolchain plus Swift (Xcode or the Command Line Tools).
No Xcode project is involved; the app compiles with `swiftc` directly.

```sh
make native-macos            # build native/macos/gen/MotelPlayground
native/macos/gen/MotelPlayground
```

Run the headless engine checks:

```sh
make native-macos-test
```

## Proof-of-concept scope

Covered: validate, bounded runs with duration/seed/slow-threshold/signal
controls, topology YAML open/save and sample reset, and native result
views for summary, span waterfall, metric charts, logs, service map, and
raw JSON. Verified on macOS 26 (arm64) with Go 1.25 and Swift 6.3; the
self-contained binary is about 8 MB.

Not covered yet, relative to the web playground: traffic preview, random
topology generation, trace import/replay, sessions/history, result
filtering, and sharing links. Those would be native views over the same
JSON payloads the web frontend already consumes. The binary is unsigned
and not bundled as a `.app`; distribution would need bundling, code
signing, and notarisation.

One engine detail to note: `-buildmode=c-archive` starts the Go runtime
inside the host process, so the binary carries the engine and both
runtimes; there is one engine call in flight at a time from the UI, and
calls are synchronous, so the app dispatches them off the main thread.
