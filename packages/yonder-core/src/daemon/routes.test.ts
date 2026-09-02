// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRouter, type Router } from "./routes.js";
import { ApplyEngine } from "../apply/engine.js";
import { saveConfig } from "../config/save.js";
import { SecretStore } from "../secrets/store.js";
import { DEFAULT_CONFIG, type Config } from "../schema/config.js";
import { AdminCredential } from "../console/credential.js";
import { AttemptThrottle, FAILURE_LIMIT, LOCKOUT_MS } from "../console/throttle.js";
import type { Clock, Renderer } from "../apply/types.js";

/**
 * The routes that own the administrator password, and the gate R-SEC-09 puts
 * in front of everything else.
 *
 * The property these tests exist for is structural: **until a password is
 * set, this socket answers nothing about the device's configuration.** Not
 * "the console does not ask" — the socket is the boundary, and a boundary
 * that depends on the caller being polite is not one.
 */

let dir: string, configPath: string, journalPath: string, secretsPath: string;
const noopRenderer: Renderer = { name: "noop", async render() {} };
const frozenClock: Clock = { now: () => 0, setTimer: () => 1, clearTimer: () => {} };

const GOOD = "a long enough password";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yonder-routes-"));
  configPath = join(dir, "config.yaml");
  journalPath = join(dir, "apply.json");
  secretsPath = join(dir, "secrets.yaml");
  saveConfig(configPath, DEFAULT_CONFIG);
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function router(opts: { credential?: AdminCredential | undefined; throttle?: AttemptThrottle } = {}): Router {
  const engine = new ApplyEngine({ configPath, journalPath, renderers: [noopRenderer], clock: frozenClock });
  const credential = "credential" in opts
    ? opts.credential
    : new AdminCredential(new SecretStore(secretsPath));
  return createRouter({
    engine,
    configPath,
    credential,
    ...(opts.throttle === undefined ? {} : { throttle: opts.throttle }),
  });
}

/** A router on a device that already has an administrator password. */
function provisionedRouter(throttle?: AttemptThrottle): Router {
  new AdminCredential(new SecretStore(secretsPath)).set(GOOD);
  return router(throttle === undefined ? {} : { throttle });
}

function changed(): Config {
  const c = structuredClone(DEFAULT_CONFIG);
  c.system.hostname = "changed";
  return c;
}

/** Everything the daemon wrote to the journal while `work` ran. */
async function captureLog(work: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation((c) => { lines.push(String(c)); return true; });
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((c) => { lines.push(String(c)); return true; });
  try {
    await work();
  } finally {
    stderr.mockRestore();
    stdout.mockRestore();
  }
  return lines.join("");
}

describe("GET /console/state", () => {
  it("answers before an administrator password exists — it is the one route that does", async () => {
    const res = await router()("GET", "/console/state", undefined);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ provisioned: false });
  });

  it("says provisioned once one is set", async () => {
    const res = await provisionedRouter()("GET", "/console/state", undefined);
    expect(res.body).toEqual({ provisioned: true });
  });

  /**
   * One boolean, and nothing else. R-SEC-09 says a device without a password
   * offers no function but setting one, and a version string, a hostname or
   * an apply state is a function. Asserted as an exact shape rather than a
   * property check, so a field added here fails loudly.
   */
  it("carries nothing but that one boolean", async () => {
    const res = await router()("GET", "/console/state", undefined);
    expect(Object.keys(res.body as object)).toEqual(["provisioned"]);
  });
});

