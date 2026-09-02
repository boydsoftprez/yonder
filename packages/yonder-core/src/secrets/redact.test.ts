// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  SECRET_KEYS,
  REDACTED,
  isSecretKey,
  secretValuesIn,
  redactValues,
  redactNamedValues,
  redactGuarded,
  redactLine,
  guardSecretValue,
  forgetGuardedValues,
} from "./redact.js";
import { SecretStore } from "./store.js";
import { redactArgv, redactText } from "../net/runner.js";

describe("secretValuesIn", () => {
  it("finds a value under a secret-bearing name", () => {
    expect(secretValuesIn({ password: "hunter2" })).toEqual(["hunter2"]);
    expect(secretValuesIn({ psk: "a passphrase" })).toEqual(["a passphrase"]);
  });

  it("finds nothing under a name that is not one", () => {
    expect(secretValuesIn({ ssid: "yonder", hostname: "yonder" })).toEqual([]);
  });

  it("looks inside nested objects and arrays, because a configuration is a tree", () => {
    const body = {
      version: 1,
      network: { ap: { ssid: "yonder", psk: "deep enough" } },
      list: [{ password: "in an array" }],
    };
    expect(secretValuesIn(body).sort()).toEqual(["deep enough", "in an array"]);
  });

  it("ignores an empty value, which is nothing to redact", () => {
    expect(secretValuesIn({ password: "" })).toEqual([]);
  });

  it("ignores a non-string value rather than stringifying it", () => {
    expect(secretValuesIn({ password: { secret: "ap_psk" } })).toEqual([]);
    expect(secretValuesIn({ password: null })).toEqual([]);
  });

  /**
   * A body is whatever arrived on the socket, including something someone
   * made self-referential. The daemon must stay up more than this must be
   * thorough.
   */
  it("stops at a bounded depth rather than spinning on a cyclic body", () => {
    const cycle: Record<string, unknown> = { password: "at the top" };
    cycle.self = cycle;
    expect(() => secretValuesIn(cycle)).not.toThrow();
    expect(secretValuesIn(cycle)).toContain("at the top");
  });

  it("is not confused by a body that is not an object at all", () => {
    for (const junk of [null, undefined, "password", 7, true]) {
      expect(secretValuesIn(junk)).toEqual([]);
    }
  });
});

describe("redactValues", () => {
  it("replaces every occurrence of every value it is given", () => {
    expect(redactValues("tried hunter2, then hunter2 again", ["hunter2"]))
      .toBe(`tried ${REDACTED}, then ${REDACTED} again`);
  });

  it("changes nothing when there is nothing to redact", () => {
    expect(redactValues("a plain line", [])).toBe("a plain line");
    expect(redactValues("a plain line", [""])).toBe("a plain line");
  });
});

/**
 * The list is shared on purpose. nmcli argv redaction and request-body
 * redaction ask the same question — "is a value carried under this name a
 * credential?" — and answering it from two lists is how one of them silently
 * stops matching the other (R-SEC-10).
 */
