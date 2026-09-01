# M1a Network Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the `network:` section of `config.yaml` into a working access point, Wi-Fi client and Ethernet connection — and make the guarantee real that a device can never be configured into unreachability.

**Architecture:** A `NetworkRenderer` implements the `Renderer` interface the apply engine already accepts, so network changes inherit M0's validate → snapshot → apply → confirm-or-revert cycle for free. It drives NetworkManager through `nmcli`'s terse machine-readable mode behind an **injected command runner**, so the entire renderer is unit-testable with no NetworkManager present ([ADR-0006](../../adr/0006-nmcli-not-dbus.md)). A fallback watchdog inside `yonder-core` forces the access point up when nothing else is reachable.

**Tech Stack:** Node 20 · TypeScript · Zod · vitest · `nmcli` (NetworkManager) · POSIX `sh` (installer)

## Global Constraints

- **Licence:** GPL-3.0. Every source file carries `// SPDX-License-Identifier: GPL-3.0-or-later` (`#` form in shell).
- **Commits:** GPG-signed and DCO signed-off. Always `git commit -s`. Never `--no-gpg-sign` — if signing fails, stop and report.
- **Node:** 20.x minimum. TypeScript strict. ESM with `.js` import extensions (NodeNext).
- **Requirements:** cite the `R-*` IDs each task satisfies. Requirements live in `docs/requirements.md`.
- **This repository is self-contained:** no references to paths outside it, no comparison to other products.
- **Nothing shells out except renderers.** All process execution goes through the injected `CommandRunner`. No test may execute `nmcli`.
- **No secret is ever logged.** The renderer logs the commands it runs; PSKs and passwords are redacted in that log.
- **Paths:** config `/etc/yonder/config.yaml`, secrets `/etc/yonder/secrets.yaml`, state `/var/lib/yonder/`, socket `/run/yonder/core.sock`, dnsmasq drop-in `/etc/NetworkManager/dnsmasq-shared.d/yonder.conf`.

## What already exists (M0, on `main`)

- `packages/yonder-core` — ESM, strict TS, vitest, 77 tests.
- `src/schema/config.ts` — `ConfigSchema` (strict), `Config`, `DEFAULT_CONFIG`, `SecretRef`. The `network` section already defines `ap` (ssid, psk as `SecretRef`, address CIDR, dhcp start/end/lease, fallback enabled/timeout), `client` (ssid, psk), `ethernet.dhcp`, and `priority`.
- `src/config/{load,save,errors}.ts` — `loadConfig`, `saveConfig`, `ConfigError`, `formatIssues`.
- `src/secrets/store.ts` — `SecretStore` with `get`, `ensure(name, kind)`, `resolve(ref)`.
- `src/fs/durable.ts` — `writeFileDurable`, `unlinkDurable`, `fsyncDir`. **Use these for every file write.**
- `src/apply/{engine,journal,types}.ts` — `ApplyEngine`, `Renderer`, `Clock`, `systemClock`, `ApplyStatus` with `lastResult`.
- `src/daemon/{server,routes}.ts` — `startServer`, `createRouter`. `startServer` currently passes `renderers: []`.
- `installer/` — POSIX sh role runner, roles `10-base.sh` and `20-yonder-core.sh`.
- `docs/known-issues.md` — **K-02 (no render timeout) is closed by Task 6 of this plan. K-03 (SecretStore shape) is closed by Task 3. K-01 stays open; it belongs to M1b.**

---

## File Structure

```
packages/yonder-core/src/net/
├── runner.ts            CommandRunner interface, systemRunner, redaction
├── nmcli/
│   ├── parse.ts         terse-output parser (escaping-aware)
│   ├── client.ts        typed nmcli operations
│   └── fixtures/        recorded real nmcli output, committed
├── profiles.ts          pure: Config -> desired connection profiles
├── dnsmasq.ts           pure + write: the AP DHCP drop-in
├── renderer.ts          NetworkRenderer implements Renderer
└── watchdog.ts          the access-point fallback
```

**Responsibility boundaries.** `runner` knows how to execute and redact, nothing about networking. `nmcli/` knows NetworkManager's interface and nothing about Yonder's config. `profiles.ts` is pure translation, no I/O, and is where most of the logic — and most of the tests — live. `renderer.ts` only orchestrates. `watchdog.ts` is independent of all of it except the client.

---

## Task 1: Command runner and nmcli terse parser

**Requirements:** groundwork for R-NET-01, R-NET-03, R-NET-04

**Files:**
- Create: `src/net/runner.ts`, `src/net/nmcli/parse.ts`, `src/net/nmcli/parse.test.ts`, `src/net/runner.test.ts`
- Create: `src/net/nmcli/fixtures/device-status.txt`, `src/net/nmcli/fixtures/connection-list.txt`, `src/net/nmcli/fixtures/wifi-scan.txt`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `interface CommandResult { code: number; stdout: string; stderr: string }`
  - `type CommandRunner = (argv: string[]) => Promise<CommandResult>`
  - `const systemRunner: CommandRunner`
  - `redactArgv(argv: string[]): string[]`
  - `parseTerse(stdout: string, fieldCount: number): string[][]`

- [ ] **Step 1: Write the failing tests**

`src/net/nmcli/parse.test.ts`:

```typescript
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTerse } from "./parse.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(here, "fixtures", name), "utf8");

describe("parseTerse", () => {
  it("splits plain records on unescaped colons", () => {
    expect(parseTerse("eth0:ethernet:connected\n", 3)).toEqual([["eth0", "ethernet", "connected"]]);
  });

  it("keeps an escaped colon inside a field", () => {
    // An SSID or a MAC address can legitimately contain a colon; nmcli escapes it.
    expect(parseTerse("wlan0:wifi:AA\\:BB\\:CC\n", 3)).toEqual([["wlan0", "wifi", "AA:BB:CC"]]);
  });

  it("unescapes a literal backslash", () => {
    expect(parseTerse("a\\\\b:x\n", 2)).toEqual([["a\\b", "x"]]);
  });

  it("keeps empty fields", () => {
    expect(parseTerse("eth0::connected\n", 3)).toEqual([["eth0", "", "connected"]]);
  });

  it("ignores blank lines and a trailing newline", () => {
    expect(parseTerse("a:b\n\nc:d\n", 2)).toEqual([["a", "b"], ["c", "d"]]);
  });

  it("returns nothing for empty output", () => {
    expect(parseTerse("", 2)).toEqual([]);
  });

  it("throws when a record has the wrong field count", () => {
    expect(() => parseTerse("a:b:c\n", 2)).toThrow(/expected 2 fields/);
  });

  it("parses recorded device status", () => {
    const rows = parseTerse(fixture("device-status.txt"), 4);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.length === 4)).toBe(true);
    expect(rows.map((r) => r[0])).toContain("wlan0");
  });

  it("parses recorded connection list", () => {
    const rows = parseTerse(fixture("connection-list.txt"), 4);
    expect(rows.every((r) => r.length === 4)).toBe(true);
  });

  it("parses a recorded wifi scan including an SSID containing a colon", () => {
    const rows = parseTerse(fixture("wifi-scan.txt"), 3);
    expect(rows.every((r) => r.length === 3)).toBe(true);
    expect(rows.some((r) => r[0].includes(":"))).toBe(true);
  });
});
```

`src/net/runner.test.ts`:

```typescript
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { redactArgv, systemRunner } from "./runner.js";

describe("redactArgv", () => {
  it("redacts the value after a wifi-security psk key", () => {
    const argv = ["connection", "modify", "Hotspot", "wifi-sec.psk", "hunter2hunter2"];
    expect(redactArgv(argv)).toEqual(["connection", "modify", "Hotspot", "wifi-sec.psk", "<redacted>"]);
  });

  it("redacts every known secret-bearing key", () => {
    for (const key of ["wifi-sec.psk", "802-11-wireless-security.psk", "gsm.password", "password"]) {
      expect(redactArgv(["x", key, "s3cret"])).toEqual(["x", key, "<redacted>"]);
    }
  });

  it("leaves an argv with no secret untouched", () => {
    const argv = ["device", "status"];
    expect(redactArgv(argv)).toEqual(argv);
  });

  it("does not redact a value that merely looks like a key", () => {
    expect(redactArgv(["connection", "show", "psk-test-network"])).toEqual(
      ["connection", "show", "psk-test-network"],
    );
  });
});

describe("systemRunner", () => {
  it("returns stdout and a zero code for a command that succeeds", async () => {
    const r = await systemRunner(["true"]);
    expect(r.code).toBe(0);
  });

  it("returns a non-zero code rather than throwing", async () => {
    const r = await systemRunner(["false"]);
    expect(r.code).not.toBe(0);
  });

  it("returns a non-zero code when the binary does not exist", async () => {
    const r = await systemRunner(["yonder-no-such-binary-exists"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Create the fixtures**

These are recorded real `nmcli` output. Create them by hand with exactly this content — they stand in for output captured from a board, and Task 9 replaces them with output captured from your Pi.

`src/net/nmcli/fixtures/device-status.txt`:

```
eth0:ethernet:connected:Wired connection 1
wlan0:wifi:disconnected:
lo:loopback:unmanaged:
```

`src/net/nmcli/fixtures/connection-list.txt`:

```
Wired connection 1:8f2c1d3e-0000-4000-8000-000000000001:802-3-ethernet:eth0
yonder-ap:8f2c1d3e-0000-4000-8000-000000000002:802-11-wireless:
```

`src/net/nmcli/fixtures/wifi-scan.txt`:

```
HomeNetwork:78:WPA2
Guest\:Wifi:42:WPA2
:31:--
```

The second scan row is the important one: an access point whose SSID contains a colon, which is exactly the case a naive `split(":")` gets wrong. The third has an empty (hidden) SSID.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -w yonder-core`
Expected: FAIL — cannot resolve `./parse.js`.

