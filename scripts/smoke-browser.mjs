import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const webRoot = fileURLToPath(new URL("../web/", import.meta.url));
const pagesBasePath = "/motel-playground/";
const a4PaperHeightInches = 11.69;
const a4PaperWidthInches = 8.27;
const letterPaperHeightInches = 11;
const letterPaperWidthInches = 8.5;
const minReportPDFBase64Length = 6000;
const oversizedTopologyPaddingLength = 9000;
const invalidTopology = "version: 1\nservices: [\n";
const oversizedTopology = `version: 1\n# ${"x".repeat(oversizedTopologyPaddingLength)}\nservices: {}\n`;
const erroredTopology = `version: 1
services:
  gateway:
    operations:
      GET /error:
        duration: 4ms +/- 1ms
        error_rate: 100%
        calls:
          - worker.job
  worker:
    operations:
      job:
        duration: 2ms +/- 1ms
traffic:
  rate: 6/s
`;

class CDPClient {
  static connect(url) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const client = new CDPClient(socket);
      socket.addEventListener("open", () => resolve(client), { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
  }

  constructor(socket) {
    this.socket = socket;
    this.nextID = 1;
    this.pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`${message.error.message}: ${message.error.data || ""}`));
        return;
      }
      pending.resolve(message.result || {});
    });
  }

  send(method, params = {}) {
    const id = this.nextID++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  close() {
    this.socket.close();
  }
}

const chromePath = findChrome();
if (!chromePath) {
  throw new Error("Chrome executable not found. Set CHROME_BIN to run browser smoke tests.");
}

const server = await startStaticServer();
const debugPort = await freePort();
const userDataDir = mkdtempSync(path.join(tmpdir(), "motel-browser-smoke-"));
const appURL = `http://127.0.0.1:${server.port}/`;
const pagesAppURL = new URL("motel-playground/", appURL).href;

