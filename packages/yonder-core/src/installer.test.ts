// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DEFAULT_CONSOLE_PATHS } from "./console/settings.js";
import { MEDIA_CONFIG_PATH } from "./media/renderer.js";
import { PIPELINE_HOST } from "./video/supervisor.js";

/**
 * The installer's shell helpers, exercised rather than read.
 *
 * These are the checks that stand between a mistake in a unit file and a
 * board that boots, fails and boots again for ever — and until now nothing
 * ran them. They are POSIX `sh`, so a test can source the real file and call
 * the real function; what it must not do is touch the real account database,
 * so `getent` is stubbed on PATH and `useradd` is never invoked at all.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const COMMON = join(ROOT, "installer", "lib", "common.sh");
const SYSTEMD = join(ROOT, "systemd");

let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "yonder-installer-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** A getent that knows about exactly the accounts named, and nothing else. */
function stubGetent(users: string[], groups: string[]): string {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "getent"), [
    "#!/bin/sh",
    `known_passwd="${users.join(" ")}"`,
    `known_group="${groups.join(" ")}"`,
    'case "$1" in',
    '  passwd) for n in $known_passwd; do [ "$n" = "$2" ] && exit 0; done ;;',
    '  group)  for n in $known_group;  do [ "$n" = "$2" ] && exit 0; done ;;',
    "esac",
    "exit 2",
    "",
  ].join("\n"), { mode: 0o755 });
  return bin;
}

function unit(body: string): string {
  const path = join(dir, "test.service");
  writeFileSync(path, body);
  return path;
}

function sh(script: string, env: Record<string, string> = {}, path?: string) {
  const result = spawnSync("/bin/sh", ["-c", script], {
    encoding: "utf8",
    env: { ...process.env, ...(path === undefined ? {} : { PATH: path }), ...env },
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

/** Source common.sh and call assert_unit_accounts against `unitPath`. */
function assertAccounts(unitPath: string, opts: { known?: [string[], string[]]; dryRun?: boolean; path?: string } = {}) {
  const [users, groups] = opts.known ?? [["yonder"], ["yonder"]];
  const binPath = opts.path ?? `${stubGetent(users, groups)}:${process.env.PATH ?? ""}`;
  return sh(
    `set -eu; . '${COMMON}'; assert_unit_accounts '${unitPath}'`,
    { DRY_RUN: opts.dryRun === true ? "1" : "0" },
    binPath,
  );
}

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync, symlinkSync, existsSync, lstatSync } from "node:fs";

import { ROUTER_CONF_PATH, ROUTER_UNIT } from "./mav/renderer.js";

describe("assert_unit_accounts", () => {
  it("passes a unit whose accounts all exist", () => {
    const r = assertAccounts(unit("[Service]\nUser=yonder\nGroup=yonder\n"));
    expect(r.code).toBe(0);
    expect(r.out).toContain("runs as user yonder, which exists");
    expect(r.out).toContain("runs as group yonder, which exists");
  });

  /**
   * The failure this whole helper exists for. A `Group=` naming an account
   * that is not there is status=217/USER before systemd executes anything —
   * on yonder-core, a board with no daemon, no access point and no console.
   * The message has to name the group, or whoever reads it on a bench has
   * nothing to act on.
   */
  it("dies naming the group when the group does not exist", () => {
    const r = assertAccounts(unit("[Service]\nGroup=yonder-missing\n"));
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("yonder-missing");
    expect(r.out).toContain("does not exist");
    expect(r.out).toContain("217");
  });

  it("dies naming the user when the user does not exist", () => {
    const r = assertAccounts(unit("[Service]\nUser=nobody-here\nGroup=yonder\n"));
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("nobody-here");
    expect(r.out).toContain("217");
  });

  it("says what it would check on a dry run, and does not resolve anything", () => {
    // Same split as assert_unit_exec: the unit is read either way, the
    // account database is only consulted on a real run. So this passes on a
    // machine with no such account — which is every CI runner.
    const r = assertAccounts(unit("[Service]\nUser=yonder\nGroup=yonder-missing\n"), { dryRun: true });
    expect(r.code).toBe(0);
    expect(r.out).toContain("would check that the user yonder exists");
    expect(r.out).toContain("would check that the group yonder-missing exists");
  });

  it("passes a unit that names no account at all", () => {
    const r = assertAccounts(unit("[Service]\nExecStart=/bin/true\n"));
    expect(r.code).toBe(0);
    expect(r.out).toContain("runs as root");
  });

  it("reads the first word of the value, so a trailing comment is not an account", () => {
    const r = assertAccounts(unit("[Service]\nGroup=yonder\nExecStart=/bin/true\n"));
    expect(r.code).toBe(0);
  });

  /**
   * A check that cannot run is not the same as a check that passed. Enabling
   * a unit nobody has verified is the crash loop this function exists to
   * prevent, so a missing getent stops the install with the reason rather
   * than shrugging.
   */
  it("refuses to pass a unit it has no way to check", () => {
    // A PATH with sed and nothing else: enough for common.sh to parse the
    // unit, not enough to resolve an account.
    const bin = join(dir, "onlysed");
    mkdirSync(bin, { recursive: true });
    const sed = sh("command -v sed").out.trim();
    symlinkSync(sed, join(bin, "sed"));
    const r = assertAccounts(unit("[Service]\nGroup=yonder\n"), { path: bin });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("getent");
  });

  it("stops on a unit file that is not there", () => {
    const r = assertAccounts(join(dir, "absent.service"));
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("not there to check");
  });
});

/**
 * The unit and the installer are two halves of one statement, and nothing in
 * either file makes the other true. A `Group=` added to a unit without the
 * matching account in 10-base.sh is a board that will not start the daemon;
 * an account removed from 10-base.sh while a unit still names it is the same
 * defect from the other side. So the two are compared here.
 */
describe("the accounts the shipped units name", () => {
  function unitAccounts(): { users: Set<string>; groups: Set<string> } {
    const users = new Set<string>();
    const groups = new Set<string>();
    for (const file of readdirSync(SYSTEMD).filter((f) => f.endsWith(".service"))) {
      for (const line of readFileSync(join(SYSTEMD, file), "utf8").split("\n")) {
        const user = /^User=\s*(\S+)/.exec(line);
        const group = /^Group=\s*(\S+)/.exec(line);
        if (user?.[1] !== undefined) users.add(user[1]);
        if (group?.[1] !== undefined) groups.add(group[1]);
      }
    }
    return { users, groups };
  }

  /** 10-base.sh with backslash continuations joined, so one command is one line. */
  function baseRole(): string[] {
    return readFileSync(join(ROOT, "installer", "roles", "10-base.sh"), "utf8")
      .replaceAll("\\\n", " ")
      .split("\n");
  }

  it("are every account installer/roles/10-base.sh creates", () => {
    const { users, groups } = unitAccounts();
    // The daemon carries Group=yonder and nothing else; without it the socket
    // is root:root and no console can open it (K-01).
    expect(groups).toContain("yonder");

    const lines = baseRole();
    for (const name of users) {
      expect(
        lines.some((l) => l.includes("useradd") && new RegExp(`\\b${name}\\b`).test(l)),
        `a unit runs as the user ${name}, and 10-base.sh does not create it; the service would fail at 217/USER on every start`,
      ).toBe(true);
    }
    for (const name of groups) {
      expect(
        lines.some((l) => l.includes("groupadd") && new RegExp(`\\b${name}\\b`).test(l)),
        `a unit runs as the group ${name}, and 10-base.sh does not create it; the service would fail at 217/USER on every start`,
      ).toBe(true);
    }
  });

  it("are checked by 30-console.sh before anything is enabled", () => {
    const role = readFileSync(join(ROOT, "installer", "roles", "30-console.sh"), "utf8");
    const checked = role.indexOf("assert_unit_accounts");
    const enabled = role.indexOf("systemctl enable");
    expect(checked).toBeGreaterThan(0);
    expect(checked).toBeLessThan(enabled);
  });

  it("are checked by 20-yonder-core.sh before anything is enabled", () => {
    const role = readFileSync(join(ROOT, "installer", "roles", "20-yonder-core.sh"), "utf8");
    const checked = role.indexOf("assert_unit_accounts");
    const enabled = role.indexOf("systemctl enable");
    expect(checked, "20-yonder-core.sh does not check the accounts its unit names").toBeGreaterThan(0);
    expect(checked, "the accounts are checked after the unit is enabled, which is too late").toBeLessThan(enabled);
  });

  it("are checked by 50-mediamtx.sh before it leaves the unit for the daemon", () => {
    // This role never enables anything — MediaRenderer does, when a camera is
    // configured — so the deadline is the daemon-reload that makes the unit
    // startable at all.
    const role = readFileSync(join(ROOT, "installer", "roles", "50-mediamtx.sh"), "utf8");
    const checked = role.indexOf("assert_unit_accounts");
    const loaded = role.indexOf("systemctl daemon-reload");
    expect(checked, "50-mediamtx.sh does not check the accounts its unit names").toBeGreaterThan(0);
    expect(checked, "the accounts are checked after the unit is loaded, which is too late").toBeLessThan(loaded);
  });
});

/**
 * The media server's role, read rather than trusted.
 *
 * Each of these is a property whose absence is invisible until a board is in
 * an aircraft: a listener left running on a device nobody configured a camera
 * on, a picture taken away from an operator upgrading over it, or a pipeline
 * that cannot parse because one 41 kB package is missing.
 */
describe("installer/roles/50-mediamtx.sh", () => {
  const role = readFileSync(join(ROOT, "installer", "roles", "50-mediamtx.sh"), "utf8");

  it("installs the one GStreamer package every pipeline depends on", () => {
    // rtspclientsink is on the full-rate branches and on the preview alike,
    // and a pipeline naming an element GStreamer cannot resolve fails to
    // parse rather than failing to connect — so a missing package here is
    // every camera on the device, not one output.
    expect(role).toMatch(/^ensure_pkgs gstreamer1\.0-tools gstreamer1\.0-plugins-base gstreamer1\.0-plugins-good \\$/m);
  });

  it("asks GStreamer to resolve the element, not dpkg whether a package is there", () => {
    expect(role).toContain("rtspclientsink v4l2src");
    expect(role.indexOf("die")).toBeGreaterThan(0);
  });

  it("skips a payload that carries no media server rather than failing the install", () => {
    // R-CFG-08. A payload built without mediamtx is a valid payload — it is
    // only needed by a device that will carry a camera — and a freshly
    // flashed device must reach a usable state regardless.
    expect(role).toMatch(/no mediamtx in the payload; skipping/);
    expect(role).toMatch(/^\s*return 0$/m);
  });

  it("leaves the unit installed and off, and checks that it worked", () => {
    // R-SEC-13: a media server present on a device with no camera configured
    // is a listener nobody decided to open. `systemctl disable` is the wrong
    // tool — it answers "Running in chroot, ignoring request" and exits 0 in
    // the chroot an image is built in, which is how a unit ships enabled.
    expect(role).toMatch(/^\s*try systemctl stop mediamtx$/m);
    expect(role).toMatch(/^\s*disable_unit_offline mediamtx\.service$/m);
    expect(role).toMatch(/^\s*assert_unit_disabled mediamtx\.service$/m);
    expect(role).not.toMatch(/^\s*(try|run)\s+systemctl\s+disable/m);
  });

  it("leaves a running media server alone when yonder-core owns it", () => {
    // The same defect 40-zerotier.sh was fixed for. This installer is re-run
    // to upgrade, and 20-yonder-core restarts the daemon first — whose
    // start-up render brings the media server up for the configured cameras.
    // A role that then stopped it took the picture away from the operator
    // upgrading a device while watching video over it, and nothing later
    // re-renders. The generated configuration is the record: written with the
    // first camera, removed with the last.
    const guard = role.indexOf(`if [ -f "$mtx_etc/mediamtx.yml" ]`);
    const stop = role.indexOf("try systemctl stop mediamtx");
    expect(guard, "50-mediamtx.sh stops the unit unconditionally").toBeGreaterThan(0);
    expect(guard).toBeLessThan(stop);
  });

  it("proves the daemon can write the file it is going to be asked to write", () => {
    expect(role).toContain("assert_daemon_can_write");
  });
});

/**
 * The runner that can be spoken to, and the two halves it is a pair with.
 *
 * K-53: video is run by `gst-launch-1.0`, which plays a pipeline and then
 * answers nothing, so an applied bitrate never reaches the running encoder
 * however correct every layer above it is. `installer/payload/yonder-pipeline`
 * is the program that answers, and this role puts it where the daemon spawns
 * it. Everything below is a way for those two halves to be checked against
 * each other rather than typed twice.
 */
describe("installer/roles/55-pipeline-host.sh", () => {
  const role = readFileSync(join(ROOT, "installer", "roles", "55-pipeline-host.sh"), "utf8");
  const host = join(ROOT, "installer", "payload", "yonder-pipeline");
  const fakeGi = join(ROOT, "packages", "yonder-core", "src", "video", "fake-gi");

  it("installs the bindings the host imports, from Debian rather than the payload", () => {
    // Both are in Debian main, on the footing 50-mediamtx.sh states for
    // gstreamer1.0-rtsp. make-payload.sh vendors what Debian does not carry,
    // against pinned fingerprints, and has no apt mechanism at all.
    expect(role).toMatch(/^ensure_pkgs python3-gi gir1\.2-gstreamer-1\.0 gstreamer1\.0-libav$/m);
  });

  it("asks Python whether it can import them, not dpkg whether they are there", () => {
    // The same distinction 50-mediamtx.sh draws by resolving rtspclientsink
    // through the GStreamer registry: a package that is installed and a
    // binding that imports are different questions.
    expect(role).toContain('gi.require_version("Gst", "1.0")');
    expect(role).toContain("from gi.repository import Gst");
  });

  it("installs the host at the path the daemon spawns, and executable", () => {
    // Two halves of a pair, and a value they can disagree about is a control
    // channel that is silently never there. `preferring` chooses this runner
    // on the executable bit specifically, so the mode is half of the same
    // pair.
    expect(role).toContain(`host_bin=${PIPELINE_HOST}`);
    expect(role).toMatch(/install -m 0755 "\$host_src" "\$host_bin"/);
  });

  it("stops rather than skipping when the host is not in the tree", () => {
    // Committed source, not a downloaded artefact: unlike a payload built
    // without mediamtx, a checkout missing this file is broken.
    expect(role).toMatch(/\[ -f "\$host_src" \] \|\| die/);
  });

  it("proves the install by running what it installed", () => {
    expect(role).toContain('"$host_bin" 2>&1 | grep -q');
  });

  it("greps for a message the host really prints", () => {
    // The post-condition above is a string. Reworded on one side and not the
    // other it is a check that passes on a device where nothing works — so
    // the real program is run here, with a stand-in GStreamer, and asked.
    const wanted = /grep -q '([^']+)'/.exec(role)?.[1];
    expect(wanted, "the role no longer greps for anything").toBeDefined();
    const ran = spawnSync(host, [], {
      encoding: "utf8",
      env: { ...process.env, PYTHONPATH: fakeGi },
    });
    expect(ran.status).not.toBe(0);
    expect(`${ran.stdout ?? ""}${ran.stderr ?? ""}`).toContain(wanted);
  });

  it("enables nothing, because the host is not a service", () => {
    // One per running camera, spawned and supervised by yonder-core
    // (video/supervisor.ts). A unit here would be a second thing starting
    // pipelines.
    expect(role).not.toMatch(/systemctl/);
  });
});

