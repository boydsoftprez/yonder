// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOOLEAN_CONTROLS, createRouter, requestedControls, type DiagProbes, type Router, type SystemReport } from "./routes.js";
import { ActivityLog } from "../log/activity.js";
import type { ScanResult } from "../net/scan.js";
import type { PingResult } from "../diag/probe.js";
import { ApplyEngine } from "../apply/engine.js";
import { saveConfig } from "../config/save.js";
import { loadConfig } from "../config/load.js";
import { SecretStore } from "../secrets/store.js";
import { DEFAULT_AP_PASSPHRASE } from "../net/profiles.js";
import { MODEM_PASSWORD_SECRET } from "../net/modem/configure.js";
import { ConfigSchema, DEFAULT_CONFIG, type Camera, type Config } from "../schema/config.js";
import { Supervisor } from "../video/supervisor.js";
import { noCapabilities, present, type CameraCapabilities, type VideoFormat } from "../video/capability.js";
import type { ApplyControlsOptions, ApplyControlsResult } from "../video/controls.js";
import type { DetectResult, Detection, Rejection } from "../video/probe/camera.js";
import type { Encoder } from "../video/probe/encoder.js";
import type { SupplyState } from "../system/supply.js";
import { AdminCredential } from "../console/credential.js";
import { AttemptThrottle, FAILURE_LIMIT, LOCKOUT_MS } from "../console/throttle.js";
import type { Clock, Renderer } from "../apply/types.js";
import type { ModemState } from "../net/modem/state.js";
import type { PathName, ReachState } from "../net/reach/standing.js";
import type { RemoteState } from "../remote/state.js";

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
  spawned = [];
  probed = [];
  controlsCalls = [];
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/**
 * Stubs for the four things the page routes read. None of them touches a
 * board, a radio or a `ping`: `scan` and `diag` are given rather than
 * defaulted precisely so a test cannot reach a real one by omission.
 */
const SCAN: ScanResult = {
  interface: "wlan0",
  networks: [
    { ssid: "HomeNetwork", signal: 78, security: "WPA2" },
    { ssid: "Guest:Wifi", signal: 42, security: "WPA2" },
  ],
};

const REPLIED: PingResult = {
  host: "1.1.1.1", reachable: true, transmitted: 3, received: 3, rttMs: 9.117,
};

const FACTS: SystemReport = {
  facts: {
    model: "Raspberry Pi 4 Model B Rev 1.5",
    load: { one: 0.52, five: 0.58, fifteen: 0.59, runnable: 1, total: 342 },
    memory: { totalBytes: 949_059_584, availableBytes: 760_762_368, freeBytes: 455_254_016, usedBytes: 188_297_216 },
    uptimeSeconds: 41.83,
    cpuTemperatureC: 58,
  },
  versions: { yonder: "0.1.0", os: "Debian GNU/Linux 13 (trixie)" },
  display: {
    model: "Raspberry Pi 4 Model B Rev 1.5",
    load: "0.52, 0.58, 0.59",
    memory: "180 MB of 905 MB used (20%)",
    uptime: "41 seconds",
    temperature: "58.0 °C",
    yonder: "0.1.0",
    os: "Debian GNU/Linux 13 (trixie)",
  },
};

/**
 * The camera fixtures.
 *
 * The identities are the bench board's own, out of `probe/fixtures/`: this
 * by-path name, this card, this codec rejection. The format list and the
 * control range beneath them are trimmed to the two sizes and the one control
 * these routes need — what is asserted here is what the routes do with an
 * answer, not the parsing of one, which `probe/camera.test.ts` owns.
 *
 * The by-path name is deliberately **not** the bus id
 * `v4l2-ctl --list-devices` prints beside the card name
 * (`usb-0000:01:00.0-1.3`): that has no entry under `/dev/v4l/by-path/`, so a
 * configuration holding it resolves to nothing.
 */
const CAMERA_BY_PATH = "platform-fd500000.pcie-pci-0000:01:00.0-usb-0:1.3:1.0-video-index0";

const FORMATS: VideoFormat[] = [
  { fourcc: "MJPG", width: 1920, height: 1080, rates: [30] },
  { fourcc: "MJPG", width: 1280, height: 720, rates: [30, 24, 15] },
];

function fixtureCapabilities(): CameraCapabilities {
  return {
    ...noCapabilities(),
    formats: present(FORMATS),
    // `current` is what the device says it is *now*, and the route hands it
    // straight back: R-CTL-10 is a read-back, never a form default.
    brightness: present({ min: 0, max: 255, step: 1, default: 128, current: 96, inactive: false }),
  };
}

/** One camera found, one hardware codec rejected — this board's actual pair. */
function fixtureDetection(): DetectResult {
  return {
    found: [{
      device: "/dev/video0",
      card: "Global Shutter Camera: Global S",
      byPath: CAMERA_BY_PATH,
      byPathStable: true,
      capabilities: fixtureCapabilities(),
    }],
    rejected: [{
      device: "/dev/video10",
      card: "bcm2835-codec-decode",
      reason: "bcm2835-codec-decode is a hardware codec on this board, not a camera; "
        + "it advertises formats it cannot capture (K-40)",
    }],
  };
}

const ENCODER: Encoder = {
  element: "v4l2h264enc", device: "/dev/video11", hardware: true, codec: "h264",
  detail: "hardware H.264 on /dev/video11 — raw in, H.264 out",
};

/** The value the receive-line route resolves, and no other route may. */
const RTSP_PASSWORD = "an-actual-generated-rtsp-password";

const ADDRESSES = ["192.168.77.1", "10.147.17.42"];

/** A configuration with one camera in it, on the by-path name above. */
function cameraConfig(overrides: Partial<Camera> = {}): Config {
  return ConfigSchema.parse({
    ...structuredClone(DEFAULT_CONFIG),
    cameras: [{
      id: "cam0",
      name: "Nose",
      source: "usb",
      device: CAMERA_BY_PATH,
      outputs: [
        { kind: "rtp", host: "192.168.1.50", port: 5600 },
        { kind: "rtsp", password: { secret: "rtsp_password" } },
      ],
      ...overrides,
    }],
  });
}

/** Every pipeline the supervisor was asked to spawn, and every re-probe made. */
let spawned: string[][] = [];
let probed: { node: string; card: string }[] = [];
/** Every call the controls route made to `applyControls`. */
let controlsCalls: ApplyControlsOptions[] = [];

interface RouterOptions {
  credential?: AdminCredential | undefined;
  throttle?: AttemptThrottle;
  scan?: () => Promise<ScanResult>;
  diag?: DiagProbes;
  secrets?: { put(name: string, value: string): void; get?(name: string): string | undefined };
  activity?: ActivityLog;
  system?: () => SystemReport;
  modemState?: () => Promise<ModemState>;
  reachState?: () => Promise<ReachState>;
  /** The mesh join state. Undefined, as in production, unless a test says otherwise. */
  remoteState?: () => Promise<RemoteState>;
  /** Tests one path now, over the same ReachMonitor the automatic probes use. */
  testPath?: (path: PathName) => Promise<boolean>;
  /**
   * What the camera probe answers.
   *
   * **Given, never defaulted**, exactly as `scan` and `diag` are: with a
   * default, any test that reached a camera route would run a real
   * `v4l2-ctl` against whatever machine it happened to be on. Supplying it
   * also writes a configuration carrying one camera, since a camera route
   * with nothing configured has nothing to answer about.
   */
  cameras?: DetectResult;
  /** Overrides on that one configured camera. */
  camera?: Partial<Camera>;
  /** What a single-device re-probe answers, when a test wants it to differ. */
  reprobed?: Detection | Rejection;
  /** The supply register (R-SYS-09). Absent means this board does not expose it. */
  supply?: () => Promise<SupplyState | null>;
  /** What the fake `applyControls` answers. Defaults to nothing applied and nothing refused. */
  controlsResult?: ApplyControlsResult;
}

function router(opts: RouterOptions = {}): Router {
  const engine = new ApplyEngine({ configPath, journalPath, renderers: [noopRenderer], clock: frozenClock });
  const credential = "credential" in opts
    ? opts.credential
    : new AdminCredential(new SecretStore(secretsPath));
  const detection = opts.cameras;
  if (detection !== undefined) saveConfig(configPath, cameraConfig(opts.camera ?? {}));
  // A supervisor whose spawner records an argv and hands back a process that
  // never exits. Nothing here starts gst-launch-1.0, and `frozenClock` never
  // fires the settle timer, so a started camera stays `starting` — which is
  // what a route answering the moment it spawned should report (R-UI-05).
  const supervisor = new Supervisor({
    spawner: (argv) => {
      spawned.push(argv);
      return { kill: () => {}, on: () => {} };
    },
    clock: frozenClock,
  });
  return createRouter({
    engine,
    configPath,
    credential,
    system: opts.system ?? (() => FACTS),
    ...("scan" in opts ? (opts.scan === undefined ? {} : { scan: opts.scan }) : { scan: () => Promise.resolve(SCAN) }),
    ...("diag" in opts ? (opts.diag === undefined ? {} : { diag: opts.diag }) : {
      diag: {
        ping: () => Promise.resolve(REPLIED),
        reachable: () => Promise.resolve(REPLIED),
      },
    }),
    ...("secrets" in opts
      ? (opts.secrets === undefined ? {} : { secrets: opts.secrets })
      : { secrets: { put: () => {} } }),
    ...(opts.activity === undefined ? {} : { activity: opts.activity }),
    ...(opts.throttle === undefined ? {} : { throttle: opts.throttle }),
    ...(opts.modemState === undefined ? {} : { modemState: opts.modemState }),
    ...(opts.reachState === undefined ? {} : { reachState: opts.reachState }),
    ...(opts.remoteState === undefined ? {} : { remoteState: opts.remoteState }),
    ...(opts.testPath === undefined ? {} : { testPath: opts.testPath }),
    ...(opts.supply === undefined ? {} : { supply: opts.supply }),
    ...(detection === undefined ? {} : {
      cameras: {
        detect: () => Promise.resolve(detection),
        probe: (node: string, card: string) => {
          probed.push({ node, card });
          return Promise.resolve(opts.reprobed ?? detection.found[0] ?? detection.rejected[0]);
        },
      },
      encoder: () => Promise.resolve(ENCODER),
      supervisor,
      rtspPassword: () => RTSP_PASSWORD,
      addresses: () => Promise.resolve(ADDRESSES),
      // Given, never a real applyControls — exactly as `cameras` and
      // `encoder` are given rather than defaulted: with a default, any test
      // that reached this route would run a real v4l2-ctl.
      applyControls: (o: ApplyControlsOptions) => {
        controlsCalls.push(o);
        return Promise.resolve(opts.controlsResult ?? { applied: {}, refused: [], clamped: [] });
      },
    }),
  });
}

