// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { redactArgv, systemRunner } from "./runner.js";

describe("redactArgv", () => {
  it("redacts the value after a wifi-security psk key", () => {
    const argv = ["connection", "modify", "Hotspot", "wifi-sec.psk", "hunter2hunter2"];
    expect(redactArgv(argv)).toEqual(["connection", "modify", "Hotspot", "wifi-sec.psk", "<redacted>"]);
  });

  it("redacts every known secret-bearing key", () => {
    for (const key of ["wifi-sec.psk", "802-11-wireless-security.psk", "gsm.password", "password"]) {
      expect(redactArgv(["x", key, "s3cret"])).toEqual(["x", key, "<redacted>"]);
    }
  });

  it("leaves an argv with no secret untouched", () => {
    const argv = ["device", "status"];
    expect(redactArgv(argv)).toEqual(argv);
  });

  it("does not redact a value that merely looks like a key", () => {
    expect(redactArgv(["connection", "show", "psk-test-network"])).toEqual(
      ["connection", "show", "psk-test-network"],
    );
  });
});

describe("systemRunner", () => {
  it("returns stdout and a zero code for a command that succeeds", async () => {
    const r = await systemRunner(["true"]);
    expect(r.code).toBe(0);
  });

  it("returns a non-zero code rather than throwing", async () => {
    const r = await systemRunner(["false"]);
    expect(r.code).not.toBe(0);
  });

  it("returns a non-zero code when the binary does not exist", async () => {
    const r = await systemRunner(["yonder-no-such-binary-exists"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr.length).toBeGreaterThan(0);
  });
});
