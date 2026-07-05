import {
  createResultSnapshot,
  normalizeResultSnapshot,
  normalizeSnapshotSettings,
  resultSnapshotKind,
  resultSnapshotVersion,
} from "./result-snapshot.mjs";

export const sessionKind = "motel-playground-session";
export const sessionVersion = 1;
export const sessionMimeType = "application/json";
export const sessionStorageKey = "motel-playground-session-v1";
export const sessionEntryKinds = Object.freeze(["run"]);

export const defaultSessionLimits = Object.freeze({
  maxEntries: 50,
  maxResultChars: 256 * 1024,
  maxSessionChars: 3 * 1024 * 1024,
});

const defaultEntryKind = "run";
const defaultEntryLabel = "topology";
const entryIDRadix = 36;
const entryIDSliceStart = 2;
const filenameStampPattern = /[-:]|\.\d{3}/g;
const requiredEntryStatsFields = ["traces", "spans", "errors", "error_rate"];

export function createSessionEntry({ kind = defaultEntryKind, topology, settings, result, recordedAt = new Date(), id = "" }) {
  const snapshot = createResultSnapshot({ topology, settings, result, exportedAt: recordedAt });
  return {
    id: id || randomEntryID(),
    recorded_at: snapshot.exported_at,
    kind: normalizeEntryKind(kind),
    label: entryLabel(snapshot.result.topology),
    stats: entryStats(snapshot.result.stats),
    topology: snapshot.topology,
    settings: snapshot.settings,
    result: snapshot.result,
  };
}

export function normalizeSessionEntry(entry) {
  if (!isRecord(entry)) {
    throw new Error("session entry is not an object");
  }
  if (typeof entry.topology !== "string" || !entry.topology.trim()) {
    throw new Error("session entry is missing topology YAML");
  }
  if (!isRecord(entry.stats)) {
    throw new Error("session entry is missing run statistics");
  }
  for (const field of requiredEntryStatsFields) {
    if (!Number.isFinite(Number(entry.stats[field]))) {
      throw new Error(`session entry has invalid ${field} statistics`);
    }
  }
  const normalized = {
    id: typeof entry.id === "string" && entry.id ? entry.id : randomEntryID(),
    recorded_at: typeof entry.recorded_at === "string" ? entry.recorded_at : "",
    kind: normalizeEntryKind(entry.kind),
    label: typeof entry.label === "string" && entry.label ? entry.label : defaultEntryLabel,
    stats: entryStats(entry.stats),
    topology: entry.topology,
    settings: normalizeSnapshotSettings(entry.settings),
    result: null,
  };
  if (entry.result != null) {
    normalized.result = entrySnapshot({ ...normalized, result: entry.result }).result;
  }
  return normalized;
}

export function entryResultSnapshot(entry) {
  if (entry.result == null) return null;
  return entrySnapshot(entry);
}

export function createSessionDocument(entries, savedAt = new Date()) {
  return normalizeSession({
    kind: sessionKind,
    v: sessionVersion,
    saved_at: savedAt instanceof Date ? savedAt.toISOString() : String(savedAt),
    entries,
  });
}

export function normalizeSession(session) {
  if (!isRecord(session)) {
    throw new Error("session file is missing a session object");
  }
  if (session.kind !== sessionKind || session.v !== sessionVersion) {
    throw new Error("session file uses an unsupported format");
  }
  if (!Array.isArray(session.entries)) {
    throw new Error("session file is missing entries");
  }
  return {
    kind: sessionKind,
    v: sessionVersion,
    saved_at: typeof session.saved_at === "string" ? session.saved_at : "",
    entries: session.entries.map((entry) => normalizeSessionEntry(entry)),
  };
}

export function parseSessionFile(text) {
  let session;
  try {
    session = JSON.parse(text);
  } catch {
    throw new Error("session file is not valid JSON");
  }
  return normalizeSession(session);
}

export function sessionFileText(session) {
  return `${JSON.stringify(session, null, 2)}\n`;
}

export function sessionFilename(savedAt) {
  const saved = savedAt instanceof Date ? savedAt : new Date(savedAt ?? Date.now());
  const stampSource = Number.isNaN(saved.valueOf()) ? new Date() : saved;
  const stamp = stampSource.toISOString().replaceAll(filenameStampPattern, "").toLowerCase();
  return `motel-session-${stamp}.json`;
}

