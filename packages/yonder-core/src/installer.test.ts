// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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
    expect(exec).toContain("-s /opt/yonder/console/settings.js");
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
