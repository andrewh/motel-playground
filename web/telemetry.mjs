export const telemetryConfigGlobal = "motelTelemetryConfig";
export const googleAnalyticsScriptBaseURL = "https://www.googletagmanager.com/gtag/js";
export const defaultTelemetryHosts = Object.freeze(["andrewh.github.io"]);
export const defaultOtelModuleBaseURL = "https://esm.sh";
export const defaultOtelAPIPackageVersion = "1.9.0";
export const defaultOtelPackageVersion = "1.30.1";
export const defaultTelemetryServiceName = "motel-playground";

export const telemetryEventNames = Object.freeze({
  pageView: "page_view",
  wasmLoadStarted: "wasm_load_started",
  wasmLoadCompleted: "wasm_load_completed",
  wasmLoadFailed: "wasm_load_failed",
  runStarted: "run_started",
  runCompleted: "run_completed",
  runFailed: "run_failed",
  resultTabChanged: "result_tab_changed",
  topologyLoaded: "topology_loaded",
  topologySaved: "topology_saved",
  topologyGenerated: "topology_generated",
  shareLinkCreated: "share_link_created",
  shareLinkRejected: "share_link_rejected",
  traceFileLoaded: "trace_file_loaded",
  traceImportStarted: "trace_import_started",
  traceImportCompleted: "trace_import_completed",
  traceImportFailed: "trace_import_failed",
  resultExported: "result_exported",
  resultImported: "result_imported",
  resultImportFailed: "result_import_failed",
  reportPrinted: "report_printed",
  otelInitFailed: "otel_init_failed",
});

export const telemetrySpanNames = Object.freeze({
  appStartup: "motel.app.startup",
  wasmLoad: "motel.wasm.load",
  topologyRun: "motel.topology.run",
  previewRender: "motel.preview.render",
  resultRender: "motel.result.render",
  serviceMapRender: "motel.service_map.render",
  traceImport: "motel.trace_import",
});

const byteBucketSmallLimit = 10 * 1024;
const byteBucketMediumLimit = 100 * 1024;
const byteBucketLargeLimit = 1024 * 1024;
const byteBucketHugeLimit = 5 * 1024 * 1024;
const durationPrecision = 10;
const maxStringParamLength = 80;
const otelStatusCodeError = 2;
const pendingSpanLimit = 200;
const otelPackageNames = Object.freeze({
  api: "@opentelemetry/api",
  traceWeb: "@opentelemetry/sdk-trace-web",
  traceBase: "@opentelemetry/sdk-trace-base",
  traceExporter: "@opentelemetry/exporter-trace-otlp-http",
});

let telemetryState = initialTelemetryState();

export function initTelemetry(config = readTelemetryConfig(), environment = {}) {
  telemetryState = initialTelemetryState(environment);
  telemetryState.config = normalizeTelemetryConfig(config);

  if (!isTelemetryAllowed(telemetryState.config, telemetryState.environment.win?.location)) {
    exposeTelemetryDebugAPI();
    return telemetrySnapshot();
  }

  telemetryState.enabled = true;
  if (telemetryState.config.measurementID) {
    initGoogleAnalytics();
    trackPageView();
  }
  if (telemetryState.config.otelEndpoint) {
    telemetryState.otelReadyPromise = initOpenTelemetry();
  }
  exposeTelemetryDebugAPI();
  return telemetrySnapshot();
}

export function telemetryReady() {
  return telemetryState.otelReadyPromise ?? Promise.resolve();
}

export function telemetrySnapshot() {
  return {
    enabled: telemetryState.enabled,
    gaEnabled: telemetryState.gaEnabled,
    otelConfigured: Boolean(telemetryState.config.otelEndpoint),
    otelReady: telemetryState.otelReady,
    measurementID: telemetryState.config.measurementID,
  };
}

export function trackPageView() {
  return trackEvent(telemetryEventNames.pageView, sanitizedPageParams());
}

export function trackEvent(name, params = {}) {
  if (!telemetryState.gaEnabled || typeof telemetryState.gtag !== "function") {
    return false;
  }
  const eventName = safeParamString(name);
  const safeParams = sanitizeTelemetryParams(params);
  telemetryState.gtag("event", eventName, safeParams);
  return { name: eventName, params: safeParams };
}

export async function traceAsync(name, action, attributes = {}) {
  const span = startTelemetrySpan(name, attributes);
  const startedAt = now();
  try {
    const result = await action();
    finishTelemetrySpan(span, {
      duration_ms: elapsedMilliseconds(startedAt),
      ok: true,
    });
    return result;
  } catch (error) {
    finishTelemetrySpan(span, {
      duration_ms: elapsedMilliseconds(startedAt),
      ok: false,
      error_category: categorizeError(error),
    }, error);
    throw error;
  }
}

export function traceSync(name, action, attributes = {}) {
  const span = startTelemetrySpan(name, attributes);
  const startedAt = now();
  try {
    const result = action();
    finishTelemetrySpan(span, {
      duration_ms: elapsedMilliseconds(startedAt),
      ok: true,
    });
    return result;
  } catch (error) {
    finishTelemetrySpan(span, {
      duration_ms: elapsedMilliseconds(startedAt),
      ok: false,
      error_category: categorizeError(error),
    }, error);
    throw error;
  }
}

