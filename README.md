# motel-playground

Static web playground for experimenting with
[`motel`](https://github.com/andrewh/motel) topologies in the browser.

Hosted playground: <https://andrewh.github.io/motel-playground/>.

This repo follows the direction from `andrewh/motel#148`: keep the playground in
a separate repository, depend on `motel` locally while the experiment is young,
and start with a WASM-first implementation that can grow
from one-shot runs into a live observability workbench.

## Current Scope

- Go WASM bridge exposing `Validate`, `Run`, and `Preview` style functions.
- Static frontend with a topology YAML editor, validation, bounded run controls,
  local YAML load/save, random topology generation, traffic preview SVG, span
  waterfall, service map, and raw JSON output.
- `andrewh/motel` checked out as a Git submodule at `third_party/motel` so the
  playground can build against a pinned engine revision without copying the
  whole codebase into this repository.
- Vendored p5.js for graph rendering, so the playground can run without loading
  runtime dependencies from a CDN.

Generated artifacts are intentionally ignored:

- `web/motel.wasm`
- `web/wasm_exec.js`

Vendored browser dependencies live under `web/vendor/`; p5.js is pinned at
`1.11.3` with its license in `web/vendor/p5/LICENSE.txt`.

## Development

Build the WASM artifact:

```sh
make build
```

Serve the static playground:

```sh
make serve
```

Then open <http://localhost:8080>.

Run verification:

```sh
make test
```

The browser smoke test launches headless Chrome. Set `CHROME_BIN` if Chrome is
not on your `PATH` or in the default macOS application location.

## Deployment

GitHub Pages is deployed from the `Deploy playground` workflow on pushes to
`main` and from manual `workflow_dispatch` runs. The workflow checks out the
submodule, runs `make build`, and uploads the `web/` directory as the Pages
artifact, including the generated `web/motel.wasm` and `web/wasm_exec.js`
runtime files.

Pages must be configured to use GitHub Actions as its build and deployment
source. The static app uses relative asset paths, so the same `web/` files work
both at <http://localhost:8080> and under the `/motel-playground/` Pages path.

## Motel submodule

The motel engine lives at `third_party/motel`, and `go.mod` uses:

```go
replace github.com/andrewh/motel => ./third_party/motel
```

Clone with submodules:

```sh
git clone --recurse-submodules https://github.com/andrewh/motel-playground.git
```

If you already cloned without submodules:

```sh
git submodule update --init --recursive
```

When updating the engine, advance the submodule commit, rebuild, and avoid
playground-only patches inside the submodule unless they are temporary and
documented.