const chrome = spawn(chromePath, [
  "--headless=new",
  "--disable-gpu",
  "--no-sandbox",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-sync",
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${userDataDir}`,
  appURL,
], { stdio: ["ignore", "ignore", "ignore"] });
const chromeClosed = new Promise((resolve) => {
  chrome.once("exit", resolve);
});

let client;
try {
  const wsURL = await waitForPageWebSocket(debugPort, appURL);
  client = await CDPClient.connect(wsURL);
  await client.send("Runtime.enable");
  await client.send("Page.enable");
  await client.send("Page.navigate", { url: appURL });

  let runtimeState;
  try {
    await waitFor(async () => {
      runtimeState = await evaluate(client, `(() => ({
        ready: document.querySelector("#runtime-status")?.textContent === "Runtime ready"
          && Boolean(document.querySelector("#preview svg")),
        status: document.querySelector("#runtime-status")?.textContent,
        summary: document.querySelector("#summary-line")?.textContent,
        raw: document.querySelector("#raw-output")?.textContent.slice(0, 240),
        preview: Boolean(document.querySelector("#preview svg")),
        rateVariation: document.querySelector("#preview svg")?.dataset.rateVariation,
        previewText: document.querySelector("#preview")?.textContent,
      }))()`);
      return runtimeState.ready;
    }, "runtime ready and preview rendered");
  } catch (error) {
    throw new Error(`${error.message}: ${JSON.stringify(runtimeState)}`);
  }
  if (
    runtimeState.rateVariation !== "false"
    || !runtimeState.previewText.includes("expected traces")
    || !runtimeState.previewText.includes("elapsed run time (1s)")
  ) {
    throw new Error(`static-rate preview did not expose forecast details: ${JSON.stringify(runtimeState)}`);
  }
  const sampleTopology = await evaluate(client, `window.motelPlayground.getTopology()`);
  const initialTabState = await evaluate(client, `(${resultTabA11yState})()`);
  if (!initialTabState.ok) {
    throw new Error(`result tabs do not expose ARIA tab semantics: ${JSON.stringify(initialTabState)}`);
  }
  await evaluate(client, `document.querySelector("#tab-preview").focus()`);
  await dispatchShortcut(client, { key: "ArrowRight", selector: "#tab-preview" });
  const arrowTabState = await waitFor(async () => {
    const state = await evaluate(client, `(${resultTabFocusState})()`);
    return state.activeView === "traces" && state.focusedTab === "tab-traces" ? state : false;
  }, "arrow key tab navigation");
  if (arrowTabState.selectedTab !== "tab-traces") {
    throw new Error(`arrow key tab navigation did not update selected state: ${JSON.stringify(arrowTabState)}`);
  }
  await evaluate(client, `document.querySelector("#tab-preview").click()`);

  if (await evaluate(client, `document.documentElement.dataset.theme !== "light"`)) {
    await evaluate(client, `document.querySelector("#theme-toggle").click()`);
    await waitFor(async () => {
      const state = await evaluate(client, `(${previewThemeState})()`);
      return state.theme === "light" && state.hasSVG ? state : false;
    }, "preview light theme ready");
  }
  const lightPreviewTheme = await evaluate(client, `(${previewThemeState})()`);
  if (!lightPreviewTheme.hasSVG || lightPreviewTheme.hardcodedLight) {
    throw new Error(`preview SVG still uses hardcoded light colours: ${JSON.stringify(lightPreviewTheme)}`);
  }
  await evaluate(client, `(() => {
    const originalPreview = window.motelPreview;
    window.__previewRenderCalls = 0;
    window.motelPreview = async (...args) => {
      window.__previewRenderCalls += 1;
      return originalPreview(...args);
    };
    document.querySelector("#theme-toggle").click();
  })()`);
  const darkPreviewTheme = await waitFor(async () => {
    const state = await evaluate(client, `(${previewThemeState})()`);
    return state.theme === "dark"
      && state.calls > 0
      && state.backgroundFill !== lightPreviewTheme.backgroundFill
      && state.textFill !== lightPreviewTheme.textFill
      ? state
      : false;
  }, "preview dark theme repaint");
  if (darkPreviewTheme.hardcodedLight) {
    throw new Error(`dark preview SVG still includes hardcoded light colours: ${JSON.stringify(darkPreviewTheme)}`);
  }

  await evaluate(client, `(() => {
    window.__unhandledRejections = [];
    window.addEventListener("unhandledrejection", (event) => {
      window.__unhandledRejections.push(String(event.reason?.message || event.reason));
    });
  })()`);
  await setEditorValue(client, invalidTopology);
  await evaluate(client, `(() => {
    const input = document.querySelector("#duration");
    input.value = "2";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await delay(200);
  const invalidPreviewEdit = await evaluate(client, `(${invalidPreviewEditState})()`);
  if (!invalidPreviewEdit.cleared || invalidPreviewEdit.unhandled.length) {
    throw new Error(`invalid editor preview was not handled cleanly: ${JSON.stringify(invalidPreviewEdit)}`);
  }
  await setEditorValue(client, sampleTopology);
  await evaluate(client, `document.querySelector("#duration").value = "1"`);
  await evaluate(client, `document.querySelector("#validate-button").click()`);
  await waitFor(async () => evaluate(client, `document.querySelector("#validate-button").classList.contains("validated")`), "sample revalidated after invalid preview edit");

  await evaluate(client, `document.querySelector("#shortcut-help-button").focus()`);
  await dispatchShortcut(client, { key: "?" });
  const openHelp = await waitFor(async () => {
    const state = await evaluate(client, `(${shortcutHelpState})()`);
    return state.open && state.focusedDialog && state.text.includes("Run topology") ? state : false;
  }, "shortcut help opened");
  if (!openHelp.text.includes("Cmd/Ctrl") || !openHelp.text.includes("Switch result tabs")) {
    throw new Error(`shortcut help did not document expected commands: ${JSON.stringify(openHelp)}`);
  }
  await dispatchShortcut(client, { key: "Escape" });
  const closedHelp = await waitFor(async () => {
    const state = await evaluate(client, `(${shortcutHelpState})()`);
    return !state.open && state.focusedHelpButton ? state : false;
  }, "shortcut help closed");
  if (!closedHelp.focusedHelpButton) {
    throw new Error(`shortcut help did not restore focus: ${JSON.stringify(closedHelp)}`);
  }
  await evaluate(client, `window.motelPlayground.setTopology(window.motelPlayground.getTopology())`);
  await evaluate(client, `document.querySelector(".editor-pane .CodeMirror").CodeMirror.focus()`);
  await dispatchShortcut(client, { key: "?", selector: ".editor-pane .CodeMirror textarea" });
  const ignoredEditorHelp = await evaluate(client, `(${shortcutHelpState})()`);
  if (ignoredEditorHelp.open) {
    throw new Error(`shortcut help opened while typing in editor: ${JSON.stringify(ignoredEditorHelp)}`);
  }
  await dispatchShortcut(client, { key: "k", ctrlKey: true, selector: ".editor-pane .CodeMirror textarea" });
  const editorKeptFocus = await evaluate(client, `document.activeElement === document.querySelector(".editor-pane .CodeMirror textarea")`);
  if (!editorKeptFocus) {
    throw new Error("filter shortcut fired while typing in the editor");
  }
  await dispatchShortcut(client, { key: "Escape", selector: ".editor-pane .CodeMirror textarea" });
  const editorBlurred = await waitFor(async () => evaluate(client, `document.activeElement !== document.querySelector(".editor-pane .CodeMirror textarea")`), "editor escape blur");
  if (!editorBlurred) {
    throw new Error("Escape did not leave the editor field");
  }
  await evaluate(client, `document.querySelector("#shortcut-help-button").focus()`);
  await dispatchShortcut(client, { key: "k", ctrlKey: true });
  const filterFocused = await waitFor(async () => evaluate(client, `document.activeElement?.id === "result-filter"`), "filter shortcut focus");
  if (!filterFocused) {
    throw new Error("filter shortcut did not focus the output filter");
  }
  await evaluate(client, `document.querySelector("#result-filter").value = "gateway"`);
  await dispatchShortcut(client, { key: "Escape", selector: "#result-filter" });
  const filterEscaped = await waitFor(async () => evaluate(client, `(() => {
    const input = document.querySelector("#result-filter");
    return document.activeElement !== input && input.value === "";
  })()`), "filter escape clear and blur");
  if (!filterEscaped) {
    throw new Error("Escape did not clear and leave the output filter");
  }

  await evaluate(client, `document.querySelector("#validate-button").click()`);
  await waitFor(async () => evaluate(client, `document.querySelector("#validate-button").classList.contains("validated")`), "sample revalidated after editor shortcut checks");
  await evaluate(client, `document.querySelector("[data-view='map']").click()`);
  const mapState = await waitFor(async () => {
    const state = await evaluate(client, `(${mapRenderState})()`);
    return state.nonblankCanvas || state.fallbackNodes >= 2 ? state : false;
  }, "service map rendered");

  const maxNodeControl = await evaluate(client, `(() => {
    const input = document.querySelector("#max-nodes");
    return { value: input.value, min: input.min, max: input.max, step: input.step };
  })()`);
  if (maxNodeControl.value !== "8" || maxNodeControl.min !== "2" || maxNodeControl.max !== "12" || maxNodeControl.step !== "1") {
    throw new Error(`max-node control has unexpected defaults: ${JSON.stringify(maxNodeControl)}`);
  }
  await evaluate(client, `document.querySelector("#max-nodes").value = "3"`);
  const firstRandom = await generateDifferentTopology(client, sampleTopology);
  const secondRandom = await generateDifferentTopology(client, firstRandom.value);
  if (firstRandom.seed === secondRandom.seed) {
    throw new Error(`random topology reused seed ${firstRandom.seed}`);
  }
  if (firstRandom.services > 3 || secondRandom.services > 3) {
    throw new Error(`random topology exceeded max nodes: ${JSON.stringify({ firstRandom, secondRandom })}`);
  }
  await setEditorValue(client, sampleTopology);

  const durationControl = await evaluate(client, `(() => {
    const input = document.querySelector("#duration");
    return { value: input.value, min: input.min, max: input.max, step: input.step, label: input.closest("label")?.textContent.trim() };
  })()`);
  if (
    durationControl.value !== "1"
    || durationControl.min !== "0.1"
    || durationControl.max !== "10"
    || durationControl.step !== "0.1"
    || !durationControl.label.includes("max 10s")
  ) {
    throw new Error(`duration control does not default to one-second fractional input: ${JSON.stringify(durationControl)}`);
  }
  await evaluate(client, `(() => {
    window.__lastShareCopy = "";
    try {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text) => {
            window.__lastShareCopy = text;
          },
        },
      });
    } catch {
    }
  })()`);
  await evaluate(client, `document.querySelector("#duration").value = "2.5"`);
  await evaluate(client, `document.querySelector("#seed").value = "314"`);
  await evaluate(client, `document.querySelector("#max-nodes").value = "4"`);
  await setResultFilter(client, "gateway");
  await evaluate(client, `document.querySelector("[data-view='logs']").click()`);
  await evaluate(client, `document.querySelector("#share-button").click()`);
  const copiedShare = await waitFor(async () => {
    const state = await evaluate(client, `(${shareCopyState})()`);
    return state.hasHash && state.readyStatus ? state : false;
  }, "share link copied");
  const shareHash = new URL(copiedShare.href).hash;
  if (!shareHash.startsWith("#state=")) {
    throw new Error(`share link did not use the state hash: ${JSON.stringify(copiedShare)}`);
  }

  await client.send("Page.navigate", { url: `${pagesAppURL}${shareHash}` });
  const restoredShare = await waitFor(async () => {
    const state = await evaluate(client, `(${shareRestoreState})()`);
    return state.ready
      && state.preview
      && state.topology === sampleTopology
      && state.duration === "2.5"
      && state.seed === "314"
      && state.maxNodes === "4"
      && state.filter === "gateway"
      && state.activeView === "logs"
      ? state
      : false;
  }, "share link restored under Pages path");
  if (!restoredShare.path.endsWith(pagesBasePath)) {
    throw new Error(`share link did not preserve Pages path: ${JSON.stringify(restoredShare)}`);
  }

  await client.send("Page.navigate", { url: `${appURL}#state=not-valid` });
  const invalidShare = await waitFor(async () => {
    const state = await evaluate(client, `(${invalidShareState})()`);
    return state.ready && state.recoverable ? state : false;
  }, "invalid share link handled");
  if (!invalidShare.defaultTopology || invalidShare.runDisabled) {
    throw new Error(`invalid share link did not leave the playground usable: ${JSON.stringify(invalidShare)}`);
  }

  await setEditorValue(client, oversizedTopology);
  await evaluate(client, `document.querySelector("#share-button").click()`);
  const oversizedShare = await waitFor(async () => {
    const state = await evaluate(client, `(${oversizedShareState})()`);
    return state.tooLarge ? state : false;
  }, "oversized share link handled");
  if (!oversizedShare.status.includes("save YAML")) {
    throw new Error(`oversized share guidance was not clear: ${JSON.stringify(oversizedShare)}`);
  }

  await setEditorValue(client, sampleTopology);
  await setResultFilter(client, "");
  await evaluate(client, `document.querySelector("[data-view='preview']").click()`);
  await evaluate(client, `document.querySelector("#duration").value = "1"`);
  await evaluate(client, `document.querySelector("#seed").value = "42"`);
  await evaluate(client, `document.querySelector("#validate-button").click()`);
  await waitFor(async () => evaluate(client, `document.querySelector("#validate-button").classList.contains("validated")`), "sample revalidated after share checks");
  await evaluate(client, `document.querySelector("#run-button").click()`);
  const controlsDuringRun = await waitFor(async () => {
    const state = await evaluate(client, `(${runControlState})()`);
    return state.runDisabled ? state : false;
  }, "background run controls");
  if (controlsDuringRun.loadDisabled || controlsDuringRun.saveDisabled || controlsDuringRun.generateDisabled || controlsDuringRun.validateDisabled) {
    throw new Error(`background run disabled unrelated controls: ${JSON.stringify(controlsDuringRun)}`);
  }
  if (!controlsDuringRun.status.includes("background")) {
    throw new Error(`background run status did not describe worker execution: ${JSON.stringify(controlsDuringRun)}`);
  }
  await waitFor(async () => Number(await evaluate(client, `document.querySelector("#metric-spans").textContent`)) > 0, "spans captured");
  await evaluate(client, `document.querySelector("[data-view='raw']").click()`);
  const rawExpanded = await waitFor(async () => {
    const state = await evaluate(client, `(${rawJsonState})()`);
    return state.foldControls > 0
      && state.lines > 8
      && state.hasBraces
      && state.hasCommas
      && state.hasRunKeys
      && state.validJson
      && state.formatted
      && state.editorTextInset
      ? state
      : false;
  }, "raw JSON tree rendered");
  if (!rawExpanded.gutterContained) {
    throw new Error(`raw JSON line numbers escaped the gutter: ${JSON.stringify(rawExpanded)}`);
  }
  await evaluate(client, `(() => {
    const editor = document.querySelector("#raw-output .CodeMirror").CodeMirror;
    editor.focus();
    editor.setCursor({ line: 0, ch: 0 });
  })()`);
  await dispatchShortcut(client, { key: "q", ctrlKey: true, selector: "#raw-output .CodeMirror textarea" });
  const rawCollapsed = await waitFor(async () => {
    const state = await evaluate(client, `(${rawJsonState})()`);
    return state.foldMarks > 0 ? state : false;
  }, "raw JSON tree collapsed");
  if (rawCollapsed.foldControls < 1) {
    throw new Error(`raw JSON collapse did not leave a visible folded control: ${JSON.stringify({ rawExpanded, rawCollapsed })}`);
  }
  await dispatchShortcut(client, { key: "q", ctrlKey: true, selector: "#raw-output .CodeMirror textarea" });
  await evaluate(client, `document.querySelector("[data-view='metrics']").click()`);
  await evaluate(client, `(${installResultDownloadSpy})()`);
  await evaluate(client, `document.querySelector("#export-results-button").click()`);
  const exportedResults = await waitFor(async () => {
    const state = await evaluate(client, `(${resultDownloadState})()`);
    return state.ready ? state : false;
  }, "result JSON exported");
  if (
    exportedResults.kind !== "motel-playground-run"
    || exportedResults.seed !== "42"
    || exportedResults.traces < 1
    || exportedResults.spans < 1
    || exportedResults.metrics < 1
    || exportedResults.logs < 1
    || !exportedResults.topology.includes("gateway.request.duration")
  ) {
    throw new Error(`result export did not include the full run: ${JSON.stringify(exportedResults)}`);
  }
  if (!exportedResults.download.endsWith(".json") || !exportedResults.status.includes("Exported")) {
    throw new Error(`result export did not expose a JSON download: ${JSON.stringify(exportedResults)}`);
  }

  await client.send("Page.navigate", { url: appURL });
  await waitFor(async () => evaluate(client, `document.querySelector("#runtime-status")?.textContent === "Runtime ready"`), "runtime ready after result import reload");
  await importResultFile(client, exportedResults.text);
  const importedResults = await waitFor(async () => {
    const state = await evaluate(client, `(${resultImportState})()`);
    return state.ready ? state : false;
  }, "result JSON imported");
  if (
    !importedResults.topologyRestored
    || importedResults.duration !== "1"
    || importedResults.seed !== "42"
    || importedResults.traces < 1
    || importedResults.metrics < 1
    || importedResults.logs < 1
    || importedResults.exportDisabled
  ) {
    throw new Error(`result import did not restore the run: ${JSON.stringify(importedResults)}`);
  }
  await evaluate(client, `document.querySelector("[data-view='raw']").click()`);
  const importedRaw = await waitFor(async () => {
    const state = await evaluate(client, `(${rawJsonState})()`);
    return state.validJson && state.hasRunKeys ? state : false;
  }, "imported raw JSON rendered");
  if (!importedRaw.formatted) {
    throw new Error(`imported raw JSON was not formatted: ${JSON.stringify(importedRaw)}`);
  }
  await evaluate(client, `(${installPrintSpy})()`);
  await evaluate(client, `document.querySelector("#print-report-button").click()`);
  const reportState = await waitFor(async () => {
    const state = await evaluate(client, `(${printReportState})()`);
    return state.ready ? state : false;
  }, "printable report generated");
  if (
    !reportState.reportReady
    || reportState.prints !== 1
    || reportState.nodes < 2
    || reportState.tables < 4
    || reportState.interactiveControls !== 0
    || !reportState.sections.includes("Topology map")
    || !reportState.sections.includes("Topology configuration")
    || !reportState.text.includes("gateway.request.duration")
    || !reportState.text.includes("gateway handled")
  ) {
    throw new Error(`printable report is incomplete: ${JSON.stringify(reportState)}`);
  }
  const a4Report = await client.send("Page.printToPDF", {
    paperHeight: a4PaperHeightInches,
    paperWidth: a4PaperWidthInches,
    printBackground: true,
  });
  const letterReport = await client.send("Page.printToPDF", {
    paperHeight: letterPaperHeightInches,
    paperWidth: letterPaperWidthInches,
    printBackground: true,
  });
  assertReportPDF("A4", a4Report);
  assertReportPDF("Letter", letterReport);
  await evaluate(client, `document.querySelector("[data-view='metrics']").click()`);
  const metricState = await waitFor(async () => {
    const state = await evaluate(client, `(${signalTabState})("metrics")`);
    return state.rows > 0 && state.text.includes("gateway.request.duration") ? state : false;
  }, "metric signal rows rendered");
  await evaluate(client, `document.querySelector("[data-view='logs']").click()`);
  const logState = await waitFor(async () => {
    const state = await evaluate(client, `(${signalTabState})("logs")`);
    return state.rows > 0 && state.text.includes("gateway handled") ? state : false;
  }, "log signal rows rendered");
  if (!metricState.text.includes("histogram") || !logState.text.includes("INFO")) {
    throw new Error(`signal tabs did not expose expected details: ${JSON.stringify({ metricState, logState })}`);
  }
  await setResultFilter(client, "gateway");
  const gatewayFilter = await waitFor(async () => {
    const state = await evaluate(client, `(${resultFilterState})()`);
    return state.spans > 0 && state.metrics > 0 && state.logs > 0 ? state : false;
  }, "shared result filter applied to all signal tabs");
  if (!gatewayFilter.spanCountText.includes("match") || !gatewayFilter.logCountText.includes("match")) {
    throw new Error(`result filter counts did not reflect matching state: ${JSON.stringify(gatewayFilter)}`);
  }
  await setResultFilter(client, "/api/v1/users");
  const attributeFilter = await waitFor(async () => {
    const state = await evaluate(client, `(${resultFilterState})()`);
    return state.spans > 0 && state.metrics === 0 && state.logs === 0 ? state : false;
  }, "span attribute filter applied");
  if (!attributeFilter.traceText.includes("GET /users")) {
    throw new Error(`span attribute filter did not expose matching span: ${JSON.stringify(attributeFilter)}`);
  }
  await setResultFilter(client, "");

  await setEditorValue(client, erroredTopology);
  await evaluate(client, `document.querySelector("#validate-button").click()`);
  await waitFor(async () => evaluate(client, `document.querySelector("#validate-button").classList.contains("validated")`), "error topology validated");
  await evaluate(client, `document.querySelector("#duration").value = "1"`);
  await evaluate(client, `document.querySelector("#run-button").click()`);
  const unfilteredTraces = await waitFor(async () => {
    const state = await evaluate(client, `(${traceFilterState})()`);
    return state.errored > 0 ? state : false;
  }, "errored traces captured");
  await evaluate(client, `document.querySelector("[data-view='traces']").click()`);
  await evaluate(client, `document.querySelector("#error-filter").click()`);
  const filteredTraces = await waitFor(async () => {
    const state = await evaluate(client, `(${traceFilterState})()`);
    return state.active && state.total === unfilteredTraces.errored ? state : false;
  }, "error trace filter applied");
  if (filteredTraces.nonErrored !== 0) {
    throw new Error(`error filter left non-error traces visible: ${JSON.stringify(filteredTraces)}`);
  }
  await evaluate(client, `document.querySelector("#error-filter").click()`);

  await evaluate(client, `document.querySelector("[data-view='logs']").click()`);
  const unfilteredLogs = await waitFor(async () => {
    const state = await evaluate(client, `(${logFilterState})()`);
    return state.total > 0 ? state : false;
  }, "errored topology logs captured");
  await evaluate(client, `document.querySelector("#log-severity-filter").click()`);
  const filteredLogs = await waitFor(async () => {
    const state = await evaluate(client, `(${logFilterState})()`);
    return state.active && state.total <= unfilteredLogs.total ? state : false;
  }, "log severity filter applied");
  if (filteredLogs.infoRows !== 0) {
    throw new Error(`log filter left info rows visible: ${JSON.stringify(filteredLogs)}`);
  }
  await evaluate(client, `document.querySelector("#log-severity-filter").click()`);

  await setEditorValue(client, invalidTopology);
  await evaluate(client, `document.querySelector("#validate-button").click()`);
  await waitFor(async () => {
    const state = await evaluate(client, `(${invalidValidationState})()`);
    return state.cleared ? state : false;
  }, "invalid validation clears stale state");

  console.log(`browser smoke ok: map rendered via ${mapState.nonblankCanvas ? "p5 canvas" : "HTML fallback"}; stale states cleared`);
} finally {
  if (client) client.close();
  if (chrome.exitCode === null && chrome.signalCode === null) {
    chrome.kill("SIGTERM");
    await Promise.race([
      chromeClosed,
      delay(3000).then(() => {
        if (chrome.exitCode === null && chrome.signalCode === null) chrome.kill("SIGKILL");
      }),
    ]);
  }
  server.close();
  rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate.includes(path.sep)) {
      const result = spawnSync(candidate, ["--version"], { stdio: "ignore" });
      if (!result.error) return candidate;
      continue;
    }
    const result = spawnSync("which", [candidate], { encoding: "utf8" });
    if (result.status === 0) return result.stdout.trim();
  }
  return "";
}

function startStaticServer() {
  const contentTypes = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".wasm": "application/wasm",
  };
  const httpServer = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      const pathname = resolveStaticPathname(decodeURIComponent(url.pathname));
      const filePath = path.resolve(webRoot, `.${pathname}`);
      if (!filePath.startsWith(webRoot)) {
        response.writeHead(403);
        response.end("Forbidden");
        return;
      }
      const body = await readFile(filePath);
      response.writeHead(200, {
        "Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream",
      });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end("Not found");
    }
  });
  return new Promise((resolve, reject) => {
    httpServer.on("error", reject);
    httpServer.listen(0, "127.0.0.1", () => {
      resolve({
        port: httpServer.address().port,
        close: () => httpServer.close(),
      });
    });
  });
}

