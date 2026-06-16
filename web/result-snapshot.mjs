export const resultSnapshotKind = "motel-playground-run";
export const resultSnapshotVersion = 1;
export const resultSnapshotMimeType = "application/json";

const defaultDurationSetting = "1";
const defaultMaxNodesSetting = "8";
const defaultSeedSetting = "42";
const defaultSignalSetting = true;
const defaultSlowThresholdSetting = "0";
const filenameFallbackToken = "run";
const filenameUnsafePattern = /[^a-z0-9_-]+/gi;
const requiredStatsFields = ["traces", "spans", "errors", "error_rate"];
const resultArrayFields = ["spans", "metrics", "logs"];

export function createResultSnapshot({ topology, settings = {}, result, exportedAt = new Date() }) {
  const snapshot = {
    kind: resultSnapshotKind,
    v: resultSnapshotVersion,
    exported_at: exportedAt instanceof Date ? exportedAt.toISOString() : String(exportedAt),
    topology,
    settings: normalizeSettings(settings),
    result,
  };
  return normalizeResultSnapshot(snapshot);
}

export function parseResultSnapshot(text) {
  let snapshot;
  try {
    snapshot = JSON.parse(text);
  } catch {
    throw new Error("result file is not valid JSON");
  }
  return normalizeResultSnapshot(snapshot);
}

export function normalizeResultSnapshot(snapshot) {
  if (!isRecord(snapshot)) {
    throw new Error("result file is missing a snapshot object");
  }
  if (snapshot.kind !== resultSnapshotKind || snapshot.v !== resultSnapshotVersion) {
    throw new Error("result file uses an unsupported format");
  }
  if (typeof snapshot.topology !== "string" || !snapshot.topology.trim()) {
    throw new Error("result file is missing topology YAML");
  }
  return {
    kind: resultSnapshotKind,
    v: resultSnapshotVersion,
    exported_at: typeof snapshot.exported_at === "string" ? snapshot.exported_at : "",
    topology: snapshot.topology,
    settings: normalizeSettings(snapshot.settings),
    result: normalizeRunResult(snapshot.result),
  };
}

export function resultSnapshotFilename(settings = {}) {
  const seed = safeFilenameToken(settings.seed);
  return `motel-results-${seed || filenameFallbackToken}.json`;
}

function normalizeRunResult(result) {
  if (!isRecord(result)) {
    throw new Error("result file is missing run output");
  }
  if (result.ok !== true) {
    throw new Error("result file does not contain a completed run");
  }
  if (!isRecord(result.stats)) {
    throw new Error("result file is missing run statistics");
  }
  for (const field of requiredStatsFields) {
    if (!Number.isFinite(Number(result.stats[field]))) {
      throw new Error(`result file has invalid ${field} statistics`);
    }
  }
  if (!isRecord(result.topology) || !Array.isArray(result.topology.services)) {
    throw new Error("result file is missing topology analysis");
  }
  if (!isRecord(result.limits)) {
    throw new Error("result file is missing run limits");
  }
  const normalized = { ...result };
  for (const field of resultArrayFields) {
    normalized[field] = Array.isArray(result[field]) ? result[field] : [];
  }
  return normalized;
}

function normalizeSettings(settings = {}) {
  const source = isRecord(settings) ? settings : {};
  return {
    duration: stringSetting(source.duration, defaultDurationSetting),
    slowThresholdMs: stringSetting(source.slowThresholdMs, defaultSlowThresholdSetting),
    seed: stringSetting(source.seed, defaultSeedSetting),
    maxNodes: stringSetting(source.maxNodes, defaultMaxNodesSetting),
    signals: normalizeSignals(source.signals),
  };
}

function normalizeSignals(signals = {}) {
  const source = isRecord(signals) ? signals : {};
  return {
    traces: boolSetting(source.traces, defaultSignalSetting),
    metrics: boolSetting(source.metrics, defaultSignalSetting),
    logs: boolSetting(source.logs, defaultSignalSetting),
  };
}

function stringSetting(value, fallback) {
  if (value == null || value === "") return fallback;
  return String(value);
}

function boolSetting(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function safeFilenameToken(value) {
  return String(value ?? "")
    .trim()
    .replaceAll(filenameUnsafePattern, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
