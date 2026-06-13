import { randomTopologyYaml } from "./topology-generator.mjs";

const sampleTopology = `# Five-service topology demonstrating motel capabilities
version: 1

services:
  gateway:
    resource_attributes:
      deployment.environment: production
      service.namespace: demo
    operations:
      GET /users:
        duration: 30ms +/- 10ms
        error_rate: 0.1%
        attributes:
          http.request.method:
            value: GET
          http.route:
            value: "/api/v1/users"
        calls:
          - user-service.list
      POST /orders:
        duration: 80ms +/- 20ms
        error_rate: 0.5%
        calls:
          - order-service.create

  user-service:
    operations:
      list:
        duration: 20ms +/- 5ms
        error_rate: 0.1%
        calls:
          - postgres.query

  order-service:
    operations:
      create:
        duration: 50ms +/- 15ms
        error_rate: 0.5%
        call_style: parallel
        calls:
          - postgres.query
          - redis.get

  postgres:
    operations:
      query:
        duration: 5ms +/- 2ms
        error_rate: 0.01%

  redis:
    operations:
      get:
        duration: 1ms +/- 0.5ms
        error_rate: 0.001%

traffic:
  rate: 12/s

scenarios:
  - name: database degradation
    at: +15s
    duration: 25s
    override:
      postgres.query:
        duration: 500ms +/- 100ms
        error_rate: 15%
`;

const state = {
  ready: false,
  lastRun: null,
  currentTopology: null,
};

const els = {
  editor: document.querySelector("#editor"),
  status: document.querySelector("#runtime-status"),
  theme: document.querySelector("#theme-toggle"),
  file: document.querySelector("#topology-file"),
  load: document.querySelector("#load-button"),
  save: document.querySelector("#save-button"),
  generate: document.querySelector("#generate-button"),
  validate: document.querySelector("#validate-button"),
  run: document.querySelector("#run-button"),
  duration: document.querySelector("#duration"),
  seed: document.querySelector("#seed"),
  preview: document.querySelector("#preview"),
  traces: document.querySelector("#traces"),
  map: document.querySelector("#service-map"),
  raw: document.querySelector("#raw-output"),
  summary: document.querySelector("#summary-line"),
  metrics: {
    traces: document.querySelector("#metric-traces"),
    spans: document.querySelector("#metric-spans"),
    errors: document.querySelector("#metric-errors"),
  },
};

els.editor.value = sampleTopology;
els.map.innerHTML = `<p class="empty">Open the map tab to render the service graph.</p>`;

initTheme();

for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((item) => item.classList.remove("active"));
    document.querySelectorAll(".view").forEach((item) => item.classList.remove("active"));
    tab.classList.add("active");
    document.querySelector(`#view-${tab.dataset.view}`).classList.add("active");
    if (tab.dataset.view === "map" && state.currentTopology) {
      renderMap(state.currentTopology, state.lastRun?.spans ?? []);
    }
  });
}

els.theme.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  setTheme(next);
  localStorage.setItem("motel-playground-theme", next);
  if (state.currentTopology) renderMap(state.currentTopology, state.lastRun?.spans ?? []);
});

els.validate.addEventListener("click", () => validate());
els.run.addEventListener("click", () => run());
els.generate.addEventListener("click", () => generateTopology());
els.load.addEventListener("click", () => els.file.click());
els.save.addEventListener("click", () => saveTopology());
els.file.addEventListener("change", () => loadTopologyFile());

loadWasm();

function initTheme() {
  const stored = localStorage.getItem("motel-playground-theme");
  const preferred = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  setTheme(stored || preferred);
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const dark = theme === "dark";
  els.theme.setAttribute("aria-pressed", String(dark));
  els.theme.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
}

async function loadWasm() {
  try {
    const go = new Go();
    const result = await WebAssembly.instantiateStreaming(fetch("./motel.wasm"), go.importObject);
    go.run(result.instance);
    state.ready = true;
    els.status.textContent = "Runtime ready";
    els.status.classList.add("ready");
    await validate({ passive: true });
  } catch (error) {
    els.status.textContent = "Build runtime first";
    els.status.classList.add("error");
    els.raw.textContent = String(error);
  }
}