export function bucketBytes(byteCount) {
  const value = Number(byteCount);
  if (!Number.isFinite(value) || value <= 0) return "empty";
  if (value < byteBucketSmallLimit) return "lt_10kb";
  if (value < byteBucketMediumLimit) return "10kb_100kb";
  if (value < byteBucketLargeLimit) return "100kb_1mb";
  if (value < byteBucketHugeLimit) return "1mb_5mb";
  return "gte_5mb";
}

export function categorizeError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  if (message.includes("network") || message.includes("fetch")) return "network";
  if (message.includes("webassembly") || message.includes("wasm")) return "wasm";
  if (message.includes("json") || message.includes("parse") || message.includes("invalid")) return "input";
  if (message.includes("timeout") || message.includes("timed out")) return "timeout";
  return "unknown";
}

export function elapsedMilliseconds(startedAt) {
  const elapsed = now() - Number(startedAt);
  if (!Number.isFinite(elapsed) || elapsed < 0) return 0;
  return Math.round(elapsed * durationPrecision) / durationPrecision;
}

export function sanitizeTelemetryParams(params = {}) {
  const safeParams = {};
  for (const [key, value] of Object.entries(params || {})) {
    const safeKey = safeParamString(key);
    const safeValue = safeParamValue(value);
    if (safeKey && safeValue !== undefined) {
      safeParams[safeKey] = safeValue;
    }
  }
  return safeParams;
}

export function sanitizedPageParams() {
  const location = telemetryState.environment.win?.location;
  const pathname = location?.pathname || "/";
  const origin = location?.origin || "";
  return {
    page_title: telemetryState.environment.doc?.title || defaultTelemetryServiceName,
    page_location: `${origin}${pathname}`,
    page_path: pathname,
  };
}

export async function loadOpenTelemetryWebSDK(config, environment = defaultEnvironment()) {
  const importModule = environment.importModule || ((specifier) => import(specifier));
  const moduleBaseURL = trimTrailingSlash(config.otelModuleBaseURL || defaultOtelModuleBaseURL);
  const apiPackageVersion = config.otelAPIPackageVersion || defaultOtelAPIPackageVersion;
  const packageVersion = config.otelPackageVersion || defaultOtelPackageVersion;
  const [api, traceWeb, traceBase, traceExporter] = await Promise.all([
    importModule(otelModuleURL(moduleBaseURL, otelPackageNames.api, apiPackageVersion)),
    importModule(otelModuleURL(moduleBaseURL, otelPackageNames.traceWeb, packageVersion)),
    importModule(otelModuleURL(moduleBaseURL, otelPackageNames.traceBase, packageVersion)),
    importModule(otelModuleURL(moduleBaseURL, otelPackageNames.traceExporter, packageVersion)),
  ]);
  const exporter = new traceExporter.OTLPTraceExporter({ url: config.otelEndpoint });
  const spanProcessor = new traceBase.BatchSpanProcessor(exporter);
  const provider = new traceWeb.WebTracerProvider({
    spanProcessors: [spanProcessor],
  });
  if (typeof provider.addSpanProcessor === "function") {
    provider.addSpanProcessor(spanProcessor);
  }
  provider.register();
  return api.trace.getTracer(config.otelServiceName || defaultTelemetryServiceName);
}

function readTelemetryConfig() {
  const win = typeof window !== "undefined" ? window : undefined;
  return win?.[telemetryConfigGlobal] || {};
}

function initialTelemetryState(environment = {}) {
  return {
    enabled: false,
    gaEnabled: false,
    otelReady: false,
    otelReadyPromise: null,
    pendingSpans: [],
    tracer: null,
    gtag: null,
    config: normalizeTelemetryConfig({}),
    environment: {
      ...defaultEnvironment(),
      ...environment,
    },
  };
}

function defaultEnvironment() {
  const win = typeof window !== "undefined" ? window : undefined;
  const doc = typeof document !== "undefined" ? document : undefined;
  const perf = typeof performance !== "undefined" ? performance : undefined;
  return {
    win,
    doc,
    now: () => perf?.now?.() ?? Date.now(),
    wallNow: () => Date.now(),
    loadOpenTelemetry: loadOpenTelemetryWebSDK,
  };
}

function normalizeTelemetryConfig(config) {
  const source = config && typeof config === "object" ? config : {};
  return {
    enabled: source.enabled !== false,
    measurementID: safeConfigString(source.measurementID),
    allowedHosts: normalizeAllowedHosts(source.allowedHosts),
    otelEndpoint: safeConfigString(source.otelEndpoint),
    otelModuleBaseURL: safeConfigString(source.otelModuleBaseURL),
    otelAPIPackageVersion: safeConfigString(source.otelAPIPackageVersion),
    otelPackageVersion: safeConfigString(source.otelPackageVersion),
    otelServiceName: safeConfigString(source.otelServiceName) || defaultTelemetryServiceName,
    loadGoogleAnalyticsScript: source.loadGoogleAnalyticsScript !== false,
  };
}

