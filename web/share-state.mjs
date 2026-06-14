export const maxShareURLLength = 8000;
export const shareHashKey = "state";
export const shareStateVersion = 1;

const base64BlockSize = 4;
const shareEncodingChunkSize = 0x8000;
const shareTokenPattern = /^[A-Za-z0-9_-]+$/;

export function makeShareURL(href, payload) {
  const url = new URL(href);
  const params = hashParams(url.hash);
  params.set(shareHashKey, encodeSharePayload({
    v: shareStateVersion,
    ...payload,
  }));
  url.hash = params.toString();
  return url;
}

export function getShareToken(hash) {
  return hashParams(hash).get(shareHashKey);
}

export function parseShareHash(hash, options = {}) {
  const token = getShareToken(hash);
  if (!token) return null;
  return decodeSharePayload(token, options);
}

export function isShareURLTooLarge(url) {
  return String(url).length > maxShareURLLength;
}

export function encodeSharePayload(payload) {
  return encodeBase64URL(JSON.stringify(payload));
}

export function decodeSharePayload(token, { allowedViews = new Set() } = {}) {
  if (!shareTokenPattern.test(token)) {
    throw new Error("invalid share token");
  }
  const payload = JSON.parse(decodeBase64URL(token));
  if (!payload || typeof payload !== "object") {
    throw new Error("invalid share payload");
  }
  if (payload.v !== shareStateVersion) {
    throw new Error("unsupported share payload version");
  }
  if (typeof payload.topology !== "string" || !payload.topology.trim()) {
    throw new Error("missing shared topology");
  }
  if (payload.view != null && allowedViews.size > 0 && !allowedViews.has(payload.view)) {
    throw new Error("unsupported shared view");
  }
  return payload;
}

function hashParams(hash) {
  const hashText = hash.startsWith("#") ? hash.slice(1) : hash;
  return new URLSearchParams(hashText);
}

function encodeBase64URL(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += shareEncodingChunkSize) {
    const chunk = bytes.subarray(offset, offset + shareEncodingChunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decodeBase64URL(value) {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const paddingLength = (base64BlockSize - (base64.length % base64BlockSize)) % base64BlockSize;
  const binary = atob(`${base64}${"=".repeat(paddingLength)}`);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
