// SPDX-License-Identifier: GPL-3.0-or-later
// R-FLT-11: bounded browser inputs, independent of the aircraft transport.
export class DataFetchError extends Error {
  constructor(message, retryMs = 0) {
    super(message);
    this.retryMs = retryMs;
  }
}
export function signals(...items) {
  const controller = new AbortController(),
    clean = [];
  for (const signal of items.filter(Boolean)) {
    if (signal.aborted) controller.abort();
    else {
      const fn = () => controller.abort();
      signal.addEventListener("abort", fn, { once: true });
      clean.push(() => signal.removeEventListener("abort", fn));
    }
  }
  return {
    signal: controller.signal,
    abort: () => controller.abort(),
    dispose: () => clean.forEach((fn) => fn()),
  };
}
export async function readBytes(response, limit) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel();
    throw new Error("Response exceeds byte limit");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader(),
    parts = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new Error("Response exceeds byte limit");
      parts.push(value);
    }
  } catch (e) {
    await reader.cancel();
    throw e;
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
export async function checksum(bytes) {
  if (!globalThis.crypto?.subtle)
    throw new Error("Secure browser storage requires HTTPS or localhost");
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}
export function imageType(bytes, type) {
  const png = [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v),
    jpeg = bytes[0] === 255 && bytes[1] === 216;
  if (png && type === "image/png") return type;
  if (jpeg && ["image/jpeg", "image/jpg"].includes(type)) return "image/jpeg";
  throw new Error("Provider image format invalid");
}
export function validTile(layer, z, x, y) {
  if (
    !["elevation", "imagery", "places", "roads"].includes(layer) ||
    ![z, x, y].every(Number.isInteger) ||
    z < 0 ||
    z > 19 ||
    x < 0 ||
    y < 0 ||
    x >= 2 ** z ||
    y >= 2 ** z ||
    (layer === "elevation" && z > 15)
  )
    throw new Error("Invalid geographic tile");
}
export class ByteCache {
  constructor(limit = 32 * 1024 * 1024, maxEntries = 128) {
    if (!Number.isInteger(limit) || limit < 0 || limit > 64 * 1024 * 1024)
      throw new Error("Invalid memory cache limit");
    this.limit = limit;
    this.maxEntries = maxEntries;
    this.values = new Map();
    this.bytes = 0;
  }
  get(key, now = 0) {
    const v = this.values.get(key);
    if (!v) return null;
    if (v.until && now >= v.until) {
      this.values.delete(key);
      this.bytes -= v.bytes;
      return null;
    }
    this.values.delete(key);
    this.values.set(key, v);
    return v.value;
  }
  put(key, value, bytes, until = 0) {
    const old = this.values.get(key);
    if (old) {
      this.bytes -= old.bytes;
      this.values.delete(key);
    }
    if (bytes > this.limit) return;
    while (
      this.bytes + bytes > this.limit ||
      this.values.size >= this.maxEntries
    ) {
      const k = this.values.keys().next().value;
      this.bytes -= this.values.get(k).bytes;
      this.values.delete(k);
    }
    this.values.set(key, { value, bytes, until });
    this.bytes += bytes;
  }
  clear() {
    this.values.clear();
    this.bytes = 0;
  }
}