/** A router on a device that already has an administrator password. */
function provisionedRouter(throttle?: AttemptThrottle): Router {
  new AdminCredential(new SecretStore(secretsPath)).set(GOOD);
  return router(throttle === undefined ? {} : { throttle });
}

/** Provisioned, with whatever else the test wants to stub. */
function provisioned(opts: RouterOptions = {}): Router {
  new AdminCredential(new SecretStore(secretsPath)).set(GOOD);
  return router(opts);
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
    expect((await r("POST", "/revert", { id: "anything" })).status).toBe(403);
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

/**
 * The routes the console's pages read (Task 4 of M1b-2).
 *
 * The property under test is the same one the rest of this file exists for,
 * applied to five more routes: **the socket is the boundary.** A board model,
 * a scan of the air, a probe and an activity log are all function, and R-SEC-09
 * says a device with no administrator password offers none of it.
 */
describe("the page routes", () => {
  const PAGE_ROUTES: [string, string, unknown][] = [
    ["GET", "/system", undefined],
    ["GET", "/net/scan", undefined],
    ["POST", "/diag/ping", { host: "1.1.1.1" }],
    ["GET", "/diag/reachable", undefined],
    ["GET", "/log", undefined],
  ];

  it("every one of them is 403 while unprovisioned", async () => {
    const route = router();
    for (const [method, path, body] of PAGE_ROUTES) {
      const result = await route(method, path, body);
      expect(result.status, `${method} ${path}`).toBe(403);
      expect(JSON.stringify(result.body)).toContain("no administrator password");
    }
  });

  /**
   * *Cannot tell* is not *no password*. A daemon whose secrets.yaml will not
   * parse must behave as though the device has a lock nobody can open
   * (R-SEC-11), not as though it needs none.
   */
  it("every one of them is 403 when the secret store could not be read", async () => {
    const route = router({ credential: undefined });
    for (const [method, path, body] of PAGE_ROUTES) {
      expect((await route(method, path, body)).status, `${method} ${path}`).toBe(403);
    }
  });

  it("every one of them answers once a password is set", async () => {
    const route = provisioned();
    for (const [method, path, body] of PAGE_ROUTES) {
      expect((await route(method, path, body)).status, `${method} ${path}`).toBe(200);
    }
  });
});

describe("GET /system", () => {
  it("reports the board and the versions", async () => {
    const result = await provisioned()("GET", "/system", undefined);
    // `supply` beside them, and null on a board that does not expose the
    // register — unknown, never good (R-SYS-09).
    expect(result.body).toEqual({ ...FACTS, supply: null });
  });

  it("carries no configuration and no secret", async () => {
    const body = JSON.stringify((await provisioned()("GET", "/system", undefined)).body);
    expect(body).not.toContain("ssid");
    expect(body).not.toMatch(/psk|password|passphrase/i);
  });
});

describe("GET /net/scan", () => {
  it("lists what is in the air", async () => {
    const result = await provisioned()("GET", "/net/scan", undefined);
    expect(result.status).toBe(200);
    expect(result.body).toEqual(SCAN);
  });

  /**
   * A scan is a list of what is broadcasting. It is public by construction —
   * anything with a radio can see it — and it must never come back carrying a
   * key for any of it.
   */
  it("never returns a pre-shared key", async () => {
    const body = JSON.stringify((await provisioned()("GET", "/net/scan", undefined)).body);
    expect(body).not.toMatch(/psk|password|passphrase|key/i);
  });

  /**
   * The scan failure path is the one that would leak. `nmcli`'s stderr names
   * an SSID and a driver path, and echoing an arbitrary error message into a
   * response body is how those leave the device.
   */
  it("swallows nmcli's own words when the scan fails", async () => {
    const stderr = "Error: Device 'wlan0' not found: /sys/class/net/wlan0 (brcmfmac)";
    const route = provisioned({ scan: () => Promise.reject(new Error(`nmcli exited 2: ${stderr}`)) });
    const result = await route("GET", "/net/scan", undefined);
    expect(result.status).toBe(500);
    const body = JSON.stringify(result.body);
    expect(body).not.toContain("brcmfmac");
    expect(body).not.toContain("wlan0");
    expect(body).toContain("see the device journal");
  });

  it("says it cannot scan, rather than reporting an empty air, with no network layer", async () => {
    const result = await provisioned({ scan: undefined })("GET", "/net/scan", undefined);
    expect(result.status).toBe(503);
    expect(JSON.stringify(result.body)).toContain("cannot scan");
  });
});

describe("POST /diag/ping", () => {
  it("probes a host and returns the result", async () => {
    const asked: [string, number | undefined][] = [];
    const route = provisioned({
      diag: {
        ping: (host, count) => { asked.push([host, count]); return Promise.resolve(REPLIED); },
        reachable: () => Promise.resolve(REPLIED),
      },
    });
    const result = await route("POST", "/diag/ping", { host: "example.com", count: 4 });
    expect(result.status).toBe(200);
    expect(asked).toEqual([["example.com", 4]]);
  });

  /**
   * The host is operator input on its way to a command line. It is refused
   * here as well as inside the probe, so a page gets a 400 rather than a 200
   * carrying a refusal it has to read the body to notice.
   */
  it("is 400 for a host that is not one, and runs no probe", async () => {
    let ran = false;
    const route = provisioned({
      diag: {
        ping: () => { ran = true; return Promise.resolve(REPLIED); },
        reachable: () => Promise.resolve(REPLIED),
      },
    });
    for (const host of ["8.8.8.8; rm -rf /", "$(whoami)", "-i0.001", "", 42, undefined, null]) {
      const result = await route("POST", "/diag/ping", { host });
      expect(result.status, JSON.stringify(host)).toBe(400);
    }
    expect(await route("POST", "/diag/ping", undefined)).toMatchObject({ status: 400 });
    expect(ran).toBe(false);
  });

  it("does not echo the refused host back into the answer", async () => {
    const result = await provisioned()("POST", "/diag/ping", { host: "<script>alert(1)</script>" });
    expect(JSON.stringify(result.body)).not.toContain("script");
  });
});

describe("GET /diag/reachable", () => {
  it("answers with a probe result", async () => {
    const result = await provisioned()("GET", "/diag/reachable", undefined);
    expect(result.status).toBe(200);
    expect(result.body).toEqual(REPLIED);
  });
});

describe("GET /log", () => {
  it("serves the activity buffer", async () => {
    const activity = new ActivityLog({ clock: frozenClock });
    activity.record("info", "the access point is up");
    activity.record("warn", "could not read the configuration");
    const result = await provisioned({ activity })("GET", "/log", undefined);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      entries: [
        { seq: 1, level: "info", message: "the access point is up" },
        { seq: 2, level: "warn", message: "could not read the configuration" },
      ],
      newestSeq: 2,
    });
  });

  /**
   * `req.url` carries the query string, and every route comparison here is an
   * equality against a path. A route that forgot to split would be a 404 an
   * operator reads as a missing feature.
   */
  it("takes a cursor out of the query string", async () => {
    const activity = new ActivityLog({ clock: frozenClock });
    for (const n of [1, 2, 3]) activity.record("info", `line ${n}`);
    const route = provisioned({ activity });
    const result = await route("GET", "/log?since=2", undefined);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ entries: [{ seq: 3, message: "line 3" }] });
  });

  it("treats a cursor it cannot read as asking for everything", async () => {
    const activity = new ActivityLog({ clock: frozenClock });
    activity.record("info", "one");
    const route = provisioned({ activity });
    for (const query of ["?since=", "?since=nonsense", "?since=-4", "?other=1", ""]) {
      const result = await route("GET", `/log${query}`, undefined);
      expect(result.body, query).toMatchObject({ entries: [{ seq: 1 }] });
    }
  });

  /**
   * Redaction happens on the way *into* the buffer, so there is no filtering
   * step here that a second copy of this route could forget. This asserts the
   * consequence: a PSK logged by any caller is not in what this route serves.
   */
  it("cannot serve a secret, because the buffer never held one", async () => {
    const activity = new ActivityLog({ clock: frozenClock });
    activity.record("warn", "nmcli failed: 802-11-wireless-security.psk: hunter2-the-actual-key");
    const result = await provisioned({ activity })("GET", "/log", undefined);
    expect(JSON.stringify(result.body)).not.toContain("hunter2-the-actual-key");
    expect(JSON.stringify(result.body)).toContain("redacted");
  });

  it("is still gated while unprovisioned, even with a buffer full of entries", async () => {
    const activity = new ActivityLog({ clock: frozenClock });
    activity.record("info", "something the daemon did before anyone logged in");
    const result = await router({ activity })("GET", "/log?since=0", undefined);
    expect(result.status).toBe(403);
    expect(JSON.stringify(result.body)).not.toContain("something the daemon did");
  });
});

/**
 * `POST /net/join` — the one write the network page makes.
 *
 * A route rather than a form that assembles a configuration in a browser: the
 * passphrase has to reach `secrets.yaml` (which only root can write), the
 * configuration has to carry a reference to it, and the whole document has to
 * go through the apply engine so it inherits the confirmation timer. A page
 * doing that itself would be making a decision, in wiring, about the document
 * that decides whether the device is reachable.
 */
