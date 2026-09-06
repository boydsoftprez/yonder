// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRenderers, consolePathsFromEnv, startServer, SIGNAL_POLL_SECONDS } from "./server.js";
import { SecretStore } from "../secrets/store.js";
import { AdminCredential, ADMIN_PASSWORD_SECRET } from "../console/credential.js";
import { hashPassword } from "../console/password.js";
import type { Clock, Renderer } from "../apply/types.js";
import { FAILURES_TO_STAND_DOWN, REACH_TICK_MS } from "../net/reach/standing.js";
import { PROBE_ADDRESSES } from "../net/reach/probe.js";
import type { CounterReader } from "../net/reach/counters.js";

/**
 * The byte counters, injected — never `/sys`.
 *
 * `ReachMonitor` and `ReachWatch` both default to `readFileSync
 * ("/sys/class/net/…")`, so a `startServer` test that passes nothing is
 * asserting about whatever interfaces the machine running the suite happens
 * to have. It passed only because `wwan0` and `eth0` do not exist on the
 * hosts it has run on; on a Linux board that has one, the same test takes a
 * different branch of the watch. No test may reach a real `/sys`.
 */
const noCounters: CounterReader = () => null;

/** A link with bytes moving both ways, which is what a healthy one looks like. */
function movingCounters(): CounterReader {
  let seen = 0;
  return () => { seen += 4_000; return { rx: seen, tx: seen }; };
}
import type { CommandResult } from "../net/runner.js";
import {
  AP_CONNECTION, ETHERNET_CONNECTION, MODEM_CONNECTION, DEFAULT_AP_PASSPHRASE, STOOD_DOWN_METRIC, metricFor,
} from "../net/profiles.js";
import { loadConfig } from "../config/load.js";
import { saveConfig } from "../config/save.js";
import { DEFAULT_CONFIG, type Camera } from "../schema/config.js";
import { compose } from "../video/pipeline.js";
import { noCapabilities, present } from "../video/capability.js";
import type { ProcessSpawner } from "../video/supervisor.js";
import { RTSP_BASE } from "../media/ports.js";
import type { Encoder } from "../video/probe/encoder.js";

/**
 * What `buildRenderers` probes for on a board with no `v4l2-ctl` to answer:
 * the fake runner above returns code 0 and empty output for every candidate
 * node, so `probeEncoder` falls through to software. The wiring test composes
 * with the same answer, so the line it starts a pipeline on is the line the
 * renderer will compose for an unchanged configuration.
 */
const WIRED_ENCODER: Encoder = {
  element: "x264enc", device: null, hardware: false, codec: "h264",
  detail: "software H.264 (x264enc) — this board offers no hardware encoder",
};

function wiredCamera(kbps: number): Camera {
  return {
    id: "cam0", name: "Nose", source: "usb",
    device: "platform-fd500000.pcie-pci-0000:01:00.0-usb-0:1.3:1.0-video-index0",
    enabled: true, autostart: false,
    width: 1280, height: 720, framerate: 30, codec: "h264", bitrate_kbps: kbps,
    preview: {
      mode: "fixed", size: "auto", ladder_top: "1280x720", ladder_bottom: "640x360",
      floor_kbps: 300, ceiling_kbps: 2000, bitrate_kbps: 400, framerate: 15,
    },
    controls: { brightness: null, contrast: null, rotation: 0 },
    outputs: [],
    stream: { mode: "fixed", floor_kbps: kbps, ceiling_kbps: kbps },
  } as never;
}
import type { CommandRunner } from "../net/runner.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "yonder-wire-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("buildRenderers", () => {
  it("produces a network renderer", () => {
    saveConfig(join(dir, "config.yaml"), DEFAULT_CONFIG);
    const run: CommandRunner = async () => ({ code: 0, stdout: "", stderr: "" });
    const { renderers } = buildRenderers({
      secretsPath: join(dir, "secrets.yaml"),
      runner: run,
      remoteStatePath: join(dir, "remote.json"),
    });
    expect(renderers.map((r) => r.name)).toEqual(["hostname", "network", "remote", "video"]);
  });

  /**
   * Absent unless a caller says where the console is. That is what stops a
   * test — or a future call site that forgot an option — writing to
   * /opt/yonder on whatever machine it happens to run on. Production supplies
   * the paths from consolePathsFromEnv, in main().
   */
  it("produces no console renderer when nobody said where the console is", () => {
    const run: CommandRunner = async () => ({ code: 0, stdout: "", stderr: "" });
    const built = buildRenderers({
      secretsPath: join(dir, "secrets.yaml"),
      runner: run,
      remoteStatePath: join(dir, "remote.json"),
    });
    expect(built.consoleRenderer).toBeUndefined();
    expect(built.renderers.map((r) => r.name)).toEqual(["hostname", "network", "remote", "video"]);
  });

  /**
   * Order is load-bearing. Renderers run in sequence, so the console goes
   * behind a network that has already settled: if the console then fails and
   * the apply rolls back, the rollback re-renders a network that was working.
   * The reverse order would let a console failure leave the access point
   * untouched by either pass, which is rule 6.
   */
  it("puts the console renderer after the network one", () => {
    const run: CommandRunner = async () => ({ code: 0, stdout: "", stderr: "" });
    const built = buildRenderers({
      secretsPath: join(dir, "secrets.yaml"),
      runner: run,
      remoteStatePath: join(dir, "remote.json"),
      console: { settings: join(dir, "console", "settings.js") },
    });
    expect(built.renderers.map((r) => r.name)).toEqual(["hostname", "network", "remote", "console", "video"]);
    expect(built.consoleRenderer).toBeDefined();
  });

  /**
   * In front of the network, and for the mirror image of the reason the
   * console is behind it. K-19: a failing renderer stops the ones behind it.
   * HostnameRenderer cannot fail, so nothing is put at risk by going first —
   * and a board whose NetworkManager is wedged still gets the name its
   * configuration gives it, which is the board most likely to be searched for
   * by name.
   */
  /**
   * Absent unless a caller says where the generated file goes, exactly as the
   * console is. A default here would be a real /etc/mediamtx — a file a test
   * could write a credential into, or delete, on whatever machine it ran on.
   */
  it("produces no media renderer when nobody said where its configuration goes", () => {
    const run: CommandRunner = async () => ({ code: 0, stdout: "", stderr: "" });
    const built = buildRenderers({
      secretsPath: join(dir, "secrets.yaml"),
      runner: run,
      remoteStatePath: join(dir, "remote.json"),
    });
    expect(built.mediaRenderer).toBeUndefined();
    expect(built.renderers.map((r) => r.name)).not.toContain("media");
  });

  /**
   * Last, and the opposite of the console's reasoning. A failing renderer
   * stops the ones behind it, so the question is what each is allowed to
   * prevent: a media server that will not start must not stop the console
   * being re-rendered, because the console is how an operator fixes a device
   * and video is not.
   */
  it("puts the media renderer behind the console, so video cannot cost the console", () => {
    const run: CommandRunner = async () => ({ code: 0, stdout: "", stderr: "" });
    const built = buildRenderers({
      secretsPath: join(dir, "secrets.yaml"),
      runner: run,
      remoteStatePath: join(dir, "remote.json"),
      console: { settings: join(dir, "console", "settings.js") },
      mediaConfigPath: join(dir, "mediamtx.yml"),
    });
    expect(built.renderers.map((r) => r.name))
      .toEqual(["hostname", "network", "remote", "console", "media", "video"]);
    expect(built.mediaRenderer).toBeDefined();
  });

  /**
   * R-SEC-07. The RTSP credential is generated by the media renderer when a
   * camera is configured, never seeded at start-up — so a published image,
   * which is a device with nothing configured, carries no credential material
   * without anything having to remember to strip one.
   */
  it("seeds no RTSP credential, because a device with no camera needs none", () => {
    const run: CommandRunner = async () => ({ code: 0, stdout: "", stderr: "" });
    const { secrets, generated } = buildRenderers({
      secretsPath: join(dir, "secrets.yaml"),
      runner: run,
      remoteStatePath: join(dir, "remote.json"),
      mediaConfigPath: join(dir, "mediamtx.yml"),
    });
    expect(secrets.get("rtsp_password")).toBeUndefined();
    expect(generated).not.toContain("rtsp_password");
  });

  it("puts the hostname renderer in front of everything, because it cannot fail", () => {
    const run: CommandRunner = async () => ({ code: 0, stdout: "", stderr: "" });
    const built = buildRenderers({
      secretsPath: join(dir, "secrets.yaml"),
      runner: run,
      remoteStatePath: join(dir, "remote.json"),
      console: { settings: join(dir, "console", "settings.js") },
    });
    expect(built.renderers[0]?.name).toBe("hostname");
  });

  /**
   * **The join K-48's fix actually depends on, tested where it lives.**
   *
   * `PipelineRenderer` has its own file of tests and every one of them would
   * stay green with this renderer left out of the sequence, or built over a
   * second supervisor that holds no running pipeline — which is the shape
   * this branch has now been bitten by five times, most recently with 1916
   * tests passing over a feature that did nothing at all. So this asserts the
   * two facts the class's own tests cannot: that the daemon puts it in the
   * list, and that the supervisor it drives is the same object the camera
   * routes are handed.
   *
   * The spawner is injected for the reason the runner is: nothing in this
   * suite may start a real `gst-launch-1.0`.
   */
  it("wires the pipeline renderer to the supervisor the camera routes are given", async () => {
    const run: CommandRunner = async () => ({ code: 0, stdout: "", stderr: "" });
    const spawned: string[][] = [];
    const killed: number[] = [];
    let pid = 0;
    const built = buildRenderers({
      secretsPath: join(dir, "secrets.yaml"),
      runner: run,
      remoteStatePath: join(dir, "remote.json"),
      spawner: (argv) => {
        const mine = ++pid;
        spawned.push([...argv]);
        return { kill: () => { killed.push(mine); }, on: () => { /* never exits */ } };
      },
    });

    const video = built.renderers.find((r) => r.name === "video");
    expect(video).toBeDefined();
    // Last of all: a camera that cannot be restarted must be able to cost
    // nothing behind it, and nothing is behind it.
    expect(built.renderers[built.renderers.length - 1]).toBe(video);

    // A camera on the air, started the way POST /cameras/:id/run starts one:
    // through the supervisor buildRenderers returned and the routes are
    // handed, composed against the same RTSP base the route composes with.
    const cam = wiredCamera(2000);
    built.supervisor.start("cam0", compose({
      camera: cam, capabilities: noCapabilities(), encoder: WIRED_ENCODER, rtspBase: RTSP_BASE,
    }));
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.join(" ")).toContain("x264enc name=enc-stream bitrate=2000");

    // The operator halves it and the apply lands.
    await video!.render({ ...DEFAULT_CONFIG, cameras: [wiredCamera(1000)] } as never);

    expect(killed).toEqual([1]);
    expect(spawned).toHaveLength(2);
    expect(built.supervisor.argv("cam0")?.join(" ")).toContain("x264enc name=enc-stream bitrate=1000");
  });
});

