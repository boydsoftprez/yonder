// SPDX-License-Identifier: GPL-3.0-or-later
// R-FLT-11: same EGM96-5 bilinear reader as core, provisioned by a local file only.
import { checksum } from "./ground-utils.mjs";
const HASH = "c4b25a03ec5845cec4778a54b580aeda676363f2205a89137e8677b2337af3ec";
export async function importGroundGeoid(file) {
  if (!file || file.size > 32 * 1024 * 1024)
    throw new Error("Invalid ground geoid file");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if ((await checksum(bytes)) !== HASH)
    throw new Error("Expected the documented EGM96-5 ground grid");
  return new GroundGeoid(bytes);
}
export class GroundGeoid {
  constructor(bytes) {
    let pos = 0;
    const line = () => {
      const end = bytes.indexOf(10, pos);
      if (end < 0 || end - pos > 1024) throw new Error("Invalid geoid header");
      const s = new TextDecoder().decode(bytes.subarray(pos, end));
      pos = end + 1;
      return s;
    };
    if (line() !== "P5") throw new Error("Expected GeographicLib PGM");
    const metadata = {};
    let dimensions = "";
    for (let i = 0; i < 64; i++) {
      const s = line();
      if (!s.startsWith("#")) {
        dimensions = s;
        break;
      }
      const match = /^#\s*(\S+)\s+(.+)$/.exec(s);
      if (match) metadata[match[1]] = match[2];
    }
    [this.width, this.height] = dimensions.split(/\s+/).map(Number);
    this.offset = Number(metadata.Offset);
    this.scale = Number(metadata.Scale);
    if (
      line() !== "65535" ||
      !Number.isInteger(this.width) ||
      this.width < 4 ||
      this.width > 21600 ||
      this.width !== 2 * (this.height - 1) ||
      !Number.isFinite(this.offset) ||
      !(this.scale > 0 && this.scale <= 1) ||
      bytes.length - pos !== this.width * this.height * 2
    )
      throw new Error("Invalid geoid dimensions");
    this.data = new DataView(
      bytes.buffer,
      bytes.byteOffset + pos,
      bytes.byteLength - pos,
    );
  }
  undulation(lat, lon) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90)
      throw new Error("Invalid geoid coordinate");
    const x = ((((lon % 360) + 360) % 360) * this.width) / 360,
      y = ((90 - lat) * (this.height - 1)) / 180,
      ix = Math.floor(x) % this.width,
      iy = Math.min(Math.floor(y), this.height - 2),
      dx = x - Math.floor(x),
      dy = y - iy;
    const sample = (col, row) =>
      this.offset +
      this.scale *
        this.data.getUint16(2 * (row * this.width + (col % this.width)), false);
    return (
      (sample(ix, iy) * (1 - dx) + sample(ix + 1, iy) * dx) * (1 - dy) +
      (sample(ix, iy + 1) * (1 - dx) + sample(ix + 1, iy + 1) * dx) * dy
    );
  }
}
