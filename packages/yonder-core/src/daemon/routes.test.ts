// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
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
import { Recorder, type CameraMedium, type Capture } from "../video/recorder.js";
import { Stills } from "../video/stills.js";
import { STILLS_INTERVAL_MS, stillCostKbps, Viewers } from "../video/viewers.js";
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
import type { AnswerableAddress } from "../net/dial-in.js";
import type { MavlinkControl, MavlinkStateBody, MavlinkDetectBody } from "./routes.js";
import type { LinkState } from "../mav/link.js";
import { SweepInProgressError, type DetectOutcome } from "../mav/detect.js";
import type { PathCheck } from "../mav/check.js";

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

/**
 * The operator's own case: a second camera plugged into a running board, on a
 * socket the configuration has never heard of. `fixtureDetection()`'s camera
 * is the configured one; this is the one beside it with no entry.
 */
const SECOND_BY_PATH = "platform-fd500000.pcie-pci-0000:01:00.0-usb-0:1.1:1.0-video-index0";

function detectionWithASecondCamera(): DetectResult {
  const base = fixtureDetection();
  return {
    ...base,
    found: [...base.found, {
      device: "/dev/video2",
      card: "Webcam gadget: UVC HD Camera",
      byPath: SECOND_BY_PATH,
      byPathStable: true,
      capabilities: fixtureCapabilities(),
    }],
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
  element: "v4l2h264enc", h265: null, decoder: null, device: "/dev/video11", hardware: true,
  detail: "hardware H.264 on /dev/video11 — raw in, H.264 out",
};

/** The value the stream-address route resolves, and no other route may. */
const RTSP_PASSWORD = "an-actual-generated-rtsp-password";

/**
 * What this device answers on, and the path a peer would reach each one over.
 *
 * The three a bench board actually holds at once: the access point it is
 * raising, the mesh it has joined, and the ethernet it is plugged into.
 * Deliberately not three interchangeable ones — a verdict that rests on the
 * mesh is satisfied by exactly one of them, and the access point's, which
 * `activeIpv4()` reports first, satisfies none.
 */
const ADDRESSES: AnswerableAddress[] = [
  { address: "192.168.77.1", path: "access-point" },
  { address: "10.147.17.42", path: "mesh" },
  { address: "192.168.1.50", path: "lan" },
];

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
  /** What this device answers on, and the path a peer would reach each over. */
  addresses?: AnswerableAddress[];
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
  /** The telemetry link. Undefined, as in production today, unless a test says otherwise. */
  mavlink?: MavlinkControl;
  /** Recording and stills (R-CAM-17, R-CAM-18). Absent means this daemon has
   *  no recorder, which every capture route says rather than answering with
   *  an empty list. */
  recorder?: Recorder;
  stills?: Stills;
  viewers?: Viewers;
  clock?: Clock;
  accessory?: import('../video/accessory/source.js').AccessorySources;
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
    accessory: opts.accessory,
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
      addresses: () => Promise.resolve(opts.addresses ?? ADDRESSES),
      // Given, never a real applyControls — exactly as `cameras` and
      // `encoder` are given rather than defaulted: with a default, any test
      // that reached this route would run a real v4l2-ctl.
      applyControls: (o: ApplyControlsOptions) => {
        controlsCalls.push(o);
        return Promise.resolve(opts.controlsResult ?? { applied: {}, refused: [], clamped: [] });
      },
    }),
    ...(opts.mavlink === undefined ? {} : { mavlink: opts.mavlink }),
    ...(opts.recorder === undefined ? {} : { recorder: opts.recorder }),
    ...(opts.stills === undefined ? {} : { stills: opts.stills }),
    ...(opts.viewers === undefined ? {} : { viewers: opts.viewers }),
    ...(opts.clock === undefined ? {} : { clock: opts.clock }),
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
 * `GET /cameras/:id/stream-address`.
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
 * stream address is the one place the value is allowed out, because the
 * operator is being handed a URL to copy; every other route answers with the
 * reference the configuration holds.
 */
