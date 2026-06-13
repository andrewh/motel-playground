(function () {
  const NODE_W = 128;
  const NODE_H = 38;
  const CELL_W = 206;
  const CELL_H = 92;
  const CHANNEL_GAP = 10;
  const CORNER_R = 10;

  let sketch = null;

  window.renderP5Map = function renderP5Map(container, graph, spans) {
    if (!window.p5) {
      renderFallback(container, graph, spans);
      return;
    }
    if (sketch) {
      sketch.remove();
      sketch = null;
    }
    container.innerHTML = "";
    container.classList.add("p5-map");
    sketch = new p5((p) => createSketch(p, container, graph, spans), container);
  };

  function createSketch(p, container, graph, spans) {
    const stats = serviceStats(spans);
    let nodes = [];
    let edges = [];
    let hovered = null;
    let cellW = CELL_W;
    let cellH = CELL_H;
    let nodeW = NODE_W;
    let nodeH = NODE_H;
    let gridX0 = 0;
    let gridY0 = 0;
    let palette = null;

    p.setup = () => {
      const size = canvasSize(container);
      p.createCanvas(size.width, size.height);
      palette = readPalette(container);
      p.textFont(palette.font);

      const nodeByID = {};
      nodes = graph.nodes.map((node) => {
        const copy = { ...node, px: 0, py: 0 };
        nodeByID[node.id] = copy;
        return copy;
      });
      edges = graph.edges.map((edge) => ({
        ...edge,
        from: nodeByID[edge.source],
        to: nodeByID[edge.target],
        path: null,
      }));
      placeNodes();
    };

    p.windowResized = () => {
      const size = canvasSize(container);
      p.resizeCanvas(size.width, size.height);
      placeNodes();
    };

    p.draw = () => {
      p.background(palette.surface);
      hovered = nodeAt(p.mouseX, p.mouseY);
      container.style.cursor = hovered ? "pointer" : "default";
      for (const edge of edges) drawEdge(edge);
      if (spans.length) for (const edge of edges) drawPulses(edge);
      for (const node of nodes) drawNode(node);
      if (hovered) drawTooltip(hovered);
    };

    function placeNodes() {
      const cols = Math.max(graph.gridCols - 1, 1);
      const rows = Math.max(graph.gridRows - 1, 1);
      const marginX = p.width < 560 ? 52 : 90;
      const marginY = p.height < 380 ? 46 : 68;
      const scale = Math.min(
        1,
        Math.max(0.42, (p.width - marginX * 2) / Math.max(cols * CELL_W, 1)),
        Math.max(0.48, (p.height - marginY * 2) / Math.max(rows * CELL_H, 1)),
      );
      cellW = CELL_W * scale;
      cellH = CELL_H * scale;
      nodeW = Math.min(NODE_W, Math.max(72, cellW - 34));
      nodeH = Math.min(NODE_H, Math.max(30, cellH - 28));
      gridX0 = (p.width - (graph.gridCols - 1) * cellW) / 2;
      gridY0 = (p.height - (graph.gridRows - 1) * cellH) / 2;
      for (const node of nodes) {
        node.px = gridX0 + node.col * cellW;
        node.py = gridY0 + node.row * cellH;
      }
      buildEdgePaths();
    }

    function buildEdgePaths() {
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
      const channelSpan = (key) => (key[0] === "v" || key[0] === "r" ? cellW - nodeW - 8 : cellH - nodeH - 8);
      const offset = (key) => {
        claimed[key] = (claimed[key] || 0) + 1;
        const step = Math.min(CHANNEL_GAP, channelSpan(key) / Math.max(counts[key], 1));
        return (claimed[key] - 1 - (counts[key] - 1) / 2) * step;
      };
      const gapX = (col) => gridX0 + (col - 0.5) * cellW;

      edges.forEach((edge, index) => {
        const spec = specs[index];
        if (spec.kind === "self") {
          edge.path = null;
          return;
        }
        const s = edge.from;
        const t = edge.to;
        const exitR = s.px + nodeW / 2;
        const entryL = t.px - nodeW / 2;
        const entryR = t.px + nodeW / 2;
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
          const laneY = gridY0 + (laneRow - 0.5) * cellH + offset(`lane${laneRow}`);
          const x2 = gapX(t.col) + offset(`v${t.col}`);
          pts = [[exitR, s.py], [x1, s.py], [x1, laneY], [x2, laneY], [x2, t.py], [entryL, t.py]];
        } else if (spec.kind === "same") {
          const x = Math.max(s.px, t.px) + nodeW / 2 + 24 + offset(`r${s.col}`);
          pts = [[exitR, s.py], [x, s.py], [x, t.py], [entryR, t.py]];
        } else {
          const x = gapX(t.col) + offset(`v${t.col}`);
          const laneY = gridY0 + (graph.gridRows - 0.5) * cellH + offset("bottom");
          pts = [[s.px, s.py + nodeH / 2], [s.px, laneY], [x, laneY], [x, t.py], [entryL, t.py]];
        }
        edge.path = makePath(pts);
      });
    }

    function drawEdge(edge) {
      const active = hovered && (edge.from === hovered || edge.to === hovered);
      const width = edgeWidth(edge.weight);
      p.stroke(active ? palette.warn : palette.edge);
      p.strokeWeight(width);
      p.noFill();
      if (edge.async) p.drawingContext.setLineDash([6, 6]);
      if (edge.from === edge.to) {
        p.arc(edge.from.px, edge.from.py - nodeH / 2, 50, 50, p.PI * 0.9, p.PI * 2.1);
      } else {
        const pts = edge.path.pts;
        const ctx = p.drawingContext;
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length - 1; i++) {
          ctx.arcTo(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], CORNER_R);
        }
        ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
        ctx.stroke();
        drawArrow(pts[pts.length - 1], pts[pts.length - 2], width, active);
      }
      p.drawingContext.setLineDash([]);
    }

    function drawArrow(point, from, width, active) {
      const angle = Math.atan2(point[1] - from[1], point[0] - from[0]);
      const size = 7 + width;
      p.push();
      p.translate(point[0], point[1]);
      p.rotate(angle);
      p.noStroke();
      p.fill(active ? palette.warn : palette.edge);
      p.triangle(0, 0, -size, -size / 2.2, -size, size / 2.2);
      p.pop();
    }

    function drawPulses(edge) {
      if (!edge.path || edge.from === edge.to) return;
      const targetStats = stats.get(edge.target) || { spans: 0, errors: 0, rate: 0 };
      if (targetStats.rate <= 0) return;
      const count = p.constrain(Math.round(Math.sqrt(targetStats.rate)), 1, 6);
      const errorLevel = p.constrain(targetStats.spans ? (targetStats.errors / targetStats.spans) * 3 : 0, 0, 1);
      const fill = p.lerpColor(p.color(palette.accent), p.color(palette.danger), errorLevel);
      p.noStroke();
      p.fill(fill);
      for (let i = 0; i < count; i++) {
        const position = ((p.millis() / 1000) * 0.55 + i / count) % 1;
        const point = pointOnPath(edge.path, position);
        p.circle(point.x, point.y, 5 + edgeWidth(edge.weight) / 2);
      }
    }

    function drawNode(node) {
      const nodeStats = stats.get(node.id) || { spans: 0, errors: 0, rate: 0 };
      const errorLevel = p.constrain(nodeStats.spans ? (nodeStats.errors / nodeStats.spans) * 3 : 0, 0, 1);
      const strokeColor = p.lerpColor(p.color(node.isRoot ? palette.accentStrong : palette.edgeStrong), p.color(palette.danger), errorLevel);
      p.stroke(strokeColor);
      p.strokeWeight(node === hovered ? 2.4 : 1.4);
      p.fill(node.isRoot ? palette.accentSoft : palette.node);
      p.rectMode(p.CENTER);
      p.rect(node.px, node.py, nodeW, nodeH, 7);
      p.noStroke();
      p.fill(palette.ink);
      p.textAlign(p.CENTER, p.CENTER);
      p.textStyle(node.isRoot ? p.BOLD : p.NORMAL);
      p.textSize(Math.max(9, Math.min(12, nodeW / 9)));
      p.text(node.id, node.px, node.py - (spans.length ? 7 : 0), nodeW - 10, nodeH / 2);
      if (spans.length && nodeW >= 86) {
        p.textStyle(p.NORMAL);
        p.textSize(9);
        p.fill(errorLevel > 0 ? strokeColor : palette.muted);
        p.text(`${nodeStats.rate.toFixed(1)}/s · ${nodeStats.errors} err`, node.px, node.py + 9);
      }
      p.textStyle(p.NORMAL);
    }

    function drawTooltip(node) {
      const lines = [node.id + (node.isRoot ? "  entry" : "")];
      const nodeStats = stats.get(node.id);
      if (nodeStats) lines.push(`  ${nodeStats.spans} spans, ${nodeStats.errors} errors`);
      for (const operation of node.operations) lines.push(`  ${operation}`);
      for (const edge of edges) {
        if (edge.from !== node) continue;
        for (const call of edge.calls) {
          const mods = [];
          if (call.probability < 1) mods.push(`${Math.round(call.probability * 100)}%`);
          if (call.count > 1) mods.push(`x${call.count}`);
          if (call.async) mods.push("async");
          lines.push(`  ${call.from} -> ${edge.target}.${call.to}${mods.length ? ` [${mods.join(", ")}]` : ""}`);
        }
      }
      p.textSize(11);
      let boxW = 0;
      for (const line of lines) boxW = Math.max(boxW, p.textWidth(line));
      boxW += 22;
      const boxH = lines.length * 16 + 12;
      const tx = p.constrain(node.px + nodeW / 2 + 10, 4, p.width - boxW - 4);
      const ty = p.constrain(node.py - boxH / 2, 4, p.height - boxH - 4);
      p.rectMode(p.CORNER);
      p.stroke(palette.line);
      p.strokeWeight(1);
      p.fill(palette.tooltip);
      p.rect(tx, ty, boxW, boxH, 6);
      p.noStroke();
      p.textAlign(p.LEFT, p.TOP);
      lines.forEach((line, index) => {
        p.fill(index === 0 ? palette.ink : palette.muted);
        p.textStyle(index === 0 ? p.BOLD : p.NORMAL);
        p.text(line, tx + 10, ty + 8 + index * 16);
      });
      p.textStyle(p.NORMAL);
    }

    function nodeAt(x, y) {
      for (let i = nodes.length - 1; i >= 0; i--) {
        const node = nodes[i];
        if (Math.abs(x - node.px) <= nodeW / 2 && Math.abs(y - node.py) <= nodeH / 2) return node;
      }
      return null;
    }
  }

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

  function canvasSize(container) {
    const rect = container.getBoundingClientRect();
    return {
      width: Math.max(320, Math.floor(rect.width || 640)),
      height: Math.max(360, Math.floor(rect.height || 480)),
    };
  }

  function edgeWidth(weight) {
    return 1 + 2.5 * Math.log(1 + weight);
  }

  function readPalette(container) {
    const style = getComputedStyle(container);
    const value = (name, fallback) => resolveColor(style.getPropertyValue(name).trim() || fallback);
    return {
      font: style.getPropertyValue("--font-ui").trim() || "Avenir Next, Segoe UI, system-ui, sans-serif",
      surface: value("--surface", "#fafafa"),
      node: value("--surface-raised", "#f4f4f4"),
      tooltip: value("--surface", "#fafafa"),
      ink: value("--ink", "#2e2e2e"),
      muted: value("--muted", "#747474"),
      line: value("--line", "#d1d1d1"),
      edge: value("--line-strong", "#9a9a9a"),
      edgeStrong: value("--muted-strong", "#555555"),
      accent: value("--accent", "#4b4b4b"),
      accentStrong: value("--accent-strong", "#2e2e2e"),
      accentSoft: value("--accent-soft", "#dddddd"),
      warn: value("--warn", "#666666"),
      danger: value("--danger", "#5c5c5c"),
    };
  }

  function resolveColor(color) {
    const probe = document.createElement("span");
    probe.style.color = color;
    probe.style.position = "absolute";
    probe.style.visibility = "hidden";
    document.body.appendChild(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    return resolved || color;
  }

  function makePath(rawPts) {
    const pts = [rawPts[0]];
    for (const point of rawPts.slice(1)) {
      const last = pts[pts.length - 1];
      if (Math.abs(point[0] - last[0]) > 0.01 || Math.abs(point[1] - last[1]) > 0.01) pts.push(point);
    }
    const lens = [0];
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      lens.push(total);
    }
    return { pts, lens, total };
  }

  function pointOnPath(path, t) {
    const distance = t * path.total;
    let i = 1;
    while (i < path.lens.length - 1 && path.lens[i] < distance) i++;
    const segmentLength = path.lens[i] - path.lens[i - 1] || 1;
    const f = (distance - path.lens[i - 1]) / segmentLength;
    const a = path.pts[i - 1];
    const b = path.pts[i];
    return { x: a[0] + (b[0] - a[0]) * f, y: a[1] + (b[1] - a[1]) * f };
  }

  function renderFallback(container, graph, spans) {
    const counts = serviceStats(spans);
    container.classList.remove("p5-map");
    container.innerHTML = graph.nodes.map((node) => {
      const item = counts.get(node.id) || { spans: 0, errors: 0 };
      return `<section class="service-node"><div><strong>${escapeHtml(node.id)}</strong><span>${item.spans} spans</span></div><ol>${node.operations.map((op) => `<li><span>${escapeHtml(op)}</span></li>`).join("")}</ol></section>`;
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
