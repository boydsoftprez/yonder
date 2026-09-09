// SPDX-License-Identifier: GPL-3.0-or-later
// Original bilinear reader ported from the working cockpit's geoid_grid.py.
import { readFileSync } from "node:fs";
export class GeoidGrid {
  private data: Buffer;
  private width: number;
  private height: number;
  private offset: number;
  private scale: number;
  constructor(
    bytes = readFileSync(new URL("./assets/egm96-5.pgm", import.meta.url)),
  ) {
    let pos = 0;
    const line = () => {
      const end = bytes.indexOf(10, pos);
      if (end < 0 || end - pos > 1024) throw new Error("Invalid geoid header");
      const s = bytes.toString("ascii", pos, end);
      pos = end + 1;
      return s;
    };
    if (line() !== "P5") throw new Error("Expected GeographicLib binary PGM");
    const metadata: Record<string, string> = {};
    let dimensions = "";
    for (let i = 0; i < 64; i++) {
      const s = line();
      if (!s.startsWith("#")) {
        dimensions = s;
        break;
      }
      const match = /^#\s*(\S+)\s+(.+)$/.exec(s);
      if (match) metadata[match[1]!] = match[2]!;
    }
    [this.width, this.height] = dimensions.split(/\s+/).map(Number) as [
      number,
      number,
    ];
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
      throw new Error("Invalid geoid dimensions/data");
    this.data = bytes.subarray(pos);
  }
  undulation(lat: number, lon: number): number {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90)
      throw new Error("Invalid geoid coordinates");
    const x = ((((lon % 360) + 360) % 360) * this.width) / 360,
      y = ((90 - lat) * (this.height - 1)) / 180;
    const ix = Math.floor(x) % this.width,
      iy = Math.min(Math.floor(y), this.height - 2),
      dx = x - Math.floor(x),
      dy = y - iy;
    const sample = (col: number, row: number) =>
      this.offset +
      this.scale *
        this.data.readUInt16BE(2 * (row * this.width + (col % this.width)));
    const north = sample(ix, iy) * (1 - dx) + sample(ix + 1, iy) * dx,
      south = sample(ix, iy + 1) * (1 - dx) + sample(ix + 1, iy + 1) * dx;
    return north * (1 - dy) + south * dy;
  }
}
