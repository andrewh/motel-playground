import assert from "node:assert/strict";

import {
  bucketBytes,
  categorizeError,
  initTelemetry,
  telemetryEventNames,
  telemetryReady,
  telemetrySnapshot,
  traceAsync,
  trackEvent,
} from "../web/telemetry.mjs";

const byteBucketSmallLimit = 10 * 1024;
const byteBucketMediumLimit = 100 * 1024;
const byteBucketLargeLimit = 1024 * 1024;
const longParamValue = "x".repeat(120);

const local = makeTelemetryEnvironment("http://127.0.0.1:8080/#state=secret");
initTelemetry({ measurementID: "G-LOCAL" }, local.environment);
assert.equal(telemetrySnapshot().enabled, false);
assert.equal(trackEvent(telemetryEventNames.runStarted, { duration_seconds: 1 }), false);
assert.deepEqual(local.window.dataLayer, []);

const hosted = makeTelemetryEnvironment("https://andrewh.github.io/motel-playground/#state=secret&tab=logs");
initTelemetry({ measurementID: "G-B2GVLBQD3G" }, hosted.environment);
assert.equal(telemetrySnapshot().enabled, true);
assert.equal(telemetrySnapshot().gaEnabled, true);
assert.equal(hosted.document.scripts.length, 1);
assert.ok(hosted.document.scripts[0].src.includes("id=G-B2GVLBQD3G"));

const configCommand = hosted.window.dataLayer.find((command) => command[0] === "config");
assert.deepEqual(configCommand, ["config", "G-B2GVLBQD3G", { send_page_view: false }]);

const pageView = hosted.window.dataLayer.find((command) => command[0] === "event" && command[1] === "page_view");
assert.equal(pageView[2].page_location, "https://andrewh.github.io/motel-playground/");
assert.equal(pageView[2].page_path, "/motel-playground/");
assert.equal(pageView[2].page_location.includes("#"), false);

const event = trackEvent("custom_event", {
  count: 4,
  enabled: true,
  long: longParamValue,
  payload: { secret: "not allowed" },
  bad: Number.NaN,
});
assert.equal(event.name, "custom_event");
assert.equal(event.params.count, 4);
assert.equal(event.params.enabled, true);
assert.equal(event.params.long.length, 80);
assert.equal("payload" in event.params, false);
assert.equal("bad" in event.params, false);

assert.equal(bucketBytes(0), "empty");
assert.equal(bucketBytes(byteBucketSmallLimit - 1), "lt_10kb");
assert.equal(bucketBytes(byteBucketMediumLimit - 1), "10kb_100kb");
assert.equal(bucketBytes(byteBucketLargeLimit - 1), "100kb_1mb");
assert.equal(bucketBytes(byteBucketLargeLimit), "1mb_5mb");
assert.equal(categorizeError(new Error("fetch failed")), "network");
assert.equal(categorizeError(new Error("WebAssembly compile failed")), "wasm");
assert.equal(categorizeError(new Error("invalid JSON")), "input");

const spans = [];
const otel = makeTelemetryEnvironment("https://collector.example/app/#state=secret", {
  loadOpenTelemetry: async () => ({
    startSpan: (name, options) => makeSpan(spans, name, options),
  }),
});
initTelemetry({
  measurementID: "G-OTEL",
  allowedHosts: ["collector.example"],
  loadGoogleAnalyticsScript: false,
  otelEndpoint: "https://collector.example/v1/traces",
}, otel.environment);
await telemetryReady();
assert.equal(telemetrySnapshot().otelReady, true);

const result = await traceAsync("motel.test.ok", async () => {
  otel.advance(12.5);
  return "ok";
}, {
  view: "raw",
  payload: { secret: "not allowed" },
});
assert.equal(result, "ok");
assert.equal(spans[0].name, "motel.test.ok");
assert.equal(spans[0].attributes.view, "raw");
assert.equal(spans[0].attributes.ok, true);
assert.equal(spans[0].attributes.duration_ms, 12.5);
assert.equal("payload" in spans[0].attributes, false);
assert.equal(spans[0].ended, true);

await assert.rejects(async () => traceAsync("motel.test.failure", async () => {
  otel.advance(7);
  throw new Error("fetch failed");
}));
const failure = spans[1];
assert.equal(failure.attributes.ok, false);
assert.equal(failure.attributes.error_category, "network");
assert.deepEqual(failure.status, { code: 2, message: "network" });
assert.deepEqual(failure.exception, { name: "network" });

const pendingSpans = [];
let resolvePendingTracer;
const pending = makeTelemetryEnvironment("https://pending.example/app/#state=secret", {
  loadOpenTelemetry: async () => new Promise((resolve) => {
    resolvePendingTracer = resolve;
  }),
});
initTelemetry({
  allowedHosts: ["pending.example"],
  otelEndpoint: "https://pending.example/v1/traces",
}, pending.environment);
await traceAsync("motel.pending.startup", async () => {
  pending.advance(4);
}, { phase: "startup" });
assert.equal(pendingSpans.length, 0);
resolvePendingTracer({
  startSpan: (name, options) => makeSpan(pendingSpans, name, options),
});
await telemetryReady();
assert.equal(pendingSpans[0].name, "motel.pending.startup");
assert.equal(pendingSpans[0].attributes.phase, "startup");
assert.equal(pendingSpans[0].attributes.duration_ms, 4);
assert.equal(pendingSpans[0].startTime, 1000);
assert.equal(pendingSpans[0].endTime, 1004);

console.log("telemetry ok");

function makeTelemetryEnvironment(href, options = {}) {
  const location = new URL(href);
  const scripts = [];
  const window = {
    location,
    dataLayer: [],
  };
  const document = {
    title: "motel playground",
    scripts,
    head: {
      append: (script) => scripts.push(script),
    },
    createElement: (tagName) => ({
      async: false,
      src: "",
      tagName: tagName.toUpperCase(),
    }),
  };
  let currentTime = 1000;
  return {
    window,
    document,
    environment: {
      win: window,
      doc: document,
      now: () => currentTime,
      wallNow: () => currentTime,
      loadOpenTelemetry: options.loadOpenTelemetry,
    },
    advance: (milliseconds) => {
      currentTime += milliseconds;
    },
  };
}

function makeSpan(spans, name, options = {}) {
  return {
    name,
    attributes: { ...(options.attributes ?? {}) },
    startTime: options.startTime,
    endTime: null,
    exception: null,
    status: null,
    ended: false,
    setAttribute(key, value) {
      this.attributes[key] = value;
    },
    recordException(error) {
      this.exception = error;
    },
    setStatus(status) {
      this.status = status;
    },
    end(endTime) {
      this.endTime = endTime;
      this.ended = true;
      spans.push(this);
    },
  };
}