- [ ] **Step 4: Write the parser and runner**

`src/net/nmcli/parse.ts`:

```typescript
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Parse `nmcli -t` terse output.
 *
 * Terse mode is a machine interface: one record per line, fields separated by
 * a colon, and any colon or backslash inside a value escaped with a backslash.
 * Splitting naively on ":" corrupts SSIDs and MAC addresses, so this walks the
 * string one character at a time.
 */
export function parseTerse(stdout: string, fieldCount: number): string[][] {
  const records: string[][] = [];

  for (const line of stdout.split("\n")) {
    if (line === "") continue;

    const fields: string[] = [];
    let current = "";
    let escaped = false;

    for (const ch of line) {
      if (escaped) {
        current += ch;
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === ":") {
        fields.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
    fields.push(current);

    if (fields.length !== fieldCount) {
      throw new Error(
        `nmcli output: expected ${fieldCount} fields, got ${fields.length} in ${JSON.stringify(line)}`,
      );
    }
    records.push(fields);
  }

  return records;
}
```

`src/net/runner.ts`:

```typescript
// SPDX-License-Identifier: GPL-3.0-or-later
import { execFile } from "node:child_process";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Every process execution in Yonder goes through one of these. Renderers take
 * a runner rather than calling child_process directly, so tests can assert on
 * the exact argv and return canned output without a real NetworkManager.
 */
export type CommandRunner = (argv: string[]) => Promise<CommandResult>;

/** nmcli property names whose following argument is a secret. */
const SECRET_KEYS = new Set([
  "wifi-sec.psk",
  "802-11-wireless-security.psk",
  "wifi-sec.wep-key0",
  "gsm.password",
  "password",
  "ppp.password",
]);

/**
 * The renderer logs what it ran so an operator can reproduce it by hand. That
 * log must never carry a pre-shared key.
 */
export function redactArgv(argv: string[]): string[] {
  const out = [...argv];
  for (let i = 0; i < out.length - 1; i++) {
    if (SECRET_KEYS.has(out[i])) out[i + 1] = "<redacted>";
  }
  return out;
}

/** Never rejects: a non-zero exit is a result, not an exception. */
export const systemRunner: CommandRunner = (argv) =>
  new Promise((resolve) => {
    const [cmd, ...args] = argv;
    execFile(cmd, args, { encoding: "utf8", maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      const code =
        err && typeof (err as NodeJS.ErrnoException & { code?: number }).code === "number"
          ? ((err as unknown as { code: number }).code)
          : err
            ? 127
            : 0;
      resolve({ code, stdout: stdout ?? "", stderr: stderr ?? (err ? String(err.message) : "") });
    });
  });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w yonder-core && npm run lint`
Expected: PASS — 77 existing plus 13 new.

- [ ] **Step 6: Commit**

```bash
git add packages/yonder-core/src/net
git commit -s -m "feat(net): command runner and nmcli terse parser

Terse output escapes colons inside values, so an SSID containing a colon
breaks a naive split. The parser walks characters; a fixture covers the case.

Secrets are redacted from the argv the renderer logs.

ADR-0006"
```

---

## Task 2: nmcli client

**Requirements:** groundwork for R-NET-01, R-NET-03, R-NET-04

**Files:**
- Create: `src/net/nmcli/client.ts`, `src/net/nmcli/client.test.ts`

**Interfaces:**
- Consumes: `CommandRunner`, `parseTerse` (Task 1)
- Produces: `class NmcliClient` with:
  - `constructor(run: CommandRunner, log?: (line: string) => void)`
  - `devices(): Promise<DeviceInfo[]>` — `{ device, type, state, connection }`
  - `connections(): Promise<ConnectionInfo[]>` — `{ name, uuid, type, device }`
  - `scan(iface: string): Promise<AccessPointInfo[]>` — `{ ssid, signal, security }`
  - `addOrModify(name: string, settings: string[][]): Promise<void>`
  - `up(name: string): Promise<void>` · `down(name: string): Promise<void>` · `remove(name: string): Promise<void>`
  - `activeIpv4(): Promise<{ device: string; address: string }[]>`
  - `class NmcliError extends Error` carrying `argv` (redacted) and `stderr`

- [ ] **Step 1: Write the failing test**

`src/net/nmcli/client.test.ts`:

```typescript
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { NmcliClient, NmcliError } from "./client.js";
import type { CommandRunner, CommandResult } from "../runner.js";

function fake(responses: Record<string, CommandResult>): { run: CommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: CommandRunner = async (argv) => {
    calls.push(argv);
    const key = argv.join(" ");
    const hit = responses[key];
    if (hit === undefined) return { code: 0, stdout: "", stderr: "" };
    return hit;
  };
  return { run, calls };
}

const ok = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: "" });

describe("NmcliClient", () => {
  it("lists devices with pinned fields", async () => {
    const { run, calls } = fake({
      "nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device status":
        ok("eth0:ethernet:connected:Wired connection 1\nwlan0:wifi:disconnected:\n"),
    });
    const devices = await new NmcliClient(run).devices();
    expect(devices).toEqual([
      { device: "eth0", type: "ethernet", state: "connected", connection: "Wired connection 1" },
      { device: "wlan0", type: "wifi", state: "disconnected", connection: "" },
    ]);
    expect(calls[0]).toEqual(["nmcli", "-t", "-f", "DEVICE,TYPE,STATE,CONNECTION", "device", "status"]);
  });

  it("lists connections", async () => {
    const { run } = fake({
      "nmcli -t -f NAME,UUID,TYPE,DEVICE connection show":
        ok("yonder-ap:u-1:802-11-wireless:\n"),
    });
    expect(await new NmcliClient(run).connections()).toEqual([
      { name: "yonder-ap", uuid: "u-1", type: "802-11-wireless", device: "" },
    ]);
  });

  it("scans and keeps an SSID containing a colon intact", async () => {
    const { run, calls } = fake({
      "nmcli -t -f SSID,SIGNAL,SECURITY device wifi list ifname wlan0 --rescan yes":
        ok("Guest\\:Wifi:42:WPA2\nHome:78:WPA2\n"),
    });
    const aps = await new NmcliClient(run).scan("wlan0");
    expect(aps[0]).toEqual({ ssid: "Guest:Wifi", signal: 42, security: "WPA2" });
    expect(calls[0]).toContain("--rescan");
  });

  it("drops hidden (empty-SSID) networks from a scan", async () => {
    const { run } = fake({
      "nmcli -t -f SSID,SIGNAL,SECURITY device wifi list ifname wlan0 --rescan yes":
        ok(":31:--\nHome:78:WPA2\n"),
    });
    expect(await new NmcliClient(run).scan("wlan0")).toEqual([
      { ssid: "Home", signal: 78, security: "WPA2" },
    ]);
  });

  it("adds a connection when it does not exist", async () => {
    const { run, calls } = fake({
      "nmcli -t -f NAME,UUID,TYPE,DEVICE connection show": ok(""),
    });
    await new NmcliClient(run).addOrModify("yonder-ap", [
      ["type", "wifi"],
      ["ifname", "wlan0"],
      ["ssid", "yonder"],
    ]);
    const add = calls.find((c) => c[1] === "connection" && c[2] === "add");
    expect(add).toBeDefined();
    expect(add).toContain("con-name");
    expect(add).toContain("yonder-ap");
  });

  it("modifies a connection that already exists rather than adding a duplicate", async () => {
    const { run, calls } = fake({
      "nmcli -t -f NAME,UUID,TYPE,DEVICE connection show":
        ok("yonder-ap:u-1:802-11-wireless:\n"),
    });
    await new NmcliClient(run).addOrModify("yonder-ap", [["ssid", "yonder"]]);
    expect(calls.some((c) => c[2] === "add")).toBe(false);
    const mod = calls.find((c) => c[2] === "modify");
    expect(mod).toEqual(["nmcli", "connection", "modify", "yonder-ap", "ssid", "yonder"]);
  });

  it("throws NmcliError with the redacted argv on a non-zero exit", async () => {
    const { run } = fake({
      "nmcli connection up yonder-ap": { code: 4, stdout: "", stderr: "Error: activation failed" },
    });
    const client = new NmcliClient(run);
    await expect(client.up("yonder-ap")).rejects.toThrow(NmcliError);
    await expect(client.up("yonder-ap")).rejects.toThrow(/activation failed/);
  });

  it("keeps secrets out of the log and out of the error", async () => {
    const lines: string[] = [];
    const { run } = fake({
      "nmcli -t -f NAME,UUID,TYPE,DEVICE connection show": ok("yonder-ap:u-1:802-11-wireless:\n"),
    });
    await new NmcliClient(run, (l) => lines.push(l)).addOrModify("yonder-ap", [
      ["wifi-sec.psk", "hunter2hunter2"],
    ]);
    expect(lines.join("\n")).not.toContain("hunter2hunter2");
    expect(lines.join("\n")).toContain("<redacted>");
  });

  it("reports active IPv4 addresses per device", async () => {
    const { run } = fake({
      "nmcli -t -f DEVICE,IP4.ADDRESS device show":
        ok("eth0:192.168.1.50/24\nwlan0:\n"),
    });
    expect(await new NmcliClient(run).activeIpv4()).toEqual([
      { device: "eth0", address: "192.168.1.50/24" },
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w yonder-core`
Expected: FAIL — cannot resolve `./client.js`.