/**
 * The console unit, read rather than trusted.
 *
 * Every property below is one this milestone would otherwise only discover on
 * hardware: a unit that takes the network daemon down with it, a console
 * running as root, or an ExecStart naming a script that is not there.
 */
describe("systemd/yonder-console.service", () => {
  const unit = readFileSync(join(SYSTEMD, "yonder-console.service"), "utf8");

  /**
   * Rule 6. A Requires= would make a console that cannot start able to stop
   * yonder-core with it — and yonder-core is what renders the network and
   * holds the access point up. A device whose console is broken must still be
   * a device you can reach.
   */
  it("wants yonder-core rather than requiring it", () => {
    expect(unit).toMatch(/^Wants=yonder-core\.service$/m);
    expect(unit).not.toMatch(/^Requires=/m);
    expect(unit).toMatch(/^After=.*yonder-core\.service/m);
  });

  it("runs unprivileged, as the account 10-base.sh creates", () => {
    expect(unit).toMatch(/^User=yonder$/m);
    expect(unit).toMatch(/^Group=yonder$/m);
  });

  it("starts red.js with the generated settings, through the installer's node link", () => {
    const exec = /^ExecStart=(.*)$/m.exec(unit)?.[1] ?? "";
    expect(exec.split(" ")[0]).toBe("/usr/local/bin/yonder-node");
    expect(exec).toContain("node_modules/node-red/red.js");
    expect(exec).toContain("-s /var/lib/yonder/console/settings.js");
  });

  it("comes back on its own, because a console nobody can reach is the failure", () => {
    expect(unit).toMatch(/^Restart=always$/m);
    expect(unit).toMatch(/^WantedBy=multi-user\.target$/m);
  });

  /**
   * This is the internet-adjacent surface — it is what a browser talks to,
   * over the access point and over a cell link.
   */
  it("is hardened, and can write only its own state directory", () => {
    for (const setting of [
      "NoNewPrivileges=true",
      "PrivateTmp=true",
      "ProtectSystem=strict",
      "ProtectHome=true",
      "ReadWritePaths=/var/lib/yonder/console",
    ]) {
      expect(unit, `${setting} is missing`).toContain(setting);
    }
    // Nothing under /etc/yonder is writable. The administrator password hash
    // lives there and the console must not be able to read it, let alone
    // write it (ADR-0007) — the comment in the unit says so, so the check has
    // to be against the settings rather than against the text.
    const writable = [...unit.matchAll(/^ReadWritePaths=(.*)$/gm)].map((m) => m[1] ?? "");
    expect(writable).toEqual(["/var/lib/yonder/console"]);
  });
});

/**
 * The daemon's unit and the console's have to agree about the socket, or the
 * console can never authenticate anyone and the device has no way in.
 */
describe("the two units together", () => {
  it("put the socket where both of them can reach it", () => {
    const core = readFileSync(join(SYSTEMD, "yonder-core.service"), "utf8");
    // Group=yonder on the daemon is what makes /run/yonder root:yonder 0750
    // and the socket group-writable; User=yonder on the console is what puts
    // it in that group (K-01).
    expect(core).toMatch(/^Group=yonder$/m);
    expect(core).toMatch(/^RuntimeDirectory=yonder$/m);
    expect(core).not.toMatch(/^User=/m);
  });
});

/**
 * The invariant the first board taught us, pinned so it cannot come back.
 *
 * `yonder-core.service` is `ProtectSystem=strict`, so the daemon may only
 * write what its `ReadWritePaths` names. Everything the `ConsoleRenderer`
 * writes has to be inside that set — and while `settings.js` and `theme.css`
 * lived under `/opt`, they were not. Every render failed `EROFS` from inside
 * the service, silently: the installer generates `settings.js` as root
 * *outside* systemd, so the install still reported success and the console
 * still came up. The failure surfaced only when an operator set an
 * administrator password and the console could not be flipped to match,
 * leaving a device whose only page contradicted itself and whose only
 * recovery was the card.
 *
 * Asserted against the shipped unit and the shipped defaults, so it fails
 * here rather than on hardware.
 */
describe("the daemon can write everything the console renderer writes", () => {
  it("keeps every generated console path inside yonder-core's ReadWritePaths", () => {
    const unit = readFileSync(join(ROOT, "systemd/yonder-core.service"), "utf8");
    expect(unit).toContain("ProtectSystem=strict");

    const roots = unit
      .split("\n")
      .filter((l) => l.startsWith("ReadWritePaths="))
      .flatMap((l) => l.slice("ReadWritePaths=".length).trim().split(/\s+/))
      .filter(Boolean);
    expect(roots.length).toBeGreaterThan(0);

    const inside = (p: string): boolean =>
      roots.some((r) => p === r || p.startsWith(`${r}/`));

    for (const p of [DEFAULT_CONSOLE_PATHS.settings, DEFAULT_CONSOLE_PATHS.publicDir]) {
      expect(inside(p), `${p} must be inside one of: ${roots.join(" ")}`).toBe(true);
    }
  });

  it("starts the console from the same path the daemon regenerates", () => {
    // Two halves of a pair. A unit reading one settings.js while the daemon
    // rewrites another is a console that never changes, and nothing else
    // would say so.
    const unit = readFileSync(join(ROOT, "systemd/yonder-console.service"), "utf8");
    expect(unit).toContain(`-s ${DEFAULT_CONSOLE_PATHS.settings}`);
  });
});

/**
 * The modem role. ModemManager's udev rules ship inside the package, so a
 * port that enumerated before the package was installed carries no
 * ID_MM_CANDIDATE and the service never looks at it — `mmcli -L` answers "No
 * modems were found", indistinguishable from unsupported hardware. This
 * arises on every upgrade of a board already in the field, not on a fresh
 * flash, because there udev runs after the package is already there.
 */