function normalizeAllowedHosts(hosts) {
  if (!Array.isArray(hosts) || hosts.length === 0) return defaultTelemetryHosts.slice();
  return hosts.map((host) => safeConfigString(host)).filter(Boolean);
}

function isTelemetryAllowed(config, location) {
  if (!config.enabled) return false;
  if (!config.measurementID && !config.otelEndpoint) return false;
  const hostname = location?.hostname || "";
  return config.allowedHosts.includes(hostname);
}

function initGoogleAnalytics() {
  const win = telemetryState.environment.win;
  if (!win) return;
  win.dataLayer = win.dataLayer || [];
  const existingGtag = typeof win.gtag === "function" ? win.gtag.bind(win) : null;
  telemetryState.gtag = existingGtag || ((...args) => win.dataLayer.push(args));
  win.gtag = telemetryState.gtag;
  if (telemetryState.config.loadGoogleAnalyticsScript) {
    appendAnalyticsScript(telemetryState.config.measurementID);
  }
  telemetryState.gtag("js", new Date());
  telemetryState.gtag("config", telemetryState.config.measurementID, {
    send_page_view: false,
  });
  telemetryState.gaEnabled = true;
}

function appendAnalyticsScript(measurementID) {
  const doc = telemetryState.environment.doc;
  if (!doc?.createElement) return;
  const script = doc.createElement("script");
  script.async = true;
  script.src = `${googleAnalyticsScriptBaseURL}?id=${encodeURIComponent(measurementID)}`;
  const parent = doc.head || doc.documentElement || doc.body;
  parent?.append(script);
}

async function initOpenTelemetry() {
  try {
    const loader = telemetryState.environment.loadOpenTelemetry || loadOpenTelemetryWebSDK;
    telemetryState.tracer = await loader(telemetryState.config, telemetryState.environment);
    telemetryState.otelReady = Boolean(telemetryState.tracer);
    flushPendingSpans();
  } catch (error) {
    trackEvent(telemetryEventNames.otelInitFailed, {
      error_category: categorizeError(error),
    });
  }
}

function startTelemetrySpan(name, attributes = {}) {
  const spanName = safeParamString(name);
  const safeAttributes = sanitizeTelemetryParams(attributes);
  if (telemetryState.tracer?.startSpan) {
    return {
      kind: "otel",
      span: telemetryState.tracer.startSpan(spanName, {
        attributes: safeAttributes,
      }),
    };
  }
  if (telemetryState.config.otelEndpoint) {
    return {
      kind: "pending",
      name: spanName,
      attributes: safeAttributes,
      startedAt: wallNow(),
    };
  }
  return null;
}

function finishTelemetrySpan(span, attributes = {}, error) {
  if (!span) return;
  const safeAttributes = sanitizeTelemetryParams(attributes);
  const errorCategory = error ? categorizeError(error) : "";
  if (span.kind === "pending") {
    if (telemetryState.pendingSpans.length >= pendingSpanLimit) return;
    telemetryState.pendingSpans.push({
      name: span.name,
      attributes: {
        ...span.attributes,
        ...safeAttributes,
      },
      errorCategory,
      startedAt: span.startedAt,
      endedAt: wallNow(),
    });
    return;
  }
  finishOtelSpan(span.span, safeAttributes, errorCategory);
}

function finishOtelSpan(span, attributes = {}, errorCategory = "", endTime) {
  if (!span) return;
  for (const [key, value] of Object.entries(attributes)) {
    span.setAttribute?.(key, value);
  }
  if (errorCategory) {
    span.recordException?.({ name: errorCategory });
    span.setStatus?.({ code: otelStatusCodeError, message: errorCategory });
  }
  span.end?.(endTime);
}

function flushPendingSpans() {
  if (!telemetryState.tracer?.startSpan || telemetryState.pendingSpans.length === 0) return;
  const pendingSpans = telemetryState.pendingSpans.splice(0);
  for (const pending of pendingSpans) {
    const span = telemetryState.tracer.startSpan(pending.name, {
      attributes: pending.attributes,
      startTime: pending.startedAt,
    });
    finishOtelSpan(span, {}, pending.errorCategory, pending.endedAt);
  }
}

function safeParamString(value) {
  return String(value || "").trim().slice(0, maxStringParamLength);
}

function safeConfigString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function safeParamValue(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") return safeParamString(value);
  return undefined;
}

function now() {
  return telemetryState.environment.now();
}

function wallNow() {
  return telemetryState.environment.wallNow?.() ?? Date.now();
}

function exposeTelemetryDebugAPI() {
  const win = telemetryState.environment.win;
  if (!win) return;
  win.motelTelemetry = {
    bucketBytes,
    eventNames: telemetryEventNames,
    snapshot: telemetrySnapshot,
    spanNames: telemetrySpanNames,
  };
}

function otelModuleURL(baseURL, packageName, packageVersion) {
  return `${baseURL}/${packageName}@${packageVersion}`;
}

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}
