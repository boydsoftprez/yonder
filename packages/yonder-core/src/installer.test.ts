// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DEFAULT_CONSOLE_PATHS } from "./console/settings.js";
import { MEDIA_CONFIG_PATH } from "./media/renderer.js";

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
    expect(role).toMatch(/^ensure_pkgs gstreamer1\.0-rtsp$/m);
  });

  it("asks GStreamer to resolve the element, not dpkg whether a package is there", () => {
    expect(role).toContain("gst-inspect-1.0 rtspclientsink");
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