export function createSessionStore({ storage, key = sessionStorageKey, limits = defaultSessionLimits, now = () => new Date() } = {}) {
  const bounds = { ...defaultSessionLimits, ...limits };
  let cached = [];

  function load() {
    const raw = readStorage(storage, key);
    if (!raw) {
      cached = [];
      return entries();
    }
    try {
      cached = normalizeSession(JSON.parse(raw)).entries;
    } catch {
      cached = [];
    }
    return entries();
  }

  function entries() {
    return cached.slice();
  }

  function record(entry) {
    return commit([...cached, normalizeSessionEntry(entry)]);
  }

  function remove(id) {
    return commit(cached.filter((entry) => entry.id !== id));
  }

  function replace(nextEntries) {
    return commit(nextEntries.map((entry) => normalizeSessionEntry(entry)));
  }

  function clear() {
    cached = [];
    try {
      storage.removeItem(key);
      return { entries: entries(), persisted: true };
    } catch {
      return { entries: entries(), persisted: false };
    }
  }

  function commit(nextEntries) {
    const limited = applySessionLimits(nextEntries, bounds);
    const outcome = persist(limited);
    cached = outcome.entries;
    return { ...outcome, entries: entries() };
  }

  function persist(limitedEntries) {
    let working = limitedEntries;
    for (;;) {
      try {
        storage.setItem(key, JSON.stringify(createSessionDocument(working, now())));
        return { entries: working, persisted: true };
      } catch {
        const reduced = reduceSessionEntries(working);
        if (!reduced || reduced.length === 0) {
          return { entries: limitedEntries, persisted: false };
        }
        working = reduced;
      }
    }
  }

  return { load, entries, record, remove, replace, clear };
}

export function applySessionLimits(entries, limits = defaultSessionLimits) {
  const bounds = { ...defaultSessionLimits, ...limits };
  let working = entries.slice(Math.max(0, entries.length - bounds.maxEntries));
  working = working.map((entry) => {
    if (entry.result != null && serializedLength(entry.result) > bounds.maxResultChars) {
      return { ...entry, result: null };
    }
    return entry;
  });
  while (working.length && serializedLength(working) > bounds.maxSessionChars) {
    const reduced = reduceSessionEntries(working);
    if (!reduced) break;
    working = reduced;
  }
  return working;
}

function reduceSessionEntries(entries) {
  const oldestWithResult = entries.findIndex((entry) => entry.result != null);
  if (oldestWithResult >= 0) {
    return entries.map((entry, index) => (index === oldestWithResult ? { ...entry, result: null } : entry));
  }
  if (entries.length > 0) {
    return entries.slice(1);
  }
  return null;
}

function entrySnapshot(entry) {
  return normalizeResultSnapshot({
    kind: resultSnapshotKind,
    v: resultSnapshotVersion,
    exported_at: entry.recorded_at,
    topology: entry.topology,
    settings: entry.settings,
    result: entry.result,
  });
}

function entryLabel(analyzedTopology) {
  const services = analyzedTopology?.services ?? [];
  const primary = rootService(analyzedTopology) || services[0]?.name;
  if (!primary) return defaultEntryLabel;
  return services.length > 1 ? `${primary} · ${services.length} services` : primary;
}

function rootService(analyzedTopology) {
  const root = analyzedTopology?.roots?.[0];
  if (typeof root !== "string" || !root) return "";
  return root.split(".")[0];
}

function entryStats(stats) {
  return {
    traces: Number(stats.traces),
    spans: Number(stats.spans),
    errors: Number(stats.errors),
    error_rate: Number(stats.error_rate),
  };
}

function normalizeEntryKind(kind) {
  return sessionEntryKinds.includes(kind) ? kind : defaultEntryKind;
}

function randomEntryID() {
  return `${Date.now().toString(entryIDRadix)}${Math.random().toString(entryIDRadix).slice(entryIDSliceStart)}`;
}

function serializedLength(value) {
  return JSON.stringify(value).length;
}

function readStorage(storage, key) {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
