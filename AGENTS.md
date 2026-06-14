# AGENTS.md - motel-playground

This file follows the [agents.md](https://agents.md)
convention and provides guidance for AI coding agents working in this repository.

## Code Quality

- Wrap errors with `%w`; use sentinel errors
- Use constants for often-used string values to prevent typos
- No magic numbers; use named constants or variables
- No descriptive single-line comments
- Professional, concise tone; no emojis
- Always ensure tests pass before committing

## Project Structure

- This repository is a static Go/WASM playground for `andrewh/motel`.
- The WASM entrypoint is `cmd/motel-wasm/main.go`.
- Shared playground logic lives in `internal/playground`.
- Browser code lives in `web/` and should stay framework-free unless there is
  a clear user-approved reason to add a build step.
- `web/vendor/codemirror` is the vendored editor dependency for topology YAML
  and Raw JSON views; keep it static and buildless.
- Smoke tests live in `scripts/`.
- The motel engine is a Git submodule at `third_party/motel`; do not make
  playground-only changes inside the submodule.
- `web/motel.wasm` and `web/wasm_exec.js` are generated build artifacts and
  should not be committed.

## Development Commands

- `make build` builds the WASM bundle.
- `make serve` builds WASM and serves `web/` on <http://localhost:8080>.
- `make test` builds WASM, runs `go test ./...`, then runs the Node smoke
  tests.
- `make lint` runs Go formatting checks, `go vet`, and JavaScript syntax
  checks.
- Set `CHROME_BIN` when the browser smoke test cannot find Chrome.

## Frontend Direction

- Build a serious observability workbench, not a marketing page.
- Keep the interface quiet, data-focused, keyboard-visible, and useful under
  debugging pressure.
- Preserve light and dark theme support when changing styles.
- Prefer monochrome greyscale surfaces with restrained contrast.
- Avoid green-led palettes, beige or clay color systems, decorative gradients,
  neon dashboard styling, gamified simulation styling, and loud SaaS
  composition.
- Keep copy sparse and operational: labels should name actions and results
  without explaining visible UI.

## WASM and Submodule Rules

- The root `go.mod` replaces `github.com/andrewh/motel` with
  `./third_party/motel`; keep that local dependency model unless asked to
  change it.
- When updating motel behavior, advance the submodule commit deliberately and
  rebuild the playground.
- After changing Go exports used by JavaScript, verify both `make build` and
  the browser-facing smoke path.
- Keep asset paths relative so the same `web/` files work locally and under
  GitHub Pages at `/motel-playground/`.

## Commits and Releases

- Single task per commit, no AI attribution in commit messages
- Use conventional commits for commit subjects
- Single-line commit messages are forbidden except for truly trivial changes
- Every non-trivial commit message body must reference and ideally explain every change in the commit
- Wrap commit message body text at 80 columns
- Tag and release only for user-visible features or bug fixes, not for lint/docs/refactoring

## GitHub

- `gh pr edit` hits GraphQL Projects Classic deprecation — use `gh api` REST endpoint instead
- Never use `#N` in PR/issue comments — GitHub auto-links to issue numbers. Use plain numbered lists instead
