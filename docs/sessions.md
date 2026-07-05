# Design: user sessions with run history

Issue 50 asks the playground to collect a history of runs that can be saved
and loaded locally and persisted in browser storage, so an engineer can use
the playground to investigate a series of scenarios as one session.

## Goals

- Record every successful topology run into an ordered session history
  without extra user action.
- Persist the history in browser storage so it survives reloads and browser
  restarts on the same machine.
- Let the user save a session to a local file and load it back later or on
  another machine.
- Let the user restore any recorded run: topology, run settings, and, where
  captured, the exact results.
- Stay static, buildless, and framework-free, matching the rest of `web/`.

## Non-goals

- Server-side or cross-device persistence. The playground remains a static
  app; storage is the browser plus explicit files.
- Sharing sessions through URLs. Run output is far too large for the share
  hash; the existing **Copy link** flow already covers configuration sharing.
- Recording validation, preview, or trace-import actions. Only completed
  runs produce results worth revisiting. Replay of imported traces is a
  planned follow-up (see Future work).

## Concepts

- **Session**: the ordered list of recorded runs held in browser storage,
  or serialized to a session file. There is one active session per browser
  profile; loading a session file replaces it.
- **Entry**: one recorded run. An entry always carries enough to reproduce
  the run (topology YAML, run settings including the seed) plus summary
  statistics, and carries the full result payload when it fits the size
  budget.

## Data model

The playground already defines a versioned single-run snapshot in
`web/result-snapshot.mjs` (`motel-playground-run`, used by result
export/import). A session entry flattens that snapshot and adds identity:

```json
{
  "id": "k3f2v9x1q8",
  "recorded_at": "2026-07-05T12:34:56.000Z",
  "kind": "run",
  "label": "gateway · 5 services",
  "stats": { "traces": 12, "spans": 58, "errors": 1, "error_rate": 0.017 },
  "topology": "version: 1\n...",
  "settings": { "duration": "1", "slowThresholdMs": "0", "seed": "42",
                "maxNodes": "8", "signals": { "traces": true, "metrics": true, "logs": true } },
  "result": { "ok": true, "stats": {}, "topology": {}, "limits": {},
              "spans": [], "metrics": [], "logs": [] }
}
```

`result` is the same object the result snapshot stores and may be `null`
when the payload exceeded the per-entry budget (see Storage limits). The
session document wraps entries with the usual kind/version envelope, both
in storage and in saved files:

```json
{
  "kind": "motel-playground-session",
  "v": 1,
  "saved_at": "2026-07-05T12:40:00.000Z",
  "entries": []
}
```

Entries are stored oldest first and rendered newest first. Settings are
normalized through the result-snapshot rules so entries, result snapshots,
and share links keep one settings shape.

## Storage

### Options considered

- **`localStorage`**: synchronous, universally available, zero dependencies,
  and already used for the theme preference. Quota is typically 5 MB of
  UTF-16 text per origin, so full run output cannot be stored without
  bounds.
- **IndexedDB**: much larger quota and structured storage, the right home
  for unbounded result payloads, but it drags async lifecycle, schema
  versioning, and error handling into a PoC whose payloads are usually
  small (a default one-second run serializes to tens of kilobytes).
- **OPFS / File System Access**: not broadly available enough for a static
  playground and overkill for this feature.

### Decision

Use `localStorage` behind a small storage-agnostic store
(`createSessionStore` in `web/session-history.mjs`) with explicit budgets.
The store takes any `getItem`/`setItem`/`removeItem` object, so tests run
against an in-memory fake, private-mode failures fall back to an in-memory
session, and a future IndexedDB adapter can slot in without touching the
UI.

### Storage limits and degradation

- Key: `motel-playground-session-v1`.
- At most 50 entries; recording past the cap drops the oldest.
- An entry whose serialized `result` exceeds 256 K characters keeps its
  stats, topology, and settings but stores `result: null`.
- If the whole session exceeds a 3 M character budget, the store strips
  `result` from the oldest entries first, then drops the oldest entries.
- If the browser still rejects the write (quota, private mode), the store
  retries with the same reduction ladder and finally keeps the session in
  memory for the tab's lifetime, reporting that persistence failed so the
  UI can tell the user.

A settings-only entry is still useful: restoring it loads the topology and
settings, and because the seed is part of the settings a re-run reproduces
the results wherever the engine is deterministic — the same contract the
README documents for share links. Corrupt or unreadable stored sessions
reset to an empty history rather than breaking startup.

## Recording policy

`run()` records an entry after every successful run (including runs with
signals disabled). Failed runs are not recorded; their output is transient
diagnostics. Trace replay is not recorded in the PoC because replayed
results are reproduced from the trace input rather than the topology YAML,
so a faithful replay entry must carry the trace payload; see Future work.

## UI

A seventh result tab, **History** (keyboard shortcut `7`), keeps the
workbench layout unchanged and the history reachable at any time:

- Toolbar: entry count, live status line, and **Load session**,
  **Save session**, **Clear** actions. Save downloads the session document
  as pretty-printed JSON (`motel-session-<timestamp>.json`); Load replaces
  the current session from a file; Clear empties history and storage.
- Entries list newest first. Each row shows the label, recorded time, seed,
  duration, run stats, whether full results are stored, and offers
  **Restore** and **Delete**.
- Restore with a stored result rebuilds the run through the existing
  result-snapshot path (`applyResultSnapshot`), exactly like importing a
  result file. Restore without a stored result loads topology and settings,
  revalidates, and tells the user to run to regenerate results.

## Privacy and telemetry

Session content never leaves the browser except through explicit file
saves. Telemetry follows the existing rules: new events
(`session_entry_recorded`, `session_entry_restored`, `session_saved`,
`session_loaded`, `session_cleared`, ...) carry only counts, booleans, and
size buckets — never topology YAML, results, filenames, or labels. The
privacy statement now names session history among the data telemetry does
not send.

## Testing

- `scripts/session-history-test.mjs` (Node, no browser): entry creation and
  normalization, session file round-trip, rejection of malformed documents,
  entry cap and size-budget trimming, oversized-result degradation, quota
  fallback, and corrupt-storage recovery, all against a fake storage.
- `scripts/smoke-browser.mjs`: after real runs, asserts entries appear in
  the History tab, persist in `localStorage` across a reload, restore a
  recorded run back into the workbench, and clear correctly; the result-tab
  accessibility check now expects seven tabs.

## Future work

- Record trace replays (entries carrying the trace source) and result-file
  imports.
- Optional IndexedDB adapter to lift the size budgets and keep full results
  for long sessions.
- User-editable entry labels and pinned entries that trimming never drops.
- Cross-tab live sync via `storage` events.
- Comparing two entries (stat deltas, span diffing) as a first analysis
  tool on top of sessions.