describe("the camera routes", () => {
  it("is 403 while unprovisioned, like every other configuration route", async () => {
    const r = router({ cameras: fixtureDetection() });
    expect((await r("GET", "/cameras", undefined)).status).toBe(403);
    expect((await r("GET", "/cameras/cam0", undefined)).status).toBe(403);
    expect((await r("POST", "/cameras/cam0/run", { action: "start" })).status).toBe(403);
    expect((await r("GET", "/cameras/cam0/stream-address", undefined)).status).toBe(403);
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

  /**
   * **The one guarantee the brief names first, held where the daemon feeds
   * the adapter** (R-VID-11).
   *
   * `present.test.ts` proves `cameraIndex()` answers `null` when it is handed
   * no measurement. It cannot prove the daemon hands it none — and the review
   * demonstrated exactly that gap: adding
   * `egressKbps: (id) => the configured bitrate_kbps` to this route's single
   * `cameraIndex({...})` call left all 1877 tests green. That one line is the
   * defect the brief forbids, at the only place the seam is ever used, so the
   * assertion belongs here as well as there.
   *
   * The camera below is configured at 2000 kb/s and the supervisor reports it
   * `running`, which is the state that most invites a plausible-looking
   * number. Nothing on this branch measures egress, so the honest answer is
   * that there is none.
   */
  /**
   * **Adopting a camera the board has already found.**
   *
   * The operator plugged a second camera into a running board, saw it listed
   * as *Not configured*, and had no way to do anything with it — the OPEN key
   * is disabled for a row with no id, correctly, and nothing anywhere could
   * give it one. Found by him on hardware; no test could have caught it,
   * because a review reads a diff and nothing in a diff is missing.
   */
  it("adopts a detected camera onto the socket it was found on", async () => {
    const r = provisioned({ cameras: detectionWithASecondCamera() });
    const before = loadConfig(configPath).cameras.length;
    const res = await r("POST", "/cameras", { device: SECOND_BY_PATH });
    expect(res.status).toBe(200);
    const cameras = loadConfig(configPath).cameras;
    expect(cameras.length, "the camera reached the configuration").toBe(before + 1);
    const added = cameras.find((c) => c.device === SECOND_BY_PATH);
    // **The socket, never /dev/videoN** — R-CAM-05. The whole point of the
    // entry is that it still means this camera after a replug.
    expect(added?.device).toBe(SECOND_BY_PATH);
    expect(added?.name).toBe("Webcam gadget: UVC HD Camera");
    expect((res.body as { camera: string }).camera).toBe(added?.id);
  });

  it("gives the adopted camera an id, so it now has a page to open", async () => {
    const r = provisioned({ cameras: detectionWithASecondCamera() });
    const before = await r("GET", "/cameras", undefined);
    const unconfigured = (before.body as { index: { cameras: { id: string | null }[] } })
      .index.cameras.filter((c) => c.id === null);
    expect(unconfigured.length, "the second camera starts with no id").toBe(1);

    await r("POST", "/cameras", { device: SECOND_BY_PATH });
    const res = await r("GET", "/cameras", undefined);
    const rows = (res.body as { index: { cameras: { id: string | null; name: string }[] } }).index.cameras;
    const row = rows.find((c) => c.name.startsWith("Webcam"));
    // This is the whole defect, stated as an assertion: before this route
    // existed every detected-but-unconfigured camera had a null id for ever,
    // and `YonderIndex` disables OPEN on exactly that.
    expect(row?.id, "an adopted camera has an id, and so a page").toBeTruthy();
  });

  it("refuses a socket that already carries a camera, rather than adding a second entry for it", async () => {
    const r = provisioned({ cameras: detectionWithASecondCamera() });
    await r("POST", "/cameras", { device: SECOND_BY_PATH });
    const again = await r("POST", "/cameras", { device: SECOND_BY_PATH });
    expect(again.status).toBe(409);
    expect(loadConfig(configPath).cameras.filter((c) => c.device === SECOND_BY_PATH).length).toBe(1);
  });

  it("refuses a socket this board cannot see, because that entry could never answer", async () => {
    const r = provisioned({ cameras: fixtureDetection() });
    const res = await r("POST", "/cameras", { device: "platform-nothing-is-plugged-in-here" });
    expect(res.status).toBe(404);
    expect(loadConfig(configPath).cameras.some((c) => c.device.includes("nothing"))).toBe(false);
  });

  it("names the body it wants when given none", async () => {
    const res = await provisioned({ cameras: fixtureDetection() })("POST", "/cameras", {});
    expect(res.status).toBe(400);
    expect(String((res.body as { error: string }).error)).toContain("device");
  });

  /**
   * **Every configured camera reaches the page, present or not** (R-CAM-20).
   *
   * Asserted here as well as in `present.test.ts` for the reason the rate
   * assertion above gives: that file proves what `cameraIndex()` composes and
   * cannot prove that the daemon hands it the configuration to compose it
   * from. This route is the only place the seam is ever used, and the defect
   * the operator found was a page that drew nothing for two configured
   * cameras while the navigation — built from the same file — carried both.
   */
  it("puts every configured camera on the index, including one the sweep found nothing for", async () => {
    // The board's own state: nothing on the bus, one camera configured.
    const r = provisioned({ cameras: { found: [], rejected: [] } });
    const body = (await r("GET", "/cameras", undefined)).body as {
      found: unknown[];
      index: { cameras: { id: string | null; state: string; device: string }[] };
    };
    expect(body.found, "the probe genuinely saw nothing").toHaveLength(0);
    expect(body.index.cameras, "and the configured camera is still on the page").toHaveLength(1);
    expect(body.index.cameras[0]).toMatchObject({ id: "cam0", state: "Not attached" });
    // Carrying the socket it expects — the one string an operator can act on.
    expect(body.index.cameras[0]?.device).toBe(CAMERA_BY_PATH);
  });

  /** And a camera that *is* there is drawn once, never also as absent. */
  it("draws a configured camera that is attached exactly once", async () => {
    const r = provisioned({ cameras: fixtureDetection() });
    const body = (await r("GET", "/cameras", undefined)).body as {
      index: { cameras: { id: string | null; state: string }[] };
    };
    expect(body.index.cameras).toHaveLength(1);
    expect(body.index.cameras[0]).toMatchObject({ id: "cam0", state: "Idle" });
  });

  /**
   * **`DELETE /cameras/:id` — the mirror of the adoption above** (R-CAM-21,
   * R-CAM-05, R-CFG-01, R-CFG-03).
   *
   * Found on a board, minutes after the adoption shipped. A camera had been
   * moved between USB ports; identity is the socket, so each move made it a
   * *different* camera as far as the configuration was concerned and nothing
   * ever removed the old one. The board carried two configured cameras
   * against ports with nothing in them and the camera in the operator's hand
   * matching neither. `POST /cameras` could adopt; nothing could undo it, and
   * the only repair left was editing `/etc/yonder/config.yaml` by hand on the
   * device — the exact thing R-CFG-01's single writer exists to prevent.
   */
  describe("DELETE /cameras/:id", () => {
    it.each(["revert", "rejected"])("retires a failed retry before asynchronous DELETE apply (%s)", async (outcome) => {
      vi.useFakeTimers();
      try {
        saveConfig(configPath, cameraConfig());
        const credential = new AdminCredential(new SecretStore(secretsPath));
        credential.set(GOOD);
        let exit: (arg: unknown) => void = () => {};
        let spawns = 0;
        const supervisor = new Supervisor({ spawner: () => {
          spawns++;
          return { kill() {}, on(event, fn) { if (event === "exit") exit = fn; } };
        } });
        let release: () => void = () => {};
        const blocked = new Promise<void>((resolve) => { release = resolve; });
        let first = true;
        const engine = new ApplyEngine({ configPath, journalPath, renderers: [{
          name: "slow", async render() {
            if (!first) return;
            first = false;
            await blocked;
            if (outcome === "rejected") throw new Error("renderer rejected removal");
          },
        }] });
        const r = createRouter({ engine, configPath, credential, supervisor });
        supervisor.start("cam0", ["pipeline"]);
        exit(1);
        expect(supervisor.state("cam0").state).toBe("failed");
        const removing = r("DELETE", "/cameras/cam0", undefined);
        await vi.advanceTimersByTimeAsync(1500);
        expect(spawns).toBe(1);
        release();
        const response = await removing;
        if (outcome === "revert") {
          expect(response.status).toBe(200);
          expect(loadConfig(configPath).cameras).toEqual([]);
          await engine.revertNow((response.body as { id: string }).id);
        }
        expect(loadConfig(configPath).cameras.map((c) => c.id)).toEqual(["cam0"]);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(spawns).toBe(1);
        expect(supervisor.state("cam0").state).toBe("stopped");
      } finally { vi.useRealTimers(); }
    });

    /** The ordinary case, and the one the operator was actually in. */
    it("removes a camera whose socket has nothing on it", async () => {
      // `cameras` is the *other* camera's detection, so the configured
      // `cam0` — on CAMERA_BY_PATH — is matched by nothing on the bus.
      const r = provisioned({
        cameras: { found: [], rejected: fixtureDetection().rejected },
      });
      expect(loadConfig(configPath).cameras.map((c) => c.id)).toEqual(["cam0"]);
      const res = await r("DELETE", "/cameras/cam0", undefined);
      expect(res.status).toBe(200);
      expect(loadConfig(configPath).cameras, "the entry left the configuration").toEqual([]);
      expect((res.body as { camera: string }).camera).toBe("cam0");
    });

    /**
     * **Through the apply engine, never a direct write** (R-CFG-03). The
     * answer carries the apply's own id, which is the confirmation handle —
     * a route that wrote `config.yaml` itself would have nothing to put here
     * and nothing to revert.
     */
    it("goes through the apply engine, so the change is journalled and revertible", async () => {
      const r = provisioned({ cameras: fixtureDetection() });
      const res = await r("DELETE", "/cameras/cam0", undefined);
      expect(res.status).toBe(200);
      const body = res.body as { camera: string; id: string; expiresAt: number | null };
      expect(body.id, "an apply id, which is what a confirm or a revert names").toBeTruthy();
      expect(body.id).not.toBe(body.camera);
      // And it really did revert: the engine's rollback target is the
      // configuration this route was handed, camera and all.
      await r("POST", "/revert", { id: body.id });
      expect(loadConfig(configPath).cameras.map((c) => c.id)).toEqual(["cam0"]);
    });

    /**
     * **Removing a camera is not a way to stop it** (R-CAM-21). An operator
     * stopping a feed should do it deliberately, on the key that says so.
     */
    it("refuses to remove a camera that is running, and says why", async () => {
      const r = provisioned({ cameras: fixtureDetection() });
      await r("POST", "/cameras/cam0/run", { action: "start" });
      const res = await r("DELETE", "/cameras/cam0", undefined);
      expect(res.status).toBe(409);
      const error = String((res.body as { error: string }).error);
      expect(error, "the reason, in words").toContain("stop it");
      expect(loadConfig(configPath).cameras.map((c) => c.id), "and nothing was written")
        .toEqual(["cam0"]);
    });

    /**
     * The refusal is the *row's* refusal — one sentence, composed in
     * `video/present.ts` and read by both. Two wordings for one rule is how a
     * page and a daemon come to disagree about why something did not happen.
     */
    it("refuses in the same words the row draws the key inoperative with", async () => {
      const r = provisioned({ cameras: fixtureDetection() });
      await r("POST", "/cameras/cam0/run", { action: "start" });
      const listed = (await r("GET", "/cameras", undefined)).body as {
        index: { cameras: { id: string | null; removal: string | null }[] };
      };
      const row = listed.index.cameras.find((c) => c.id === "cam0");
      const refused = await r("DELETE", "/cameras/cam0", undefined);
      expect(row?.removal).toBe((refused.body as { error: string }).error);
    });

    it("answers 404 for an id nothing is configured under, and writes nothing", async () => {
      const r = provisioned({ cameras: fixtureDetection() });
      const res = await r("DELETE", "/cameras/cam9", undefined);
      expect(res.status).toBe(404);
      expect(loadConfig(configPath).cameras.map((c) => c.id)).toEqual(["cam0"]);
    });

    /**
     * The id off a URL is matched against `CAMERA_ID` before it is used for
     * anything at all — before the configuration is even read. The same guard
     * every other camera route is behind, reached through this verb too.
     */
    it("refuses an id that is not one, rather than joining it to anything", async () => {
      const r = provisioned({ cameras: fixtureDetection() });
      expect((await r("DELETE", "/cameras/..%2F..%2Fetc", undefined)).status).toBe(404);
      expect((await r("DELETE", "/cameras/../../etc", undefined)).status).toBe(404);
    });

    /**
     * **The camera goes; its captures stay.** The removal is revertible
     * (R-CFG-03) and deleting the recordings would make half of it
     * irreversible while the console told the operator the whole thing could
     * be undone. R-CAM-18 gives deleting a capture its own control, on the
     * camera's own page, where an operator does it deliberately.
     */
    it("leaves the captures the camera already made on the board", async () => {
      const captures = join(dir, "captures", "cam0");
      mkdirSync(captures, { recursive: true });
      writeFileSync(join(captures, "a-recording.mp4"), "not really an mp4");
      const r = provisioned({ cameras: fixtureDetection() });
      expect((await r("DELETE", "/cameras/cam0", undefined)).status).toBe(200);
      expect(existsSync(join(captures, "a-recording.mp4"))).toBe(true);
    });

    /**
     * The other half of what the page then shows: the row does not vanish
     * where the camera is still on the bus — it comes back as a detection
     * nothing is configured for, with the key that adopts it (R-UI-03).
     */
    it("leaves a camera that is still attached listed, with no id", async () => {
      const r = provisioned({ cameras: fixtureDetection() });
      await r("DELETE", "/cameras/cam0", undefined);
      const body = (await r("GET", "/cameras", undefined)).body as {
        index: { cameras: { id: string | null; state: string }[] };
      };
      expect(body.index.cameras).toHaveLength(1);
      expect(body.index.cameras[0]).toMatchObject({ id: null, state: "Not configured" });
    });

    /** R-SEC-09: it is behind the administrator gate like every other write. */
    it("is refused outright while no administrator password is set", async () => {
      const res = await router({ cameras: fixtureDetection() })("DELETE", "/cameras/cam0", undefined);
      expect(res.status).toBe(403);
      expect(loadConfig(configPath).cameras.map((c) => c.id)).toEqual(["cam0"]);
    });
  });

  it("puts no rate on an index row, because nothing on this device measures one", async () => {
    const r = provisioned({ cameras: fixtureDetection() });
    await r("POST", "/cameras/cam0/run", { action: "start" });
    const body = (await r("GET", "/cameras", undefined)).body as {
      index: { cameras: { id: string | null; state: string; rate: number | null }[] };
    };
    const row = body.index.cameras[0]!;
    expect(row.id).toBe("cam0");
    // The state proves the row is live rather than a default: a stopped
    // camera reading `null` would pass this test for the wrong reason. Either
    // running word will do — which of the two the supervisor is on a
    // millisecond after `start` is not this test's subject.
    expect(["Starting", "Streaming"]).toContain(row.state);
    expect(row.rate, "a rate nobody measured is a rate nobody should act on")
      .toBeNull();
  });

  /** R-CAM-05: the sentence the daemon composes reaches the page's payload. */
  it("carries each index row's identity sentence", async () => {
    const body = (await provisioned({ cameras: fixtureDetection() })("GET", "/cameras", undefined))
      .body as { index: { cameras: { identity: string }[] } };
    expect(body.index.cameras[0]!.identity).toContain(CAMERA_BY_PATH);
    expect(body.index.cameras[0]!.identity).toMatch(/survives a reboot|different camera after a reboot/);
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
    expect((await r("GET", "/cameras/cam9/stream-address", undefined)).status).toBe(404);
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

  it("resolves the RTSP credential into the stream address, and nowhere else", async () => {
    // R-SEC-10: never in a log, an error, or a support bundle. This route is
    // the one place the value is allowed out, because the operator is being
    // handed a URL to copy.
    const r = provisioned({ cameras: fixtureDetection() });
    const line = await r("GET", "/cameras/cam0/stream-address", undefined);
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

    /**
     * **The Resolution and Frame rate pickers, followed to `config.yaml`**
     * (R-VID-07, R-CAM-14, R-CTL-05).
     *
     * Not to `GET /config`, which is the router answering out of its own
     * memory, but to the bytes on disk: four separate defects on this branch
     * were a control that drew, posted and changed nothing, the last of them
     * a draft field the apply silently dropped while answering 200. The file
     * is the only place that cannot lie about it.
     */
    it("writes a staged size and rate through to config.yaml", async () => {
      const r = provisioned({ cameras: fixtureDetection() });
      const out = await r("POST", "/cameras/cam0/apply", {
        width: 1920, height: 1080, framerate: 30,
      });
      expect(out.status).toBe(200);
      const onDisk = loadConfig(configPath).cameras[0];
      expect(onDisk?.width).toBe(1920);
      expect(onDisk?.height).toBe(1080);
      expect(onDisk?.framerate).toBe(30);
      // And the deck the console reads next carries it back as values, which
      // is what a picker is drawn from and what a staged edit is compared
      // against — a `spec` string is neither.
      const deck = ((await r("GET", "/cameras/cam0", undefined)).body as {
        deck: { policy: { capture: unknown }; applied: { capture: unknown } };
      }).deck;
      expect(deck.policy.capture).toEqual({ width: 1920, height: 1080, framerate: 30, codec: "h264" });
      expect(deck.applied.capture).toEqual(deck.policy.capture);
    });

    /**
     * **A pair this camera cannot make is refused here, not by the pipeline**
     * (R-CAM-14, R-CFG-03).
     *
     * The fixture offers 30, 24 and 15 at 1280×720 and 30 alone at
     * 1920×1080. Left to `video/pipeline.ts`'s `refuse()`, the same pair
     * would be caught one layer later — after the engine had written the
     * document and armed the window, with the picture gone until the rollback
     * took it back. Refused by name instead, so the deck marks the picker.
     */
    it("refuses a rate this camera does not make at the size being staged", async () => {
      const r = provisioned({ cameras: fixtureDetection() });
      const before = readFileSync(configPath, "utf8");
      const out = await r("POST", "/cameras/cam0/apply", {
        width: 1920, height: 1080, framerate: 24,
      });
      expect(out.status).toBe(400);
      const { problems } = out.body as { problems: { path: string; message: string }[] };
      // Named for the picker that has to change — the rate, because the size
      // is one the camera does offer.
      expect(problems.map((p) => p.path)).toEqual(["framerate"]);
      expect(problems[0]?.message).toContain("24 fps at 1920x1080");
      expect(readFileSync(configPath, "utf8"), "a refused apply writes nothing").toBe(before);
      // 24 is a rate this camera makes, at the size it is running now, so the
      // refusal is about the pair and not about the number — a guard that
      // rejected 24 outright would pass every assertion above.
      expect((await r("POST", "/cameras/cam0/apply", { framerate: 24 })).status).toBe(200);
      expect(loadConfig(configPath).cameras[0]?.framerate).toBe(24);
    });

    /**
     * The other half of the same guard, and the half only a hand-edited
     * request can reach: the picker is built from `captureSizes()` and offers
     * nothing else.
     */
    it("refuses a size this camera never offered, and names the size picker", async () => {
      const r = provisioned({ cameras: fixtureDetection() });
      const out = await r("POST", "/cameras/cam0/apply", { width: 3840, height: 2160 });
      expect(out.status).toBe(400);
      const { problems } = out.body as { problems: { path: string; message: string }[] };
      expect(problems.map((p) => p.path)).toEqual(["width"]);
      expect(problems[0]?.message).toContain("3840x2160");
      expect(loadConfig(configPath).cameras[0]?.width).toBe(1280);
    });

    /**
     * **Judged over the draft laid on what is applied, not over the draft
     * alone.** An operator who changes only the rate has staged no size, and
     * the size that rate has to be legal at is the one already running — so a
     * check that looked at the draft by itself would let every lone rate
     * through and leave the pair to the pipeline.
     */
    it("checks a lone staged rate against the size already running", async () => {
      const r = provisioned({ cameras: fixtureDetection(), camera: { width: 1920, height: 1080 } });
      // 24 is legal at 1280×720 and this camera is running 1920×1080, where
      // only 30 is offered. Nothing in the draft says 1920×1080.
      const out = await r("POST", "/cameras/cam0/apply", { framerate: 24 });
      expect(out.status).toBe(400);
      expect(JSON.stringify(out.body)).toContain("24 fps at 1920x1080");
      expect(loadConfig(configPath).cameras[0]?.framerate).toBe(30);
    });

    /**
     * A capture change restarts the picture, and the operator is told —
     * `interruption()`, the same function the deck calls over its own staged
     * draft before the press. It was empty for a board turn once and the
     * operator met the cut with nothing having warned of it.
     */
    it("says a staged size restarts the picture", async () => {
      const r = provisioned({ cameras: fixtureDetection() });
      const out = await r("POST", "/cameras/cam0/apply", { width: 1920, height: 1080 });
      expect(out.status).toBe(200);
      expect((out.body as { interruption: string[] }).interruption)
        .toEqual(["restarts the picture"]);
      // ...and not for a size that is already the one running: a warning
      // about a restart that will not happen teaches an operator to stop
      // reading them.
      const same = await provisioned({ cameras: fixtureDetection() })(
        "POST", "/cameras/cam0/apply", { width: 1280, height: 720 },
      );
      expect((same.body as { interruption: string[] }).interruption).toEqual([]);
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
      //
      // **15 and not 25, and the difference is a second guarantee**: this
      // fixture offers 30, 24 and 15 at 1280x720 and the route now refuses a
      // rate the camera does not make, so 25 answers 400 and would exercise
      // nothing about the window. See the two tests that own that refusal.
      const kept = await provisioned({ cameras: fixtureDetection() })(
        "POST", "/cameras/cam0/apply", { framerate: 15 },
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
  /**
   * Recording, stills, and the captures this device is holding (R-CAM-17,
   * R-CAM-18, R-STO-06).
   *
   * `video/recorder.test.ts` is where the mechanism is proved — the reserve,
   * the pending guard, the naming. What is proved here is the seam: which
   * status each refusal becomes, that a capture leaves as bytes with a
   * content type rather than as JSON, and that a name off a URL cannot become
   * a path this device did not write.
   */
  describe("the capture routes", () => {
    /** A recorder with a stand-in for the pipeline host under it. */
    function recorderOn(opts: {
      free?: number;
      running?: boolean;
      onCamera?: CameraMedium;
      deaf?: boolean;
    } = {}) {
      // Under this test's own directory, which afterEach removes.
      const root = mkdtempSync(join(dir, "captures-"));
      const sent: Record<string, unknown>[] = [];
      const listeners: ((camera: string, line: string) => void)[] = [];
      const held = new Map<string, string>();
      const recorder = new Recorder({
        channel: {
          send: (camera, message) => {
            const m = message as Record<string, unknown>;
            sent.push(m);
            if (opts.deaf === true) return false;
            queueMicrotask(() => {
              const path = String(m.path ?? held.get(camera) ?? "");
              let observed: unknown;
              if (m.op === "still") {
                writeFileSync(path, "a jpeg");
                observed = { path, bytes: 6, width: 1280, height: 720 };
              } else if (m.op === "record") {
                writeFileSync(path, "mkv");
                held.set(camera, path);
                observed = { path, recording: true };
              } else {
                held.delete(camera);
                observed = { path, bytes: 3, recording: false };
              }
              const line = JSON.stringify({ id: m.id, pid: 1, continuous: true, observed });
              for (const fn of listeners) fn(camera, line);
            });
            return true;
          },
          onMessage: (fn) => { listeners.push(fn); },
          state: (camera) => ({
            id: camera,
            state: opts.running === false ? "stopped" : "running",
            since: 0,
            restarts: 0,
          }),
        },
        cameras: () => loadConfig(configPath).cameras,
        reserveMb: () => loadConfig(configPath).storage.reserve_mb,
        freeBytes: () => Promise.resolve(opts.free ?? 8 * 1024 * 1024 * 1024),
        root,
        clock: frozenClock,
        ...(opts.onCamera === undefined ? {} : { onCamera: opts.onCamera }),
      });
      return { recorder, sent, root };
    }

    /** The camera's own medium, modelled: one file Yonder never saw. */
    const ON_CAMERA: Capture = {
      name: "DJI_0001.MP4", at: 1_699_000_000_000, bytes: 91_000_000,
      width: 1920, height: 1080, held: "camera",
    };
    const CARD: CameraMedium = {
      holds: () => true,
      captures: () => Promise.resolve([ON_CAMERA]),
    };

    it("is 403 while unprovisioned, like every other configuration route", async () => {
      const { recorder } = recorderOn();
      const r = router({ cameras: fixtureDetection(), recorder });
      expect((await r("POST", "/cameras/cam0/record", { action: "start" })).status).toBe(403);
      expect((await r("POST", "/cameras/cam0/photo", undefined)).status).toBe(403);
      expect((await r("GET", "/cameras/cam0/captures", undefined)).status).toBe(403);
    });

    it("starts a recording and answers with what is being written", async () => {
      const { recorder, sent } = recorderOn();
      const r = provisioned({ cameras: fixtureDetection(), recorder });
      const res = await r("POST", "/cameras/cam0/record", { action: "start" });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ recording: true, destination: "board" });
      expect(sent.map((m) => m.op)).toEqual(["record"]);
    });

    it("refuses a second press while one is in flight, rather than queueing it", async () => {
      // One at a time, per camera. Two branches on one tee is what the guard
      // exists to prevent, and 409 is the honest answer to the second press.
      const { recorder, sent } = recorderOn();
      const r = provisioned({ cameras: fixtureDetection(), recorder });
      const first = r("POST", "/cameras/cam0/record", { action: "start" });
      const second = await r("POST", "/cameras/cam0/photo", undefined);
      expect(second.status).toBe(409);
      expect((second.body as { error: string }).error).toContain("one at a time");
      expect((await first).status).toBe(200);
      expect(sent.map((m) => m.op)).toEqual(["record"]);
    });

    it("refuses a start at the reserve, with the reason in words an operator reads", async () => {
      const { recorder, sent } = recorderOn({ free: 1024 * 1024 * 1024 });
      const r = provisioned({ cameras: fixtureDetection(), recorder });
      const res = await r("POST", "/cameras/cam0/record", { action: "start" });
      expect(res.status).toBe(409);
      expect((res.body as { error: string }).error)
        .toContain("1024 MB is reserved on this device");
      // Nothing was written, and nothing was asked of the pipeline.
      expect(sent).toEqual([]);
    });

    it("refuses a recording on a camera that is not running", async () => {
      const { recorder } = recorderOn({ running: false });
      const r = provisioned({ cameras: fixtureDetection(), recorder });
      const res = await r("POST", "/cameras/cam0/record", { action: "start" });
      expect(res.status).toBe(409);
      expect((res.body as { error: string }).error).toContain("no pipeline to record");
    });

    it("refuses an action that is neither start nor stop", async () => {
      const { recorder } = recorderOn();
      const r = provisioned({ cameras: fixtureDetection(), recorder });
      expect((await r("POST", "/cameras/cam0/record", { action: "pause" })).status).toBe(400);
    });

    it("is 404 for a camera this device does not have", async () => {
      const { recorder } = recorderOn();
      const r = provisioned({ cameras: fixtureDetection(), recorder });
      expect((await r("POST", "/cameras/cam9/record", { action: "start" })).status).toBe(404);
      expect((await r("GET", "/cameras/cam9/captures", undefined)).status).toBe(404);
    });

    it("answers a still with the capture, once the file is written", async () => {
      const { recorder } = recorderOn();
      const r = provisioned({ cameras: fixtureDetection(), recorder });
      const res = await r("POST", "/cameras/cam0/photo", undefined);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ width: 1280, height: 720, held: "board", bytes: 6 });
    });

    it("lists the captures, newest first", async () => {
      const { recorder } = recorderOn();
      const r = provisioned({ cameras: fixtureDetection(), recorder });
      await r("POST", "/cameras/cam0/photo", undefined);
      const res = await r("GET", "/cameras/cam0/captures", undefined);
      expect(res.status).toBe(200);
      const { camera, captures } = res.body as {
        camera: string; captures: { name: string; held: string }[];
      };
      expect(captures).toHaveLength(1);
      expect(captures[0].held).toBe("board");
      // **The listing says whose it is.** The panel builds every thumbnail,
      // View and Download URL from this id, and the node that fetched the
      // list emits a fresh message that carries no `msg.camera` of its own.
      expect(camera).toBe("cam0");
    });

    it("puts the recorder and the count on the deck payload, from the same read", async () => {
      const { recorder } = recorderOn();
      const r = provisioned({ cameras: fixtureDetection(), recorder });
      await r("POST", "/cameras/cam0/photo", undefined);
      const view = (await r("GET", "/cameras/cam0", undefined)).body as {
        deck: { captures: { count: number }; recorder: unknown };
        recorder: unknown;
      };
      expect(view.deck.captures).toEqual({ count: 1 });
      // One read, one answer: the REC pill on the picture and the shutter key
      // under it must not be able to disagree.
      expect(view.deck.recorder).toEqual(view.recorder);
      expect((view as any).picture.recording).toEqual(view.recorder);
      expect((view as any).picture.path).toBe(view.camera.id);
      expect((view as any).picture.cost).toBe(view.display.pictureCost);
      expect((view as any).picture.aim).toEqual(view.aim);
    });

    it("hands one over as bytes with a content type, not as JSON", async () => {
      const { recorder } = recorderOn();
      const r = provisioned({ cameras: fixtureDetection(), recorder });
      const taken = (await r("POST", "/cameras/cam0/photo", undefined)).body as { name: string };
      const res = await r("GET", `/cameras/cam0/captures/${taken.name}`, undefined);
      expect(res.status).toBe(200);
      expect(res.contentType).toBe("image/jpeg");
      expect(Buffer.isBuffer(res.body)).toBe(true);
      expect((res.body as Buffer).toString("utf8")).toBe("a jpeg");
    });

    it("deletes one, and it is gone from the listing", async () => {
      const { recorder } = recorderOn();
      const r = provisioned({ cameras: fixtureDetection(), recorder });
      const taken = (await r("POST", "/cameras/cam0/photo", undefined)).body as { name: string };
      expect((await r("DELETE", `/cameras/cam0/captures/${taken.name}`, undefined)).status).toBe(200);
      const after = await r("GET", "/cameras/cam0/captures", undefined);
      expect((after.body as { captures: unknown[] }).captures).toEqual([]);
    });

    it("is 404 for a capture the camera holds, and says the camera holds it", async () => {
      // Yonder never saw the file. A 404 with the reason is the honest answer;
      // offering it and failing later would be the console claiming something
      // it does not have.
      const { recorder } = recorderOn({ onCamera: CARD });
      const r = provisioned({ cameras: fixtureDetection(), recorder });
      const listed = await r("GET", "/cameras/cam0/captures", undefined);
      expect((listed.body as { captures: { held: string }[] }).captures[0].held).toBe("camera");

      for (const method of ["GET", "DELETE"]) {
        const res = await r(method, `/cameras/cam0/captures/${ON_CAMERA.name}`, undefined);
        expect(res.status, method).toBe(404);
        expect((res.body as { error: string }).error, method).toContain("never saw the file");
      }
    });

    it("will not record or photograph on a camera that holds its own", async () => {
      const { recorder, sent } = recorderOn({ onCamera: CARD });
      const r = provisioned({ cameras: fixtureDetection(), recorder });
      expect((await r("POST", "/cameras/cam0/record", { action: "start" })).status).toBe(409);
      expect((await r("POST", "/cameras/cam0/photo", undefined)).status).toBe(409);
      expect(sent).toEqual([]);
    });

    /**
     * The second place in this router where something off a URL becomes part
     * of a file path — the first is the camera id. A pattern, not a filter for
     * `..`: a filter is a list of the tricks somebody thought of.
     */
    it("refuses a capture name that is not one, however it is spelled", async () => {
      const { recorder } = recorderOn();
      const r = provisioned({ cameras: fixtureDetection(), recorder });
      for (const name of [
        "..%2F..%2Fetc%2Fyonder%2Fsecrets.yaml",
        "..",
        "%2e%2e%2f%2e%2e%2fetc%2fpasswd",
        "%zz",
      ]) {
        const res = await r("GET", `/cameras/cam0/captures/${name}`, undefined);
        expect(res.status, name).toBe(404);
        expect(res.contentType, name).toBeUndefined();
      }
    });

    it("carries the recorder's state on the camera's own page", async () => {
      const { recorder } = recorderOn();
      const r = provisioned({ cameras: fixtureDetection(), recorder });
      await r("POST", "/cameras/cam0/record", { action: "start" });
      const page = await r("GET", "/cameras/cam0", undefined);
      expect((page.body as { recorder: unknown }).recorder)
        .toMatchObject({ recording: true, destination: "board" });
    });

    it("says so rather than answering when this daemon has no recorder", async () => {
      // Never an empty capture list, which would read as *nothing has been
      // recorded* on a device that cannot tell.
      const r = provisioned({ cameras: fixtureDetection() });
      const res = await r("GET", "/cameras/cam0/captures", undefined);
      expect(res.status).toBe(503);
      expect((await r("GET", "/cameras/cam0", undefined)).body)
        .toMatchObject({ recorder: null });
    });
  });

  /**
   * The latest still, with its age, and the strip it is drawn in (R-VID-14,
   * R-VID-11, R-STO-01; blueprint L-20, L-22).
   *
   * The stand-in for the pipeline host writes a real JPEG where it is told
   * to, so the bytes the route hands over are bytes read off a real
   * directory; the clock is the test's, so the age is a number the test
   * chose rather than one it measured.
   */
  describe("GET /cameras/:id/still", () => {
    // A JPEG's magic number and enough behind it to cost something at the
    // interval: ten bytes every five seconds rounds to 0 kb/s, and a copy
    // that costs nothing cannot prove it was counted.
    const JPEG = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]),
      Buffer.alloc(20_000, 0x2e),
    ]);
    let nowMs = 1_700_000_000_000;
    const ticking: Clock = { now: () => nowMs, setTimer: () => 1, clearTimer: () => {} };

    /** A generator with a stand-in for the pipeline host under it. */
    function stillsOn(opts: { running?: boolean } = {}) {
      const root = mkdtempSync(join(dir, "stills-"));
      const listeners: ((camera: string, line: string) => void)[] = [];
      const stills = new Stills({
        channel: {
          send: (camera, message) => {
            const m = message as { id: string; path: string };
            writeFileSync(m.path, JPEG);
            queueMicrotask(() => {
              const observed = { path: m.path, bytes: JPEG.length, width: 1280, height: 720 };
              for (const fn of listeners) {
                fn(camera, JSON.stringify({ id: m.id, pid: 1, continuous: true, observed }));
              }
            });
            return true;
          },
          onMessage: (fn) => { listeners.push(fn); },
          state: (camera) => ({
            id: camera, state: opts.running === false ? "stopped" : "running", since: 0, restarts: 0,
          }),
        },
        cameras: () => loadConfig(configPath).cameras,
        wanted: () => loadConfig(configPath).cameras.map((c) => c.id),
        root,
        clock: ticking,
      });
      const viewers = new Viewers({
        cameras: () => loadConfig(configPath).cameras,
        inForce: () => null,
        clock: ticking,
        stillFor: (id) => stills.latest(id),
      });
      return { stills, viewers, root };
    }

    /** A second configured camera beside the fixture's, so the strip has an
     *  *other* camera to draw as a still. */
    function withTail(): void {
      const config = loadConfig(configPath);
      const nose = config.cameras[0]!;
      saveConfig(configPath, {
        ...config,
        cameras: [nose, { ...nose, id: "tail", name: "Tail", device: `${nose.device}-tail` }],
      });
    }

    beforeEach(() => { nowMs = 1_700_000_000_000; });

    it("is 403 while unprovisioned, like every other configuration route", async () => {
      const { stills } = stillsOn();
      const r = router({ cameras: fixtureDetection(), stills });
      expect((await r("GET", "/cameras/cam0/still", undefined)).status).toBe(403);
    });

    it("hands over the latest still as bytes, with when it was taken and how old it is", async () => {
      const { stills } = stillsOn();
      const r = provisioned({ cameras: fixtureDetection(), stills, clock: ticking });
      await stills.tick();
      nowMs += 1_500;
      const res = await r("GET", "/cameras/cam0/still", undefined);
      expect(res.status).toBe(200);
      expect(res.contentType).toBe("image/jpeg");
      expect(res.body).toEqual(JPEG);
      // The frame's own stamp, and its age by the clock that stamped it: a
      // browser cannot compare this device's clock with its own, so it is
      // told the age rather than left to work one out (R-VID-14).
      expect(res.headers).toEqual({
        "x-yonder-still-at": String(nowMs - 1_500),
        "x-yonder-still-age": "1500",
      });
    });

    it("counts each answer as one transmission to the viewer that asked (R-VID-11)", async () => {
      const { stills, viewers } = stillsOn();
      const r = provisioned({ cameras: fixtureDetection(), stills, viewers, clock: ticking });
      await stills.tick();
      const copy = stillCostKbps(JPEG.length, STILLS_INTERVAL_MS);

      expect((await r("GET", "/cameras/cam0/still?viewer=aaaa", undefined)).status).toBe(200);
      const oneCopy = viewers.state("cam0", "aaaa").cost.path;
      expect((await r("GET", "/cameras/cam0/still?viewer=aaaa", undefined)).status).toBe(200);
      expect((await r("GET", "/cameras/cam0/still?viewer=bbbb", undefined)).status).toBe(200);
      // Three answers, including two to one session, are three copies of one
      // image. Sharing generation must not collapse actual transmissions.
      expect(copy).toBeGreaterThan(0);
      expect(viewers.state("cam0", "aaaa").cost.mine).toBe(2 * copy);
      expect(viewers.state("cam0", "bbbb").cost.mine).toBe(copy);
      expect(viewers.stillsKbps()).toBe(3 * copy);
      expect(viewers.state("cam0", "aaaa").cost.path).toBe(oneCopy + 2 * copy);
      expect(viewers.state("cam0", "aaaa")).toMatchObject({
        mine: { delivery: "off", frameAge: null }, cost: { mine: 2 * copy },
      });

      // A caller naming no viewer — a shell on the socket — is served and
      // counted against nobody: nothing left the aircraft.
      expect((await r("GET", "/cameras/cam0/still", undefined)).status).toBe(200);
      expect(viewers.stillsKbps()).toBe(3 * copy);
    });

    it("says in words that there is no still yet", async () => {
      const { stills } = stillsOn();
      const r = provisioned({ cameras: fixtureDetection(), stills });
      const res = await r("GET", "/cameras/cam0/still", undefined);
      expect(res.status).toBe(404);
      expect(res.contentType).toBeUndefined();
      expect((res.body as { error: string }).error).toMatch(/no still of cam0 yet/);
    });

    it("says in words that the camera is not running", async () => {
      const { stills } = stillsOn({ running: false });
      const r = provisioned({ cameras: fixtureDetection(), stills });
      const res = await r("GET", "/cameras/cam0/still", undefined);
      expect(res.status).toBe(404);
      expect((res.body as { error: string }).error).toContain("cam0 is not running");
    });

    it("refuses a viewer id that could address another route, and counts nothing", async () => {
      const { stills, viewers } = stillsOn();
      const r = provisioned({ cameras: fixtureDetection(), stills, viewers });
      await stills.tick();
      const res = await r("GET", "/cameras/cam0/still?viewer=..%2Fadmin", undefined);
      expect(res.status).toBe(404);
      expect(viewers.stillsKbps()).toBe(0);
    });

    it("takes GET and nothing else", async () => {
      const { stills } = stillsOn();
      const r = provisioned({ cameras: fixtureDetection(), stills });
      await stills.tick();
      for (const method of ["POST", "DELETE", "PUT"]) {
        expect((await r(method, "/cameras/cam0/still", undefined)).status, method).toBe(404);
      }
    });

    it("is 404 for a camera this device does not have", async () => {
      const { stills } = stillsOn();
      const r = provisioned({ cameras: fixtureDetection(), stills });
      const res = await r("GET", "/cameras/nope/still", undefined);
      expect(res.status).toBe(404);
      expect((res.body as { error: string }).error).toContain("no camera is configured");
    });

    it("says so rather than answering when this daemon has no stills", async () => {
      const r = provisioned({ cameras: fixtureDetection() });
      expect((await r("GET", "/cameras/cam0/still", undefined)).status).toBe(503);
    });

    it("carries the strip on the camera's own page, from the same read (L-20, L-22)", async () => {
      const { stills, viewers } = stillsOn();
      const r = provisioned({ cameras: fixtureDetection(), stills, viewers, clock: ticking });
      withTail();
      // Only the fixture's own camera can be started here; `tail` names a
      // socket the sweep did not find, so the supervisor holds it stopped.
      expect((await r("POST", "/cameras/cam0/run", { action: "start" })).status).toBe(200);
      await stills.tick();
      const taken = nowMs;
      nowMs += 4_200;
      await r("GET", "/cameras/cam0/still?viewer=aaaa", undefined);

      const page = (await r("GET", "/cameras/cam0", undefined)).body as {
        picture: { cameras: Record<string, unknown>[]; downlink: string };
      };
      // One row per configured camera. This one is active, with its still's
      // age and a real image even when it is the only available camera. The
      // other is **stopped on the page even though the generator's stand-in
      // holds a frame for it**: the run state is the supervisor's, and a
      // camera the supervisor is not running has no still to show, whatever
      // is on the tmpfs (`server.wiring.test.ts` draws the running case, with
      // the one supervisor both read).
      expect(stills.latest("tail")?.at).toBe(taken);
      expect(page.picture.cameras).toMatchObject([
        { id: "cam0", name: expect.any(String), active: true, ageSeconds: 4,
          thumbSrc: expect.stringMatching(/^\/video\/cam0\/still\?at=\d+$/), stopped: false },
        { id: "tail", name: "Tail", active: false, ageSeconds: null, thumbSrc: null, stopped: true },
      ]);
      // And what every still copy is costing, in the blueprint's words —
      // the one copy served above, for the page's own camera.
      const copy = stillCostKbps(JPEG.length, STILLS_INTERVAL_MS);
      expect(copy).toBeGreaterThan(0);
      expect(page.picture.downlink).toBe(`${String(Math.round(copy))} kb/s of stills · counted in Path total`);
    });

    it("draws the strip with nothing in it on a daemon with no video layer", async () => {
      const r = provisioned({ cameras: fixtureDetection() });
      withTail();
      const page = (await r("GET", "/cameras/cam0", undefined)).body as {
        picture: { cameras: Record<string, unknown>[]; downlink: string };
      };
      expect(page.picture.cameras).toHaveLength(2);
      expect(page.picture.cameras.every((c) => c.thumbSrc === null)).toBe(true);
      expect(page.picture.downlink).toBe("0 kb/s of stills · counted in Path total");
    });
  });

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
    const chosen = await r("GET", "/cameras/cam0/stream-address?address=10.147.17.42", undefined);
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
    const out = await r("GET", "/cameras/cam0/stream-address?address=evil.example", undefined);
    expect(JSON.stringify(out.body)).not.toContain("evil.example");
    expect(JSON.stringify(out.body)).toContain("192.168.77.1:8554/cam0");
  });

  /**
   * **R-UI-24 at the join, which is where it was unguarded.**
   *
   * `renderReceive()` decides whether a line can be used and `receive.test.ts`
   * holds it to that — over paths *it* supplies. None of that is worth
   * anything if this route hands it a set of paths that is not the device's:
   * a hardcoded `{ lan: true, mesh: true, cellular: true }` here would leave
   * every test in that file green and every line on a flying aircraft marked
   * usable. So the guarantee is tested through the one hop that carries it,
   * in both directions, from the same `reachState` the deck's own outputs
   * are drawn from.
   */
  describe("the stream address is drawn against this device's own paths", () => {
    const only = (path: PathName): ReachState => ({
      inUse: path,
      carrying: true,
      paths: [{
        path, device: "x", standing: "in-use", since: null,
        evidence: "reaching", detail: "Carrying traffic",
      }],
    });
    const lineOf = async (state: ReachState, kind: string): Promise<{ usable: boolean; note: string }> => {
      const r = provisioned({ cameras: fixtureDetection(), reachState: async () => state });
      const out = await r("GET", "/cameras/cam0/stream-address", undefined);
      const found = (out.body as { renderings: { kind: string; usable: boolean; note: string }[] })
        .renderings.find((x) => x.kind === kind);
      if (found === undefined) throw new Error(`no ${kind} rendering`);
      return found;
    };

    it("marks the RTSP URL unusable when the only path up is the modem", async () => {
      const url = await lineOf(only("modem"), "url");
      expect(url.usable).toBe(false);
      expect(url.note).toMatch(/^unusable — /);
      expect(url.note).toMatch(/cellular/);
    });

    it("marks it usable on ethernet, so the mark follows the paths and is not always on", async () => {
      expect((await lineOf(only("ethernet"), "url")).usable).toBe(true);
    });

    it("leaves the outbound push usable on the modem, because it dials out", async () => {
      expect((await lineOf(only("modem"), "gstreamer")).usable).toBe(true);
    });
  });

  /**
   * **The dial-in subset reaches the rendering** (R-UI-24) — the second half
   * of the same join as the paths above, and the one that was wrong.
   *
   * `renderReceive()` decides which address the RTSP URL is built from, and
   * `receive.test.ts` holds it to that over a set *it* supplies. If this route
   * hands it every address rather than the dialable ones, the flying case
   * silently comes back: a URL carrying the modem's address under a sentence
   * saying a mesh peer can reach it.
   */
  it("builds the RTSP URL from an address a peer can dial in to", async () => {
    const r = provisioned({
      cameras: fixtureDetection(),
      addresses: [
        // The console arrived on the modem's address — first in the list, as
        // `server.ts` orders it — and nothing can dial in to that one. The
        // access point's is reported before the mesh's on every board whose
        // radio is serving, and satisfies no verdict.
        { address: "100.72.14.9", path: "cellular" },
        { address: "192.168.77.1", path: "access-point" },
        { address: "10.147.17.42", path: "mesh" },
      ],
      remoteState: () => Promise.resolve(
        { online: true, addresses: ["10.147.17.42"] } as unknown as RemoteState,
      ),
    });
    const out = await r("GET", "/cameras/cam0/stream-address", undefined);
    const url = (out.body as { renderings: { kind: string; body: string; usable: boolean }[] })
      .renderings.find((x) => x.kind === "url");
    expect(url?.usable, "the mesh is up, so a peer can reach the listener").toBe(true);
    expect(url?.body).toContain("@10.147.17.42:8554/cam0");
    expect(url?.body).not.toContain("100.72.14.9");
    expect(url?.body, "the access point is not the mesh").not.toContain("192.168.77.1");
  });

  /**
   * R-UI-27: everywhere the camera is named, including the address for it.
   *
   * In the rendering a person reads, not as a field beside it: a ground
   * station's dialog holds one feed and the operator filling it in has to
   * know which camera they are pointing it at. A `camera` on the body that no
   * surface drew would be the name composed and never shown, which is the
   * shape R-CAM-05's identity sentence had for a whole commit.
   */
  it("names the camera the address is for, from the configuration", async () => {
    const r = provisioned({ cameras: fixtureDetection() });
    const out = await r("GET", "/cameras/cam0/stream-address", undefined);
    const dialog = (out.body as { renderings: { kind: string; body: string }[] })
      .renderings.find((x) => x.kind === "dialog");
    expect(dialog?.body).toContain("Nose");
  });

  it("never writes the RTSP credential to the journal", async () => {
    const written = await captureLog(async () => {
      const r = provisioned({ cameras: fixtureDetection() });
      await r("GET", "/cameras/cam0/stream-address", undefined);
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
    expect((await r("GET", "/cameras/cam0/stream-address", undefined)).status).toBe(503);
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
  it("derives exactly the four switches the schema declares boolean", () => {
    expect([...BOOLEAN_CONTROLS].sort())
      .toEqual(["autoFocus", "autoWhiteBalance", "horizontalFlip", "verticalFlip"]);
  });

  /**
   * R-CTL-05, at the hop that carries it onto the wire. A mirror reaches
   * this route as a boolean because the schema types it as one; a route that
   * still expected a number for it would refuse the whole body — and the
   * refusal is whole-body, so an operator moving brightness and the mirror
   * in one gesture would lose both.
   */
  it("takes a mirror and a flip as booleans, alongside a level, in one request", () => {
    expect(requestedControls({ brightness: 12, horizontalFlip: true, verticalFlip: false }))
      .toEqual({ brightness: 12, horizontalFlip: true, verticalFlip: false });
  });

  it("refuses degrees for a mirror — a flip is not a rotation", () => {
    // 180 is the number that makes this sharp: it is a legal `rotation`, and
    // a route that let it through for a flip would be accepting the very
    // collapse the two boolean fields exist to prevent.
    expect(requestedControls({ horizontalFlip: 180 })).toBeNull();
    expect(requestedControls({ verticalFlip: 0 })).toBeNull();
    // Rotation itself is unaffected and still a number.
    expect(requestedControls({ rotation: 180 })).toEqual({ rotation: 180 });
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

/**
 * The Telemetry page's five routes (R-MAV-09, R-MAV-10, R-DIA-04).
 *
 * Two properties carry this block. **`GET /mav/state` answers with both
 * halves** — what was measured about the aircraft, and whether this device is
 * actually putting it on the air — because `phase` reads `linked` whether
 * telemetry is running or deliberately switched off, and a page handed only
 * the first half cannot tell those apart. And **`ok: null` is not `false`**:
 * the path check draws a dash for a link nobody attempted and a cross only
 * for one that was attempted and is not working.
 *
 * Nothing here touches a serial port, a `systemctl` or a real renderer:
 * `MavlinkControl` is an injected interface for exactly the reason
 * `DiagProbes` is.
 */
describe("the telemetry routes", () => {
  const LINKED: LinkState = {
    phase: "linked",
    device: "/dev/ttyAMA0",
    baud: 57600,
    vehicle: "ArduPlane",
    system: 1,
    heartbeatHz: 1,
    lastHeardMs: 300,
    groundStations: [{ name: "gcs0", answering: true, lastHeardMs: 300 }],
    triedBauds: [],
    traffic: { rx: [0.4], tx: [3.1], peak: 3.1, windowMs: 5_000 },
    tcpClients: null,
  };

  const FOUND: DetectOutcome = {
    kind: "found", device: "/dev/ttyAMA0", baud: 57600, vehicle: "ArduPlane", system: 1,
  };

  /**
   * A telemetry layer with no renderer behind it.
   *
   * `telemetryRunning` is a **getter**, exactly as it is on `MavlinkRenderer`
   * — so a route that captured it once instead of reading it per request
   * fails here rather than on a board.
   */
  function fakeMavlink(opts: {
    link?: LinkState; running?: boolean; router?: boolean; outcome?: DetectOutcome; detectThrows?: string;
    /** The renderer already has the port. `MavlinkRenderer` refuses this way. */
    detectBusy?: boolean;
  } = {}) {
    let running = opts.running ?? true;
    let link = opts.link ?? LINKED;
    const calls: string[] = [];
    const control: MavlinkControl = {
      state: () => link,
      get telemetryRunning() { return running; },
      // Two facts, not one. A stop leaves the router up carrying the flight
      // controller link, so `router` defaults to true and stays true while
      // `running` goes false — which is the pair the Autopilot row reads.
      get routerRunning() { return opts.router ?? true; },
      detectNow: async () => {
        calls.push("detect");
        if (opts.detectBusy === true) throw new SweepInProgressError();
        if (opts.detectThrows !== undefined) throw new Error(opts.detectThrows);
        return opts.outcome ?? FOUND;
      },
      startTelemetry: async () => { calls.push("start"); running = true; },
      stopTelemetry: async () => { calls.push("stop"); running = false; },
    };
    return Object.assign(control, {
      calls,
      /** Move what the tracker would be reporting, the way a sweep would. */
      reports(next: LinkState) { link = next; },
    });
  }

  const ROUTES: [string, string][] = [
    ["GET", "/mav/state"], ["GET", "/mav/check"],
    ["POST", "/mav/detect"], ["POST", "/mav/start"], ["POST", "/mav/stop"],
  ];

  // R-SEC-09. A link state, a path check and a stop button are all function,
  // and a device with no administrator password on it offers none.
  it.each(ROUTES)("%s %s is behind the administrator password", async (method, path) => {
    const res = await router({ mavlink: fakeMavlink() })(method, path, undefined);
    expect(res.status).toBe(403);
  });

  /**
   * A daemon assembled with no telemetry layer at all. **No longer the
   * ordinary state of a board** — `mav/serial.ts` opens the port and `main()`
   * wires it in — so this now means only "started without a way to do
   * telemetry", which no production path produces. A 503 naming the absence
   * either way: never a 500, and never an empty link state a page would draw
   * as a device patiently searching.
   */
  it.each(ROUTES)("%s %s says so plainly when this build has no telemetry layer", async (method, path) => {
    const res = await provisioned({})(method, path, undefined);
    expect(res.status).toBe(503);
    expect((res.body as { error: string }).error).toMatch(/no telemetry layer/);
  });

  it("GET /mav/state answers with the measured link", async () => {
    const res = await provisioned({ mavlink: fakeMavlink() })("GET", "/mav/state", undefined);
    expect(res.status).toBe(200);
    expect((res.body as MavlinkStateBody).link).toEqual(LINKED);
  });

  /**
   * **The one way this route could be quietly wrong.**
   *
   * `phase` reads `linked` both when telemetry is flowing and when a link was
   * found and telemetry is deliberately switched off (R-MAV-09) or never
   * started (`autocast: false`, R-MAV-08). Answering with the link state alone
   * would drop the only field that tells those apart, and the page would
   * report a link that is carrying nothing as one that is carrying.
   */
  it("GET /mav/state tells a link that is switched off from one that is flowing", async () => {
    const flowing = await provisioned({ mavlink: fakeMavlink({ running: true }) })(
      "GET", "/mav/state", undefined,
    );
    const off = await provisioned({ mavlink: fakeMavlink({ running: false }) })(
      "GET", "/mav/state", undefined,
    );
    expect((flowing.body as MavlinkStateBody).link.phase).toBe("linked");
    expect((off.body as MavlinkStateBody).link.phase).toBe("linked");
    expect((flowing.body as MavlinkStateBody).telemetryRunning).toBe(true);
    expect((off.body as MavlinkStateBody).telemetryRunning).toBe(false);
  });

  // Read afresh per request, not captured when the router was assembled: the
  // renderer exposes it as a getter and it moves under the routes' feet.
  it("GET /mav/state re-reads whether telemetry is running on every request", async () => {
    const mavlink = fakeMavlink({ running: true });
    const route = provisioned({ mavlink });
    expect(((await route("GET", "/mav/state", undefined)).body as MavlinkStateBody).telemetryRunning).toBe(true);
    await route("POST", "/mav/stop", undefined);
    expect(((await route("GET", "/mav/state", undefined)).body as MavlinkStateBody).telemetryRunning).toBe(false);
  });

  it("POST /mav/stop takes telemetry off the air and answers with the state that produced", async () => {
    const mavlink = fakeMavlink({ running: true });
    const res = await provisioned({ mavlink })("POST", "/mav/stop", undefined);
    expect(res.status).toBe(200);
    expect(mavlink.calls).toEqual(["stop"]);
    expect((res.body as MavlinkStateBody).telemetryRunning).toBe(false);
  });

  it("POST /mav/start puts it back and answers with the state that produced", async () => {
    const mavlink = fakeMavlink({ running: false });
    const res = await provisioned({ mavlink })("POST", "/mav/start", undefined);
    expect(res.status).toBe(200);
    expect(mavlink.calls).toEqual(["start"]);
    expect((res.body as MavlinkStateBody).telemetryRunning).toBe(true);
  });

  it("POST /mav/detect sweeps the port and reports what it found, with the state it left behind", async () => {
    const mavlink = fakeMavlink();
    const res = await provisioned({ mavlink })("POST", "/mav/detect", undefined);
    expect(res.status).toBe(200);
    expect(mavlink.calls).toEqual(["detect"]);
    const body = res.body as MavlinkDetectBody;
    expect(body.outcome).toEqual(FOUND);
    expect(body.link).toEqual(LINKED);
    expect(body.telemetryRunning).toBe(true);
  });

  // R-MAV-13's two kinds of nothing reach the page as themselves, so the
  // §3 diagnosis can name the pins or the autopilot's own parameters.
  it("POST /mav/detect reports a sweep that found nothing as what it was", async () => {
    const outcome: DetectOutcome = { kind: "noise", device: "/dev/ttyAMA0", triedBauds: [57600, 115200], bytes: 913 };
    const res = await provisioned({ mavlink: fakeMavlink({ outcome }) })("POST", "/mav/detect", undefined);
    expect((res.body as MavlinkDetectBody).outcome).toEqual(outcome);
  });

  /**
   * Re-detection stops `mavlink-router` to get the serial port back, so it
   * drops every ground station that is receiving (R-MAV-16). The console
   * states that before the operator commits — which is only honest if the
   * routes a page *polls* cannot do it. A read that re-probed would take
   * telemetry down every few seconds, on an aircraft, with nothing on the
   * page having asked for it.
   */
  it("never re-probes from a route the page polls", async () => {
    const mavlink = fakeMavlink();
    const route = provisioned({ mavlink });
    await route("GET", "/mav/state", undefined);
    await route("GET", "/mav/check", undefined);
    await route("GET", "/mav/state", undefined);
    expect(mavlink.calls).toEqual([]);
  });

  it("GET /mav/check answers with the three links of the chain", async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.mavlink.endpoints = [{ name: "gcs0", host: "192.168.1.50", port: 14550 }];
    saveConfig(configPath, config);
    const res = await provisioned({ mavlink: fakeMavlink() })("GET", "/mav/check", undefined);
    expect(res.status).toBe(200);
    const check = res.body as PathCheck;
    expect([check.autopilot.ok, check.outbound.ok, check.inbound.ok]).toEqual([true, true, true]);
    expect(check.autopilot.detail).toMatch(/1\.0 Hz/);
  });

  /**
   * Both running facts reach the page, and they differ exactly where it
   * matters: a stopped device is still hearing its aircraft.
   */
  it("GET /mav/state carries both running facts, which a stop pulls apart", async () => {
    const mavlink = fakeMavlink({ link: { ...LINKED, phase: "stopped" }, running: false, router: true });
    const body = (await provisioned({ mavlink })("GET", "/mav/state", undefined)).body as MavlinkStateBody;
    expect(body.telemetryRunning).toBe(false);
    expect(body.routerRunning).toBe(true);
  });

  /**
   * §8: a link nobody attempted shows a dash rather than a cross, and
   * "stopped is not broken". An operator who switched telemetry off on
   * purpose must not open the page to a column of red.
   */
  it("GET /mav/check leaves the aircraft visible on a device stopped on purpose", async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.mavlink.endpoints = [{ name: "gcs0", host: "192.168.1.50", port: 14550 }];
    saveConfig(configPath, config);
    const mavlink = fakeMavlink({ link: { ...LINKED, phase: "stopped" }, running: false, router: true });
    const res = await provisioned({ mavlink })("GET", "/mav/check", undefined);
    const check = res.body as PathCheck;
    // A tick and two dashes: the loopback copy is still delivering, nobody is
    // being sent to, and nothing anywhere has failed.
    expect([check.autopilot.ok, check.outbound.ok, check.inbound.ok]).toEqual([true, null, null]);
    expect(check.outbound.detail).toMatch(/stopped by you/i);
  });

  /**
   * The ground stations come from `config.yaml`, not from the measured state.
   * `LinkState.groundStations` is filled in from the router's own counters, so
   * for the first couple of seconds of every daemon's life it is empty on a
   * device with three endpoints configured — and "none configured" is a
   * different answer from "no reading yet".
   */
  it("GET /mav/check counts the ground stations the configuration names", async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.mavlink.endpoints = [
      { name: "gcs0", host: "192.168.1.50", port: 14550 },
      { name: "gcs1", host: "192.168.1.51", port: 14551 },
    ];
    saveConfig(configPath, config);
    // Nothing sampled yet: the measured state names no stations at all.
    const mavlink = fakeMavlink({ link: { ...LINKED, groundStations: [] } });
    const res = await provisioned({ mavlink })("GET", "/mav/check", undefined);
    expect((res.body as PathCheck).outbound.detail).toMatch(/2 ground stations configured/);
  });

  // The default configuration names none, which is a setting rather than a
  // fault — a dash, and a sentence saying which.
  it("GET /mav/check says so when no ground station is configured", async () => {
    const res = await provisioned({ mavlink: fakeMavlink() })("GET", "/mav/check", undefined);
    const check = res.body as PathCheck;
    expect(check.outbound.ok).toBeNull();
    expect(check.outbound.detail).toMatch(/no ground stations are configured/i);
  });

  /**
   * The rule the whole catch-all exists for: an error out of a renderer can
   * carry a subprocess's own stderr, and echoing one into an HTTP body is how
   * it leaves the device. The detail goes to the journal, which needs being
   * on the device to read.
   */
  it("does not put a renderer's own error text in the response body", async () => {
    const mavlink = fakeMavlink({ detectThrows: "systemctl: Failed to stop mavlink-router at /etc/secret" });
    const res = await provisioned({ mavlink })("POST", "/mav/detect", undefined);
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/systemctl|\/etc\/secret/);
  });

  /**
   * **409, not 500: "already looking" is a state, not a fault.**
   *
   * Two sweeps at once set the baud rate out from under each other — termios
   * belongs to the tty and not to a descriptor — so the renderer refuses the
   * second. Answering that with the catch-all's 500 would tell an operator
   * who pressed *Detect again* twice that their device is broken, and hide
   * the reason in a journal they may not be able to reach. The message is
   * safe to return: it names no path and no subprocess.
   */
  it("answers 409 while a sweep is already running, and says so", async () => {
    const mavlink = fakeMavlink({ detectBusy: true });
    const res = await provisioned({ mavlink })("POST", "/mav/detect", undefined);
    expect(res.status).toBe(409);
    expect((res.body as { error: string }).error).toMatch(/already running/);
  });

  // A read is a read and a write is a write: nothing that interrupts a ground
  // station is reachable with a GET.
  it.each([["GET", "/mav/detect"], ["GET", "/mav/stop"], ["POST", "/mav/state"]])(
    "has no route for %s %s",
    async (method, path) => {
      const res = await provisioned({ mavlink: fakeMavlink() })(method, path, undefined);
      expect(res.status).toBe(404);
    },
  );
});

describe('accessory route dispatch', () => {
  function source() {
    return { input: vi.fn(() => ({ endpoint: '/run/yonder/accessory/cam0.sock', native: { width: 1280, height: 720, fps: 29.97 }, live: true, generation: 1, reason: null })),
      snapshot: vi.fn(() => ({ input: { endpoint: '/run/yonder/accessory/cam0.sock', native: { width: 1280, height: 720, fps: 29.97 }, live: true, generation: 1, reason: null },
        generation: 1, controlGeneration: 1, state: { status: null, exposure: null, focus: null, batteryPercent: null }, attitude: null, envelope: null,
        inhibition: 'attitude-missing', admitted: { pan: 0, tilt: 0 }, recentre: { allowed: false, reason: 'attitude-missing' }, modes: [{ allowed: false, reason: 'attitude-missing' }] })), discover: vi.fn(async () => ({ found: [], rejected: [] })), controls: vi.fn(async () => ({ completed: true })),
      aim: vi.fn(async () => ({ accepted: true })) } as unknown as import('../video/accessory/source.js').AccessorySources;
  }
  const detected: Detection = { source: 'accessory', device: 'pocket2:test.udc', byPath: 'pocket2:test.udc', byPathStable: true,
    card: 'DJI Pocket 2 (HG211)', capabilities: noCapabilities() };
  it('binds standalone Aim to the control generation and Picture drag to the media generation', async () => {
    const accessory = source();
    const snapshot = accessory.snapshot(detected.byPath)!;
    (accessory.snapshot as any).mockReturnValue({ ...snapshot, generation: 3_000_004, controlGeneration: 3,
      input: { ...snapshot.input, generation: 3_000_004 } });
    const route = provisioned({ cameras: { found: [detected], rejected: [] }, camera: { source: 'accessory', device: detected.byPath }, accessory });
    const response = await route('GET', '/cameras/cam0', undefined);
    expect(response.status).toBe(200);
    expect((response.body as any).aim.generation).toBe(3);
    expect((response.body as any).deck.aim.generation).toBe(3);
    expect((response.body as any).picture.aim.generation).toBe(3_000_004);
  });
  it('starts native media despite no selectable formats and never sends the identity to V4L2 controls', async () => {
    const accessory = source();
    const route = provisioned({ cameras: { found: [detected], rejected: [] }, camera: { source: 'accessory', device: detected.byPath }, accessory });
    expect((await route('POST', '/cameras/cam0/run', { action: 'start' })).status).toBe(200);
    expect(spawned[0].join(' ')).toContain('appsrc name=accessory-source');
    expect(spawned[0].join(' ')).not.toContain('/dev/v4l');
    expect((await route('POST', '/cameras/cam0/controls', { kind: 'iso', value: 5 })).status).toBe(200);
    expect(accessory.controls).toHaveBeenCalledWith(detected.byPath, { kind: 'iso', value: 5 });
    expect(probed).toEqual([]);
  });
  it('reports the camera-card captures panel as unavailable rather than an empty board directory', async () => {
    const route = provisioned({ cameras: { found: [detected], rejected: [] }, camera: { source: 'accessory', device: detected.byPath }, accessory: source() });
    const response = await route('GET', '/cameras/cam0', undefined);
    expect(response.status).toBe(200);
    expect((response.body as any).captures).toMatchObject({ camera: 'cam0', destination: 'camera', listing: 'unavailable', captures: [] });
    expect((response.body as any).captures.reason).toContain('cannot list');
    expect((response.body as any).captures).not.toHaveProperty('count');
  });
  it('passes exact authenticated aim requests before camera probes', async () => {
    const accessory = source();
    const route = provisioned({ cameras: { found: [detected], rejected: [] }, camera: { source: 'accessory', device: detected.byPath }, accessory });
    const request = { op: 'slew', gesture: 'g', credential: 'c', deadline: 123, seq: 1, pan: 2, tilt: 0 };
    expect((await route('POST', '/cameras/cam0/aim', { owner: 'session-derived', request })).status).toBe(200);
    expect(accessory.aim).toHaveBeenCalledWith(detected.byPath, 'session-derived', request);
    expect(probed).toEqual([]);
    expect((await route('POST', '/cameras/cam0/aim', request)).status).toBe(400);
  });
  it('adopts the detected source despite an untrusted source field', async () => {
    const accessory = source();
    const route = provisioned({ cameras: { found: [detected], rejected: [] }, accessory });
    const adopted = await route('POST', '/cameras', { device: detected.byPath, source: 'usb' });
    expect(adopted.status).toBe(200);
    expect(loadConfig(configPath).cameras.find(c => c.device === detected.byPath)?.source).toBe('accessory');
  });
});
