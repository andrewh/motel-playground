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
const invalidTopology = "version: 1\nservices: [\n";

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
      }))()`);
      return runtimeState.ready;
    }, "runtime ready and preview rendered");
  } catch (error) {
    throw new Error(`${error.message}: ${JSON.stringify(runtimeState)}`);
  }

  await evaluate(client, `document.querySelector("[data-view='map']").click()`);
  const mapState = await waitFor(async () => {
    const state = await evaluate(client, `(${mapRenderState})()`);
    return state.nonblankCanvas || state.fallbackNodes >= 2 ? state : false;
  }, "service map rendered");

  const sampleTopology = await evaluate(client, `document.querySelector("#editor").value`);
  const durationControl = await evaluate(client, `(() => {
    const input = document.querySelector("#duration");
    return { value: input.value, min: input.min, step: input.step };
  })()`);
  if (durationControl.value !== "1" || durationControl.min !== "0.1" || durationControl.step !== "0.1") {
    throw new Error(`duration control does not default to one-second fractional input: ${JSON.stringify(durationControl)}`);
  }
  await evaluate(client, `document.querySelector("#duration").value = "0.5"`);
  await evaluate(client, `document.querySelector("#run-button").click()`);
  await waitFor(async () => Number(await evaluate(client, `document.querySelector("#metric-spans").textContent`)) > 0, "spans captured");

  await setEditorValue(client, invalidTopology);
  await evaluate(client, `document.querySelector("#validate-button").click()`);
  await waitFor(async () => {
    const state = await evaluate(client, `(${invalidValidationState})()`);
    return state.cleared ? state : false;
  }, "invalid validation clears stale state");

  await setEditorValue(client, sampleTopology);
  await evaluate(client, `document.querySelector("#validate-button").click()`);
  await waitFor(async () => evaluate(client, `document.querySelector("#validate-button").classList.contains("validated")`), "sample revalidated");
  await evaluate(client, `document.querySelector("#run-button").click()`);
  await waitFor(async () => Number(await evaluate(client, `document.querySelector("#metric-spans").textContent`)) > 0, "spans captured after revalidation");

  await setEditorValue(client, invalidTopology);
  await evaluate(client, `document.querySelector("#run-button").click()`);
  await waitFor(async () => {
    const state = await evaluate(client, `(${failedRunStateSnapshot})()`);
    return state.cleared ? state : false;
  }, "failed run clears stale state");

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
      const pathname = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
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
      const editor = document.querySelector("#editor");
      editor.value = ${JSON.stringify(value)};
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    })()
  `);
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

function invalidValidationState() {
  const validate = document.querySelector("#validate-button");
  const preview = document.querySelector("#preview");
  const map = document.querySelector("#service-map");
  const spans = document.querySelector("#traces");
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
    && metrics.traces === "0"
    && metrics.spans === "0"
    && metrics.errors === "0%";
  return { cleared, validate: validate.textContent, preview: preview.textContent, map: map.textContent, spans: spans.textContent, metrics };
}

function failedRunStateSnapshot() {
  const map = document.querySelector("#service-map");
  const preview = document.querySelector("#preview");
  const spans = document.querySelector("#traces");
  const metrics = {
    traces: document.querySelector("#metric-traces").textContent,
    spans: document.querySelector("#metric-spans").textContent,
    errors: document.querySelector("#metric-errors").textContent,
  };
  const cleared = document.querySelector("#summary-line").classList.contains("bad")
    && !preview.querySelector("svg")
    && preview.textContent.includes("Fix the run error")
    && !map.querySelector("canvas")
    && map.textContent.includes("Fix the run error")
    && !spans.querySelector(".trace-group")
    && spans.textContent.includes("Run failed")
    && metrics.traces === "0"
    && metrics.spans === "0"
    && metrics.errors === "0%";
  return { cleared, summary: document.querySelector("#summary-line").textContent, preview: preview.textContent, map: map.textContent, spans: spans.textContent, metrics };
}
