export const tourStorageKey = "motel-playground-tour-v1";
export const tourSeenValue = "seen";
export const tourPlacements = Object.freeze(["bottom", "top"]);
export const tourTooltipGap = 12;
export const tourViewportMargin = 12;

const firstStepIndex = 0;
const inactiveStepIndex = -1;
const stepAdvance = 1;

export const tourSteps = Object.freeze([
  {
    id: "editor",
    target: ".editor-pane .pane-head",
    title: "Topology YAML",
    body: "Edit services, operations, calls, and traffic in the editor below. Validate checks the YAML before a run, and Random topology generates a fresh one.",
    placement: "bottom",
  },
  {
    id: "settings",
    target: ".control-row-primary",
    title: "Run settings",
    body: "Duration bounds each run, the seed makes it reproducible, and Signals chooses which telemetry is emitted.",
    placement: "bottom",
  },
  {
    id: "run",
    target: "#run-button",
    title: "Run topology",
    body: "Emits traces, metrics, and logs for the configured duration. Cmd/Ctrl+Enter runs when focus is outside a field.",
    placement: "bottom",
  },
  {
    id: "views",
    target: ".tabs",
    title: "Result views",
    body: "Traffic forecasts load, Spans shows the waterfall, Metrics and Logs list signals, Map draws the service graph, Raw holds JSON, and History keeps past runs. Keys 1 to 7 switch views.",
    placement: "bottom",
  },
  {
    id: "filter",
    target: ".filter-field",
    title: "Filter output",
    body: "Narrows spans, metrics, and logs by service, attribute, or trace. Cmd/Ctrl+K or / focuses it.",
    placement: "bottom",
  },
  {
    id: "import",
    target: ".trace-import-head",
    title: "Import traces",
    body: "Load or drop OTLP JSON or stdouttrace JSONL to infer a topology, or replay the traces exactly as recorded.",
    placement: "bottom",
  },
  {
    id: "share",
    target: "#share-button",
    title: "Share",
    body: "Copy link encodes the topology and run settings in the URL. Save downloads the YAML.",
    placement: "bottom",
  },
  {
    id: "help",
    target: "#shortcut-help-button",
    title: "Help",
    body: "Lists keyboard shortcuts and restarts this tour.",
    placement: "bottom",
  },
]);

export function createTour({ steps = tourSteps, storage = null } = {}) {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error("tour requires at least one step");
  }
  let index = inactiveStepIndex;
  let memorySeen = false;

  function readSeen() {
    if (memorySeen) return true;
    try {
      return storage?.getItem(tourStorageKey) === tourSeenValue;
    } catch {
      return false;
    }
  }

  function markSeen() {
    memorySeen = true;
    try {
      storage?.setItem(tourStorageKey, tourSeenValue);
    } catch {
      return false;
    }
    return true;
  }

  function reset() {
    memorySeen = false;
    try {
      storage?.removeItem(tourStorageKey);
    } catch {
      return false;
    }
    return true;
  }

  function clampIndex(value) {
    return Math.max(firstStepIndex, Math.min(steps.length - 1, Math.floor(Number(value) || firstStepIndex)));
  }

  return {
    steps,
    get active() {
      return index !== inactiveStepIndex;
    },
    get index() {
      return index;
    },
    get step() {
      return index === inactiveStepIndex ? null : steps[index];
    },
    get isFirst() {
      return index === firstStepIndex;
    },
    get isLast() {
      return index === steps.length - 1;
    },
    get progress() {
      return index === inactiveStepIndex ? "" : `${index + 1} of ${steps.length}`;
    },
    seen: readSeen,
    markSeen,
    reset,
    shouldAutoStart: () => !readSeen(),
    start(at = firstStepIndex) {
      index = clampIndex(at);
      markSeen();
      return steps[index];
    },
    next() {
      if (index === inactiveStepIndex) return null;
      if (index === steps.length - 1) {
        index = inactiveStepIndex;
        return null;
      }
      index += stepAdvance;
      return steps[index];
    },
    back() {
      if (index <= firstStepIndex) return this.step;
      index -= stepAdvance;
      return steps[index];
    },
    finish() {
      index = inactiveStepIndex;
      return markSeen();
    },
  };
}

export function placeTooltip({
  target,
  tooltip,
  viewport,
  placement = tourPlacements[0],
  gap = tourTooltipGap,
  margin = tourViewportMargin,
}) {
  const preferred = tourPlacements.includes(placement) ? placement : tourPlacements[0];
  const spaceBelow = viewport.height - target.bottom - gap - margin;
  const spaceAbove = target.top - gap - margin;
  let resolved = preferred;
  if (preferred === "bottom" && tooltip.height > spaceBelow && spaceAbove > spaceBelow) {
    resolved = "top";
  } else if (preferred === "top" && tooltip.height > spaceAbove && spaceBelow > spaceAbove) {
    resolved = "bottom";
  }

  const maxTop = Math.max(margin, viewport.height - tooltip.height - margin);
  const rawTop = resolved === "bottom" ? target.bottom + gap : target.top - gap - tooltip.height;
  const top = Math.min(maxTop, Math.max(margin, rawTop));

  const maxLeft = Math.max(margin, viewport.width - tooltip.width - margin);
  const left = Math.min(maxLeft, Math.max(margin, target.left));

  return { left: Math.round(left), top: Math.round(top), placement: resolved };
}
