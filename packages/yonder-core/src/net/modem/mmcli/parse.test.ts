// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { arrayAt, parseKeyValue } from "./parse.js";

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, "fixtures", `${name}.txt`), "utf8");

describe("parseKeyValue", () => {
  it("reads a key and its value across the padding mmcli aligns with", () => {
    const r = parseKeyValue(fixture("modem-show"));
    expect(r["modem.generic.model"]).toBe("EC25");
    expect(r["modem.3gpp.operator-name"]).toBe("Dark Star");
  });

  it("reads `--` as absent rather than as the string it looks like", () => {
    const r = parseKeyValue(fixture("modem-show"));
    expect(r["modem.generic.state-failed-reason"]).toBeNull();
  });

  it("keeps a value containing a colon whole", () => {
    // An IPv6 address is the case that breaks a naive split(":").
    const r = parseKeyValue(fixture("bearer-connected"));
    expect(r["bearer.ipv6-config.address"]).toBe("2600:382:859c:df48:40b3:9486:1d36:cb26");
  });

  it("ignores a blank line", () => {
    expect(parseKeyValue("\n\na : b\n\n")).toEqual({ a: "b" });
  });
});

describe("arrayAt", () => {
  it("reads a length-and-value array in index order", () => {
    const r = parseKeyValue(fixture("modem-show"));
    expect(arrayAt(r, "modem.generic.ports")).toEqual([
      "cdc-wdm0 (mbim)", "ttyUSB0 (ignored)", "ttyUSB1 (gps)",
      "ttyUSB2 (at)", "ttyUSB3 (at)", "wwan0 (net)",
    ]);
  });

  it("is empty when there is no such array", () => {
    expect(arrayAt(parseKeyValue(fixture("modem-show")), "modem.nothing")).toEqual([]);
  });

  it("reads the modem list", () => {
    expect(arrayAt(parseKeyValue(fixture("modem-list")), "modem-list"))
      .toEqual(["/org/freedesktop/ModemManager1/Modem/0"]);
  });
});
