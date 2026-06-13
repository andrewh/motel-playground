const MIN_NODES = 2;
const DEFAULT_MAX_NODES = 8;
const HARD_MAX_NODES = 12;

const COMPONENTS = {
  "api-gateway": component("api-gateway", "api-gateway", [12, 35], [0.05, 0.8], ["ingress", "authorize", "route"]),
  "application-service": component("application-service", "application", [20, 80], [0.1, 1.8], ["handle", "compose", "render"]),
  "auth-service": component("auth-service", "microservice", [18, 60], [0.1, 1.4], ["verify-token", "lookup-session"]),
  "cdn-edge": component("cdn-edge", "cdn", [2, 10], [0.01, 0.2], ["fetch", "cache-hit", "purge"]),
  "document-store": component("document-store", "document-store", [7, 28], [0.05, 0.7], ["find", "insert", "aggregate"]),
  "feed-service": component("feed-service", "microservice", [30, 110], [0.2, 2.4], ["timeline", "fanout", "rank"]),
  "key-value-store": component("key-value-store", "key-value-store", [2, 12], [0.01, 0.4], ["read", "write", "expire"]),
  "load-balancer": component("load-balancer", "load-balancer", [4, 14], [0.01, 0.2], ["route", "balance", "health-check"]),
  "media-service": component("media-service", "microservice", [28, 90], [0.1, 1.6], ["transform", "metadata", "serve"]),
  "message-queue": component("message-queue", "message-queue", [5, 22], [0.03, 0.7], ["publish", "consume", "ack"]),
  "object-cache": component("object-cache", "cache", [1, 8], [0.001, 0.3], ["read", "write", "refresh"]),
  "object-store": component("object-store", "object-store", [12, 45], [0.05, 0.9], ["get-object", "put-object", "list"]),
  "postgres-primary": component("postgres-primary", "rdbms", [8, 35], [0.05, 0.8], ["query", "transaction", "replicate"]),
  "redis-cache": component("redis-cache", "cache", [1, 6], [0.001, 0.2], ["get", "set", "evict"]),
  "reverse-proxy": component("reverse-proxy", "reverse-proxy", [5, 18], [0.02, 0.4], ["proxy", "terminate-tls", "rewrite"]),
  "search-index": component("search-index", "search-index", [12, 60], [0.1, 1.4], ["search", "index", "suggest"]),
  "service-discovery": component("service-discovery", "service-discovery", [3, 12], [0.01, 0.3], ["resolve", "register", "heartbeat"]),
  "task-worker": component("task-worker", "worker", [20, 85], [0.1, 1.8], ["process", "retry", "complete"]),
  "user-service": component("user-service", "microservice", [22, 75], [0.1, 1.6], ["profile", "lookup", "update"]),
  "wide-column-store": component("wide-column-store", "wide-column-store", [9, 42], [0.08, 0.9], ["scan", "write", "compact"]),
};

const ARCHITECTURES = [
  architecture("read-heavy web path", [
    node("cdn-edge", "fetch"),
    node("load-balancer", "route"),
    node("reverse-proxy", "proxy"),
    node("application-service", "compose"),
    node("redis-cache", "get"),
    node("postgres-primary", "query"),
    node("search-index", "search"),
    node("object-cache", "read"),
  ], [
    call("cdn-edge", "load-balancer"),
    call("load-balancer", "reverse-proxy"),
    call("reverse-proxy", "application-service"),
    call("application-service", "redis-cache"),
    call("application-service", "postgres-primary"),
    call("application-service", "search-index", { probability: 0.55 }),
    call("cdn-edge", "object-cache", { probability: 0.35 }),
  ]),
  architecture("microservice fanout", [
    node("api-gateway", "ingress"),
    node("auth-service", "verify-token"),
    node("user-service", "profile"),
    node("feed-service", "timeline"),
    node("redis-cache", "get"),
    node("document-store", "find"),
    node("search-index", "search"),
    node("service-discovery", "resolve"),
  ], [
    call("api-gateway", "auth-service"),
    call("auth-service", "user-service"),
    call("api-gateway", "feed-service", { async: true, probability: 0.75 }),
    call("user-service", "redis-cache"),
    call("user-service", "document-store"),
    call("feed-service", "redis-cache"),
    call("feed-service", "search-index", { probability: 0.65 }),
    call("api-gateway", "service-discovery", { probability: 0.35 }),
  ]),
  architecture("async write path", [
    node("load-balancer", "balance"),
    node("api-gateway", "route"),
    node("application-service", "handle"),
    node("message-queue", "publish"),
    node("task-worker", "process"),
    node("postgres-primary", "transaction"),
    node("redis-cache", "set"),
    node("service-discovery", "resolve"),
  ], [
    call("load-balancer", "api-gateway"),
    call("api-gateway", "application-service"),
    call("application-service", "message-queue", { async: true }),
    call("message-queue", "task-worker"),
    call("task-worker", "postgres-primary"),
    call("application-service", "redis-cache", { probability: 0.6 }),
    call("api-gateway", "service-discovery", { probability: 0.4 }),
  ]),
  architecture("content delivery path", [
    node("cdn-edge", "fetch"),
    node("reverse-proxy", "terminate-tls"),
    node("media-service", "serve"),
    node("object-cache", "read"),
    node("object-store", "get-object"),
    node("key-value-store", "read"),
    node("search-index", "suggest"),
    node("message-queue", "publish"),
  ], [
    call("cdn-edge", "reverse-proxy"),
    call("reverse-proxy", "media-service"),
    call("media-service", "object-cache"),
    call("media-service", "object-store"),
    call("media-service", "key-value-store", { probability: 0.5 }),
    call("media-service", "search-index", { probability: 0.35 }),
    call("media-service", "message-queue", { async: true, probability: 0.3 }),
  ]),
  architecture("analytics lookup path", [
    node("reverse-proxy", "rewrite"),
    node("application-service", "handle"),
    node("service-discovery", "resolve"),
    node("feed-service", "rank"),
    node("wide-column-store", "scan"),
    node("redis-cache", "get"),
    node("message-queue", "publish"),
    node("task-worker", "complete"),
  ], [
    call("reverse-proxy", "application-service"),
    call("application-service", "service-discovery"),
    call("application-service", "feed-service"),
    call("feed-service", "wide-column-store"),
    call("feed-service", "redis-cache"),
    call("application-service", "message-queue", { async: true, probability: 0.45 }),
    call("message-queue", "task-worker"),
  ]),
];

