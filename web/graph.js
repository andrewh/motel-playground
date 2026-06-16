(function () {
  const NODE_W = 128;
  const NODE_H = 38;
  const CELL_W = 206;
  const CELL_H = 92;
  const VIEW_PAD = 28;
  const SELF_LOOP_R = 22;
  const ZOOM_MIN = 0.3;
  const ZOOM_MAX = 4;
  const ARROW_MARKER_LENGTH = 6;
  const ARROW_MARKER_HALF_HEIGHT = 3;
  const ARROW_MARKER_SIZE = 5;
  const KEY_ARROW_VIEWBOX_WIDTH = 40;
  const KEY_ARROW_VIEWBOX_HEIGHT = 8;
  const KEY_ARROW_LINE_START_X = 1;
  const KEY_ARROW_TIP_X = 36;
  const KEY_ARROW_BASE_X = 30;
  const KEY_ARROW_CENTER_Y = 4;
  const KEY_ARROW_HALF_HEIGHT = 2;

  // Render the service topology as a d3-driven SVG network graph. Nodes keep the
  // layered col/row placement computed server-side; d3 handles the DOM join,
  // link curves (d3-shape), and pan/zoom (d3-zoom).
  window.renderServiceMap = function renderServiceMap(container, graph, spans) {
    try {
      if (!window.d3) {
        renderFallback(container, graph, spans || []);
        return;
      }
      drawMap(container, graph, spans || []);
    } catch (error) {
      console.warn("d3 map failed; falling back to HTML map", error);
      renderFallback(container, graph, spans || []);
    }
  };

  window.clearServiceMap = function clearServiceMap(container, message) {
    clearGraphEvents(container);
    container.classList.remove("graph-map");
    container.innerHTML = `<p class="empty">${escapeHtml(message || "No service map available.")}</p>`;
  };

  function drawMap(container, graph, spans) {
    const d3 = window.d3;
    if (!graph || !graph.nodes || !graph.nodes.length) {
      renderFallback(container, graph, spans);
      return;
    }
    const stats = serviceStats(spans);
    const hasSpans = spans.length > 0;

    const nodes = graph.nodes.map((node) => ({
      ...node,
      x: node.col * CELL_W,
      y: node.row * CELL_H,
    }));
    const nodeByID = new Map(nodes.map((node) => [node.id, node]));
    const links = (graph.edges ?? [])
      .map((edge) => ({
        ...edge,
        source: nodeByID.get(edge.source),
        target: nodeByID.get(edge.target),
      }))
      .filter((link) => link.source && link.target);
    for (const link of links) link.self = link.source === link.target;

    const bounds = boundsOf(nodes, links);

    clearGraphEvents(container);
    container.classList.add("graph-map");
    container.innerHTML = "";
    const root = d3.select(container);

    const svg = root.append("svg")
      .attr("class", "graph-svg")
      .attr("role", "img")
      .attr("aria-label", "Service topology map")
      .attr("viewBox", `${num(bounds.minX)} ${num(bounds.minY)} ${num(bounds.width)} ${num(bounds.height)}`)
      .attr("preserveAspectRatio", "xMidYMid meet");

    svg.append("defs").append("marker")
      .attr("id", "graph-arrow")
      .attr("viewBox", `0 ${-ARROW_MARKER_HALF_HEIGHT} ${ARROW_MARKER_LENGTH} ${ARROW_MARKER_HALF_HEIGHT * 2}`)
      .attr("refX", ARROW_MARKER_LENGTH)
      .attr("refY", 0)
      .attr("markerWidth", ARROW_MARKER_SIZE)
      .attr("markerHeight", ARROW_MARKER_SIZE)
      .attr("orient", "auto")
      .append("path")
      .attr("class", "graph-arrowhead")
      .attr("d", `M 0 ${-ARROW_MARKER_HALF_HEIGHT} L ${ARROW_MARKER_LENGTH} 0 L 0 ${ARROW_MARKER_HALF_HEIGHT} z`);

    const viewport = svg.append("g").attr("class", "graph-viewport");
    const linkGen = d3.linkHorizontal().x((d) => d.x).y((d) => d.y);
    const linkPath = (link) => (link.self ? selfLoopPath(link.source) : linkGen(linkEndpoints(link)));

    const linkSel = viewport.append("g").attr("class", "graph-edges")
      .selectAll("path")
      .data(links)
      .join("path")
      .attr("class", (link) => `graph-edge${link.async ? " graph-edge-async" : ""}`)
      .attr("fill", "none")
      .style("stroke-width", (link) => num(edgeWidth(link.weight)))
      .attr("marker-end", (link) => (link.self ? null : "url(#graph-arrow)"))
      .attr("d", linkPath);

    const nodeSel = viewport.append("g").attr("class", "graph-nodes")
      .selectAll("g")
      .data(nodes)
      .join("g")
      .attr("class", (node) => `graph-node${node.isRoot ? " graph-node-root" : ""}`)
      .attr("data-id", (node) => node.id)
      .attr("tabindex", 0)
      .attr("transform", (node) => `translate(${num(node.x)} ${num(node.y)})`)
      .style("--err", (node) => num(errorLevel(stats.get(node.id))));

    nodeSel.append("rect")
      .attr("x", -NODE_W / 2)
      .attr("y", -NODE_H / 2)
      .attr("width", NODE_W)
      .attr("height", NODE_H)
      .attr("rx", 7);

    nodeSel.append("text")
      .attr("class", "graph-node-label")
      .attr("text-anchor", "middle")
      .attr("dominant-baseline", "central")
      .attr("y", hasSpans ? -5 : 0)
      .text((node) => truncate(node.id, 18));

    if (hasSpans) {
      nodeSel.append("text")
        .attr("class", "graph-node-stats")
        .attr("text-anchor", "middle")
        .attr("dominant-baseline", "central")
        .attr("y", 10)
        .text((node) => {
          const item = stats.get(node.id) || { rate: 0, errors: 0 };
          return `${(item.rate || 0).toFixed(1)}/s · ${item.errors} err`;
        });
    }

    // Interaction: hover highlights connected links and shows a tooltip.
    const tooltip = root.append("div").attr("class", "graph-tooltip").attr("role", "tooltip").property("hidden", true);
    const activate = (node, element) => {
      linkSel.classed("is-active", (link) => link.source === node || link.target === node);
      showTooltip(tooltip.node(), container, element, node, links, stats);
    };
    const deactivate = () => {
      linkSel.classed("is-active", false);
      tooltip.property("hidden", true);
    };
    const dismissTooltip = (event) => {
      if (event.target?.closest?.(".graph-node")) return;
      deactivate();
      if (container.contains(document.activeElement) && document.activeElement?.matches?.(".graph-node")) {
        document.activeElement.blur();
      }
    };
    document.addEventListener("pointerdown", dismissTooltip, true);
    container.__graphCleanup = () => {
      document.removeEventListener("pointerdown", dismissTooltip, true);
      root.on(".zoom", null);
      delete container.__zoom;
    };
    nodeSel
      .on("pointerenter", function (event, node) { activate(node, this); })
      .on("pointerleave", deactivate)
      .on("focus", function (event, node) { activate(node, this); })
      .on("blur", deactivate);

    // Pan / zoom the whole viewport.
    const zoom = d3.zoom()
      .scaleExtent([ZOOM_MIN, ZOOM_MAX])
      .on("zoom", (event) => viewport.attr("transform", event.transform));
    root.call(zoom);

    if (links.length) root.append("div").attr("class", "graph-key").attr("aria-hidden", "true").html(lineKeyMarkup());
  }

  function lineKeyMarkup() {
    const top = KEY_ARROW_CENTER_Y - KEY_ARROW_HALF_HEIGHT;
    const bottom = KEY_ARROW_CENTER_Y + KEY_ARROW_HALF_HEIGHT;
    const sample = (extra, style) => `<svg viewBox="0 0 ${KEY_ARROW_VIEWBOX_WIDTH} ${KEY_ARROW_VIEWBOX_HEIGHT}" width="${KEY_ARROW_VIEWBOX_WIDTH}" height="${KEY_ARROW_VIEWBOX_HEIGHT}" aria-hidden="true"><line x1="${KEY_ARROW_LINE_START_X}" y1="${KEY_ARROW_CENTER_Y}" x2="${KEY_ARROW_BASE_X}" y2="${KEY_ARROW_CENTER_Y}" class="graph-edge${extra}"${style ? ` style="${style}"` : ""}></line><polygon points="${KEY_ARROW_TIP_X},${KEY_ARROW_CENTER_Y} ${KEY_ARROW_BASE_X},${top} ${KEY_ARROW_BASE_X},${bottom}" class="graph-key-arrow"></polygon></svg>`;
    return `<span class="graph-key-title">line key</span>`
      + `<span class="graph-key-row">${sample("")} sync call</span>`
      + `<span class="graph-key-row">${sample(" graph-edge-async")} async call</span>`
      + `<span class="graph-key-row">${sample("", "stroke-width:4")} more calls</span>`;
  }

  // --- geometry -------------------------------------------------------------

  function linkEndpoints(link) {
    const s = link.source;
    const t = link.target;
    const forward = t.x >= s.x;
    return {
      source: { x: s.x + (forward ? NODE_W / 2 : -NODE_W / 2), y: s.y },
      target: { x: t.x + (forward ? -NODE_W / 2 : NODE_W / 2), y: t.y },
    };
  }

  function selfLoopPath(node) {
    const cx = node.x;
    const cy = node.y - NODE_H / 2;
    const start = [cx + SELF_LOOP_R * Math.cos(Math.PI * 0.9), cy + SELF_LOOP_R * Math.sin(Math.PI * 0.9)];
    const end = [cx + SELF_LOOP_R * Math.cos(Math.PI * 2.1), cy + SELF_LOOP_R * Math.sin(Math.PI * 2.1)];
    return `M ${num(start[0])} ${num(start[1])} A ${SELF_LOOP_R} ${SELF_LOOP_R} 0 1 1 ${num(end[0])} ${num(end[1])}`;
  }

  function boundsOf(nodes, links) {
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
      include(node.x - NODE_W / 2, node.y - NODE_H / 2);
      include(node.x + NODE_W / 2, node.y + NODE_H / 2);
    }
    for (const link of links) {
      if (link.self) include(link.source.x, link.source.y - NODE_H / 2 - 2 * SELF_LOOP_R);
    }
    return {
      minX: minX - VIEW_PAD,
      minY: minY - VIEW_PAD,
      width: maxX - minX + VIEW_PAD * 2,
      height: maxY - minY + VIEW_PAD * 2,
    };
  }

  function errorLevel(item) {
    if (!item || !item.spans) return 0;
    return clamp((item.errors / item.spans) * 3, 0, 1);
  }

  // --- tooltip --------------------------------------------------------------

  function showTooltip(tooltip, container, element, node, links, stats) {
    if (!tooltip) return;
    const lines = [`<strong>${escapeHtml(node.id)}${node.isRoot ? " · entry" : ""}</strong>`];
    const item = stats.get(node.id);
    if (item) lines.push(`<span>${item.spans} spans, ${item.errors} errors</span>`);
    for (const operation of node.operations ?? []) lines.push(`<span>${escapeHtml(operation)}</span>`);
    for (const link of links) {
      if (link.source !== node) continue;
      for (const call of link.calls ?? []) {
        const mods = [];
        if (call.probability < 1) mods.push(`${Math.round(call.probability * 100)}%`);
        if (call.count > 1) mods.push(`x${call.count}`);
        if (call.async) mods.push("async");
        lines.push(`<span class="graph-tooltip-call">${escapeHtml(`${call.from} -> ${link.target.id}.${call.to}`)}${mods.length ? ` [${escapeHtml(mods.join(", "))}]` : ""}</span>`);
      }
    }
    tooltip.innerHTML = lines.join("");
    tooltip.hidden = false;
    if (!element || !element.getBoundingClientRect) return;
    const anchor = element.getBoundingClientRect();
    const frame = container.getBoundingClientRect();
    const margin = 8;
    let left = anchor.right - frame.left + 10;
    let top = anchor.top - frame.top;
    if (left + tooltip.offsetWidth + margin > container.clientWidth) {
      left = anchor.left - frame.left - tooltip.offsetWidth - 10;
    }
    left = Math.max(margin, Math.min(left, container.clientWidth - tooltip.offsetWidth - margin));
    top = Math.max(margin, Math.min(top, container.clientHeight - tooltip.offsetHeight - margin));
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }

  // --- helpers --------------------------------------------------------------

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

  function clearGraphEvents(container) {
    if (!container.__graphCleanup) return;
    container.__graphCleanup();
    delete container.__graphCleanup;
  }

  function renderFallback(container, graph, spans) {
    clearGraphEvents(container);
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