describe("the gate in front of the configuration routes", () => {
  it("refuses GET /config with 403 while unprovisioned, and answers it after", async () => {
    const unprovisioned = await router()("GET", "/config", undefined);
    expect(unprovisioned.status).toBe(403);
    expect((unprovisioned.body as { error: string }).error).toMatch(/administrator password/);
    // And it gives away nothing about the configuration on the way past.
    expect(JSON.stringify(unprovisioned.body)).not.toContain("192.168");

    const provisioned = await provisionedRouter()("GET", "/config", undefined);
    expect(provisioned.status).toBe(200);
    expect((provisioned.body as Config).version).toBe(1);
  });

  it("refuses POST /apply and POST /confirm while unprovisioned", async () => {
    const r = router();
    expect((await r("POST", "/apply", changed())).status).toBe(403);
    expect((await r("POST", "/confirm", { id: "anything" })).status).toBe(403);
  });

  it("refuses an unknown route while unprovisioned rather than saying it is unknown", async () => {
    // 404 would confirm which routes exist. There is nothing behind the gate
    // to enumerate until a password is set.
    expect((await router()("GET", "/nope", undefined)).status).toBe(403);
  });

  /**
   * GET /status is deliberately in front of the gate: it carries no
   * configuration, and it is what makes a device whose secrets.yaml cannot be
   * read diagnosable at all.
   */
  it("leaves GET /status answering while unprovisioned", async () => {
    const res = await router()("GET", "/status", undefined);
    expect(res.status).toBe(200);
    expect((res.body as { state: string }).state).toBe("idle");
  });

  it("writes nothing to config.yaml on a refused apply", async () => {
    const before = readFileSync(configPath, "utf8");
    await router()("POST", "/apply", changed());
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });
});

describe("POST /admin/password", () => {
  it("sets the password once", async () => {
    const r = router();
    const res = await r("POST", "/admin/password", { password: GOOD });
    expect(res.status).toBe(200);
    expect((await r("GET", "/console/state", undefined)).body).toEqual({ provisioned: true });
  });

  /**
   * The second attempt is 409, not 200. A device that lets an
   * unauthenticated caller replace the administrator password has no lock on
   * it: whoever reached the console second would simply overwrite the first
   * operator's.
   */
  it("is 409 the second time, and the first password still works", async () => {
    const r = router();
    await r("POST", "/admin/password", { password: GOOD });
    const again = await r("POST", "/admin/password", { password: "a different password" });
    expect(again.status).toBe(409);

    expect((await r("POST", "/admin/verify", { password: GOOD })).body).toEqual({ ok: true });
    expect((await r("POST", "/admin/verify", { password: "a different password" })).body)
      .toEqual({ ok: false });
  });

  it("is 400 for a password that fails the length rule, and sets nothing", async () => {
    const r = router();
    const res = await r("POST", "/admin/password", { password: "short" });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/at least 8/);
    expect((await r("GET", "/console/state", undefined)).body).toEqual({ provisioned: false });
  });

  it("is 400 for a body with no password in it", async () => {
    const r = router();
    for (const body of [undefined, {}, { password: null }, { password: 12345678 }, "password"]) {
      expect((await r("POST", "/admin/password", body)).status, JSON.stringify(body)).toBe(400);
    }
  });

  it("opens the configuration routes that were shut", async () => {
    const r = router();
    expect((await r("GET", "/config", undefined)).status).toBe(403);
    await r("POST", "/admin/password", { password: GOOD });
    expect((await r("GET", "/config", undefined)).status).toBe(200);
  });
});

/**
 * Setting the password changes what the console is, and that shape is decided
 * when settings.js is generated — so something has to rewrite it. The route's
 * side of that contract is narrow and worth pinning: called once, on success
 * only, and never able to turn a set password into a failed request.
 */
describe("the console-restart hook", () => {
  function withHook(hook: () => void): Router {
    const engine = new ApplyEngine({ configPath, journalPath, renderers: [noopRenderer], clock: frozenClock });
    return createRouter({
      engine,
      configPath,
      credential: new AdminCredential(new SecretStore(secretsPath)),
      onProvisioned: hook,
    });
  }

  it("is called once when a password is set", async () => {
    let calls = 0;
    const r = withHook(() => { calls += 1; });
    await r("POST", "/admin/password", { password: GOOD });
    expect(calls).toBe(1);
  });

  it("is not called when the password is refused", async () => {
    let calls = 0;
    const r = withHook(() => { calls += 1; });
    await r("POST", "/admin/password", { password: "short" });
    await r("POST", "/admin/password", {});
    expect(calls).toBe(0);
  });

  it("is not called again when a second attempt is refused as already set", async () => {
    let calls = 0;
    const r = withHook(() => { calls += 1; });
    await r("POST", "/admin/password", { password: GOOD });
    const again = await r("POST", "/admin/password", { password: "another one entirely" });
    expect(again.status).toBe(409);
    expect(calls).toBe(1);
  });

  it("cannot turn a password that was set into a failed request", async () => {
    // The password is stored either way. A console that did not get restarted
    // comes back into the right mode on the next apply or the next boot,
    // which is not worth telling the operator their password did not take.
    const captured = await captureLog(async () => {
      const r = withHook(() => { throw new Error("systemctl is not here"); });
      const res = await r("POST", "/admin/password", { password: GOOD });
      expect(res.status).toBe(200);
      expect((await r("GET", "/console/state", undefined)).body).toEqual({ provisioned: true });
    });
    expect(captured).toContain("could not be scheduled");
  });
});

