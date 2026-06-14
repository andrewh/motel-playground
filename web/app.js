import { randomTopologyYaml } from "./topology-generator.mjs";
import {
  decodeSharePayload,
  getShareToken,
  isShareURLTooLarge,
  makeShareURL,
} from "./share-state.mjs";
import {
  createResultSnapshot,
  normalizeResultSnapshot,
  parseResultSnapshot,
  resultSnapshotFilename,
  resultSnapshotMimeType,
} from "./result-snapshot.mjs";

const sampleTopology = `# Five-service topology demonstrating motel capabilities
version: 1

services:
  gateway:
    resource_attributes:
      deployment.environment: production
      service.namespace: demo
    metrics:
      - name: gateway.request.duration
        type: histogram
        unit: ms
      - name: gateway.error.count
        type: counter
        errors_only: true
    logs:
      - severity: INFO
        body: "gateway handled {operation.name}"
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
    at: +200ms
    duration: 600ms
    override:
      postgres.query:
        duration: 500ms +/- 100ms
        error_rate: 15%
`;

const p5ScriptPath = "./vendor/p5/p5.min.js";
const firstResultTabIndex = 0;
const nextResultTabOffset = 1;
const previousResultTabOffset = -1;
const reportHashLength = 12;
const reportMapCellHeight = 116;
const reportMapCellWidth = 190;
const reportMapEdgeBaseWidth = 1.2;
const reportMapEdgeMaxBoost = 3;
const reportMapNodeHeight = 48;
const reportMapNodeLabelLength = 24;
const reportMapNodeWidth = 132;
const reportMapPadding = 48;
const reportTableRowLimit = 80;

const state = {
  ready: false,
  lastRun: null,
  lastRunSource: null,
  currentTopology: null,
  errorTracesOnly: false,
  warnLogsOnly: false,
  resultFilter: "",
  editorRevision: 0,
  runtimeBusy: false,
  runBusy: false,
  activeRunID: 0,
  runner: null,
  p5Loading: null,
  rawOutput: "",
  rawOutputJSON: false,
  rawOutputDirty: false,
};

const emptyCopy = {
  spans: "Run the topology to inspect spans.",
  invalidSpans: "Fix validation errors before running the topology.",
  runFailedSpans: "Run failed; no spans are available.",
  metrics: "Run the topology to inspect metrics.",
  logs: "Run the topology to inspect logs.",
  invalidMetrics: "Fix validation errors before running the topology.",
  invalidLogs: "Fix validation errors before running the topology.",
  runFailedMetrics: "Run failed; no metrics are available.",
  runFailedLogs: "Run failed; no logs are available.",
  map: "Open the map tab to render the service graph.",
  invalidMap: "Fix validation errors to render the service map.",
  invalidPreview: "Fix validation errors to preview traffic.",
};

const els = {
  editor: document.querySelector("#editor"),
  status: document.querySelector("#runtime-status"),
  theme: document.querySelector("#theme-toggle"),
  shortcutHelp: document.querySelector("#shortcut-help"),
  shortcutHelpPanel: document.querySelector("#shortcut-help .shortcut-modal"),
  shortcutHelpButton: document.querySelector("#shortcut-help-button"),
  shortcutHelpClose: document.querySelector("#shortcut-help-close"),
  file: document.querySelector("#topology-file"),
  load: document.querySelector("#load-button"),
  save: document.querySelector("#save-button"),
  share: document.querySelector("#share-button"),
  resultFile: document.querySelector("#result-file"),
  importResults: document.querySelector("#import-results-button"),
  exportResults: document.querySelector("#export-results-button"),
  printReport: document.querySelector("#print-report-button"),
  generate: document.querySelector("#generate-button"),
  validate: document.querySelector("#validate-button"),
  run: document.querySelector("#run-button"),
  duration: document.querySelector("#duration"),
  maxNodes: document.querySelector("#max-nodes"),
  seed: document.querySelector("#seed"),
  resultFilter: document.querySelector("#result-filter"),
  preview: document.querySelector("#preview"),
  traces: document.querySelector("#traces"),
  errorFilter: document.querySelector("#error-filter"),
  spanFilterCount: document.querySelector("#span-filter-count"),
  signalMetrics: document.querySelector("#signal-metrics"),
  signalLogs: document.querySelector("#signal-logs"),
  logSeverityFilter: document.querySelector("#log-severity-filter"),
  logFilterCount: document.querySelector("#log-filter-count"),
  map: document.querySelector("#service-map"),
  raw: document.querySelector("#raw-output"),
  summary: document.querySelector("#summary-line"),
  shareStatus: document.querySelector("#share-status"),
  report: document.querySelector("#print-report"),
  metrics: {
    traces: document.querySelector("#metric-traces"),
    spans: document.querySelector("#metric-spans"),
    errors: document.querySelector("#metric-errors"),
  },
};

const resultTabs = Array.from(document.querySelectorAll(".tab"));
const resultViewNames = new Set(resultTabs.map((tab) => tab.dataset.view));
const editors = {
  topology: null,
  raw: null,
};
let lastShortcutFocus = null;

els.editor.value = sampleTopology;
clearMap(emptyCopy.map);
clearSignalOutput();

initTheme();
initEditors();

for (const tab of resultTabs) {
  tab.addEventListener("click", () => {
    activateTab(tab);
  });
  tab.addEventListener("keydown", (event) => handleResultTabKeydown(event, tab));
}

els.theme.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  setTheme(next);
  localStorage.setItem("motel-playground-theme", next);
  if (state.currentTopology) renderMap(state.currentTopology, state.lastRun?.spans ?? []);
  if (state.currentTopology) void renderPreview();
});

els.shortcutHelpButton.addEventListener("click", () => openShortcutHelp());
els.shortcutHelpClose.addEventListener("click", () => closeShortcutHelp());
els.shortcutHelp.addEventListener("click", (event) => {
  if (event.target === els.shortcutHelp) closeShortcutHelp();
});
els.shortcutHelpPanel.addEventListener("keydown", (event) => {
  if (event.key === "Tab") trapShortcutHelpFocus(event);
});
document.addEventListener("keydown", handleGlobalShortcut);

