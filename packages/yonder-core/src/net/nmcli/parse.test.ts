// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTerse, parseDeviceShow } from "./parse.js";

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

/**
 * The parser behind the access-point fallback, and the one call in this
 * client whose output shape has never been seen on real hardware. Everything
 * here is written from the documented grammar of `nmcli -t` and is the first
 * thing docs/hardware/verifying-m1a.md asks a board to confirm.
 */
describe("parseDeviceShow", () => {
  it("accumulates addresses per device across a field stream", () => {
    expect(parseDeviceShow(
      "GENERAL.DEVICE:eth0\nIP4.ADDRESS[1]:192.168.1.50/24\nGENERAL.DEVICE:wlan0\n",
    )).toEqual([
      { device: "eth0", addresses: ["192.168.1.50/24"] },
      { device: "wlan0", addresses: [] },
    ]);
  });

  it("keeps every address of a device holding several", () => {
    expect(parseDeviceShow(
      "GENERAL.DEVICE:eth0\nIP4.ADDRESS[1]:192.168.1.50/24\nIP4.ADDRESS[2]:10.42.0.1/24\n",
    )).toEqual([{ device: "eth0", addresses: ["192.168.1.50/24", "10.42.0.1/24"] }]);
  });

  it("accepts the unindexed IP4.ADDRESS spelling too", () => {
    expect(parseDeviceShow("GENERAL.DEVICE:eth0\nIP4.ADDRESS:192.168.1.50/24\n"))
      .toEqual([{ device: "eth0", addresses: ["192.168.1.50/24"] }]);
  });

  it("treats an empty address value as no address", () => {
    // Some versions print the field with nothing after the colon rather than
    // omitting the line. Either way the device holds no address.
    expect(parseDeviceShow("GENERAL.DEVICE:wlan0\nIP4.ADDRESS[1]:\n"))
      .toEqual([{ device: "wlan0", addresses: [] }]);
  });

  it("ignores fields it does not recognise, and blank separator lines", () => {
    expect(parseDeviceShow(
      "GENERAL.DEVICE:eth0\nGENERAL.TYPE:ethernet\nIP6.ADDRESS[1]:fe80::1/64\n\nGENERAL.DEVICE:wlan0\n",
    )).toEqual([
      { device: "eth0", addresses: [] },
      { device: "wlan0", addresses: [] },
    ]);
  });

  /**
   * The failure this parser exists to make impossible. `parseTerse(out, 2)`
   * read `GENERAL.DEVICE:eth0` as the record {device: "GENERAL.DEVICE",
   * address: "eth0"} — an address that does not exist — and the fallback
   * watchdog read that as "something is reachable" and stood down. A parser
   * for a safety probe may lose an address; it may never invent one.
   */
  it("never reports an address for a device that holds none", () => {
    const out = parseDeviceShow("GENERAL.DEVICE:eth0\nGENERAL.DEVICE:wlan0\nGENERAL.DEVICE:lo\n");
    expect(out.flatMap((d) => d.addresses)).toEqual([]);
  });

  it("drops an address that arrives before any device line", () => {
    // Unattributable: nothing says which interface holds it, and an address
    // we cannot attribute is not evidence that anything is reachable.
    expect(parseDeviceShow("IP4.ADDRESS[1]:192.168.1.50/24\n")).toEqual([]);
  });

  it("returns nothing for empty output", () => {
    expect(parseDeviceShow("")).toEqual([]);
  });

  it("parses the recorded device show", () => {
    expect(parseDeviceShow(fixture("device-show-ip4.txt"))).toEqual([
      { device: "eth0", addresses: ["192.168.1.50/24"] },
      { device: "wlan0", addresses: [] },
      { device: "lo", addresses: ["127.0.0.1/8"] },
    ]);
  });
});