function resolveStaticPathname(pathname) {
  if (pathname === "/" || pathname === pagesBasePath) return "/index.html";
  if (pathname.startsWith(pagesBasePath)) {
    return `/${pathname.slice(pagesBasePath.length)}`;
  }
  return pathname;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForPageWebSocket(port, expectedURL) {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const pages = await response.json();
      const page = pages.find((item) => item.type === "page" && item.url === expectedURL) || pages.find((item) => item.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
    }
    await delay(100);
  }
  throw new Error("Timed out waiting for Chrome DevTools endpoint");
}

async function waitFor(fn, label, timeout = 12000) {
  const started = Date.now();
  let lastValue;
  while (Date.now() - started < timeout) {
    lastValue = await fn();
    if (lastValue) return lastValue;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(lastValue)}`);
}

async function evaluate(client, expression) {
  const response = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.text || "Runtime.evaluate failed");
  }
  return response.result.value;
}

async function setEditorValue(client, value) {
  await evaluate(client, `
    (() => {
      window.motelPlayground.setTopology(${JSON.stringify(value)});
    })()
  `);
  await waitFor(async () => {
    const state = await evaluate(client, `(() => ({
      visible: window.motelPlayground.getTopology(),
      hidden: document.querySelector("#editor").value,
    }))()`);
    return state.visible === value && state.hidden === value ? state : false;
  }, "topology editor synchronized");
}

async function setResultFilter(client, value) {
  await evaluate(client, `
    (() => {
      const input = document.querySelector("#result-filter");
      input.value = ${JSON.stringify(value)};
      input.dispatchEvent(new Event("input", { bubbles: true }));
    })()
  `);
}

async function importResultFile(client, text) {
  await evaluate(client, `
    (() => {
      const input = document.querySelector("#result-file");
      const file = new File([${JSON.stringify(text)}], "shared-results.json", { type: "application/json" });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    })()
  `);
}

async function dispatchShortcut(client, { key, ctrlKey = false, metaKey = false, shiftKey = false, altKey = false, selector = "document" }) {
  await evaluate(client, `
    (() => {
      const target = ${selector === "document" ? "document" : `document.querySelector(${JSON.stringify(selector)})`};
      const keyCode = ${JSON.stringify(keyCodeForShortcut(key))};
      target.dispatchEvent(new KeyboardEvent("keydown", {
        key: ${JSON.stringify(key)},
        code: ${JSON.stringify(codeForShortcut(key))},
        keyCode,
        which: keyCode,
        ctrlKey: ${JSON.stringify(ctrlKey)},
        metaKey: ${JSON.stringify(metaKey)},
        shiftKey: ${JSON.stringify(shiftKey)},
        altKey: ${JSON.stringify(altKey)},
        bubbles: true,
        cancelable: true,
      }));
    })()
  `);
}

function keyCodeForShortcut(key) {
  if (key.length === 1) return key.toUpperCase().charCodeAt(0);
  if (key === "Escape") return 27;
  if (key === "Enter") return 13;
  if (key === "Tab") return 9;
  return 0;
}

function codeForShortcut(key) {
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  return key;
}

async function generateDifferentTopology(client, previousValue) {
  await evaluate(client, `document.querySelector("#generate-button").click()`);
  return waitFor(async () => {
    const snapshot = await evaluate(client, `(() => ({
      value: window.motelPlayground.getTopology(),
      seed: document.querySelector("#seed").value,
      services: window.motelPlayground.getTopology().split("\\ntraffic:")[0].split("\\n").filter((line) => /^  [a-z0-9-]+:$/.test(line)).length,
      rateVariation: document.querySelector("#preview svg")?.dataset.rateVariation,
    }))()`);
    return snapshot.value !== previousValue
      && snapshot.value.includes(`# Seed: ${snapshot.seed}`)
      && snapshot.rateVariation === "true"
      ? snapshot
      : false;
  }, "random topology changed");
}