async function validate({ passive = false } = {}) {
  if (!state.ready) return;
  setBusy(true, "Validating", { resetValidate: false });
  if (!passive) {
    els.validate.textContent = "Validating";
    els.validate.classList.remove("validated");
  }
  try {
    const result = JSON.parse(await window.motelValidate(els.editor.value));
    renderValidation(result);
    if (result.ok) {
      await renderPreview();
    }
    els.raw.textContent = JSON.stringify(result, null, 2);
  } finally {
    setBusy(false, "Runtime ready");
    if (!passive) {
      els.validate.textContent = "Validated";
      els.validate.classList.add("validated");
    }
  }
}

async function run() {
  if (!state.ready) return;
  setBusy(true, "Running");
  try {
    const result = JSON.parse(await window.motelRun(
      els.editor.value,
      Number(els.duration.value),
      Number(els.seed.value),
    ));
    state.lastRun = result;
    renderRun(result);
    els.raw.textContent = JSON.stringify(result, null, 2);
  } finally {
    setBusy(false, "Runtime ready");
  }
}

async function generateTopology() {
  const seed = Math.max(1, Math.floor(Number(els.seed.value) || Date.now()));
  const topology = randomTopologyYaml(seed);
  els.editor.value = topology;
  els.summary.classList.remove("bad");
  els.summary.textContent = "Generated topology";
  els.metrics.traces.textContent = "0";
  els.metrics.spans.textContent = "0";
  els.metrics.errors.textContent = "0%";
  els.traces.innerHTML = `<p class="empty">Run the topology to inspect spans.</p>`;
  els.raw.textContent = "";
  state.lastRun = null;
  if (state.ready) await validate({ passive: true });
}

async function loadTopologyFile() {
  const [file] = els.file.files ?? [];
  if (!file) return;
  try {
    els.editor.value = await file.text();
    els.summary.classList.remove("bad", "good");
    els.summary.textContent = `Loaded ${file.name}`;
    els.metrics.traces.textContent = "0";
    els.metrics.spans.textContent = "0";
    els.metrics.errors.textContent = "0%";
    els.traces.innerHTML = `<p class="empty">Run the topology to inspect spans.</p>`;
    els.raw.textContent = "";
    state.lastRun = null;
    if (state.ready) await validate({ passive: true });
  } catch (error) {
    els.summary.textContent = `Could not load file: ${error.message}`;
    els.summary.classList.remove("good");
    els.summary.classList.add("bad");
  } finally {
    els.file.value = "";
  }
}