describe("POST /net/join", () => {
  function secretSink(): { put(name: string, value: string): void; stored: Record<string, string> } {
    const stored: Record<string, string> = {};
    return { stored, put: (name, value) => { stored[name] = value; } };
  }

  it("is 403 while unprovisioned", async () => {
    const result = await router()("POST", "/net/join", { ssid: "HomeNetwork", psk: "a-passphrase" });
    expect(result.status).toBe(403);
  });

  it("applies a configuration that joins the network, and starts the clock", async () => {
    const secrets = secretSink();
    const route = provisioned({ secrets });
    const result = await route("POST", "/net/join", { ssid: "HomeNetwork", psk: "a-passphrase" });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ id: expect.any(String) as unknown as string });
    // The written configuration is the one that joins.
    const config = (await route("GET", "/config", undefined)).body as Config;
    expect(config.network.client.ssid).toBe("HomeNetwork");
    expect(config.network.client.psk).toEqual({ secret: "wifi_psk" });
    expect(secrets.stored.wifi_psk).toBe("a-passphrase");
  });

  /**
   * The one that matters: this apply moves the radio, so it gets the longer
   * confirmation window — the operator has to find the device again on
   * another network before they can confirm anything.
   */
  it("reports that it moves the radio, so a page can say so", async () => {
    const result = await provisioned({ secrets: secretSink() })(
      "POST", "/net/join", { ssid: "HomeNetwork", psk: "a-passphrase" },
    );
    expect(result.body).toMatchObject({ movesRadio: true });
  });

  /**
   * **And says it again on `GET /status`, which is where a page reads it.**
   *
   * `POST /net/join`'s answer reaches one browser once. The CHANGE PENDING
   * banner is on eight surfaces, is polled, and survives a reload — so
   * everything it draws comes from `/status`. Until this was carried there,
   * the banner offered `CONFIRM` for a join, and R-CFG-11 gives that
   * confirmation to the device: a press moves the engine to `confirmed`, and
   * the device's own verification then returns early on the state check.
   */
  it("keeps saying so on GET /status for as long as the join is pending", async () => {
    const route = provisioned({ secrets: secretSink() });
    await route("POST", "/net/join", { ssid: "HomeNetwork", psk: "a-passphrase" });
    const status = (await route("GET", "/status", undefined)).body as
      { state: string; movesRadio?: boolean };
    expect(status.state).toBe("pending");
    expect(status.movesRadio).toBe(true);
  });

  /**
   * An ordinary apply says nothing about the radio, and **absent is what the
   * console reads as "the operator confirms this one"**. A `/status` that
   * omitted the field for a join would leave `CONFIRM` on the banner; one
   * that claimed it for a hostname change would take a control away from an
   * operator who needs it.
   */
  it("says nothing about the radio on GET /status for an ordinary apply", async () => {
    const route = provisioned({ secrets: secretSink() });
    await route("POST", "/apply", changed());
    const status = (await route("GET", "/status", undefined)).body as
      { state: string; movesRadio?: boolean };
    expect(status.state).toBe("pending");
    expect(status.movesRadio).toBeUndefined();
    expect(JSON.stringify(status)).not.toMatch(/movesRadio/);
  });

  it("is 400 for a passphrase no access point would accept, and stores nothing", async () => {
    const secrets = secretSink();
    const result = await provisioned({ secrets })("POST", "/net/join", { ssid: "HomeNetwork", psk: "short" });
    expect(result.status).toBe(400);
    expect(secrets.stored).toEqual({});
  });

  it("is 400 for an ssid that is not one", async () => {
    const route = provisioned({ secrets: secretSink() });
    for (const ssid of ["", undefined, 42]) {
      expect((await route("POST", "/net/join", { ssid, psk: "a-passphrase" })).status, JSON.stringify(ssid)).toBe(400);
    }
  });

  /**
   * R-SEC-10, at the point of capture. The body is redacted at the top of the
   * router before any branch can touch it, so nothing this route logs can
   * carry the passphrase — which is the property that survives somebody
   * adding a new log line here later.
   */
  it("never writes the passphrase to the journal", async () => {
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    try {
      const route = provisioned({ secrets: secretSink() });
      await route("POST", "/net/join", { ssid: "HomeNetwork", psk: "the-actual-passphrase" });
      await route("POST", "/net/join", { ssid: "", psk: "the-actual-passphrase" });
    } finally {
      spy.mockRestore();
    }
    expect(written.join("")).not.toContain("the-actual-passphrase");
  });

  it("refuses rather than applying when the secret store could not be read", async () => {
    const result = await provisioned({ secrets: undefined })(
      "POST", "/net/join", { ssid: "HomeNetwork", psk: "a-passphrase" },
    );
    expect(result.status).toBe(503);
  });
});

/**
 * `POST /ui/theme` — R-UI-07, and the reason it is a route.
 *
 * The wiring this replaced kept the last configuration in `flow.yonderConfig`,
 * copied it into the message, and set `payload.ui.theme` through that copy.
 * Node-RED's change node stores and retrieves flow context by reference, so
 * all three steps addressed one object: choosing a theme edited the cached
 * configuration in place, whether or not the apply was ever confirmed. A
 * revert then left the cache holding a theme the device did not have, and the
 * next apply of anything at all carried it along.
 */
describe("POST /ui/theme", () => {
  it("is 403 while unprovisioned", async () => {
    expect((await router()("POST", "/ui/theme", { theme: "night" })).status).toBe(403);
  });

  it("applies a configuration with the theme set, and starts the clock", async () => {
    const route = provisioned({});
    const result = await route("POST", "/ui/theme", { theme: "night" });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ id: expect.any(String) as unknown as string });
    expect(((await route("GET", "/config", undefined)).body as Config).ui.theme).toBe("night");
  });

  it("changes nothing but the theme", async () => {
    const route = provisioned({});
    const before = (await route("GET", "/config", undefined)).body as Config;
    await route("POST", "/ui/theme", { theme: "night" });
    const after = (await route("GET", "/config", undefined)).body as Config;
    expect({ ...after, ui: { ...after.ui, theme: before.ui.theme } }).toEqual(before);
  });

  it("is 400 for a theme that is not one of the two, and applies nothing", async () => {
    const route = provisioned({});
    for (const bad of ["dusk", "", 1, null]) {
      const result = await route("POST", "/ui/theme", { theme: bad });
      expect(result.status, `${JSON.stringify(bad)} must be refused`).toBe(400);
      expect(((await route("GET", "/config", undefined)).body as Config).ui.theme).toBe("day");
    }
  });

  /**
   * Changing the theme does not move the radio, so it must not borrow the long
   * window a Wi-Fi join needs. An operator who picks the wrong palette should
   * get it back in ninety seconds, not five minutes.
   */
  it("does not claim to move the radio", async () => {
    const result = await provisioned({})("POST", "/ui/theme", { theme: "night" });
    expect(result.body).not.toMatchObject({ movesRadio: true });
  });
});

/**
 * What M3b's contrib nodes read, and the two records this daemon is the only
 * source of. Both are injected — this router knows no mmcli and no probe.
 */
describe("GET /modem/state", () => {
  const CONNECTED: ModemState = {
    mode: "connected",
    summary: "Connected to Dark Star",
    operator: "Dark Star",
    technology: "lte",
    registration: "home",
    apn: "ereseller",
    address: "10.31.95.33",
    mtu: 1430,
    signal: { rssi: -71, rsrq: -9, rsrp: -100, snr: 19 },
    ports: ["cdc-wdm0 (mbim)", "wwan0 (net)"],
    reportsSignal: true,
  };

  it("serves the modem state", async () => {
    const res = await provisioned({ modemState: async () => CONNECTED })(
      "GET", "/modem/state", undefined,
    );
    expect(res.status).toBe(200);
    expect((res.body as { operator: string }).operator).toBe("Dark Star");
  });

  it("says so plainly when this daemon has no modem layer to ask", async () => {
    // The same shape /net/state uses: a 503 naming the absence, never an empty
    // body a page would render as "no signal".
    const res = await provisioned({})("GET", "/modem/state", undefined);
    expect(res.status).toBe(503);
    expect((res.body as { error: string }).error).toMatch(/cannot report a modem/);
  });

  it("never puts the modem password in a response", async () => {
    // R-SEC-10. The modem state is assembled from the device, not the config,
    // and this asserts the boundary rather than trusting it.
    const res = await provisioned({
      modemState: async () => ({ ...CONNECTED, operator: null, address: null, mtu: null }),
    })("GET", "/modem/state", undefined);
    expect(JSON.stringify(res.body)).not.toMatch(/password|secret/i);
  });

  it("is behind the administrator password like every other configuration read", async () => {
    // R-SEC-09. A modem's operator, technology and address are function, and
    // a device with no password set offers none.
    const res = await router({ modemState: async () => CONNECTED })(
      "GET", "/modem/state", undefined,
    );
    expect(res.status).toBe(403);
  });
});

describe("GET /reach/state", () => {
  const STATE: ReachState = {
    inUse: "modem",
    carrying: true,
    paths: [
      { path: "ethernet", device: "eth0", standing: "no-route-out", since: 1_000,
        evidence: "not-reaching", detail: "Stood down" },
      { path: "modem", device: "wwan0", standing: "in-use", since: null,
        evidence: "reaching", detail: "Carrying traffic" },
    ],
  };

  it("serves which way out is in use", async () => {
    const res = await provisioned({ reachState: async () => STATE })(
      "GET", "/reach/state", undefined,
    );
    expect(res.status).toBe(200);
    expect((res.body as { inUse: string }).inUse).toBe("modem");
  });

  it("serves the evidence about each path, not only the sentence", async () => {
    // The console draws three states from this and must not have to parse
    // `detail` to get them. Serialised over the socket, so a field the router
    // dropped would show up here.
    const res = await provisioned({ reachState: async () => STATE })(
      "GET", "/reach/state", undefined,
    );
    const paths = (res.body as ReachState).paths;
    expect(paths.map((p) => p.evidence)).toEqual(["not-reaching", "reaching"]);
  });

  it("says so plainly when this daemon has no reach monitor to ask", async () => {
    const res = await provisioned({})("GET", "/reach/state", undefined);
    expect(res.status).toBe(503);
    expect((res.body as { error: string }).error).toMatch(/cannot report its way out/);
  });

  it("is behind the administrator password", async () => {
    const res = await router({ reachState: async () => STATE })("GET", "/reach/state", undefined);
    expect(res.status).toBe(403);
  });
});

/**
 * The mesh routes: GET /remote/state, POST /remote/join, POST /remote/leave.
 *
 * The join and leave routes do nothing zerotier-cli would recognise — each
 * merges one field into the configuration and hands the whole document to the
 * apply engine, exactly like /net/join and /ui/theme above. What they do own
 * is validation: a network id that is not sixteen lowercase hex characters
 * draws no complaint from zerotier-cli either — it simply never finishes
 * joining — so the route is the last chance to catch a typo before it goes
 * quiet.
 */