els.validate.addEventListener("click", () => validate());
els.run.addEventListener("click", () => run());
els.generate.addEventListener("click", () => generateTopology());
els.load.addEventListener("click", () => els.file.click());
els.save.addEventListener("click", () => saveTopology());
els.share.addEventListener("click", () => {
  void copyShareURL();
});
els.importResults.addEventListener("click", () => els.resultFile.click());
els.exportResults.addEventListener("click", () => exportResults());
els.printReport.addEventListener("click", () => printReport());
els.file.addEventListener("change", () => loadTopologyFile());
els.resultFile.addEventListener("change", () => {
  void loadResultsFile();
});
els.errorFilter.addEventListener("click", () => {
  state.errorTracesOnly = !state.errorTracesOnly;
  renderSpans(state.lastRun?.spans ?? []);
});
els.logSeverityFilter.addEventListener("click", () => {
  state.warnLogsOnly = !state.warnLogsOnly;
  renderLogs(state.lastRun?.logs ?? []);
});
els.resultFilter.addEventListener("input", () => {
  state.resultFilter = els.resultFilter.value.trim().toLowerCase();
  renderFilteredResults();
});
els.duration.addEventListener("input", () => {
  if (state.ready && state.currentTopology && !state.runtimeBusy) {
    void renderPreview();
  }
});
els.editor.addEventListener("input", () => {
  if (editors.topology && editors.topology.getValue() !== els.editor.value) {
    editors.topology.setValue(els.editor.value);
    return;
  }
  markEditorChanged();
});
window.addEventListener("hashchange", () => {
  void restoreShareStateFromURL();
});
window.addEventListener("beforeprint", () => {
  if (!state.lastRun) return;
  renderPrintableReport(makeCurrentResultSnapshot());
  document.body.classList.add("report-ready");
});

void restoreShareStateFromURL();
syncControls();
loadWasm();

function activateTab(tab) {
  for (const item of resultTabs) {
    const selected = item === tab;
    const panel = document.querySelector(`#view-${item.dataset.view}`);
    item.classList.toggle("active", selected);
    item.setAttribute("aria-selected", String(selected));
    item.tabIndex = selected ? 0 : -1;
    if (panel) {
      panel.classList.toggle("active", selected);
      panel.hidden = !selected;
    }
  }
  if (tab.dataset.view === "map" && state.currentTopology) {
    renderMap(state.currentTopology, state.lastRun?.spans ?? []);
  }
  if (tab.dataset.view === "raw") {
    flushRawOutput();
    editors.raw?.refresh();
    if (editors.raw) syncCodeMirrorGutter(editors.raw);
  }
}

function handleResultTabKeydown(event, tab) {
  let nextIndex;
  if (event.key === "Home") {
    nextIndex = firstResultTabIndex;
  } else if (event.key === "End") {
    nextIndex = resultTabs.length - nextResultTabOffset;
  } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
    nextIndex = (resultTabs.indexOf(tab) + previousResultTabOffset + resultTabs.length) % resultTabs.length;
  } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
    nextIndex = (resultTabs.indexOf(tab) + nextResultTabOffset) % resultTabs.length;
  } else {
    return;
  }
  event.preventDefault();
  const nextTab = resultTabs[nextIndex];
  activateTab(nextTab);
  nextTab.focus({ preventScroll: true });
}

function handleGlobalShortcut(event) {
  if (event.defaultPrevented || event.isComposing) return;
  if (isShortcutHelpOpen()) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeShortcutHelp();
    }
    return;
  }

  const commandKey = event.metaKey || event.ctrlKey;
  const typing = isTextEntryTarget(event.target);
  const key = event.key.toLowerCase();

  if (event.key === "Escape") {
    if (typing) {
      event.preventDefault();
      if (document.activeElement === els.resultFilter && els.resultFilter.value) {
        els.resultFilter.value = "";
        els.resultFilter.dispatchEvent(new Event("input", { bubbles: true }));
      }
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    }
    return;
  }

  if (typing) return;

  if (commandKey && !event.altKey && key === "s") {
    event.preventDefault();
    if (!els.save.disabled) saveTopology();
    return;
  }

  if (commandKey && !event.altKey && key === "o") {
    event.preventDefault();
    if (!els.load.disabled) els.file.click();
    return;
  }

  if (commandKey && !event.altKey && event.key === "Enter") {
    event.preventDefault();
    if (event.shiftKey) {
      if (!els.validate.disabled) validate();
    } else if (!els.run.disabled) {
      run();
    }
    return;
  }

  if (commandKey && !event.altKey && key === "k") {
    event.preventDefault();
    focusResultFilter();
    return;
  }

  if (event.metaKey || event.ctrlKey || event.altKey) return;

  if (event.key === "?") {
    event.preventDefault();
    openShortcutHelp();
    return;
  }

  if (event.key === "/") {
    event.preventDefault();
    focusResultFilter();
    return;
  }

  if (/^[1-6]$/.test(event.key)) {
    event.preventDefault();
    activateTab(resultTabs[Number(event.key) - 1]);
  }
}

