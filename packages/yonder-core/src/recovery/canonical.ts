// SPDX-License-Identifier: GPL-3.0-or-later
/** Deterministic JSON: UTF-16 key order, JSON strings/numbers, no whitespace. */
export class CanonicalSizeError extends Error {}
export function canonicalJson(value: unknown): string {
  let nodes = 0;
  let bytes = 0;
  function token(text: string): string {
    bytes += Buffer.byteLength(text);
    if (bytes > 4 * 1024 * 1024) throw new CanonicalSizeError("Recovery serialization exceeds its byte limit");
    return text;
  }
  function quote(text: string): string {
    if (Buffer.byteLength(text) > 4 * 1024 * 1024 - bytes) throw new CanonicalSizeError("Recovery serialization exceeds its byte limit");
    return token(JSON.stringify(text));
  }
  function encode(input: unknown, depth: number): string {
    if (++nodes > 100_000 || depth > 32) throw new Error("Recovery structure exceeds its limits");
    if (typeof input === "string") return quote(input);
    if (input === null || typeof input === "boolean") return token(JSON.stringify(input));
    if (typeof input === "number" && Number.isFinite(input)) return token(JSON.stringify(input));
    if (Array.isArray(input)) return token("[") + input.map((item, index) => (index ? token(",") : "") + encode(item, depth + 1)).join("") + token("]");
    if (typeof input !== "object" || Object.getPrototypeOf(input) !== Object.prototype) throw new Error("Recovery value is not JSON");
    const record = input as Record<string, unknown>;
    return token("{") + Object.keys(record).sort().map((key, index) => (index ? token(",") : "") + quote(key) + token(":") + encode(record[key], depth + 1)).join("") + token("}");
  }
  return encode(value, 0);
}