function resultTabA11yState() {
  const expectedTabCount = 6;
  const tabs = Array.from(document.querySelectorAll(".tabs [role='tab']"));
  const panels = Array.from(document.querySelectorAll(".view[role='tabpanel']"));
  const selectedTabs = tabs.filter((tab) => tab.getAttribute("aria-selected") === "true");
  const invalidTabs = tabs.filter((tab) => {
    const panel = document.getElementById(tab.getAttribute("aria-controls"));
    return !tab.id || !panel || panel.getAttribute("aria-labelledby") !== tab.id;
  });
  const invalidPanels = panels.filter((panel) => {
    const tab = document.getElementById(panel.getAttribute("aria-labelledby"));
    const active = panel.classList.contains("active");
    return !panel.id || !tab || panel.hidden === active;
  });
  const ok = tabs.length === expectedTabCount
    && panels.length === expectedTabCount
    && selectedTabs.length === 1
    && invalidTabs.length === 0
    && invalidPanels.length === 0;
  return {
    ok,
    tabs: tabs.map((tab) => ({
      id: tab.id,
      selected: tab.getAttribute("aria-selected"),
      controls: tab.getAttribute("aria-controls"),
      tabindex: tab.getAttribute("tabindex") || "0",
    })),
    panels: panels.map((panel) => ({
      id: panel.id,
      labelledby: panel.getAttribute("aria-labelledby"),
      hidden: panel.hidden,
      active: panel.classList.contains("active"),
    })),
    invalidTabs: invalidTabs.map((tab) => tab.id),
    invalidPanels: invalidPanels.map((panel) => panel.id),
  };
}