export function randomTopologyYaml(seed, options = {}) {
  const random = mulberry32(seed);
  const maxNodes = normalizedMaxNodes(options.maxNodes);
  const template = pick(random, ARCHITECTURES);
  const count = randInt(random, MIN_NODES, Math.min(maxNodes, template.nodes.length));
  const nodes = template.nodes.slice(0, count).map((spec) => makeService(spec, random));
  const included = new Set(nodes.map((item) => item.name));

  for (const edge of template.calls) {
    if (!included.has(edge.source) || !included.has(edge.target)) continue;
    const source = nodes.find((item) => item.name === edge.source);
    const target = nodes.find((item) => item.name === edge.target);
    source.calls.push({
      target: `${target.name}.${target.operation}`,
      count: edge.count ?? (random() > 0.84 ? randInt(random, 2, 4) : 1),
      probability: edge.probability,
      async: edge.async,
    });
  }

  const rate = randInt(random, 8, 80);
  const incident = random() > 0.45 ? pick(random, nodes.slice(1)) : null;
  const lines = [
    `# Random topology generated in motel playground`,
    `# Seed: ${seed}`,
    `# Pattern: ${template.name}`,
    `# Max nodes: ${maxNodes}`,
    `version: 1`,
    ``,
    `services:`,
  ];

  for (const node of nodes) {
    lines.push(`  ${node.name}:`);
    lines.push(`    resource_attributes:`);
    lines.push(`      component.type: ${node.type}`);
    lines.push(`      architecture.pattern: ${template.name}`);
    lines.push(`    operations:`);
    lines.push(`      ${node.operation}:`);
    lines.push(`        duration: ${node.duration}ms +/- ${node.variance}ms`);
    lines.push(`        error_rate: ${node.errorRate}%`);
    if (node === nodes[0]) {
      lines.push(`        attributes:`);
      lines.push(`          http.request.method:`);
      lines.push(`            value: ${pick(random, ["GET", "POST", "PATCH"])}`);
      lines.push(`          http.route:`);
      lines.push(`            value: "/generated/${seed}"`);
    }
    if (node.calls.length) {
      lines.push(`        call_style: ${random() > 0.7 ? "parallel" : "sequential"}`);
      lines.push(`        calls:`);
      for (const outbound of node.calls) {
        writeCall(lines, outbound);
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

function architecture(name, nodes, calls) {
  return { name, nodes, calls };
}

function node(name, operation) {
  return { name, operation };
}

function call(source, target, options = {}) {
  return { source, target, ...options };
}

function component(name, type, duration, error, ops) {
  return { name, type, duration, error, ops };
}

function makeService(spec, random) {
  const component = COMPONENTS[spec.name];
  const duration = randInt(random, component.duration[0], component.duration[1]);
  return {
    name: component.name,
    type: component.type,
    operation: spec.operation || pick(random, component.ops),
    duration,
    variance: Math.max(1, Math.round(duration * (0.18 + random() * 0.26))),
    errorRate: formatPercent(component.error[0] + random() * (component.error[1] - component.error[0])),
    calls: [],
  };
}

function writeCall(lines, outbound) {
  const hasOptions = outbound.count > 1 || outbound.probability < 1 || outbound.async;
  if (!hasOptions) {
    lines.push(`          - ${outbound.target}`);
    return;
  }
  lines.push(`          - target: ${outbound.target}`);
  if (outbound.count > 1) lines.push(`            count: ${outbound.count}`);
  if (outbound.probability < 1) lines.push(`            probability: ${formatPercent(outbound.probability)}`);
  if (outbound.async) lines.push(`            async: true`);
}

function normalizedMaxNodes(value) {
  const parsed = Math.floor(Number(value) || DEFAULT_MAX_NODES);
  return Math.min(HARD_MAX_NODES, Math.max(MIN_NODES, parsed));
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