function isTextEntryTarget(target) {
  if (!(target instanceof Element)) return false;
  if (target.closest('[contenteditable="true"]')) return true;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function focusResultFilter() {
  els.resultFilter.focus({ preventScroll: true });
  els.resultFilter.select();
}

function initEditors() {
  if (!window.CodeMirror) return;
  editors.topology = window.CodeMirror.fromTextArea(els.editor, {
    mode: "yaml",
    lineNumbers: true,
    lineWrapping: false,
    fixedGutter: true,
    foldGutter: true,
    gutters: ["CodeMirror-linenumbers", "CodeMirror-foldgutter"],
    indentUnit: 2,
    tabSize: 2,
    extraKeys: {
      Tab: (editor) => editor.replaceSelection("  ", "end"),
      Esc: (editor) => editor.getInputField().blur(),
      "Ctrl-Q": (editor) => editor.foldCode(editor.getCursor()),
    },
  });
  editors.topology.on("change", () => {
    editors.topology.save();
    syncCodeMirrorGutter(editors.topology);
    markEditorChanged();
  });
  syncCodeMirrorGutter(editors.topology);

  editors.raw = window.CodeMirror(els.raw, {
    value: "",
    mode: { name: "javascript", json: true },
    lineNumbers: true,
    readOnly: true,
    lineWrapping: false,
    fixedGutter: true,
    foldGutter: true,
    gutters: ["CodeMirror-linenumbers", "CodeMirror-foldgutter"],
    indentUnit: 2,
    tabSize: 2,
    extraKeys: {
      Esc: (editor) => editor.getInputField().blur(),
      "Ctrl-Q": (editor) => editor.foldCode(editor.getCursor()),
    },
  });
  syncCodeMirrorGutter(editors.raw);

  window.motelPlayground = {
    getTopology: () => getTopologyValue(),
    setTopology: (value) => setTopologyValue(value),
    getShareURL: () => buildShareURL().href,
    restoreShareState: () => restoreShareStateFromURL(),
    createResultSnapshot: () => makeCurrentResultSnapshot(),
    importResultSnapshot: (snapshot) => applyResultSnapshot(normalizeResultSnapshot(snapshot)),
  };
}

async function copyShareURL() {
  const url = buildShareURL();
  if (isShareURLTooLarge(url)) {
    setShareStatus("Share link is too large; save YAML instead.", "bad");
    return;
  }
  window.history.replaceState(null, "", url.href);
  const copied = await writeClipboard(url.href);
  setShareStatus(copied ? "Share link copied" : "Share link ready in address bar", "good");
}

function buildShareURL() {
  return makeShareURL(window.location.href, {
    topology: getTopologyValue(),
    settings: {
      duration: els.duration.value,
      seed: els.seed.value,
      maxNodes: els.maxNodes.value,
    },
    filters: {
      result: els.resultFilter.value,
      errorTracesOnly: state.errorTracesOnly,
      warnLogsOnly: state.warnLogsOnly,
    },
    view: activeResultView(),
  });
}

async function restoreShareStateFromURL() {
  const token = getShareToken(window.location.hash);
  if (!token) return false;
  let payload;
  try {
    payload = decodeSharePayload(token, { allowedViews: resultViewNames });
  } catch {
    setShareStatus("Shared link could not be opened; playground left unchanged.", "bad");
    return false;
  }
  applySharePayload(payload);
  setShareStatus("Shared link opened", "good");
  if (state.ready) {
    await validate({ passive: true });
  }
  return true;
}

function applySharePayload(payload) {
  setTopologyValue(payload.topology);
  clearPreview("Validate the topology to preview traffic.");
  clearRunOutput(emptyCopy.spans);
  clearSignalOutput();
  clearRawOutput();
  clearMap(emptyCopy.map);
  applyNumberInput(els.duration, payload.settings?.duration);
  applyNumberInput(els.seed, payload.settings?.seed);
  applyNumberInput(els.maxNodes, payload.settings?.maxNodes);
  els.resultFilter.value = typeof payload.filters?.result === "string" ? payload.filters.result : "";
  state.resultFilter = els.resultFilter.value.trim().toLowerCase();
  state.errorTracesOnly = Boolean(payload.filters?.errorTracesOnly);
  state.warnLogsOnly = Boolean(payload.filters?.warnLogsOnly);
  syncSpanFilter(0, 0);
  syncLogFilter(0, 0);
  setValidateButton("Validate");
  activateResultView(payload.view);
}

function applyNumberInput(input, value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return;
  const min = finiteInputBound(input.min, -Infinity);
  const max = finiteInputBound(input.max, Infinity);
  input.value = String(Math.min(max, Math.max(min, numericValue)));
}

function finiteInputBound(value, fallback) {
  if (value === "") return fallback;
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

function activateResultView(view) {
  const tab = resultTabs.find((item) => item.dataset.view === view) ?? resultTabs[0];
  activateTab(tab);
}

async function writeClipboard(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.className = "sr-only";
  document.body.append(textarea);
  textarea.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
  }
  textarea.remove();
  return copied;
}

function setShareStatus(message, kind) {
  els.shareStatus.textContent = message;
  els.shareStatus.classList.remove("good", "bad");
  if (kind) {
    els.shareStatus.classList.add(kind);
  }
}

function openShortcutHelp() {
  if (isShortcutHelpOpen()) return;
  lastShortcutFocus = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
    ? document.activeElement
    : els.shortcutHelpButton;
  els.shortcutHelp.hidden = false;
  document.body.classList.add("modal-open");
  requestAnimationFrame(() => els.shortcutHelpPanel.focus({ preventScroll: true }));
}

function closeShortcutHelp() {
  if (!isShortcutHelpOpen()) return;
  els.shortcutHelp.hidden = true;
  document.body.classList.remove("modal-open");
  const target = lastShortcutFocus?.isConnected ? lastShortcutFocus : els.shortcutHelpButton;
  lastShortcutFocus = null;
  target.focus({ preventScroll: true });
}

function isShortcutHelpOpen() {
  return !els.shortcutHelp.hidden;
}

function trapShortcutHelpFocus(event) {
  const focusable = Array.from(els.shortcutHelpPanel.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
  )).filter((item) => !item.disabled && item.offsetParent !== null);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

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
    syncControls();
    await validate({ passive: true });
  } catch (error) {
    els.status.textContent = "Build runtime first";
    els.status.classList.add("error");
    renderRawText(String(error));
  }
}

async function validate({ passive = false } = {}) {
  if (!state.ready) return;
  let valid = false;
  setRuntimeBusy(true, "Validating", { resetValidate: false });
  if (!passive) {
    setValidateButton("Validating");
  }
  try {
    const result = JSON.parse(await window.motelValidate(getTopologyValue()));
    valid = renderValidation(result);
    if (valid) {
      valid = await renderPreview();
    }
    renderRawJson(result);
  } finally {
    setRuntimeBusy(false);
    if (!passive) {
      setValidateButton(valid ? "Validated" : "Invalid", valid ? "validated" : "invalid");
    }
  }
}

async function run() {
  if (!state.ready || state.runBusy) return;
  const runID = state.activeRunID + 1;
  const editorRevision = state.editorRevision;
  const topology = getTopologyValue();
  const settings = currentRunSettings();
  state.activeRunID = runID;
  setRunBusy(true, "Running topology in background");
  setValidateButton("Validate");
  try {
    const result = JSON.parse(await runClient().run({
      topology,
      duration: Number(els.duration.value),
      seed: Number(els.seed.value),
    }));
    if (state.activeRunID !== runID || state.editorRevision !== editorRevision) return;
    renderRun(result, { topology, settings });
    renderRawJson(result);
  } catch (error) {
    if (state.activeRunID !== runID || state.editorRevision !== editorRevision) return;
    renderRunWorkerError(error);
  } finally {
    if (state.activeRunID === runID) {
      setRunBusy(false);
    }
  }
}

async function generateTopology() {
  const currentSeed = Math.max(1, Math.floor(Number(els.seed.value) || 0));
  const seed = nextRandomSeed(currentSeed);
  const topology = randomTopologyYaml(seed, { maxNodes: maxRandomNodes() });
  els.seed.value = String(seed);
  setTopologyValue(topology);
  els.summary.classList.remove("bad");
  els.summary.textContent = "Generated topology";
  clearRunOutput(emptyCopy.spans);
  clearSignalOutput();
  clearRawOutput();
  if (state.ready) await validate({ passive: true });
}

function nextRandomSeed(previousSeed) {
  const maxSeed = 0x7fffffff;
  const values = new Uint32Array(1);
  if (window.crypto?.getRandomValues) {
    window.crypto.getRandomValues(values);
  } else {
    values[0] = Math.floor(Math.random() * maxSeed);
  }
  let seed = values[0] % maxSeed;
  if (seed <= 0) seed = 1;
  if (seed === previousSeed) seed = (seed % maxSeed) + 1;
  return seed;
}

function maxRandomNodes() {
  const min = Number(els.maxNodes.min) || 2;
  const max = Number(els.maxNodes.max) || 12;
  const value = Math.floor(Number(els.maxNodes.value) || max);
  return Math.min(max, Math.max(min, value));
}