describe("the remote routes", () => {
  it("is 403 while unprovisioned", async () => {
    expect((await router()("GET", "/remote/state", undefined)).status).toBe(403);
  });

  it("GET /remote/state answers with the join state", async () => {
    const state: RemoteState = {
      phase: "waiting-for-approval",
      networkId: "9fef8a3bf9000001",
      deviceId: "9fef8a3bf9",
      addresses: [],
      interface: "ztuqliuo7y",
      detail: null,
    };
    const route = provisioned({ remoteState: () => Promise.resolve(state) });
    const res = await route("GET", "/remote/state", undefined);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(state);
  });

  // Never a 500 for a board that has no remote layer.
  it("GET /remote/state says so when this daemon has no remote layer", async () => {
    const route = provisioned({});
    expect((await route("GET", "/remote/state", undefined)).status).toBe(503);
  });

  it("POST /remote/join applies a configuration carrying the network id", async () => {
    const route = provisioned({});
    const res = await route("POST", "/remote/join", { networkId: "9fef8a3bf9000001" });
    expect(res.status).toBe(200);
    const config = (await route("GET", "/config", undefined)).body as Config;
    expect(config.remote.zerotier).toEqual({ enabled: true, network_id: "9fef8a3bf9000001" });
  });

  // The last chance to catch a typo: a wrong id draws no complaint from the
  // client, it simply never finishes joining.
  it.each(["9FEF8A3BF9000001", "9fef8a3bf900000", "nonsense", ""])(
    "POST /remote/join refuses %s without touching the configuration",
    async (bad) => {
      const route = provisioned({});
      const res = await route("POST", "/remote/join", { networkId: bad });
      expect(res.status).toBe(400);
      expect((res.body as { error: string }).error).toMatch(/sixteen/i);
      const config = (await route("GET", "/config", undefined)).body as Config;
      expect(config.remote.zerotier).toEqual(DEFAULT_CONFIG.remote.zerotier);
    },
  );

  it("POST /remote/leave clears the network and disables it", async () => {
    const route = provisioned({});
    const res = await route("POST", "/remote/leave", undefined);
    expect(res.status).toBe(200);
    const config = (await route("GET", "/config", undefined)).body as Config;
    expect(config.remote.zerotier).toEqual({ enabled: false, network_id: null });
  });
});

describe("POST /modem/configure", () => {
  it("merges the fields into the configuration and applies the whole document", async () => {
    // The same shape /net/join and /remote/join use: the router merges one
    // section and hands the engine a complete document. Nothing about a modem
    // is stored anywhere else.
    const route = provisioned({});
    const res = await route("POST", "/modem/configure", { enabled: true, apn: "ereseller" });
    expect(res.status).toBe(200);
    const config = (await route("GET", "/config", undefined)).body as Config;
    expect(config.network.modem.enabled).toBe(true);
    expect(config.network.modem.apn).toBe("ereseller");
  });

  it("leaves the rest of the configuration alone", async () => {
    const route = provisioned({});
    const before = (await route("GET", "/config", undefined)).body as Config;
    await route("POST", "/modem/configure", { enabled: true, apn: "ereseller" });
    const after = (await route("GET", "/config", undefined)).body as Config;
    expect(after.network.ap).toEqual(before.network.ap);
    expect(after.network.client).toEqual(before.network.client);
  });

  it("refuses a body that is not a modem configuration", async () => {
    const res = await provisioned({})("POST", "/modem/configure", { apn: 42 });
    expect(res.status).toBe(400);
  });

  /**
   * R-CEL-02, priority 1: a modem that needs a credential can be given one
   * from the console.
   *
   * The body a form sends carries a **typed string**, and the configuration
   * holds a `SecretRef` — so the two shapes are different on purpose and the
   * route is what stands between them, exactly as `POST /net/join` does for a
   * Wi-Fi passphrase. This asserts the whole journey: accepted, stored in
   * `secrets.yaml`, referenced by name from `config.yaml`, and the APN that
   * travelled with it applied rather than discarded.
   */
  it("accepts a typed password, and applies the APN that travelled with it", async () => {
    const store = new SecretStore(secretsPath);
    const route = provisioned({ secrets: store });
    const res = await route("POST", "/modem/configure", {
      enabled: true, apn: "ereseller", username: "sim-user", password: "hunter2",
    });
    expect(res.status).toBe(200);
    const config = (await route("GET", "/config", undefined)).body as Config;
    expect(config.network.modem.apn).toBe("ereseller");
    expect(config.network.modem.username).toBe("sim-user");
    expect(config.network.modem.password).toEqual({ secret: MODEM_PASSWORD_SECRET });
    expect(store.get(MODEM_PASSWORD_SECRET)).toBe("hunter2");
  });

  /**
   * The credential goes to the one file that is `0600 root`, and nowhere near
   * the one that is world-readable and travels in a support bundle.
   */
  it("puts the password in secrets.yaml and never in config.yaml", async () => {
    const route = provisioned({ secrets: new SecretStore(secretsPath) });
    await route("POST", "/modem/configure", { enabled: true, apn: "a", password: "hunter2" });
    expect(readFileSync(configPath, "utf8")).not.toMatch(/hunter2/);
    expect(readFileSync(secretsPath, "utf8")).toMatch(/hunter2/);
  });

  /**
   * Rule 1 of `modemRequest`, held on this side of the socket too: an
   * untouched password box must never overwrite a working credential. A body
   * with no `password` key leaves the reference exactly where it was.
   */
  it("leaves a stored credential alone when no password is sent", async () => {
    const store = new SecretStore(secretsPath);
    const route = provisioned({ secrets: store });
    const first = await route("POST", "/modem/configure", { enabled: true, apn: "a", password: "hunter2" });
    // Confirmed, so the second apply is not refused for arriving while the
    // first is still pending — this test is about the password, not the
    // engine's reservation.
    await route("POST", "/confirm", { id: (first.body as { id: string }).id });
    await route("POST", "/modem/configure", { enabled: true, apn: "another" });
    const config = (await route("GET", "/config", undefined)).body as Config;
    expect(config.network.modem.apn).toBe("another");
    expect(config.network.modem.password).toEqual({ secret: MODEM_PASSWORD_SECRET });
    expect(store.get(MODEM_PASSWORD_SECRET)).toBe("hunter2");
  });

  /** No secret store, nothing to store it in — and the route says so. */
  it("refuses rather than applying a reference to a row it could not write", async () => {
    const res = await provisioned({ secrets: undefined })(
      "POST", "/modem/configure", { enabled: true, apn: "a", password: "hunter2" },
    );
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).not.toMatch(/hunter2/);
  });

  /**
   * R-SEC-10, asserted against the **whole serialised body** rather than one
   * field — the shape `form.test.ts` uses, and the reason it is right: a key
   * added to this response later cannot carry the credential out past an
   * assertion that only looked at the field it expected.
   *
   * The status assertion is what stops this passing vacuously. It used to
   * read `not.toMatch(/hunter2/)` on a `400` the route produced before the
   * engine was ever reached, so it would have gone on passing if the route
   * had started echoing the whole configuration on success.
   */
  it("never returns the modem password", async () => {
    const res = await provisioned({ secrets: new SecretStore(secretsPath) })(
      "POST", "/modem/configure", { enabled: true, apn: "a", password: "hunter2" },
    );
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/hunter2/);
    expect(JSON.stringify(res.body)).not.toMatch(/password/i);
  });

  /**
   * Nor in the journal. The router redacts by value at the point the body is
   * captured (R-SEC-10), so no branch below it has to remember.
   */
  it("never writes the modem password to the log", async () => {
    const store = new SecretStore(secretsPath);
    const route = provisioned({ secrets: store });
    const printed = await captureLog(async () => {
      await route("POST", "/modem/configure", { enabled: true, apn: "a", password: "hunter2" });
    });
    expect(printed).not.toMatch(/hunter2/);
  });
});

describe("POST /reach/test", () => {
  it("tests the path it is given and answers with the result", async () => {
    const asked: string[] = [];
    const route = provisioned({ testPath: async (p) => { asked.push(p); return true; } });
    const res = await route("POST", "/reach/test", { path: "modem" });
    expect(res.status).toBe(200);
    expect(asked).toEqual(["modem"]);
    expect((res.body as { reached: boolean }).reached).toBe(true);
  });

  it("refuses a path that is not one of the three", async () => {
    const res = await provisioned({ testPath: async () => true })("POST", "/reach/test", { path: "carrier-pigeon" });
    expect(res.status).toBe(400);
  });

  it("says so plainly when this daemon has no reach monitor to ask", async () => {
    const res = await provisioned({})("POST", "/reach/test", { path: "modem" });
    expect(res.status).toBe(503);
  });
});

/**
 * **R-UI-15.** The other half of the confirmation decision. A console that
 * could only confirm would leave an operator who has already decided the
 * change was wrong watching a five-minute timer — and reaching for the power
 * instead, which is the one thing that turns a rollback into a recovery.
 */
describe("POST /revert", () => {
  it("puts the previous configuration back and returns to rest", async () => {
    const r = provisioned();
    const applied = await r("POST", "/apply", changed());
    const id = (applied.body as { id: string }).id;
    expect(loadConfig(configPath).system.hostname).toBe("changed");

    const res = await r("POST", "/revert", { id });
    expect(res.status).toBe(200);
    expect((res.body as { state: string }).state).toBe("idle");
    expect((res.body as { lastResult?: { outcome: string } }).lastResult?.outcome).toBe("reverted");
    expect(loadConfig(configPath).system.hostname).toBe("yonder");
  });

  it("wants an id, and says so rather than reverting whatever is pending", async () => {
    const r = provisioned();
    await r("POST", "/apply", changed());
    const res = await r("POST", "/revert", {});
    expect(res.status).toBe(400);
    expect(loadConfig(configPath).system.hostname).toBe("changed");
  });

  /**
   * A ConfigError is written for the operator, so the console can say what
   * happened rather than showing a key that did nothing.
   */
  it("refuses an id that is not the pending one, in words", async () => {
    const r = provisioned();
    await r("POST", "/apply", changed());
    const res = await r("POST", "/revert", { id: "not-the-id" });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/unknown apply/);
    expect(loadConfig(configPath).system.hostname).toBe("changed");
  });

  it("refuses when nothing is pending at all", async () => {
    const res = await provisioned()("POST", "/revert", { id: "a1" });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/nothing is pending/);
  });
});

/**
 * `GET /status`'s `wayBackIn` — the way back into a device an operator has
 * lost the console to (R-UI-18).
 *
 * The rule this exists to get right: **the passphrase is returned only while
 * it is the published default.** ADR-0007 makes that value deliberately
 * public — a per-device one could only be read from the device you are locked
 * out of, so it guarded nothing and locked out the legitimate operator — and
 * one the operator has set is theirs, which makes returning it a credential
 * in an API response (R-SEC-10).
 */