function resultTabFocusState() {
  const selectedTab = document.querySelector("[role='tab'][aria-selected='true']");
  return {
    activeView: document.querySelector(".tab.active")?.dataset.view,
    focusedTab: document.activeElement?.id,
    selectedTab: selectedTab?.id,
  };
}

function previewThemeState() {
  const svg = document.querySelector("#preview svg");
  const bg = svg?.querySelector(".preview-bg");
  const title = svg?.querySelector(".title");
  const card = svg?.querySelector(".card");
  const html = svg?.outerHTML || "";
  return {
    theme: document.documentElement.dataset.theme,
    calls: window.__previewRenderCalls || 0,
    hasSVG: Boolean(svg),
    backgroundFill: bg ? getComputedStyle(bg).fill : "",
    textFill: title ? getComputedStyle(title).fill : "",
    cardFill: card ? getComputedStyle(card).fill : "",
    hardcodedLight: /#(?:f7f7f5|262626|666|777|deded9|9f9f98|242424|fff|d7d7d1|e9e9e4)/i.test(html),
  };
}

function invalidPreviewEditState() {
  const preview = document.querySelector("#preview");
  return {
    cleared: !preview.querySelector("svg")
      && preview.textContent.includes("Validate the topology")
      && document.querySelector("#validate-button").textContent === "Validate",
    preview: preview.textContent,
    unhandled: window.__unhandledRejections || [],
  };
}