async function loadTopologyFile() {
  const [file] = els.file.files ?? [];
  if (!file) return;
  try {
    setTopologyValue(await file.text());
    els.summary.classList.remove("bad", "good");
    els.summary.textContent = `Loaded ${file.name}`;
    clearRunOutput(emptyCopy.spans);
    clearSignalOutput();
    clearRawOutput();
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
  const filename = topologyFilename();
  downloadText(getTopologyValue(), { filename, type: "text/yaml" });
  els.summary.classList.remove("bad");
  els.summary.textContent = `Saved ${filename}`;
}

function topologyFilename() {
  const seed = Math.max(1, Math.floor(Number(els.seed.value) || Date.now()));
  return `motel-topology-${seed}.yaml`;
}

function exportResults() {
  if (!state.lastRun) {
    setShareStatus("Run results are not available.", "bad");
    return;
  }
  const snapshot = makeCurrentResultSnapshot();
  const filename = resultSnapshotFilename(snapshot.settings);
  downloadText(`${JSON.stringify(snapshot, null, 2)}\n`, {
    filename,
    type: resultSnapshotMimeType,
  });
  setShareStatus(`Exported ${filename}`, "good");
}

function printReport() {
  if (!state.lastRun) {
    setShareStatus("Run results are not available.", "bad");
    return;
  }
  renderPrintableReport(makeCurrentResultSnapshot());
  document.body.classList.add("report-ready");
  setShareStatus("Report ready for print", "good");
  window.print();
}

async function loadResultsFile() {
  const [file] = els.resultFile.files ?? [];
  if (!file) return;
  try {
    const snapshot = parseResultSnapshot(await file.text());
    await applyResultSnapshot(snapshot);
    setShareStatus(`Imported ${file.name}`, "good");
  } catch (error) {
    setShareStatus(`Could not import results: ${error.message}`, "bad");
  } finally {
    els.resultFile.value = "";
  }
}

function makeCurrentResultSnapshot() {
  return createResultSnapshot({
    topology: state.lastRunSource?.topology ?? getTopologyValue(),
    settings: state.lastRunSource?.settings ?? currentRunSettings(),
    result: state.lastRun,
  });
}

async function applyResultSnapshot(snapshot) {
  setTopologyValue(snapshot.topology);
  applyNumberInput(els.duration, snapshot.settings.duration);
  applyNumberInput(els.seed, snapshot.settings.seed);
  applyNumberInput(els.maxNodes, snapshot.settings.maxNodes);
  els.resultFilter.value = "";
  state.resultFilter = "";
  state.errorTracesOnly = false;
  state.warnLogsOnly = false;
  setValidateButton("Validate");
  renderRun(snapshot.result, {
    topology: snapshot.topology,
    settings: snapshot.settings,
  });
  renderRawJson(snapshot.result);
  if (state.ready) {
    await renderPreview();
  }
  const stats = snapshot.result.stats;
  els.summary.classList.add("good");
  els.summary.classList.remove("bad");
  els.summary.textContent = `Imported run: ${stats.traces} traces, ${stats.spans} spans, ${stats.errors} errors`;
}

function currentRunSettings() {
  return {
    duration: els.duration.value,
    seed: els.seed.value,
    maxNodes: els.maxNodes.value,
  };
}

function downloadText(value, { filename, type }) {
  downloadBlob(new Blob([value], { type }), filename);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function renderPrintableReport(snapshot) {
  const result = snapshot.result;
  const stats = result.stats;
  const topology = result.topology;
  const generatedAt = snapshot.exported_at
    ? new Date(snapshot.exported_at)
    : new Date();
  els.report.innerHTML = `<article class="report-document">
    <header class="report-header">
      <div>
        <p class="report-kicker">motel playground</p>
        <h1>Topology report</h1>
      </div>
      <dl class="report-meta">
        <div><dt>Generated</dt><dd>${escapeHtml(reportDate(generatedAt))}</dd></div>
        <div><dt>Duration</dt><dd>${escapeHtml(snapshot.settings.duration)}s</dd></div>
        <div><dt>Seed</dt><dd>${escapeHtml(snapshot.settings.seed)}</dd></div>
      </dl>
    </header>
    ${reportSection("Run summary", renderReportFacts([
      ["traces", stats.traces],
      ["spans", stats.spans],
      ["span errors", `${stats.errors} (${formatPercent(stats.error_rate)})`],
      ["elapsed", `${formatNumber(stats.elapsed_ms)}ms`],
      ["services", topology.services.length],
      ["operations", topology.operations],
    ]))}
    ${reportSection("Topology map", renderReportMap(topology), "report-map-section")}
    ${reportSection("Run parameters", renderReportFacts([
      ["duration", `${snapshot.settings.duration}s`],
      ["seed", snapshot.settings.seed],
      ["max nodes", snapshot.settings.maxNodes],
      ["captured spans", result.limits.captured_spans],
      ["captured metrics", result.limits.captured_metrics],
      ["captured logs", result.limits.captured_logs],
    ]))}
    ${reportSection("Traffic", renderReportTraffic(topology))}
    ${reportSection("Warnings and errors", renderReportWarnings(result))}
    ${reportSection("Metrics", renderReportMetrics(result.metrics ?? []), "report-wide-section")}
    ${reportSection("Logs", renderReportLogs(result.logs ?? []), "report-wide-section")}
    ${reportSection("Trace summaries", renderReportTraces(result.spans ?? []), "report-wide-section")}
    ${reportSection("Topology configuration", `<pre class="report-code">${escapeHtml(snapshot.topology)}</pre>`, "report-wide-section")}
  </article>`;
}

function reportSection(title, body, className = "") {
  return `<section class="report-section ${className}">
    <h2>${escapeHtml(title)}</h2>
    ${body}
  </section>`;
}

function renderReportFacts(items) {
  return `<dl class="report-facts">
    ${items.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}
  </dl>`;
}

function renderReportMap(topology) {
  const graph = topology.graph;
  if (!graph?.nodes?.length) {
    return `<p class="report-empty">No topology map available.</p>`;
  }
  const cols = Math.max(graph.gridCols || 1, ...graph.nodes.map((node) => node.col + 1));
  const rows = Math.max(graph.gridRows || 1, ...graph.nodes.map((node) => node.row + 1));
  const width = (reportMapPadding * 2) + reportMapNodeWidth + ((cols - 1) * reportMapCellWidth);
  const height = (reportMapPadding * 2) + reportMapNodeHeight + ((rows - 1) * reportMapCellHeight);
  const positions = new Map(graph.nodes.map((node) => [node.id, {
    x: reportMapPadding + (node.col * reportMapCellWidth),
    y: reportMapPadding + (node.row * reportMapCellHeight),
  }]));
  const edges = (graph.edges ?? []).flatMap((edge) => {
    const source = positions.get(edge.source);
    const target = positions.get(edge.target);
    if (!source || !target) return [];
    const x1 = source.x + (reportMapNodeWidth / 2);
    const y1 = source.y + (reportMapNodeHeight / 2);
    const x2 = target.x + (reportMapNodeWidth / 2);
    const y2 = target.y + (reportMapNodeHeight / 2);
    const strokeWidth = reportMapEdgeBaseWidth + Math.min(reportMapEdgeMaxBoost, Number(edge.weight) || 0);
    return [`<line x1="${formatSVGNumber(x1)}" y1="${formatSVGNumber(y1)}" x2="${formatSVGNumber(x2)}" y2="${formatSVGNumber(y2)}" stroke-width="${formatSVGNumber(strokeWidth)}" marker-end="url(#report-arrow)" class="${edge.async ? "report-edge report-edge-async" : "report-edge"}"></line>`];
  }).join("");
  const nodes = graph.nodes.map((node) => {
    const point = positions.get(node.id);
    const label = shortLabel(node.id, reportMapNodeLabelLength);
    const operations = `${node.operations?.length ?? 0} operations`;
    return `<g class="${node.isRoot ? "report-node report-node-root" : "report-node"}" transform="translate(${formatSVGNumber(point.x)} ${formatSVGNumber(point.y)})">
      <rect width="${reportMapNodeWidth}" height="${reportMapNodeHeight}" rx="6"></rect>
      <text x="12" y="20">${escapeHtml(label)}</text>
      <text x="12" y="36" class="report-node-detail">${escapeHtml(operations)}</text>
      <title>${escapeHtml(node.id)}</title>
    </g>`;
  }).join("");
  return `<svg class="report-map" viewBox="0 0 ${formatSVGNumber(width)} ${formatSVGNumber(height)}" role="img" aria-label="Topology visualization">
    <defs>
      <marker id="report-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z"></path>
      </marker>
    </defs>
    ${edges}
    ${nodes}
  </svg>`;
}

function renderReportTraffic(topology) {
  const roots = topology.roots?.length
    ? `<ul class="report-list">${topology.roots.map((root) => `<li>${escapeHtml(root)}</li>`).join("")}</ul>`
    : `<p class="report-empty">No root operations identified.</p>`;
  const edgeRows = (topology.graph?.edges ?? []).map((edge) => [
    `${edge.source} -> ${edge.target}`,
    `${edge.calls?.length ?? 0} call paths`,
    edge.async ? "async" : "sync",
  ]);
  return `<div class="report-grid">
    <div><h3>Root operations</h3>${roots}</div>
    <div><h3>Service calls</h3>${renderReportTable(["edge", "paths", "style"], edgeRows, "No service calls captured.")}</div>
  </div>`;
}

function renderReportWarnings(result) {
  const errorSpanRows = (result.spans ?? [])
    .filter((span) => span.is_error)
    .map((span) => ["span", `${span.service}.${span.operation}`, `${formatNumber(span.duration_ms)}ms`, shortHash(span.trace_id)]);
  const notableLogRows = (result.logs ?? [])
    .filter(isNotableLog)
    .map((log) => [log.severity || "WARN", signalContext(log), log.body || "(empty log)", signalTime(log.timestamp_ms)]);
  const rows = [...errorSpanRows, ...notableLogRows];
  return renderReportTable(["kind", "source", "detail", "time or trace"], rows, "No span errors or warning logs captured.");
}

function renderReportMetrics(metrics) {
  const rows = metrics.map((metric) => [
    metric.name,
    signalContext(metric),
    metric.type || "metric",
    metricValue(metric),
  ]);
  return renderReportTable(["metric", "source", "type", "value"], rows, "No metrics captured.");
}

function renderReportLogs(logs) {
  const rows = logs.map((log) => [
    log.severity || "INFO",
    signalContext(log),
    log.body || "(empty log)",
    signalTime(log.timestamp_ms),
  ]);
  return renderReportTable(["severity", "source", "body", "time"], rows, "No logs captured.");
}

function renderReportTraces(spans) {
  if (!spans.length) {
    return renderReportTable(["trace", "root", "spans", "errors", "duration"], [], "No spans captured.");
  }
  const traces = groupSpansByTrace(spans.slice().sort(compareSpans));
  const rows = traces.map((trace) => [
    shortHash(trace.id),
    `${trace.root.service}.${trace.root.operation}`,
    trace.spans.length,
    trace.errors,
    `${formatNumber(trace.duration)}ms`,
  ]);
  return renderReportTable(["trace", "root", "spans", "errors", "duration"], rows, "No spans captured.");
}

function renderReportTable(headers, rows, emptyMessage) {
  if (!rows.length) {
    return `<p class="report-empty">${escapeHtml(emptyMessage)}</p>`;
  }
  const visibleRows = rows.slice(0, reportTableRowLimit);
  const table = `<table class="report-table">
    <thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead>
    <tbody>
      ${visibleRows.map((row) => `<tr>${row.map((value) => `<td>${escapeHtml(value)}</td>`).join("")}</tr>`).join("")}
    </tbody>
  </table>`;
  if (rows.length <= reportTableRowLimit) return table;
  return `${table}<p class="report-note">Showing ${reportTableRowLimit} of ${rows.length} captured rows.</p>`;
}

function reportDate(value) {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) return "unknown";
  return value.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function formatPercent(value) {
  return `${Math.round(Number(value || 0) * 1000) / 10}%`;
}

function shortHash(value) {
  const text = String(value || "synthetic");
  return text.length > reportHashLength ? text.slice(0, reportHashLength) : text;
}

function shortLabel(value, maxLength) {
  const text = String(value || "");
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function formatSVGNumber(value) {
  return Number(value).toFixed(2).replace(/\.?0+$/, "");
}

async function renderPreview() {
  try {
    const svg = await window.motelPreview(getTopologyValue(), previewDurationSeconds());
    els.preview.innerHTML = svg;
    return true;
  } catch {
    state.currentTopology = null;
    clearPreview(emptyCopy.invalidPreview);
    return false;
  }
}

function previewDurationSeconds() {
  const value = Number(els.duration.value);
  const min = Number(els.duration.min) || 0.1;
  const max = Number(els.duration.max) || 10;
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.min(max, Math.max(min, value));
}

function renderValidation(result) {
  if (!result.ok) {
    const diagnostics = result.diagnostics ?? [];
    const message = diagnostics[0]?.message ?? "Topology is invalid";
    state.currentTopology = null;
    clearPreview(emptyCopy.invalidPreview);
    clearRunOutput(emptyCopy.invalidSpans);
    clearSignalOutput(emptyCopy.invalidMetrics, emptyCopy.invalidLogs);
    clearMap(emptyCopy.invalidMap);
    els.summary.textContent = `Invalid topology: ${message}`;
    els.summary.classList.remove("good");
    els.summary.classList.add("bad");
    return false;
  }
  const topology = result.topology;
  state.currentTopology = topology;
  els.summary.classList.add("good");
  els.summary.classList.remove("bad");
  els.summary.textContent = `Valid topology: ${topology.services.length} services, ${topology.operations} operations, ${topology.edges} calls`;
  renderMap(topology, []);
  return true;
}

function renderRun(result, source = { topology: getTopologyValue(), settings: currentRunSettings() }) {
  if (!result.ok) {
    state.lastRun = null;
    state.lastRunSource = null;
    state.currentTopology = null;
    clearPreview("Fix the run error to preview traffic.");
    clearRunOutput(emptyCopy.runFailedSpans);
    clearSignalOutput(emptyCopy.runFailedMetrics, emptyCopy.runFailedLogs);
    clearMap("Fix the run error to render the service map.");
    els.summary.textContent = result.errors?.[0]?.message ?? "Run failed";
    els.summary.classList.remove("good");
    els.summary.classList.add("bad");
    syncControls();
    return;
  }
  const stats = result.stats;
  state.lastRun = result;
  state.lastRunSource = source;
  state.currentTopology = result.topology;
  els.metrics.traces.textContent = stats.traces;
  els.metrics.spans.textContent = stats.spans;
  els.metrics.errors.textContent = `${Math.round(stats.error_rate * 1000) / 10}%`;
  const capturedErrors = (result.spans ?? []).filter((span) => span.is_error).length;
  if (stats.errors > capturedErrors) {
    els.summary.textContent = `${stats.traces} traces, ${stats.spans} spans, ${stats.errors} errors (${capturedErrors} captured)`;
  }
  renderSpans(result.spans ?? []);
  renderMetrics(result.metrics ?? []);
  renderLogs(result.logs ?? []);
  renderMap(result.topology, result.spans ?? []);
  syncControls();
}

function renderRunWorkerError(error) {
  state.lastRun = null;
  state.lastRunSource = null;
  state.currentTopology = null;
  clearPreview("Fix the run error to preview traffic.");
  clearRunOutput(emptyCopy.runFailedSpans);
  clearSignalOutput(emptyCopy.runFailedMetrics, emptyCopy.runFailedLogs);
  clearMap("Fix the run error to render the service map.");
  els.summary.textContent = error?.message || "Run failed";
  els.summary.classList.remove("good");
  els.summary.classList.add("bad");
  renderRawText(String(error?.stack || error?.message || error));
  syncControls();
}

function renderMetrics(metrics) {
  const filter = resultFilter();
  const ordered = metrics.slice().sort(compareSignals);
  const visible = filter ? ordered.filter((metric) => signalMatchesFilter(metric, filter)) : ordered;
  if (ordered.length === 0) {
    els.signalMetrics.innerHTML = `<p class="empty">No metrics captured yet.</p>`;
    return;
  }
  if (visible.length === 0) {
    els.signalMetrics.innerHTML = `<p class="empty">No metrics match this filter.</p>`;
    return;
  }
  els.signalMetrics.innerHTML = visible.map((metric, index) => {
    const panelID = `metric-panel-${index}`;
    return `<article class="signal-item">
      <button class="signal-row" type="button" aria-expanded="false" aria-controls="${panelID}">
        <span class="signal-meta">
          <strong>${escapeHtml(metric.name)}</strong>
          <span>${escapeHtml(signalContext(metric))}</span>
        </span>
        <span class="signal-kind">${escapeHtml(metric.type || "metric")}</span>
        <span class="signal-value">${escapeHtml(metricValue(metric))}</span>
      </button>
      <div class="signal-drawer" id="${panelID}" hidden>
        ${renderMetricDetails(metric)}
      </div>
    </article>`;
  }).join("");
  bindSignalDrawers(els.signalMetrics);
}

function renderMetricDetails(metric) {
  const timestamp = Number.isFinite(metric.timestamp_ms) && metric.timestamp_ms > 0
    ? new Date(metric.timestamp_ms).toISOString()
    : "collection time";
  const attributes = Object.entries(metric.attributes ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return `<div class="span-facts">
    ${spanFact("name", metric.name)}
    ${spanFact("type", metric.type || "metric")}
    ${spanFact("value", metricValue(metric))}
    ${spanFact("service", metric.service || "unknown")}
    ${spanFact("operation", metric.operation || "service")}
    ${spanFact("timestamp", timestamp)}
  </div>
  ${attributes.length ? `<dl class="span-attributes">
    ${attributes.map(([key, value]) => `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}
  </dl>` : `<p class="empty span-empty">No metric attributes.</p>`}`;
}

function renderLogs(logs) {
  const filter = resultFilter();
  const ordered = logs.slice().sort(compareSignals);
  const notableCount = ordered.filter((log) => isNotableLog(log)).length;
  const severityFiltered = state.warnLogsOnly ? ordered.filter((log) => isNotableLog(log)) : ordered;
  const visible = filter ? severityFiltered.filter((log) => signalMatchesFilter(log, filter)) : severityFiltered;
  syncLogFilter(notableCount, ordered.length, visible.length);
  if (ordered.length === 0) {
    els.signalLogs.innerHTML = `<p class="empty">No logs captured yet.</p>`;
    return;
  }
  if (visible.length === 0) {
    els.signalLogs.innerHTML = `<p class="empty">No warn or error logs in this run.</p>`;
    return;
  }
  els.signalLogs.innerHTML = visible.map((log, index) => {
    const panelID = `log-panel-${index}`;
    const severity = (log.severity || "info").toLowerCase();
    return `<article class="signal-item log-${escapeHtml(severity)}">
      <button class="signal-row" type="button" aria-expanded="false" aria-controls="${panelID}">
        <span class="signal-meta">
          <strong>${escapeHtml(log.body || "(empty log)")}</strong>
          <span>${escapeHtml(signalContext(log))}</span>
        </span>
        <span class="signal-kind">${escapeHtml(log.severity || "INFO")}</span>
        <time class="signal-value">${escapeHtml(signalTime(log.timestamp_ms))}</time>
      </button>
      <div class="signal-drawer" id="${panelID}" hidden>
        ${renderLogDetails(log)}
      </div>
    </article>`;
  }).join("");
  bindSignalDrawers(els.signalLogs);
}

function renderLogDetails(log) {
  const timestamp = Number.isFinite(log.timestamp_ms) && log.timestamp_ms > 0
    ? new Date(log.timestamp_ms).toISOString()
    : "unknown";
  const attributes = Object.entries(log.attributes ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return `<div class="span-facts">
    ${spanFact("severity", log.severity || "INFO")}
    ${spanFact("service", log.service || "unknown")}
    ${spanFact("operation", log.operation || "service")}
    ${spanFact("timestamp", timestamp)}
    ${spanFact("trace", log.trace_id || "none")}
    ${spanFact("span", log.span_id || "none")}
  </div>
  ${attributes.length ? `<dl class="span-attributes">
    ${attributes.map(([key, value]) => `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}
  </dl>` : `<p class="empty span-empty">No log attributes.</p>`}`;
}

function renderSpans(spans) {
  const filter = resultFilter();
  const orderedSpans = spans
    .slice()
    .sort(compareSpans);
  if (orderedSpans.length === 0) {
    syncSpanFilter(0, 0);
    els.traces.innerHTML = `<p class="empty">No spans captured yet.</p>`;
    return;
  }
  const traceGroups = groupSpansByTrace(orderedSpans);
  const errorTraceCount = traceGroups.filter((trace) => trace.errors > 0).length;
  const candidateGroups = state.errorTracesOnly
    ? traceGroups.filter((trace) => trace.errors > 0)
    : traceGroups;
  const visibleGroups = filter
    ? candidateGroups.flatMap((trace) => {
      const matchedSpans = trace.spans.filter((span) => spanMatchesFilter(span, filter));
      return matchedSpans.length ? [makeTraceGroup(trace.id, matchedSpans, trace.root)] : [];
    })
    : candidateGroups;
  syncSpanFilter(errorTraceCount, traceGroups.length, visibleGroups.length);
  if (visibleGroups.length === 0) {
    els.traces.innerHTML = `<p class="empty">${filter ? "No spans match this filter." : "No error traces in this run."}</p>`;
    return;
  }
  const maxDuration = Math.max(...orderedSpans.map((span) => span.duration_ms), 1);
  els.traces.innerHTML = visibleGroups.map((trace, traceIndex) => {
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

function renderRawJson(value) {
  setRawOutput(JSON.stringify(value, null, 2), { json: true });
}

function renderRawText(value) {
  setRawOutput(value, { json: false });
}

function clearRawOutput() {
  setRawOutput("", { json: false });
}

function setRawOutput(value, { json }) {
  state.rawOutput = value;
  state.rawOutputJSON = json;
  state.rawOutputDirty = true;
  if (activeResultView() === "raw") {
    flushRawOutput();
  }
}

function flushRawOutput() {
  if (!state.rawOutputDirty) return;
  renderRawEditor(state.rawOutput, { json: state.rawOutputJSON });
  state.rawOutputDirty = false;
}

function activeResultView() {
  return document.querySelector(".tab.active")?.dataset.view;
}

function renderRawEditor(value, { json }) {
  els.raw.classList.toggle("raw-json", json);
  els.raw.classList.toggle("raw-text", !json);
  if (!editors.raw) {
    els.raw.innerHTML = `<pre>${escapeHtml(value)}</pre>`;
    return;
  }
  editors.raw.setOption("mode", json ? { name: "javascript", json: true } : null);
  editors.raw.setOption("foldGutter", json);
  editors.raw.setValue(value);
  editors.raw.refresh();
  syncCodeMirrorGutter(editors.raw);
}

function syncCodeMirrorGutter(editor) {
  const sync = () => {
    const wrapper = editor.getWrapperElement();
    const gutter = wrapper.querySelector(".CodeMirror-gutters");
    if (!gutter) return;
    const width = gutter.getBoundingClientRect().width;
    if (width > 0) {
      wrapper.style.setProperty("--cm-gutter-width", `${width}px`);
    }
  };
  sync();
  requestAnimationFrame(sync);
}

function renderMap(topology, spans) {
  if (!topology) return;
  if (!document.querySelector("#view-map").classList.contains("active")) return;
  if (topology.graph && window.renderP5Map) {
    if (!window.p5) {
      els.map.classList.remove("p5-map");
      els.map.innerHTML = `<p class="empty">Loading service map.</p>`;
      loadP5().then(() => {
        if (activeResultView() === "map" && state.currentTopology === topology) {
          renderMap(topology, spans);
        }
      }).catch(() => {
        if (activeResultView() === "map" && state.currentTopology === topology) {
          window.renderP5Map(els.map, topology.graph, spans);
        }
      });
      return;
    }
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

function loadP5() {
  if (window.p5) return Promise.resolve();
  if (state.p5Loading) return state.p5Loading;
  state.p5Loading = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = p5ScriptPath;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      state.p5Loading = null;
      reject(new Error("Could not load p5"));
    };
    document.head.append(script);
  });
  return state.p5Loading;
}

function clearRunOutput(message) {
  state.lastRun = null;
  state.lastRunSource = null;
  state.errorTracesOnly = false;
  state.warnLogsOnly = false;
  syncSpanFilter(0, 0);
  syncLogFilter(0, 0);
  els.metrics.traces.textContent = "0";
  els.metrics.spans.textContent = "0";
  els.metrics.errors.textContent = "0%";
  els.traces.innerHTML = `<p class="empty">${escapeHtml(message)}</p>`;
  syncControls();
}

function clearSignalOutput(metricMessage = emptyCopy.metrics, logMessage = emptyCopy.logs) {
  state.warnLogsOnly = false;
  syncLogFilter(0, 0);
  els.signalMetrics.innerHTML = `<p class="empty">${escapeHtml(metricMessage)}</p>`;
  els.signalLogs.innerHTML = `<p class="empty">${escapeHtml(logMessage)}</p>`;
}

function clearPreview(message) {
  els.preview.innerHTML = `<p class="empty">${escapeHtml(message)}</p>`;
}

function clearMap(message) {
  if (window.clearP5Map) {
    window.clearP5Map(els.map, message);
    return;
  }
  els.map.classList.remove("p5-map");
  els.map.innerHTML = `<p class="empty">${escapeHtml(message)}</p>`;
}

function setValidateButton(label, stateClass) {
  els.validate.textContent = label;
  els.validate.classList.remove("validated", "invalid");
  if (stateClass) els.validate.classList.add(stateClass);
}

function setTopologyValue(value) {
  if (editors.topology) {
    editors.topology.setValue(value);
    editors.topology.save();
    return;
  }
  els.editor.value = value;
  markEditorChanged();
}

function getTopologyValue() {
  if (editors.topology) {
    editors.topology.save();
  }
  return editors.topology?.getValue() ?? els.editor.value;
}

function markEditorChanged() {
  state.editorRevision += 1;
  state.currentTopology = null;
  clearPreview("Validate the topology to preview traffic.");
  setValidateButton("Validate");
}

function syncSpanFilter(errorTraceCount, totalTraceCount, visibleTraceCount = totalTraceCount) {
  els.errorFilter.disabled = totalTraceCount === 0;
  els.errorFilter.setAttribute("aria-pressed", String(state.errorTracesOnly));
  els.errorFilter.classList.toggle("active", state.errorTracesOnly);
  els.errorFilter.textContent = state.errorTracesOnly ? "Showing errors" : "Errors only";
  const filter = resultFilter();
  els.spanFilterCount.textContent = filter && totalTraceCount
    ? `${visibleTraceCount} of ${totalTraceCount} traces match`
    : totalTraceCount
    ? `${errorTraceCount} of ${totalTraceCount} traces with errors`
    : "0 traces";
}

function syncLogFilter(notableCount, totalCount, visibleCount = totalCount) {
  els.logSeverityFilter.disabled = totalCount === 0;
  els.logSeverityFilter.setAttribute("aria-pressed", String(state.warnLogsOnly));
  els.logSeverityFilter.classList.toggle("active", state.warnLogsOnly);
  els.logSeverityFilter.textContent = state.warnLogsOnly ? "Showing warn/error" : "Warn and error";
  const filter = resultFilter();
  els.logFilterCount.textContent = filter && totalCount
    ? `${visibleCount} of ${totalCount} logs match`
    : totalCount
    ? `${notableCount} of ${totalCount} logs warn/error`
    : "0 logs";
}

function renderFilteredResults() {
  if (!state.lastRun) {
    syncSpanFilter(0, 0);
    syncLogFilter(0, 0);
    return;
  }
  renderSpans(state.lastRun.spans ?? []);
  renderMetrics(state.lastRun.metrics ?? []);
  renderLogs(state.lastRun.logs ?? []);
}

function resultFilter() {
  return state.resultFilter;
}

function spanMatchesFilter(span, filter) {
  return searchableText([
    span.trace_id,
    span.span_id,
    span.service,
    span.operation,
    span.parent_service,
    span.parent_operation,
    span.kind,
    span.is_error ? "error" : "ok",
    ...(span.scenarios ?? []),
    span.attributes,
  ]).includes(filter);
}

function signalMatchesFilter(signal, filter) {
  return searchableText([
    signal.name,
    signal.type,
    signal.unit,
    signal.service,
    signal.operation,
    signal.severity,
    signal.body,
    signal.trace_id,
    signal.span_id,
    signal.attributes,
  ]).includes(filter);
}

function searchableText(values) {
  return values.flatMap(searchableParts).join(" ").toLowerCase();
}

function searchableParts(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap(searchableParts);
  if (typeof value === "object") {
    return Object.entries(value).flatMap(([key, entry]) => [key, ...searchableParts(entry)]);
  }
  return [String(value)];
}

function bindSignalDrawers(root) {
  for (const row of root.querySelectorAll(".signal-row")) {
    row.addEventListener("click", () => {
      const drawer = document.getElementById(row.getAttribute("aria-controls"));
      const expanded = row.getAttribute("aria-expanded") === "true";
      row.setAttribute("aria-expanded", String(!expanded));
      drawer.hidden = expanded;
    });
  }
}

function metricValue(metric) {
  if (metric.count) {
    const suffix = metric.unit ? ` ${metric.unit}` : "";
    return `${metric.count} samples, sum ${formatNumber(metric.sum)}${suffix}`;
  }
  const suffix = metric.unit ? ` ${metric.unit}` : "";
  return `${formatNumber(metric.value)}${suffix}`;
}

function signalContext(signal) {
  const service = signal.service || "unknown";
  return signal.operation ? `${service}.${signal.operation}` : service;
}

function signalTime(timestampMs) {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return "";
  return new Date(timestampMs).toISOString().slice(11, 23);
}

function compareSignals(a, b) {
  const timestampDelta = (a.timestamp_ms ?? 0) - (b.timestamp_ms ?? 0);
  if (timestampDelta !== 0) return timestampDelta;
  return `${a.service || ""}.${a.name || a.body || ""}`.localeCompare(`${b.service || ""}.${b.name || b.body || ""}`);
}

function isNotableLog(log) {
  const severity = String(log.severity || "").toLowerCase();
  return severity.includes("warn") || severity.includes("error") || severity.includes("fatal");
}

function formatNumber(value) {
  if (!Number.isFinite(Number(value))) return "0";
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(Number(value));
}

function setRuntimeBusy(isBusy, label, { resetValidate = true } = {}) {
  state.runtimeBusy = isBusy;
  if (isBusy && resetValidate) {
    setValidateButton("Validate");
  }
  syncControls(label);
}

function setRunBusy(isBusy, label) {
  state.runBusy = isBusy;
  syncControls(label);
}

function syncControls(label) {
  els.status.textContent = label || statusLabel();
  els.load.disabled = state.runtimeBusy;
  els.save.disabled = state.runtimeBusy;
  els.generate.disabled = state.runtimeBusy;
  els.importResults.disabled = state.runtimeBusy || !state.ready;
  els.exportResults.disabled = state.runtimeBusy || !state.lastRun;
  els.printReport.disabled = state.runtimeBusy || !state.lastRun;
  els.validate.disabled = state.runtimeBusy || !state.ready;
  els.run.disabled = state.runtimeBusy || state.runBusy || !state.ready;
}

function statusLabel() {
  if (!state.ready) return "Runtime starting";
  if (state.runtimeBusy) return els.status.textContent || "Working";
  if (state.runBusy) return "Running topology in background";
  return "Runtime ready";
}

function runClient() {
  if (!window.Worker) {
    return {
      run: ({ topology, duration, seed }) => window.motelRun(topology, duration, seed),
    };
  }
  if (!state.runner) {
    state.runner = new RunWorkerClient(new URL("./run-worker.js", import.meta.url));
  }
  return state.runner;
}

class RunWorkerClient {
  constructor(url) {
    this.url = url;
    this.nextID = 1;
    this.pending = new Map();
    this.worker = null;
  }

  run(payload) {
    const id = this.nextID++;
    const worker = this.ensureWorker();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ ...payload, id, type: "run" });
    });
  }

  ensureWorker() {
    if (this.worker) return this.worker;
    this.worker = new Worker(this.url, { name: "motel-run-worker" });
    this.worker.addEventListener("message", (event) => this.handleMessage(event.data));
    this.worker.addEventListener("error", (event) => {
      this.rejectAll(new Error(event.message || "Run worker failed"));
      this.terminate();
    });
    this.worker.addEventListener("messageerror", () => {
      this.rejectAll(new Error("Run worker returned an unreadable message"));
      this.terminate();
    });
    return this.worker;
  }

  handleMessage(message) {
    const pending = this.pending.get(message?.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.ok) {
      pending.resolve(message.json);
      return;
    }
    pending.reject(new Error(message.error?.message || "Run worker failed"));
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  terminate() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
