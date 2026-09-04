// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { boundedRunner, redactArgv, redactText, systemRunner } from "./runner.js";

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

describe("redactText", () => {
  /** nmcli quotes back what it could not accept, key included. */
  it("removes a secret the argv carried from the text", () => {
    const argv = ["nmcli", "connection", "modify", "yonder-ap", "802-11-wireless-security.psk", "hunter2hunter2"];
    const stderr = "Error: invalid property: 802-11-wireless-security.psk: 'hunter2hunter2' is too short.";
    const out = redactText(stderr, argv);
    expect(out).not.toContain("hunter2hunter2");
    expect(out).toContain("<redacted>");
  });

  it("removes every occurrence, not just the first", () => {
    const argv = ["x", "password", "s3cret"];
    expect(redactText("s3cret and s3cret again", argv)).toBe("<redacted> and <redacted> again");
  });

  it("leaves text alone when the argv carried no secret", () => {
    expect(redactText("Error: activation failed", ["nmcli", "connection", "up", "yonder-ap"]))
      .toBe("Error: activation failed");
  });

  it("does not redact an empty value into every gap in the text", () => {
    expect(redactText("Error: nothing", ["x", "password", ""])).toBe("Error: nothing");
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

  /**
   * A wedged ModemManager holds `mmcli` on a D-Bus call that never returns,
   * and with no `timeout` on execFile the daemon waited for it for the life
   * of the process. Run at 50 ms rather than the shipped two minutes: what is
   * being tested is that there is a bound at all, not what it is set to.
   */
  it("kills a command that never returns, rather than waiting for ever", async () => {
    const r = await boundedRunner(50)(["sleep", "30"]);
    expect(r.code).not.toBe(0);
  });

  /**
   * A renderer that needs one variable set for one command must actually get
   * it. `systemctl enable`/`disable` inside this daemon's sandbox is the case
   * this exists for (see remote/renderer.ts) and it is not something a board
   * should have to be borrowed to discover.
   */
  it("passes a caller's environment variable to the child", async () => {
    const r = await systemRunner(
      ["sh", "-c", "printf %s \"$YONDER_RUNNER_TEST\""],
      { env: { YONDER_RUNNER_TEST: "set-by-the-caller" } },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("set-by-the-caller");
  });

  /**
   * Laid *over* the daemon's environment, never replacing it. A child handed
   * only the one variable loses PATH, and every renderer that names a binary
   * rather than a path stops working.
   */
  it("leaves the rest of the environment in place when a variable is added", async () => {
    const r = await systemRunner(
      ["sh", "-c", "printf %s \"$PATH\""],
      { env: { YONDER_RUNNER_TEST: "1" } },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(process.env.PATH ?? "");
  });
});