describe("consolePathsFromEnv", () => {
  it("uses the installed paths when the environment says nothing", () => {
    expect(consolePathsFromEnv({})).toEqual({
      settings: "/var/lib/yonder/console/settings.js",
      publicDir: "/var/lib/yonder/console/public",
      userDir: "/var/lib/yonder/console",
      socket: "/run/yonder/core.sock",
      coreTree: "/opt/yonder/packages/yonder-core",
      unit: "yonder-console.service",
    });
  });

  it("takes the socket from the same variable the daemon binds", () => {
    // One variable, so the daemon and the console cannot end up pointed at
    // two different sockets — which would be a console that can never
    // authenticate anyone and a device nobody can log in to.
    expect(consolePathsFromEnv({ YONDER_SOCKET: "/tmp/probe.sock" }).socket).toBe("/tmp/probe.sock");
  });

  it("lets the tree the console requires its wiring from be moved", () => {
    // The generated settings.js requires a module out of the daemon's own
    // installed tree, so an install with a different prefix has to be able to
    // say where that is. Same for the unit, which the renderer restarts.
    const paths = consolePathsFromEnv({
      YONDER_CONSOLE_CORE_TREE: "/srv/yonder/core",
      YONDER_CONSOLE_UNIT: "yonder-console-test.service",
    });
    expect(paths.coreTree).toBe("/srv/yonder/core");
    expect(paths.unit).toBe("yonder-console-test.service");
  });

  it("lets the settings path and userDir be moved", () => {
    const paths = consolePathsFromEnv({
      YONDER_CONSOLE_SETTINGS: "/srv/console/settings.js",
      YONDER_CONSOLE_USERDIR: "/srv/console/state",
    });
    expect(paths.settings).toBe("/srv/console/settings.js");
    expect(paths.userDir).toBe("/srv/console/state");
  });

  /**
   * ADR-0007. The passphrase used to be a random per-device value printed to
   * the journal — which only someone already on the device could read, and
   * joining this access point is how anyone gets on the device. It is now the
   * published default, identical everywhere and never called a secret.
   */
  it("seeds the access point with the published default passphrase", () => {
    const secretsPath = join(dir, "secrets.yaml");
    const run: CommandRunner = async () => ({ code: 0, stdout: "", stderr: "" });
    const { secrets, generated } = buildRenderers({
      secretsPath, runner: run, remoteStatePath: join(dir, "remote.json"),
    });
    expect(secrets.get("ap_psk")).toBe(DEFAULT_AP_PASSPHRASE);
    expect(generated).toContain("ap_psk");
  });

  it("gives every device the same passphrase, not a random one each", () => {
    const run: CommandRunner = async () => ({ code: 0, stdout: "", stderr: "" });
    const one = buildRenderers({
      secretsPath: join(dir, "a.yaml"), runner: run, remoteStatePath: join(dir, "a-remote.json"),
    });
    const two = buildRenderers({
      secretsPath: join(dir, "b.yaml"), runner: run, remoteStatePath: join(dir, "b-remote.json"),
    });
    expect(one.secrets.get("ap_psk")).toBe(two.secrets.get("ap_psk"));
  });

  /**
   * R-SEC-09. The console's administrator password does not exist until the
   * operator sets it; a value seeded here would make the first-run setup step
   * a formality over a credential nobody chose.
   */
  it("does not seed an editor password", () => {
    const secretsPath = join(dir, "secrets.yaml");
    const run: CommandRunner = async () => ({ code: 0, stdout: "", stderr: "" });
    const { secrets, generated } = buildRenderers({
      secretsPath, runner: run, remoteStatePath: join(dir, "remote.json"),
    });
    expect(secrets.get("editor_password")).toBeUndefined();
    expect(generated).not.toContain("editor_password");
  });

  it("does not re-seed a secret that already exists", () => {
    const secretsPath = join(dir, "secrets.yaml");
    const run: CommandRunner = async () => ({ code: 0, stdout: "", stderr: "" });
    const first = buildRenderers({ secretsPath, runner: run, remoteStatePath: join(dir, "remote.json") });
    const value = first.secrets.get("ap_psk");
    const second = buildRenderers({ secretsPath, runner: run, remoteStatePath: join(dir, "remote.json") });
    expect(second.secrets.get("ap_psk")).toBe(value);
    expect(second.generated).toEqual([]);
  });

  /**
   * The supervisor is built here, and it is not a renderer.
   *
   * Here, because a Node-RED redeploy destroys and recreates every node: a
   * supervisor inside one would drop every camera's pipeline the moment
   * somebody edited a flow — including, on a flying aircraft, the feed a
   * ground station is watching.
   *
   * Not a renderer, because starting and stopping a stream is a runtime action
   * that survives no apply and no reboot (R-CTL-01), and the renderer sequence
   * exists to make a configuration true.
   */
  it("builds one supervisor, and does not put it in the renderer sequence", () => {
    const run: CommandRunner = async () => ({ code: 0, stdout: "", stderr: "" });
    const built = buildRenderers({
      secretsPath: join(dir, "secrets.yaml"),
      runner: run,
      remoteStatePath: join(dir, "remote.json"),
    });
    expect(built.supervisor.all()).toEqual([]);
    expect(built.renderers.map((r) => r.name)).not.toContain("supervisor");
  });

  it("keeps a passphrase the operator has changed", () => {
    const secretsPath = join(dir, "secrets.yaml");
    writeFileSync(secretsPath, "ap_psk: an-operator-chose-this\n", { mode: 0o600 });
    const run: CommandRunner = async () => ({ code: 0, stdout: "", stderr: "" });
    const { secrets, generated } = buildRenderers({
      secretsPath, runner: run, remoteStatePath: join(dir, "remote.json"),
    });
    // The published default is a starting point, never something the daemon
    // reasserts over a choice the operator has already made.
    expect(secrets.get("ap_psk")).toBe("an-operator-chose-this");
    expect(generated).toEqual([]);
  });
});