describe("the way back in", () => {
  /** The same router, with `ap_psk` seeded to a value the operator chose. */
  function provisionedWithApPassphrase(psk: string): Router {
    new SecretStore(secretsPath).ensureValue("ap_psk", psk);
    new AdminCredential(new SecretStore(secretsPath)).set(GOOD);
    return router({ secrets: new SecretStore(secretsPath) });
  }

  it("names the access point, its address and the hostname", async () => {
    const res = await provisioned({})("GET", "/status", undefined);
    const back = (res.body as {
      wayBackIn: { ssid: string; address: string; hostname: string };
    }).wayBackIn;
    expect(back.ssid).toBe("yonder");
    expect(back.address).toBe("192.168.77.1");
    expect(back.hostname).toBe("yonder.local");
  });

  it("gives the passphrase while it is the published default", async () => {
    // ADR-0007: published, documented, the same on every device, and the only
    // thing that makes a locked-out operator's way back in usable.
    const route = provisionedWithApPassphrase(DEFAULT_AP_PASSPHRASE);
    const res = await route("GET", "/status", undefined);
    expect((res.body as { wayBackIn: { passphrase: string | null } }).wayBackIn.passphrase)
      .toBe("yonder1234");
  });

  it("withholds it once the operator has set their own", async () => {
    // R-SEC-10. Theirs, not ours, and not for an API response.
    const route = provisionedWithApPassphrase("something-they-chose");
    const res = await route("GET", "/status", undefined);
    expect((res.body as { wayBackIn: { passphrase: string | null } }).wayBackIn.passphrase)
      .toBeNull();
    expect(JSON.stringify(res.body)).not.toMatch(/something-they-chose/);
  });

  /**
   * The stored value is never copied into the response — not even when it is
   * equal to the published one.
   *
   * Comparing and then returning `stored` would be correct today and one edit
   * away from being a leak: change the comparison and the operator's own
   * passphrase goes out on an ungated route. Returning the *constant* makes
   * the leak unreachable rather than merely absent, which is the difference
   * R-SEC-10 asks for.
   */
  it("returns the published constant, and never the row it read", async () => {
    const route = provisionedWithApPassphrase(DEFAULT_AP_PASSPHRASE);
    const res = await route("GET", "/status", undefined);
    const back = (res.body as { wayBackIn: { passphrase?: string | null } }).wayBackIn;
    expect(back.passphrase).toBe(DEFAULT_AP_PASSPHRASE);
    // This used to assert `back.passphrase === DEFAULT_AP_PASSPHRASE` as well,
    // which is `toBe` written a second time: JavaScript string equality cannot
    // tell the module's own string from a copy that travelled through
    // secrets.yaml, so the docstring claimed a property the test could not
    // express. The property is real and it is `publishableApPassphrase`'s —
    // no argument produces an answer that is not the constant, null or
    // nothing — and `profiles.test.ts` proves it by value across seven
    // inputs including near misses. What is asserted *here* is the half this
    // route owns: a value that is not the published one never reaches the
    // body, whatever the store holds.
    const theirs = "an-operators-own-passphrase";
    const other = await provisionedWithApPassphrase(theirs)("GET", "/status", undefined);
    expect(JSON.stringify(other.body)).not.toMatch(new RegExp(theirs));
  });

  /**
   * **Cannot tell is its own answer** (I-3, R-UI-18).
   *
   * A daemon whose `secrets.yaml` could not be read is serving without a
   * secret store — that is what `buildRenderers` throwing leaves behind, and
   * it is the state this panel exists for. It used to print `yonder1234`
   * unconditionally, which is a passphrase that will not work on any device
   * whose operator had set their own: the panel named a value for the one
   * failure mode it was written for, and the value was wrong.
   */
  it("prints no passphrase at all when it cannot read the store", async () => {
    const route = provisioned({ secrets: undefined });
    const res = await route("GET", "/status", undefined);
    const back = (res.body as { wayBackIn: { passphrase?: string | null } }).wayBackIn;
    expect("passphrase" in back).toBe(false);
    expect(JSON.stringify(res.body)).not.toMatch(/yonder1234/);
    // Everything that is public by construction is still there: this panel
    // stays useful on a device that has gone wrong.
    expect(back).toMatchObject({ ssid: "yonder", address: "192.168.77.1", hostname: "yonder.local" });
  });

  /**
   * It answers while unprovisioned, like the rest of `/status`.
   *
   * The panel is what an operator reads when the console has stopped being
   * useful, and every field in it is already public: the SSID is beaconed,
   * the address is handed to every client that joins, the hostname is
   * announced over mDNS, and the passphrase — when it is returned at all — is
   * the one printed in the README.
   */
  it("answers in front of the administrator-password gate", async () => {
    const res = await router()("GET", "/status", undefined);
    expect(res.status).toBe(200);
    expect((res.body as { wayBackIn: { ssid: string } }).wayBackIn.ssid).toBe("yonder");
  });

  /**
   * The boundary this route keeps, stated as a test rather than as a comment.
   *
   * `GET /status` is in front of the gate, and until now it carried no
   * configuration at all. `wayBackIn` is the one exception, and it is a
   * narrow one: three fields that are already public by construction. Nothing
   * else out of `config.yaml` may follow them onto this route.
   */
  it("carries the way back in and no other configuration", async () => {
    // `client`, not `wifi_client`. The section is called `client` in the
    // schema and `ConfigSchema` is `.strict()`, so the fixture this test used
    // to write did not load at all: `wayBackIn()` caught the failure and fell
    // back to DEFAULT_CONFIG, and the three operator values grepped for below
    // had never been in a loaded configuration. The boundary this test exists
    // to assert — that nothing else out of a *real* config.yaml follows
    // `wayBackIn` onto an ungated route — was not being exercised.
    const secret: Config = {
      ...DEFAULT_CONFIG,
      network: {
        ...DEFAULT_CONFIG.network,
        client: { ssid: "a-network-they-joined", psk: { secret: "wifi_psk" } },
        modem: { ...DEFAULT_CONFIG.network.modem, apn: "an-apn-they-configured" },
      },
    };
    saveConfig(configPath, secret);
    // The fixture really is what the daemon loads, which is what makes the
    // rest of this test mean anything.
    expect(loadConfig(configPath).network.client.ssid).toBe("a-network-they-joined");
    const body = JSON.stringify((await provisioned({})("GET", "/status", undefined)).body);
    // Not vacuous: the route did answer, and it did carry the panel.
    expect(body).toMatch(/"wayBackIn"/);
    expect(body).not.toMatch(/a-network-they-joined/);
    expect(body).not.toMatch(/an-apn-they-configured/);
    expect(body).not.toMatch(/wifi_psk/);
    expect(body).not.toMatch(/"secret"/);
  });

  /**
   * A configuration that will not load must not take the way back in with it.
   *
   * This panel exists for a device that has gone wrong, and an unreadable
   * config.yaml is one of the ways it goes wrong. The shipped defaults are
   * what a device in that state is actually reachable on, because the
   * access-point profile it is running was rendered from them.
   */
  it("falls back to the shipped defaults when config.yaml will not load", async () => {
    writeFileSync(configPath, "network: [this is not a configuration]\n");
    const res = await provisioned({})("GET", "/status", undefined);
    expect(res.status).toBe(200);
    expect((res.body as { wayBackIn: { ssid: string; address: string; hostname: string } }).wayBackIn)
      .toMatchObject({ ssid: "yonder", address: "192.168.77.1", hostname: "yonder.local" });
  });

  it("keeps the apply state it has always carried", async () => {
    const res = await provisioned({})("GET", "/status", undefined);
    expect((res.body as { state: string }).state).toBe("idle");
  });
});

/**
 * The camera routes: `GET /cameras`, `GET /cameras/:id`,
 * `POST /cameras/:id/probe`, `POST /cameras/:id/run` and
 * `GET /cameras/:id/receive-line`.
 *
 * Three properties these exist for, in the order they matter:
 *
 * **A rejection is a value** (R-CAM-12). "What was found, what was rejected
 * and why" is the requirement, and a route that answered only the first two
 * thirds would leave an operator looking for the camera that vanished.
 *
 * **A start is refused before it is attempted** (R-CAM-10). A pipeline that
 * fails to start says `Internal data stream error` and nothing else.
 *
 * **The credential leaves the daemon on exactly one route** (R-SEC-10). The
 * receive line is the one place the value is allowed out, because the
 * operator is being handed a URL to copy; every other route answers with the
 * reference the configuration holds.
 */