- [ ] **Step 3: Write the client**

`src/net/nmcli/client.ts`:

```typescript
// SPDX-License-Identifier: GPL-3.0-or-later
import { parseTerse } from "./parse.js";
import { redactArgv, type CommandRunner } from "../runner.js";

export interface DeviceInfo { device: string; type: string; state: string; connection: string }
export interface ConnectionInfo { name: string; uuid: string; type: string; device: string }
export interface AccessPointInfo { ssid: string; signal: number; security: string }

export class NmcliError extends Error {
  readonly argv: string[];
  readonly stderr: string;
  constructor(argv: string[], code: number, stderr: string) {
    super(`nmcli exited ${code}: ${stderr.trim() || "(no stderr)"}\n  ${redactArgv(argv).join(" ")}`);
    this.name = "NmcliError";
    this.argv = redactArgv(argv);
    this.stderr = stderr;
  }
}

export class NmcliClient {
  constructor(
    private readonly run: CommandRunner,
    private readonly log: (line: string) => void = () => {},
  ) {}

  private async exec(argv: string[]): Promise<string> {
    this.log(redactArgv(argv).join(" "));
    const result = await this.run(argv);
    if (result.code !== 0) throw new NmcliError(argv, result.code, result.stderr);
    return result.stdout;
  }

  async devices(): Promise<DeviceInfo[]> {
    const out = await this.exec(["nmcli", "-t", "-f", "DEVICE,TYPE,STATE,CONNECTION", "device", "status"]);
    return parseTerse(out, 4).map(([device, type, state, connection]) => ({ device, type, state, connection }));
  }

  async connections(): Promise<ConnectionInfo[]> {
    const out = await this.exec(["nmcli", "-t", "-f", "NAME,UUID,TYPE,DEVICE", "connection", "show"]);
    return parseTerse(out, 4).map(([name, uuid, type, device]) => ({ name, uuid, type, device }));
  }

  async scan(iface: string): Promise<AccessPointInfo[]> {
    const out = await this.exec([
      "nmcli", "-t", "-f", "SSID,SIGNAL,SECURITY", "device", "wifi", "list",
      "ifname", iface, "--rescan", "yes",
    ]);
    return parseTerse(out, 3)
      .filter(([ssid]) => ssid !== "")
      .map(([ssid, signal, security]) => ({ ssid, signal: Number(signal), security }));
  }

  async activeIpv4(): Promise<{ device: string; address: string }[]> {
    const out = await this.exec(["nmcli", "-t", "-f", "DEVICE,IP4.ADDRESS", "device", "show"]);
    return parseTerse(out, 2)
      .filter(([, address]) => address !== "")
      .map(([device, address]) => ({ device, address }));
  }

  /** Create the connection if absent, otherwise update it in place. Idempotent. */
  async addOrModify(name: string, settings: string[][]): Promise<void> {
    const existing = await this.connections();
    const flat = settings.flat();
    if (existing.some((c) => c.name === name)) {
      await this.exec(["nmcli", "connection", "modify", name, ...flat]);
    } else {
      await this.exec(["nmcli", "connection", "add", "con-name", name, ...flat]);
    }
  }

  async up(name: string): Promise<void> { await this.exec(["nmcli", "connection", "up", name]); }
  async down(name: string): Promise<void> { await this.exec(["nmcli", "connection", "down", name]); }
  async remove(name: string): Promise<void> { await this.exec(["nmcli", "connection", "delete", name]); }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w yonder-core && npm run lint`
Expected: PASS — 9 new tests.

- [ ] **Step 5: Commit**

```bash
git add packages/yonder-core/src/net/nmcli
git commit -s -m "feat(net): typed nmcli client

Every call pins its field list with -f so a distribution shipping a
different default order cannot silently change what is parsed. addOrModify
is idempotent. Secrets never reach the log or the error message.

ADR-0006"
```

---

## Task 3: Config to connection profiles

**Requirements:** R-NET-01, R-NET-03, R-NET-04 · closes **K-03**

This task is pure translation with no I/O, and it is where most of the logic lives.

**Files:**
- Create: `src/net/profiles.ts`, `src/net/profiles.test.ts`
- Modify: `src/secrets/store.ts` (close K-03)

**Interfaces:**
- Consumes: `Config` (M0), `SecretStore`
- Produces:
  - `const AP_CONNECTION = "yonder-ap"`, `CLIENT_CONNECTION = "yonder-wifi"`, `ETHERNET_CONNECTION = "yonder-eth"`
  - `interface DesiredProfile { name: string; settings: string[][]; autoconnect: boolean }`
  - `apProfile(config, psk, iface): DesiredProfile`
  - `clientProfile(config, psk, iface): DesiredProfile | null`
  - `ethernetProfile(config, iface): DesiredProfile`
  - `desiredProfiles(config, secrets, ifaces): DesiredProfile[]`

- [ ] **Step 1: Write the failing test**

`src/net/profiles.test.ts`:

```typescript
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { apProfile, clientProfile, ethernetProfile, AP_CONNECTION, CLIENT_CONNECTION } from "./profiles.js";
import { DEFAULT_CONFIG } from "../schema/config.js";
import type { Config } from "../schema/config.js";

function settingsOf(p: { settings: string[][] }): Record<string, string> {
  return Object.fromEntries(p.settings.map(([k, v]) => [k, v]));
}

describe("apProfile", () => {
  it("declares a wifi access point on the given interface", () => {
    const s = settingsOf(apProfile(DEFAULT_CONFIG, "secretpsk123", "wlan0"));
    expect(s["type"]).toBe("wifi");
    expect(s["ifname"]).toBe("wlan0");
    expect(s["802-11-wireless.mode"]).toBe("ap");
    expect(s["802-11-wireless.ssid"]).toBe("yonder");
  });

  it("uses WPA-PSK with the resolved secret, never a literal from config", () => {
    const s = settingsOf(apProfile(DEFAULT_CONFIG, "secretpsk123", "wlan0"));
    expect(s["802-11-wireless-security.key-mgmt"]).toBe("wpa-psk");
    expect(s["802-11-wireless-security.psk"]).toBe("secretpsk123");
    expect(JSON.stringify(s)).not.toContain("ap_psk");
  });

  it("takes the static address from config and shares the connection", () => {
    const s = settingsOf(apProfile(DEFAULT_CONFIG, "p", "wlan0"));
    expect(s["ipv4.method"]).toBe("shared");
    expect(s["ipv4.addresses"]).toBe("192.168.77.1/24");
  });

  it("honours a changed address and ssid", () => {
    const c: Config = structuredClone(DEFAULT_CONFIG);
    c.network.ap.ssid = "field-unit";
    c.network.ap.address = "10.9.0.1/24";
    const s = settingsOf(apProfile(c, "p", "wlan0"));
    expect(s["802-11-wireless.ssid"]).toBe("field-unit");
    expect(s["ipv4.addresses"]).toBe("10.9.0.1/24");
  });

  it("does not autoconnect: the access point is brought up deliberately", () => {
    expect(apProfile(DEFAULT_CONFIG, "p", "wlan0").autoconnect).toBe(false);
  });

  it("is named consistently", () => {
    expect(apProfile(DEFAULT_CONFIG, "p", "wlan0").name).toBe(AP_CONNECTION);
  });
});

describe("clientProfile", () => {
  it("returns null when no client ssid is configured", () => {
    expect(clientProfile(DEFAULT_CONFIG, null, "wlan0")).toBeNull();
  });

  it("builds an infrastructure profile when an ssid is set", () => {
    const c: Config = structuredClone(DEFAULT_CONFIG);
    c.network.client.ssid = "HomeNetwork";
    c.network.client.psk = { secret: "wifi_psk" };
    const p = clientProfile(c, "homesecret", "wlan0");
    expect(p).not.toBeNull();
    const s = settingsOf(p!);
    expect(p!.name).toBe(CLIENT_CONNECTION);
    expect(s["802-11-wireless.mode"]).toBe("infrastructure");
    expect(s["802-11-wireless.ssid"]).toBe("HomeNetwork");
    expect(s["802-11-wireless-security.psk"]).toBe("homesecret");
    expect(s["ipv4.method"]).toBe("auto");
    expect(p!.autoconnect).toBe(true);
  });

  it("builds an open-network profile when there is no key", () => {
    const c: Config = structuredClone(DEFAULT_CONFIG);
    c.network.client.ssid = "OpenGuest";
    c.network.client.psk = null;
    const s = settingsOf(clientProfile(c, null, "wlan0")!);
    expect(s["802-11-wireless-security.key-mgmt"]).toBeUndefined();
  });

  it("keeps an ssid containing a colon intact", () => {
    const c: Config = structuredClone(DEFAULT_CONFIG);
    c.network.client.ssid = "Guest:Wifi";
    c.network.client.psk = null;
    expect(settingsOf(clientProfile(c, null, "wlan0")!)["802-11-wireless.ssid"]).toBe("Guest:Wifi");
  });
});

describe("ethernetProfile", () => {
  it("uses DHCP by default and autoconnects", () => {
    const p = ethernetProfile(DEFAULT_CONFIG, "eth0");
    const s = settingsOf(p);
    expect(s["type"]).toBe("ethernet");
    expect(s["ifname"]).toBe("eth0");
    expect(s["ipv4.method"]).toBe("auto");
    expect(p.autoconnect).toBe(true);
  });
});
```