function shortcutHelpState() {
  const help = document.querySelector("#shortcut-help");
  return {
    open: !help.hidden,
    focusedDialog: document.activeElement === document.querySelector(".shortcut-modal"),
    focusedHelpButton: document.activeElement === document.querySelector("#shortcut-help-button"),
    text: help.textContent,
  };
}

function shareCopyState() {
  const status = document.querySelector("#share-status").textContent;
  const href = window.__lastShareCopy || window.location.href;
  return {
    href,
    status,
    hasHash: new URL(href).hash.startsWith("#state="),
    readyStatus: status.includes("copied") || status.includes("address bar"),
  };
}

function shareRestoreState() {
  return {
    ready: document.querySelector("#runtime-status")?.textContent === "Runtime ready",
    preview: Boolean(document.querySelector("#preview svg")),
    topology: window.motelPlayground?.getTopology(),
    duration: document.querySelector("#duration").value,
    seed: document.querySelector("#seed").value,
    maxNodes: document.querySelector("#max-nodes").value,
    filter: document.querySelector("#result-filter").value,
    activeView: document.querySelector(".tab.active")?.dataset.view,
    path: window.location.pathname,
    status: document.querySelector("#share-status").textContent,
  };
}

function invalidShareState() {
  return {
    ready: document.querySelector("#runtime-status")?.textContent === "Runtime ready",
    recoverable: document.querySelector("#share-status").textContent.includes("could not be opened"),
    defaultTopology: window.motelPlayground?.getTopology().includes("Five-service topology"),
    runDisabled: document.querySelector("#run-button").disabled,
  };
}

