import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { randomTopologyYaml } from "../web/topology-generator.mjs";

const wasmExec = await readFile(new URL("../web/wasm_exec.js", import.meta.url), "utf8");
vm.runInThisContext(wasmExec, { filename: "wasm_exec.js" });

const go = new Go();
const wasm = await readFile(new URL("../web/motel.wasm", import.meta.url));
const { instance } = await WebAssembly.instantiate(wasm, go.importObject);
go.run(instance);
const traceFixture = await readFile(new URL("../third_party/motel/pkg/synth/traceimport/testdata/single-trace-otlp.json", import.meta.url), "utf8");

const topology = `version: 1
services:
  gateway:
    metrics:
      - name: gateway.request.duration
        type: histogram
        unit: ms
    logs:
      - severity: INFO
        body: "gateway handled {operation.name}"
    operations:
      GET /:
        duration: 5ms +/- 1ms
        error_rate: 1%
        calls:
          - worker.job
  worker:
    operations:
      job:
        duration: 2ms +/- 1ms
traffic:
  rate: 5/s
`;

const scenarioShapeTopology = `version: 1
services:
  gateway:
    operations:
      GET /:
        duration: 5ms +/- 1ms
        calls:
          - worker.job
  worker:
    operations:
      job:
        duration: 3ms +/- 1ms
  cache:
    operations:
      get:
        duration: 1ms +/- 1ms
traffic:
  rate: 5/s
scenarios:
  - name: fallback fanout
    at: +200ms
    duration: 600ms
    override:
      worker.job:
        add_calls:
          - target: cache.get
`;

const validation = JSON.parse(await globalThis.motelValidate(topology));
if (!validation.ok) {
  throw new Error(`validation failed: ${JSON.stringify(validation.diagnostics)}`);
}
if (!validation.topology.graph || validation.topology.graph.nodes.length !== 2 || validation.topology.graph.edges.length !== 1) {
  throw new Error(`graph data missing from validation: ${JSON.stringify(validation.topology.graph)}`);
}

const svg = await globalThis.motelPreview(topology, 60);
if (!svg.startsWith("<svg") || !svg.includes("polyline")) {
  throw new Error("preview did not return an SVG chart");
}
if (
  !svg.includes("expected traces")
  || !svg.includes("trace shape sample")
  || !svg.includes("elapsed run time")
  || !svg.includes('data-rate-variation="false"')
) {
  throw new Error("static-rate preview did not include forecast details");
}

const inactiveShapeSvg = await globalThis.motelPreview(scenarioShapeTopology, 0.1);
const activeShapeSvg = await globalThis.motelPreview(scenarioShapeTopology, 1);
if (!inactiveShapeSvg.includes('data-shape-max-spans="2"') || !inactiveShapeSvg.includes('data-shape-scenarios="0"')) {
  throw new Error("duration before scenario window should use the baseline trace shape");
}
if (!activeShapeSvg.includes('data-shape-max-spans="3"') || !activeShapeSvg.includes('data-shape-scenarios="1"')) {
  throw new Error("duration overlapping scenario window should include scenario call-shape changes");
}

const run = JSON.parse(await globalThis.motelRun(topology, 1, 7));
if (!run.ok || run.stats.traces < 1 || run.spans.length < 1) {
  throw new Error(`run did not capture spans: ${JSON.stringify(run)}`);
}
if (!run.metrics?.some((metric) => metric.name === "gateway.request.duration" && metric.type === "histogram" && metric.service === "gateway" && metric.count > 0)) {
  throw new Error(`run did not capture topology metrics: ${JSON.stringify(run.metrics)}`);
}
if (!run.logs?.some((log) => log.severity === "INFO" && log.body.includes("gateway handled") && log.service === "gateway" && log.operation === "GET /")) {
  throw new Error(`run did not capture topology logs: ${JSON.stringify(run.logs)}`);
}
if (run.limits.duration_seconds !== 1) {
  throw new Error(`default one-second run changed unexpectedly: ${JSON.stringify(run.limits)}`);
}
const orderedSpans = run.spans.slice().sort((a, b) => a.timestamp_ms - b.timestamp_ms);
if (orderedSpans[0].service !== "gateway") {
  throw new Error(`earliest span should be gateway, got ${orderedSpans[0].service}`);
}
if (!orderedSpans.every((span) => span.trace_id && !/^0+$/.test(span.trace_id) && span.span_id && !/^0+$/.test(span.span_id))) {
  throw new Error(`spans should include real trace/span IDs: ${JSON.stringify(orderedSpans[0])}`);
}
if (new Set(orderedSpans.map((span) => span.trace_id)).size < 1) {
  throw new Error("run did not include trace IDs");
}