Add to `src/secrets/secrets.test.ts`:

```typescript
  it("rejects a secrets file that is not a flat map of strings", () => {
    const p = join(dir, "secrets.yaml");
    writeFileSync(p, "ap_psk:\n  nested: true\n");
    expect(() => new SecretStore(p)).toThrow(/flat map/);
  });
```

(add `writeFileSync` to that file's existing `node:fs` import)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w yonder-core`
Expected: FAIL — cannot resolve `./profiles.js`, and the new secrets test fails.

- [ ] **Step 3: Close K-03 in the secret store**

In `src/secrets/store.ts`, add the import and replace the constructor body's parse:

```typescript
import { z } from "zod";

const BagSchema = z.record(z.string());
```

```typescript
  constructor(path: string) {
    this.path = path;
    if (!existsSync(path)) {
      this.bag = {};
      return;
    }
    const parsed = BagSchema.safeParse(parse(readFileSync(path, "utf8")) ?? {});
    if (!parsed.success) {
      throw new ConfigError(
        `${path} must be a flat map of names to string values`,
        formatIssues(parsed.error),
      );
    }
    this.bag = parsed.data;
  }
```

Import `formatIssues` alongside `ConfigError`. A nested value would otherwise reach a renderer and interpolate as `[object Object]`, producing a broken access point with no error anywhere.

- [ ] **Step 4: Write the profiles**

`src/net/profiles.ts`:

```typescript
// SPDX-License-Identifier: GPL-3.0-or-later
import type { Config } from "../schema/config.js";
import type { SecretStore } from "../secrets/store.js";

export const AP_CONNECTION = "yonder-ap";
export const CLIENT_CONNECTION = "yonder-wifi";
export const ETHERNET_CONNECTION = "yonder-eth";

export interface DesiredProfile {
  name: string;
  settings: string[][];
  autoconnect: boolean;
}

/**
 * The access point. `ipv4.method shared` makes NetworkManager run DHCP and
 * masquerade for clients; the pool itself comes from a dnsmasq drop-in, see
 * dnsmasq.ts. autoconnect is false because the access point is brought up
 * deliberately — by configuration or by the fallback watchdog — never as a
 * side effect of a radio appearing.
 */
export function apProfile(config: Config, psk: string, iface: string): DesiredProfile {
  const ap = config.network.ap;
  return {
    name: AP_CONNECTION,
    autoconnect: false,
    settings: [
      ["type", "wifi"],
      ["ifname", iface],
      ["802-11-wireless.mode", "ap"],
      ["802-11-wireless.ssid", ap.ssid],
      ["802-11-wireless-security.key-mgmt", "wpa-psk"],
      ["802-11-wireless-security.psk", psk],
      ["ipv4.method", "shared"],
      ["ipv4.addresses", ap.address],
      ["connection.autoconnect", "no"],
    ],
  };
}

export function clientProfile(config: Config, psk: string | null, iface: string): DesiredProfile | null {
  const client = config.network.client;
  if (client.ssid === null || client.ssid === "") return null;

  const settings: string[][] = [
    ["type", "wifi"],
    ["ifname", iface],
    ["802-11-wireless.mode", "infrastructure"],
    ["802-11-wireless.ssid", client.ssid],
    ["ipv4.method", "auto"],
    ["connection.autoconnect", "yes"],
  ];
  if (psk !== null) {
    settings.push(["802-11-wireless-security.key-mgmt", "wpa-psk"]);
    settings.push(["802-11-wireless-security.psk", psk]);
  }
  return { name: CLIENT_CONNECTION, autoconnect: true, settings };
}

export function ethernetProfile(config: Config, iface: string): DesiredProfile {
  return {
    name: ETHERNET_CONNECTION,
    autoconnect: true,
    settings: [
      ["type", "ethernet"],
      ["ifname", iface],
      ["ipv4.method", config.network.ethernet.dhcp ? "auto" : "disabled"],
      ["connection.autoconnect", "yes"],
    ],
  };
}

export interface Interfaces {
  wifi: string | null;
  ethernet: string | null;
}

/** Everything the config asks for, for the interfaces this board actually has. */
export function desiredProfiles(config: Config, secrets: SecretStore, ifaces: Interfaces): DesiredProfile[] {
  const out: DesiredProfile[] = [];

  if (ifaces.wifi !== null) {
    out.push(apProfile(config, secrets.resolve(config.network.ap.psk), ifaces.wifi));
    const clientPsk = config.network.client.psk === null ? null : secrets.resolve(config.network.client.psk);
    const client = clientProfile(config, clientPsk, ifaces.wifi);
    if (client !== null) out.push(client);
  }
  if (ifaces.ethernet !== null) {
    out.push(ethernetProfile(config, ifaces.ethernet));
  }
  return out;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w yonder-core && npm run lint`
Expected: PASS — 12 new tests (11 profile, 1 secrets).

- [ ] **Step 6: Commit**

```bash
git add packages/yonder-core/src/net packages/yonder-core/src/secrets
git commit -s -m "feat(net): translate config into NetworkManager profiles

Pure translation, no I/O, so the mapping is exhaustively testable. The PSK
is always the resolved secret and never a config literal.

Also closes K-03: SecretStore now validates that secrets.yaml is a flat map
of strings. A nested value would previously have reached a renderer and
interpolated as [object Object], giving a broken access point silently.

R-NET-01, R-NET-03, R-NET-04"
```

---

## Task 4: The access-point DHCP pool

**Requirements:** R-NET-02

**Files:**
- Create: `src/net/dnsmasq.ts`, `src/net/dnsmasq.test.ts`

**Interfaces:**
- Consumes: `Config`, `writeFileDurable` (M0)
- Produces: `renderDnsmasqConf(config): string`, `writeDnsmasqConf(path, config): void`, `const DNSMASQ_DROPIN = "/etc/NetworkManager/dnsmasq-shared.d/yonder.conf"`

`ipv4.method shared` gives NetworkManager's own dnsmasq. Its pool is configured by a drop-in rather than by a separate dnsmasq service, so there is one fewer daemon to supervise.

- [ ] **Step 1: Write the failing test**

`src/net/dnsmasq.test.ts`:

```typescript
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderDnsmasqConf, writeDnsmasqConf } from "./dnsmasq.js";
import { DEFAULT_CONFIG } from "../schema/config.js";
import type { Config } from "../schema/config.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "yonder-dns-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("renderDnsmasqConf", () => {
  it("emits the configured pool and lease", () => {
    expect(renderDnsmasqConf(DEFAULT_CONFIG))
      .toContain("dhcp-range=192.168.77.2,192.168.77.50,12h");
  });

  it("follows a changed pool", () => {
    const c: Config = structuredClone(DEFAULT_CONFIG);
    c.network.ap.dhcp = { start: "10.9.0.10", end: "10.9.0.20", lease: "1h" };
    expect(renderDnsmasqConf(c)).toContain("dhcp-range=10.9.0.10,10.9.0.20,1h");
  });

  it("is authoritative, so a client with a stale lease is corrected", () => {
    expect(renderDnsmasqConf(DEFAULT_CONFIG)).toContain("dhcp-authoritative");
  });

  it("carries a header saying it is generated", () => {
    expect(renderDnsmasqConf(DEFAULT_CONFIG)).toMatch(/^#/);
    expect(renderDnsmasqConf(DEFAULT_CONFIG)).toContain("config.yaml");
  });

  it("is deterministic", () => {
    expect(renderDnsmasqConf(DEFAULT_CONFIG)).toBe(renderDnsmasqConf(DEFAULT_CONFIG));
  });
});

describe("writeDnsmasqConf", () => {
  it("writes the file world-readable and creates missing parents", () => {
    const p = join(dir, "dnsmasq-shared.d", "yonder.conf");
    writeDnsmasqConf(p, DEFAULT_CONFIG);
    expect(readFileSync(p, "utf8")).toContain("dhcp-range=");
    expect(statSync(p).mode & 0o777).toBe(0o644);
  });

  it("overwrites cleanly when the pool changes", () => {
    const p = join(dir, "yonder.conf");
    writeDnsmasqConf(p, DEFAULT_CONFIG);
    const c: Config = structuredClone(DEFAULT_CONFIG);
    c.network.ap.dhcp.end = "192.168.77.99";
    writeDnsmasqConf(p, c);
    const text = readFileSync(p, "utf8");
    expect(text).toContain("192.168.77.99");
    expect(text).not.toContain("192.168.77.50");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w yonder-core`
Expected: FAIL — cannot resolve `./dnsmasq.js`.

- [ ] **Step 3: Write it**

`src/net/dnsmasq.ts`:

```typescript
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileDurable } from "../fs/durable.js";
import type { Config } from "../schema/config.js";

export const DNSMASQ_DROPIN = "/etc/NetworkManager/dnsmasq-shared.d/yonder.conf";

/**
 * NetworkManager's `shared` method runs its own dnsmasq for the access point.
 * This drop-in sets the pool. One fewer daemon than a standalone dnsmasq, and
 * NetworkManager owns the lifecycle.
 */
export function renderDnsmasqConf(config: Config): string {
  const { start, end, lease } = config.network.ap.dhcp;
  return [
    "# Generated by yonder-core from /etc/yonder/config.yaml.",
    "# Edits here are overwritten on the next apply.",
    `dhcp-range=${start},${end},${lease}`,
    "dhcp-authoritative",
    "",
  ].join("\n");
}

export function writeDnsmasqConf(path: string, config: Config): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileDurable(path, renderDnsmasqConf(config), 0o644);
}
```

If `writeFileDurable`'s signature differs from `(path, contents, mode)`, adapt the call rather than the helper, and note it in your report.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w yonder-core && npm run lint`
Expected: PASS — 7 new tests.

- [ ] **Step 5: Commit**

```bash
git add packages/yonder-core/src/net/dnsmasq.ts packages/yonder-core/src/net/dnsmasq.test.ts
git commit -s -m "feat(net): DHCP pool for the access point

NetworkManager's shared method runs its own dnsmasq; a drop-in sets the
pool. One fewer daemon than a standalone dnsmasq.

R-NET-02"
```

---

## Task 5: The network renderer

**Requirements:** R-NET-01, R-NET-02, R-NET-03, R-NET-04

**Files:**
- Create: `src/net/renderer.ts`, `src/net/renderer.test.ts`

**Interfaces:**
- Consumes: `NmcliClient`, `desiredProfiles`, `writeDnsmasqConf`, `SecretStore`, `Renderer` (M0)
- Produces: `class NetworkRenderer implements Renderer` with `constructor(opts: { client, secrets, dnsmasqPath?, log? })` and `render(config)`

- [ ] **Step 1: Write the failing test**

`src/net/renderer.test.ts`:

```typescript
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NetworkRenderer } from "./renderer.js";
import { NmcliClient } from "./nmcli/client.js";
import { SecretStore } from "../secrets/store.js";
import { AP_CONNECTION, CLIENT_CONNECTION, ETHERNET_CONNECTION } from "./profiles.js";
import { DEFAULT_CONFIG } from "../schema/config.js";
import type { Config } from "../schema/config.js";
import type { CommandRunner, CommandResult } from "./runner.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "yonder-rend-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });

const DEVICES = "eth0:ethernet:connected:yonder-eth\nwlan0:wifi:disconnected:\nlo:loopback:unmanaged:\n";

function harness(overrides: Record<string, CommandResult> = {}) {
  const calls: string[][] = [];
  const responses: Record<string, CommandResult> = {
    "nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device status": ok(DEVICES),
    "nmcli -t -f NAME,UUID,TYPE,DEVICE connection show": ok(""),
    ...overrides,
  };
  const run: CommandRunner = async (argv) => {
    calls.push(argv);
    return responses[argv.join(" ")] ?? ok();
  };
  const secrets = new SecretStore(join(dir, "secrets.yaml"));
  secrets.ensure("ap_psk", "psk");
  const renderer = new NetworkRenderer({
    client: new NmcliClient(run),
    secrets,
    dnsmasqPath: join(dir, "yonder.conf"),
  });
  return { renderer, calls, secrets };
}

const argvOf = (calls: string[][], verb: string, name: string) =>
  calls.find((c) => c[1] === "connection" && c[2] === verb && c[3] === name);

describe("NetworkRenderer", () => {
  it("creates the access point and the ethernet profile", async () => {
    const { renderer, calls } = harness();
    await renderer.render(DEFAULT_CONFIG);
    expect(argvOf(calls, "add", undefined as never) ?? calls.some((c) => c.includes(AP_CONNECTION))).toBeTruthy();
    expect(calls.some((c) => c.includes(AP_CONNECTION))).toBe(true);
    expect(calls.some((c) => c.includes(ETHERNET_CONNECTION))).toBe(true);
  });

  it("writes the DHCP drop-in", async () => {
    const { renderer } = harness();
    await renderer.render(DEFAULT_CONFIG);
    expect(existsSync(join(dir, "yonder.conf"))).toBe(true);
    expect(readFileSync(join(dir, "yonder.conf"), "utf8")).toContain("dhcp-range=");
  });

  it("does not create a client profile when no ssid is configured", async () => {
    const { renderer, calls } = harness();
    await renderer.render(DEFAULT_CONFIG);
    expect(calls.some((c) => c.includes(CLIENT_CONNECTION))).toBe(false);
  });

  it("creates a client profile when an ssid is configured", async () => {
    const { renderer, calls, secrets } = harness();
    secrets.ensure("wifi_psk", "psk");
    const c: Config = structuredClone(DEFAULT_CONFIG);
    c.network.client.ssid = "HomeNetwork";
    c.network.client.psk = { secret: "wifi_psk" };
    await renderer.render(c);
    expect(calls.some((c2) => c2.includes(CLIENT_CONNECTION))).toBe(true);
  });

  it("removes a client profile that config no longer asks for", async () => {
    const { renderer, calls } = harness({
      "nmcli -t -f NAME,UUID,TYPE,DEVICE connection show":
        ok(`${CLIENT_CONNECTION}:u-2:802-11-wireless:wlan0\n`),
    });
    await renderer.render(DEFAULT_CONFIG);
    expect(argvOf(calls, "delete", CLIENT_CONNECTION)).toBeDefined();
  });

  it("never deletes a connection it does not own", async () => {
    const { renderer, calls } = harness({
      "nmcli -t -f NAME,UUID,TYPE,DEVICE connection show":
        ok("Wired connection 1:u-9:802-3-ethernet:eth0\n"),
    });
    await renderer.render(DEFAULT_CONFIG);
    expect(calls.some((c) => c[2] === "delete")).toBe(false);
  });

  it("brings the access point up when it is enabled", async () => {
    const { renderer, calls } = harness();
    await renderer.render(DEFAULT_CONFIG);
    expect(argvOf(calls, "up", AP_CONNECTION)).toBeDefined();
  });

  it("takes the access point down when config disables it", async () => {
    const { renderer, calls } = harness({
      "nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device status":
        ok(`eth0:ethernet:connected:yonder-eth\nwlan0:wifi:connected:${AP_CONNECTION}\n`),
    });
    const c: Config = structuredClone(DEFAULT_CONFIG);
    c.network.ap.enabled = false;
    await renderer.render(c);
    expect(argvOf(calls, "down", AP_CONNECTION)).toBeDefined();
  });

  it("skips wifi entirely on a board with no wifi device", async () => {
    const { renderer, calls } = harness({
      "nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device status":
        ok("eth0:ethernet:connected:yonder-eth\nlo:loopback:unmanaged:\n"),
    });
    await renderer.render(DEFAULT_CONFIG);
    expect(calls.some((c) => c.includes(AP_CONNECTION))).toBe(false);
    expect(calls.some((c) => c.includes(ETHERNET_CONNECTION))).toBe(true);
  });

  it("rejects when nmcli fails, so the apply engine rolls back", async () => {
    const { renderer } = harness({
      "nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device status":
        { code: 1, stdout: "", stderr: "NetworkManager is not running" },
    });
    await expect(renderer.render(DEFAULT_CONFIG)).rejects.toThrow(/not running/);
  });

  it("is idempotent: a second render of the same config adds nothing", async () => {
    const { renderer, calls } = harness({
      "nmcli -t -f NAME,UUID,TYPE,DEVICE connection show":
        ok(`${AP_CONNECTION}:u-1:802-11-wireless:\n${ETHERNET_CONNECTION}:u-3:802-3-ethernet:eth0\n`),
    });
    await renderer.render(DEFAULT_CONFIG);
    expect(calls.some((c) => c[2] === "add")).toBe(false);
    expect(calls.some((c) => c[2] === "modify")).toBe(true);
  });

  it("keeps the pre-shared key out of its log", async () => {
    const lines: string[] = [];
    const calls: string[][] = [];
    const run: CommandRunner = async (argv) => {
      calls.push(argv);
      if (argv.join(" ") === "nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device status") return ok(DEVICES);
      return ok();
    };
    const secrets = new SecretStore(join(dir, "s.yaml"));
    const psk = secrets.ensure("ap_psk", "psk").value;
    const renderer = new NetworkRenderer({
      client: new NmcliClient(run, (l) => lines.push(l)),
      secrets,
      dnsmasqPath: join(dir, "y.conf"),
      log: (l) => lines.push(l),
    });
    await renderer.render(DEFAULT_CONFIG);
    expect(lines.join("\n")).not.toContain(psk);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w yonder-core`
Expected: FAIL — cannot resolve `./renderer.js`.

- [ ] **Step 3: Write the renderer**

`src/net/renderer.ts`:

```typescript
// SPDX-License-Identifier: GPL-3.0-or-later
import type { Renderer } from "../apply/types.js";
import type { Config } from "../schema/config.js";
import type { SecretStore } from "../secrets/store.js";
import { NmcliClient } from "./nmcli/client.js";
import { writeDnsmasqConf, DNSMASQ_DROPIN } from "./dnsmasq.js";
import {
  desiredProfiles, AP_CONNECTION, CLIENT_CONNECTION, ETHERNET_CONNECTION,
  type Interfaces,
} from "./profiles.js";

/** The only connection names this renderer will ever create or delete. */
const OWNED = new Set([AP_CONNECTION, CLIENT_CONNECTION, ETHERNET_CONNECTION]);

export interface NetworkRendererOptions {
  client: NmcliClient;
  secrets: SecretStore;
  dnsmasqPath?: string;
  log?: (line: string) => void;
}

export class NetworkRenderer implements Renderer {
  readonly name = "network";
  private readonly client: NmcliClient;
  private readonly secrets: SecretStore;
  private readonly dnsmasqPath: string;
  private readonly log: (line: string) => void;

  constructor(opts: NetworkRendererOptions) {
    this.client = opts.client;
    this.secrets = opts.secrets;
    this.dnsmasqPath = opts.dnsmasqPath ?? DNSMASQ_DROPIN;
    this.log = opts.log ?? (() => {});
  }

  async render(config: Config): Promise<void> {
    const devices = await this.client.devices();
    const ifaces: Interfaces = {
      wifi: devices.find((d) => d.type === "wifi")?.device ?? null,
      ethernet: devices.find((d) => d.type === "ethernet")?.device ?? null,
    };
    this.log(`network: wifi=${ifaces.wifi ?? "none"} ethernet=${ifaces.ethernet ?? "none"}`);

    const desired = desiredProfiles(config, this.secrets, ifaces);
    const wanted = new Set(desired.map((p) => p.name));

    // Remove only what we own and no longer want. A connection created by
    // someone else is never touched.
    for (const existing of await this.client.connections()) {
      if (OWNED.has(existing.name) && !wanted.has(existing.name)) {
        this.log(`network: removing ${existing.name}`);
        await this.client.remove(existing.name);
      }
    }

    for (const profile of desired) {
      await this.client.addOrModify(profile.name, profile.settings);
    }

    if (ifaces.wifi !== null) {
      writeDnsmasqConf(this.dnsmasqPath, config);
    }

    // The access point is brought up or taken down deliberately; everything
    // else autoconnects.
    if (ifaces.wifi !== null) {
      const apActive = devices.some((d) => d.connection === AP_CONNECTION);
      if (config.network.ap.enabled && !apActive) {
        this.log("network: bringing the access point up");
        await this.client.up(AP_CONNECTION);
      } else if (!config.network.ap.enabled && apActive) {
        this.log("network: taking the access point down");
        await this.client.down(AP_CONNECTION);
      }
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w yonder-core && npm run lint`
Expected: PASS — 12 new tests.

- [ ] **Step 5: Commit**

```bash
git add packages/yonder-core/src/net/renderer.ts packages/yonder-core/src/net/renderer.test.ts
git commit -s -m "feat(net): network renderer

Implements the Renderer interface, so network changes inherit the apply
engine's confirm-or-revert cycle. Only ever creates or deletes the three
connections it owns; a profile made by someone else is never touched.
Idempotent, and skips wifi entirely on a board with no radio.

R-NET-01, R-NET-02, R-NET-03, R-NET-04"
```

---

## Task 6: Render timeout in the apply engine

**Requirements:** R-CFG-03 · closes **K-02**

A renderer that throws is already handled. A renderer that **never settles** currently pins the engine in `applying` forever, and every later apply is refused. Until now there were no renderers, so it could not happen. Task 5 just added one that talks to a daemon which can wedge.

**Files:**
- Modify: `src/apply/engine.ts`, `src/apply/engine.test.ts`
- Modify: `docs/known-issues.md` (remove K-02)

**Interfaces:**
- Consumes: existing `ApplyEngineOptions`
- Produces: `ApplyEngineOptions.renderTimeoutMs?: number` (default 60000)

- [ ] **Step 1: Write the failing test**

Add to `src/apply/engine.test.ts`:

```typescript
  it("fails the apply and rolls back when a renderer never settles", async () => {
    const { clock, advance } = fakeClock();
    const hung: Renderer = { name: "hung", render: () => new Promise(() => {}) };
    const e = new ApplyEngine({
      configPath, journalPath, renderers: [hung], clock, renderTimeoutMs: 60_000,
    });
    const applying = e.apply(changed());
    advance(61_000);
    await expect(applying).rejects.toThrow(/timed out/i);
    expect(loadConfig(configPath).system.hostname).toBe("yonder");
    expect(e.status().state).toBe("idle");
  });

  it("accepts a later apply after a render timed out", async () => {
    const { clock, advance } = fakeClock();
    let hang = true;
    const sometimes: Renderer = {
      name: "sometimes",
      render: () => (hang ? new Promise<void>(() => {}) : Promise.resolve()),
    };
    const e = new ApplyEngine({
      configPath, journalPath, renderers: [sometimes], clock, renderTimeoutMs: 60_000,
    });
    const first = e.apply(changed());
    advance(61_000);
    await expect(first).rejects.toThrow(/timed out/i);
    hang = false;
    await expect(e.apply(changed())).resolves.toHaveProperty("id");
  });

  it("records a timed-out apply as failed in lastResult", async () => {
    const { clock, advance } = fakeClock();
    const hung: Renderer = { name: "hung", render: () => new Promise(() => {}) };
    const e = new ApplyEngine({
      configPath, journalPath, renderers: [hung], clock, renderTimeoutMs: 60_000,
    });
    const applying = e.apply(changed());
    advance(61_000);
    await applying.catch(() => {});
    expect(e.status().lastResult?.outcome).toBe("failed");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w yonder-core`
Expected: FAIL — the first test hangs or times out rather than rejecting.

- [ ] **Step 3: Add the timeout**

In `src/apply/engine.ts`:

- Add `renderTimeoutMs?: number` to `ApplyEngineOptions`; store `this.renderTimeoutMs = opts.renderTimeoutMs ?? 60_000`.
- Add a private helper that races each render against the injected clock:

```typescript
  /**
   * A renderer that throws is a failure we already handle. A renderer that
   * never returns would otherwise hold the reservation for ever, refusing
   * every later apply with "already pending". Time comes from the injected
   * clock so this is testable without waiting.
   */
  private withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const timer = this.clock.setTimer(ms, () => {
        if (settled) return;
        settled = true;
        reject(new ConfigError(`${what} timed out after ${ms} ms`));
      });
      work.then(
        (value) => { if (!settled) { settled = true; this.clock.clearTimer(timer); resolve(value); } },
        (err) => { if (!settled) { settled = true; this.clock.clearTimer(timer); reject(err); } },
      );
    });
  }
```

- Wrap each renderer call in `renderAll`:

```typescript
  private async renderAll(config: Config): Promise<void> {
    for (const r of this.renderers) {
      await this.withTimeout(r.render(config), this.renderTimeoutMs, `renderer "${r.name}"`);
    }
  }
```

The existing `catch` in `apply()` already rolls back and releases the reservation on a rejection, so a timeout takes the same path as a throw. Confirm that `finish()` still runs in its `finally`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w yonder-core && npm run lint`
Expected: PASS — 3 new tests.

- [ ] **Step 5: Remove K-02 from known issues**

Delete the whole `### K-02 · apply() has no render timeout` section from `docs/known-issues.md`. Leave K-01 and K-03 headings unrenumbered — IDs are stable.

- [ ] **Step 6: Commit**

```bash
git add packages/yonder-core/src/apply docs/known-issues.md
git commit -s -m "fix(core): time out a renderer that never settles

A renderer that throws was handled; one that hangs held the apply
reservation for ever and refused every later apply. Harmless while there
were no renderers; the network renderer talks to a daemon that can wedge.

Closes K-02. R-CFG-03"
```

---

## Task 7: The access-point fallback watchdog

**Requirements:** R-NET-07 — the guarantee that a device never becomes unreachable

**Files:**
- Create: `src/net/watchdog.ts`, `src/net/watchdog.test.ts`

**Interpretation of the requirement, stated so it is a decision and not a drift.** R-NET-07 says "if no configured network *carries traffic* within 90 seconds of boot, bring up the access point regardless of configuration." Byte counters are the wrong test: a connected but idle Ethernet link carries no traffic and is perfectly reachable, and would trigger a spurious fallback. The guarantee's purpose is *"you can still reach me."* So the implemented test is **no non-access-point interface holds an active connection with an IPv4 address**. Record this in the report; if a future requirement needs true traffic accounting, it gets its own ID.

**Interfaces:**
- Consumes: `NmcliClient`, `Clock`, `Config`
- Produces: `class FallbackWatchdog` with `constructor(opts: { client, clock, config, apUp, log? })`, `start()`, `stop()`, `check(): Promise<boolean>`

- [ ] **Step 1: Write the failing test**

`src/net/watchdog.test.ts`:

```typescript
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { FallbackWatchdog } from "./watchdog.js";
import { NmcliClient } from "./nmcli/client.js";
import { DEFAULT_CONFIG } from "../schema/config.js";
import type { Config } from "../schema/config.js";
import type { Clock } from "../apply/types.js";
import type { CommandRunner, CommandResult } from "./runner.js";

const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });

function fakeClock() {
  let t = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let next = 1;
  const clock: Clock = {
    now: () => t,
    setTimer: (ms, fn) => { const h = next++; timers.set(h, { at: t + ms, fn }); return h; },
    clearTimer: (h) => { timers.delete(h as number); },
  };
  return {
    clock,
    advance(ms: number) {
      t += ms;
      for (const [h, timer] of [...timers]) if (timer.at <= t) { timers.delete(h); timer.fn(); }
    },
  };
}

function harness(deviceShow: string, config: Config = DEFAULT_CONFIG) {
  const { clock, advance } = fakeClock();
  const run: CommandRunner = async (argv) =>
    argv.join(" ") === "nmcli -t -f DEVICE,IP4.ADDRESS device show" ? ok(deviceShow) : ok();
  let raised = 0;
  const wd = new FallbackWatchdog({
    client: new NmcliClient(run),
    clock,
    config,
    apUp: async () => { raised++; },
  });
  return { wd, advance, raised: () => raised };
}

describe("FallbackWatchdog", () => {
  it("raises the access point when nothing is reachable at the deadline", async () => {
    const { wd, advance, raised } = harness("eth0:\nwlan0:\n");
    wd.start();
    advance(90_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(raised()).toBe(1);
  });

  it("does not raise it when an interface has an address", async () => {
    const { wd, advance, raised } = harness("eth0:192.168.1.50/24\nwlan0:\n");
    wd.start();
    advance(90_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(raised()).toBe(0);
  });

  it("does not raise it before the deadline", async () => {
    const { wd, advance, raised } = harness("eth0:\n");
    wd.start();
    advance(89_000);
    await Promise.resolve();
    expect(raised()).toBe(0);
  });

  it("ignores the access point's own address when deciding", async () => {
    // 192.168.77.1 is the access point itself; its presence must not count
    // as "we are reachable", or the fallback could never fire twice.
    const { wd, advance, raised } = harness("wlan0:192.168.77.1/24\n");
    wd.start();
    advance(90_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(raised()).toBe(1);
  });

  it("ignores loopback", async () => {
    const { wd, advance, raised } = harness("lo:127.0.0.1/8\neth0:\n");
    wd.start();
    advance(90_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(raised()).toBe(1);
  });

  it("honours a configured timeout other than the default", async () => {
    const c: Config = structuredClone(DEFAULT_CONFIG);
    c.network.ap.fallback.timeout = 120;
    const { wd, advance, raised } = harness("eth0:\n", c);
    wd.start();
    advance(90_000);
    await Promise.resolve();
    expect(raised()).toBe(0);
    advance(31_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(raised()).toBe(1);
  });

  it("does nothing at all when the fallback is disabled", async () => {
    const c: Config = structuredClone(DEFAULT_CONFIG);
    c.network.ap.fallback.enabled = false;
    const { wd, advance, raised } = harness("eth0:\n", c);
    wd.start();
    advance(200_000);
    await Promise.resolve();
    expect(raised()).toBe(0);
  });

  it("stop() cancels a pending check", async () => {
    const { wd, advance, raised } = harness("eth0:\n");
    wd.start();
    wd.stop();
    advance(200_000);
    await Promise.resolve();
    expect(raised()).toBe(0);
  });

  it("raises the access point even when nmcli fails, rather than assuming reachability", async () => {
    const { clock, advance } = fakeClock();
    const run: CommandRunner = async () => ({ code: 1, stdout: "", stderr: "NetworkManager is not running" });
    let raised = 0;
    const wd = new FallbackWatchdog({
      client: new NmcliClient(run), clock, config: DEFAULT_CONFIG,
      apUp: async () => { raised++; },
    });
    wd.start();
    advance(90_000);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(raised).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w yonder-core`
Expected: FAIL — cannot resolve `./watchdog.js`.

- [ ] **Step 3: Write the watchdog**

`src/net/watchdog.ts`:

```typescript
// SPDX-License-Identifier: GPL-3.0-or-later
import type { Clock } from "../apply/types.js";
import type { Config } from "../schema/config.js";
import { NmcliClient } from "./nmcli/client.js";

export interface FallbackWatchdogOptions {
  client: NmcliClient;
  clock: Clock;
  config: Config;
  apUp: () => Promise<void>;
  log?: (line: string) => void;
}

/**
 * The guarantee that a device can never be configured into unreachability.
 *
 * R-NET-07 is written as "carries traffic". Byte counters are the wrong
 * test — a connected but idle Ethernet link carries none and is perfectly
 * reachable — so the implemented test is "no interface other than the access
 * point itself holds an IPv4 address". That is what "you can still reach me"
 * actually means.
 *
 * On any doubt, including nmcli failing outright, the access point comes up.
 * A spurious access point costs an operator nothing; a missing one costs a
 * card reader and a trip to wherever the aircraft is.
 */
export class FallbackWatchdog {
  private readonly opts: FallbackWatchdogOptions;
  private readonly log: (line: string) => void;
  private timer: unknown;

  constructor(opts: FallbackWatchdogOptions) {
    this.opts = opts;
    this.log = opts.log ?? (() => {});
  }

  start(): void {
    const fallback = this.opts.config.network.ap.fallback;
    if (!fallback.enabled) {
      this.log("fallback: disabled by configuration");
      return;
    }
    const ms = fallback.timeout * 1000;
    this.log(`fallback: will check for a reachable interface in ${fallback.timeout} s`);
    this.timer = this.opts.clock.setTimer(ms, () => { void this.fire(); });
  }

  stop(): void {
    if (this.timer !== undefined) {
      this.opts.clock.clearTimer(this.timer);
      this.timer = undefined;
    }
  }

  /** True when some interface other than the access point holds an address. */
  async check(): Promise<boolean> {
    const apAddress = this.opts.config.network.ap.address.split("/")[0];
    try {
      const active = await this.opts.client.activeIpv4();
      return active.some(
        (a) =>
          a.device !== "lo" &&
          !a.address.startsWith("127.") &&
          a.address.split("/")[0] !== apAddress,
      );
    } catch (e) {
      this.log(`fallback: cannot determine reachability (${(e as Error).message}); assuming none`);
      return false;
    }
  }

  private async fire(): Promise<void> {
    this.timer = undefined;
    if (await this.check()) {
      this.log("fallback: an interface is reachable, leaving the access point alone");
      return;
    }
    this.log("fallback: nothing reachable, bringing the access point up");
    try {
      await this.opts.apUp();
    } catch (e) {
      this.log(`fallback: could not bring the access point up: ${(e as Error).message}`);
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w yonder-core && npm run lint`
Expected: PASS — 9 new tests.

- [ ] **Step 5: Commit**

```bash
git add packages/yonder-core/src/net/watchdog.ts packages/yonder-core/src/net/watchdog.test.ts
git commit -s -m "feat(net): access-point fallback watchdog

If nothing is reachable at the deadline, the access point comes up
regardless of configuration. Reachability is 'some interface other than the
access point holds an address', not byte counters — an idle Ethernet link
carries no traffic and is perfectly reachable.

On any doubt, including nmcli failing, the access point comes up. A
spurious access point costs nothing; a missing one costs a card reader.

R-NET-07"
```

---

## Task 8: Wire it into the daemon and the installer

**Requirements:** R-NET-01 … R-NET-04, R-NET-07

**Files:**
- Modify: `src/daemon/server.ts`, `src/index.ts`
- Create: `src/daemon/server.wiring.test.ts`
- Modify: `installer/roles/10-base.sh`, `installer/roles/20-yonder-core.sh`, `systemd/yonder-core.service`

**Interfaces:**
- Consumes: everything above
- Produces: `startServer` gains `secretsPath?`, constructs a `NetworkRenderer` and a `FallbackWatchdog`, and returns `{ close }` unchanged

- [ ] **Step 1: Write the failing test**

`src/daemon/server.wiring.test.ts`:

```typescript
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRenderers } from "./server.js";
import { saveConfig } from "../config/save.js";
import { DEFAULT_CONFIG } from "../schema/config.js";
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
      dnsmasqPath: join(dir, "y.conf"),
      runner: run,
    });
    expect(renderers.map((r) => r.name)).toEqual(["network"]);
  });

  it("generates the access-point secret if it is absent", () => {
    const secretsPath = join(dir, "secrets.yaml");
    const run: CommandRunner = async () => ({ code: 0, stdout: "", stderr: "" });
    const { secrets, generated } = buildRenderers({
      secretsPath, dnsmasqPath: join(dir, "y.conf"), runner: run,
    });
    expect(secrets.get("ap_psk")).toBeTruthy();
    expect(generated).toContain("ap_psk");
  });

  it("does not regenerate a secret that already exists", () => {
    const secretsPath = join(dir, "secrets.yaml");
    const run: CommandRunner = async () => ({ code: 0, stdout: "", stderr: "" });
    const first = buildRenderers({ secretsPath, dnsmasqPath: join(dir, "y.conf"), runner: run });
    const value = first.secrets.get("ap_psk");
    const second = buildRenderers({ secretsPath, dnsmasqPath: join(dir, "y.conf"), runner: run });
    expect(second.secrets.get("ap_psk")).toBe(value);
    expect(second.generated).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w yonder-core`
Expected: FAIL — `buildRenderers` is not exported.

- [ ] **Step 3: Wire the daemon**

In `src/daemon/server.ts`, add and export:

```typescript
export interface BuildRenderersOptions {
  secretsPath: string;
  dnsmasqPath?: string;
  runner?: CommandRunner;
  log?: (line: string) => void;
}

/**
 * Assemble the renderers and make sure every secret the config references
 * exists. Secrets created here are reported so the caller can display them
 * once — a per-device access-point password is no use if nobody ever sees it.
 */
export function buildRenderers(opts: BuildRenderersOptions): {
  renderers: Renderer[];
  secrets: SecretStore;
  client: NmcliClient;
  generated: string[];
} {
  const log = opts.log ?? ((l: string) => process.stdout.write(`${l}\n`));
  const secrets = new SecretStore(opts.secretsPath);
  const generated: string[] = [];
  for (const [name, kind] of [["ap_psk", "psk"], ["editor_password", "password"]] as const) {
    if (secrets.ensure(name, kind).created) generated.push(name);
  }
  const client = new NmcliClient(opts.runner ?? systemRunner, log);
  const renderer = new NetworkRenderer({
    client, secrets, dnsmasqPath: opts.dnsmasqPath, log,
  });
  return { renderers: [renderer], secrets, client, generated };
}
```

In `startServer`, accept `secretsPath` (default `/etc/yonder/secrets.yaml`), call `buildRenderers`, pass `renderers` to the `ApplyEngine`, and after `recover()` start the watchdog:

```typescript
  const { renderers, secrets, client, generated } = buildRenderers({
    secretsPath: opts.secretsPath ?? "/etc/yonder/secrets.yaml",
  });
  for (const name of generated) {
    process.stdout.write(`generated ${name}: ${secrets.get(name)}\n`);
  }
```

```typescript
  // Started after recover() so a rolled-back config is the one it judges.
  const watchdog = new FallbackWatchdog({
    client,
    clock: systemClock,
    config: loadConfig(opts.configPath),
    apUp: () => client.up(AP_CONNECTION),
    log: (l) => process.stdout.write(`${l}\n`),
  });
  watchdog.start();
```

Have `close()` call `watchdog.stop()` before closing the server. Export the new `net/` modules from `src/index.ts`.

- [ ] **Step 4: Update the installer**

In `installer/roles/10-base.sh`, add NetworkManager and the drop-in directory:

```sh
ensure_pkgs network-manager
ensure_dir /etc/NetworkManager/dnsmasq-shared.d 0755
```

In `systemd/yonder-core.service`, add to `[Unit]`:

```ini
After=local-fs.target NetworkManager.service
Wants=NetworkManager.service
```

and to `[Service]`:

```ini
ReadWritePaths=/etc/yonder /var/lib/yonder /etc/NetworkManager/dnsmasq-shared.d
```

Keep `Before=network-pre.target` only if it does not conflict with `After=NetworkManager.service`; if it does, drop `Before=network-pre.target` and say so in the report.

- [ ] **Step 5: Run everything**

Run: `npm test -w yonder-core && npm run lint && npm run build -w yonder-core`
Run: `./installer/install.sh --dry-run && shellcheck installer/install.sh installer/lib/*.sh installer/roles/*.sh`
Expected: all clean; 3 new tests.

- [ ] **Step 6: Commit**

```bash
git add packages/yonder-core/src installer systemd
git commit -s -m "feat(net): wire the network renderer and fallback into the daemon

The daemon now assembles a network renderer, ensures every secret the
config references exists, prints newly generated secrets once, and starts
the fallback watchdog after recovery so it judges the rolled-back config.

R-NET-01, R-NET-02, R-NET-03, R-NET-04, R-NET-07"
```

---

## Task 9: Verify it on the board

**Requirements:** the M1a exit criterion

This is the task that cannot be faked. Everything above is unit-tested against a fake `nmcli`; this proves the real thing works on real hardware.

**Files:**
- Create: `docs/hardware/verifying-m1a.md`
- Modify: `src/net/nmcli/fixtures/*.txt` — replace the hand-written fixtures with output captured from the board
- Modify: `docs/known-issues.md` if the board reveals anything new

- [ ] **Step 1: Capture real nmcli output from the Pi**

On the board:

```bash
nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device status
nmcli -t -f NAME,UUID,TYPE,DEVICE connection show
nmcli -t -f SSID,SIGNAL,SECURITY device wifi list ifname wlan0 --rescan yes
nmcli -t -f DEVICE,IP4.ADDRESS device show
```

Replace the three fixture files with this output, redacting real SSIDs and UUIDs but **keeping the exact escaping and field structure**. If any record has a different field count than the parser expects, that is a real finding — fix the parser, do not adjust the fixture. Re-run `npm test`.

- [ ] **Step 2: Install and run on the board**

```bash
sudo ./installer/install.sh
sudo systemctl status yonder-core
sudo journalctl -u yonder-core -n 50 --no-pager
```

Record the generated access-point password from the log. Confirm the service is `active (running)` and the socket exists:

```bash
sudo ls -l /run/yonder/core.sock
```

- [ ] **Step 3: Apply a config through the socket and confirm it**

```bash
sudo curl --unix-socket /run/yonder/core.sock -s http://localhost/config | head -20
sudo curl --unix-socket /run/yonder/core.sock -s http://localhost/status
```

Then apply a configuration that enables the access point, confirm it within the window, and check from a laptop that the SSID appears, that you can associate with the generated password, that DHCP gives you an address inside the configured pool, and that you can reach the board at the configured address.

- [ ] **Step 4: Prove the rollback — the test that matters**

Apply a configuration with a **deliberately wrong** Wi-Fi client password, or an access-point address on a subnet you cannot reach, and **do not confirm it**. Watch the journal. Within the confirmation window the daemon must revert and the previous configuration must come back.

```bash
sudo journalctl -u yonder-core -f
```

- [ ] **Step 5: Prove the fallback**

Set a client SSID that does not exist, disable the access point in config, reboot, and confirm that after the fallback timeout the access point comes up anyway and you can join it. **This is R-NET-07 and it is the reason the milestone exists.**

- [ ] **Step 6: Write down what happened**

`docs/hardware/verifying-m1a.md` records the exact procedure above, the board and OS version tested, what worked, and anything that behaved differently from the unit tests. Note any nmcli version differences worth knowing.

- [ ] **Step 7: Commit**

```bash
git add packages/yonder-core/src/net/nmcli/fixtures docs/hardware/verifying-m1a.md docs/known-issues.md
git commit -s -m "test(net): fixtures and verification from real hardware

Fixtures are now output captured from a board rather than written by hand.
Records the on-board procedure: apply, confirm, roll back an unconfirmed
change, and prove the access-point fallback brings a device back when
nothing else is reachable.

R-NET-07"
```

---

## Self-Review

**Spec coverage.** M1a covers the network half of roadmap M1:

| Roadmap M1 item | Task | Note |
|---|---|---|
| Access point with per-device password — R-NET-01, R-SEC-01, R-CFG-06 | 3, 5, 8 | secret generated by `buildRenderers`, printed once |
| DHCP for access-point clients — R-NET-02 | 4, 5 | |
| Wi-Fi client with scanning — R-NET-03 | 2, 3, 5 | `scan()` exists; the UI that calls it is M1b |
| Ethernet with DHCP — R-NET-04 | 3, 5 | |
| Access-point fallback — R-NET-07 | 7, 9 | |
| Apply and rollback used in anger — R-CFG-03 | 6, 9 | |
| Web console, board status, activity log, editor auth, themes | — | **M1b, deliberately not here** |
| Reachability and ping diagnostics — R-DIA-01, R-DIA-02 | — | **M1b** — they belong with the console that shows them |

**Known issues.** K-02 closed by Task 6, K-03 by Task 3. K-01 (socket ownership) is untouched and belongs to M1b, which introduces the non-root console that needs it.

**Placeholder scan.** No TBD, no "add error handling", no "similar to Task N". Every code step carries its code; every test step carries its assertions.

**Type consistency.** `CommandRunner`, `CommandResult`, `DeviceInfo`, `ConnectionInfo`, `AccessPointInfo`, `DesiredProfile`, `Interfaces` are defined once and used with the same names throughout. `NetworkRenderer` satisfies the existing `Renderer` interface (`name` plus `render(config)`), so it drops into `ApplyEngine` unchanged. `FallbackWatchdog` takes the same injected `Clock` the engine uses.

**One risk worth naming.** Task 9 is the first time any of this touches a real NetworkManager. Expect the fixtures to differ from the hand-written ones, and expect at least one nmcli behaviour to surprise the unit tests — that is what Task 9 is for, and its instruction is explicit: fix the parser, never the fixture.
