import assert from "node:assert/strict";

import {
  applySessionLimits,
  createSessionDocument,
  createSessionEntry,
  createSessionStore,
  entryResultSnapshot,
  normalizeSessionEntry,
  parseSessionFile,
  sessionFilename,
  sessionFileText,
  sessionKind,
  sessionVersion,
} from "../web/session-history.mjs";

const topology = `version: 1
services:
  gateway:
    operations:
      GET /:
        duration: 5ms +/- 1ms
traffic:
  rate: 5/s
`;

const result = {
  ok: true,
  stats: {
    traces: 2,
    spans: 4,
    errors: 1,
    error_rate: 0.25,
  },
  topology: {
    services: [
      { name: "gateway", operations: [] },
      { name: "postgres", operations: [] },
    ],
    roots: ["gateway.GET /"],
    operations: 2,
    edges: 1,
    scenarios: 0,
    graph: { nodes: [], edges: [], gridCols: 1, gridRows: 1 },
  },
  spans: [{ service: "gateway", operation: "GET /" }],
  metrics: [],
  logs: [],
  limits: {
    duration_seconds: 1,
    max_traces: 200,
    max_spans_per_trace: 500,
    captured_spans: 4,
    captured_metrics: 0,
    captured_logs: 0,
  },
};

const settings = {
  duration: 2,
  slowThresholdMs: 25,
  seed: 314,
  maxNodes: 4,
  signals: { traces: true, metrics: false, logs: true },
};

function makeEntry(overrides = {}) {
  return createSessionEntry({
    topology,
    settings,
    result,
    recordedAt: new Date("2026-07-05T10:00:00Z"),
    ...overrides,
  });
}

function fakeStorage({ failSet = () => false } = {}) {
  const data = new Map();
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => {
      if (failSet(value)) throw new Error("quota exceeded");
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

const entry = makeEntry({ id: "entry-1" });
assert.equal(entry.id, "entry-1");
assert.equal(entry.recorded_at, "2026-07-05T10:00:00.000Z");
assert.equal(entry.kind, "run");
assert.equal(entry.label, "gateway · 2 services");
assert.deepEqual(entry.stats, { traces: 2, spans: 4, errors: 1, error_rate: 0.25 });
assert.equal(entry.settings.seed, "314");
assert.equal(entry.settings.signals.metrics, false);
assert.deepEqual(entry.result.stats, result.stats);
assert.ok(makeEntry().id);
assert.notEqual(makeEntry().id, makeEntry().id);

const snapshot = entryResultSnapshot(entry);
assert.equal(snapshot.kind, "motel-playground-run");
assert.equal(snapshot.topology, topology);
assert.equal(snapshot.settings.seed, "314");
assert.deepEqual(snapshot.result.stats, result.stats);
assert.equal(entryResultSnapshot({ ...entry, result: null }), null);

const settingsOnly = normalizeSessionEntry({ ...entry, result: null, kind: "mystery", label: "" });
assert.equal(settingsOnly.result, null);
assert.equal(settingsOnly.kind, "run");
assert.equal(settingsOnly.label, "topology");
assert.throws(() => normalizeSessionEntry({ ...entry, topology: "" }), /missing topology/);
assert.throws(() => normalizeSessionEntry({ ...entry, stats: { traces: "bad" } }), /invalid traces statistics/);
assert.throws(() => normalizeSessionEntry({ ...entry, result: { ok: false } }), /completed run/);
assert.throws(() => createSessionEntry({ topology, settings, result: { ...result, ok: false } }), /completed run/);

const savedAt = new Date("2026-07-05T11:00:00Z");
const doc = createSessionDocument([entry], savedAt);
assert.equal(doc.kind, sessionKind);
assert.equal(doc.v, sessionVersion);
assert.equal(doc.saved_at, "2026-07-05T11:00:00.000Z");
assert.deepEqual(parseSessionFile(sessionFileText(doc)), doc);
assert.equal(sessionFilename(savedAt), "motel-session-20260705t110000z.json");

assert.throws(() => parseSessionFile("{"), /not valid JSON/);
assert.throws(() => parseSessionFile(JSON.stringify({ ...doc, kind: "other" })), /unsupported format/);
assert.throws(() => parseSessionFile(JSON.stringify({ ...doc, entries: "nope" })), /missing entries/);
assert.throws(() => parseSessionFile(JSON.stringify({ ...doc, entries: [{}] })), /session entry/);

const capped = applySessionLimits(
  [makeEntry({ id: "a" }), makeEntry({ id: "b" }), makeEntry({ id: "c" })],
  { maxEntries: 2 },
);
assert.deepEqual(capped.map((item) => item.id), ["b", "c"]);

const oversized = applySessionLimits([entry], { maxResultChars: 10 });
assert.equal(oversized[0].result, null);
assert.equal(oversized[0].stats.spans, 4);

const budgeted = applySessionLimits(
  [makeEntry({ id: "old" }), makeEntry({ id: "mid" }), makeEntry({ id: "new" })],
  { maxSessionChars: JSON.stringify([makeEntry({ id: "old" })]).length * 2 },
);
assert.ok(budgeted.length >= 1);
assert.equal(budgeted[0].result, null);
assert.equal(budgeted.at(-1).id, "new");

const storage = fakeStorage();
const store = createSessionStore({ storage, now: () => savedAt });
assert.deepEqual(store.load(), []);
const recorded = store.record(makeEntry({ id: "first" }));
assert.equal(recorded.persisted, true);
assert.equal(recorded.entries.length, 1);
store.record(makeEntry({ id: "second" }));
assert.deepEqual(store.entries().map((item) => item.id), ["first", "second"]);

const reloaded = createSessionStore({ storage });
assert.deepEqual(reloaded.load().map((item) => item.id), ["first", "second"]);

const removed = store.remove("first");
assert.deepEqual(removed.entries.map((item) => item.id), ["second"]);
const replaced = store.replace([makeEntry({ id: "from-file" })]);
assert.deepEqual(replaced.entries.map((item) => item.id), ["from-file"]);
const cleared = store.clear();
assert.deepEqual(cleared.entries, []);
assert.equal(storage.getItem("motel-playground-session-v1"), null);

storage.setItem("motel-playground-session-v1", "not json");
assert.deepEqual(createSessionStore({ storage }).load(), []);

const strictStorage = fakeStorage({
  failSet: (value) => value.includes('"spans":[{'),
});
const strictStore = createSessionStore({ storage: strictStorage });
strictStore.load();
const degraded = strictStore.record(makeEntry({ id: "degraded" }));
assert.equal(degraded.persisted, true);
assert.equal(degraded.entries[0].result, null);
assert.equal(degraded.entries[0].stats.traces, 2);

const brokenStore = createSessionStore({
  storage: fakeStorage({ failSet: () => true }),
});
brokenStore.load();
const unpersisted = brokenStore.record(makeEntry({ id: "memory-only" }));
assert.equal(unpersisted.persisted, false);
assert.deepEqual(brokenStore.entries().map((item) => item.id), ["memory-only"]);

console.log("session history ok");