describe("the camera routes", () => {
  it("is 403 while unprovisioned, like every other configuration route", async () => {
    const r = router({ cameras: fixtureDetection() });
    expect((await r("GET", "/cameras", undefined)).status).toBe(403);
    expect((await r("GET", "/cameras/cam0", undefined)).status).toBe(403);
    expect((await r("POST", "/cameras/cam0/run", { action: "start" })).status).toBe(403);
    expect((await r("GET", "/cameras/cam0/receive-line", undefined)).status).toBe(403);
    expect((await r("POST", "/cameras/cam0/controls", { brightness: 10 })).status).toBe(403);
    expect((await r("POST", "/cameras/cam0/settings", { framerate: 25 })).status).toBe(403);
    expect(spawned).toEqual([]);
    expect(controlsCalls).toEqual([]);
  });

  it("lists what was found and what was rejected, with reasons", async () => {
    const r = await provisioned({ cameras: fixtureDetection() })("GET", "/cameras", undefined);
    expect(r.status).toBe(200);
    const body = r.body as { found: unknown[]; rejected: { reason: string }[] };
    expect(body.found).toHaveLength(1);
    expect(body.rejected[0].reason).toContain("hardware codec");
  });

  /**
   * `aim: none · zoom: none` explains why that camera's page has no Aim group
   * before anyone goes looking for one — R-UI-20 applied a level up from the
   * page it governs. The id beside it is what turns a detected camera into a
   * page an operator can open (R-UI-03); null where nothing is configured for
   * this socket yet.
   */
  it("carries each camera's capability line and the id it is configured under", async () => {
    const r = await provisioned({ cameras: fixtureDetection() })("GET", "/cameras", undefined);
    const found = (r.body as { found: { id: string | null; summary: string }[] }).found;
    expect(found[0].id).toBe("cam0");
    expect(found[0].summary).toContain("aim: none");
    expect(found[0].summary).toContain("formats: 2");
  });

  it("reports a camera plugged into a socket nothing is configured for", async () => {
    const route = provisioned({
      cameras: fixtureDetection(),
      camera: { device: "some-other-socket" },
    });
    const found = ((await route("GET", "/cameras", undefined)).body as {
      found: { id: string | null }[];
    }).found;
    expect(found[0].id).toBeNull();
  });

  /**
   * R-CTL-10, and the spec leans on it harder than the wording implies: a
   * control shows what the camera reports, never what was sent. `current` is
   * the device's own answer, and the run state beside it is what the
   * supervisor observed rather than what the configuration asked for.
   */
  it("reads one camera's settings back from the device, with its run state", async () => {
    const r = await provisioned({ cameras: fixtureDetection() })("GET", "/cameras/cam0", undefined);
    expect(r.status).toBe(200);
    const body = r.body as {
      camera: Camera;
      capabilities: CameraCapabilities;
      run: { state: string };
      encoder: Encoder;
      refusal: string | null;
    };
    expect(body.camera.id).toBe("cam0");
    expect((body.capabilities.brightness as { value: { current: number } }).value.current).toBe(96);
    expect(body.run.state).toBe("stopped");
    expect(body.encoder.element).toBe("v4l2h264enc");
    expect(body.refusal).toBeNull();
  });

  /** The Setup deck's *Re-probe* key: this one device, read again. */
  it("re-probes one camera and answers with what it said this time", async () => {
    const detection = fixtureDetection();
    const reprobed: Detection = {
      ...detection.found[0],
      capabilities: {
        ...fixtureCapabilities(),
        brightness: present({ min: 0, max: 255, step: 1, default: 128, current: 201, inactive: false }),
      },
    };
    const r = await provisioned({ cameras: detection, reprobed })(
      "POST", "/cameras/cam0/probe", undefined,
    );
    expect(r.status).toBe(200);
    expect(probed).toEqual([{ node: "/dev/video0", card: "Global Shutter Camera: Global S" }]);
    const caps = (r.body as { capabilities: CameraCapabilities }).capabilities;
    expect((caps.brightness as { value: { current: number } }).value.current).toBe(201);
  });

  /** A re-probe that comes back a rejection says so rather than answering nothing. */
  it("carries the reason when a re-probe rejects the device", async () => {
    const rejection: Rejection = {
      device: "/dev/video0",
      card: "Global Shutter Camera: Global S",
      reason: "this device offered no capture format",
    };
    const r = await provisioned({ cameras: fixtureDetection(), reprobed: rejection })(
      "POST", "/cameras/cam0/probe", undefined,
    );
    expect(r.status).toBe(200);
    const body = r.body as { capabilities: unknown; reason: string | null };
    expect(body.capabilities).toBeNull();
    expect(body.reason).toContain("no capture format");
  });

  it("starts and stops a camera, and answers the run state", async () => {
    const r = provisioned({ cameras: fixtureDetection() });
    const started = await r("POST", "/cameras/cam0/run", { action: "start" });
    expect(started.status).toBe(200);
    expect((started.body as { state: string }).state).toBe("starting");
    const stopped = await r("POST", "/cameras/cam0/run", { action: "stop" });
    expect((stopped.body as { state: string }).state).toBe("stopped");
  });

  /** The argv is composed in yonder-core; this asserts the route spends it. */
  it("spawns the pipeline composed for this camera and this board's encoder", async () => {
    await provisioned({ cameras: fixtureDetection() })("POST", "/cameras/cam0/run", { action: "start" });
    expect(spawned).toHaveLength(1);
    const argv = spawned[0].join(" ");
    expect(argv).toContain(`device=/dev/v4l/by-path/${CAMERA_BY_PATH}`);
    expect(argv).toContain("v4l2h264enc");
    expect(argv).toContain("rtsp://127.0.0.1:8554/cam0-preview");
    // The pipeline publishes from loopback, where mediamtx asks for no
    // credential. A credential in an argv is a credential in `ps` output.
    expect(argv).not.toContain(RTSP_PASSWORD);
  });

  it("refuses a configuration the board cannot sustain, before starting anything", async () => {
    // R-CAM-10. config.yaml is a file an operator may edit by hand, and a
    // pipeline that fails to start says 'Internal data stream error' and
    // nothing else.
    const r = provisioned({ cameras: fixtureDetection(), camera: { width: 3840, height: 2160 } });
    const out = await r("POST", "/cameras/cam0/run", { action: "start" });
    expect(out.status).toBe(400);
    expect(JSON.stringify(out.body)).toContain("3840x2160");
    expect(spawned).toEqual([]);
  });

  /**
   * The likeliest of the refusals to be hit, and today the only report of it
   * is `Internal data stream error`. `v4l2-ctl --list-devices` prints a bus id
   * beside the card name which looks like an answer and has no entry under
   * /dev/v4l/by-path/ at all.
   */
  it("refuses a device that does not resolve, naming the ones that do", async () => {
    const r = provisioned({
      cameras: fixtureDetection(),
      camera: { device: "usb-0000:01:00.0-1.3" },
    });
    const out = await r("POST", "/cameras/cam0/run", { action: "start" });
    expect(out.status).toBe(400);
    expect(JSON.stringify(out.body)).toContain(CAMERA_BY_PATH);
    expect(spawned).toEqual([]);
  });

  it("refuses an unknown camera rather than starting a pipeline for it", async () => {
    const out = await provisioned({ cameras: fixtureDetection() })(
      "POST", "/cameras/../../etc/run", { action: "start" },
    );
    expect(out.status).toBe(404);
    expect(spawned).toEqual([]);
  });

  /**
   * The id comes off a URL and becomes a media path and a file path
   * downstream, so it is matched against the same pattern the schema allows
   * **before anything else happens with it** — a pattern rather than a filter
   * for `..`, because a filter is a list of the tricks somebody thought of.
   *
   * Asserted by breaking config.yaml: a malformed id is still a plain 404,
   * which it can only be if the pattern refused it before the configuration
   * was ever read.
   */
  it("refuses a malformed camera id without reading the configuration", async () => {
    const r = provisioned({ cameras: fixtureDetection() });
    writeFileSync(configPath, "version: 99\n");
    for (const bad of ["../../etc", "CAM0", "-cam0", "cam0!", "a".repeat(33), ""]) {
      expect((await r("GET", `/cameras/${bad}`, undefined)).status, bad).toBe(404);
      expect((await r("POST", `/cameras/${bad}/run`, { action: "start" })).status, bad).toBe(404);
    }
    expect(spawned).toEqual([]);
    expect(probed).toEqual([]);
  });

  it("is 404 for a well-formed id no camera is configured under", async () => {
    const r = provisioned({ cameras: fixtureDetection() });
    expect((await r("GET", "/cameras/cam9", undefined)).status).toBe(404);
    expect((await r("POST", "/cameras/cam9/run", { action: "start" })).status).toBe(404);
    expect((await r("GET", "/cameras/cam9/receive-line", undefined)).status).toBe(404);
    expect((await r("POST", "/cameras/cam9/controls", { brightness: 10 })).status).toBe(404);
  });

  it("refuses a run request that names neither start nor stop", async () => {
    const r = provisioned({ cameras: fixtureDetection() });
    for (const bad of [undefined, {}, { action: "restart" }, { action: 1 }]) {
      const out = await r("POST", "/cameras/cam0/run", bad);
      expect(out.status, JSON.stringify(bad)).toBe(400);
    }
    expect(spawned).toEqual([]);
  });

  it("resolves the RTSP credential into the receive line, and nowhere else", async () => {
    // R-SEC-10: never in a log, an error, or a support bundle. This route is
    // the one place the value is allowed out, because the operator is being
    // handed a URL to copy.
    const r = provisioned({ cameras: fixtureDetection() });
    const line = await r("GET", "/cameras/cam0/receive-line", undefined);
    expect(JSON.stringify(line.body)).toContain("rtsp://yonder:");
    expect(JSON.stringify(line.body)).toContain(RTSP_PASSWORD);

    const list = await r("GET", "/cameras", undefined);
    expect(JSON.stringify(list.body)).not.toContain("rtsp://yonder:");

    // Every other route this milestone adds, and the two that already carried
    // the configuration. A leak anywhere in this set is the same leak.
    for (const [method, path, body] of [
      ["GET", "/cameras", undefined],
      ["GET", "/cameras/cam0", undefined],
      ["POST", "/cameras/cam0/probe", undefined],
      ["POST", "/cameras/cam0/run", { action: "start" }],
      ["POST", "/cameras/cam0/run", { action: "stop" }],
      ["POST", "/cameras/cam0/controls", { brightness: 10 }],
      ["POST", "/cameras/cam0/settings", { framerate: 25 }],
      ["GET", "/config", undefined],
      ["GET", "/system", undefined],
    ] as [string, string, unknown][]) {
      const answer = await r(method, path, body);
      expect(JSON.stringify(answer.body), `${method} ${path}`).not.toContain(RTSP_PASSWORD);
    }
  });

  /**
   * **The Setup deck can only promise a confirmation window where one really
   * arms, because it draws the engine's own answer.**
   *
   * `apply/reachability.ts` decides that from `CAMERA_EXEMPT_LEAVES`, against
   * the document this route produces — so a change to a picture setting is
   * kept the instant it is made (`expiresAt: null`, R-CFG-12) and a change to
   * the bitrate arms the window. A page promising a confirm control that never
   * comes, or omitting one that does, is K-32 on the camera page.
   */
  describe("POST /cameras/:id/settings", () => {
    it("keeps a change that cannot cost reachability, with nothing to confirm", async () => {
      const r = provisioned({ cameras: fixtureDetection() });
      const out = await r("POST", "/cameras/cam0/settings", { framerate: 25 });
      expect(out.status).toBe(200);
      expect((out.body as { expiresAt: number | null }).expiresAt).toBeNull();
      // And it really changed the document, not merely reported that it had.
      const config = (await r("GET", "/config", undefined)).body as Config;
      expect(config.cameras[0]?.framerate).toBe(25);
    });

    it("arms the window for a change to what leaves the aircraft", async () => {
      const r = provisioned({ cameras: fixtureDetection() });
      const out = await r("POST", "/cameras/cam0/settings", { bitrate_kbps: 3000 });
      expect(out.status).toBe(200);
      expect(typeof (out.body as { expiresAt: number | null }).expiresAt).toBe("number");
    });

    // R-NET-07: a preview ceiling that can now reach 4000 kb/s is egress on
    // the same path the console is reached over, so — unlike before this
    // task — a preview change is held exactly like a change to the main
    // bitrate is, not kept on the strength of a bound that no longer holds.
    it("arms the window for a preview change too, now that the schema no longer bounds it small", async () => {
      const r = provisioned({ cameras: fixtureDetection() });
      const out = await r("POST", "/cameras/cam0/settings", { preview_bitrate_kbps: 300 });
      expect(typeof (out.body as { expiresAt: number | null }).expiresAt).toBe("number");
    });

    it("refuses a setting nobody offers, and never writes the document", async () => {
      const r = provisioned({ cameras: fixtureDetection() });
      const out = await r("POST", "/cameras/cam0/settings", { device: "/dev/video9" });
      expect(out.status).toBe(400);
      const config = (await r("GET", "/config", undefined)).body as Config;
      expect(config.cameras[0]?.device).toBe(CAMERA_BY_PATH);
    });

    it("refuses a value the schema will not take, with the schema's own reasons", async () => {
      const r = provisioned({ cameras: fixtureDetection() });
      // 60000 kb/s is past the schema's max(20000).
      const out = await r("POST", "/cameras/cam0/settings", { bitrate_kbps: 60000 });
      expect(out.status).toBe(400);
    });

    it("404s for a camera that is not configured, like every other camera route", async () => {
      const r = provisioned({ cameras: fixtureDetection() });
      expect((await r("POST", "/cameras/cam9/settings", { framerate: 25 })).status).toBe(404);
    });
  });

  /**
   * **`POST /cameras/:id/apply` — the Setup deck's own Apply** (R-CFG-03,
   * spec §7, and the defect §10 lists first).
   *
   * The route `settings` above is not: it takes one flat key at a time,
   * which is the shape a `ui-number-input` posts on blur — one field, one
   * apply, one confirmation window for every box an operator tabs out of.
   * This takes the whole shared draft, once, when Apply is pressed.
   */
  describe("POST /cameras/:id/apply", () => {
    it("refuses a draft whose fields contradict each other, naming the field to change", async () => {
      const r = provisioned({ cameras: fixtureDetection() });
      const out = await r("POST", "/cameras/cam0/apply", {
        previewFloor: 2000, previewCeiling: 500,
      });
      expect(out.status).toBe(400);
      const body = out.body as { problems: { path: string; message: string }[] };
      // By path, so the deck marks the field rather than showing a sentence
      // about a form (R-CMD-04: it reports, it never repairs).
      expect(body.problems).toEqual([{
        path: "preview.floor_kbps",
        message: "the floor (2000 kb/s) is above the ceiling (500 kb/s)",
      }]);
      // And nothing was written. A refused draft that had already half
      // applied is worse than one that was refused.
      const config = (await r("GET", "/config", undefined)).body as Config;
      expect(config.cameras[0]?.preview.floor_kbps).not.toBe(2000);
    });

    /**
     * A held size is checked against **this camera's** own rungs, not the
     * schema's three: a size the schema allows in general is still wrong for
     * a camera that does not make it. The fixture's camera offers 1280×720
     * and 640×480, so 854×480 is a rung it cannot hold.
     */
    it("refuses a held preview size this camera does not offer", async () => {
      const r = provisioned({ cameras: fixtureDetection() });
      const out = await r("POST", "/cameras/cam0/apply", { previewSize: "854x480" });
      expect(out.status).toBe(400);
      expect(JSON.stringify(out.body)).toContain("does not offer 854x480");
    });

    it("applies a whole draft at once, and says what it interrupts", async () => {
      const r = provisioned({ cameras: fixtureDetection() });
      const out = await r("POST", "/cameras/cam0/apply", {
        previewRate: 25,
        streamMode: "Adaptive", streamFloor: 500, streamCeiling: 3000,
      });
      expect(out.status).toBe(200);
      const config = (await r("GET", "/config", undefined)).body as Config;
      expect(config.cameras[0]?.preview.framerate).toBe(25);
      expect(config.cameras[0]?.stream.mode).toBe("adaptive");
      expect(config.cameras[0]?.stream.floor_kbps).toBe(500);
      // The same function the deck draws before the press, so the warning an
      // operator read and the answer they get are one calculation. A preview
      // rate change is the preview branch and nothing else.
      expect((out.body as { interruption: string[] }).interruption)
        .toEqual(["preview branch only"]);
    });

    /**
     * **Where the window arms, and where it does not** — spec §10's defect 1,
     * measured at the route rather than assumed at the page. A load-bearing
     * change to what leaves the aircraft is held pending a confirmation
     * (R-NET-07, R-CFG-03); a live image control touches no configuration and
     * can never arm one, which is why `controls` is a different route and not
     * a flag on this one.
     */
    it("arms the confirmation window for a load-bearing change; a control never does", async () => {
      // A router each, because an armed window is device state: a second
      // apply while one is pending is refused, and the refusal would be
      // mistaken for "this change did not arm one".
      const armed = await provisioned({ cameras: fixtureDetection() })(
        "POST", "/cameras/cam0/apply", { streamBitrate: 3000 },
      );
      expect(typeof (armed.body as { expiresAt: number | null }).expiresAt).toBe("number");

      // A change the engine's own `CAMERA_EXEMPT_LEAVES` exempts is kept, with
      // nothing to confirm — the page draws a countdown exactly where one
      // armed because it draws the engine's answer, never a prediction.
      const kept = await provisioned({ cameras: fixtureDetection() })(
        "POST", "/cameras/cam0/apply", { framerate: 25 },
      );
      expect((kept.body as { expiresAt: number | null }).expiresAt).toBeNull();

      // And the live route, on the same camera, with the same daemon: no
      // deadline anywhere in the answer, because it never reaches the engine.
      const live = await provisioned({ cameras: fixtureDetection() })(
        "POST", "/cameras/cam0/controls", { brightness: 10 },
      );
      expect(live.status).toBe(200);
      expect(Object.keys(live.body as object)).not.toContain("expiresAt");
    });

    it("refuses anything that is not a draft object at all", async () => {
      const r = provisioned({ cameras: fixtureDetection() });
      expect((await r("POST", "/cameras/cam0/apply", "everything")).status).toBe(400);
      expect((await r("POST", "/cameras/cam0/apply", [1, 2])).status).toBe(400);
    });

    /**
     * **A staged path this device does not know is named, never dropped.**
     * An old browser holding a draft from a console two versions back is the
     * case: silently ignoring the field it cannot apply is an Apply that
     * reports success and leaves one of the operator's edits unmade, which is
     * exactly what the draft mechanism exists to stop.
     */
    it("refuses a staged path it does not know, by name, and writes nothing", async () => {
      const r = provisioned({ cameras: fixtureDetection() });
      const out = await r("POST", "/cameras/cam0/apply", { previewRate: 25, streamWobble: 1 });
      expect(out.status).toBe(400);
      expect(JSON.stringify(out.body)).toContain("streamWobble");
      const config = (await r("GET", "/config", undefined)).body as Config;
      expect(config.cameras[0]?.preview.framerate).not.toBe(25);
    });

    /** The camera's own name travels with the draft, and is written too. */
    it("renames the camera when the deck staged a name", async () => {
      const r = provisioned({ cameras: fixtureDetection() });
      const out = await r("POST", "/cameras/cam0/apply", { name: "Nose mast" });
      expect(out.status).toBe(200);
      const config = (await r("GET", "/config", undefined)).body as Config;
      expect(config.cameras[0]?.name).toBe("Nose mast");
    });
  });

  /**
   * **`POST /cameras/:id/outputs/:kind`** (R-UI-24, spec §7's Outputs table).
   * Through the engine like every other change to what leaves the aircraft,
   * and emphatically not a runtime toggle.
   */
  describe("POST /cameras/:id/outputs/:kind", () => {
    it("stops one output without losing its port, its path or its secret", async () => {
      const r = provisioned({ cameras: fixtureDetection() });
      const out = await r("POST", "/cameras/cam0/outputs/rtp", { enabled: false });
      expect(out.status).toBe(200);
      const config = (await r("GET", "/config", undefined)).body as Config;
      const rtp = config.cameras[0]?.outputs.find((o) => o.kind === "rtp") as
        { enabled: boolean; host: string; port: number };
      expect(rtp.enabled).toBe(false);
      expect(rtp.host).toBe("192.168.1.50");
      expect(rtp.port).toBe(5600);
    });

    it("404s for an output this camera has not got", async () => {
      const r = provisioned({ cameras: fixtureDetection() });
      expect((await r("POST", "/cameras/cam0/outputs/srt", { enabled: false })).status).toBe(404);
    });

    it("needs a boolean, so a missing field cannot read as off", async () => {
      const r = provisioned({ cameras: fixtureDetection() });
      expect((await r("POST", "/cameras/cam0/outputs/rtp", {})).status).toBe(400);
      expect((await r("POST", "/cameras/cam0/outputs/rtp", { enabled: "no" })).status).toBe(400);
    });
  });

  /** R-VID-15: the command carries the address the operator is reaching this device on. */
  it("names the address the request arrived on, and lists the others beneath it", async () => {
    const r = provisioned({ cameras: fixtureDetection() });
    const chosen = await r("GET", "/cameras/cam0/receive-line?address=10.147.17.42", undefined);
    const text = JSON.stringify(chosen.body);
    expect(text).toContain("10.147.17.42:8554/cam0");
    expect(text).toContain("192.168.77.1");
  });

  /**
   * An address this device does not answer on is not carried into a command
   * an operator is about to copy. The allowed set is the set of real
   * addresses, so there is nothing to filter for.
   */
  it("ignores an address this device does not answer on", async () => {
    const r = provisioned({ cameras: fixtureDetection() });
    const out = await r("GET", "/cameras/cam0/receive-line?address=evil.example", undefined);
    expect(JSON.stringify(out.body)).not.toContain("evil.example");
    expect(JSON.stringify(out.body)).toContain("192.168.77.1:8554/cam0");
  });

  it("never writes the RTSP credential to the journal", async () => {
    const written = await captureLog(async () => {
      const r = provisioned({ cameras: fixtureDetection() });
      await r("GET", "/cameras/cam0/receive-line", undefined);
      await r("POST", "/cameras/cam0/run", { action: "start" });
    });
    expect(written).not.toContain(RTSP_PASSWORD);
  });

  /** Never a 500 for a board this daemon could not assemble a camera layer for. */
  it("says so when this daemon has no camera layer, rather than failing", async () => {
    const r = provisioned({});
    expect((await r("GET", "/cameras", undefined)).status).toBe(503);
    expect((await r("GET", "/cameras/cam0", undefined)).status).toBe(503);
    expect((await r("POST", "/cameras/cam0/run", { action: "start" })).status).toBe(503);
    expect((await r("GET", "/cameras/cam0/receive-line", undefined)).status).toBe(503);
    expect((await r("POST", "/cameras/cam0/controls", { brightness: 10 })).status).toBe(503);
  });
});