function oversizedShareState() {
  const status = document.querySelector("#share-status").textContent;
  return {
    status,
    tooLarge: status.includes("too large"),
  };
}

function installResultDownloadSpy() {
  window.__resultDownload = {};
  URL.createObjectURL = (blob) => {
    window.__resultDownload.blob = blob;
    return "blob:motel-results";
  };
  URL.revokeObjectURL = () => {};
  HTMLAnchorElement.prototype.click = function () {
    if (this.download?.endsWith(".json")) {
      window.__resultDownload.download = this.download;
      window.__resultDownload.href = this.href;
    }
  };
}

async function resultDownloadState() {
  const blob = window.__resultDownload?.blob;
  let text = "";
  let json = null;
  if (blob) {
    text = await blob.text();
    try {
      json = JSON.parse(text);
    } catch {
    }
  }
  return {
    ready: Boolean(json),
    text,
    kind: json?.kind,
    seed: json?.settings?.seed,
    topology: json?.topology || "",
    traces: json?.result?.stats?.traces ?? 0,
    spans: json?.result?.stats?.spans ?? 0,
    metrics: json?.result?.metrics?.length ?? 0,
    logs: json?.result?.logs?.length ?? 0,
    download: window.__resultDownload?.download || "",
    status: document.querySelector("#share-status").textContent,
  };
}

function resultImportState() {
  return {
    ready: document.querySelector("#share-status").textContent.includes("Imported")
      && document.querySelector("#summary-line").textContent.includes("Imported run"),
    topologyRestored: window.motelPlayground?.getTopology().includes("gateway.request.duration"),
    duration: document.querySelector("#duration").value,
    seed: document.querySelector("#seed").value,
    traces: Number(document.querySelector("#metric-traces").textContent),
    spans: Number(document.querySelector("#metric-spans").textContent),
    metrics: document.querySelectorAll("#signal-metrics .signal-item").length,
    logs: document.querySelectorAll("#signal-logs .signal-item").length,
    exportDisabled: document.querySelector("#export-results-button").disabled,
    status: document.querySelector("#share-status").textContent,
    summary: document.querySelector("#summary-line").textContent,
  };
}

function installPrintSpy() {
  window.__printCount = 0;
  window.print = () => {
    window.__printCount += 1;
  };
}

function printReportState() {
  const report = document.querySelector("#print-report");
  return {
    ready: window.__printCount > 0 && report.textContent.includes("Topology report"),
    reportReady: document.body.classList.contains("report-ready"),
    prints: window.__printCount,
    nodes: report.querySelectorAll(".report-node").length,
    tables: report.querySelectorAll(".report-table").length,
    interactiveControls: report.querySelectorAll("button, input, textarea, select, .tab, .CodeMirror").length,
    sections: Array.from(report.querySelectorAll(".report-section h2")).map((heading) => heading.textContent),
    text: report.textContent,
  };
}

function mapRenderState() {
  const map = document.querySelector("#service-map");
  const canvas = map.querySelector("canvas");
  return {
    fallbackNodes: map.querySelectorAll(".service-node").length,
    nonblankCanvas: canvas ? canvasHasInk(canvas) : false,
    text: map.textContent.trim(),
  };

  function canvasHasInk(canvas) {
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
    const step = Math.max(1, Math.floor((width * height) / 8000));
    const base = [data[0], data[1], data[2], data[3]];
    for (let pixel = step; pixel < width * height; pixel += step) {
      const index = pixel * 4;
      const delta = Math.abs(data[index] - base[0])
        + Math.abs(data[index + 1] - base[1])
        + Math.abs(data[index + 2] - base[2])
        + Math.abs(data[index + 3] - base[3]);
      if (delta > 8) return true;
    }
    return false;
  }
}

function traceFilterState() {
  const groups = Array.from(document.querySelectorAll("#traces .trace-group"));
  const errored = groups.filter((group) => group.classList.contains("errored")).length;
  return {
    total: groups.length,
    errored,
    nonErrored: groups.length - errored,
    active: document.querySelector("#error-filter").getAttribute("aria-pressed") === "true",
    disabled: document.querySelector("#error-filter").disabled,
    count: document.querySelector("#span-filter-count").textContent,
  };
}

function signalTabState(kind) {
  const root = document.querySelector(kind === "metrics" ? "#signal-metrics" : "#signal-logs");
  return {
    rows: root.querySelectorAll(".signal-item").length,
    text: root.textContent,
  };
}