describe("installing a modem", () => {
  it("installs ModemManager from Debian, with no payload", () => {
    // ZeroTier needed a payload because it is not in Debian. ModemManager is,
    // and the installer already installs Debian packages in a chroot with a
    // network, so none of that machinery applies here.
    const role = readFileSync(join(ROOT, "installer", "roles", "10-base.sh"), "utf8");
    expect(role).toMatch(/ensure_pkgs\s+modemmanager/);
  });

  it("triggers udev and restarts ModemManager, over every subsystem", () => {
    // A subsystem-filtered trigger (tty, net, usb) misses usbmisc, where the
    // control port lives, and leaves a modem claimed AT-only with its net
    // port ignored — a modem with no data path but PPP.
    const role = readFileSync(join(ROOT, "installer", "roles", "40-modem.sh"), "utf8");
    expect(role).toMatch(/udevadm trigger/);
    expect(role).not.toMatch(/udevadm trigger.*--subsystem-match/);
    expect(role).toMatch(/systemctl restart ModemManager/);
  });

  it("does not bring a link up", () => {
    // R-CFG-08 and R-VPN-05's principle: installing support for something is
    // not configuring it. A device carries no cellular connection until
    // config.yaml asks for one.
    const role = readFileSync(join(ROOT, "installer", "roles", "40-modem.sh"), "utf8");
    expect(role).not.toMatch(/nmcli connection (add|up)/);
  });
});

/**
 * The media server's unit, read rather than trusted.
 *
 * It is the second internet-adjacent surface on the device: RTSP is reachable
 * from the mesh and from whatever network the aircraft is on. What it must not
 * be is privileged, and what it must not have is the daemon's socket.
 */
describe("systemd/mediamtx.service", () => {
  const unit = readFileSync(join(SYSTEMD, "mediamtx.service"), "utf8");

  it("runs as an account of its own, and not the one that owns the daemon's socket", () => {
    // Group=yonder owns /run/yonder/core.sock (K-01). A network-facing media
    // server in that group could open the daemon's control socket, which is a
    // far larger grant than the one file it actually needs.
    expect(unit).toMatch(/^User=yonder-media$/m);
    expect(unit).toMatch(/^Group=yonder-media$/m);
    expect(unit).not.toMatch(/^(User|Group)=yonder$/m);
  });

  it("reads the file yonder-core writes, and not another one", () => {
    // Two halves of a pair. A unit reading one configuration while the daemon
    // rewrites another is a media server whose listeners never change, and
    // nothing else would say so.
    const exec = /^ExecStart=(.*)$/m.exec(unit)?.[1] ?? "";
    expect(exec.split(" ")[0]).toBe("/usr/local/bin/mediamtx");
    expect(exec).toContain(MEDIA_CONFIG_PATH);
  });

  it("is hardened, and can write nothing at all", () => {
    for (const setting of [
      "NoNewPrivileges=true",
      "PrivateTmp=true",
      "ProtectSystem=strict",
      "ProtectHome=true",
    ]) {
      expect(unit, `${setting} is missing`).toContain(setting);
    }
    // It reads one file and serves what the pipeline publishes to it. Nothing
    // it does is a write, so nothing is writable.
    expect([...unit.matchAll(/^ReadWritePaths=(.*)$/gm)]).toEqual([]);
  });
});

/**
 * The same invariant the console taught us, for the media server's file.
 *
 * yonder-core is ProtectSystem=strict, so a path outside its ReadWritePaths is
 * EROFS from inside the service and from nowhere else — the installer runs
 * outside the sandbox, so an install would report success and the first camera
 * an operator configured would fail to apply on hardware.
 */
describe("the daemon can write the media server's configuration", () => {
  it("keeps MEDIA_CONFIG_PATH inside yonder-core's ReadWritePaths", () => {
    const unit = readFileSync(join(ROOT, "systemd/yonder-core.service"), "utf8");
    expect(unit).toContain("ProtectSystem=strict");
    const roots = unit
      .split("\n")
      .filter((l) => l.startsWith("ReadWritePaths="))
      .flatMap((l) => l.slice("ReadWritePaths=".length).trim().split(/\s+/))
      .filter(Boolean);
    expect(
      roots.some((r) => MEDIA_CONFIG_PATH === r || MEDIA_CONFIG_PATH.startsWith(`${r}/`)),
      `${MEDIA_CONFIG_PATH} must be inside one of: ${roots.join(" ")}`,
    ).toBe(true);
  });
});

/**
 * The build path in `20-yonder-core.sh` must copy everything `npm run build`
 * reaches for.
 *
 * There are two routes into `/opt/yonder/packages/yonder-core`: a prebuilt one
 * that copies `dist/` and `node_modules/` and skips the build, and this one,
 * which copies sources and builds on the board. A checkout whose dependencies
 * are hoisted to the workspace root takes the build path — which is every
 * developer checkout, so it is the path a hand deploy actually uses.
 *
 * It failed on hardware with `Cannot find module .../scripts/copy-assets.mjs`,
 * after `npm ci` had already run: far enough in to look like it was working.
 * `src/` was copied and `scripts/` was not, while the build is `tsc` followed
 * by `node scripts/copy-assets.mjs`.
 *
 * So this reads the build script rather than naming directories: every
 * repository-relative path it runs must be copied by the role. A build step
 * that reaches for a new directory fails here, with the directory named,
 * instead of on a board after a flash.
 */
describe("installer/roles/20-yonder-core.sh, the build path", () => {
  const role = readFileSync(join(ROOT, "installer", "roles", "20-yonder-core.sh"), "utf8");
  const build = (JSON.parse(
    readFileSync(join(ROOT, "packages", "yonder-core", "package.json"), "utf8"),
  ) as { scripts: Record<string, string> }).scripts.build;

  it("runs a build whose steps this test can see", () => {
    // If the build stops being a string of shell this cannot read, the two
    // tests below would pass by finding nothing. Fail here instead.
    expect(build).toBeTruthy();
    expect(build).toContain("tsc");
  });

  it("copies every directory the build script runs something out of", () => {
    // `node scripts/copy-assets.mjs` -> `scripts`. Anything invoked from a
    // bare relative path is a directory that has to be on the board.
    const needed = new Set<string>();
    for (const m of build.matchAll(/(?:^|&&|\|\||;)\s*node\s+([A-Za-z0-9_./-]+)/g)) {
      const path = m[1];
      if (path.startsWith("/") || path.startsWith("-")) continue;
      const top = path.split("/")[0];
      if (top !== "" && top !== "." && top !== "..") needed.add(top);
    }
    expect(needed.size).toBeGreaterThan(0);
    for (const top of needed) {
      expect(role).toContain(`run cp -r "$yc_src/${top}" "$yc_dest/${top}"`);
    }
  });

  it("copies src, which is what tsc compiles", () => {
    expect(role).toContain(`run cp -r "$yc_src/src" "$yc_dest/src"`);
  });
});


/*
 * The telemetry branch's own tests for this file, appended whole on merge
 * rather than interleaved: both branches grew this file by adding to it,
 * and a line-level merge cuts through test bodies. Each block below is
 * that branch's, unedited, with the describe-level setup it was written
 * against.
 */
/**
 * The invariant the first board taught us, pinned so it cannot come back.
 *
 * `yonder-core.service` is `ProtectSystem=strict`, so the daemon may only
 * write what its `ReadWritePaths` names. Everything the `ConsoleRenderer`
 * writes has to be inside that set — and while `settings.js` and `theme.css`
 * lived under `/opt`, they were not. Every render failed `EROFS` from inside
 * the service, silently: the installer generates `settings.js` as root
 * *outside* systemd, so the install still reported success and the console
 * still came up. The failure surfaced only when an operator set an
 * administrator password and the console could not be flipped to match,
 * leaving a device whose only page contradicted itself and whose only
 * recovery was the card.
 *
 * Asserted against the shipped unit and the shipped defaults, so it fails
 * here rather than on hardware.
 */
describe("the daemon can write everything the console renderer writes", () => {


  /**
   * The same invariant, for the file `MavlinkRenderer` generates.
   *
   * `/etc/mavlink-router/main.conf` is written from inside the daemon on
   * every apply that changes it, and `ProtectSystem=strict` mounts the rest
   * of /etc read-only in this process's own namespace — so without the entry
   * the very first render on a board fails EROFS and says nothing else. The
   * leading `-` matters as much as the path does: systemd refuses to start a
   * unit whose ReadWritePaths names a directory that is not there, and this
   * one exists only on a board whose installer carried mavlink-router, so an
   * unprefixed entry would take the console and the access point off every
   * device flashed before that (rule 6).
   */
  it("keeps the generated mavlink-router configuration inside them too, without hard-requiring it", () => {
    const unit = readFileSync(join(ROOT, "systemd/yonder-core.service"), "utf8");
    const entries = unit
      .split("\n")
      .filter((l) => l.startsWith("ReadWritePaths="))
      .flatMap((l) => l.slice("ReadWritePaths=".length).trim().split(/\s+/))
      .filter(Boolean);

    const optional = entries.filter((e) => e.startsWith("-")).map((e) => e.slice(1));
    const roots = entries.map((e) => (e.startsWith("-") ? e.slice(1) : e));
    const inside = (p: string): boolean => roots.some((r) => p === r || p.startsWith(`${r}/`));

    expect(inside(ROUTER_CONF_PATH), `${ROUTER_CONF_PATH} must be inside one of: ${roots.join(" ")}`).toBe(true);
    expect(optional).toContain(dirname(ROUTER_CONF_PATH));
  });

});

/**
 * The UART role. Out of the box a Pi exposes no usable serial device at all
 * — `enable_uart` is never set, and the PL011 (the UART whose baud rate does
 * not drift with the core clock) is claimed by Bluetooth, leaving the header
 * a mini-UART unreliable at the rates telemetry needs. This role takes the
 * PL011 back: a stanza owned under a marker of its own in config.txt, the
 * login console taken off the same pins in cmdline.txt, and the getty and
 * the Bluetooth attach service disabled so neither reclaims it. Measured on
 * a Raspberry Pi 4 running Debian 13; see
 * docs/hardware/an-autopilot-on-the-uart.md.
 *
 * Exercised for real against a fixture boot directory, rather than only read
 * as text. The question worth asking here is not "did the role call the
 * right function" — 40-zerotier.sh's own tests already cover that shape by
 * reading — but "does this specific sed and awk arithmetic do what it
 * claims", and only running it answers that.
 */
