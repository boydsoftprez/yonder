// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTerse } from "./parse.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(here, "fixtures", name), "utf8");

describe("parseTerse", () => {
  it("splits plain records on unescaped colons", () => {
    expect(parseTerse("eth0:ethernet:connected\n", 3)).toEqual([["eth0", "ethernet", "connected"]]);
  });

  it("keeps an escaped colon inside a field", () => {
    // An SSID or a MAC address can legitimately contain a colon; nmcli escapes it.
    expect(parseTerse("wlan0:wifi:AA\\:BB\\:CC\n", 3)).toEqual([["wlan0", "wifi", "AA:BB:CC"]]);
  });

  it("unescapes a literal backslash", () => {
    expect(parseTerse("a\\\\b:x\n", 2)).toEqual([["a\\b", "x"]]);
  });

  it("keeps empty fields", () => {
    expect(parseTerse("eth0::connected\n", 3)).toEqual([["eth0", "", "connected"]]);
  });

  it("ignores blank lines and a trailing newline", () => {
    expect(parseTerse("a:b\n\nc:d\n", 2)).toEqual([["a", "b"], ["c", "d"]]);
  });

  it("returns nothing for empty output", () => {
    expect(parseTerse("", 2)).toEqual([]);
  });

  it("throws when a record has the wrong field count", () => {
    expect(() => parseTerse("a:b:c\n", 2)).toThrow(/expected 2 fields/);
  });

  it("parses recorded device status", () => {
    const rows = parseTerse(fixture("device-status.txt"), 4);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.length === 4)).toBe(true);
    expect(rows.map((r) => r[0])).toContain("wlan0");
  });

  it("parses recorded connection list", () => {
    const rows = parseTerse(fixture("connection-list.txt"), 4);
    expect(rows.every((r) => r.length === 4)).toBe(true);
  });

  it("parses a recorded wifi scan including an SSID containing a colon", () => {
    const rows = parseTerse(fixture("wifi-scan.txt"), 3);
    expect(rows.every((r) => r.length === 3)).toBe(true);
    expect(rows.some((r) => r[0].includes(":"))).toBe(true);
  });
});
