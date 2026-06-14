import assert from "node:assert/strict";

import {
  decodeSharePayload,
  encodeSharePayload,
  getShareToken,
  isShareURLTooLarge,
  makeShareURL,
  maxShareURLLength,
  parseShareHash,
  shareStateVersion,
} from "../web/share-state.mjs";

const allowedViews = new Set(["preview", "logs", "raw"]);
const topology = `version: 1
services:
  gateway:
    operations:
      GET /users:
        duration: 30ms +/- 10ms
traffic:
  rate: 12/s
`;

const payload = {
  topology,
  settings: {
    duration: "2.5",
    seed: "314",
    maxNodes: "4",
  },
  filters: {
    result: "gateway",
    errorTracesOnly: true,
    warnLogsOnly: false,
  },
  view: "logs",
};

const shareURL = makeShareURL("https://andrewh.github.io/motel-playground/#tab=metrics", payload);
const token = getShareToken(shareURL.hash);
const decodedPayload = decodeSharePayload(token, { allowedViews });

assert.equal(shareURL.pathname, "/motel-playground/");
assert.equal(new URLSearchParams(shareURL.hash.slice(1)).get("tab"), "metrics");
assert.ok(token);
assert.deepEqual(decodedPayload, {
  v: shareStateVersion,
  ...payload,
});
assert.deepEqual(parseShareHash(shareURL.hash, { allowedViews }), decodedPayload);
assert.equal(parseShareHash("#tab=logs", { allowedViews }), null);

assert.throws(
  () => decodeSharePayload("not-valid", { allowedViews }),
  /Unexpected token|invalid character|Invalid character|invalid share payload/,
);
assert.throws(
  () => decodeSharePayload(encodeSharePayload({ ...payload, v: shareStateVersion + 1 }), { allowedViews }),
  /unsupported share payload version/,
);
assert.throws(
  () => decodeSharePayload(encodeSharePayload({ v: shareStateVersion, topology: "", view: "logs" }), { allowedViews }),
  /missing shared topology/,
);
assert.throws(
  () => decodeSharePayload(encodeSharePayload({ v: shareStateVersion, topology, view: "unknown" }), { allowedViews }),
  /unsupported shared view/,
);

const oversizedTopology = `version: 1
# ${"x".repeat(maxShareURLLength)}
services: {}
`;
const oversizedURL = makeShareURL("http://127.0.0.1:8080/", {
  ...payload,
  topology: oversizedTopology,
});

assert.ok(isShareURLTooLarge(oversizedURL));

console.log("share state ok");