function logFilterState() {
  const rows = Array.from(document.querySelectorAll("#signal-logs .signal-item"));
  return {
    total: rows.length,
    infoRows: rows.filter((row) => row.className.toLowerCase().includes("log-info")).length,
    active: document.querySelector("#log-severity-filter").getAttribute("aria-pressed") === "true",
    disabled: document.querySelector("#log-severity-filter").disabled,
    count: document.querySelector("#log-filter-count").textContent,
  };
}

function resultFilterState() {
  document.querySelector("[data-view='traces']").click();
  const traceText = document.querySelector("#traces").textContent;
  document.querySelector("[data-view='metrics']").click();
  const metricText = document.querySelector("#signal-metrics").textContent;
  document.querySelector("[data-view='logs']").click();
  const logText = document.querySelector("#signal-logs").textContent;
  return {
    filter: document.querySelector("#result-filter").value,
    spans: document.querySelectorAll("#traces .trace-group").length,
    metrics: document.querySelectorAll("#signal-metrics .signal-item").length,
    logs: document.querySelectorAll("#signal-logs .signal-item").length,
    traceText,
    metricText,
    logText,
    spanCountText: document.querySelector("#span-filter-count").textContent,
    logCountText: document.querySelector("#log-filter-count").textContent,
  };
}

function rawJsonState() {
  const raw = document.querySelector("#raw-output");
  const editor = raw.querySelector(".CodeMirror")?.CodeMirror;
  const value = editor?.getValue() || "";
  const gutter = raw.querySelector(".CodeMirror-gutters")?.getBoundingClientRect();
  const line = raw.querySelector(".CodeMirror-line")?.getBoundingClientRect();
  const lineNumberNodes = Array.from(raw.querySelectorAll(".CodeMirror-linenumber"))
    .filter((lineNumber) => !lineNumber.closest(".CodeMirror-measure"))
    .slice(0, 20);
  const lineNumbers = lineNumberNodes.map((line) => line.getBoundingClientRect());
  const escapedLineNumber = lineNumberNodes
    .map((line) => ({ text: line.textContent, rect: line.getBoundingClientRect() }))
    .find(({ rect }) => gutter && rect.right > gutter.right + 0.5);
  const maxLineNumberRight = lineNumbers.reduce((max, rect) => Math.max(max, rect.right), 0);
  let validJson = false;
  try {
    JSON.parse(value);
    validJson = true;
  } catch {
  }
  return {
    foldControls: raw.querySelectorAll(".CodeMirror-foldgutter-open, .CodeMirror-foldgutter-folded").length,
    foldMarks: editor?.getAllMarks().length || 0,
    lines: editor?.lineCount() || 0,
    hasBraces: value.includes("{") && value.includes("}"),
    hasCommas: value.includes(","),
    hasRunKeys: value.includes('"ok"') && value.includes('"spans"') && value.includes('"stats"'),
    validJson,
    formatted: value.includes('\n  "') && !value.includes("\n      \n"),
    gutterContained: Boolean(gutter)
      && maxLineNumberRight <= gutter.right + 0.5
      && (!line || line.left >= gutter.right - 0.5),
    editorTextInset: Boolean(gutter && line) && line.left >= gutter.right + 4,
    gutterRight: gutter?.right ?? 0,
    lineLeft: line?.left ?? 0,
    escapedLineNumber: escapedLineNumber
      ? {
        text: escapedLineNumber.text,
        left: escapedLineNumber.rect.left,
        right: escapedLineNumber.rect.right,
      }
      : null,
    maxLineNumberRight,
    editorReady: Boolean(editor),
  };
}

function runControlState() {
  return {
    status: document.querySelector("#runtime-status").textContent,
    loadDisabled: document.querySelector("#load-button").disabled,
    saveDisabled: document.querySelector("#save-button").disabled,
    generateDisabled: document.querySelector("#generate-button").disabled,
    validateDisabled: document.querySelector("#validate-button").disabled,
    runDisabled: document.querySelector("#run-button").disabled,
  };
}

function assertReportPDF(label, pdf) {
  if (!pdf?.data || pdf.data.length < minReportPDFBase64Length) {
    throw new Error(`${label} report PDF was too small: ${pdf?.data?.length ?? 0}`);
  }
}

function invalidValidationState() {
  const validate = document.querySelector("#validate-button");
  const preview = document.querySelector("#preview");
  const map = document.querySelector("#service-map");
  const spans = document.querySelector("#traces");
  const signalMetrics = document.querySelector("#signal-metrics");
  const signalLogs = document.querySelector("#signal-logs");
  const metrics = {
    traces: document.querySelector("#metric-traces").textContent,
    spans: document.querySelector("#metric-spans").textContent,
    errors: document.querySelector("#metric-errors").textContent,
  };
  const cleared = validate.textContent === "Invalid"
    && validate.classList.contains("invalid")
    && !validate.classList.contains("validated")
    && !preview.querySelector("svg")
    && !map.querySelector("canvas")
    && map.textContent.includes("Fix validation errors")
    && !spans.querySelector(".trace-group")
    && spans.textContent.includes("Fix validation errors")
    && !signalMetrics.querySelector(".signal-item")
    && signalMetrics.textContent.includes("Fix validation errors")
    && !signalLogs.querySelector(".signal-item")
    && signalLogs.textContent.includes("Fix validation errors")
    && metrics.traces === "0"
    && metrics.spans === "0"
    && metrics.errors === "0%";
  return { cleared, validate: validate.textContent, preview: preview.textContent, map: map.textContent, spans: spans.textContent, signalMetrics: signalMetrics.textContent, signalLogs: signalLogs.textContent, metrics };
}