describe("POST /admin/verify", () => {
  it("is true for the password and false for anything else", async () => {
    const r = provisionedRouter();
    expect((await r("POST", "/admin/verify", { password: GOOD })).body).toEqual({ ok: true });
    expect((await r("POST", "/admin/verify", { password: "wrong" })).body).toEqual({ ok: false });
  });

  it("is false, never an error, on a device with no password set", async () => {
    const res = await router()("POST", "/admin/verify", { password: GOOD });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false });
  });

  it("is false for a body with no password in it", async () => {
    const r = provisionedRouter();
    for (const body of [undefined, {}, { password: null }]) {
      expect((await r("POST", "/admin/verify", body)).body, JSON.stringify(body)).toEqual({ ok: false });
    }
  });

  it("is 429 with a retryAfter once the threshold is passed", async () => {
    let t = 1_000_000;
    const clock: Clock = { now: () => t, setTimer: () => 1, clearTimer: () => {} };
    const throttle = new AttemptThrottle({ clock });
    const r = provisionedRouter(throttle);

    for (let i = 0; i < FAILURE_LIMIT; i++) {
      const res = await r("POST", "/admin/verify", { password: "wrong" });
      expect(res.status, `attempt ${i + 1}`).toBe(200);
    }
    const refused = await r("POST", "/admin/verify", { password: "wrong" });
    expect(refused.status).toBe(429);
    expect(refused.body).toEqual({ ok: false, retryAfter: LOCKOUT_MS / 1000 });

    // Refused even for the right password: the throttle is checked before
    // anything is derived, which is what stops a caller using login attempts
    // to keep this daemon's event loop busy.
    expect((await r("POST", "/admin/verify", { password: GOOD })).status).toBe(429);

    t += LOCKOUT_MS;
    expect((await r("POST", "/admin/verify", { password: GOOD })).body).toEqual({ ok: true });
  });

  it("resets the count when the right password arrives", async () => {
    let t = 1_000_000;
    const clock: Clock = { now: () => t, setTimer: () => 1, clearTimer: () => {} };
    const throttle = new AttemptThrottle({ clock, limit: 3 });
    const r = provisionedRouter(throttle);

    await r("POST", "/admin/verify", { password: "wrong" });
    await r("POST", "/admin/verify", { password: "wrong" });
    expect((await r("POST", "/admin/verify", { password: GOOD })).body).toEqual({ ok: true });
    await r("POST", "/admin/verify", { password: "wrong" });
    await r("POST", "/admin/verify", { password: "wrong" });
    expect((await r("POST", "/admin/verify", { password: "wrong" })).status).toBe(200);
  });
});

/**
 * A secrets.yaml this daemon cannot read is *cannot tell*, not *no password*.
 * The safe direction is to behave as though the device has a lock nobody can
 * open, never as though it needs none — the opposite would reopen the setup
 * page to anyone who could corrupt a file.
 */
