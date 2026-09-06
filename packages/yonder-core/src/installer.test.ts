// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DEFAULT_CONSOLE_PATHS } from "./console/settings.js";
import { ROUTER_CONF_PATH } from "./mav/renderer.js";

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
        YONDER_SYSTEMD_DIRS: opts.systemdDirs ?? join(dir, "no-systemd-here"),
      },
      opts.path,
    );
  }

  const STANZA = "# yonder-uart\nenable_uart=1\ndtoverlay=disable-bt\n";

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
      expect.arrayContaining(["10-base.sh", "20-yonder-core.sh", "30-console.sh", "40-modem.sh", "40-uart.sh", "40-zerotier.sh"]),
    );
  });
});
