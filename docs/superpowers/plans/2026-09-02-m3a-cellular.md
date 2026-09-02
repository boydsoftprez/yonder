# M3a Cellular Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A board with a cellular modem gets online from `config.yaml` alone, reports what
the modem says, tells the truth about whether traffic is getting through, and moves traffic
off a path that stops working.

**Architecture:** NetworkManager owns the cellular connection as an ordinary `gsm`
connection, so it inherits the existing renderer, profile and rollback machinery.
ModemManager is read — never driven — for the detail only it has: registration, operator,
access technology and signal. A separate `reach/` module decides which paths are carrying
traffic, and three things consume it: the modem's own status, the standing-down of a dead
path, and the fallback watchdog.

**Tech Stack:** TypeScript, Zod, vitest, NetworkManager `nmcli -t`, ModemManager
`mmcli --output-keyvalue`, all behind the existing injected `CommandRunner`.

**Spec:** [2026-09-02-cellular-design.md](../specs/2026-09-02-cellular-design.md). Every
decision here is settled there; this is how it gets built, in the order that keeps the tree
green.

**Scope:** M3a — the link. No console. Testable by editing `config.yaml` and asking the
daemon's socket, as M1a was. The Cellular tab, the `Way out` panel and the `Reachable by`
panel are M3b.

## Global Constraints

- **Logic never goes in a Node-RED `function` node** (rule 2). M3a adds no flows at all.
- **Every change traces to a requirement ID** (rule 3). New IDs land in
  `docs/requirements.md` in the same commit that implements them.
- **Commits are GPG-signed.** Never `--no-gpg-sign`. Sign off with `-s`.
- **No renderer shells out except through the injected `CommandRunner`.** No test may reach
  a real `nmcli`, `mmcli` or `/sys`.
- **Secrets never reach a command line or a log.** The modem password goes through
  `SecretStore` and the existing `redactArgv` / `redactText` path.
- **`config.yaml` is the only writer of configuration.** `reach/` may decide whether a path
  participates. It may never reorder `network.priority`.
- **Nothing may make the device unreachable** (rule 6). Task 8 touches the fallback
  watchdog; it must end with the watchdog strictly more willing to raise the access point
  than before, never less.
- **Fixtures are captures, not inventions.** Every fixture in Task 2 is bytes recorded from
  the board in the spec's Evidence section. Do not hand-write one.
- Node ≥ 20. `npm test` at the repo root runs every workspace; `npx vitest run <path>` runs
  one file.

## What already exists

- `net/nmcli/client.ts` — `NmcliClient`, with `addOrModify`, `up`, `down`, `remove`,
  `devices()`, `activeIpv4()`, and a public `exec()` for callers needing their own fields.
- `net/profiles.ts` — `DesiredProfile`, `desiredProfiles(config, secrets, ifaces)`,
  `Interfaces { wifi, ethernet }`, `radioPlan`, and the `AP_/CLIENT_/ETHERNET_CONNECTION`
  names.
- `net/renderer.ts` — `NetworkRenderer`, with `OWNED` naming every connection it will
  create or delete.
- `net/watchdog.ts` — `FallbackWatchdog`, whose `check()` currently asks whether any
  non-loopback, non-access-point interface holds an IPv4 address.
- `net/runner.ts` — `CommandRunner`, `redactArgv`, `redactText`, `systemRunner`.
- `apply/types.ts` — `Renderer`, `Clock`, `systemClock`.
- `apply/reachability.ts` — `affectsReachability`, which compares the whole document with
  non-reachability fields removed.
- `daemon/routes.ts` — `createRouter(deps)`, a chain of `method === … && path === …`.
- `daemon/server.ts` — `buildRenderers`, which assembles hostname → network → console.

## File Structure

**Create**

| Path | Responsibility |
|---|---|
| `packages/yonder-core/src/net/modem/mmcli/parse.ts` | `mmcli --output-keyvalue` text → a flat record and its arrays |
| `packages/yonder-core/src/net/modem/mmcli/client.ts` | `MmcliClient`: list, show, the connected bearer, arm and read signal |
| `packages/yonder-core/src/net/modem/mmcli/fixtures/*.txt` | Bytes captured from the board |
| `packages/yonder-core/src/net/modem/profiles.ts` | The `gsm` profile and the appliance profile |
| `packages/yonder-core/src/net/modem/state.ts` | `ModemState` — one record for a page to render |
| `packages/yonder-core/src/net/reach/counters.ts` | Byte counters, read from `/sys` |
| `packages/yonder-core/src/net/reach/probe.ts` | The active test: does this path complete a request |
| `packages/yonder-core/src/net/reach/standing.ts` | Which paths participate, with hysteresis |
| `installer/roles/40-modem.sh` | Claim an already-plugged modem; leave the link off |

**Modify**

| Path | Change |
|---|---|
| `packages/yonder-core/src/schema/config.ts` | `network.modem` |
| `packages/yonder-core/src/net/profiles.ts` | `Interfaces.modem`, `MODEM_CONNECTION`, modem profiles in `desiredProfiles` |
| `packages/yonder-core/src/net/renderer.ts` | `OWNED` gains the modem connection; interface detection finds it |
| `packages/yonder-core/src/net/watchdog.ts` | Reachability means carrying traffic, not holding an address (K-33) |
| `packages/yonder-core/src/daemon/routes.ts` | `GET /modem/state`, `GET /reach/state` |
| `packages/yonder-core/src/daemon/server.ts` | Build the modem client, the reach monitor, wire both |
| `installer/roles/10-base.sh` | `ensure_pkgs modemmanager` |
| `docs/requirements.md` | R-CEL-09, R-CEL-10, R-CEL-11, R-NET-13 |
| `docs/known-issues.md` | K-33 |
| `docs/configuration.md` | `network.modem`, and the retired sketch keys |
| `docs/roadmap.md` | M3a status |

---

## Task 1: The `modem` section of the schema, and its requirements

**Files:**
- Modify: `packages/yonder-core/src/schema/config.ts`
- Modify: `docs/requirements.md`, `docs/known-issues.md`, `docs/configuration.md`
- Test: `packages/yonder-core/src/schema/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `config.network.modem` with fields `enabled: boolean`, `mode: "auto" |
  "appliance"`, `interface: string | null`, `apn: string | null`, `username: string | null`,
  `password: SecretRef | null`, `dial: string | null`. Every later task reads these names.

- [ ] **Step 1: Write the failing tests**

Append to `packages/yonder-core/src/schema/config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ConfigSchema, DEFAULT_CONFIG } from "./config.js";