const fractionalRun = JSON.parse(await globalThis.motelRun(topology, 0.5, 7));
if (!fractionalRun.ok || Math.abs(fractionalRun.limits.duration_seconds - 0.5) > 0.001) {
  throw new Error(`fractional duration was not preserved: ${JSON.stringify(fractionalRun)}`);
}

const importedTopology = JSON.parse(await globalThis.motelImportTraces(traceFixture, "otlp"));
if (
  !importedTopology.ok
  || importedTopology.stats?.traces !== 1
  || importedTopology.stats?.spans !== 2
  || !importedTopology.topology.includes("api-gateway:")
  || !importedTopology.topology.includes("user-service.list")
) {
  throw new Error(`trace import did not infer topology: ${JSON.stringify(importedTopology)}`);
}
const autoImportedTopology = JSON.parse(await globalThis.motelImportTraces(traceFixture, "auto"));
if (!autoImportedTopology.ok || !autoImportedTopology.topology.includes("GET /users")) {
  throw new Error(`trace auto-detection failed: ${JSON.stringify(autoImportedTopology)}`);
}
const rejectedTraceImport = JSON.parse(await globalThis.motelImportTraces(traceFixture, "zipkin"));
if (rejectedTraceImport.ok || !rejectedTraceImport.diagnostics?.[0]?.message.includes("unknown trace format")) {
  throw new Error(`trace import accepted an unknown format: ${JSON.stringify(rejectedTraceImport)}`);
}

for (const seed of [1, 42, 777, 2026]) {
  const generated = randomTopologyYaml(seed);
  if (
    !generated.includes("pattern:")
    || !generated.includes("    traffic:")
    || !generated.includes("    metrics:")
    || !generated.includes("    logs:")
  ) {
    throw new Error(`generated topology ${seed} did not include rich traffic and signal syntax:\n${generated}`);
  }
  const generatedValidation = JSON.parse(await globalThis.motelValidate(generated));
  if (!generatedValidation.ok) {
    throw new Error(`generated topology ${seed} failed validation: ${JSON.stringify(generatedValidation.diagnostics)}`);
  }
  const generatedSvg = await globalThis.motelPreview(generated, 60);
  if (!generatedSvg.includes('data-rate-variation="true"')) {
    throw new Error(`generated topology ${seed} did not produce non-flat traffic preview`);
  }
  const generatedRun = JSON.parse(await globalThis.motelRun(generated, 1, seed));
  if (!generatedRun.ok || generatedRun.stats.traces < 1 || generatedRun.spans.length < 1) {
    throw new Error(`generated topology ${seed} did not run: ${JSON.stringify(generatedRun)}`);
  }
  if (!generatedRun.metrics?.length) {
    throw new Error(`generated topology ${seed} did not emit metrics: ${JSON.stringify(generatedRun)}`);
  }
  if (!generatedRun.logs?.length) {
    throw new Error(`generated topology ${seed} did not emit logs: ${JSON.stringify(generatedRun)}`);
  }

  const capped = randomTopologyYaml(seed, { maxNodes: 3 });
  const cappedValidation = JSON.parse(await globalThis.motelValidate(capped));
  if (!cappedValidation.ok) {
    throw new Error(`capped generated topology ${seed} failed validation: ${JSON.stringify(cappedValidation.diagnostics)}`);
  }
  if (cappedValidation.topology.services.length > 3) {
    throw new Error(`generated topology ${seed} exceeded max nodes: ${cappedValidation.topology.services.length}`);
  }
}

console.log(`wasm smoke ok: ${run.stats.traces} traces, ${run.stats.spans} spans; generated topologies valid`);