/**
 * The daemon's own wiring, over the socket.
 *
 * These exist for one reason: every layer below has its own tests, and all of
 * them keep passing if the line in `startServer` that connects one to the
 * socket is deleted. A modem this daemon can read but never serves, and a
 * reach monitor nothing asks, are both a green suite and a blank page.
 */
const FIXTURES = new URL("../net/modem/mmcli/fixtures/", import.meta.url);

function fixture(name: string): string {
  return readFileSync(new URL(name, FIXTURES), "utf8");
}

/** Talk to the daemon the way the console will: over the Unix socket. */
function call(
  socketPath: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method, path }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode ?? 0, body: text === "" ? undefined : JSON.parse(text) });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

/**
 * A board with the measured modem on it, answered from the same fixtures the
 * mmcli client's own tests read. Nothing here reaches a real command: the
 * runner is the only way anything in this daemon shells out, and this is it.
 */
function boardRunner(seen: string[][]): CommandRunner {
  return async (argv): Promise<CommandResult> => {
    seen.push(argv);
    const ok = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: "" });
    if (argv[0] === "mmcli") {
      if (argv[1] === "-L") return ok(fixture("modem-list.txt"));
      if (argv[1] === "-m" && argv[2] === "/org/freedesktop/ModemManager1/Modem/0") {
        if (argv.includes("--signal-get")) return ok(fixture("signal-get.txt"));
        if (argv.some((a) => a.startsWith("--signal-setup"))) return ok("");
        return ok(fixture("modem-show.txt"));
      }
      if (argv[1] === "-b") {
        return ok(argv[2]?.endsWith("/1") === true
          ? fixture("bearer-connected.txt")
          : fixture("bearer-initial.txt"));
      }
    }
    if (argv[0] === "nmcli" && argv.includes("device") && argv.includes("status")) {
      return ok("eth0:ethernet:connected:yonder-eth\ncdc-wdm0:gsm:connected:yonder-modem\n");
    }
    return ok("");
  };
}

