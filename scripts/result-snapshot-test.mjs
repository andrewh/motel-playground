import assert from "node:assert/strict";

import {
  createResultSnapshot,
  normalizeResultSnapshot,
  parseResultSnapshot,
  resultSnapshotFilename,
  resultSnapshotKind,
  resultSnapshotVersion,
} from "../web/result-snapshot.mjs";

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
    services: [{ name: "gateway", operations: [] }],
    roots: ["gateway.GET /"],
    operations: 1,
    edges: 0,
    scenarios: 0,
    graph: { nodes: [], edges: [], gridCols: 1, gridRows: 1 },
  },
  spans: [{ service: "gateway", operation: "GET /" }],
  metrics: [{ name: "gateway.request.duration", type: "histogram" }],
  logs: [{ severity: "INFO", body: "gateway handled GET /" }],
  limits: {
    duration_seconds: 1,
    max_traces: 200,
    max_spans_per_trace: 500,
    captured_spans: 4,
    captured_metrics: 1,
    captured_logs: 1,
  },
};

const snapshot = createResultSnapshot({
  topology,
  settings: {
    duration: 2.5,
    slowThresholdMs: 25,
    seed: 314,
    maxNodes: 4,
    signals: {
      traces: true,
      metrics: false,
      logs: true,
    },
  },
  result,
  exportedAt: new Date("2026-06-14T20:50:27Z"),
});

assert.deepEqual(snapshot, {
  kind: resultSnapshotKind,
  v: resultSnapshotVersion,
  exported_at: "2026-06-14T20:50:27.000Z",
  topology,
  settings: {
    duration: "2.5",
    slowThresholdMs: "25",
    seed: "314",
    maxNodes: "4",
    signals: {
      traces: true,
      metrics: false,
      logs: true,
    },
  },
  result,
});
assert.deepEqual(parseResultSnapshot(JSON.stringify(snapshot)), snapshot);
assert.equal(resultSnapshotFilename(snapshot.settings), "motel-results-314.json");
assert.equal(resultSnapshotFilename({ seed: "../shared run" }), "motel-results-shared-run.json");

const minimalSnapshot = normalizeResultSnapshot({
  kind: resultSnapshotKind,
  v: resultSnapshotVersion,
  topology,
  result: {
    ok: true,
    stats: result.stats,
    topology: result.topology,
    limits: result.limits,
  },
});

assert.deepEqual(minimalSnapshot.settings, {
  duration: "1",
  slowThresholdMs: "0",
  seed: "42",
  maxNodes: "8",
  signals: {
    traces: true,
    metrics: true,
    logs: true,
  },
});
assert.deepEqual(minimalSnapshot.result.spans, []);
assert.deepEqual(minimalSnapshot.result.metrics, []);
assert.deepEqual(minimalSnapshot.result.logs, []);

assert.throws(() => parseResultSnapshot("{"), /not valid JSON/);
assert.throws(() => normalizeResultSnapshot({ ...snapshot, kind: "other" }), /unsupported format/);
assert.throws(() => normalizeResultSnapshot({ ...snapshot, topology: "" }), /missing topology/);
assert.throws(() => normalizeResultSnapshot({ ...snapshot, result: { ...result, ok: false } }), /completed run/);
assert.throws(
  () => normalizeResultSnapshot({ ...snapshot, result: { ...result, stats: { ...result.stats, spans: "bad" } } }),
  /invalid spans statistics/,
);

console.log("result snapshot ok");
