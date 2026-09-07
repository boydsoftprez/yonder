// SPDX-License-Identifier: GPL-3.0-or-later
// R-FLT-11: explicit local imports only; no service worker or automatic network preload.
import {
  validateTerrainManifest,
  decodeTerrainTile,
} from "yonder-core/terrain";
import { checksum, readBytes, imageType, validTile } from "./ground-utils.mjs";
export const MAX_IMPORT_BYTES = 64 * 1024 * 1024;
export function createOfflineStore(indexed = globalThis.indexedDB) {
  let database = null;
  const open = () =>
    (database ??= new Promise((ok, no) => {
      if (!indexed) return no(new Error("Offline browser storage unavailable"));
      const req = indexed.open("yonder-ground-data-v1", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("files");
      req.onsuccess = () => ok(req.result);
      req.onerror = () => no(req.error);
    }));
  return {
    async get(key) {
      const db = await open();
      return new Promise((ok, no) => {
        const request = db
          .transaction("files", "readonly")
          .objectStore("files")
          .get(key);
        request.onsuccess = () => ok(request.result ?? null);
        request.onerror = () => no(request.error);
      });
    },
    async replace(kind, entries) {
      const db = await open();
      return new Promise((ok, no) => {
        const tx = db.transaction("files", "readwrite"),
          store = tx.objectStore("files"),
          request = store.openKeyCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor) {
            if (String(cursor.key).startsWith(kind + "/"))
              store.delete(cursor.key);
            cursor.continue();
          } else
            for (const [key, value] of entries)
              store.put(value, kind + "/" + key);
        };
        tx.oncomplete = () => ok();
        tx.onerror = () => no(tx.error);
        tx.onabort = () => no(tx.error ?? new Error("Offline import aborted"));
      });
    },
    async clear() {
      const db = await open();
      return new Promise((ok, no) => {
        const tx = db.transaction("files", "readwrite");
        tx.objectStore("files").clear();
        tx.oncomplete = () => ok();
        tx.onerror = () => no(tx.error);
      });
    },
  };
}
export async function inflateTerrain(bytes, descriptor) {
  if (bytes.byteLength !== descriptor.bytes)
    throw new Error("Terrain file length mismatch");
  if ((await checksum(bytes)) !== descriptor.sha256)
    throw new Error("Terrain checksum mismatch");
  let raw = bytes;
  if (descriptor.file.endsWith(".gz")) {
    if (typeof DecompressionStream !== "function")
      throw new Error("This browser cannot decompress terrain imports");
    raw = await readBytes(
      new Response(
        new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")),
      ),
      descriptor.decodedBytes,
    );
  }
  decodeTerrainTile(raw, descriptor);
  return raw;
}
function filesByName(files) {
  const input = Array.from(files || []);
  if (input.length < 1 || input.length > 1026)
    throw new Error("Import file count exceeds limit");
  const map = new Map();
  let bytes = 0;
  for (const file of input) {
    if (
      !file ||
      typeof file.name !== "string" ||
      !Number.isInteger(file.size) ||
      file.size < 0 ||
      file.size > MAX_IMPORT_BYTES
    )
      throw new Error("Invalid import file");
    // Directory picker supplies a directory prefix; only manifest-listed basenames are consumed.
    const name = file.name;
    if (name.includes("/") || name.includes("\\") || map.has(name))
      throw new Error("Duplicate or unsafe import filename");
    bytes += file.size;
    if (bytes > MAX_IMPORT_BYTES) throw new Error("Import exceeds 64 MiB");
    map.set(name, file);
  }
  return map;
}
export async function importTerrain(files, store) {
  const map = filesByName(files),
    file = map.get("manifest.json");
  if (!file || file.size > 4 * 1024 * 1024)
    throw new Error("Select the terrain directory including manifest.json");
  const manifest = validateTerrainManifest(JSON.parse(await file.text()));
  if (manifest.tiles.length > 1024)
    throw new Error("Terrain import has too many tiles");
  const entries = [["manifest", manifest]];
  let bytes = 0;
  for (const descriptor of manifest.tiles) {
    const tile = map.get(descriptor.file);
    if (!tile) throw new Error("Missing terrain file " + descriptor.file);
    const raw = new Uint8Array(await tile.arrayBuffer());
    await inflateTerrain(raw, descriptor);
    bytes += raw.length;
    entries.push(["tile/" + descriptor.id, raw]);
  }
  await store.replace("terrain", entries);
  return {
    id: manifest.id,
    title: manifest.title,
    tiles: manifest.tiles.length,
    bytes,
    datum: manifest.verticalDatum,
  };
}
export async function importMap(files, store) {
  const map = filesByName(files),
    file = map.get("map-manifest.json");
  if (!file || file.size > 1024 * 1024)
    throw new Error("Select map-manifest.json and its licensed tile files");
  const m = JSON.parse(await file.text());
  if (
    m.schemaVersion !== 1 ||
    m.offlineAllowed !== true ||
    !["id", "title", "attribution", "sourceUrl", "license"].every(
      (k) => typeof m[k] === "string" && m[k].length > 0 && m[k].length <= 2048,
    ) ||
    !Array.isArray(m.tiles) ||
    m.tiles.length > 1024
  )
    throw new Error("Invalid offline map provenance");
  const keys = new Set(),
    entries = [["manifest", m]];
  let bytes = 0;
  for (const t of m.tiles) {
    validTile(t.layer, t.z, t.x, t.y);
    const key = [t.layer, t.z, t.x, t.y].join("/");
    if (keys.has(key)) throw new Error("Duplicate map tile");
    keys.add(key);
    if (
      typeof t.file !== "string" ||
      !/^[-a-zA-Z0-9_.]+$/.test(t.file) ||
      !Number.isInteger(t.bytes) ||
      t.bytes < 1 ||
      t.bytes > 524288 ||
      !/^[a-f0-9]{64}$/.test(t.sha256)
    )
      throw new Error("Invalid offline map tile");
    const f = map.get(t.file);
    if (!f || f.size !== t.bytes)
      throw new Error("Offline map file missing or wrong size");
    // Different tile coordinates may reuse a file. Bound the copies that will
    // be stored, including the manifest, before reading or allocating any tile.
    bytes += t.bytes;
    if (bytes + file.size > MAX_IMPORT_BYTES)
      throw new Error("Expanded offline map exceeds 64 MiB");
  }
  for (const t of m.tiles) {
    const key = [t.layer, t.z, t.x, t.y].join("/"),
      f = map.get(t.file);
    const data = new Uint8Array(await f.arrayBuffer());
    if ((await checksum(data)) !== t.sha256)
      throw new Error("Offline map checksum mismatch");
    const type = imageType(data, t.type);
    entries.push(["tile/" + key, { bytes: data, type }]);
  }
  await store.replace("map", entries);
  return {
    id: m.id,
    title: m.title,
    tiles: m.tiles.length,
    bytes,
    attribution: m.attribution,
  };
}