function saveTopology() {
  const blob = new Blob([els.editor.value], { type: "text/yaml" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = topologyFilename();
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  els.summary.classList.remove("bad");
  els.summary.textContent = `Saved ${link.download}`;
}

function topologyFilename() {
  const seed = Math.max(1, Math.floor(Number(els.seed.value) || Date.now()));
  return `motel-topology-${seed}.yaml`;
}

async function renderPreview() {
  const svg = await window.motelPreview(els.editor.value, 300);
  els.preview.innerHTML = svg;
}

function renderValidation(result) {
  if (!result.ok) {
    const diagnostics = result.diagnostics ?? [];
    const message = diagnostics[0]?.message ?? "Topology is invalid";
    els.summary.textContent = `Invalid topology: ${message}`;
    els.summary.classList.remove("good");
    els.summary.classList.add("bad");
    return;
  }
  const topology = result.topology;
  state.currentTopology = topology;
  els.summary.classList.add("good");
  els.summary.classList.remove("bad");
  els.summary.textContent = `Valid topology: ${topology.services.length} services, ${topology.operations} operations, ${topology.edges} calls`;
  renderMap(topology, []);
}

function renderRun(result) {
  if (!result.ok) {
    els.summary.textContent = result.errors?.[0]?.message ?? "Run failed";
    els.summary.classList.add("bad");
    return;
  }
  const stats = result.stats;
  state.currentTopology = result.topology;
  els.metrics.traces.textContent = stats.traces;
  els.metrics.spans.textContent = stats.spans;
  els.metrics.errors.textContent = `${Math.round(stats.error_rate * 1000) / 10}%`;
  const capturedErrors = (result.spans ?? []).filter((span) => span.is_error).length;
  if (stats.errors > capturedErrors) {
    els.summary.textContent = `${stats.traces} traces, ${stats.spans} spans, ${stats.errors} errors (${capturedErrors} captured)`;
  }
  renderSpans(result.spans ?? []);
  renderMap(result.topology, result.spans ?? []);
}

function renderSpans(spans) {
  const orderedSpans = spans
    .slice()
    .sort(compareSpans);
  if (orderedSpans.length === 0) {
    els.traces.innerHTML = `<p class="empty">No spans captured yet.</p>`;
    return;
  }
  const traceGroups = groupSpansByTrace(orderedSpans);
  const maxDuration = Math.max(...orderedSpans.map((span) => span.duration_ms), 1);
  els.traces.innerHTML = traceGroups.map((trace, traceIndex) => {
    const panelID = `trace-panel-${traceIndex}`;
    return `<article class="trace-group ${trace.errors ? "errored" : ""}">
      <button class="trace-row" type="button" aria-expanded="${traceIndex === 0 ? "true" : "false"}" aria-controls="${panelID}">
        <span class="trace-meta">
          <strong>${escapeHtml(trace.root.service)}</strong>
          <span>${trace.spans.length} spans · ${trace.errors} errors · ${escapeHtml(trace.id)}</span>
        </span>
        <span class="trace-duration">${trace.duration.toFixed(1)}ms</span>
      </button>
      <div class="trace-drawer" id="${panelID}" ${traceIndex === 0 ? "" : "hidden"}>
        ${trace.spans.map((span, spanIndex) => renderSpanRow({ ...span, display_trace_id: trace.id }, maxDuration, `${traceIndex}-${spanIndex}`)).join("")}
      </div>
    </article>`;
  }).join("");

  for (const row of els.traces.querySelectorAll(".trace-row, .span-row")) {
    row.addEventListener("click", () => {
      const drawer = document.getElementById(row.getAttribute("aria-controls"));
      const expanded = row.getAttribute("aria-expanded") === "true";
      row.setAttribute("aria-expanded", String(!expanded));
      drawer.hidden = expanded;
    });
  }
}

function renderSpanRow(span, maxDuration, id) {
  const width = Math.max(4, Math.round((span.duration_ms / maxDuration) * 100));
  const panelID = `span-panel-${id}`;
  return `<article class="span-item ${span.is_error ? "errored" : ""}">
    <button class="span-row" type="button" aria-expanded="false" aria-controls="${panelID}">
        <span class="span-meta">
          <strong>${escapeHtml(span.service)}</strong>
          <span>${escapeHtml(span.operation)}</span>
        </span>
        <span class="bar-track" aria-hidden="true"><span class="bar" style="width:${width}%"></span></span>
        <time>${span.duration_ms.toFixed(1)}ms</time>
      </button>
      <div class="span-drawer" id="${panelID}" hidden>
        ${renderSpanDetails(span)}
      </div>
    </article>`;
}

function groupSpansByTrace(spans) {
  if (!spans.some((span) => usableTraceID(span.trace_id))) {
    return deriveTraceGroups(spans);
  }
  const groups = new Map();
  for (const span of spans) {
    const traceID = span.trace_id;
    if (!groups.has(traceID)) groups.set(traceID, []);
    groups.get(traceID).push(span);
  }
  return Array.from(groups, ([id, traceSpans]) => makeTraceGroup(id, traceSpans))
    .sort((a, b) => a.start - b.start);
}

function deriveTraceGroups(spans) {
  const roots = spans
    .filter((span) => !span.parent_service)
    .sort(compareSpans);
  if (!roots.length) return [makeTraceGroup("trace 1", spans)];
  const grouped = roots.map((root, index) => ({
    id: `trace ${index + 1}`,
    root,
    spans: [root],
  }));
  for (const span of spans) {
    if (!span.parent_service) continue;
    const start = span.timestamp_ms ?? 0;
    const owner = grouped.find((group, index) => {
      const rootStart = group.root.timestamp_ms ?? 0;
      const nextStart = grouped[index + 1]?.root.timestamp_ms ?? Infinity;
      return start >= rootStart && start < nextStart;
    }) ?? grouped[grouped.length - 1];
    owner.spans.push(span);
  }
  return grouped.map((group) => makeTraceGroup(group.id, group.spans, group.root))
    .sort((a, b) => a.start - b.start);
}

function makeTraceGroup(id, traceSpans, knownRoot) {
    traceSpans.sort(compareSpans);
    const first = traceSpans[0];
    const last = traceSpans.reduce((latest, span) => {
      const spanEnd = (span.timestamp_ms ?? 0) + (span.duration_ms ?? 0);
      const latestEnd = (latest.timestamp_ms ?? 0) + (latest.duration_ms ?? 0);
      return spanEnd > latestEnd ? span : latest;
    }, first);
    const root = knownRoot ?? traceSpans.find((span) => !span.parent_service) ?? first;
    const start = first.timestamp_ms ?? 0;
    const end = (last.timestamp_ms ?? start) + (last.duration_ms ?? 0);
    return {
      id,
      spans: traceSpans,
      root,
      start,
      duration: Math.max(0, end - start),
      errors: traceSpans.filter((span) => span.is_error).length,
    };
}

function usableTraceID(traceID) {
  return Boolean(traceID && !/^0+$/.test(traceID));
}

function compareSpans(a, b) {
  const timestampDelta = (a.timestamp_ms ?? 0) - (b.timestamp_ms ?? 0);
  if (timestampDelta !== 0) return timestampDelta;
  const durationDelta = (b.duration_ms ?? 0) - (a.duration_ms ?? 0);
  if (durationDelta !== 0) return durationDelta;
  return `${a.service}.${a.operation}`.localeCompare(`${b.service}.${b.operation}`);
}

function renderSpanDetails(span) {
  const parent = span.parent_service
    ? `${span.parent_service}.${span.parent_operation || "(unknown)"}`
    : "root span";
  const scenarios = span.scenarios?.length ? span.scenarios.join(", ") : "none";
  const timestamp = Number.isFinite(span.timestamp_ms)
    ? new Date(span.timestamp_ms).toISOString()
    : "unknown";
  const attributes = Object.entries(span.attributes ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return `<div class="span-facts">
    ${spanFact("trace", span.display_trace_id || span.trace_id || "unknown")}
    ${spanFact("span", usableTraceID(span.span_id) ? span.span_id : "synthetic")}
    ${spanFact("status", span.is_error ? "error" : "ok")}
    ${spanFact("kind", span.kind || "internal")}
    ${spanFact("parent", parent)}
    ${spanFact("timestamp", timestamp)}
    ${spanFact("duration", `${span.duration_ms.toFixed(3)}ms`)}
    ${spanFact("scenarios", scenarios)}
  </div>
  ${attributes.length ? `<dl class="span-attributes">
    ${attributes.map(([key, value]) => `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}
  </dl>` : `<p class="empty span-empty">No span attributes.</p>`}`;
}

function spanFact(label, value) {
  return `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function renderMap(topology, spans) {
  if (!topology) return;
  if (!document.querySelector("#view-map").classList.contains("active")) return;
  if (topology.graph && window.renderP5Map) {
    window.renderP5Map(els.map, topology.graph, spans);
    return;
  }
  const counts = new Map();
  for (const span of spans) {
    counts.set(span.service, (counts.get(span.service) ?? 0) + 1);
  }
  els.map.innerHTML = topology.services.map((service) => {
    const opList = service.operations.map((operation) => {
      const callText = operation.calls?.length ? ` -> ${operation.calls.join(", ")}` : "";
      return `<li><span>${escapeHtml(operation.ref)}</span><small>${escapeHtml(operation.duration)}${escapeHtml(callText)}</small></li>`;
    }).join("");
    return `<section class="service-node">
      <div><strong>${escapeHtml(service.name)}</strong><span>${counts.get(service.name) ?? 0} spans</span></div>
      <ol>${opList}</ol>
    </section>`;
  }).join("");
}

function setBusy(isBusy, label, { resetValidate = true } = {}) {
  els.status.textContent = label;
  els.load.disabled = isBusy;
  els.save.disabled = isBusy;
  els.generate.disabled = isBusy;
  els.validate.disabled = isBusy;
  els.run.disabled = isBusy;
  if (isBusy && resetValidate) {
    els.validate.textContent = "Validate";
    els.validate.classList.remove("validated");
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