describe("network.modem", () => {
  it("is absent from a device that has not configured one", () => {
    // R-CFG-08: a freshly flashed board is usable with no operator input, and
    // that means no modem connection is attempted on a board with no modem.
    expect(DEFAULT_CONFIG.network.modem.enabled).toBe(false);
    expect(DEFAULT_CONFIG.network.modem.mode).toBe("auto");
    expect(DEFAULT_CONFIG.network.modem.apn).toBeNull();
  });

  it("takes an APN, a user, a password reference and a dial string", () => {
    const config = ConfigSchema.parse({
      ...DEFAULT_CONFIG,
      network: {
        ...DEFAULT_CONFIG.network,
        modem: {
          enabled: true,
          apn: "ereseller",
          username: "user",
          password: { secret: "modem_psk" },
          dial: "*99#",
        },
      },
    });
    expect(config.network.modem.apn).toBe("ereseller");
    expect(config.network.modem.password).toEqual({ secret: "modem_psk" });
    expect(config.network.modem.dial).toBe("*99#");
  });

  it("names the adapter when the operator names the modem", () => {
    const config = ConfigSchema.parse({
      ...DEFAULT_CONFIG,
      network: {
        ...DEFAULT_CONFIG.network,
        modem: { enabled: true, mode: "appliance", interface: "usb0" },
      },
    });
    expect(config.network.modem.mode).toBe("appliance");
    expect(config.network.modem.interface).toBe("usb0");
  });

  it("refuses a mode it does not have", () => {
    // `hilink` and `stick` were the sketch in configuration.md and are not
    // what shipped. A misspelling silently accepted is a setting an operator
    // believes is in force and is not.
    expect(() => ConfigSchema.parse({
      ...DEFAULT_CONFIG,
      network: { ...DEFAULT_CONFIG.network, modem: { mode: "hilink" } },
    })).toThrow();
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run packages/yonder-core/src/schema/config.test.ts`
Expected: FAIL — `network.modem` is not in the schema, so `DEFAULT_CONFIG.network.modem` is
`undefined` and the strict object rejects the key.

- [ ] **Step 3: Add the section**

In `packages/yonder-core/src/schema/config.ts`, above `const Network = z.object({`:

```ts
/**
 * The cellular modem.
 *
 * Two kinds of modem, and only one of them can be found automatically.
 *
 * `auto` means the modem ModemManager claims — the kind that exposes
 * registration, operator, radio technology and signal, and which
 * NetworkManager drives as a `gsm` connection. That is the only kind this
 * schema can identify without being told.
 *
 * `appliance` is a modem that holds the SIM, dials by itself and appears to
 * the host as an ordinary network adapter. It is indistinguishable from a
 * USB network adapter without a list of device identifiers written from a
 * vendor's documentation, so the operator names it in `interface` instead
 * (R-CEL-11). Nothing about signal or operator is available for one.
 *
 * `enabled: false` is the default and means no modem is configured — not a
 * modem configured and idle. A board with a stick plugged in and nothing
 * here brings up no cellular connection (R-CFG-08).
 *
 * `dial` exists because R-CEL-02 asks for it and is unused on every modem
 * measured: a QMI or MBIM bearer has no dial step, and `gsm.number` was empty
 * on the link that worked. It applies to a serial connection only.
 */
const Modem = z.object({
  enabled: z.boolean().default(false),
  mode: z.enum(["auto", "appliance"]).default("auto"),
  interface: z.string().min(1).nullable().default(null),
  apn: z.string().min(1).max(100).nullable().default(null),
  username: z.string().nullable().default(null),
  password: SecretRef.nullable().default(null),
  dial: z.string().nullable().default(null),
}).strict();
```

Then add to `Network`, after `ethernet`:

```ts
  modem: Modem.default({}),
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run packages/yonder-core/src/schema/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the requirements**

In `docs/requirements.md`, append to the R-CEL block after R-CEL-08, then R-NET-13 after
R-NET-12. Copy the four rows verbatim from §7 of the spec — they are written as
requirement text and must not be paraphrased.

- [ ] **Step 6: Add K-33**

In `docs/known-issues.md`, after K-32:

```markdown
### K-33 · The fallback watchdog accepts an address as proof of reachability

**Status:** Open · **Requirement:** R-NET-07, R-CEL-09

`FallbackWatchdog.check()` asks whether any interface other than the access point holds an
IPv4 address. R-NET-07's own text says "carries traffic"; the implementation weakened it
deliberately, because a connected but idle Ethernet link carries none and is perfectly
reachable, and its comment says so.

Cellular breaks that reasoning. A modem with a wrong APN registers, attaches, takes an
address and installs a route while completing no request — measured, and recorded in the
M3 design's §2. That satisfies this check. A device configured that way from the boot
partition, with no other path, never raises its access point and is unreachable until
somebody pulls the card. Rule 6.

**Closed by:** Task 8 of the M3a plan, which moves the check onto the same
carrying-traffic signal R-CEL-09 introduces — which can tell *idle* from *dead*, as byte
counters alone could not.
```

- [ ] **Step 7: Document the keys**

In `docs/configuration.md`, move `network.modem` out of "Sections that arrive with later
milestones" into the live reference with the shape from Task 1 Step 3, and add two rows to
the retired-keys table:

```markdown
| `network.modem.mode: hilink` | Renamed. A vendor's word for its own product; `appliance` is what R-CEL-01 calls this kind of modem |
| `network.modem.mode: stick` | Renamed to `auto`, which says what it does — use the modem the system found |
```

Add a note under "Notes on specific keys":

```markdown
**`network.modem.apn`** has no default and is never guessed. Debian's carrier database
lists `NXTGENPHONE` first for the SIM this was measured against, which is the value that
attached and carried nothing, and the value that worked is absent from the file entirely.
An APN comes from your carrier (R-CEL-09).
```

- [ ] **Step 8: Run the whole suite and commit**

```bash
npm test
git add packages/yonder-core/src/schema/ docs/requirements.md docs/known-issues.md docs/configuration.md
git commit -s -m "feat(schema): the modem section, and what it does not guess — R-CEL-09"
```

---

## Task 2: Parse what `mmcli` actually prints

**Files:**
- Create: `packages/yonder-core/src/net/modem/mmcli/parse.ts`
- Create: `packages/yonder-core/src/net/modem/mmcli/parse.test.ts`
- Create: `packages/yonder-core/src/net/modem/mmcli/fixtures/{modem-list,modem-show,bearer-connected,bearer-initial,signal-get}.txt`

**Interfaces:**
- Consumes: nothing.
- Produces: `parseKeyValue(text: string): Record<string, string | null>` and
  `arrayAt(record, prefix): string[]`. Task 3 uses both.

**Why a parser at all.** `mmcli --output-keyvalue` is ModemManager's machine mode, the
counterpart to `nmcli -t`, and ADR-0006's reasoning for using a supported terse output
rather than screen-scraping applies unchanged. Its shape is `key<spaces>: value`, `--` for
absent, and arrays as a `.length` plus `.value[n]` per element.

- [ ] **Step 1: Write the fixtures**

These are captures from the board in the spec's Evidence section. Create each file exactly
as given.

`fixtures/modem-list.txt`:

```
modem-list.length   : 1
modem-list.value[1] : /org/freedesktop/ModemManager1/Modem/0
```

`fixtures/modem-show.txt`:

```
modem.generic.device-identifier                 : 8d0a398cac8d78a16d19481147f5d2ca5ec9760e
modem.generic.manufacturer                      : Quectel
modem.generic.model                             : EC25
modem.generic.primary-port                      : cdc-wdm0
modem.generic.ports.length                      : 6
modem.generic.ports.value[1]                    : cdc-wdm0 (mbim)
modem.generic.ports.value[2]                    : ttyUSB0 (ignored)
modem.generic.ports.value[3]                    : ttyUSB1 (gps)
modem.generic.ports.value[4]                    : ttyUSB2 (at)
modem.generic.ports.value[5]                    : ttyUSB3 (at)
modem.generic.ports.value[6]                    : wwan0 (net)
modem.generic.state                             : connected
modem.generic.state-failed-reason               : --
modem.generic.power-state                       : on
modem.generic.access-technologies.length        : 1
modem.generic.access-technologies.value[1]      : lte
modem.generic.signal-quality.value              : 29
modem.generic.signal-quality.recent             : no
modem.3gpp.imei                                 : 357014749990990
modem.3gpp.operator-code                        : 310410
modem.3gpp.operator-name                        : Dark Star
modem.3gpp.registration-state                   : home
modem.generic.bearers.length                    : 2
modem.generic.bearers.value[1]                  : /org/freedesktop/ModemManager1/Bearer/1
modem.generic.bearers.value[2]                  : /org/freedesktop/ModemManager1/Bearer/0
```

`fixtures/bearer-connected.txt`:

```
bearer.status.connected                  : yes
bearer.status.interface                  : wwan0
bearer.status.ip-timeout                 : 20
bearer.properties.apn                    : ereseller
bearer.properties.roaming                : allowed
bearer.properties.ip-type                : ipv4v6
bearer.properties.user                   : --
bearer.properties.password               : --
bearer.ipv4-config.method                : static
bearer.ipv4-config.address               : 10.31.95.33
bearer.ipv4-config.prefix                : 30
bearer.ipv4-config.gateway               : 10.31.95.34
bearer.ipv4-config.dns.length            : 2
bearer.ipv4-config.dns.value[1]          : 172.26.38.2
bearer.ipv4-config.dns.value[2]          : 172.26.38.2
bearer.ipv4-config.mtu                   : 1430
bearer.ipv6-config.method                : static
bearer.ipv6-config.address               : 2600:382:859c:df48:40b3:9486:1d36:cb26
bearer.ipv6-config.prefix                : 64
bearer.ipv6-config.mtu                   : 1430
```

`fixtures/bearer-initial.txt` — **the trap this exists to catch.** Bearer 0 is the
network's own initial bearer, is not connected, and carries an APN nobody configured:

```
bearer.status.connected                  : no
bearer.status.interface                  : --
bearer.properties.apn                    : nxtgenphone
bearer.properties.ip-type                : ipv4v6
```

`fixtures/signal-get.txt`:

```
modem.signal.refresh.rate         : 2
modem.signal.threshold.rssi       : 0
modem.signal.threshold.error-rate : no
modem.signal.gsm.rssi             : --
modem.signal.umts.rssi            : --
modem.signal.lte.rssi             : -71.00
modem.signal.lte.rsrq             : -9.00
modem.signal.lte.rsrp             : -100.00
modem.signal.lte.snr              : 19.00
modem.signal.lte.error-rate       : --
modem.signal.5g.rssi              : --
modem.signal.5g.rsrq              : --
modem.signal.5g.rsrp              : --
modem.signal.5g.snr               : --
```

- [ ] **Step 2: Write the failing test**

`packages/yonder-core/src/net/modem/mmcli/parse.test.ts`:

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { arrayAt, parseKeyValue } from "./parse.js";

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, "fixtures", `${name}.txt`), "utf8");

describe("parseKeyValue", () => {
  it("reads a key and its value across the padding mmcli aligns with", () => {
    const r = parseKeyValue(fixture("modem-show"));
    expect(r["modem.generic.model"]).toBe("EC25");
    expect(r["modem.3gpp.operator-name"]).toBe("Dark Star");
  });

  it("reads `--` as absent rather than as the string it looks like", () => {
    const r = parseKeyValue(fixture("modem-show"));
    expect(r["modem.generic.state-failed-reason"]).toBeNull();
  });

  it("keeps a value containing a colon whole", () => {
    // An IPv6 address is the case that breaks a naive split(":").
    const r = parseKeyValue(fixture("bearer-connected"));
    expect(r["bearer.ipv6-config.address"]).toBe("2600:382:859c:df48:40b3:9486:1d36:cb26");
  });

  it("ignores a blank line", () => {
    expect(parseKeyValue("\n\na : b\n\n")).toEqual({ a: "b" });
  });
});

describe("arrayAt", () => {
  it("reads a length-and-value array in index order", () => {
    const r = parseKeyValue(fixture("modem-show"));
    expect(arrayAt(r, "modem.generic.ports")).toEqual([
      "cdc-wdm0 (mbim)", "ttyUSB0 (ignored)", "ttyUSB1 (gps)",
      "ttyUSB2 (at)", "ttyUSB3 (at)", "wwan0 (net)",
    ]);
  });

  it("is empty when there is no such array", () => {
    expect(arrayAt(parseKeyValue(fixture("modem-show")), "modem.nothing")).toEqual([]);
  });

  it("reads the modem list", () => {
    expect(arrayAt(parseKeyValue(fixture("modem-list")), "modem-list"))
      .toEqual(["/org/freedesktop/ModemManager1/Modem/0"]);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run packages/yonder-core/src/net/modem/mmcli/parse.test.ts`
Expected: FAIL — `Cannot find module './parse.js'`.

- [ ] **Step 4: Write the parser**

`packages/yonder-core/src/net/modem/mmcli/parse.ts`:

```ts
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * `mmcli --output-keyvalue` is ModemManager's machine mode, and parsing it is
 * the same trade ADR-0006 recorded for `nmcli -t`: a supported terse output,
 * not screen-scraping. Its shape is
 *
 *     modem.generic.model                             : EC25
 *     modem.generic.state-failed-reason               : --
 *
 * — a key, alignment padding, a colon, a space, and the rest of the line.
 *
 * **Split on the first colon-space, never on the colon.** A bearer's IPv6
 * address is `2600:382:859c:…` and a naive split loses all but its first
 * group. The separator mmcli actually writes is `" : "`, so that is what is
 * matched.
 */
export function parseKeyValue(text: string): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const line of text.split("\n")) {
    const at = line.indexOf(" : ");
    if (at === -1) continue;
    const key = line.slice(0, at).trim();
    if (key === "") continue;
    const value = line.slice(at + 3).trim();
    // `--` is mmcli's absent. Reading it as a string puts the literal two
    // characters on a console, which is worse than nothing because it looks
    // like data.
    out[key] = value === "--" ? null : value;
  }
  return out;
}

/**
 * An array, which mmcli writes as a `.length` and one `.value[n]` per element,
 * one-indexed.
 *
 * Read by index up to the stated length rather than by collecting every
 * matching key: `modem.generic.bearers` and `modem.generic.bearers-something`
 * would both match a prefix scan, and the order of object keys is not the
 * order of a list.
 */
export function arrayAt(record: Record<string, string | null>, prefix: string): string[] {
  const length = Number(record[`${prefix}.length`] ?? "0");
  if (!Number.isInteger(length) || length <= 0) return [];
  const out: string[] = [];
  for (let i = 1; i <= length; i++) {
    const value = record[`${prefix}.value[${i}]`];
    if (value !== undefined && value !== null) out.push(value);
  }
  return out;
}
```

- [ ] **Step 5: Run it and watch it pass**

Run: `npx vitest run packages/yonder-core/src/net/modem/mmcli/parse.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/yonder-core/src/net/modem/
git commit -s -m "feat(modem): read what mmcli prints, from captures not from documentation"
```

---

## Task 3: The mmcli client

**Files:**
- Create: `packages/yonder-core/src/net/modem/mmcli/client.ts`
- Create: `packages/yonder-core/src/net/modem/mmcli/client.test.ts`

**Interfaces:**
- Consumes: `parseKeyValue`, `arrayAt` (Task 2); `CommandRunner` from `../../runner.js`.
- Produces:

```ts
export interface ModemPorts { control: string | null; net: string | null }
export interface ModemInfo {
  path: string; manufacturer: string | null; model: string | null;
  state: string | null; failedReason: string | null; powerState: string | null;
  accessTechnology: string | null; operatorName: string | null; operatorCode: string | null;
  registration: string | null; imei: string | null;
  ports: ModemPorts; portList: string[]; bearerPaths: string[];
}
export interface BearerInfo {
  path: string; connected: boolean; interface: string | null; apn: string | null;
  ipType: string | null; address: string | null; gateway: string | null; mtu: number | null;
}
export interface SignalReading {
  rssi: number | null; rsrq: number | null; rsrp: number | null; snr: number | null;
}
export class MmcliClient {
  constructor(runner: CommandRunner, log?: (line: string) => void)
  async modems(): Promise<string[]>
  async modem(path: string): Promise<ModemInfo>
  async bearer(path: string): Promise<BearerInfo>
  async connectedBearer(modem: ModemInfo): Promise<BearerInfo | null>
  async armSignal(path: string, seconds: number): Promise<void>
  async signal(path: string): Promise<SignalReading>
}
```

Tasks 4, 5 and 9 use these names.

- [ ] **Step 1: Write the failing test**

`packages/yonder-core/src/net/modem/mmcli/client.test.ts`:

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MmcliClient } from "./client.js";
import type { CommandRunner } from "../../runner.js";

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, "fixtures", `${name}.txt`), "utf8");

/** A runner that answers from fixtures and records every argv it was given. */
function fakeRunner(answers: Record<string, string>) {
  const calls: string[][] = [];
  const runner: CommandRunner = async (argv) => {
    calls.push(argv);
    const key = Object.keys(answers).find((k) => argv.join(" ").includes(k));
    if (key === undefined) return { code: 1, stdout: "", stderr: "no such fixture" };
    return { code: 0, stdout: answers[key], stderr: "" };
  };
  return { runner, calls };
}

describe("MmcliClient.modems", () => {
  it("lists the modem paths", async () => {
    const { runner, calls } = fakeRunner({ "-L": fixture("modem-list") });
    expect(await new MmcliClient(runner).modems())
      .toEqual(["/org/freedesktop/ModemManager1/Modem/0"]);
    expect(calls[0]).toEqual(["mmcli", "-L", "--output-keyvalue"]);
  });

  it("is empty, not an error, when no modem is present", async () => {
    // A board with no modem is an ordinary board, not a fault.
    const { runner } = fakeRunner({ "-L": "modem-list.length : 0\n" });
    expect(await new MmcliClient(runner).modems()).toEqual([]);
  });
});

describe("MmcliClient.modem", () => {
  it("reads what the modem says about itself", async () => {
    const { runner } = fakeRunner({ "-m": fixture("modem-show") });
    const m = await new MmcliClient(runner).modem("/org/freedesktop/ModemManager1/Modem/0");
    expect(m.model).toBe("EC25");
    expect(m.state).toBe("connected");
    expect(m.accessTechnology).toBe("lte");
    expect(m.operatorName).toBe("Dark Star");
    expect(m.registration).toBe("home");
  });

  it("separates the port that is configured from the port that carries traffic", async () => {
    // The device NetworkManager binds is cdc-wdm0; the address and every byte
    // are on wwan0. Both names are correct for different questions.
    const { runner } = fakeRunner({ "-m": fixture("modem-show") });
    const m = await new MmcliClient(runner).modem("/org/freedesktop/ModemManager1/Modem/0");
    expect(m.ports.control).toBe("cdc-wdm0");
    expect(m.ports.net).toBe("wwan0");
  });
});

describe("MmcliClient.connectedBearer", () => {
  it("returns the bearer that is connected, not the first one listed", async () => {
    // Bearer 0 is the network's initial bearer: not connected, and carrying an
    // APN nobody configured. It is listed second here and is index 0 there.
    const runner: CommandRunner = async (argv) => {
      const line = argv.join(" ");
      if (line.includes("Bearer/1")) return { code: 0, stdout: fixture("bearer-connected"), stderr: "" };
      if (line.includes("Bearer/0")) return { code: 0, stdout: fixture("bearer-initial"), stderr: "" };
      return { code: 0, stdout: fixture("modem-show"), stderr: "" };
    };
    const client = new MmcliClient(runner);
    const modem = await client.modem("/org/freedesktop/ModemManager1/Modem/0");
    const bearer = await client.connectedBearer(modem);
    expect(bearer?.apn).toBe("ereseller");
    expect(bearer?.interface).toBe("wwan0");
    expect(bearer?.address).toBe("10.31.95.33");
    expect(bearer?.mtu).toBe(1430);
  });

  it("is null when no bearer is connected", async () => {
    const runner: CommandRunner = async (argv) =>
      argv.join(" ").includes("-b")
        ? { code: 0, stdout: fixture("bearer-initial"), stderr: "" }
        : { code: 0, stdout: fixture("modem-show"), stderr: "" };
    const client = new MmcliClient(runner);
    const modem = await client.modem("/org/freedesktop/ModemManager1/Modem/0");
    expect(await client.connectedBearer(modem)).toBeNull();
  });
});

describe("MmcliClient signal", () => {
  it("arms polling before reading, because otherwise there is nothing to read", async () => {
    const { runner, calls } = fakeRunner({ "--signal-setup": "" });
    await new MmcliClient(runner).armSignal("/org/freedesktop/ModemManager1/Modem/0", 2);
    expect(calls[0]).toEqual([
      "mmcli", "-m", "/org/freedesktop/ModemManager1/Modem/0", "--signal-setup=2",
    ]);
  });

  it("reads the four numbers for the technology in use", async () => {
    const { runner } = fakeRunner({ "--signal-get": fixture("signal-get") });
    const s = await new MmcliClient(runner).signal("/org/freedesktop/ModemManager1/Modem/0");
    expect(s).toEqual({ rssi: -71, rsrq: -9, rsrp: -100, snr: 19 });
  });

  it("answers nulls rather than zeroes when polling was never armed", async () => {
    // Zero dBm is a real and extraordinary value. Reporting it for "unknown"
    // would put a perfect signal on a console that has no signal at all.
    const { runner } = fakeRunner({ "--signal-get": "modem.signal.lte.rssi : --\n" });
    expect(await new MmcliClient(runner).signal("/x"))
      .toEqual({ rssi: null, rsrq: null, rsrp: null, snr: null });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run packages/yonder-core/src/net/modem/mmcli/client.test.ts`
Expected: FAIL — `Cannot find module './client.js'`.

- [ ] **Step 3: Write the client**

`packages/yonder-core/src/net/modem/mmcli/client.ts`:

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
import { redactArgv, type CommandRunner } from "../../runner.js";
import { arrayAt, parseKeyValue } from "./parse.js";

export interface ModemPorts {
  /** What NetworkManager binds a connection to. `cdc-wdm0` on the EC25. */
  control: string | null;
  /** What holds the address and carries the bytes. `wwan0` on the EC25. */
  net: string | null;
}

export interface ModemInfo {
  path: string;
  manufacturer: string | null;
  model: string | null;
  state: string | null;
  failedReason: string | null;
  powerState: string | null;
  accessTechnology: string | null;
  operatorName: string | null;
  operatorCode: string | null;
  registration: string | null;
  imei: string | null;
  ports: ModemPorts;
  /** Every port with its kind, as mmcli prints it. R-CEL-03's raw material. */
  portList: string[];
  bearerPaths: string[];
}

export interface BearerInfo {
  path: string;
  connected: boolean;
  interface: string | null;
  apn: string | null;
  ipType: string | null;
  address: string | null;
  gateway: string | null;
  mtu: number | null;
}

export interface SignalReading {
  rssi: number | null;
  rsrq: number | null;
  rsrp: number | null;
  snr: number | null;
}

/** A failed mmcli invocation, redacted like NmcliError is. */
export class MmcliError extends Error {
  readonly argv: string[];
  constructor(argv: string[], code: number, stderr: string) {
    super(`mmcli exited ${code}: ${stderr.trim() || "(no stderr)"}\n  ${redactArgv(argv).join(" ")}`);
    this.name = "MmcliError";
    this.argv = redactArgv(argv);
  }
}

/** `cdc-wdm0 (mbim)` → `["cdc-wdm0", "mbim"]`. */
function splitPort(entry: string): [string, string] {
  const m = /^(\S+)\s*\(([^)]*)\)$/.exec(entry.trim());
  return m === null ? [entry.trim(), ""] : [m[1], m[2]];
}

/** A number, or null for mmcli's absent. Never a zero standing in for unknown. */
function num(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * ModemManager, read and never driven.
 *
 * The connection is NetworkManager's — see net/modem/profiles.ts. What is
 * here is everything only ModemManager knows: registration, operator, access
 * technology, the ports a modem came up on, and signal.
 */
export class MmcliClient {
  constructor(
    private readonly runner: CommandRunner,
    private readonly log: (line: string) => void = () => {},
  ) {}

  private async exec(argv: string[]): Promise<string> {
    this.log(redactArgv(argv).join(" "));
    const result = await this.runner(argv);
    if (result.code !== 0) throw new MmcliError(argv, result.code, result.stderr);
    return result.stdout;
  }

  /** Every modem ModemManager has claimed. Empty is an ordinary answer. */
  async modems(): Promise<string[]> {
    const out = await this.exec(["mmcli", "-L", "--output-keyvalue"]);
    return arrayAt(parseKeyValue(out), "modem-list");
  }

  async modem(path: string): Promise<ModemInfo> {
    const r = parseKeyValue(await this.exec(["mmcli", "-m", path, "--output-keyvalue"]));
    const portList = arrayAt(r, "modem.generic.ports");
    const ports: ModemPorts = { control: null, net: null };
    for (const entry of portList) {
      const [name, kind] = splitPort(entry);
      // The kinds that matter. `at` is a control port too, but only as the
      // fallback a modem with no data port ends up on — which is the
      // arrangement the install role exists to prevent, not one to configure.
      if (kind === "net") ports.net = name;
      else if (kind === "mbim" || kind === "qmi") ports.control = name;
    }
    // The primary port is the control port when mmcli named one, which it does
    // for every modem that has a data path.
    ports.control = ports.control ?? r["modem.generic.primary-port"] ?? null;
    return {
      path,
      manufacturer: r["modem.generic.manufacturer"] ?? null,
      model: r["modem.generic.model"] ?? null,
      state: r["modem.generic.state"] ?? null,
      failedReason: r["modem.generic.state-failed-reason"] ?? null,
      powerState: r["modem.generic.power-state"] ?? null,
      accessTechnology: arrayAt(r, "modem.generic.access-technologies")[0] ?? null,
      operatorName: r["modem.3gpp.operator-name"] ?? null,
      operatorCode: r["modem.3gpp.operator-code"] ?? null,
      registration: r["modem.3gpp.registration-state"] ?? null,
      imei: r["modem.3gpp.imei"] ?? null,
      ports,
      portList,
      bearerPaths: arrayAt(r, "modem.generic.bearers"),
    };
  }

  async bearer(path: string): Promise<BearerInfo> {
    const r = parseKeyValue(await this.exec(["mmcli", "-b", path, "--output-keyvalue"]));
    return {
      path,
      connected: r["bearer.status.connected"] === "yes",
      interface: r["bearer.status.interface"] ?? null,
      apn: r["bearer.properties.apn"] ?? null,
      ipType: r["bearer.properties.ip-type"] ?? null,
      address: r["bearer.ipv4-config.address"] ?? null,
      gateway: r["bearer.ipv4-config.gateway"] ?? null,
      mtu: num(r["bearer.ipv4-config.mtu"]),
    };
  }

  /**
   * The bearer actually carrying traffic.
   *
   * **Not `bearers[0]`, and not bearer 0.** A modem reports its network's own
   * initial bearer alongside the one Yonder created. On the board this was
   * measured on, the initial bearer was index 0, was *not* connected, and
   * carried `nxtgenphone` — an APN nobody configured and the one that failed.
   * Reading the first bearer reads that. Every bearer is asked, and the
   * connected one is returned.
   */
  async connectedBearer(modem: ModemInfo): Promise<BearerInfo | null> {
    for (const path of modem.bearerPaths) {
      const bearer = await this.bearer(path);
      if (bearer.connected) return bearer;
    }
    return null;
  }

  /**
   * Turn on detailed signal polling.
   *
   * Without this a modem reports only a coarse quality percentage, which on
   * the measured board read 60 and then 29 while the real numbers moved three
   * dB. It is a privileged operation and the daemon runs as root already.
   */
  async armSignal(path: string, seconds: number): Promise<void> {
    await this.exec(["mmcli", "-m", path, `--signal-setup=${seconds}`]);
  }

  /**
   * The four numbers, for the technology in use.
   *
   * LTE first and 5G after it, because a modem reports one set and dashes for
   * the rest. Nulls when polling was never armed — never zeroes, because 0 dBm
   * is a real and extraordinary reading and would show a perfect signal on a
   * device that has none.
   */
  async signal(path: string): Promise<SignalReading> {
    const r = parseKeyValue(await this.exec(["mmcli", "-m", path, "--signal-get", "--output-keyvalue"]));
    for (const tech of ["lte", "5g", "umts", "gsm"]) {
      const rssi = num(r[`modem.signal.${tech}.rssi`]);
      const rsrp = num(r[`modem.signal.${tech}.rsrp`]);
      if (rssi !== null || rsrp !== null) {
        return {
          rssi,
          rsrq: num(r[`modem.signal.${tech}.rsrq`]),
          rsrp,
          snr: num(r[`modem.signal.${tech}.snr`]),
        };
      }
    }
    return { rssi: null, rsrq: null, rsrp: null, snr: null };
  }
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run packages/yonder-core/src/net/modem/mmcli/client.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/yonder-core/src/net/modem/mmcli/
git commit -s -m "feat(modem): read ModemManager, and never the first bearer — R-CEL-10"
```

---

## Task 4: One state for a page to render

**Files:**
- Create: `packages/yonder-core/src/net/modem/state.ts`
- Create: `packages/yonder-core/src/net/modem/state.test.ts`

**Interfaces:**
- Consumes: `ModemInfo`, `BearerInfo`, `SignalReading` (Task 3); `Config` (Task 1).
- Produces:

```ts
export type ModemMode = "absent" | "unconfigured" | "joining" | "waiting" | "connected" | "failed"
export interface ModemState {
  mode: ModemMode; summary: string;
  operator: string | null; technology: string | null; registration: string | null;
  apn: string | null; address: string | null; mtu: number | null;
  signal: SignalReading; ports: string[]; reportsSignal: boolean;
}
export function modemState(config, modem, bearer, signal): ModemState
```

Task 9 serves this; M3b renders it.

**Why a separate pure module.** `net/state.ts` did exactly this for the radio and the
reasoning is quoted there: the console had raw configuration on screen and left the
operator to work out which of two fields was in force. Same shape here, and computing it
from configuration *and* the device means the answer is what is true rather than what was
asked for.

- [ ] **Step 1: Write the failing test**

`packages/yonder-core/src/net/modem/state.test.ts`:

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../schema/config.js";
import { modemState } from "./state.js";
import type { BearerInfo, ModemInfo, SignalReading } from "./mmcli/client.js";

const NO_SIGNAL: SignalReading = { rssi: null, rsrq: null, rsrp: null, snr: null };
const SIGNAL: SignalReading = { rssi: -71, rsrq: -9, rsrp: -100, snr: 19 };

const modem = (over: Partial<ModemInfo> = {}): ModemInfo => ({
  path: "/m/0", manufacturer: "Quectel", model: "EC25", state: "connected",
  failedReason: null, powerState: "on", accessTechnology: "lte",
  operatorName: "Dark Star", operatorCode: "310410", registration: "home",
  imei: "357014749990990",
  ports: { control: "cdc-wdm0", net: "wwan0" },
  portList: ["cdc-wdm0 (mbim)", "wwan0 (net)"], bearerPaths: ["/b/1"], ...over,
});

const bearer = (over: Partial<BearerInfo> = {}): BearerInfo => ({
  path: "/b/1", connected: true, interface: "wwan0", apn: "ereseller",
  ipType: "ipv4v6", address: "10.31.95.33", gateway: "10.31.95.34", mtu: 1430, ...over,
});

const enabled = {
  ...DEFAULT_CONFIG,
  network: { ...DEFAULT_CONFIG.network, modem: { ...DEFAULT_CONFIG.network.modem, enabled: true, apn: "ereseller" } },
};

describe("modemState", () => {
  it("says absent when there is no modem", () => {
    const s = modemState(enabled, null, null, NO_SIGNAL);
    expect(s.mode).toBe("absent");
    expect(s.summary).toBe("No modem found");
  });

  it("says a modem was found and is not configured", () => {
    // A stick plugged into a board with nothing in config.yaml. Not a fault,
    // and not something to hide: it is the one thing the operator needs told.
    const s = modemState(DEFAULT_CONFIG, modem(), null, NO_SIGNAL);
    expect(s.mode).toBe("unconfigured");
    expect(s.summary).toBe("Modem found — not configured");
  });

  it("reports the operator, the technology and the address when connected", () => {
    const s = modemState(enabled, modem(), bearer(), SIGNAL);
    expect(s.mode).toBe("connected");
    expect(s.operator).toBe("Dark Star");
    expect(s.technology).toBe("lte");
    expect(s.apn).toBe("ereseller");
    expect(s.address).toBe("10.31.95.33");
    expect(s.mtu).toBe(1430);
    expect(s.signal).toEqual(SIGNAL);
  });

  it("reports the APN of the connected bearer, not the one configured", () => {
    // The two can disagree while an apply is in flight, and what is true is
    // what the link is actually using.
    const s = modemState(enabled, modem(), bearer({ apn: "something-else" }), SIGNAL);
    expect(s.apn).toBe("something-else");
  });

  it("says waiting when the modem is registered but no bearer is up", () => {
    const s = modemState(enabled, modem({ state: "registered" }), null, NO_SIGNAL);
    expect(s.mode).toBe("waiting");
  });

  it("says joining while the modem is still searching", () => {
    const s = modemState(enabled, modem({ state: "searching", registration: "idle" }), null, NO_SIGNAL);
    expect(s.mode).toBe("joining");
  });

  it("carries the failure reason when the modem failed", () => {
    const s = modemState(enabled, modem({ state: "failed", failedReason: "sim-missing" }), null, NO_SIGNAL);
    expect(s.mode).toBe("failed");
    expect(s.summary).toContain("sim-missing");
  });

  it("says an appliance cannot report signal, rather than reporting none", () => {
    // R-CEL-11: the absence is a property of that kind of modem, not data
    // that failed to arrive, and a page must be able to tell them apart.
    const appliance = {
      ...DEFAULT_CONFIG,
      network: {
        ...DEFAULT_CONFIG.network,
        modem: { ...DEFAULT_CONFIG.network.modem, enabled: true, mode: "appliance" as const, interface: "usb0" },
      },
    };
    const s = modemState(appliance, null, null, NO_SIGNAL);
    expect(s.reportsSignal).toBe(false);
    expect(s.mode).not.toBe("absent");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run packages/yonder-core/src/net/modem/state.test.ts`
Expected: FAIL — `Cannot find module './state.js'`.

- [ ] **Step 3: Write it**

`packages/yonder-core/src/net/modem/state.ts`:

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
import type { Config } from "../../schema/config.js";
import type { BearerInfo, ModemInfo, SignalReading } from "./mmcli/client.js";

export type ModemMode =
  | "absent"        // nothing found, and the operator did not name one
  | "unconfigured"  // a modem is here and config.yaml says nothing about it
  | "joining"       // searching for a network
  | "waiting"       // registered, no bearer yet
  | "connected"     // a bearer is up
  | "failed";       // the modem itself reported a failure

export interface ModemState {
  mode: ModemMode;
  /** One line for a status readout, in Yonder's words. */
  summary: string;
  operator: string | null;
  technology: string | null;
  registration: string | null;
  /** The APN in use, read from the connected bearer — not from configuration. */
  apn: string | null;
  address: string | null;
  mtu: number | null;
  signal: SignalReading;
  /** Every port with its kind, as the modem came up. R-CEL-03. */
  ports: string[];
  /**
   * Whether this kind of modem can report signal at all (R-CEL-11).
   *
   * False for an appliance, which hides operator, technology and signal behind
   * its own interface. A page shows that as a property of the modem rather
   * than as four empty fields, which would read as a fault.
   */
  reportsSignal: boolean;
}

const NO_SIGNAL: SignalReading = { rssi: null, rsrq: null, rsrp: null, snr: null };

export function modemState(
  config: Config,
  modem: ModemInfo | null,
  bearer: BearerInfo | null,
  signal: SignalReading,
): ModemState {
  const wanted = config.network.modem;
  const appliance = wanted.mode === "appliance";

  const base = {
    operator: modem?.operatorName ?? null,
    technology: modem?.accessTechnology ?? null,
    registration: modem?.registration ?? null,
    apn: bearer?.apn ?? null,
    address: bearer?.address ?? null,
    mtu: bearer?.mtu ?? null,
    signal: appliance ? NO_SIGNAL : signal,
    ports: modem?.portList ?? [],
    reportsSignal: !appliance,
  };

  // An appliance is never "absent": it is a named adapter, and whether it is
  // working is a question for reach/, not for ModemManager, which will never
  // have heard of it.
  if (appliance) {
    return { ...base, mode: wanted.enabled ? "connected" : "unconfigured",
      summary: wanted.enabled ? `Using ${wanted.interface ?? "the named adapter"}` : "Not configured" };
  }

  if (modem === null) return { ...base, mode: "absent", summary: "No modem found" };
  if (!wanted.enabled) return { ...base, mode: "unconfigured", summary: "Modem found — not configured" };

  if (modem.state === "failed") {
    return { ...base, mode: "failed",
      summary: `The modem reported a failure: ${modem.failedReason ?? "no reason given"}` };
  }
  if (bearer !== null) {
    return { ...base, mode: "connected", summary: `Connected to ${modem.operatorName ?? "the network"}` };
  }
  if (modem.registration === "home" || modem.registration === "roaming") {
    return { ...base, mode: "waiting", summary: "Registered — no connection yet" };
  }
  return { ...base, mode: "joining", summary: "Looking for a network" };
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run packages/yonder-core/src/net/modem/state.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/yonder-core/src/net/modem/state.ts packages/yonder-core/src/net/modem/state.test.ts
git commit -s -m "feat(modem): one state, computed from the device and not from the config"
```

---

## Task 5: The modem profile, and the renderer that writes it

**Files:**
- Create: `packages/yonder-core/src/net/modem/profiles.ts`
- Create: `packages/yonder-core/src/net/modem/profiles.test.ts`
- Modify: `packages/yonder-core/src/net/profiles.ts`
- Modify: `packages/yonder-core/src/net/renderer.ts`
- Test: `packages/yonder-core/src/net/profiles.test.ts`, `packages/yonder-core/src/net/renderer.test.ts`

**Interfaces:**
- Consumes: `DesiredProfile` and `Interfaces` from `../profiles.js`; `SecretStore`.
- Produces: `MODEM_CONNECTION = "yonder-modem"`, and
  `modemProfile(config, password: string | null, iface: string): DesiredProfile | null`.
  `Interfaces` gains `modem: string | null`. Tasks 9 and 11 rely on the connection name.

- [ ] **Step 1: Write the failing test**

`packages/yonder-core/src/net/modem/profiles.test.ts`:

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../schema/config.js";
import { MODEM_CONNECTION, modemProfile } from "./profiles.js";

const withModem = (over: Record<string, unknown>) => ({
  ...DEFAULT_CONFIG,
  network: { ...DEFAULT_CONFIG.network, modem: { ...DEFAULT_CONFIG.network.modem, ...over } },
});

const settings = (p: { settings: string[][] }) => Object.fromEntries(p.settings);

describe("modemProfile", () => {
  it("is null when no modem is configured", () => {
    expect(modemProfile(DEFAULT_CONFIG, null, "cdc-wdm0")).toBeNull();
  });

  it("builds a gsm connection bound to the control port", () => {
    // NetworkManager binds cdc-wdm0. wwan0 is where the traffic goes and is
    // not what a connection names.
    const p = modemProfile(withModem({ enabled: true, apn: "ereseller" }), null, "cdc-wdm0");
    expect(p?.name).toBe(MODEM_CONNECTION);
    expect(p?.type).toBe("gsm");
    expect(p?.ifname).toBe("cdc-wdm0");
    expect(settings(p!)["gsm.apn"]).toBe("ereseller");
  });

  it("comes up by itself, so a modem that drops comes back", () => {
    // R-CEL-06. Reconnection is NetworkManager's, not a loop of Yonder's.
    const p = modemProfile(withModem({ enabled: true, apn: "ereseller" }), null, "cdc-wdm0");
    expect(settings(p!)["connection.autoconnect"]).toBe("yes");
  });

  it("sets a route metric from the operator's order", () => {
    // R-NET-06's mechanism: ethernet 100, modem 700 were the measured
    // defaults, and the metric is what decides which default route wins.
    const p = modemProfile(withModem({ enabled: true, apn: "ereseller" }), null, "cdc-wdm0");
    expect(settings(p!)["ipv4.route-metric"]).toBe("700");
    expect(settings(p!)["ipv6.route-metric"]).toBe("700");
  });

  it("passes a username and password only when they are set", () => {
    const bare = modemProfile(withModem({ enabled: true, apn: "a" }), null, "cdc-wdm0");
    expect(settings(bare!)["gsm.password"]).toBeUndefined();
    const full = modemProfile(withModem({ enabled: true, apn: "a", username: "u" }), "pw", "cdc-wdm0");
    expect(settings(full!)["gsm.username"]).toBe("u");
    expect(settings(full!)["gsm.password"]).toBe("pw");
  });

  it("passes a dial string only when one is configured", () => {
    // Empty on every modem measured: a QMI or MBIM bearer has no dial step.
    const none = modemProfile(withModem({ enabled: true, apn: "a" }), null, "cdc-wdm0");
    expect(settings(none!)["gsm.number"]).toBeUndefined();
    const dialed = modemProfile(withModem({ enabled: true, apn: "a", dial: "*99#" }), null, "cdc-wdm0");
    expect(settings(dialed!)["gsm.number"]).toBe("*99#");
  });

  it("builds an ethernet connection for a modem the operator named", () => {
    const p = modemProfile(
      withModem({ enabled: true, mode: "appliance", interface: "usb0" }), null, "usb0");
    expect(p?.type).toBe("ethernet");
    expect(p?.ifname).toBe("usb0");
    expect(settings(p!)["ipv4.method"]).toBe("auto");
  });
});
```

Append to `packages/yonder-core/src/net/profiles.test.ts`:

```ts
import { MODEM_CONNECTION } from "./modem/profiles.js";

describe("desiredProfiles with a modem", () => {
  it("writes the modem profile when a modem interface was found", () => {
    const config = {
      ...DEFAULT_CONFIG,
      network: {
        ...DEFAULT_CONFIG.network,
        modem: { ...DEFAULT_CONFIG.network.modem, enabled: true, apn: "ereseller" },
      },
    };
    const names = desiredProfiles(config, fakeSecrets(), {
      wifi: "wlan0", ethernet: "eth0", modem: "cdc-wdm0",
    }).map((p) => p.name);
    expect(names).toContain(MODEM_CONNECTION);
  });

  it("writes nothing for a modem on a board that has none", () => {
    const names = desiredProfiles(DEFAULT_CONFIG, fakeSecrets(), {
      wifi: "wlan0", ethernet: "eth0", modem: null,
    }).map((p) => p.name);
    expect(names).not.toContain(MODEM_CONNECTION);
  });
});
```

> `fakeSecrets()` already exists in that file — reuse it rather than defining a second one.

- [ ] **Step 2: Run both and watch them fail**

Run: `npx vitest run packages/yonder-core/src/net/modem/profiles.test.ts packages/yonder-core/src/net/profiles.test.ts`
Expected: FAIL — no `./modem/profiles.js`, and `Interfaces` has no `modem`.

- [ ] **Step 3: Write the modem profile**

`packages/yonder-core/src/net/modem/profiles.ts`:

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
import type { Config } from "../../schema/config.js";
import type { DesiredProfile } from "../profiles.js";

export const MODEM_CONNECTION = "yonder-modem";

/**
 * Route metrics, generated from `network.priority` (R-NET-06).
 *
 * The numbers are NetworkManager's own defaults for these connection types,
 * read off a board: ethernet 100, gsm 700. Keeping them means a Yonder-written
 * profile sorts against a connection Yonder did not write exactly as it would
 * have anyway, which matters on a board where an operator has added one.
 */
const METRIC_BY_RANK = [100, 700, 800, 900];

export function metricFor(config: Config, iface: "ethernet" | "modem" | "wifi_client"): number {
  const rank = config.network.priority.indexOf(iface);
  return METRIC_BY_RANK[rank === -1 ? METRIC_BY_RANK.length - 1 : rank] ?? 900;
}

/**
 * The modem's connection, in whichever of its two forms applies.
 *
 * `auto` is a `gsm` connection bound to the modem's **control** port —
 * `cdc-wdm0` on the measured board, not `wwan0`, which is where the address
 * and every byte end up. NetworkManager reaches the modem through
 * ModemManager; nothing here drives ModemManager itself.
 *
 * `appliance` is an ordinary ethernet connection on an adapter the operator
 * named, because a modem that dials for itself is a network adapter as far as
 * this board is concerned (R-CEL-11).
 *
 * `connection.autoconnect yes` is what satisfies R-CEL-06: a modem that drops
 * and returns is NetworkManager's business to reconnect, not a loop of
 * Yonder's. Rule 4's spirit as much as its letter — Yonder does not build
 * control loops it can delegate.
 */
export function modemProfile(
  config: Config,
  password: string | null,
  iface: string,
): DesiredProfile | null {
  const modem = config.network.modem;
  if (!modem.enabled) return null;

  const metric = String(metricFor(config, "modem"));

  if (modem.mode === "appliance") {
    return {
      name: MODEM_CONNECTION,
      type: "ethernet",
      ifname: iface,
      settings: [
        ["ipv4.method", "auto"],
        ["ipv4.route-metric", metric],
        ["ipv6.route-metric", metric],
        ["connection.autoconnect", "yes"],
      ],
    };
  }

  const settings: string[][] = [
    ["ipv4.method", "auto"],
    ["ipv4.route-metric", metric],
    ["ipv6.route-metric", metric],
    ["connection.autoconnect", "yes"],
  ];
  // No default APN, ever. Guessing one is what R-CEL-09 forbids, and the
  // measured cost of guessing wrong is a link that reports success and moves
  // nothing.
  if (modem.apn !== null) settings.unshift(["gsm.apn", modem.apn]);
  if (modem.username !== null) settings.push(["gsm.username", modem.username]);
  if (password !== null) settings.push(["gsm.password", password]);
  // Only when configured. A QMI or MBIM bearer has no dial step and the link
  // that worked had this empty.
  if (modem.dial !== null) settings.push(["gsm.number", modem.dial]);

  return { name: MODEM_CONNECTION, type: "gsm", ifname: iface, settings };
}
```

- [ ] **Step 4: Widen `Interfaces` and `desiredProfiles`**

In `packages/yonder-core/src/net/profiles.ts`:

```ts
export interface Interfaces {
  wifi: string | null;
  ethernet: string | null;
  /**
   * The modem's control port — `cdc-wdm0`, not `wwan0` — or the adapter the
   * operator named when the modem is one that dials for itself.
   */
  modem: string | null;
}
```

and at the end of `desiredProfiles`, before `return out;`:

```ts
  if (ifaces.modem !== null) {
    const password = config.network.modem.password === null
      ? null
      : secrets.resolve(config.network.modem.password);
    const modem = modemProfile(config, password, ifaces.modem);
    if (modem !== null) out.push(modem);
  }
```

with `import { MODEM_CONNECTION, modemProfile } from "./modem/profiles.js";` at the top.

- [ ] **Step 5: Teach the renderer the connection**

In `packages/yonder-core/src/net/renderer.ts`, add `MODEM_CONNECTION` to the import from
`./profiles.js` and to `OWNED`:

```ts
const OWNED = new Set([AP_CONNECTION, CLIENT_CONNECTION, ETHERNET_CONNECTION, MODEM_CONNECTION]);
```

Find where the renderer builds its `Interfaces` from the device list and add the modem.
The device type NetworkManager reports for a modem is `gsm`; for an operator-named
appliance it is whatever that adapter is, so the configured name wins:

```ts
/**
 * The modem's device, if this board has one.
 *
 * A named appliance wins outright: the operator has said which adapter it is,
 * and no amount of device-type inspection improves on being told (R-CEL-11).
 * Otherwise it is the `gsm` device, which is NetworkManager's own type for a
 * modem it reaches through ModemManager, and whose name is a control port.
 */
function modemDevice(config: Config, devices: DeviceInfo[]): string | null {
  const modem = config.network.modem;
  if (!modem.enabled) return null;
  if (modem.mode === "appliance") return modem.interface;
  return devices.find((d) => d.type === "gsm")?.device ?? null;
}
```

and pass `modem: modemDevice(config, devices)` where `Interfaces` is constructed.

- [ ] **Step 6: Add a renderer test**

Append to `packages/yonder-core/src/net/renderer.test.ts`:

```ts
it("creates the modem connection and never deletes a connection it does not own", async () => {
  // OWNED is the list of connections this renderer will delete. A modem
  // connection missing from it would be created and then removed on the very
  // next render as a stray.
  const config = {
    ...DEFAULT_CONFIG,
    network: {
      ...DEFAULT_CONFIG.network,
      modem: { ...DEFAULT_CONFIG.network.modem, enabled: true, apn: "ereseller" },
    },
  };
  const { renderer, calls } = harness({
    devices: [
      { device: "wlan0", type: "wifi", state: "disconnected", connection: "" },
      { device: "cdc-wdm0", type: "gsm", state: "disconnected", connection: "" },
    ],
  });
  await renderer.render(config);
  const added = calls.filter((c) => c.includes("add")).map((c) => c.join(" "));
  expect(added.some((c) => c.includes("yonder-modem") && c.includes("gsm"))).toBe(true);
  expect(calls.some((c) => c.includes("delete") && c.includes("yonder-modem"))).toBe(false);
});
```

> `harness(...)` already exists in that file. Match its existing option names when
> supplying the device list; if it does not take one, extend it rather than building a
> second harness.

- [ ] **Step 7: Run everything and watch it pass**

Run: `npx vitest run packages/yonder-core/src/net/`
Expected: PASS, including the pre-existing profile and renderer suites.

- [ ] **Step 8: Commit**

```bash
git add packages/yonder-core/src/net/
git commit -s -m "feat(modem): a gsm connection on the control port, and a named adapter — R-CEL-11"
```

---

## Task 6: Byte counters

**Files:**
- Create: `packages/yonder-core/src/net/reach/counters.ts`
- Create: `packages/yonder-core/src/net/reach/counters.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:

```ts
export interface Counters { rx: number; tx: number }
export type CounterReader = (device: string) => Counters | null
export const systemCounters: CounterReader
export function movement(before: Counters, after: Counters): { rx: number; tx: number }
export function looksDead(before: Counters, after: Counters): boolean
```

Tasks 7 and 8 consume `CounterReader` and `looksDead`.

**Why counters at all.** They are the signature that exposed the failure the whole
milestone is built around: `TX 56842 / RX 1374` on a link reporting itself connected. The
kernel keeps them whether or not anyone reads them, so watching them costs nothing on a
metered link (R-CEL-09, R-NET-13).

- [ ] **Step 1: Write the failing test**

`packages/yonder-core/src/net/reach/counters.test.ts`:

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { looksDead, movement, systemCounters } from "./counters.js";

describe("movement", () => {
  it("reports the difference between two readings", () => {
    expect(movement({ rx: 100, tx: 200 }, { rx: 150, tx: 260 })).toEqual({ rx: 50, tx: 60 });
  });

  it("treats a counter that went backwards as no movement", () => {
    // A 32-bit counter wraps, and an interface that was torn down and rebuilt
    // starts again at zero. Neither is traffic, and a negative delta read as
    // movement would be.
    expect(movement({ rx: 100, tx: 200 }, { rx: 0, tx: 0 })).toEqual({ rx: 0, tx: 0 });
  });
});

describe("looksDead", () => {
  it("is true when traffic is leaving and nothing is coming back", () => {
    // The measured signature of a wrong APN: 56842 bytes out, 1374 in.
    expect(looksDead({ rx: 1374, tx: 56842 }, { rx: 1374, tx: 71826 })).toBe(true);
  });

  it("is false when both counters are moving", () => {
    expect(looksDead({ rx: 100, tx: 100 }, { rx: 900, tx: 900 })).toBe(false);
  });

  it("is false when nothing is moving at all", () => {
    // An idle link is not a dead one. This is exactly the distinction the
    // fallback watchdog could not make (K-33) and the reason it is drawn here
    // rather than left to a caller.
    expect(looksDead({ rx: 100, tx: 100 }, { rx: 100, tx: 100 })).toBe(false);
  });

  it("is false when only a trickle went out", () => {
    // A handful of bytes is a stray broadcast, not an attempt at traffic.
    expect(looksDead({ rx: 0, tx: 0 }, { rx: 0, tx: 120 })).toBe(false);
  });
});

describe("systemCounters", () => {
  it("answers null for a device that does not exist, rather than throwing", () => {
    expect(systemCounters("definitely-not-a-device")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run packages/yonder-core/src/net/reach/counters.test.ts`
Expected: FAIL — `Cannot find module './counters.js'`.

- [ ] **Step 3: Write it**

`packages/yonder-core/src/net/reach/counters.ts`:

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from "node:fs";

export interface Counters { rx: number; tx: number }

/** Injected, like every other reading in this daemon, so a test reaches no /sys. */
export type CounterReader = (device: string) => Counters | null;

/**
 * How many bytes an interface has carried, from the kernel's own counters.
 *
 * Free, in the sense that matters here: these are maintained whether or not
 * anything reads them, so watching a metered cellular link costs the operator
 * nothing (R-CEL-09). Null for a device that is not there — a board with no
 * modem is an ordinary board.
 */
export const systemCounters: CounterReader = (device) => {
  try {
    const at = (f: string) =>
      Number(readFileSync(`/sys/class/net/${device}/statistics/${f}`, "utf8").trim());
    const rx = at("rx_bytes");
    const tx = at("tx_bytes");
    return Number.isFinite(rx) && Number.isFinite(tx) ? { rx, tx } : null;
  } catch {
    return null;
  }
};

/**
 * The difference between two readings, floored at zero.
 *
 * A counter can go backwards — a 32-bit one wraps, and an interface torn down
 * and rebuilt starts again at zero — and a negative delta read as movement
 * would be a link declared healthy by arithmetic.
 */
export function movement(before: Counters, after: Counters): Counters {
  return { rx: Math.max(0, after.rx - before.rx), tx: Math.max(0, after.tx - before.tx) };
}

/**
 * Bytes that must leave before silence is evidence of anything.
 *
 * A few hundred bytes is a stray broadcast. This is deliberately larger than
 * one packet and far smaller than anything a working link sends in a second.
 */
const ATTEMPT_BYTES = 1024;

/**
 * Traffic going out with nothing coming back.
 *
 * **An idle link is not a dead one**, and telling them apart is the whole
 * point: the fallback watchdog rejected byte counters for exactly that reason
 * (K-33), and the answer is not to look at one counter but at both. Nothing
 * moving in either direction says nothing at all, and this returns false.
 */
export function looksDead(before: Counters, after: Counters): boolean {
  const moved = movement(before, after);
  return moved.tx >= ATTEMPT_BYTES && moved.rx === 0;
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run packages/yonder-core/src/net/reach/counters.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/yonder-core/src/net/reach/
git commit -s -m "feat(reach): the counters that told the truth when everything else lied"
```

---

## Task 7: The probe, and what stands down

**Files:**
- Create: `packages/yonder-core/src/net/reach/probe.ts`
- Create: `packages/yonder-core/src/net/reach/probe.test.ts`
- Create: `packages/yonder-core/src/net/reach/standing.ts`
- Create: `packages/yonder-core/src/net/reach/standing.test.ts`

**Interfaces:**
- Consumes: `Counters`, `CounterReader`, `looksDead` (Task 6); `CommandRunner`; `Clock`.
- Produces:

```ts
export type PathName = "ethernet" | "modem" | "wifi_client"
export type PathStanding = "in-use" | "standing-by" | "testing" | "no-route-out" | "absent"
export interface PathReport {
  path: PathName; device: string | null; standing: PathStanding;
  since: number | null; detail: string;
}
export interface ReachState { paths: PathReport[]; inUse: PathName | null; carrying: boolean }
export type Probe = (device: string) => Promise<boolean>
export function commandProbe(runner: CommandRunner): Probe
export const FAILURES_TO_STAND_DOWN = 3
export const SUCCESSES_TO_RETURN = 1
export class Standing {
  constructor(opts: { clock: Clock; log?: (line: string) => void })
  record(path: PathName, reached: boolean): PathStanding
  standingOf(path: PathName): PathStanding
  since(path: PathName): number | null
}
```

Tasks 8 and 9 consume `Standing` and `ReachState`.

- [ ] **Step 1: Write the failing tests**

`packages/yonder-core/src/net/reach/probe.test.ts`:

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { commandProbe } from "./probe.js";
import type { CommandRunner } from "../runner.js";

describe("commandProbe", () => {
  it("sends real traffic out of the named device", async () => {
    // Bound to the device, not merely to the routing table: the question is
    // whether *this* path works, and the default route may be another one.
    const calls: string[][] = [];
    const runner: CommandRunner = async (argv) => {
      calls.push(argv);
      return { code: 0, stdout: "", stderr: "" };
    };
    expect(await commandProbe(runner)("wwan0")).toBe(true);
    expect(calls[0]).toContain("wwan0");
  });

  it("is false when the command fails", async () => {
    const runner: CommandRunner = async () => ({ code: 1, stdout: "", stderr: "timeout" });
    expect(await commandProbe(runner)("wwan0")).toBe(false);
  });

  it("is false rather than throwing when the binary is missing", async () => {
    const runner: CommandRunner = async () => ({ code: 127, stdout: "", stderr: "not found" });
    expect(await commandProbe(runner)("wwan0")).toBe(false);
  });
});
```

`packages/yonder-core/src/net/reach/standing.test.ts`:

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { FAILURES_TO_STAND_DOWN, SUCCESSES_TO_RETURN, Standing } from "./standing.js";

function fixedClock(start = 1_000) {
  let now = start;
  return { clock: { now: () => now, setTimer: () => 0, clearTimer: () => {} },
    advance: (ms: number) => { now += ms; } };
}

describe("Standing", () => {
  it("does not move on a single failure", () => {
    // A carrier hiccup must not move an aircraft. This is the whole reason
    // hysteresis exists here rather than a bare boolean.
    const { clock } = fixedClock();
    const s = new Standing({ clock });
    s.record("modem", false);
    expect(s.standingOf("modem")).not.toBe("no-route-out");
  });

  it("stands a path down after repeated failure", () => {
    const { clock } = fixedClock();
    const s = new Standing({ clock });
    for (let i = 0; i < FAILURES_TO_STAND_DOWN; i++) s.record("ethernet", false);
    expect(s.standingOf("ethernet")).toBe("no-route-out");
  });

  it("brings it back faster than it took it down", () => {
    // Slow to move, quick to return: the cost of being wrong in one direction
    // is a path nobody is using, and in the other it is an aircraft.
    const { clock } = fixedClock();
    const s = new Standing({ clock });
    for (let i = 0; i < FAILURES_TO_STAND_DOWN; i++) s.record("ethernet", false);
    for (let i = 0; i < SUCCESSES_TO_RETURN; i++) s.record("ethernet", true);
    expect(s.standingOf("ethernet")).not.toBe("no-route-out");
    expect(SUCCESSES_TO_RETURN).toBeLessThan(FAILURES_TO_STAND_DOWN);
  });

  it("forgets the failures once a path succeeds", () => {
    const { clock } = fixedClock();
    const s = new Standing({ clock });
    s.record("modem", false);
    s.record("modem", false);
    s.record("modem", true);
    s.record("modem", false);
    expect(s.standingOf("modem")).not.toBe("no-route-out");
  });

  it("records when a path was stood down", () => {
    const { clock, advance } = fixedClock();
    const s = new Standing({ clock });
    advance(5_000);
    for (let i = 0; i < FAILURES_TO_STAND_DOWN; i++) s.record("ethernet", false);
    expect(s.since("ethernet")).toBe(6_000);
  });

  it("writes a sentence naming what happened, both ways", () => {
    // R-NET-13: an aircraft that changes how it is reachable while nobody is
    // watching must leave a trail that explains itself.
    const { clock } = fixedClock();
    const lines: string[] = [];
    const s = new Standing({ clock, log: (l) => lines.push(l) });
    for (let i = 0; i < FAILURES_TO_STAND_DOWN; i++) s.record("ethernet", false);
    s.record("ethernet", true);
    expect(lines.some((l) => /ethernet.*stood down/i.test(l))).toBe(true);
    expect(lines.some((l) => /ethernet.*back/i.test(l))).toBe(true);
  });

  it("says nothing while nothing changes", () => {
    // A log line per probe would bury the two that matter.
    const { clock } = fixedClock();
    const lines: string[] = [];
    const s = new Standing({ clock, log: (l) => lines.push(l) });
    for (let i = 0; i < 20; i++) s.record("modem", true);
    expect(lines).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run packages/yonder-core/src/net/reach/`
Expected: FAIL — neither module exists.

- [ ] **Step 3: Write the probe**

`packages/yonder-core/src/net/reach/probe.ts`:

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
import type { CommandRunner } from "../runner.js";

/** Does this path complete a request? Injected, so tests reach no network. */
export type Probe = (device: string) => Promise<boolean>;

/** Seconds before a probe is a failure. Short: a link this slow is not usable. */
const TIMEOUT_S = 8;

/**
 * The active test, bound to one interface.
 *
 * **Bound to the device, not left to the routing table.** The question is
 * whether *this* path works, and the default route is usually another one —
 * the whole point is to find out about a path nothing is currently using.
 *
 * `curl` rather than `ping`: a carrier that drops ICMP is common and would
 * read as a dead link, and the thing an operator cares about is whether an
 * ordinary request completes. `--head` so nothing is downloaded on a metered
 * link, and a plain HTTP request so a broken clock cannot fail it the way a
 * certificate check would.
 *
 * Any non-zero exit is a failure, 127 included: a board with no curl cannot
 * establish that a path works, and reporting "reachable" because the test
 * could not run is the direction that costs an aircraft.
 */
export function commandProbe(runner: CommandRunner): Probe {
  return async (device) => {
    const result = await runner([
      "curl", "--silent", "--head", "--output", "/dev/null",
      "--interface", device,
      "--max-time", String(TIMEOUT_S),
      "http://connectivity-check.ubuntu.com/",
    ]);
    return result.code === 0;
  };
}
```

- [ ] **Step 4: Write the standing**

`packages/yonder-core/src/net/reach/standing.ts`:

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
import type { Clock } from "../../apply/types.js";

export type PathName = "ethernet" | "modem" | "wifi_client";

export type PathStanding =
  | "in-use"        // traffic is leaving this way
  | "standing-by"   // works, but something above it in the order is in use
  | "testing"       // stopped receiving; being tested right now
  | "no-route-out"  // stood down: reached nothing when tested
  | "absent";       // no such interface on this board

export interface PathReport {
  path: PathName;
  device: string | null;
  standing: PathStanding;
  /** When this path was stood down, epoch ms. Null when it has not been. */
  since: number | null;
  /** One sentence for an operator, in Yonder's words. */
  detail: string;
}

export interface ReachState {
  paths: PathReport[];
  inUse: PathName | null;
  /** True when some path is carrying traffic. The watchdog's question (K-33). */
  carrying: boolean;
}

/**
 * How many consecutive failures stand a path down, and how many successes
 * bring it back.
 *
 * **These are provisional and Task 11 replaces them with measured values.**
 * They are named constants rather than literals so that the measurement has
 * one place to land, and the asymmetry — slow to move, quick to return — is
 * the part that is not provisional: being wrong about a path being dead costs
 * an aircraft its link, and being wrong about it being alive costs one more
 * probe.
 */
export const FAILURES_TO_STAND_DOWN = 3;
export const SUCCESSES_TO_RETURN = 1;

const WORDS: Record<PathName, string> = {
  ethernet: "ethernet",
  modem: "cellular",
  wifi_client: "Wi-Fi",
};

interface Record_ { failures: number; successes: number; down: boolean; since: number | null }

/**
 * Which paths participate, and the hysteresis that decides.
 *
 * **This never reorders anything.** `network.priority` is the only statement
 * of preference and `config.yaml` remains its only writer (R-NET-13). All this
 * decides is whether a path is in the running at all, which is what lets the
 * mechanism exist without a second writer of configuration.
 */
export class Standing {
  private readonly clock: Clock;
  private readonly log: (line: string) => void;
  private readonly records = new Map<PathName, Record_>();

  constructor(opts: { clock: Clock; log?: (line: string) => void }) {
    this.clock = opts.clock;
    this.log = opts.log ?? (() => {});
  }

  private recordFor(path: PathName): Record_ {
    const existing = this.records.get(path);
    if (existing !== undefined) return existing;
    const fresh: Record_ = { failures: 0, successes: 0, down: false, since: null };
    this.records.set(path, fresh);
    return fresh;
  }

  /** Fold one probe result in. Returns the standing that results. */
  record(path: PathName, reached: boolean): PathStanding {
    const r = this.recordFor(path);
    if (reached) {
      r.failures = 0;
      r.successes += 1;
      if (r.down && r.successes >= SUCCESSES_TO_RETURN) {
        r.down = false;
        r.since = null;
        this.log(`network: ${WORDS[path]} is reaching the internet again and is back in use`);
      }
    } else {
      r.successes = 0;
      r.failures += 1;
      if (!r.down && r.failures >= FAILURES_TO_STAND_DOWN) {
        r.down = true;
        r.since = this.clock.now();
        this.log(
          `network: ${WORDS[path]} reached nothing on ${r.failures} tries and has been stood down; ` +
          `traffic will use the next path that works`,
        );
      }
    }
    return this.standingOf(path);
  }

  standingOf(path: PathName): PathStanding {
    return this.records.get(path)?.down === true ? "no-route-out" : "standing-by";
  }

  since(path: PathName): number | null {
    return this.records.get(path)?.since ?? null;
  }
}
```

- [ ] **Step 5: Run them and watch them pass**

Run: `npx vitest run packages/yonder-core/src/net/reach/`
Expected: PASS, 13 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/yonder-core/src/net/reach/
git commit -s -m "feat(reach): stand a dead path down, slowly, and bring it back quickly — R-NET-13"
```

---

## Task 8: The watchdog stops trusting an address

**Files:**
- Modify: `packages/yonder-core/src/net/watchdog.ts`
- Modify: `packages/yonder-core/src/net/watchdog.test.ts`
- Modify: `docs/known-issues.md`

**Interfaces:**
- Consumes: `looksDead`, `CounterReader` (Task 6).
- Produces: `FallbackWatchdogOptions` gains `carrying?: () => Promise<boolean>`.

**This task must leave the watchdog strictly more willing to raise the access point.**
Every existing test in `watchdog.test.ts` must still pass unchanged. Do not relax one.

- [ ] **Step 1: Write the failing test**

Append to `packages/yonder-core/src/net/watchdog.test.ts`:

```ts
it("raises the access point when the only interface holds an address and reaches nothing", async () => {
  // K-33. A cellular link with a wrong APN registers, attaches, takes an
  // address and installs a route while completing no request — measured, and
  // the reason this check could not stay as it was.
  let raised = false;
  const watchdog = new FallbackWatchdog({
    client: fakeClient([{ device: "wwan0", address: "10.31.95.33/30" }]),
    clock: fixedClock(),
    config: DEFAULT_CONFIG,
    apUp: async () => { raised = true; },
    carrying: async () => false,
  });
  expect(await watchdog.check()).toBe(false);
  await watchdog.fireNow();
  expect(raised).toBe(true);
});

it("leaves a working link alone", async () => {
  let raised = false;
  const watchdog = new FallbackWatchdog({
    client: fakeClient([{ device: "wwan0", address: "10.31.95.33/30" }]),
    clock: fixedClock(),
    config: DEFAULT_CONFIG,
    apUp: async () => { raised = true; },
    carrying: async () => true,
  });
  expect(await watchdog.check()).toBe(true);
  await watchdog.fireNow();
  expect(raised).toBe(false);
});

it("still raises the access point when it cannot tell, with no carrying check wired", async () => {
  // Absent means "nobody told me", and the safe direction is unchanged: on
  // any doubt the access point comes up.
  let raised = false;
  const watchdog = new FallbackWatchdog({
    client: fakeClient([]),
    clock: fixedClock(),
    config: DEFAULT_CONFIG,
    apUp: async () => { raised = true; },
  });
  await watchdog.fireNow();
  expect(raised).toBe(true);
});
```

> `fakeClient`, `fixedClock` and a way to fire the timer already exist in that file. If the
> existing tests drive `fire()` through the injected clock rather than a `fireNow()`
> helper, use whatever they use and drop `fireNow` from these three.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run packages/yonder-core/src/net/watchdog.test.ts`
Expected: FAIL — `carrying` is not an option, and `check()` returns true for an interface
holding an address regardless.

- [ ] **Step 3: Narrow the check**

In `packages/yonder-core/src/net/watchdog.ts`, add to `FallbackWatchdogOptions`:

```ts
  /**
   * Whether any path is actually carrying traffic.
   *
   * R-NET-07 has always said "carries traffic". This check implemented it as
   * "holds an address" because a connected but idle Ethernet link carries
   * none and is perfectly reachable — sound reasoning, and broken by
   * cellular: a modem with a wrong APN registers, attaches, takes an address
   * and installs a route while completing no request. That satisfied the old
   * test, and a device configured that way from the boot partition with no
   * other path never raised its access point (K-33).
   *
   * **Absent means "nobody told me", and the answer is unchanged from before
   * this existed: an address is accepted.** A daemon assembled without a
   * reach monitor must not become one that raises an access point on a
   * working device.
   */
  carrying?: () => Promise<boolean>;
```

and in `check()`, after the address test succeeds:

```ts
  async check(): Promise<boolean> {
    const apAddress = this.opts.config.network.ap.address.split("/")[0];
    try {
      const active = await this.opts.client.activeIpv4();
      const holdsAddress = active.some(
        (a) =>
          a.device !== "lo" &&
          !a.address.startsWith("127.") &&
          a.address.split("/")[0] !== apAddress,
      );
      if (!holdsAddress) return false;
      // An address is necessary and, since cellular, no longer sufficient.
      if (this.opts.carrying === undefined) return true;
      return await this.opts.carrying();
    } catch (e) {
      this.log(`fallback: cannot determine reachability (${(e as Error).message}); assuming none`);
      return false;
    }
  }
```

- [ ] **Step 4: Run the whole watchdog suite**

Run: `npx vitest run packages/yonder-core/src/net/watchdog.test.ts`
Expected: PASS — the three new tests and **every pre-existing test, unchanged.** If an
existing test needed editing, stop: that means the watchdog became less willing to raise
the access point, which is rule 6.

- [ ] **Step 5: Close K-33**

In `docs/known-issues.md`, change K-33's heading to
`### K-33 · ~~The fallback watchdog accepts an address as proof of reachability~~ — CLOSED`
and set **Status:** Closed, naming this commit.

- [ ] **Step 6: Commit**

```bash
npm test
git add packages/yonder-core/src/net/watchdog.ts packages/yonder-core/src/net/watchdog.test.ts docs/known-issues.md
git commit -s -m "fix(net): an address is not a way back — K-33, R-NET-07"
```

---

## Task 9: The daemon's routes, and the wiring

**Files:**
- Modify: `packages/yonder-core/src/daemon/routes.ts`
- Modify: `packages/yonder-core/src/daemon/routes.test.ts`
- Modify: `packages/yonder-core/src/daemon/server.ts`
- Modify: `packages/yonder-core/src/daemon/server.wiring.test.ts`

**Interfaces:**
- Consumes: `ModemState` (Task 4), `ReachState` (Task 7), `MmcliClient` (Task 3).
- Produces: `RouterDeps` gains `modemState?: () => Promise<ModemState>` and
  `reachState?: () => Promise<ReachState>`. `GET /modem/state` and `GET /reach/state`.
  M3b's contrib nodes call these two paths.

- [ ] **Step 1: Write the failing test**

Append to `packages/yonder-core/src/daemon/routes.test.ts`:

```ts
it("serves the modem state", async () => {
  const router = createRouter({ ...baseDeps(), modemState: async () => ({
    mode: "connected", summary: "Connected to Dark Star",
    operator: "Dark Star", technology: "lte", registration: "home",
    apn: "ereseller", address: "10.31.95.33", mtu: 1430,
    signal: { rssi: -71, rsrq: -9, rsrp: -100, snr: 19 },
    ports: ["cdc-wdm0 (mbim)", "wwan0 (net)"], reportsSignal: true,
  }) });
  const res = await router("GET", "/modem/state", undefined);
  expect(res.status).toBe(200);
  expect((res.body as { operator: string }).operator).toBe("Dark Star");
});

it("says so plainly when this daemon has no modem layer to ask", async () => {
  // The same shape /net/state uses: a 503 naming the absence, never an empty
  // body a page would render as "no signal".
  const res = await createRouter(baseDeps())("GET", "/modem/state", undefined);
  expect(res.status).toBe(503);
});

it("serves which way out is in use", async () => {
  const router = createRouter({ ...baseDeps(), reachState: async () => ({
    inUse: "modem", carrying: true,
    paths: [
      { path: "ethernet", device: "eth0", standing: "no-route-out", since: 1_000, detail: "Stood down" },
      { path: "modem", device: "wwan0", standing: "in-use", since: null, detail: "Carrying traffic" },
    ],
  }) });
  const res = await router("GET", "/reach/state", undefined);
  expect(res.status).toBe(200);
  expect((res.body as { inUse: string }).inUse).toBe("modem");
});

it("never puts the modem password in a response", async () => {
  // R-SEC-10. The modem state is assembled from the device, not the config,
  // and this asserts the boundary rather than trusting it.
  const router = createRouter({ ...baseDeps(), modemState: async () => ({
    mode: "connected", summary: "Connected", operator: null, technology: null,
    registration: null, apn: "ereseller", address: null, mtu: null,
    signal: { rssi: null, rsrq: null, rsrp: null, snr: null },
    ports: [], reportsSignal: true,
  }) });
  const res = await router("GET", "/modem/state", undefined);
  expect(JSON.stringify(res.body)).not.toMatch(/password|secret/i);
});
```

> `baseDeps()` already exists in that file — reuse it.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run packages/yonder-core/src/daemon/routes.test.ts`
Expected: FAIL — both routes fall through to the 404.

- [ ] **Step 3: Add the routes**

In `packages/yonder-core/src/daemon/routes.ts`, add to `RouterDeps`:

```ts
  /** What the modem says about itself. Injected, so this router knows no mmcli. */
  modemState?: () => Promise<ModemState>;
  /** Which way out is in use, and which paths have been stood down. */
  reachState?: () => Promise<ReachState>;
```

and beside the `/net/state` handler:

```ts
      if (method === "GET" && path === "/modem/state") {
        if (deps.modemState === undefined) {
          say("GET /modem/state: there is no modem layer on this daemon to ask");
          return { status: 503, body: { error: "this device cannot report a modem" } };
        }
        return { status: 200, body: await deps.modemState() };
      }

      if (method === "GET" && path === "/reach/state") {
        if (deps.reachState === undefined) {
          say("GET /reach/state: there is no reach monitor on this daemon to ask");
          return { status: 503, body: { error: "this device cannot report its way out" } };
        }
        return { status: 200, body: await deps.reachState() };
      }
```

- [ ] **Step 4: Wire it in `server.ts`**

In `buildRenderers`, build the mmcli client from the same runner:

```ts
  // The same runner as the nmcli client, for the reason NmcliClient records
  // about rfkill: two runners that must agree can stop agreeing, and the
  // failure mode is a test reaching a real mmcli on the machine running it.
  const modemClient = new MmcliClient(opts.runner ?? systemRunner, opts.trace ?? trace);
```

and return it alongside `client`. Then where `createRouter` is called, pass:

```ts
    modemState: async () => {
      const config = loadConfig(configPath);
      const paths = await modemClient.modems();
      if (paths.length === 0) return modemState(config, null, null, NO_SIGNAL);
      const modem = await modemClient.modem(paths[0]);
      const bearer = await modemClient.connectedBearer(modem);
      const signal = await modemClient.signal(modem.path);
      return modemState(config, modem, bearer, signal);
    },
```

and give the watchdog its `carrying` check from the reach monitor built in the same place.

- [ ] **Step 5: Arm signal when the link comes up**

R-CEL-10: the detailed numbers do not exist until polling is set. In `NetworkRenderer`,
after the modem connection is raised, arm it — and treat a failure as a log line, never as
a failed render:

```ts
  // R-CEL-10. A modem reports only a coarse percentage until this is set, and
  // that percentage read 60 and then 29 on a board whose real numbers moved
  // three dB. Failing to arm it costs detail on a page; failing the render
  // would cost the link, so this can only ever log.
  try {
    await this.modem?.armSignal(path, SIGNAL_POLL_SECONDS);
  } catch (e) {
    this.log(`modem: could not turn on detailed signal reporting (${(e as Error).message})`);
  }
```

with `export const SIGNAL_POLL_SECONDS = 2;` beside `RADIO_POLL_MS`.

- [ ] **Step 6: Run everything**

Run: `npm test`
Expected: PASS across every workspace.

- [ ] **Step 7: Commit**

```bash
git add packages/yonder-core/src/daemon/ packages/yonder-core/src/net/
git commit -s -m "feat(daemon): serve the modem and the way out, and arm signal at connect"
```

---

## Task 10: Install it, and leave the link off

**Files:**
- Modify: `installer/roles/10-base.sh`
- Create: `installer/roles/40-modem.sh`
- Test: `packages/yonder-core/src/installer.test.ts`

**Interfaces:**
- Consumes: `ensure_pkgs`, `run`, `log` from `installer/lib/common.sh`.
- Produces: a board with ModemManager installed and a modem claimed.

- [ ] **Step 1: Write the failing test**

Append to `packages/yonder-core/src/installer.test.ts`, matching however that file already
reads role scripts:

```ts
it("installs ModemManager from Debian, with no payload", () => {
  // ZeroTier needed a payload because it is not in Debian. ModemManager is,
  // and the installer already installs Debian packages in a chroot with a
  // network, so none of that machinery applies here.
  expect(readRole("10-base.sh")).toMatch(/ensure_pkgs\s+modemmanager/);
});

it("triggers udev and restarts ModemManager, over every subsystem", () => {
  // The rules that tag modem ports ship with the package, so ports enumerated
  // before it was installed carry no tag and mmcli answers "No modems were
  // found". A subsystem-filtered trigger misses usbmisc, where the control
  // port lives, and leaves a modem claimed AT-only with its net port ignored.
  const role = readRole("40-modem.sh");
  expect(role).toMatch(/udevadm trigger/);
  expect(role).not.toMatch(/udevadm trigger.*--subsystem-match/);
  expect(role).toMatch(/systemctl restart ModemManager/);
});

it("does not bring a link up", () => {
  // R-CFG-08 and R-VPN-05's principle: installing support for something is not
  // configuring it. A device carries no cellular connection until config.yaml
  // asks for one.
  expect(readRole("40-modem.sh")).not.toMatch(/nmcli connection (add|up)/);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run packages/yonder-core/src/installer.test.ts`
Expected: FAIL — no `modemmanager` in `10-base.sh`, and no `40-modem.sh`.

- [ ] **Step 3: Add the package**

In `installer/roles/10-base.sh`, after the `avahi-daemon` block:

```sh
# The modem service, from Debian.
#
# ZeroTier needed an offline payload, a pinned fingerprint and a signature
# check because it is not in Debian. This is: `modemmanager 1.24.0-1+deb13u1`
# in trixie/main, installed in the same chroot, with a network, as every other
# package here. None of that machinery applies.
#
# It is what makes a modem visible at all. Without it a board with a modem
# plugged in has a `wwan0` link that NetworkManager cannot see and does not
# list - inert rather than broken, and with nothing saying so.
ensure_pkgs modemmanager
```

- [ ] **Step 4: Write the role**

`installer/roles/40-modem.sh`:

```sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Make an already-plugged modem visible, and leave the link off.
# shellcheck shell=sh

# The whole reason this role exists.
#
# ModemManager's udev rules ship inside the package, so any port that
# enumerated before the install carries no ID_MM_CANDIDATE and the service
# never looks at it. On a board with a modem already plugged in, `mmcli -L`
# answers "No modems were found" - indistinguishable from unsupported
# hardware - and the journal says nothing beyond starting.
#
# On a freshly flashed image this cannot happen: udev runs after the package
# is there. It happens on every upgrade of a device already in the field.
#
# The trigger is deliberately unfiltered. A trigger over tty, net and usb got
# the modem claimed and left the control port untagged, and ModemManager fell
# back to a modem whose primary port was ttyUSB2 (at) with wwan0 ignored -
# which is a modem with no data path but PPP. The control port lives in
# usbmisc, which a subsystem-filtered trigger does not reach.
if [ "$DRY_RUN" != "1" ] && command -v udevadm >/dev/null 2>&1; then
    run udevadm control --reload-rules
    run udevadm trigger
else
    log "skipping udev trigger (dry run or no udevadm)"
fi

if [ "$DRY_RUN" != "1" ] && command -v systemctl >/dev/null 2>&1; then
    run systemctl enable ModemManager.service
    run systemctl restart ModemManager.service
else
    log "skipping systemctl for ModemManager (dry run or not a systemd host)"
fi

# And nothing else.
#
# Installing modem support is not configuring a modem. No connection is
# created and none is raised: a device carries no cellular link until
# config.yaml asks for one, and the renderer is the only thing that writes it
# (R-CFG-08).
log "modem support installed; no connection configured"
```

- [ ] **Step 5: Run it and watch it pass**

Run: `npx vitest run packages/yonder-core/src/installer.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
npm test
git add installer/ packages/yonder-core/src/installer.test.ts
git commit -s -m "feat(install): ModemManager from Debian, and a modem it can actually see"
```

---

## Task 11: On the board

**Files:**
- Create: `docs/hardware/verifying-m3a.md`
- Modify: `packages/yonder-core/src/net/reach/standing.ts` (the two constants)
- Modify: `docs/roadmap.md`

**This is the task no fake proves.** Every test above runs against an injected runner by
design, and a fake `mmcli` answers whatever it is asked. A board, a live SIM and a person
are what close M3a.

Board: a Raspberry Pi 4 on Debian 13 with the EC25-AF and an active SIM. The APN is
`ereseller`; `nxtgenphone` is the value that fails, and is useful precisely for that.

- [ ] **Step 1: Flash a card built from this branch and boot it with the modem attached**

Record what `mmcli -L` says on first boot. It must find the modem without anyone running
`udevadm` by hand. If it does not, Task 10 is wrong and no amount of unit testing would
have said so.

- [ ] **Step 2: Configure the modem from `config.yaml` alone**

```yaml
network:
  modem:
    enabled: true
    apn: ereseller
```

Expected: the link comes up, `GET /modem/state` reports `connected`, `Dark Star`, `lte`,
`home`, and an address on `wwan0`.

- [ ] **Step 3: Configure it wrong, on purpose**

Set `apn: nxtgenphone`. Expected: the modem still reports registered, home, LTE and a good
signal, an address is assigned and a route installed — **and `GET /modem/state` says
traffic is not getting through.** This is the milestone's whole claim. If the console would
have shown this as healthy, R-CEL-09 is not met.

- [ ] **Step 4: Measure the hysteresis**

With the modem in use, pull the antenna or move the board until the carrier drops, and
record how long a real loss lasts and how many consecutive probes fail during one that
recovers by itself. Then set `FAILURES_TO_STAND_DOWN` and `SUCCESSES_TO_RETURN` from what
you saw, and write the measurement into `docs/hardware/verifying-m3a.md` next to the
numbers. **The constants shipped in Task 7 are provisional and must not survive this
step unexamined.**

- [ ] **Step 5: Watch a dead path stand down**

Plug Ethernet into a switch with no route out, with the modem up. Expected: within the
window Step 4 established, the log carries a sentence naming Ethernet, saying it reached
nothing and was stood down, and traffic is going out over the modem. Unplug it; expected: a
second sentence saying it is back.

- [ ] **Step 6: Watch the watchdog do the thing K-33 was about**

On a board with **no** Ethernet and **no** Wi-Fi client, boot with `apn: nxtgenphone`.
Expected: the modem takes an address, nothing is reachable, and the access point comes up
within the fallback window anyway. Before Task 8 this board would have been a brick.

- [ ] **Step 7: Confirm signal costs nothing**

Read `/sys/class/net/wwan0/statistics/rx_bytes`, leave the console reading signal for two
minutes, read it again. The change must be attributable to other traffic — polling the
modem must not move it.

- [ ] **Step 8: Write it up and update the roadmap**

Record every step's actual output in `docs/hardware/verifying-m3a.md`, in the shape
`docs/hardware/verifying-m1a.md` uses. Then mark M3a in `docs/roadmap.md` with what was
seen on hardware and what was not — **and say plainly that the appliance path has never
been exercised**, because no such modem exists on this bench (spec §4).

- [ ] **Step 9: Commit**

```bash
git add docs/hardware/verifying-m3a.md docs/roadmap.md packages/yonder-core/src/net/reach/standing.ts
git commit -s -m "docs(hardware): M3a on a board, with the hysteresis measured rather than chosen"
```

---

## Self-review

**Spec coverage.**

| Spec section | Task |
|---|---|
| §1 what drives the modem | 3, 5 |
| §1 three names that are not the obvious ones | 3 (ports, connected bearer), 4 (coarse percentage unused) |
| §1 udev after install | 10 |
| §2 a link that carries nothing | 6, 7, 9, 11 Step 3 |
| §2 no APN suggestions | 1 Step 7, 5 Step 3 |
| §3 no quirk table; report the composition | 3 (`portList`), 4 (`ports`) |
| §4 the modem an operator names | 1, 4, 5 |
| §4 handling / schema | 1 |
| §5 signal armed, published, free | 3, 9 Step 5, 11 Step 7 |
| §6 standing down, four constraints | 6, 7, 11 Step 4 |
| §6 the R-NET-07 hole | 8 |
| §7 requirements and K-33 | 1, 8 |
| §8 where it goes in the console | **M3b — deliberately out of scope** |
| §9 shape of the code | File Structure |
| §10 split; R-NET-06 moved out | Scope; the metric helper in Task 5 is the modem's own, not the cross-renderer change |

**Placeholders:** none. Every code step carries the code. The two constants in Task 7 are
real, shipped values with a named task that replaces them by measurement — not a `TODO`.

**Type consistency:** `ModemInfo.ports` is `ModemPorts` on the client and
`ModemState.ports` is `string[]`, deliberately — the first is the two names the code binds
to, the second is the list a page shows for R-CEL-03. `PathName` matches the schema's
`Interface` enum members used in `network.priority` (`ethernet`, `modem`, `wifi_client`);
the schema's fourth member `usb` has no path report because no renderer writes one.
`Standing.record` returns `PathStanding`, and `standingOf` never returns `in-use` or
`testing` — those are set by the caller assembling `ReachState` in Task 9, which knows
which path the route table is actually using.

**One gap found and closed while reviewing:** Task 5 originally set no route metric, which
would have left `network.priority` decided by NetworkManager's defaults rather than
generated from configuration. `metricFor` is in Task 5 and covers the modem's own profile.
The Ethernet and Wi-Fi profiles keep their present behaviour — that is R-NET-06, which §10
of the spec deliberately moves out of M3.