describe("the daemon serves what M3a assembles", () => {
  let socketPath: string, configPath: string, journalPath: string, secretsPath: string;
  const noop: Renderer = { name: "noop", async render() {} };

  beforeEach(() => {
    socketPath = join(dir, "core.sock");
    configPath = join(dir, "config.yaml");
    journalPath = join(dir, "apply.json");
    secretsPath = join(dir, "secrets.yaml");
    saveConfig(configPath, DEFAULT_CONFIG);
    new SecretStore(secretsPath).ensureValue(ADMIN_PASSWORD_SECRET, hashPassword("an operator's password"));
  });

  async function serve(seen: string[][]): Promise<{ close(): Promise<void> }> {
    return startServer({
      socketPath, configPath, journalPath,
      renderers: [noop], secretsPath, runner: boardRunner(seen), counters: noCounters,
    });
  }

  it("serves GET /modem/state from ModemManager", async () => {
    const seen: string[][] = [];
    const server = await serve(seen);
    try {
      const res = await call(socketPath, "GET", "/modem/state");
      expect(res.status).toBe(200);
      // Read from the device, not from the configuration: the APN comes off
      // the *connected* bearer, so this is what the link is using rather than
      // what was asked for.
      expect(res.body).toMatchObject({ operator: "Dark Star", technology: "lte", apn: "ereseller" });
    } finally {
      await server.close();
    }
  });

  it("serves GET /reach/state", async () => {
    const seen: string[][] = [];
    const server = await serve(seen);
    try {
      const res = await call(socketPath, "GET", "/reach/state");
      expect(res.status).toBe(200);
      const state = res.body as { paths: { path: string }[]; carrying: boolean };
      expect(state.paths.map((p) => p.path)).toContain("modem");
      // Nothing has probed anything, so nothing is stood down and the answer
      // is the safe one. See ReachMonitor.carrying.
      expect(state.carrying).toBe(true);
    } finally {
      await server.close();
    }
  });

  /**
   * R-CEL-13, at the socket rather than in the unit that decides it.
   *
   * The daemon used to remember the modem's net port for the life of the
   * process, so a board whose modem had been unplugged went on being handed
   * `wwan0` — a name NetworkManager never reports — and `/reach/state` kept
   * serving a cellular path standing by on hardware that was gone. A console
   * reading that path drew a ready lamp over the words "No modem found".
   *
   * This is here as well as in netport.test.ts because the defect was in the
   * *wiring*: the unit can be right while the daemon holds the answer.
   */
  it("stops reporting a cellular path once the modem is unplugged", async () => {
    let plugged = true;
    const seen: string[][] = [];
    const withModem = boardRunner(seen);
    const unpluggable: CommandRunner = async (argv) => {
      if (plugged) return withModem(argv);
      seen.push(argv);
      // Both tools agree the modem has gone: ModemManager claims none, and
      // NetworkManager lists no `gsm` device. `wwan0` can then only come from
      // something the daemon is remembering.
      if (argv[0] === "mmcli" && argv[1] === "-L") {
        return { code: 0, stdout: "modem-list.length   : 0\n", stderr: "" };
      }
      if (argv[0] === "nmcli" && argv.includes("device") && argv.includes("status")) {
        return { code: 0, stdout: "eth0:ethernet:connected:yonder-eth\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    saveConfig(configPath, {
      ...DEFAULT_CONFIG,
      network: {
        ...DEFAULT_CONFIG.network,
        modem: { ...DEFAULT_CONFIG.network.modem, enabled: true, mode: "auto", apn: "ereseller" },
      },
    });
    const server = await startServer({
      socketPath, configPath, journalPath,
      renderers: [noop], secretsPath, runner: unpluggable, counters: noCounters,
    });
    try {
      const modemPath = async () => {
        const res = await call(socketPath, "GET", "/reach/state");
        const state = res.body as { paths: { path: string; device: string | null; standing: string }[] };
        return state.paths.find((p) => p.path === "modem");
      };

      // The net port, not the control port NetworkManager binds: probing
      // cdc-wdm0 fails on a working link and stands the modem down.
      expect(await modemPath()).toMatchObject({ device: "wwan0", standing: "standing-by" });

      plugged = false;
      // No interface, so nothing to probe and nothing to stand down — the
      // path is absent, which is what the board is.
      expect(await modemPath()).toMatchObject({ device: null, standing: "absent" });
    } finally {
      await server.close();
    }
  });

  /**
   * Rule 6, asserted rather than reasoned about. Forgetting the modem must not
   * make the board less likely to raise its access point: `carrying` is a
   * question about paths *holding addresses*, and a departed modem holds none
   * either way — so the answer cannot move in the direction that leaves an
   * unreachable aircraft unreachable.
   */
  it("still answers that something is carrying traffic once the modem has gone", async () => {
    const seen: string[][] = [];
    const gone: CommandRunner = async (argv) => {
      seen.push(argv);
      if (argv[0] === "mmcli" && argv[1] === "-L") {
        return { code: 0, stdout: "modem-list.length   : 0\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const server = await startServer({
      socketPath, configPath, journalPath,
      renderers: [noop], secretsPath, runner: gone, counters: noCounters,
    });
    try {
      const res = await call(socketPath, "GET", "/reach/state");
      expect((res.body as { carrying: boolean }).carrying).toBe(true);
    } finally {
      await server.close();
    }
  });

  /**
   * The defect, at the socket, on the board it was found on (R-NET-14).
   *
   * `eth0` in `unavailable`: no carrier, no address, nothing plugged into it.
   * What `GET /reach/state` answered was
   *
   *     "standing":"standing-by","evidence":"untested",
   *     "detail":"Up, and not yet tested — nothing has established that it
   *               reaches anything"
   *
   * — a sentence asserting a state the daemon had not established, about an
   * interface whose condition it could read directly from the device list it
   * had already fetched.
   */
  it("does not say a port with no cable in it is up", async () => {
    const seen: string[][] = [];
    const unplugged: CommandRunner = async (argv) => {
      if (argv[0] === "nmcli" && argv.includes("device") && argv.includes("status")) {
        seen.push(argv);
        return { code: 0, stdout: "eth0:ethernet:unavailable:\n", stderr: "" };
      }
      return boardRunner(seen)(argv);
    };
    const server = await startServer({
      socketPath, configPath, journalPath,
      renderers: [noop], secretsPath, runner: unplugged, counters: noCounters,
    });
    try {
      const res = await call(socketPath, "GET", "/reach/state");
      const state = res.body as { paths: { path: string; device: string | null; standing: string; detail: string }[] };
      const ethernet = state.paths.find((p) => p.path === "ethernet");
      expect(ethernet?.standing).toBe("down");
      expect(ethernet?.detail).not.toMatch(/\bUp\b/);
      // And still not `absent`: the port is on the board. The three
      // conditions are three.
      expect(ethernet?.device).toBe("eth0");
    } finally {
      await server.close();
    }
  });

  /**
   * R-CEL-10. Without this the modem reports only a coarse quality
   * percentage, which on the measured board read 60 and then 29 while the
   * real numbers moved three dB — so a page bound to it would show a signal
   * halving that had not.
   */
  it("arms detailed signal reporting, once, on the modem it read", async () => {
    const seen: string[][] = [];
    const server = await serve(seen);
    try {
      await call(socketPath, "GET", "/modem/state");
      await call(socketPath, "GET", "/modem/state");
      const armed = seen.filter((a) => a.some((w) => w.startsWith("--signal-setup")));
      expect(armed).toHaveLength(1);
      expect(armed[0]).toContain(`--signal-setup=${SIGNAL_POLL_SECONDS}`);
    } finally {
      await server.close();
    }
  });

  it("never lets arming signal fail a read", async () => {
    // A modem that has just appeared may not be ready, and the numbers a page
    // does get are worth more than a 500 saying it could not have more.
    const seen: string[][] = [];
    const failing: CommandRunner = async (argv) => {
      if (argv.some((a) => a.startsWith("--signal-setup"))) {
        return { code: 1, stdout: "", stderr: "error: operation not allowed" };
      }
      return boardRunner(seen)(argv);
    };
    const server = await startServer({
      socketPath, configPath, journalPath, renderers: [noop], secretsPath, runner: failing,
    });
    try {
      const res = await call(socketPath, "GET", "/modem/state");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ operator: "Dark Star" });
    } finally {
      await server.close();
    }
  });

  it("puts no credential in either record", async () => {
    // R-SEC-10, asserted at the socket rather than trusted. `gsm.password` is
    // written to a NetworkManager profile and has no field to arrive back in.
    const seen: string[][] = [];
    const server = await serve(seen);
    try {
      for (const path of ["/modem/state", "/reach/state"]) {
        const res = await call(socketPath, "GET", path);
        expect(JSON.stringify(res.body)).not.toMatch(/password|passphrase|secret/i);
      }
    } finally {
      await server.close();
    }
  });

  it("reaches no real command for any of it", async () => {
    // Every subprocess this daemon runs goes through the injected runner. A
    // test that reached a real mmcli would answer whatever the machine
    // running it happens to have plugged in.
    const seen: string[][] = [];
    const server = await serve(seen);
    try {
      await call(socketPath, "GET", "/modem/state");
      await call(socketPath, "GET", "/reach/state");
      expect(seen.some((a) => a[0] === "mmcli")).toBe(true);
      expect(seen.every((a) => ["mmcli", "nmcli", "rfkill", "hostnamectl", "curl"].includes(a[0] ?? ""))).toBe(true);
    } finally {
      await server.close();
    }
  });
});

describe("buildRenderers and the modem", () => {
  /**
   * One runner, for the reason NmcliClient records about rfkill: two runners
   * that must agree can stop agreeing, and the failure mode is a test
   * reaching a real mmcli on the machine running it.
   */
  it("builds the mmcli client on the same runner as the nmcli one", async () => {
    const seen: string[][] = [];
    const run: CommandRunner = async (argv) => {
      seen.push(argv);
      return { code: 0, stdout: "modem-list.length   : 0\n", stderr: "" };
    };
    const built = buildRenderers({ secretsPath: join(dir, "secrets.yaml"), runner: run });
    expect(built.modemClient).toBeDefined();
    await built.modemClient.modems();
    expect(seen.some((a) => a[0] === "mmcli")).toBe(true);
  });
});

/**
 * The reach watch, at the socket.
 *
 * Its own tests prove it decides correctly; these prove the daemon actually
 * starts it and actually stops it. A watch that is constructed and never
 * started is a green suite, a `/reach/state` that says `standing-by` for
 * ever, and the K-42 board still unreachable — which is precisely the class
 * of defect this file exists to catch.
 */