describe("when the secret store could not be read at all", () => {
  it("refuses the configuration routes rather than assuming there is no lock", async () => {
    const r = router({ credential: undefined });
    expect((await r("GET", "/config", undefined)).status).toBe(403);
    expect((await r("POST", "/apply", changed())).status).toBe(403);
  });

  it("says it cannot answer GET /console/state, rather than saying unprovisioned", async () => {
    await captureLog(async () => {
      const res = await router({ credential: undefined })("GET", "/console/state", undefined);
      expect(res.status).toBe(503);
      expect(res.body).not.toEqual({ provisioned: false });
    });
  });

  it("refuses to set a password it has nowhere to put", async () => {
    await captureLog(async () => {
      const res = await router({ credential: undefined })("POST", "/admin/password", { password: GOOD });
      expect(res.status).toBe(503);
    });
  });

  it("fails a login closed", async () => {
    const res = await router({ credential: undefined })("POST", "/admin/verify", { password: GOOD });
    expect(res.body).toEqual({ ok: false });
  });
});

/**
 * R-SEC-10. The journal is read by whoever is on the device and travels in a
 * support bundle, and a password in it is a password disclosed to everyone
 * who ever reads either. Asserted against the captured output rather than
 * reviewed by eye, because a new log line three branches away is exactly how
 * this comes back.
 */
describe("no route puts the submitted password in the journal", () => {
  const SECRET = "correct-horse-battery-staple";

  it("does not, on any administrator route, in any outcome", async () => {
    const captured = await captureLog(async () => {
      const r = router();
      await r("POST", "/admin/password", { password: "shrt" });          // refused, too short
      await r("POST", "/admin/password", { password: "   " });           // refused, blank
      await r("POST", "/admin/verify", { password: SECRET });            // no password on the device
      await r("POST", "/admin/password", { password: SECRET });          // accepted
      await r("POST", "/admin/password", { password: SECRET });          // refused, already set
      await r("POST", "/admin/verify", { password: SECRET });            // right
      await r("POST", "/admin/verify", { password: `${SECRET}-wrong` }); // wrong
      await r("GET", "/console/state", undefined);
    });
    expect(captured).not.toContain(SECRET);
    expect(captured).not.toContain("shrt");
  });

  /**
   * The generic 500 branch is the one that logs an arbitrary error message,
   * so it is the one a password could ride out on. Redaction happens where
   * the value is captured — at the top of the router — so this holds without
   * the failing branch knowing anything about passwords.
   */
  it("does not, when a route fails with an error quoting what it was sent", async () => {
    // An engine that throws an error quoting the body back — which is not
    // hypothetical: an NmcliError embeds the stderr of a command whose argv
    // carried the value.
    const engine = {
      apply: (body: unknown) => { throw new Error(`could not apply ${JSON.stringify(body)}`); },
    } as unknown as ApplyEngine;

    new AdminCredential(new SecretStore(secretsPath)).set(GOOD);
    const r = createRouter({
      engine,
      configPath,
      credential: new AdminCredential(new SecretStore(secretsPath)),
    });

    const captured = await captureLog(async () => {
      const res = await r("POST", "/apply", { version: 1, psk: SECRET });
      // The body says nothing either — that is the generic 500 the router
      // has always had, and this must not have punched a hole in it.
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain(SECRET);
    });
    expect(captured).toContain("<redacted>");
    expect(captured).not.toContain(SECRET);
  });
});

describe("the secrets file", () => {
  /**
   * A refused request must leave nothing behind. A secrets.yaml created by a
   * failed attempt would be a file whose mode and contents nobody chose.
   */
  it("is not written at all until a password is actually set", async () => {
    const r = router();
    await r("GET", "/console/state", undefined);
    await r("POST", "/admin/verify", { password: "guess" });
    await r("POST", "/admin/password", { password: "short" });
    expect(existsSync(secretsPath)).toBe(false);

    await r("POST", "/admin/password", { password: GOOD });
    expect(existsSync(secretsPath)).toBe(true);
  });
});

/**
 * Redaction is by value at one choke point, which means a fixed message that
 * happens to contain the submitted password loses that substring too. Noisy,
 * and the harmless direction of the only mistake this mechanism can make:
 * the alternative — deciding per branch what might contain a secret — is how
 * the leak comes back.
 */
describe("redaction at the capture point", () => {
  it("strips the submitted value even out of this daemon's own wording", async () => {
    const captured = await captureLog(async () => {
      await router()("POST", "/admin/password", { password: "short" });
    });
    expect(captured).toContain("<redacted>");
    expect(captured).not.toMatch(/refused: too-short/);
  });
});
