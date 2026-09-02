// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseInfo, parseNetworks } from "./parse.js";

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, "fixtures", `${name}.json`), "utf8");

describe("parseInfo", () => {
  it("reads the node address, which is what the operator must approve", () => {
    expect(parseInfo(fixture("info"))).toEqual({
      address: "9fef8a3bf9",
      online: true,
      version: "1.16.2",
    });
  });

  it("throws on output that is not JSON, rather than returning a hollow record", () => {
    expect(() => parseInfo("200 info 9fef8a3bf9 1.16.2 ONLINE")).toThrow(/could not be read/);
  });
});

describe("parseNetworks", () => {
  it("reads nothing from a node that has joined nothing", () => {
    expect(parseNetworks(fixture("listnetworks-empty"))).toEqual([]);
  });

  it("reads a join that is still handshaking", () => {
    const [n] = parseNetworks(fixture("listnetworks-requesting"));
    expect(n.nwid).toBe("1234567890abcdef");
    expect(n.status).toBe("REQUESTING_CONFIGURATION");
    expect(n.assignedAddresses).toEqual([]);
  });

  // The name is empty until the device is authorised, so the console can never
  // tell the operator which network it is waiting on by name - only by id.
  it("reads a join waiting to be authorised, and carries no network name", () => {
    const [n] = parseNetworks(fixture("listnetworks-access-denied"));
    expect(n.status).toBe("ACCESS_DENIED");
    expect(n.name).toBe("");
    expect(n.portDeviceName).toBe("ztuqliuo7y");
  });

  it("reads an authorised join and its address", () => {
    const [n] = parseNetworks(fixture("listnetworks-ok"));
    expect(n.status).toBe("OK");
    expect(n.name).toBe("yonder-probe");
    expect(n.assignedAddresses).toEqual(["10.147.20.26/24"]);
  });

  // A status this version has never seen must not crash the status line.
  it("keeps a status it does not recognise rather than discarding the network", () => {
    const [n] = parseNetworks('[{"nwid":"9fef8a3bf9000001","status":"SOMETHING_NEW"}]');
    expect(n.status).toBe("SOMETHING_NEW");
  });

  it("throws on output that is not JSON", () => {
    expect(() => parseNetworks("200 listnetworks <nwid> <name>")).toThrow(/could not be read/);
  });
});
