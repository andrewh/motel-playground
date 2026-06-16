importScripts("./wasm_exec.js");

let runtimePromise;
let runtimeGo;

self.addEventListener("message", async (event) => {
  const message = event.data || {};
  if (message.type !== "run") return;

  try {
    await loadRuntime();
    const json = await self.motelRun(message.topology, message.duration, message.seed, message.signals, message.slowThresholdMs);
    self.postMessage({ id: message.id, ok: true, json });
  } catch (error) {
    self.postMessage({ id: message.id, ok: false, error: serializeError(error) });
  }
});

async function loadRuntime() {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      runtimeGo = new Go();
      const result = await WebAssembly.instantiateStreaming(fetch("./motel.wasm"), runtimeGo.importObject);
      runtimeGo.run(result.instance);
    })();
  }
  return runtimePromise;
}

function serializeError(error) {
  return {
    message: error?.message || String(error),
    stack: error?.stack || "",
  };
}