describe("the UART role", () => {
  const UART_ROLE = join(ROOT, "installer", "roles", "40-uart.sh");

  /** A systemctl and a deb-systemd-helper that only record what they were asked, so a test never touches the real machine's systemd state. */
  function stubSystemdTools(): { path: string; log: string } {
    const bin = join(dir, "sdbin");
    const log = join(dir, "sd.log");
    mkdirSync(bin, { recursive: true });
    const body = [
      "#!/bin/sh",
      `printf '%s %s\\n' "$(basename "$0")" "$*" >> '${log}'`,
      "exit 0",
      "",
    ].join("\n");
    writeFileSync(join(bin, "systemctl"), body, { mode: 0o755 });
    writeFileSync(join(bin, "deb-systemd-helper"), body, { mode: 0o755 });
    writeFileSync(log, "");
    return { path: `${bin}:${process.env.PATH ?? ""}`, log };
  }

  function bootFixture(config: string, cmdline: string): string {
    const boot = join(dir, "boot");
    mkdirSync(boot, { recursive: true });
    writeFileSync(join(boot, "config.txt"), config);
    writeFileSync(join(boot, "cmdline.txt"), cmdline);
    return boot;
  }

  function runUart(bootDir: string, opts: { dryRun?: boolean; path: string; systemdDirs?: string }) {
    return sh(
      `set -eu; . '${COMMON}'; . '${UART_ROLE}'`,
      {
        DRY_RUN: opts.dryRun === true ? "1" : "0",
        YONDER_BOOT_DIR: bootDir,
        YONDER_ARMBIAN_ENV: join(dir, "no-armbian-here"),
        YONDER_SYSTEMD_DIRS: opts.systemdDirs ?? join(dir, "no-systemd-here"),
      },
      opts.path,
    );
  }

  function armbianFixture(env: string, opts: { overlay?: boolean } = {}) {
    const boot = join(dir, "armbian-boot");
    const dtb = join(boot, "dtb", "rockchip", "overlay");
    const user = join(boot, "overlay-user");
    mkdirSync(dtb, { recursive: true });
    if (opts.overlay !== false) writeFileSync(join(dtb, "rk3568-uart2-m0.dtbo"), "dtbo bytes");
    const envFile = join(boot, "armbianEnv.txt");
    writeFileSync(envFile, env);
    return { envFile, dtb, user };
  }
  function runArmbian(f: ReturnType<typeof armbianFixture>, opts: { dryRun?: boolean; path: string }) {
    return sh(
      `set -eu; . '${COMMON}'; . '${UART_ROLE}'`,
      {
        DRY_RUN: opts.dryRun === true ? "1" : "0",
        YONDER_BOOT_DIR: join(dir, "no-pi-boot-here"),
        YONDER_ARMBIAN_ENV: f.envFile,
        YONDER_DTB_OVERLAY_DIR: f.dtb,
        YONDER_USER_OVERLAY_DIR: f.user,
        YONDER_SYSTEMD_DIRS: join(dir, "no-systemd-here"),
      },
      opts.path,
    );
  }
  // A Radxa Zero 3W's armbianEnv.txt as Armbian 26.8.1 ships it, with the
  // USB host overlay the camera needs already in user_overlays.
  const ARMBIAN = [
    "verbosity=1", "bootlogo=false", "console=both", "extraargs=cma=256M", "overlay_prefix=rk35xx",
    "fdtfile=rockchip/rk3566-radxa-zero3.dtb", "rootdev=UUID=2bae8c0f", "rootfstype=ext4",
    "user_overlays=dwc3-host", "usbstoragequirks=0x2537:0x1066:u", "",
  ].join("\n");

  it("frees UART2 on Armbian: copies the overlay, names it, takes the serial console off, disables the FIQ getty (R-MAV-02, R-HW-04)", () => {
    const f = armbianFixture(ARMBIAN);
    const { path, log } = stubSystemdTools();
    const r = runArmbian(f, { path });
    expect(r.code).toBe(0);
    expect(existsSync(join(f.user, "uart2-m0.dtbo"))).toBe(true);
    const env = readFileSync(f.envFile, "utf8");
    expect(env).toContain("user_overlays=dwc3-host uart2-m0\n");
    expect(env).toContain("console=display\n");
    expect(env).not.toContain("console=both");
    expect(env).toContain("overlay_prefix=rk35xx\n");
    expect(env).toContain("extraargs=cma=256M\n");
    expect(readFileSync(log, "utf8")).toContain("deb-systemd-helper disable serial-getty@ttyFIQ0.service");
    expect(r.out).toContain("takes hardware effect at the next boot");
  });

  it("is idempotent on Armbian: a second run changes nothing and says so", () => {
    const f = armbianFixture(ARMBIAN);
    const { path } = stubSystemdTools();
    runArmbian(f, { path });
    const once = readFileSync(f.envFile, "utf8");
    const r = runArmbian(f, { path });
    expect(r.code).toBe(0);
    expect(readFileSync(f.envFile, "utf8")).toBe(once);
    expect(r.out).toContain("already carries uart2-m0");
  });

  it("adds user_overlays when the file has none, and rewrites console=serial too", () => {
    const f = armbianFixture(ARMBIAN.replace("user_overlays=dwc3-host\n", "").replace("console=both", "console=serial"));
    const r = runArmbian(f, { path: stubSystemdTools().path });
    expect(r.code).toBe(0);
    const env = readFileSync(f.envFile, "utf8");
    expect(env).toContain("user_overlays=uart2-m0\n");
    expect(env).toContain("console=display\n");
  });

  it("leaves console=display alone", () => {
    const f = armbianFixture(ARMBIAN.replace("console=both", "console=display"));
    const r = runArmbian(f, { path: stubSystemdTools().path });
    expect(r.code).toBe(0);
    expect(readFileSync(f.envFile, "utf8").match(/^console=/gm)).toEqual(["console="]);
    expect(r.out).toContain("no serial console");
  });

  it("dies when the image carries no uart2-m0 overlay, naming what it looked for", () => {
    const f = armbianFixture(ARMBIAN, { overlay: false });
    const r = runArmbian(f, { path: stubSystemdTools().path });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("no rk3568-uart2-m0.dtbo");
  });

  it("says what it would do on Armbian on a dry run, and writes nothing", () => {
    const f = armbianFixture(ARMBIAN);
    const r = runArmbian(f, { dryRun: true, path: stubSystemdTools().path });
    expect(r.code).toBe(0);
    expect(r.out).toContain("would");
    expect(readFileSync(f.envFile, "utf8")).toBe(ARMBIAN);
    expect(existsSync(join(f.user, "uart2-m0.dtbo"))).toBe(false);
  });

  const STANZA = "# yonder-uart\nenable_uart=1\ndtoverlay=disable-bt\n";









  /**
   * console=serial0 has to be found and removed regardless of where it
   * falls on the line and whether a baud is even pinned to it, without
   * disturbing a neighbouring console= entry or leaving a doubled or
   * dangling space behind. Each of these failed at least once while this
   * role was being written.
   */
  it.each([
    ["only token, with a baud", "console=serial0,115200", ""],
    ["only token, no baud", "console=serial0", ""],
    ["first token", "console=serial0,115200 root=x rootwait", "root=x rootwait"],
    ["last token", "root=x rootwait console=serial0,115200", "root=x rootwait"],
    ["no baud, in the middle", "root=x console=serial0 rootwait quiet", "root=x rootwait quiet"],
    ["beside a different console=", "console=serial0 console=tty1", "console=tty1"],
    // Two adjacent tokens share the one space between them: a single sed
    // pass folds it into the first match's trailing group, leaving the
    // second with no leading separator to match and letting it survive —
    // fails safe (the post-condition re-runs this same regex and dies) but
    // stops the install. The removal loops to a fixed point precisely so
    // this case comes out clean in one role run rather than dying here.
    ["two adjacent tokens", "root=x console=serial0,115200 console=serial0 rootwait", "root=x rootwait"],
  ])("removes console=serial0 — %s", (_desc, before, after) => {
    const { path } = stubSystemdTools();
    const boot = bootFixture("dtparam=audio=on\n", `${before}\n`);

    const r = runUart(boot, { path });
    expect(r.code, r.out).toBe(0);
    expect(readFileSync(join(boot, "cmdline.txt"), "utf8")).toBe(`${after}\n`);
  });


  it("appends the stanza to config.txt and removes console=serial0 from cmdline.txt, leaving everything else alone", () => {
    const { path } = stubSystemdTools();
    const boot = bootFixture(
      "# For more options see http://rptl.io/configtxt\n\n[all]\ndtparam=audio=on\ndtoverlay=vc4-kms-v3d\n",
      "console=serial0,115200 console=tty1 root=PARTUUID=1234-01 rootfstype=ext4 fsck.repair=yes rootwait quiet\n",
    );

    const r = runUart(boot, { path });
    expect(r.code, r.out).toBe(0);

    const config = readFileSync(join(boot, "config.txt"), "utf8");
    expect(config).toContain("dtparam=audio=on");
    expect(config).toContain("dtoverlay=vc4-kms-v3d");
    expect(config.endsWith(STANZA)).toBe(true);
    // Owned outright: exactly one marker, never two.
    expect(config.match(/^# yonder-uart$/gm)).toHaveLength(1);

    const cmdline = readFileSync(join(boot, "cmdline.txt"), "utf8");
    expect(cmdline).not.toContain("console=serial0");
    expect(cmdline).toContain("console=tty1");
    expect(cmdline).toContain("root=PARTUUID=1234-01");
    expect(cmdline).not.toMatch(/ {2}/);
    expect(cmdline).not.toMatch(/^ | $/m);
  });

  it("is idempotent: a second run changes neither file", () => {
    const { path } = stubSystemdTools();
    const boot = bootFixture(
      "dtparam=audio=on\n",
      "console=serial0,115200 console=tty1 root=x rootwait\n",
    );

    expect(runUart(boot, { path }).code).toBe(0);
    const configAfter1 = readFileSync(join(boot, "config.txt"), "utf8");
    const cmdlineAfter1 = readFileSync(join(boot, "cmdline.txt"), "utf8");

    const second = runUart(boot, { path });
    expect(second.code, second.out).toBe(0);
    expect(second.out).toContain("config.txt already carries the # yonder-uart stanza");
    expect(second.out).toContain("cmdline.txt already carries no console=serial0");
    expect(readFileSync(join(boot, "config.txt"), "utf8")).toBe(configAfter1);
    expect(readFileSync(join(boot, "cmdline.txt"), "utf8")).toBe(cmdlineAfter1);
  });

  it("leaves a config.txt that already carries the stanza untouched, rather than duplicating it", () => {
    const { path } = stubSystemdTools();
    const original = `dtparam=audio=on\n\n${STANZA}`;
    const boot = bootFixture(original, "console=tty1 root=x\n");

    const r = runUart(boot, { path });
    expect(r.code, r.out).toBe(0);
    expect(readFileSync(join(boot, "config.txt"), "utf8")).toBe(original);
  });

  it("fails the post-condition when the marker is present but the stanza under it is not intact", () => {
    // The post-condition this role exists to get right: it must test what
    // the role actually wrote, and a marker with the wrong content beneath
    // it — a hand edit, or a partial write from an earlier crash — is
    // exactly the state a rubber-stamp check would miss.
    const { path } = stubSystemdTools();
    const boot = bootFixture("# yonder-uart\nenable_uart=1\nWRONG-LINE\n", "console=tty1 root=x\n");

    const r = runUart(boot, { path });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("does not carry an intact");
    expect(r.out).toContain("yonder-uart");
  });

  it("skips cleanly when there is no Raspberry Pi boot layout, and creates nothing", () => {
    const { path } = stubSystemdTools();
    const boot = join(dir, "not-a-pi");
    mkdirSync(boot, { recursive: true });

    const r = runUart(boot, { path });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("skipping");
    expect(readdirSync(boot)).toHaveLength(0);
  });

  it("changes neither file on a dry run, and says what it would do", () => {
    const { path } = stubSystemdTools();
    const boot = bootFixture("dtparam=audio=on\n", "console=serial0,115200 root=x\n");
    const configBefore = readFileSync(join(boot, "config.txt"), "utf8");
    const cmdlineBefore = readFileSync(join(boot, "cmdline.txt"), "utf8");

    const r = runUart(boot, { path, dryRun: true });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("would check");
    expect(readFileSync(join(boot, "config.txt"), "utf8")).toBe(configBefore);
    expect(readFileSync(join(boot, "cmdline.txt"), "utf8")).toBe(cmdlineBefore);
  });

  it("disables the getty on ttyAMA0 but does not stop it synchronously — that can be the session running the install", () => {
    // serial-getty@ttyAMA0 is not merely inert until reboot: on a board
    // where ttyAMA0 is already the console UART, it can be the operator's
    // own login session, brought up over a USB-to-serial adapter for a
    // board's first bring-up before Wi-Fi or the mesh exist. `enable_uart=1`
    // and `dtoverlay=disable-bt` do not take hardware effect until a
    // reboot, so disabling the unit — already asserted below — is enough;
    // nothing needs that session, or the install running in it, torn down
    // now for it.
    const { path, log } = stubSystemdTools();
    const boot = bootFixture("dtparam=audio=on\n", "console=serial0,115200 root=x\n");

    const r = runUart(boot, { path });
    expect(r.code, r.out).toBe(0);

    const calls = readFileSync(log, "utf8");
    expect(calls).not.toContain("systemctl stop serial-getty@ttyAMA0.service");
    expect(calls).toContain("deb-systemd-helper disable serial-getty@ttyAMA0.service");
  });

  it("stops and disables the Bluetooth UART attach service", () => {
    // hciuart carries none of the getty's risk — stopping it cannot tear
    // down anyone's login session — so it keeps the stop-disable-assert
    // sequence 40-zerotier.sh also uses.
    const { path, log } = stubSystemdTools();
    const boot = bootFixture("dtparam=audio=on\n", "console=serial0,115200 root=x\n");

    const r = runUart(boot, { path });
    expect(r.code, r.out).toBe(0);

    const calls = readFileSync(log, "utf8");
    expect(calls).toContain("systemctl stop hciuart.service");
    expect(calls).toContain("deb-systemd-helper disable hciuart.service");
  });

  it("never asserts /dev/ttyAMA0 itself — that fails every image build in a chroot", () => {
    // The trap named in the plan: install.sh also runs in a chroot on a
    // build host, where the board's UART does not exist and no overlay has
    // been applied for want of a reboot. The post-condition here has to be
    // about the configuration this role wrote, not the hardware.
    const role = readFileSync(UART_ROLE, "utf8");
    expect(role).not.toMatch(/\[\s*-[a-z]\s+["']?\/dev\/ttyAMA0/);
  });

  it("traces to R-MAV-02 and R-HW-04, and starts with the shared SPDX header", () => {
    const role = readFileSync(UART_ROLE, "utf8");
    expect(role.startsWith("# SPDX-License-Identifier: GPL-3.0-or-later\n")).toBe(true);
    expect(role).toContain("R-MAV-02");
    expect(role).toContain("R-HW-04");
  });

});

/**
 * install.sh has no per-role allowlist — it discovers roles.NN-name.sh by a
 * plain filename glob (`for role in "$HERE"/roles/*.sh`) and runs them in
 * the sort order that gives them. So a new role is "registered" by existing
 * under installer/roles/ with the right name, and nothing in install.sh
 * itself needs to change for it to run. Pinned here so that if install.sh
 * ever grows an allowlist, this test — not a board — is what notices
 * 40-uart.sh was left off it.
 */
describe("role registration", () => {


  it("install.sh discovers roles by filename glob rather than a list", () => {
    const installer = readFileSync(join(ROOT, "installer", "install.sh"), "utf8");
    expect(installer).toMatch(/for role in "\$HERE"\/roles\/\*\.sh/);
  });

  it("40-uart.sh sits alongside the installer's other hardware-enablement roles", () => {
    const files = readdirSync(join(ROOT, "installer", "roles"));
    expect(files).toEqual(
      expect.arrayContaining([
        "10-base.sh", "15-mavlink-router.sh", "20-yonder-core.sh",
        "30-console.sh", "40-modem.sh", "40-uart.sh", "40-zerotier.sh",
      ]),
    );
  });

  /**
   * The number prefix is the ordering, and here it is the whole of one
   * defect.
   *
   * `20-yonder-core.sh` ends by restarting the daemon, and
   * `yonder-core.service` is `ProtectSystem=strict`: a unit's mount
   * namespace is built **when the unit starts**, so a `ReadWritePaths`
   * directory created after that is present on the filesystem and read-only
   * inside the running service. Creating /etc/mavlink-router from a 40-*
   * role therefore left the very first render failing EROFS on a board where
   * every check in this installer had passed. Sorting before 20 is the fix,
   * and a filename is not the kind of thing anybody re-derives, so it is
   * pinned here.
   */
  it("15-mavlink-router.sh runs before the daemon whose sandbox has to contain its directory", () => {
    const roles = readdirSync(join(ROOT, "installer", "roles")).sort();
    expect(roles.indexOf("15-mavlink-router.sh")).toBeGreaterThanOrEqual(0);
    expect(
      roles.indexOf("15-mavlink-router.sh"),
      "the daemon would be restarted before /etc/mavlink-router existed, and could not write there until the next restart",
    ).toBeLessThan(roles.indexOf("20-yonder-core.sh"));
  });

});

/**
 * `elf_machine`, exercised against headers built byte by byte.
 *
 * It is the only new arithmetic this milestone's installer work added, and
 * the failure it stands between is one nothing else in this repository can
 * see: an x86-64 `mavlink-routerd` staged into an arm64 payload is a file
 * that exists, is executable, and is named correctly by its unit's
 * ExecStart — every check the installer makes passes, and the board answers
 * `Exec format error`, status=203, on every start.
 *
 * The fixtures are 64-byte headers rather than real binaries, so the test
 * asserts what the function reads rather than what this machine happens to
 * have lying about in /bin.
 */
describe("elf_machine", () => {
  /** An ELF header: `machine` at e_machine, `data` at EI_DATA (1 = little-endian). */
  function elfHeader(machine: number, data = 1): Buffer {
    const h = Buffer.alloc(64);
    h.write("\x7fELF", 0, "binary");
    h[4] = 2; // 64-bit
    h[5] = data;
    h[6] = 1;
    h.writeUInt16LE(2, 16); // e_type: ET_EXEC
    if (data === 1) h.writeUInt16LE(machine, 18); else h.writeUInt16BE(machine, 18);
    return h;
  }

  function elfFile(name: string, body: Buffer): string {
    const path = join(dir, name);
    writeFileSync(path, body);
    return path;
  }

  function machineOf(path: string) {
    return sh(`set -eu; . '${COMMON}'; elf_machine '${path}'`).out.trim();
  }




  it("reads e_machine out of a little-endian ELF header", () => {
    // 183 is EM_AARCH64 — a Raspberry Pi — and 62 is EM_X86_64.
    expect(machineOf(elfFile("aarch64", elfHeader(183)))).toBe("183");
    expect(machineOf(elfFile("x86_64", elfHeader(62)))).toBe("62");
  });

  it("says nothing about a file that is not an ELF at all", () => {
    expect(machineOf(elfFile("script", Buffer.alloc(64, "#".charCodeAt(0))))).toBe("");
  });

  it("declines a big-endian ELF rather than misreading it", () => {
    // Nothing this installer supports is big-endian, and a function that
    // guessed at a byte order would answer 46848 for aarch64 — a number that
    // is wrong in a way no caller could detect.
    expect(machineOf(elfFile("bigendian", elfHeader(183, 2)))).toBe("");
  });

  it("says nothing about a file too short to have a header, or one that is not there", () => {
    expect(machineOf(elfFile("truncated", Buffer.from("\x7fELF", "binary")))).toBe("");
    expect(machineOf(join(dir, "absent"))).toBe("");
  });

});

/**
 * The router's unit, read rather than trusted.
 *
 * It is the one unit in this repository that was written down from a board
 * rather than designed at a desk: this exact text was run on a Raspberry
 * Pi 4 with a live ArduPlane and two ground stations answering on
 * 2026-09-06 (docs/hardware/an-autopilot-on-the-uart.md). Every assertion
 * below is a property that would otherwise only be discovered by flying.
 */
describe("systemd/mavlink-router.service", () => {
  const unit = readFileSync(join(SYSTEMD, "mavlink-router.service"), "utf8");






  it("is the unit the renderer starts and reads statistics from", () => {
    // Two halves of one statement. `systemctl start mavlink-router` and
    // `journalctl -u mavlink-router` both come from ROUTER_UNIT; a unit file
    // under any other name is a renderer talking to nothing.
    expect(`${ROUTER_UNIT}.service`).toBe("mavlink-router.service");
    expect(readdirSync(SYSTEMD)).toContain(`${ROUTER_UNIT}.service`);
  });

  it("starts the binary the installer stages, with the configuration the daemon generates", () => {
    const exec = /^ExecStart=(.*)$/m.exec(unit)?.[1] ?? "";
    // The other half of YONDER_MAVLINK_BIN in installer/lib/common.sh; the
    // role's own assert_unit_exec compares the pair at install time, and
    // this is what compares them in CI, on a machine with no systemd.
    expect(exec.split(" ")[0]).toBe("/usr/bin/mavlink-routerd");
    expect(readFileSync(COMMON, "utf8")).toMatch(/^: "\$\{YONDER_MAVLINK_BIN:=\/usr\/bin\/mavlink-routerd\}"$/m);
    // And the other half of ROUTER_CONF_PATH. A unit reading one file while
    // the daemon writes another is a router that never sees a change an
    // operator made, with nothing anywhere saying so.
    expect(exec).toContain(`-c ${ROUTER_CONF_PATH}`);
  });

  /**
   * `Restart=on-failure`, and not `always`, is load-bearing in two
   * directions at once.
   *
   * The renderer deliberately notices a dead router and does not restart it,
   * because restarting a service is the service manager's job — a control
   * plane that did it would make the router's lifetime depend on its own,
   * which is what R-MAV-06 forbids. So something has to restart it, and this
   * is that something.
   *
   * And `on-failure` rather than `always` is what leaves a *clean* exit
   * exited. Systemd does not restart a unit after `systemctl stop` or an
   * equivalent operation under any Restart= setting — `always` included —
   * so re-detection's stop of the router (R-MAV-16) stays stopped either
   * way, and that is not what the choice turns on. What differs is a router
   * that exits 0 on its own: told to, or because the configuration it was
   * started with leaves it nothing to do. `on-failure` leaves that router
   * exited; `always` would bring it back regardless.
   */
  it("is restarted by systemd on failure, with a delay, and never restarted always", () => {
    expect(unit).toMatch(/^Restart=on-failure$/m);
    expect(unit).not.toMatch(/^Restart=always$/m);
    const delay = /^RestartSec=(\d+)/m.exec(unit)?.[1];
    expect(delay, "a restart with no delay is a busy loop on a 905 MiB board").toBeDefined();
    expect(Number(delay)).toBeGreaterThan(0);
  });

  /**
   * The line the console's per-station marks hang from.
   *
   * `ReportStats = true` prints a block per endpoint to stdout once a
   * second and the renderer reads it back out of the journal; where stdout
   * goes is otherwise decided by `DefaultStandardOutput=` in system.conf,
   * which a distribution or an operator may set to anything. If it is ever
   * not the journal, `parseStats` finds nothing — which is indistinguishable
   * from a router that has not printed yet, so there is no error, no log
   * line, and a page that simply never says which ground station is
   * answering.
   */
  it("puts the router's statistics in the journal rather than wherever the host defaults", () => {
    expect(unit).toMatch(/^StandardOutput=journal$/m);
  });

  it("can be enabled deliberately, even though the installer leaves it disabled", () => {
    // Kept so `systemctl enable mavlink-router` on a bench does something
    // rather than failing with "unit has no installation config" and reading
    // like a broken unit file. R-MAV-17 is enforced by the role, which
    // disables it and asserts the result — not by omitting this section.
    expect(unit).toMatch(/^WantedBy=multi-user\.target$/m);
  });

  it("starts with the shared SPDX header", () => {
    expect(unit.startsWith("# SPDX-License-Identifier: GPL-3.0-or-later\n")).toBe(true);
  });

});

/**
 * R-MAV-06, which is the whole reason `mavlink-router` is its own service:
 * **restarting yonder-core must leave the router running.** Raw MAVLink
 * never passes through the control plane on its way to a ground station, so
 * a Node-RED restart — or a daemon upgrade, or a crash — is invisible to
 * Mission Planner.
 *
 * Nothing in either unit's *code* makes that true; it is true because of
 * what the two unit files do **not** say to each other. systemd propagates a
 * restart along exactly one kind of edge — `PartOf=`, and the stop
 * propagation of `BindsTo=`, `Requires=`, `Requisite=`, `StopPropagatedFrom=`
 * and `PropagatesStopTo=` — so the property is the absence of every one of
 * them between these two units, and that is what is asserted here.
 *
 * This is a static check and it is honest about being one: the behaviour
 * itself is proven on a board with
 *
 *     systemctl show -p MainPID mavlink-router
 *     systemctl restart yonder-core
 *     systemctl show -p MainPID mavlink-router     # the same number
 *
 * What this test buys is that nobody can quietly add `PartOf=` later — which
 * would read like tidiness and would drop every ground station in flight
 * every time the daemon was restarted.
 */
describe("a yonder-core restart leaves the router running", () => {
  /** `Key=value` pairs, with comments and blank lines dropped. */
  function directives(text: string): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
      const m = /^([A-Za-z][A-Za-z0-9]*)=(.*)$/.exec(line);
      if (m?.[1] !== undefined && m[2] !== undefined) out.push([m[1], m[2]]);
    }
    return out;
  }

  const router = directives(readFileSync(join(SYSTEMD, "mavlink-router.service"), "utf8"));
  const core = directives(readFileSync(join(SYSTEMD, "yonder-core.service"), "utf8"));




  it("the router's unit says nothing at all about yonder-core", () => {
    const naming = router.filter(([, value]) => value.includes("yonder-core"));
    expect(
      naming.map(([key, value]) => `${key}=${value}`),
      "a setting that names yonder-core is a router whose lifetime follows the control plane's",
    ).toEqual([]);
  });

  it("yonder-core's unit names the router in nothing but a writable path", () => {
    // ReadWritePaths=-/etc/mavlink-router is a *directory*, not a unit, and
    // it is what lets the daemon generate main.conf under
    // ProtectSystem=strict. Every other mention would be a dependency.
    const naming = core.filter(([, value]) => value.includes("mavlink-router"));
    expect(naming.map(([key]) => key)).toEqual(["ReadWritePaths"]);
  });

  it("the router's unit declares no dependency that could propagate a stop or a restart", () => {
    const propagating = [
      "Requires", "Requisite", "BindsTo", "PartOf", "Upholds",
      "StopPropagatedFrom", "PropagatesStopTo", "PropagatesReloadTo",
    ];
    for (const [key, value] of router) {
      expect(
        propagating,
        `${key}=${value} can make another unit's lifecycle this one's; R-MAV-06 says it must not`,
      ).not.toContain(key);
    }
  });

  it("neither unit stops the other from a lifecycle hook", () => {
    // The other route to the same defect: an ExecStopPost= that tidies up
    // by stopping the router would take telemetry down on every daemon
    // restart, and would not be a dependency directive at all.
    for (const [key, value] of [...router, ...core]) {
      if (!key.startsWith("Exec")) continue;
      expect(value, `${key} runs a command that touches the other service`).not.toMatch(/systemctl/);
    }
  });

});

/**
 * The mavlink-router role, run rather than read.
 *
 * It carries the one component of the offline payload that is *built* rather
 * than downloaded, and it has three jobs that each close a defect somebody
 * has already met: create the directory the daemon generates `main.conf`
 * into **before** the daemon's sandbox is built around it, refuse a binary
 * for the wrong architecture, and leave the service installed and off.
 *
 * Exercised against fixture paths — `YONDER_MAVLINK_ETC` and
 * `YONDER_ELF_REFERENCE`, both overridable for exactly this reason — so the
 * paths that need root are reached only on a dry run, where nothing is
 * written and the command sequence is what is asserted.
 */
describe("the mavlink-router role", () => {
  const MR_ROLE = join(ROOT, "installer", "roles", "15-mavlink-router.sh");

  /** An ELF header for `machine`, as a staged payload binary would be. */
  function elfBytes(machine: number): Buffer {
    const h = Buffer.alloc(64);
    h.write("\x7fELF", 0, "binary");
    h[4] = 2;
    h[5] = 1;
    h[6] = 1;
    h.writeUInt16LE(2, 16);
    h.writeUInt16LE(machine, 18);
    return h;
  }

  /**
   * A stub PATH: systemd tools that only record, and an **apt that always
   * fails**.
   *
   * The apt stub is this test's version of M2a's dead proxy. R-CFG-07 says
   * the install path needs no network, and the way to prove it of a role is
   * to make every package manager it could reach for fail loudly and then
   * watch the role finish anyway.
   */
  function stubTools(): { path: string; log: string } {
    const bin = join(dir, "mrbin");
    const log = join(dir, "mr.log");
    mkdirSync(bin, { recursive: true });
    const recorder = [
      "#!/bin/sh",
      `printf '%s %s\\n' "$(basename "$0")" "$*" >> '${log}'`,
      "exit 0",
      "",
    ].join("\n");
    writeFileSync(join(bin, "systemctl"), recorder, { mode: 0o755 });
    writeFileSync(join(bin, "deb-systemd-helper"), recorder, { mode: 0o755 });
    for (const name of ["apt-get", "apt", "dpkg"]) {
      writeFileSync(join(bin, name), [
        "#!/bin/sh",
        `printf '%s %s\\n' "$(basename "$0")" "$*" >> '${log}'`,
        'printf "the network is not here\\n" >&2',
        "exit 100",
        "",
      ].join("\n"), { mode: 0o755 });
    }
    writeFileSync(log, "");
    return { path: `${bin}:${process.env.PATH ?? ""}`, log };
  }

  /**
   * A staged repository: `vendor/mavlink-router/` and `systemd/`, exactly
   * what install.sh points $YONDER_SRC at. The unit is the **shipped** one,
   * so `assert_unit_exec`'s comparison of ExecStart against the installer's
   * own destination is the real pair being checked.
   */
  function payload(opts: { binary?: Buffer | null } = {}): string {
    const src = join(dir, "src");
    mkdirSync(join(src, "systemd"), { recursive: true });
    writeFileSync(
      join(src, "systemd", "mavlink-router.service"),
      readFileSync(join(SYSTEMD, "mavlink-router.service")),
    );
    if (opts.binary !== null) {
      mkdirSync(join(src, "vendor", "mavlink-router"), { recursive: true });
      writeFileSync(
        join(src, "vendor", "mavlink-router", "mavlink-routerd"),
        opts.binary ?? elfBytes(183),
        { mode: 0o755 },
      );
    }
    return src;
  }

  function runRole(opts: {
    src: string;
    path: string;
    dryRun?: boolean;
    etc?: string;
    reference?: string;
  }) {
    return sh(
      `set -eu; . '${COMMON}'; . '${MR_ROLE}'`,
      {
        DRY_RUN: opts.dryRun === true ? "1" : "0",
        YONDER_SRC: opts.src,
        YONDER_MAVLINK_ETC: opts.etc ?? join(dir, "etc-mavlink-router"),
        YONDER_SYSTEMD_DIRS: join(dir, "no-systemd-here"),
        ...(opts.reference === undefined ? {} : { YONDER_ELF_REFERENCE: opts.reference }),
      },
      opts.path,
    );
  }












  /**
   * `mr_install_bin`, called directly rather than through the whole role —
   * the role's own last step copies the unit to /etc/systemd/system, which
   * is real outside a chroot, so exercising it end to end here would either
   * write there or need DRY_RUN, and DRY_RUN never calls this function at
   * all (`run` only prints). Extracting the function by its brace lines and
   * sourcing that is what lets the rest of it be tested for real.
   */
  function mrInstallBin(): string {
    const fn = join(dir, "mr_install_bin.sh");
    const { code, out } = sh(`sed -n '/^mr_install_bin() {/,/^}/p' '${MR_ROLE}' > '${fn}'`);
    if (code !== 0) throw new Error(`could not extract mr_install_bin: ${out}`);
    return fn;
  }



  /**
   * Step 2a, and the defect it exists for. `yonder-core.service` runs
   * `ProtectSystem=strict` and a unit's mount namespace is built **when the
   * unit starts**, so a directory created afterwards is on the filesystem
   * and read-only inside the running service. The first render on a board
   * failed `EROFS: read-only file system` for exactly this reason.
   */
  it("creates the directory the daemon generates main.conf into before it judges the payload at all", () => {
    // Deliberately not inside the payload check: a board with no usable
    // router still renders, and it must fail with "the service is not
    // installed" rather than with EROFS — which names the wrong problem and
    // sends whoever reads it looking at systemd sandboxing instead of at an
    // empty vendor directory. Run here against a payload that is refused, so
    // the directory being there afterwards is the whole point.
    const { path } = stubTools();
    const etc = join(dir, "etc-mr");
    const r = runRole({ src: payload({ binary: Buffer.from("not an elf") }), path, etc });
    expect(r.code).not.toBe(0);
    expect(statSync(etc).isDirectory(), `${etc} was not created`).toBe(true);
  });

  it("skips cleanly when the payload carries no router, and still leaves the directory", () => {
    const { path } = stubTools();
    const etc = join(dir, "etc-none");
    const r = runRole({ src: payload({ binary: null }), path, etc });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("no mavlink-router in the payload; skipping");
    expect(r.out).toContain("make-payload.sh");
    expect(statSync(etc).isDirectory()).toBe(true);
  });

  /**
   * The warning that exists because the failure it names is silent. A
   * running daemon keeps the mount namespace it started with, so a directory
   * created underneath it is read-only inside the service until it is
   * restarted — and `--only 15-mavlink-router` is exactly the invocation
   * somebody reaches for when they are fixing this by hand, with no
   * 20-yonder-core.sh behind it to do the restart.
   */
  it("says so when it creates the directory under a yonder-core that is already running", () => {
    const { path } = stubTools(); // its systemctl answers is-active with 0
    const r = runRole({ src: payload({ binary: null }), path, etc: join(dir, "etc-live") });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("it cannot write there yet");
    expect(r.out).toContain("systemctl restart yonder-core");
  });

  it("puts it exactly where the renderer writes, and where the daemon is allowed to", () => {
    // Three files name this directory — the renderer, yonder-core.service's
    // ReadWritePaths and this role — and the first two are already tied
    // together above. This is the third knot.
    expect(readFileSync(COMMON, "utf8"))
      .toMatch(new RegExp(`^: "\\$\\{YONDER_MAVLINK_ETC:=${dirname(ROUTER_CONF_PATH)}\\}"$`, "m"));
  });

  /**
   * R-CFG-07, proved the way it can be proved without a board: every package
   * manager on PATH fails, and the role finishes anyway. On hardware the
   * same claim is made by pointing apt at a dead proxy and reading
   * `Need to get 0 B`.
   */
  it("installs with every package manager on PATH failing, because it never calls one", () => {
    const { path, log } = stubTools();
    const r = runRole({ src: payload(), path, dryRun: true, reference: join(dir, "ref") });
    expect(r.code, r.out).toBe(0);
    expect(readFileSync(log, "utf8")).not.toMatch(/^(apt-get|apt|dpkg) /m);
    // And the role text names none of the helpers that would reach for one.
    const role = readFileSync(MR_ROLE, "utf8");
    expect(role).not.toMatch(/ensure_pkgs|apt_update_once|apt-get/);
  });

  it("refuses a payload binary that is not an executable at all", () => {
    const { path } = stubTools();
    const r = runRole({ src: payload({ binary: Buffer.from("#!/bin/sh\nexit 0\n") }), path });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("not a little-endian ELF executable");
  });

  /**
   * The failure that only a board would otherwise report, and it would
   * report it as `status=203/EXEC` on every start with nothing saying why.
   */
  it("refuses a payload built for another architecture, naming both", () => {
    const { path } = stubTools();
    const reference = join(dir, "reference-x86_64");
    writeFileSync(reference, elfBytes(62));
    const r = runRole({ src: payload({ binary: elfBytes(183) }), path, reference });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("183");
    expect(r.out).toContain("62");
    expect(r.out).toContain("Exec format error");
  });

  it("installs a payload whose architecture matches, and says so", () => {
    const { path } = stubTools();
    const reference = join(dir, "reference-aarch64");
    writeFileSync(reference, elfBytes(183));
    const r = runRole({ src: payload({ binary: elfBytes(183) }), path, dryRun: true, reference });
    expect(r.code, r.out).toBe(0);
    // A bare `toContain("ELF machine 183")` also passes if this branch's log
    // line is replaced by the "no reference, installing unchecked" branch's
    // wording — both interpolate the same `$mr_have`. "the same as
    // <reference>" is the phrase only the match branch prints, and
    // "unchecked" is the tell if the wrong branch's text has been swapped in.
    expect(r.out).toContain(`ELF machine 183, the same as ${reference}`);
    expect(r.out).not.toContain("unchecked");
    expect(r.out).toContain("/usr/bin/mavlink-routerd");
    expect(r.out).toContain("/etc/systemd/system/mavlink-router.service");
  });

  /**
   * R-MAV-17. The serial port is the resource the router and detection
   * contend for: a unit enabled here would open it at every boot before the
   * sweep could, and on a freshly flashed board there is no generated
   * configuration for it to read at all.
   */
  it("leaves the unit disabled, and never starts or enables it", () => {
    const { path, log } = stubTools();
    const r = runRole({ src: payload(), path, dryRun: true, reference: join(dir, "ref") });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("yonder-core starts it, and only once a link has been found");
    const everything = `${r.out}\n${readFileSync(log, "utf8")}`;
    expect(everything).not.toMatch(/systemctl (start|enable|restart) mavlink-router/);
    expect(everything).toMatch(/deb-systemd-helper disable mavlink-router\.service/);
  });

  /**
   * The difference from 40-zerotier.sh, which does stop the thing it
   * installs. Disabling arms the next boot and leaves this one alone, so an
   * operator upgrading a device that is carrying telemetry keeps carrying
   * it — R-MAV-06 again, and the K-37 irony that the tool for reaching a
   * device is what takes it away.
   */
  it("never stops a router that is already running", () => {
    const { path, log } = stubTools();
    const r = runRole({ src: payload(), path, dryRun: true, reference: join(dir, "ref") });
    expect(r.code, r.out).toBe(0);
    const everything = `${r.out}\n${readFileSync(log, "utf8")}`;
    expect(everything).not.toMatch(/systemctl stop/);
    expect(readFileSync(MR_ROLE, "utf8")).not.toMatch(/systemctl stop/);
  });

  it("replaces the binary by rename, so an upgrade over a running router is not ETXTBSY", () => {
    // Writing into a running executable is "Text file busy" and stops the
    // install; a rename replaces the directory entry and leaves the running
    // process on its own inode.
    const role = readFileSync(MR_ROLE, "utf8");
    expect(role).toMatch(/cp "\$1" "\$2\.new"/);
    expect(role).toMatch(/mv "\$2\.new" "\$2"/);
  });

  it("removes a stale .new left by an earlier run before installing", () => {
    // A run that died between its cp and its mv leaves "$2.new" behind, and
    // nothing else in the role ever looks for it again — so the next run
    // has to, rather than leaving it for cp to silently overwrite (or not,
    // if whatever stopped the mv also stops the cp).
    const fn = mrInstallBin();
    const src = join(dir, "new-binary");
    writeFileSync(src, "the new binary");
    const dest = join(dir, "installed-binary");
    writeFileSync(`${dest}.new`, "stale: a run that died before its mv");
    const r = sh(`set -eu; . '${fn}'; mr_install_bin '${src}' '${dest}'`);
    expect(r.code, r.out).toBe(0);
    expect(readFileSync(dest, "utf8")).toBe("the new binary");
    expect(existsSync(`${dest}.new`)).toBe(false);
  });

  it("leaves no .new behind when the copy itself fails", () => {
    const fn = mrInstallBin();
    const dest = join(dir, "installed-binary-2");
    writeFileSync(`${dest}.new`, "stale: a run that died before its mv");
    const r = sh(`. '${fn}'; mr_install_bin '${join(dir, "does-not-exist")}' '${dest}'`);
    expect(r.code).not.toBe(0);
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}.new`)).toBe(false);
  });

  it("traces to R-CFG-07, R-MAV-06 and R-MAV-17, and starts with the shared SPDX header", () => {
    const role = readFileSync(MR_ROLE, "utf8");
    expect(role.startsWith("# SPDX-License-Identifier: GPL-3.0-or-later\n")).toBe(true);
    for (const id of ["R-CFG-07", "R-MAV-06", "R-MAV-17"]) {
      expect(role).toContain(id);
    }
    const requirements = readFileSync(join(ROOT, "docs", "requirements.md"), "utf8");
    for (const id of ["R-CFG-07", "R-MAV-06", "R-MAV-17"]) {
      expect(requirements, `${id} is cited by a role and is not in docs/requirements.md`)
        .toContain(`| ${id} |`);
    }
  });

});

describe("installer/make-payload.sh stages gst-rockchip", () => {
  const script = readFileSync(join(ROOT, "installer", "make-payload.sh"), "utf8");

  it("pins each of the three sources to a full commit", () => {
    for (const name of ["MPP_COMMIT", "LIBRGA_COMMIT", "GST_ROCKCHIP_COMMIT"]) {
      expect(script).toMatch(new RegExp(`^${name}=\\$\\{${name}:-[0-9a-f]{40}\\}$`, "m"));
    }
  });

  it("lists it as a component, staged before the console", () => {
    expect(script).toMatch(/^COMPONENTS="node zerotier mavlink-router gst-rockchip console"$/m);
  });

  it("stages it only for arm64, which is every Rockchip board there is", () => {
    expect(script).toContain('if [ "$ARCH" != "linux-arm64" ]');
  });

  it("proves the built plugin registers before staging it", () => {
    expect(script).toContain("gst-inspect-1.0 rockchipmpp");
    expect(script).toContain("grep -q mppjpegdec");
  });

  it("never reads a variable in the summary that only one component sets (K-64)", () => {
    const summary = script.slice(script.indexOf('step "done"'));
    expect(summary).not.toContain("$ZT_DEB");
  });
});

describe("installer/roles/52-gst-rockchip.sh", () => {
  const GR_ROLE = join(ROOT, "installer", "roles", "52-gst-rockchip.sh");

  /** An ELF header for `machine`, as a staged shared object would begin. */
  function elfObject(machine: number): Buffer {
    const h = Buffer.alloc(64);
    h.write("\x7fELF", 0, "binary");
    h[4] = 2;
    h[5] = 1;
    h[6] = 1;
    h.writeUInt16LE(3, 16);
    h.writeUInt16LE(machine, 18);
    return h;
  }
  /** dpkg says every package is present, apt has no network, ldconfig and gst-inspect record what they were asked. */
  function stubs(opts: { unresolved?: string[] } = {}): { path: string; log: string } {
    const bin = join(dir, "grbin");
    const log = join(dir, "gr.log");
    mkdirSync(bin, { recursive: true });
    const record = (name: string, body: string) => writeFileSync(join(bin, name), [
      "#!/bin/sh",
      `printf '%s %s\\n' "$(basename "$0")" "$*" >> '${log}'`,
      body,
      "",
    ].join("\n"), { mode: 0o755 });
    record("dpkg-query", 'printf "install ok installed\\n"; exit 0');
    record("apt-get", 'printf "the network is not here\\n" >&2; exit 100');
    record("ldconfig", "exit 0");
    const cases = (opts.unresolved ?? []).map((e) => `*"${e}"*) exit 1 ;;`).join(" ");
    record("gst-inspect-1.0", `case "$*" in ${cases} *) exit 0 ;; esac`);
    writeFileSync(log, "");
    return { path: `${bin}:${process.env.PATH ?? ""}`, log };
  }
  function payload(opts: { plugin?: Buffer } = {}): string {
    const src = join(dir, "src");
    const lib = join(src, "vendor", "gst-rockchip", "lib");
    const plug = join(src, "vendor", "gst-rockchip", "gstreamer-1.0");
    mkdirSync(lib, { recursive: true });
    mkdirSync(plug, { recursive: true });
    writeFileSync(join(lib, "librockchip_mpp.so.0"), elfObject(183));
    symlinkSync("librockchip_mpp.so.0", join(lib, "librockchip_mpp.so.1"));
    symlinkSync("librockchip_mpp.so.1", join(lib, "librockchip_mpp.so"));
    writeFileSync(join(lib, "librga.so.2"), elfObject(183));
    symlinkSync("librga.so.2", join(lib, "librga.so"));
    writeFileSync(join(plug, "libgstrockchipmpp.so"), opts.plugin ?? elfObject(183));
    return src;
  }
  function board() {
    const libdir = join(dir, "usr-lib");
    const registry = join(dir, "gst-cache");
    mkdirSync(registry, { recursive: true });
    writeFileSync(join(registry, "registry.aarch64.bin"), "stale");
    const reference = join(dir, "reference-elf");
    writeFileSync(reference, elfObject(183));
    return { libdir, plugindir: join(libdir, "gstreamer-1.0"), registry, reference };
  }
  function runRole(opts: { src: string; path: string; device: string; board: ReturnType<typeof board>; dryRun?: boolean }) {
    return sh(
      `set -eu; . '${COMMON}'; . '${GR_ROLE}'`,
      {
        DRY_RUN: opts.dryRun === true ? "1" : "0",
        YONDER_SRC: opts.src,
        YONDER_MPP_DEVICE: opts.device,
        YONDER_GST_LIBDIR: opts.board.libdir,
        YONDER_GST_PLUGIN_DIR: opts.board.plugindir,
        YONDER_GST_REGISTRY_DIRS: opts.board.registry,
        YONDER_ELF_REFERENCE: opts.board.reference,
      },
      opts.path,
    );
  }
  // /dev/null is a character device on every Unix; a Rockchip board is told
  // apart by the character device MPP opens, so it stands in for one here.
  const ROCKCHIP = "/dev/null";

  it("skips, and says how to build one, when the payload carries no plugin", () => {
    const src = join(dir, "bare-src");
    mkdirSync(src, { recursive: true });
    const r = runRole({ src, path: stubs().path, device: ROCKCHIP, board: board() });
    expect(r.code).toBe(0);
    expect(r.out).toContain("no gst-rockchip in the payload; skipping");
    expect(r.out).toContain("--only gst-rockchip");
  });

  it("leaves a board with no MPP device alone, and says why (R-HW-04)", () => {
    const b = board();
    const { path, log } = stubs();
    const r = runRole({ src: payload(), path, device: join(dir, "no-such-node"), board: b });
    expect(r.code).toBe(0);
    expect(r.out).toContain("not a Rockchip board");
    expect(existsSync(join(b.plugindir, "libgstrockchipmpp.so"))).toBe(false);
    expect(readFileSync(log, "utf8")).not.toContain("ldconfig");
  });

  it("installs the libraries and the plugin where GStreamer looks, refreshes the loader and drops the registry cache", () => {
    const b = board();
    const { path, log } = stubs();
    const r = runRole({ src: payload(), path, device: ROCKCHIP, board: b });
    expect(r.code).toBe(0);
    expect(existsSync(join(b.plugindir, "libgstrockchipmpp.so"))).toBe(true);
    expect(existsSync(join(b.libdir, "librockchip_mpp.so.0"))).toBe(true);
    expect(lstatSync(join(b.libdir, "librockchip_mpp.so.1")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(b.libdir, "librga.so.2"))).toBe(true);
    expect(existsSync(join(b.registry, "registry.aarch64.bin"))).toBe(false);
    const asked = readFileSync(log, "utf8");
    expect(asked).toContain("ldconfig");
    for (const element of ["mpph264enc", "mpph265enc", "mppjpegdec"]) {
      expect(asked).toContain(`gst-inspect-1.0 --exists ${element}`);
    }
    expect(r.out).toContain("probeEncoder will find them");
  });

  it("dies naming the element the registry does not resolve, and names the permission trap", () => {
    const r = runRole({ src: payload(), path: stubs({ unresolved: ["mpph265enc"] }).path, device: ROCKCHIP, board: board() });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("does not resolve mpph265enc");
    expect(r.out).toContain("decoders and no encoders");
  });

  it("refuses a plugin built for another architecture, naming both", () => {
    const r = runRole({ src: payload({ plugin: elfObject(62) }), path: stubs().path, device: ROCKCHIP, board: board() });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("ELF machine 62");
    expect(r.out).toContain("183");
  });

  it("says what it would do on a dry run, and touches nothing", () => {
    const b = board();
    const r = runRole({ src: payload(), path: stubs().path, device: ROCKCHIP, board: b, dryRun: true });
    expect(r.code).toBe(0);
    expect(r.out).toContain("would check that GStreamer resolves");
    expect(existsSync(join(b.plugindir, "libgstrockchipmpp.so"))).toBe(false);
    expect(existsSync(join(b.registry, "registry.aarch64.bin"))).toBe(true);
  });

  it("installs libdrm2 and the tools package from Debian, not the payload", () => {
    expect(readFileSync(GR_ROLE, "utf8")).toMatch(/^ensure_pkgs libdrm2 gstreamer1\.0-tools$/m);
  });
});

describe("installer/roles/50-mediamtx.sh installs what every pipeline is made of (spec §10)", () => {
  const role = readFileSync(join(ROOT, "installer", "roles", "50-mediamtx.sh"), "utf8");
  const ensure = role.slice(role.indexOf("ensure_pkgs gstreamer1.0-tools"), role.indexOf("gstreamer1.0-rtsp") + "gstreamer1.0-rtsp".length);

  it("names every GStreamer package the composer relies on, on every board", () => {
    for (const pkg of ["gstreamer1.0-tools", "gstreamer1.0-plugins-base", "gstreamer1.0-plugins-good",
      "gstreamer1.0-plugins-bad", "gstreamer1.0-plugins-ugly", "gstreamer1.0-rtsp"]) {
      expect(ensure).toContain(pkg);
    }
  });

  it("resolves every board-independent element compose() can name, and dies on the first it cannot", () => {
    // The list in video/pipeline.ts, minus the elements a board's own plugin
    // provides (v4l2convert and v4l2h264enc on a Pi; the MPP elements on
    // Rockchip, which 52-gst-rockchip.sh checks).
    for (const element of ["rtspclientsink", "v4l2src", "jpegdec", "videoflip", "tee", "queue", "capsfilter",
      "videorate", "videoconvert", "videoscale", "h264parse", "h265parse", "rtph264pay", "rtph265pay",
      "udpsink", "x264enc", "jpegenc", "matroskamux", "filesink"]) {
      expect(role).toContain(element);
    }
    expect(role).toContain('gst-inspect-1.0 --exists "$mtx_element"');
    expect(role).toContain("|| die");
  });

  it("no longer takes the weaker branch when gst-inspect-1.0 is absent — it dies", () => {
    expect(role).not.toContain("no gst-inspect-1.0 here to resolve");
    expect(role).toContain("still no gst-inspect-1.0");
  });
});

describe('accessory daemon filesystem boundary', () => {
  it('prepares configfs before core starts and grants only the gadget subtree', () => {
    const role = readFileSync(join(ROOT, 'installer/roles/18-accessory-usb.sh'), 'utf8');
    const unit = readFileSync(join(ROOT, 'systemd/yonder-core.service'), 'utf8');
    expect(role).toContain('modprobe libcomposite'); expect(role).toContain('mount -t configfs');
    expect(role).toContain('core installation continues');
    expect(unit).toContain('After=local-fs.target NetworkManager.service systemd-modules-load.service sys-kernel-config.mount');
    expect(unit).toContain('-/sys/kernel/config/usb_gadget');
    expect(unit).toContain('ProtectSystem=strict'); expect(unit).not.toMatch(/^ReadWritePaths=.*(?:\s|=)\/sys(?:\s|$)/m);
    const helper = readFileSync(join(ROOT, 'packages/yonder-core/src/video/accessory/assets/functionfs.py'), 'utf8');
    expect(helper).toContain("Path('/run/yonder/accessory-usb')"); expect(helper).toContain('dir=lock_root');
    expect(helper).toContain('fcntl.LOCK_EX | fcntl.LOCK_NB');
  });
});