/**
 * `requestedControls` itself (round 2, coordinator's resolutions 8-10):
 * exactly one JS type is accepted per control, and it must be the type the
 * schema itself gives that field, derived rather than hand-listed
 * (`BOOLEAN_CONTROLS` in `routes.ts`) — never a bound on the number, which
 * is `applyControls`'s job against the device's own reported range.
 */
describe("requestedControls", () => {
  // The sharp edge round 2 exists to close: before this, a single boolean
  // anywhere in the body returned null for the *entire* request, so a page
  // setting brightness and auto focus in one gesture would have lost the
  // brightness too, silently. This is the case that matters, not the
  // single-field case below.
  it("takes a switch as a boolean and a level as a number, in one request", () => {
    expect(requestedControls({ brightness: 12, autoFocus: false }))
      .toEqual({ brightness: 12, autoFocus: false });
  });

  it("still refuses a boolean for a control that is not a switch", () => {
    expect(requestedControls({ brightness: true })).toBeNull();
  });

  // The set is walked out of the schema rather than typed here, which is what
  // keeps it from becoming a third list to remember. The cost is that a walk
  // which stopped finding the boolean fields would return nothing, silently
  // refuse every switch again, and be caught only by the mixed-request test
  // above. Name the members, so a broken derivation fails as itself.
  it("derives exactly the two switches the schema declares boolean", () => {
    expect([...BOOLEAN_CONTROLS].sort()).toEqual(["autoFocus", "autoWhiteBalance"]);
  });

  // Refusing the whole body is the deliberate behaviour, not the sharp edge
  // that was fixed. The edge was refusing it over a *boolean*, which is now a
  // legal value for two controls; a string is still nobody's control value,
  // and half-applying a request an operator made in one gesture would be
  // worse than declining it.
  it("refuses the whole body for a value that is nobody's, not just that field", () => {
    expect(requestedControls({ brightness: 12, contrast: "bad" })).toBeNull();
    expect(requestedControls({ brightness: 12, autoFocus: "bad" })).toBeNull();
  });

  // Beyond the brief's two: the same wrong-JS-type refusal in the other
  // direction (a non-boolean for a field the schema does type as boolean),
  // so the boolean branch is checked both ways rather than only the one the
  // brief's own two tests exercise.
  it("refuses a non-boolean for a control that is a switch", () => {
    expect(requestedControls({ autoFocus: "on" })).toBeNull();
  });

  // `null` still means "leave it" for a boolean field, exactly as for a
  // numeric one — the boolean branch is a different type check, not a
  // different rule about absence.
  it("drops a null switch rather than refusing it, alongside a real value", () => {
    expect(requestedControls({ brightness: 5, autoFocus: null })).toEqual({ brightness: 5 });
  });
});