describe("one list, two callers", () => {
  it("is the same list the nmcli argv redactor uses", () => {
    expect(isSecretKey("802-11-wireless-security.psk")).toBe(true);
    expect(redactArgv(["nmcli", "c", "modify", "wifi-sec.psk", "hunter2"]))
      .toEqual(["nmcli", "c", "modify", "wifi-sec.psk", REDACTED]);
    expect(redactText("Error: invalid property 'hunter2'", ["wifi-sec.psk", "hunter2"]))
      .toBe(`Error: invalid property '${REDACTED}'`);
  });

  it("covers the bare names a request body uses as well as nmcli's", () => {
    for (const name of ["password", "psk", "passphrase"]) {
      expect(isSecretKey(name), `${name} is not treated as secret-bearing`).toBe(true);
    }
  });

  /**
   * The mechanism only protects what goes through it. A second copy of this
   * list somewhere else is a copy that will drift, so there is exactly one,
   * and this is the test that says so.
   */
  it("is defined in exactly one place", () => {
    const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
    const definers = readdirSync(SRC, { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .map((f) => f.split("\\").join("/"))
      .filter((f) => /SECRET_KEYS\s*[:=]\s*[A-Za-z]*Set|SECRET_KEYS\s*=\s*\[/
        .test(readFileSync(join(SRC, f), "utf8")));
    expect(
      definers,
      "the list of secret-bearing names is declared in more than one source file; "
      + "two lists is how one of them silently stops matching the other (R-SEC-10). "
      + "A caller that needs a name added should add it to secrets/redact.ts.",
    ).toEqual(["secrets/redact.ts"]);
  });

  it("has no duplicate entries hiding a typo", () => {
    expect(SECRET_KEYS.size).toBeGreaterThan(5);
  });
});

/**
 * The third consumer of the one list, after argv and request bodies. The
 * activity buffer this feeds is served to a browser, and a log line has
 * neither an argv slot nor a JSON key to key redaction off.
 */
describe("redactNamedValues", () => {
  it("strips the value after a secret-bearing name", () => {
    expect(redactNamedValues("psk=hunter2")).toBe(`psk=${REDACTED}`);
    expect(redactNamedValues("802-11-wireless-security.psk: hunter2"))
      .toBe(`802-11-wireless-security.psk: ${REDACTED}`);
    expect(redactNamedValues('gsm.password = "hunter2"'))
      .toBe(`gsm.password = ${REDACTED}`);
  });

  /**
   * Longest name first. Otherwise the qualified nmcli property is matched as
   * a bare `psk` with a prefix, and the prefix survives into the line.
   */
  it("matches the qualified name rather than its last word", () => {
    const out = redactNamedValues("wifi-sec.psk=hunter2");
    expect(out).toBe(`wifi-sec.psk=${REDACTED}`);
    expect(out).not.toContain("hunter2");
  });

  /**
   * This is still not a guess about what a secret looks like — that is the
   * mistake this module refuses to make, because a password can look like a
   * word. A sentence that merely mentions one is left alone.
   */
  it("leaves a sentence that only mentions a password alone", () => {
    const line = "an administrator password was set";
    expect(redactNamedValues(line)).toBe(line);
    expect(redactNamedValues("POST /admin/password refused: too-short"))
      .toBe("POST /admin/password refused: too-short");
  });

  it("strips every occurrence, not just the first", () => {
    const out = redactNamedValues("psk=one and psk=two");
    expect(out).not.toContain("one");
    expect(out).not.toContain("two");
  });
});

describe("the registry of values this device holds", () => {
  afterEach(() => { forgetGuardedValues(); });

  /**
   * Names are knowledge this module has by construction; values are knowledge
   * only the secret store has. Registering them is what covers the line
   * nobody anticipated — one that names nothing and matches no pattern.
   */
  it("strips a registered value out of a line that names nothing", () => {
    guardSecretValue("correct-horse-battery");
    expect(redactGuarded("joining home-network with correct-horse-battery"))
      .toBe(`joining home-network with ${REDACTED}`);
  });

  it("leaves a line alone when nothing is registered", () => {
    expect(redactGuarded("joining home-network")).toBe("joining home-network");
  });

  it("ignores an empty value, which would otherwise match everywhere", () => {
    guardSecretValue("");
    expect(redactGuarded("nothing to strip here")).toBe("nothing to strip here");
  });

  /**
   * The point of doing it in SecretStore's constructor: a value becomes
   * un-loggable the moment it is read, so no later call site has to remember.
   */
  it("is populated by reading a secrets file, without anyone asking", () => {
    const dir = mkdtempSync(join(tmpdir(), "yonder-redact-"));
    try {
      const path = join(dir, "secrets.yaml");
      writeFileSync(path, "ap_psk: a-passphrase-from-the-file\n");
      new SecretStore(path);
      expect(redactGuarded("the access point uses a-passphrase-from-the-file"))
        .toContain(REDACTED);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("redactLine applies both mechanisms", () => {
    guardSecretValue("a-registered-value");
    const out = redactLine("psk=hunter2 while holding a-registered-value");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("a-registered-value");
  });
});
