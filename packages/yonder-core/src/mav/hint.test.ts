// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { forgetHint, readHint, writeHint } from "./hint.js";

const scratch = () => join(mkdtempSync(join(tmpdir(), "yonder-hint-")), "link.json");

describe("the remembered port and speed", () => {
  it("round-trips", () => {
    const p = scratch();
    writeHint(p, { device: "/dev/ttyAMA0", baud: 57600 });
    expect(readHint(p)).toEqual({ device: "/dev/ttyAMA0", baud: 57600 });
  });

  it("is undefined when it has never been written", () => {
    expect(readHint(scratch())).toBeUndefined();
  });

  // A hint is an optimisation. Anything wrong with it must degrade to the
  // full sweep, never to a failed boot — this file is on the path to
  // telemetry starting at all (R-MAV-08).
  it("is undefined rather than an exception when the file is corrupt", () => {
    const p = scratch();
    writeFileSync(p, "{ this is not json");
    expect(readHint(p)).toBeUndefined();
  });

  it("is undefined when the file is valid json of the wrong shape", () => {
    const p = scratch();
    writeFileSync(p, JSON.stringify({ device: "/dev/ttyAMA0", baud: "fast" }));
    expect(readHint(p)).toBeUndefined();
  });

  it("refuses a baud that is not one we sweep", () => {
    const p = scratch();
    writeFileSync(p, JSON.stringify({ device: "/dev/ttyAMA0", baud: 9600 }));
    expect(readHint(p)).toBeUndefined();
  });

  // The other half of "valid json of the wrong shape": a device field of the
  // right *type* but a value nothing should ever open. Deleting just the
  // length check (keeping the type check) lets this through as a real hint —
  // verified in task-7-report.md's review-round-2 section by actually
  // deleting it and watching this test fail.
  it("refuses an empty-string device", () => {
    const p = scratch();
    writeFileSync(p, JSON.stringify({ device: "", baud: 57600 }));
    expect(readHint(p)).toBeUndefined();
  });

  it("can be forgotten, and forgetting one that is not there is not an error", () => {
    const p = scratch();
    writeHint(p, { device: "/dev/ttyAMA0", baud: 57600 });
    forgetHint(p);
    expect(readHint(p)).toBeUndefined();
    expect(() => forgetHint(p)).not.toThrow();
  });

  // --- Beyond the brief: gaps in the failure modes above --------------------

  // JSON.parse happily returns a non-object top-level value — a bare literal
  // is exactly what a naive "clear the hint" writer might produce instead of
  // deleting the file. This exercises the `parsed === null` guard, which
  // "wrong shape" above never reaches because that test keeps an object at
  // the top level and only breaks a field inside it.
  it("is undefined when the file holds valid json that is not an object", () => {
    const p = scratch();
    writeFileSync(p, "null");
    expect(readHint(p)).toBeUndefined();
  });

  // A bare non-null primitive at the top level (as opposed to null, above).
  // Kept as a characterization test of the whole read path rather than of one
  // guard clause — see task-7-report.md's review-round-2 section for why:
  // destructuring a primitive box-converts it and yields undefined fields
  // rather than throwing, so `typeof device !== "string"` catches this on its
  // own even without a top-level `typeof parsed !== "object"` check. Both
  // guard shapes were tried against this exact case; only the one that
  // survives is in hint.ts now.
  it("is undefined when the file holds a bare top-level primitive", () => {
    const p = scratch();
    writeFileSync(p, "42");
    expect(readHint(p)).toBeUndefined();
  });

  // An array is also `typeof … === "object"` and not null, so it passes the
  // top-level guard and has to be caught by the per-field checks instead —
  // a distinct branch from both the null case above and the wrong-field-type
  // case the brief covers.
  it("is undefined when the json is an array rather than a record", () => {
    const p = scratch();
    writeFileSync(p, JSON.stringify(["/dev/ttyAMA0", 57600]));
    expect(readHint(p)).toBeUndefined();
  });

  // Distinct from "corrupt" above: a write torn off by a power cut or a full
  // disk leaves a *prefix* of valid-looking JSON, not scrambled bytes. Still
  // caught by the same JSON.parse/catch, but worth pinning by name since it
  // is the failure mode this file's atomic write exists to make rare, not
  // the one it makes impossible — the hint could still predate this code, or
  // be dropped there by something other than writeHint.
  it("is undefined when the file was truncated mid-write", () => {
    const p = scratch();
    const full = JSON.stringify({ device: "/dev/ttyAMA0", baud: 57600 });
    writeFileSync(p, full.slice(0, full.length - 5));
    expect(readHint(p)).toBeUndefined();
  });

  // The brief's scratch() always hands writeHint a path whose parent
  // (the mkdtemp directory itself) already exists, so it never exercises
  // directory creation. A real board's first boot writes this file before
  // anything else has necessarily created its parent, so this has to work.
  it("creates the hint's directory when it does not exist yet", () => {
    const base = mkdtempSync(join(tmpdir(), "yonder-hint-"));
    const nested = join(base, "state", "mav", "link.json");
    writeHint(nested, { device: "/dev/ttyAMA0", baud: 115200 });
    expect(readHint(nested)).toEqual({ device: "/dev/ttyAMA0", baud: 115200 });
  });

  // The other half of the same gap: forgetting a hint that was never written
  // under a directory that was never created either — still not an error.
  it("forgetting a hint under a directory that was never created is not an error", () => {
    const base = mkdtempSync(join(tmpdir(), "yonder-hint-"));
    const nested = join(base, "never", "created", "link.json");
    expect(() => forgetHint(nested)).not.toThrow();
    expect(readHint(nested)).toBeUndefined();
  });

  // Pins the file-mode choice: a port and a baud rate are not a secret (they
  // are already visible in an unauthenticated /status reply), unlike
  // secrets.yaml's 0600, so this should read 0644 the way the ZeroTier
  // membership record and config.yaml itself do.
  it("writes the hint at mode 0644", () => {
    const p = scratch();
    writeHint(p, { device: "/dev/ttyAMA0", baud: 57600 });
    expect(statSync(p).mode & 0o777).toBe(0o644);
  });

  it("leaves no temporary file behind after writing", () => {
    const p = scratch();
    writeHint(p, { device: "/dev/ttyAMA0", baud: 57600 });
    expect(existsSync(`${p}.tmp`)).toBe(false);
  });
});
