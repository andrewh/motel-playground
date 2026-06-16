(function () {
  const NODE_W = 128;
  const NODE_H = 38;
  const CELL_W = 206;
  const CELL_H = 92;
  const CHANNEL_GAP = 10;
  const CORNER_R = 10;
  const VIEW_PAD = 16;
  const SELF_LOOP_R = 25;

  // Render the service topology as an inline SVG. The grid placement and
  // orthogonal edge routing are computed in a fixed coordinate space; the SVG
  // viewBox then scales the whole thing to fit its container, so there is no
  // canvas to resize or repaint.
  window.renderServiceMap = function renderServiceMap(container, graph, spans) {
    try {
      drawMap(container, graph, spans || []);
    } catch (error) {
      console.warn("SVG map failed; falling back to HTML map", error);
      renderFallback(container, graph, spans || []);
    }
  };

  window.clearServiceMap = function clearServiceMap(container, message) {
    container.classList.remove("graph-map");
    container.innerHTML = `<p class="empty">${escapeHtml(message || "No service map available.")}</p>`;
  };

  function drawMap(container, graph, spans) {
    if (!graph || !graph.nodes || !graph.nodes.length) {
      renderFallback(container, graph, spans);
      return;
    }
    const stats = serviceStats(spans);
    const hasSpans = spans.length > 0;
    const gridCols = Math.max(graph.gridCols || 1, ...graph.nodes.map((node) => node.col + 1));
    const gridRows = Math.max(graph.gridRows || 1, ...graph.nodes.map((node) => node.row + 1));

    const nodeByID = {};
    const nodes = graph.nodes.map((node) => {
      const placed = {
        ...node,
        px: NODE_W / 2 + node.col * CELL_W,
        py: NODE_H / 2 + node.row * CELL_H,
      };
      nodeByID[node.id] = placed;
      return placed;
    });
    const edges = (graph.edges ?? []).map((edge) => ({
      ...edge,
      from: nodeByID[edge.source],
      to: nodeByID[edge.target],
    })).filter((edge) => edge.from && edge.to);

    routeEdges(edges, gridCols, gridRows);

    const extent = boundsOf(nodes, edges);
    const viewW = extent.maxX - extent.minX;
    const viewH = extent.maxY - extent.minY;

    const edgeMarkup = edges.map((edge, index) => edgeMarkup_(edge, index)).join("");
    const nodeMarkup = nodes.map((node) => nodeMarkup_(node, stats.get(node.id), hasSpans)).join("");
    const svg = `<svg class="graph-svg" viewBox="${num(extent.minX)} ${num(extent.minY)} ${num(viewW)} ${num(viewH)}" role="img" aria-label="Service topology map" preserveAspectRatio="xMidYMid meet">
      <g class="graph-edges">${edgeMarkup}</g>
      <g class="graph-nodes">${nodeMarkup}</g>
    </svg>`;

    container.classList.add("graph-map");
    container.innerHTML = `${svg}${edges.length ? lineKeyMarkup() : ""}<div class="graph-tooltip" role="tooltip" hidden></div>`;

    bindInteractions(container, nodes, edges, stats);
  }

  // --- layout / routing -----------------------------------------------------

  function routeEdges(edges, gridCols, gridRows) {
    const gridX0 = NODE_W / 2;
    const gridY0 = NODE_H / 2;
    const specs = edges.map((edge) => {
      if (edge.from === edge.to) return { kind: "self", keys: [] };
      const sc = edge.from.col;
      const tc = edge.to.col;
      if (tc > sc) {
        if (tc - sc === 1) return { kind: "fwd", keys: edge.from.row === edge.to.row ? [] : [`v${tc}`] };
        return { kind: "long", keys: [`v${sc + 1}`, `lane${Math.min(edge.from.row, edge.to.row)}`, `v${tc}`] };
      }
      if (tc === sc) return { kind: "same", keys: [`r${sc}`] };
      return { kind: "back", keys: [`v${tc}`, "bottom"] };
    });

    const counts = {};
    const claimed = {};
    for (const spec of specs) {
      for (const key of spec.keys) counts[key] = (counts[key] || 0) + 1;
    }
    const channelSpan = (key) => (key[0] === "v" || key[0] === "r" ? CELL_W - NODE_W - 8 : CELL_H - NODE_H - 8);
    const offset = (key) => {
      claimed[key] = (claimed[key] || 0) + 1;
      const step = Math.min(CHANNEL_GAP, channelSpan(key) / Math.max(counts[key], 1));
      return (claimed[key] - 1 - (counts[key] - 1) / 2) * step;
    };
    const gapX = (col) => gridX0 + (col - 0.5) * CELL_W;

    edges.forEach((edge, index) => {
      const spec = specs[index];
      edge.kind = spec.kind;
      if (spec.kind === "self") {
        edge.pts = null;
        return;
      }
      const s = edge.from;
      const t = edge.to;
      const exitR = s.px + NODE_W / 2;
      const entryL = t.px - NODE_W / 2;
      const entryR = t.px + NODE_W / 2;
      let pts;
      if (spec.kind === "fwd") {
        if (s.row === t.row) {
          pts = [[exitR, s.py], [entryL, t.py]];
        } else {
          const x = gapX(t.col) + offset(`v${t.col}`);
          pts = [[exitR, s.py], [x, s.py], [x, t.py], [entryL, t.py]];
        }
      } else if (spec.kind === "long") {
        const x1 = gapX(s.col + 1) + offset(`v${s.col + 1}`);
        const laneRow = Math.min(s.row, t.row);
        const laneY = gridY0 + (laneRow - 0.5) * CELL_H + offset(`lane${laneRow}`);
        const x2 = gapX(t.col) + offset(`v${t.col}`);
        pts = [[exitR, s.py], [x1, s.py], [x1, laneY], [x2, laneY], [x2, t.py], [entryL, t.py]];
      } else if (spec.kind === "same") {
        const x = Math.max(s.px, t.px) + NODE_W / 2 + 24 + offset(`r${s.col}`);
        pts = [[exitR, s.py], [x, s.py], [x, t.py], [entryR, t.py]];
      } else {
        const x = gapX(t.col) + offset(`v${t.col}`);
        const laneY = gridY0 + (gridRows - 0.5) * CELL_H + offset("bottom");
        pts = [[s.px, s.py + NODE_H / 2], [s.px, laneY], [x, laneY], [x, t.py], [entryL, t.py]];
      }
      edge.pts = dedupePoints(pts);
    });
  }

  function boundsOf(nodes, edges) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const include = (x, y) => {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    };
    for (const node of nodes) {
      include(node.px - NODE_W / 2, node.py - NODE_H / 2);
      include(node.px + NODE_W / 2, node.py + NODE_H / 2);
    }
    for (const edge of edges) {
      if (edge.kind === "self") {
        include(edge.from.px - SELF_LOOP_R, edge.from.py - NODE_H / 2 - SELF_LOOP_R);
        include(edge.from.px + SELF_LOOP_R, edge.from.py - NODE_H / 2 + SELF_LOOP_R);
        continue;
      }
      for (const [x, y] of edge.pts ?? []) include(x, y);
    }
    return {
      minX: minX - VIEW_PAD,
      minY: minY - VIEW_PAD,
      maxX: maxX + VIEW_PAD,
      maxY: maxY + VIEW_PAD,
    };
  }

  // --- markup ---------------------------------------------------------------

  function edgeMarkup_(edge, index) {
    const width = edgeWidth(edge.weight);
    const cls = `graph-edge${edge.async ? " graph-edge-async" : ""}`;
    const data = `data-edge="${index}" data-source="${escapeHtml(edge.source)}" data-target="${escapeHtml(edge.target)}"`;
    if (edge.kind === "self") {
      const cx = edge.from.px;
      const cy = edge.from.py - NODE_H / 2;
      const start = [cx + SELF_LOOP_R * Math.cos(Math.PI * 0.9), cy + SELF_LOOP_R * Math.sin(Math.PI * 0.9)];
      const end = [cx + SELF_LOOP_R * Math.cos(Math.PI * 2.1), cy + SELF_LOOP_R * Math.sin(Math.PI * 2.1)];
      return `<path class="${cls}" ${data} style="stroke-width:${num(width)}" fill="none" d="M ${num(start[0])} ${num(start[1])} A ${SELF_LOOP_R} ${SELF_LOOP_R} 0 1 1 ${num(end[0])} ${num(end[1])}"></path>`;
    }
    const pts = edge.pts;
    const d = roundedPathD(pts, CORNER_R);
    const arrow = arrowPoints(pts[pts.length - 1], pts[pts.length - 2], width);
    return `<path class="${cls}" ${data} style="stroke-width:${num(width)}" fill="none" d="${d}"></path>`
      + `<polygon class="graph-arrow" data-edge="${index}" data-source="${escapeHtml(edge.source)}" data-target="${escapeHtml(edge.target)}" points="${arrow}"></polygon>`;
  }

  function nodeMarkup_(node, nodeStats, hasSpans) {
    const stats = nodeStats || { spans: 0, errors: 0, rate: 0 };
    const errorLevel = clamp(stats.spans ? (stats.errors / stats.spans) * 3 : 0, 0, 1);
    const cls = `graph-node${node.isRoot ? " graph-node-root" : ""}`;
    const showStats = hasSpans;
    const label = truncate(node.id, 18);
    const labelY = showStats ? node.py - 5 : node.py;
    const statsText = `${(stats.rate || 0).toFixed(1)}/s · ${stats.errors} err`;
    return `<g class="${cls}" data-id="${escapeHtml(node.id)}" style="--err:${num(errorLevel)}" tabindex="0">
      <rect x="${num(node.px - NODE_W / 2)}" y="${num(node.py - NODE_H / 2)}" width="${NODE_W}" height="${NODE_H}" rx="7"></rect>
      <text class="graph-node-label" x="${num(node.px)}" y="${num(labelY)}" text-anchor="middle" dominant-baseline="central">${escapeHtml(label)}</text>
      ${showStats ? `<text class="graph-node-stats" x="${num(node.px)}" y="${num(node.py + 10)}" text-anchor="middle" dominant-baseline="central">${escapeHtml(statsText)}</text>` : ""}
    </g>`;
  }

  function lineKeyMarkup() {
    const sample = (extra) => `<svg viewBox="0 0 40 8" width="40" height="8" aria-hidden="true"><line x1="1" y1="4" x2="30" y2="4" class="graph-edge${extra}"></line><polygon points="38,4 30,1.5 30,6.5" class="graph-arrow"></polygon></svg>`;
    return `<div class="graph-key" aria-hidden="true">
      <span class="graph-key-title">line key</span>
      <span class="graph-key-row">${sample("")} sync call</span>
      <span class="graph-key-row">${sample(" graph-edge-async")} async call</span>
      <span class="graph-key-row"><svg viewBox="0 0 40 8" width="40" height="8" aria-hidden="true"><line x1="1" y1="4" x2="30" y2="4" class="graph-edge" style="stroke-width:4"></line><polygon points="38,4 30,1.5 30,6.5" class="graph-arrow"></polygon></svg> more calls</span>
    </div>`;
  }

  // --- interaction ----------------------------------------------------------

  function bindInteractions(container, nodes, edges, stats) {
    const tooltip = container.querySelector(".graph-tooltip");
    const nodeEls = container.querySelectorAll(".graph-node");
    const edgeEls = container.querySelectorAll("[data-edge]");
    const nodeByID = new Map(nodes.map((node) => [node.id, node]));

    const activate = (id, anchor) => {
      for (const el of edgeEls) {
        const active = el.getAttribute("data-source") === id || el.getAttribute("data-target") === id;
        el.classList.toggle("is-active", active);
      }
      const node = nodeByID.get(id);
      if (node && tooltip) showTooltip(tooltip, container, anchor, node, edges, stats);
    };
    const deactivate = () => {
      for (const el of edgeEls) el.classList.remove("is-active");
      if (tooltip) tooltip.hidden = true;
    };

    for (const el of nodeEls) {
      const id = el.getAttribute("data-id");
      const anchor = el.querySelector("rect");
      el.addEventListener("pointerenter", () => activate(id, anchor));
      el.addEventListener("pointerleave", deactivate);
      el.addEventListener("focus", () => activate(id, anchor));
      el.addEventListener("blur", deactivate);
    }
  }

  function showTooltip(tooltip, container, anchor, node, edges, stats) {
    const lines = [`<strong>${escapeHtml(node.id)}${node.isRoot ? " · entry" : ""}</strong>`];
    const nodeStats = stats.get(node.id);
    if (nodeStats) lines.push(`<span>${nodeStats.spans} spans, ${nodeStats.errors} errors</span>`);
    for (const operation of node.operations ?? []) lines.push(`<span>${escapeHtml(operation)}</span>`);
    for (const edge of edges) {
      if (edge.from !== node) continue;
      for (const call of edge.calls ?? []) {
        const mods = [];
        if (call.probability < 1) mods.push(`${Math.round(call.probability * 100)}%`);
        if (call.count > 1) mods.push(`x${call.count}`);
        if (call.async) mods.push("async");
        lines.push(`<span class="graph-tooltip-call">${escapeHtml(`${call.from} -> ${edge.target}.${call.to}`)}${mods.length ? ` [${escapeHtml(mods.join(", "))}]` : ""}</span>`);
      }
    }
    tooltip.innerHTML = lines.join("");
    tooltip.hidden = false;
    if (!anchor || !anchor.getBoundingClientRect) return;
    const anchorRect = anchor.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const margin = 8;
    let left = anchorRect.right - containerRect.left + 10;
    let top = anchorRect.top - containerRect.top;
    if (left + tooltip.offsetWidth + margin > container.clientWidth) {
      left = anchorRect.left - containerRect.left - tooltip.offsetWidth - 10;
    }
    left = Math.max(margin, Math.min(left, container.clientWidth - tooltip.offsetWidth - margin));
    top = Math.max(margin, Math.min(top, container.clientHeight - tooltip.offsetHeight - margin));
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }

  // --- geometry helpers -----------------------------------------------------

  function roundedPathD(pts, r) {
    if (pts.length < 2) return "";
    if (pts.length === 2) return `M ${num(pts[0][0])} ${num(pts[0][1])} L ${num(pts[1][0])} ${num(pts[1][1])}`;
    let d = `M ${num(pts[0][0])} ${num(pts[0][1])}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const prev = pts[i - 1];
      const corner = pts[i];
      const next = pts[i + 1];
      const into = unit(corner, prev);
      const out = unit(corner, next);
      const d1 = Math.min(r, dist(prev, corner) / 2);
      const d2 = Math.min(r, dist(corner, next) / 2);
      const a = [corner[0] + into[0] * d1, corner[1] + into[1] * d1];
      const b = [corner[0] + out[0] * d2, corner[1] + out[1] * d2];
      d += ` L ${num(a[0])} ${num(a[1])} Q ${num(corner[0])} ${num(corner[1])} ${num(b[0])} ${num(b[1])}`;
    }
    const last = pts[pts.length - 1];
    d += ` L ${num(last[0])} ${num(last[1])}`;
    return d;
  }

  function arrowPoints(tip, prev, width) {
    const angle = Math.atan2(tip[1] - prev[1], tip[0] - prev[0]);
    const size = 7 + width;
    return [[0, 0], [-size, -size / 2.2], [-size, size / 2.2]]
      .map(([x, y]) => [
        tip[0] + x * Math.cos(angle) - y * Math.sin(angle),
        tip[1] + x * Math.sin(angle) + y * Math.cos(angle),
      ])
      .map(([x, y]) => `${num(x)},${num(y)}`)
      .join(" ");
  }

  function dedupePoints(rawPts) {
    const pts = [rawPts[0]];
    for (const point of rawPts.slice(1)) {
      const last = pts[pts.length - 1];
      if (Math.abs(point[0] - last[0]) > 0.01 || Math.abs(point[1] - last[1]) > 0.01) pts.push(point);
    }
    return pts;
  }

  function unit(from, to) {
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    const length = Math.hypot(dx, dy) || 1;
    return [dx / length, dy / length];
  }

  function dist(a, b) {
    return Math.hypot(b[0] - a[0], b[1] - a[1]);
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function num(value) {
    return Math.round(value * 100) / 100;
  }

  function truncate(value, max) {
    const text = String(value);
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }

  // --- shared ---------------------------------------------------------------

  function serviceStats(spans) {
    const stats = new Map();
    if (!spans.length) return stats;
    let minTs = Infinity;
    let maxTs = -Infinity;
    for (const span of spans) {
      minTs = Math.min(minTs, span.timestamp_ms);
      maxTs = Math.max(maxTs, span.timestamp_ms);
      const item = stats.get(span.service) || { spans: 0, errors: 0, rate: 0 };
      item.spans += 1;
      if (span.is_error) item.errors += 1;
      stats.set(span.service, item);
    }
    const seconds = Math.max((maxTs - minTs) / 1000, 1);
    for (const item of stats.values()) item.rate = item.spans / seconds;
    return stats;
  }

  function edgeWidth(weight) {
    return 1 + 2.5 * Math.log(1 + (Number(weight) || 0));
  }

  function renderFallback(container, graph, spans) {
    const counts = serviceStats(spans || []);
    container.classList.remove("graph-map");
    const nodes = graph?.nodes ?? [];
    if (!nodes.length) {
      container.innerHTML = `<p class="empty">No service map available.</p>`;
      return;
    }
    container.innerHTML = nodes.map((node) => {
      const item = counts.get(node.id) || { spans: 0, errors: 0 };
      return `<section class="service-node"><div><strong>${escapeHtml(node.id)}</strong><span>${item.spans} spans</span></div><ol>${(node.operations ?? []).map((op) => `<li><span>${escapeHtml(op)}</span></li>`).join("")}</ol></section>`;
    }).join("");
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }
})();