/**
 * R-CTL-04, R-CTL-05, R-CTL-10: the route that actually reaches the camera.
 *
 * `config.cameras[].controls` was, before this route existed, stored and
 * never applied — `apply/reachability.ts` exempts it from the confirmation
 * window and nothing carried it any further. These tests are about what this
 * route does with a request, not about `v4l2-ctl` itself: clamping, refusal
 * wording and the read-back are `controls.test.ts`'s job. `applyControls` is
 * given here exactly as `cameras` and `encoder` are — a test that reached
 * this route with no camera layer configured must not be able to run a real
 * `v4l2-ctl` by omission.
 */
describe("POST /cameras/:id/controls", () => {
  it("resolves the camera to its device node and hands the request to applyControls", async () => {
    const r = provisioned({
      cameras: fixtureDetection(),
      controlsResult: {
        applied: { brightness: 64 },
        refused: [],
        clamped: [{ control: "brightness", requested: 100, sent: 64 }],
      },
    });
    const out = await r("POST", "/cameras/cam0/controls", { brightness: 100 });
    expect(out.status).toBe(200);
    expect(controlsCalls).toHaveLength(1);
    // The resolved /dev node, never the by-path name — that is what
    // v4l2-ctl accepts (probe/bypath.ts resolves the other direction).
    expect(controlsCalls[0].node).toBe("/dev/video0");
    expect(controlsCalls[0].controls).toEqual({ brightness: 100 });
    expect(controlsCalls[0].capabilities).toEqual(fixtureCapabilities());
    const body = out.body as { applied: Record<string, number>; refused: unknown[] };
    expect(body.applied).toEqual({ brightness: 64 });
    expect(body.refused).toEqual([]);
  });

  /**
   * R-CTL-10, and the reason this route re-probes rather than answering with
   * the snapshot it already had: a page showing three controls must not show
   * two fresh values and one the operator's last request happened to leave
   * alone.
   */
  it("answers with a fresh read-back of the whole device, not the pre-write snapshot", async () => {
    const detection = fixtureDetection();
    const reprobed: Detection = {
      ...detection.found[0],
      capabilities: {
        ...fixtureCapabilities(),
        brightness: present({ min: 0, max: 255, step: 1, default: 128, current: 64, inactive: false }),
      },
    };
    const r = provisioned({
      cameras: detection,
      reprobed,
      controlsResult: { applied: { brightness: 64 }, refused: [], clamped: [] },
    });
    const out = await r("POST", "/cameras/cam0/controls", { brightness: 64 });
    expect(probed).toEqual([{ node: "/dev/video0", card: "Global Shutter Camera: Global S" }]);
    const body = out.body as { current: CameraCapabilities };
    expect((body.current.brightness as { value: { current: number } }).value.current).toBe(64);
  });

  it("passes a refusal straight through, unmodified", async () => {
    const r = provisioned({
      cameras: fixtureDetection(),
      controlsResult: {
        applied: {},
        refused: [{ control: "rotation", reason: "this camera does not offer rotation" }],
        clamped: [],
      },
    });
    const out = await r("POST", "/cameras/cam0/controls", { rotation: 90 });
    expect(out.status).toBe(200);
    const body = out.body as { refused: { control: string; reason: string }[] };
    expect(body.refused).toEqual([{ control: "rotation", reason: "this camera does not offer rotation" }]);
  });

  it("refuses a body naming no recognised control, before calling applyControls", async () => {
    // `zoom` used to stand in here for "a name CONTROL_NAMES does not know" —
    // Task 9 gave the write path all fourteen controls the schema carries
    // (R-CTL-11 … R-CTL-14), zoom among them, so that example is retired in
    // favour of a name no schema field will ever use.
    const r = provisioned({ cameras: fixtureDetection() });
    for (const bad of [{}, { nonexistent: 5 }, undefined, "brighter"]) {
      expect((await r("POST", "/cameras/cam0/controls", bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect(controlsCalls).toEqual([]);
  });

  it("refuses a control value that is not a finite number, before calling applyControls", async () => {
    const r = provisioned({ cameras: fixtureDetection() });
    for (const bad of [{ brightness: "bright" }, { brightness: null }, { brightness: NaN }, { contrast: [1] }]) {
      expect((await r("POST", "/cameras/cam0/controls", bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect(controlsCalls).toEqual([]);
  });

  it("refuses a camera whose device cannot currently be resolved, before calling applyControls", async () => {
    const r = provisioned({
      cameras: fixtureDetection(),
      camera: { device: "some-other-socket" },
    });
    const out = await r("POST", "/cameras/cam0/controls", { brightness: 10 });
    expect(out.status).toBe(400);
    expect(controlsCalls).toEqual([]);
  });
});

/**
 * The supply register, sampled where this daemon already samples system state
 * (R-SYS-09).
 *
 * The requirement has two halves and only the first was built: reporting it.
 * The second — *record an occurrence in the log* — is the half that matters in
 * flight, because an undervoltage event restarts the board and a restart
 * presents as an aircraft that went quiet with nothing to explain it.
 *
 * **The transition, not the state.** A board that has been dirty since boot
 * would otherwise write one line every time a status page polled, for ever.
 */
describe("GET /system's supply reading", () => {
  const clean: SupplyState = {
    clean: true,
    now: { undervoltage: false, capped: false, throttled: false },
    sinceBoot: { undervoltage: false, capped: false, throttled: false },
    raw: "0x0",
  };
  // 0x50000: undervoltage and throttling latched since boot, nothing wrong at
  // the moment it was read. K-41's shape exactly.
  const latched: SupplyState = {
    clean: false,
    now: { undervoltage: false, capped: false, throttled: false },
    sinceBoot: { undervoltage: true, capped: false, throttled: true },
    raw: "0x50000",
  };

  it("carries the reading beside the board's other facts", async () => {
    const res = await provisioned({ supply: () => Promise.resolve(clean) })("GET", "/system", undefined);
    expect(res.status).toBe(200);
    expect((res.body as { supply: SupplyState }).supply).toEqual(clean);
  });

  it("answers null where the board does not expose it — unknown, not good", async () => {
    const res = await provisioned({})("GET", "/system", undefined);
    expect((res.body as { supply: unknown }).supply).toBeNull();
  });

  it("records an occurrence the first time a latched bit is seen", async () => {
    const written = await captureLog(async () => {
      await provisioned({ supply: () => Promise.resolve(latched) })("GET", "/system", undefined);
    });
    expect(written).toMatch(/undervoltage/i);
    expect(written).toContain("0x50000");
  });

  it("records it once, not once per reading", async () => {
    const route = provisioned({ supply: () => Promise.resolve(latched) });
    const written = await captureLog(async () => {
      for (let i = 0; i < 5; i++) await route("GET", "/system", undefined);
    });
    // Counted by log line, not by word: one line names undervoltage twice.
    expect(written.match(/supply: /g) ?? []).toHaveLength(1);
  });

  it("records the new bit when one sets that was not set before", async () => {
    let state = latched;
    const route = provisioned({ supply: () => Promise.resolve(state) });
    const written = await captureLog(async () => {
      await route("GET", "/system", undefined);
      state = {
        ...latched,
        sinceBoot: { undervoltage: true, capped: true, throttled: true },
        raw: "0x70000",
      };
      await route("GET", "/system", undefined);
    });
    expect(written).toContain("0x70000");
    expect(written.match(/frequency capped/gi) ?? []).toHaveLength(1);
  });

  it("says nothing about a board whose supply has held since boot", async () => {
    const written = await captureLog(async () => {
      await provisioned({ supply: () => Promise.resolve(clean) })("GET", "/system", undefined);
    });
    expect(written).not.toMatch(/undervoltage/i);
  });
});
