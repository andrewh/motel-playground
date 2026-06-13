export function randomTopologyYaml(seed) {
  const random = mulberry32(seed);
  const componentCatalog = [
    component("load-balancer", "load-balancer", [4, 14], [0.01, 0.2], ["route", "balance", "health-check"]),
    component("reverse-proxy", "reverse-proxy", [5, 18], [0.02, 0.4], ["proxy", "terminate-tls", "rewrite"]),
    component("cdn-edge", "cdn", [2, 10], [0.01, 0.2], ["fetch", "cache-hit", "purge"]),
    component("application-service", "application", [20, 80], [0.1, 1.8], ["handle", "authorize", "compose"]),
    component("user-service", "microservice", [22, 75], [0.1, 1.6], ["profile", "lookup", "update"]),
    component("feed-service", "microservice", [30, 110], [0.2, 2.4], ["timeline", "fanout", "rank"]),
    component("service-discovery", "service-discovery", [3, 12], [0.01, 0.3], ["resolve", "register", "heartbeat"]),
    component("postgres-primary", "rdbms", [8, 35], [0.05, 0.8], ["query", "transaction", "replicate"]),
    component("document-store", "document-store", [7, 28], [0.05, 0.7], ["find", "insert", "aggregate"]),
    component("wide-column-store", "wide-column-store", [9, 42], [0.08, 0.9], ["scan", "write", "compact"]),
    component("graph-database", "graph-database", [12, 55], [0.08, 1.1], ["traverse", "match", "expand"]),
    component("redis-cache", "cache", [1, 6], [0.001, 0.2], ["get", "set", "evict"]),
    component("object-cache", "cache", [1, 8], [0.001, 0.3], ["read", "write", "refresh"]),
    component("message-queue", "message-queue", [5, 22], [0.03, 0.7], ["publish", "consume", "ack"]),
    component("task-queue", "task-queue", [8, 36], [0.05, 0.9], ["enqueue", "lease", "complete"]),
    component("search-index", "search-index", [12, 60], [0.1, 1.4], ["search", "index", "suggest"]),
  ];
  const count = randInt(random, 5, 10);
  const nodes = [];
  const root = makeService(component("gateway", "api-gateway", [12, 35], [0.05, 0.8], ["ingress"]), "ingress", random);
  const availableComponents = shuffle(random, componentCatalog).slice(0, count - 1);
  nodes.push(root);

  for (const candidate of availableComponents) {
    nodes.push(makeService(candidate, pick(random, candidate.ops), random));
  }

  for (let index = 1; index < nodes.length; index += 1) {
    const candidates = nodes.slice(0, index).filter((node) => node.calls.length < 3);
    const parent = pick(random, candidates.length ? candidates : nodes.slice(0, index));
    parent.calls.push({
      target: `${nodes[index].name}.${nodes[index].operation}`,
      count: random() > 0.82 ? randInt(random, 2, 4) : 1,
    });
    if (index > 3 && random() > 0.78) {
      const secondParent = pick(random, nodes.slice(0, index).filter((node) => node !== parent));
      if (secondParent && secondParent.calls.length < 3) {
        secondParent.calls.push({ target: `${nodes[index].name}.${nodes[index].operation}`, count: 1 });
      }
    }
  }

  const rate = randInt(random, 8, 80);
  const incident = random() > 0.45 ? pick(random, nodes.slice(1)) : null;
  const lines = [
    `# Random topology generated in motel playground`,
    `# Seed: ${seed}`,
    `version: 1`,
    ``,
    `services:`,
  ];

  for (const node of nodes) {
    lines.push(`  ${node.name}:`);
    lines.push(`    resource_attributes:`);
    lines.push(`      component.type: ${node.type}`);
    lines.push(`    operations:`);
    lines.push(`      ${node.operation}:`);
    lines.push(`        duration: ${node.duration}ms +/- ${node.variance}ms`);
    lines.push(`        error_rate: ${node.errorRate}%`);
    if (node === root) {
      lines.push(`        attributes:`);
      lines.push(`          http.request.method:`);
      lines.push(`            value: ${pick(random, ["GET", "POST", "PATCH"])}`);
      lines.push(`          http.route:`);
      lines.push(`            value: "/generated/${seed}"`);
    }
    if (node.calls.length) {
      lines.push(`        call_style: ${random() > 0.7 ? "parallel" : "sequential"}`);
      lines.push(`        calls:`);
      for (const call of node.calls) {
        if (call.count > 1) {
          lines.push(`          - target: ${call.target}`);
          lines.push(`            count: ${call.count}`);
        } else {
          lines.push(`          - ${call.target}`);
        }
      }
    }
    lines.push(``);
  }

  lines.push(`traffic:`);
  lines.push(`  rate: ${rate}/s`);
  if (incident) {
    lines.push(``);
    lines.push(`scenarios:`);
    lines.push(`  - name: generated degradation`);
    lines.push(`    at: +${randInt(random, 4, 12)}s`);
    lines.push(`    duration: ${randInt(random, 12, 30)}s`);
    lines.push(`    override:`);
    lines.push(`      ${incident.name}.${incident.operation}:`);
    lines.push(`        duration: ${incident.duration * randInt(random, 5, 12)}ms +/- ${incident.variance * 2}ms`);
    lines.push(`        error_rate: ${randInt(random, 6, 24)}%`);
  }
  return `${lines.join("\n")}\n`;
}

function component(name, type, duration, error, ops) {
  return { name, type, duration, error, ops };
}

function makeService(component, operation, random) {
  const duration = randInt(random, component.duration[0], component.duration[1]);
  return {
    name: component.name,
    type: component.type,
    operation,
    duration,
    variance: Math.max(1, Math.round(duration * (0.18 + random() * 0.26))),
    errorRate: formatPercent(component.error[0] + random() * (component.error[1] - component.error[0])),
    calls: [],
  };
}

function shuffle(random, items) {
  const shuffled = items.slice();
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]];
  }
  return shuffled;
}

function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let mixed = value;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(random, min, max) {
  return Math.floor(random() * (max - min + 1)) + min;
}

function pick(random, items) {
  return items[Math.floor(random() * items.length)];
}

function formatPercent(value) {
  return value < 1 ? Number(value.toFixed(3)) : Number(value.toFixed(1));
}