describe("the daemon drives the reach watch", () => {
  let socketPath: string, configPath: string, journalPath: string, secretsPath: string;
  const noop: Renderer = { name: "noop", async render() {} };

  beforeEach(() => {
    socketPath = join(dir, "core.sock");
    configPath = join(dir, "config.yaml");
    journalPath = join(dir, "apply.json");
    secretsPath = join(dir, "secrets.yaml");
    saveConfig(configPath, DEFAULT_CONFIG);
    new SecretStore(secretsPath).ensureValue(ADMIN_PASSWORD_SECRET, hashPassword("an operator's password"));
  });

  /** A clock the test drives by hand; the same shape as the one in server.test.ts. */
  function handClock() {
    let t = 0;
    let next = 1;
    const timers = new Map<number, { at: number; fn: () => void }>();
    const clock: Clock = {
      now: () => t,
      setTimer: (ms, fn) => { const h = next++; timers.set(h, { at: t + ms, fn }); return h; },
      clearTimer: (h) => { timers.delete(h as number); },
    };
    return {
      clock,
      armed: () => timers.size,
      async advance(ms: number) {
        t += ms;
        for (const [h, timer] of [...timers]) if (timer.at <= t) { timers.delete(h); timer.fn(); }
        for (let i = 0; i < 200; i++) await Promise.resolve();
      },
    };
  }

  /**
   * A board with a modem holding the default route and reaching nothing: the
   * wrong APN, in a runner. `curl` on the modem's interface always fails.
   */
  function deadModemRunner(seen: string[][], reaches: () => boolean = () => false): CommandRunner {
    // The connections NetworkManager holds, remembered rather than replayed.
    // A fake that forgets what it was told cannot say whether a profile the
    // start-up render created is there to have its route metric rewritten —
    // and `remetric` deliberately writes only to connections that exist.
    const names = new Set<string>();
    return async (argv): Promise<CommandResult> => {
      seen.push(argv);
      if (argv[0] === "curl") return { code: reaches() ? 0 : 7, stdout: "", stderr: "" };
      if (argv[0] === "nmcli" && argv.includes("NAME,UUID,TYPE,DEVICE")) {
        return {
          code: 0,
          stdout: [...names].map((n) => `${n}:u-${n}:gsm:cdc-wdm0\n`).join(""),
          stderr: "",
        };
      }
      if (argv[0] === "nmcli" && argv[1] === "connection" && argv[2] === "add") names.add(argv[4]!);
      if (argv[0] === "nmcli" && argv[1] === "connection" && argv[2] === "delete") names.delete(argv[3]!);
      // The board's own two names: the connection is bound to the control
      // port, and every byte goes out of the net port (design spec, "three
      // names that are not the obvious ones").
      if (argv[0] === "mmcli" && argv[1] === "-L") return { code: 0, stdout: fixture("modem-list.txt"), stderr: "" };
      if (argv[0] === "mmcli" && argv[1] === "-m") {
        return { code: 0, stdout: fixture("modem-show.txt"), stderr: "" };
      }
      if (argv[0] === "nmcli" && argv.includes("device") && argv.includes("status")) {
        return { code: 0, stdout: "cdc-wdm0:gsm:connected:yonder-modem\n", stderr: "" };
      }
      if (argv[0] === "nmcli" && argv.some((a) => a.includes("IP4.ADDRESS"))) {
        return { code: 0, stdout: "GENERAL.DEVICE:wwan0\nIP4.ADDRESS[1]:10.31.95.33/30\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
  }

  /** config.yaml asking for the modem, which is what puts it on a path. */
  function withModem(): void {
    const config = structuredClone(DEFAULT_CONFIG);
    config.network.modem.enabled = true;
    config.network.modem.apn = "nxtgenphone";
    saveConfig(configPath, config);
  }

  it("probes on its own, and stands a modem that reaches nothing down", async () => {
    // K-42 end to end, through the socket: a link with an address, a route
    // and no way out, and nothing but this loop to notice.
    withModem();
    const seen: string[][] = [];
    const hand = handClock();
    const server = await startServer({
      socketPath, configPath, journalPath, renderers: [noop], secretsPath,
      runner: deadModemRunner(seen), clock: hand.clock, counters: noCounters,
    });
    try {
      for (let i = 0; i < FAILURES_TO_STAND_DOWN + 1; i++) await hand.advance(REACH_TICK_MS);
      // The net port, never the control port. `curl --interface cdc-wdm0`
      // fails on a perfectly good link, and three of those would stand a
      // working modem down.
      expect(seen.filter((a) => a[0] === "curl").map((a) => a[a.indexOf("--interface") + 1]))
        .toContain("wwan0");

      const res = await call(socketPath, "GET", "/reach/state");
      const state = res.body as { carrying: boolean; paths: { path: string; standing: string }[] };
      expect(state.paths.find((p) => p.path === "modem")?.standing).toBe("no-route-out");
      // The answer the fallback watchdog reads. Before this loop existed it
      // was true for ever, and the board stayed unreachable.
      expect(state.carrying).toBe(false);
    } finally {
      await server.close();
    }
  });

  /**
   * The injection point itself, at the socket — and the property it makes
   * testable, which is the one the whole design rests on: a board that is
   * working spends nothing on establishing that (R-CEL-09, R-NET-13).
   *
   * With bytes moving both ways the watch tests once, when the link comes up,
   * and never again. Without a way to inject the reader these tests read the
   * host's real `/sys`, got null for every device, and could only ever
   * exercise the branch where the counters say nothing.
   */
  it("takes the byte counters it was given, and probes nothing while they move", async () => {
    withModem();
    const seen: string[][] = [];
    const hand = handClock();
    const server = await startServer({
      socketPath, configPath, journalPath, renderers: [noop], secretsPath,
      runner: deadModemRunner(seen), clock: hand.clock, counters: movingCounters(),
    });
    try {
      await hand.advance(REACH_TICK_MS);
      // One probe, which is one *or more* requests: a probe tries a second
      // address before it will call a path dead, so this dead link's single
      // link-up probe costs up to PROBE_ADDRESSES.length of them. What this
      // test is about is unchanged — that nothing probes *again* while the
      // counters move.
      const afterLinkUp = seen.filter((a) => a[0] === "curl").length;
      expect(afterLinkUp).toBeGreaterThan(0);
      expect(afterLinkUp).toBeLessThanOrEqual(PROBE_ADDRESSES.length);
      for (let i = 0; i < FAILURES_TO_STAND_DOWN + 2; i++) await hand.advance(REACH_TICK_MS);
      expect(seen.filter((a) => a[0] === "curl").length).toBe(afterLinkUp);

      // Traffic in both directions is evidence, and it costs nothing: the
      // modem is not stood down, and the watchdog's question answers true.
      const res = await call(socketPath, "GET", "/reach/state");
      const state = res.body as { carrying: boolean; paths: { path: string; standing: string }[] };
      expect(state.paths.find((p) => p.path === "modem")?.standing).not.toBe("no-route-out");
      expect(state.carrying).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("moves traffic off the path it stood down, and puts it back when it returns", async () => {
    // R-NET-13's second half, at the socket. `Standing` worked out that the
    // modem reached nothing long before anything acted on it: the path kept
    // its winning route metric and the default route indefinitely while the
    // log line said traffic had moved. This is the assertion that would have
    // caught that absence.
    withModem();
    const seen: string[][] = [];
    const hand = handClock();
    let reaches = false;
    const server = await startServer({
      socketPath, configPath, journalPath, renderers: [noop], secretsPath,
      runner: deadModemRunner(seen, () => reaches), clock: hand.clock, counters: noCounters,
    });
    try {
      const metricsWritten = (): number[] =>
        seen
          .filter((a) => a[1] === "connection" && a[2] === "modify" && a[3] === MODEM_CONNECTION)
          .map((a) => Number(a[a.indexOf("ipv4.route-metric") + 1]));

      // Nothing has been stood down yet, so nothing has been re-metricked.
      expect(metricsWritten()).toEqual([]);

      for (let i = 0; i < FAILURES_TO_STAND_DOWN + 1; i++) await hand.advance(REACH_TICK_MS);

      const configured = metricFor(loadConfig(configPath), "modem");
      expect(metricsWritten()).toEqual([configured + STOOD_DOWN_METRIC]);
      // The stored profile said one thing and the running device another
      // until this. The net port is where the bytes go, but the connection is
      // bound to the control port, and that is the device to reapply.
      expect(seen.some((a) => a.join(" ") === "nmcli device reapply cdc-wdm0")).toBe(true);
      // Nothing was taken down and the access point was not disturbed: an
      // operator may be reaching this board over the very path that failed.
      expect(seen.some((a) => a[1] === "connection" && a[2] === "down")).toBe(false);
      expect(seen.some((a) => a[1] === "connection" && a[2] === "modify" && a[3] === AP_CONNECTION))
        .toBe(false);

      // Quick to return: the APN is fixed, the probe succeeds, and the
      // configured metric comes straight back.
      reaches = true;
      await hand.advance(REACH_TICK_MS);
      expect(metricsWritten()).toEqual([configured + STOOD_DOWN_METRIC, configured]);

      const res = await call(socketPath, "GET", "/reach/state");
      const state = res.body as { carrying: boolean };
      expect(state.carrying).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("stops the watch when the daemon closes", async () => {
    // A tick loop outliving its daemon would go on running curl on somebody's
    // metered link on behalf of a process that has let go of its socket.
    withModem();
    const seen: string[][] = [];
    const hand = handClock();
    const server = await startServer({
      socketPath, configPath, journalPath, renderers: [noop], secretsPath,
      runner: deadModemRunner(seen), clock: hand.clock, counters: noCounters,
    });
    await hand.advance(REACH_TICK_MS);
    await server.close();
    const before = seen.length;
    await hand.advance(REACH_TICK_MS * 5);
    expect(seen.length).toBe(before);
  });

  /**
   * **A re-dial is a link coming up, and it must be tested** (R-CEL-09).
   *
   * The wire from the renderer, which is the only component that knows a
   * re-dial happened, to the watch that tests. Measured on the board: the
   * APN was changed to a wrong one, the modem re-dialled correctly onto a
   * new bearer and a new address, `curl --interface wwan0` came back exit 28
   * — and no `testing cellular` line was ever written, because the interface
   * name did not change and cellular was not the path carrying traffic.
   *
   * The board here is that one: ethernet in use, a modem standing by, and a
   * profile dialled on an APN the configuration no longer asks for. The
   * start-up render finds the difference and cycles the link.
   */
  function twoPathRunner(seen: string[][], dialled: string): CommandRunner {
    const names = new Set<string>([ETHERNET_CONNECTION, MODEM_CONNECTION]);
    return async (argv): Promise<CommandResult> => {
      seen.push(argv);
      // Ethernet works and the modem does not — the board in §2, one layer
      // up. Ethernet reaching something is what keeps the alternatives loop
      // out of this: any `curl` on wwan0 below is there because of a re-dial
      // and for no other reason.
      if (argv[0] === "curl") {
        return { code: argv.includes("wwan0") ? 7 : 0, stdout: "", stderr: "" };
      }
      if (argv[0] === "mmcli" && argv[1] === "-L") return { code: 0, stdout: fixture("modem-list.txt"), stderr: "" };
      if (argv[0] === "mmcli" && argv[1] === "-m") return { code: 0, stdout: fixture("modem-show.txt"), stderr: "" };
      if (argv[0] === "nmcli" && argv.includes("NAME,UUID,TYPE,DEVICE")) {
        return { code: 0, stdout: [...names].map((n) => `${n}:u-${n}:gsm:cdc-wdm0\n`).join(""), stderr: "" };
      }
      if (argv[0] === "nmcli" && argv[1] === "connection" && argv[2] === "add") names.add(argv[4]!);
      if (argv[0] === "nmcli" && argv[1] === "connection" && argv[2] === "delete") names.delete(argv[3]!);
      // What the modem is *already dialled on*, which is the one reading the
      // renderer's comparison rests on.
      if (argv[0] === "nmcli" && argv[1] === "-t" && argv[5] === "show" && argv[6] === MODEM_CONNECTION) {
        return { code: 0, stdout: `gsm.apn:${dialled}\n`, stderr: "" };
      }
      if (argv[0] === "nmcli" && argv.includes("device") && argv.includes("status")) {
        return {
          code: 0,
          stdout: `eth0:ethernet:connected:${ETHERNET_CONNECTION}\ncdc-wdm0:gsm:connected:${MODEM_CONNECTION}\n`,
          stderr: "",
        };
      }
      if (argv[0] === "nmcli" && argv.some((a) => a.includes("IP4.ADDRESS"))) {
        return {
          code: 0,
          stdout: "GENERAL.DEVICE:eth0\nIP4.ADDRESS[1]:192.168.1.20/24\n"
            + "GENERAL.DEVICE:wwan0\nIP4.ADDRESS[1]:10.230.244.138/30\n",
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
  }

  /** Which interfaces `curl` was pointed at, in order. */
  const probedInterfaces = (seen: string[][]): string[] =>
    seen.filter((a) => a[0] === "curl").map((a) => a[a.indexOf("--interface") + 1]!);

  it("tests a re-dialled modem that is standing by rather than in use", async () => {
    withModem();
    const seen: string[][] = [];
    const hand = handClock();
    const server = await startServer({
      socketPath, configPath, journalPath, renderers: [noop], secretsPath,
      // Dialled on one APN, configured for another: the start-up render
      // cycles the link, and that is the event nothing could see before.
      runner: twoPathRunner(seen, "ereseller"), clock: hand.clock, counters: noCounters,
    });
    try {
      expect(seen.some((a) => a[1] === "connection" && a[2] === "up" && a[3] === MODEM_CONNECTION))
        .toBe(true);
      await hand.advance(REACH_TICK_MS);
      // The net port, which is where a modem's bytes go — and the path that
      // is *not* carrying traffic, which is the whole of the defect.
      expect(probedInterfaces(seen)).toContain("wwan0");

      const res = await call(socketPath, "GET", "/reach/state");
      const state = res.body as { inUse: string; paths: { path: string; detail: string }[] };
      expect(state.inUse).toBe("ethernet");
      expect(state.paths.find((p) => p.path === "modem")?.detail).not.toMatch(/ready/i);
    } finally {
      await server.close();
    }
  });

  it("tests nothing extra when the render re-dialled nothing", async () => {
    // The same board with the modem already dialled on what the
    // configuration asks for. Ethernet is tested because it has just started
    // carrying traffic; the modem is not tested at all.
    withModem();
    const seen: string[][] = [];
    const hand = handClock();
    const server = await startServer({
      socketPath, configPath, journalPath, renderers: [noop], secretsPath,
      runner: twoPathRunner(seen, "nxtgenphone"), clock: hand.clock, counters: noCounters,
    });
    try {
      expect(seen.some((a) => a[1] === "connection" && a[2] === "up" && a[3] === MODEM_CONNECTION))
        .toBe(false);
      await hand.advance(REACH_TICK_MS);
      expect(probedInterfaces(seen)).not.toContain("wwan0");
    } finally {
      await server.close();
    }
  });

  it("spends nothing on a device that has no path in use", async () => {
    // No modem configured and no address anywhere: there is no subject to
    // test, and a tick must not manufacture one.
    const seen: string[][] = [];
    const hand = handClock();
    const server = await startServer({
      socketPath, configPath, journalPath, renderers: [noop], secretsPath,
      runner: async (argv) => { seen.push(argv); return { code: 0, stdout: "", stderr: "" }; },
      clock: hand.clock, counters: noCounters,
    });
    try {
      for (let i = 0; i < 5; i++) await hand.advance(REACH_TICK_MS);
      expect(seen.some((a) => a[0] === "curl")).toBe(false);
    } finally {
      await server.close();
    }
  });

  /**
   * `POST /reach/test`, at the socket — the wiring `testPath` exists for.
   * This is not a unit test of the route handler, which would pass with
   * `testPath` left disconnected in `server.ts`: it asserts that asking
   * through the socket reaches the injected probe on the modem's own
   * device, the same way the automatic loop above does.
   */
  it("reaches the injected probe for an operator-requested test of the modem", async () => {
    withModem();
    const seen: string[][] = [];
    const hand = handClock();
    const server = await startServer({
      socketPath, configPath, journalPath, renderers: [noop], secretsPath,
      runner: deadModemRunner(seen, () => true), clock: hand.clock, counters: noCounters,
    });
    try {
      const res = await call(socketPath, "POST", "/reach/test", { path: "modem" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ path: "modem", reached: true });
      // The net port, not the control port — see the automatic-probe test
      // above for why that distinction is the one that matters here.
      expect(probedInterfaces(seen)).toContain("wwan0");
    } finally {
      await server.close();
    }
  });
});

/**
 * **The stream address, at the socket, on the board this join was wrong on**
 * (R-UI-24, R-VID-15).
 *
 * `answerableAddresses()` decides which path each address is on and
 * `dial-in.test.ts` holds it to that over readings *it* supplies;
 * `renderReceive()` chooses from the path the verdict rests on and
 * `receive.test.ts` holds it to that over a set *it* supplies. Neither is
 * worth anything if the one production assembly hands them the wrong
 * readings — and it did: it compared each address's interface against the
 * modem's *net* port, `wwan0`, while NetworkManager binds the address to the
 * *control* port, `cdc-wdm0`, so the comparison was trivially true and the
 * CGNAT address came back dialable on every board in auto mode.
 *
 * `server.ts` is the only caller. Turning the exclusion off entirely left the
 * whole suite green, because nothing tested `addresses` at the assembly. This
 * is that test: a real daemon, a real router, and the same fixtures the mmcli
 * client's own tests read.
 */
describe("the stream address is built from an address a peer can dial", () => {
  let socketPath: string, configPath: string, journalPath: string, secretsPath: string;
  const noop: Renderer = { name: "noop", async render() {} };

  /** What `nmcli -t -f GENERAL.DEVICE,IP4.ADDRESS device show` reports here. */
  const DEVICE_SHOW = [
    // Real captures lead with loopback — `fixtures/device-show-ip4.txt` does.
    "GENERAL.DEVICE:lo",
    "IP4.ADDRESS[1]:127.0.0.1/8",
    "",
    // The modem, under the name NetworkManager binds it to. First of the real
    // addresses, which is what makes this the one a flat list would print.
    "GENERAL.DEVICE:cdc-wdm0",
    "IP4.ADDRESS[1]:10.31.95.33/30",
    "",
    "GENERAL.DEVICE:eth0",
    "IP4.ADDRESS[1]:192.168.1.8/24",
    "",
    // The radio, serving the access point, holding its address for ever.
    "GENERAL.DEVICE:wlan0",
    "IP4.ADDRESS[1]:192.168.77.1/24",
    "",
  ].join("\n");

  beforeEach(() => {
    socketPath = join(dir, "core.sock");
    configPath = join(dir, "config.yaml");
    journalPath = join(dir, "apply.json");
    secretsPath = join(dir, "secrets.yaml");
    const config = structuredClone(DEFAULT_CONFIG);
    // Auto mode: the operator has not named an adapter, so the two names have
    // to be reconciled. Appliance mode is the case that never needed it.
    config.network.modem.enabled = true;
    config.network.modem.apn = "ereseller";
    config.cameras = [{
      id: "cam0",
      name: "Nose",
      source: "usb",
      device: "platform-fd500000.pcie-pci-0000:01:00.0-usb-0:1.3:1.0-video-index0",
      outputs: [
        { kind: "rtp", host: "192.168.1.50", port: 5600 },
        { kind: "rtsp", password: { secret: "rtsp_password" } },
      ],
    }] as unknown as typeof config.cameras;
    saveConfig(configPath, config);
    new SecretStore(secretsPath).ensureValue(ADMIN_PASSWORD_SECRET, hashPassword("an operator's password"));
  });

  async function serve(): Promise<{ close(): Promise<void> }> {
    const seen: string[][] = [];
    const board = boardRunner(seen);
    const runner: CommandRunner = async (argv) => {
      if (argv[0] === "nmcli" && argv.includes("device") && argv.includes("show")) {
        return { code: 0, stdout: DEVICE_SHOW, stderr: "" };
      }
      return board(argv);
    };
    return startServer({
      socketPath, configPath, journalPath, renderers: [noop], secretsPath,
      runner, counters: noCounters,
      cameraLayer: {
        cameras: {
          detect: async () => ({ found: [], rejected: [] }),
          probe: async (node: string, card: string) => ({ device: node, card, reason: "not in this fixture" }),
        },
        encoder: async () => ({
          element: "v4l2h264enc", device: "/dev/video11", hardware: true,
          codec: "h264" as const, detail: "hardware H.264",
        }),
        rtspPassword: () => "FIXTURE-NOT-A-REAL-PASSWORD",
      },
    });
  }

  async function url(): Promise<{ body: string; usable: boolean; note: string }> {
    const res = await call(socketPath, "GET", "/cameras/cam0/stream-address");
    expect(res.status).toBe(200);
    const found = (res.body as { renderings: { kind: string; body: string; usable: boolean; note: string }[] })
      .renderings.find((r) => r.kind === "url");
    if (found === undefined) throw new Error("no RTSP rendering");
    return found;
  }

  it("never builds it from the modem's address, whichever of its two names holds it", async () => {
    const server = await serve();
    try {
      // The ethernet path is probed on demand, so the verdict has something
      // to rest on rather than the daemon's untested start-up state.
      expect((await call(socketPath, "POST", "/reach/test", { path: "ethernet" })).body)
        .toEqual({ path: "ethernet", reached: true });
      const line = await url();
      expect(line.usable, "ethernet is reaching, so a peer on it can dial the listener").toBe(true);
      expect(line.body).toContain("@192.168.1.8:8554/cam0");
      // The two that must never be chosen: the modem's, which nothing dials,
      // and the access point's, which no LAN or mesh peer is on.
      expect(line.body, "the CGNAT address is not one a peer can dial").not.toContain("10.31.95.33");
      expect(line.body, "the access point is not a LAN").not.toContain("192.168.77.1");
    } finally {
      await server.close();
    }
  });

  /**
   * With no path up the line is unusable either way — but it still prints an
   * address, and *which* one is where the two modem names become load-bearing
   * again: a modem address recognised as the modem's is skipped, and one this
   * assembly failed to recognise is printed. Dropping `alsoKnownAs` here
   * leaves the daemon serving `10.31.95.33`, which is the finding.
   */
  it("prints the least-wrong address when no path is up, and never the modem's", async () => {
    const server = await serve();
    try {
      const line = await url();
      expect(line.usable).toBe(false);
      expect(line.note).toMatch(/^unusable — /);
      // The console arrived on the modem's address and it is first in the
      // list; the ethernet address is what a person could conceivably use.
      expect(line.body).toContain("@192.168.1.8:8554/cam0");
      expect(line.body, "the modem's address is known never to be dialable")
        .not.toContain("10.31.95.33");
      // A real `device show` leads with loopback, and it used to be
      // `addresses[0]` — the address this device claimed to answer on.
      expect(line.body).not.toContain("127.0.0.1");
    } finally {
      await server.close();
    }
  });
});

/**
 * The video layer's runtime half, assembled in `startServer` and nowhere
 * else (R-VID-07, R-VID-11; spec §8.1, §8.2).
 *
 * **This is the join that was missing, asserted where it can actually be
 * broken.** `video/rate.ts` was built, proved on a board and left with no
 * production caller at all: nothing constructed a controller, nothing gave it
 * a link measurement, nothing ticked it. Every layer beneath kept passing —
 * which is the whole point of a test at this level, and the reason the rest
 * of this file exists.
 *
 * So the journey here starts where a browser's own statistic starts, at this
 * daemon's socket, and ends inside the `extra-controls` property of a
 * `v4l2h264enc` that is already playing.
 */
describe("the daemon runs the rate controller", () => {
  let socketPath: string, configPath: string, journalPath: string, secretsPath: string;
  const noop: Renderer = { name: "noop", async render() {} };

  const ADAPTIVE = {
    id: "cam0", name: "Nose", source: "usb",
    device: "platform-fd500000.pcie-pci-0000:01:00.0-usb-0:1.3:1.0-video-index0",
    enabled: true, autostart: false,
    width: 1280, height: 720, framerate: 30, codec: "h264", bitrate_kbps: 2000,
    preview: {
      mode: "adaptive", size: "auto", ladder_top: "1280x720", ladder_bottom: "640x360",
      floor_kbps: 300, ceiling_kbps: 2000, bitrate_kbps: 400, framerate: 15,
    },
    controls: { brightness: null, contrast: null, rotation: 0 },
    outputs: [],
    stream: { mode: "adaptive", floor_kbps: 500, ceiling_kbps: 4000 },
  } as unknown as Camera;

  interface Sent {
    id: number;
    op: string;
    sets: { element: string; property: string; value: string }[];
  }

  /** Timers this daemon armed, fired only when the test says so: nothing here
   *  waits on a wall clock, and no assertion below depends on one. */
  let now: number;
  let timers: { at: number; fn: () => void }[];
  let sent: Sent[];
  let spawns: string[][];
  let pids: number[];

  const clock: Clock = {
    now: () => now,
    setTimer: (ms, fn) => { const t = { at: now + ms, fn }; timers.push(t); return t; },
    clearTimer: (h) => { const i = timers.indexOf(h as never); if (i >= 0) timers.splice(i, 1); },
  };
  function advance(ms: number): void {
    now += ms;
    for (const t of [...timers]) if (t.at <= now) { timers.splice(timers.indexOf(t), 1); t.fn(); }
  }

  beforeEach(() => {
    socketPath = join(dir, "core.sock");
    configPath = join(dir, "config.yaml");
    journalPath = join(dir, "apply.json");
    secretsPath = join(dir, "secrets.yaml");
    now = 1_000_000;
    timers = [];
    sent = [];
    spawns = [];
    pids = [];
    saveConfig(configPath, { ...DEFAULT_CONFIG, cameras: [ADAPTIVE] } as never);
    new SecretStore(secretsPath).ensureValue(ADMIN_PASSWORD_SECRET, hashPassword("an operator's password"));
  });

  /** A pipeline that answers, the way `installer/payload/yonder-pipeline`
   *  does: it takes a property write while playing, echoes the rate it ended
   *  up at, and keeps the same process id — which is what makes "the picture
   *  did not restart" a fact rather than an assumption. */
  const spawner: ProcessSpawner = (argv) => {
    spawns.push([...argv]);
    const mine = 5000 + spawns.length;
    pids.push(mine);
    const inbox: ((line: string) => void)[] = [];
    return {
      kill: () => {}, on: () => {},
      onMessage: (fn: (line: string) => void) => { inbox.push(fn); },
      send: (line: string) => {
        const command = JSON.parse(line) as Sent;
        sent.push(command);
        const kbps = Number(/video_bitrate=(\d+)/.exec(command.sets[0]?.value ?? "")?.[1] ?? 0) / 1000;
        for (const fn of inbox) {
          fn(JSON.stringify({ id: command.id, pid: mine, continuous: true, observed: kbps }));
        }
      },
    } as never;
  };

  async function serve(): Promise<{ close(): Promise<void> }> {
    return startServer({
      socketPath, configPath, journalPath, renderers: [noop], secretsPath,
      runner: async () => ({ code: 0, stdout: "", stderr: "" }),
      counters: noCounters,
      clock,
      spawner,
      cameraLayer: {
        cameras: {
          detect: async () => ({
            found: [{
              device: "/dev/video0",
              card: "Global Shutter Camera: Global S",
              byPath: ADAPTIVE.device,
              byPathStable: true,
              capabilities: {
                ...noCapabilities(),
                formats: present([{ fourcc: "MJPG", width: 1280, height: 720, rates: [30, 24, 15] }]),
              },
            }],
            rejected: [],
          }),
          probe: async (node: string, card: string) => ({ device: node, card, reason: "not re-probed here" }),
        },
        encoder: async () => ({
          element: "v4l2h264enc", device: "/dev/video11", hardware: true,
          codec: "h264" as const, detail: "hardware H.264 on /dev/video11",
        }),
        rtspPassword: () => null,
      },
    });
  }

  const retunes = (): Sent[] =>
    sent.filter((s) => s.op === "retune" && s.sets[0]?.element === "enc-stream");

  it("moves a running encoder from a statistic that arrived on this socket", async () => {
    const server = await serve();
    try {
      // The camera on the air, exactly the way the console starts one.
      expect((await call(socketPath, "POST", "/cameras/cam0/run", { action: "start" })).status).toBe(200);
      expect(spawns).toHaveLength(1);
      expect(spawns[0].join(" ")).toContain("bitrate=2000");
      expect(retunes()).toEqual([]);

      // A browser opens the picture and posts what its own WebRTC statistics
      // say the path is carrying — the shape `console/middleware.ts`'s viewer
      // id addresses, and the only measurement of that path anything has.
      const answer = await call(socketPath, "POST", "/cameras/cam0/viewers/1f2e3d4c5b6a7089", {
        want: "video",
        stats: { rtt: 38, loss: 0, egress: 900, capacity: 40_000, frameAge: 90 },
      });
      expect(answer.status).toBe(200);
      expect(answer.body).toMatchObject({
        camera: "cam0", viewer: "1f2e3d4c5b6a7089",
        mine: { delivery: "video", source: "cam0-preview" },
      });

      // One tick of the daemon's own clock, which is the thing that did not
      // exist before this change.
      advance(1_000);
      await Promise.resolve();

      const moved = retunes();
      expect(moved).toHaveLength(1);
      // Its own applied ceiling, not the link's 40 Mb/s.
      expect(moved[0].sets[0].value).toBe("controls,video_bitrate=4000000");
      // And the picture never restarted: one process, one launch line, one pid.
      expect(spawns).toHaveLength(1);
      expect(new Set(pids).size).toBe(1);
      expect((await call(socketPath, "GET", "/cameras/cam0")).body)
        .toMatchObject({ run: { restarts: 0 } });
    } finally {
      await server.close();
    }
  });

  it("does nothing at all until a browser has measured something", async () => {
    const server = await serve();
    try {
      await call(socketPath, "POST", "/cameras/cam0/run", { action: "start" });
      for (let i = 0; i < 10; i += 1) advance(1_000);
      expect(retunes()).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("stops deciding when the daemon closes", async () => {
    const server = await serve();
    await call(socketPath, "POST", "/cameras/cam0/run", { action: "start" });
    await call(socketPath, "POST", "/cameras/cam0/viewers/1f2e3d4c5b6a7089", {
      want: "video",
      stats: { rtt: 38, loss: 0, egress: 900, capacity: 40_000 },
    });
    advance(1_000);
    const moved = retunes().length;
    expect(moved).toBe(1);

    await server.close();
    // A rate controller outliving its daemon would go on writing bitrates
    // into a running pipeline on behalf of a process that has let go of its
    // socket — and, unlike every other timer here, it would be commanding
    // hardware while it did it.
    for (let i = 0; i < 10; i += 1) advance(1_000);
    expect(retunes()).toHaveLength(moved);
  });

  it("refuses a viewer report about a camera this device does not have", async () => {
    const server = await serve();
    try {
      const answer = await call(socketPath, "POST", "/cameras/nope/viewers/1f2e3d4c5b6a7089", {
        want: "video",
      });
      expect(answer.status).toBe(404);
    } finally {
      await server.close();
    }
  });
});
