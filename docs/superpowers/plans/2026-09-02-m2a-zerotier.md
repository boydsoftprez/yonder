# M2a ZeroTier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a device on a ZeroTier network from the console, on a board that was installed with no internet — join by network ID, show it waiting to be authorised, and serve the whole console over the mesh once it is.

**Architecture:** A `RemoteRenderer` implements the `Renderer` interface the apply engine already accepts, so a mesh join inherits M0's validate → apply cycle. It drives `zerotier-cli` through the **injected `CommandRunner`** exactly as `NetworkRenderer` drives `nmcli` ([ADR-0006](../../adr/0006-nmcli-not-dbus.md)), so the whole renderer is unit-testable with no ZeroTier present. A pure `state.ts` turns the client's vocabulary into the one state the console renders. A join is **kept rather than held** (R-CFG-12): `remote.zerotier` is added to the reachability exemption, earned by measurement recorded in the spec.

**Tech Stack:** Node 22.12 · TypeScript (strict, ESM, NodeNext) · Zod · vitest · `zerotier-cli` · POSIX `sh` (installer) · Node-RED 5 + Dashboard 2.x

**Spec:** [2026-09-02-remote-access-design.md](../specs/2026-09-02-remote-access-design.md). Every measurement quoted below was read off a real board; do not re-derive them from vendor documentation.

**Out of scope — M2b:** Tailscale (R-VPN-02), direct-versus-relayed reporting (R-VPN-03), and any reachability exemption for Tailscale. This plan ends with a device reachable over ZeroTier.

## Global Constraints

- **Licence:** GPL-3.0. Every source file carries `// SPDX-License-Identifier: GPL-3.0-or-later` (`#` form in shell).
- **Commits:** GPG-signed and DCO signed-off. Always `git commit -s`. **Never `--no-gpg-sign`** — if signing fails, stop and report.
- **Node:** 22.12 minimum for console-side work, 20 for `yonder-core`. TypeScript strict. ESM with `.js` import extensions (NodeNext).
- **Requirements:** cite the `R-*` IDs each task satisfies. Requirements live in `docs/requirements.md`. IDs are stable — never reuse or renumber.
- **This repository is self-contained:** no references to paths outside it, no comparison to other products.
- **Nothing shells out except renderers.** All process execution goes through the injected `CommandRunner`. **No test may execute `zerotier-cli`.**
- **No secret is ever logged.** A ZeroTier network ID is *not* a secret and lives in `config.yaml`; the local API auth token is never read into the daemon at all.
- **Logic lives in node packages, never in Node-RED `function` nodes.** `flows/flows.json` is wiring only (CLAUDE.md rule 2).
- **Paths:** config `/etc/yonder/config.yaml`, secrets `/etc/yonder/secrets.yaml`, state `/var/lib/yonder/`, socket `/run/yonder/core.sock`, payload `vendor/`.

## What already exists (on this branch)

- `src/apply/types.ts` — `Renderer` is `{ readonly name: string; render(config: Config): Promise<void> }`.
- `src/apply/reachability.ts` — `affectsReachability(previous, next)`, and `withoutCosmetics` which today deletes only `ui.theme`.
- `src/net/runner.ts` — `CommandRunner = (argv: string[]) => Promise<CommandResult>`, `CommandResult = { code, stdout, stderr }`, `systemRunner`. **Never rejects: a non-zero exit is a result, not an exception.**
- `src/daemon/routes.ts` — routes are `if (method === "..." && path === "...") { ... }` returning `{ status, body }`.
- `src/daemon/server.ts` — `buildRenderers(opts)` returns `{ renderers, renderer, consoleRenderer?, secrets, client, generated }`.
- `installer/make-payload.sh` — pinned Node version, published checksum, `$SHA_CHECK`, staging into `vendor/`, `$WORK` removed on any exit.
- `scripts/capture-pages.mjs` — `pagesFromFlows()` filters `n.type === "ui-page"`; captures each page once.
- `packages/node-red-contrib-yonder-network` — the contrib package to copy for structure.
- **`theme.ts` already styles `.v-tabs` / `.v-tab` / `.v-tab--selected`.** Done in commit `d8dd994`; this plan does not repeat it.

---

## File Structure

```
packages/yonder-core/src/remote/
├── zerotier/
│   ├── parse.ts          pure: `zerotier-cli -j` output -> typed records
│   ├── parse.test.ts
│   ├── cli.ts            typed operations over the injected CommandRunner
│   ├── cli.test.ts
│   └── fixtures/         recorded real output, committed
│       ├── info.json
│       ├── listnetworks-access-denied.json
│       ├── listnetworks-requesting.json
│       ├── listnetworks-ok.json
│       └── listnetworks-empty.json
├── state.ts              pure: config + client reports -> one RemoteState
├── state.test.ts
├── renderer.ts           RemoteRenderer implements Renderer
└── renderer.test.ts

packages/node-red-contrib-yonder-remote/    nodes: yonder-remote-state, -join, -leave
installer/keys/zerotier.gpg                 the publisher's key, committed
installer/roles/40-zerotier.sh              install from vendor, stop and disable
```

**Responsibility boundaries.** `parse.ts` knows ZeroTier's output format and nothing about Yonder. `cli.ts` knows which commands exist and nothing about config. `state.ts` is pure translation with no I/O — most of the logic and most of the tests live there, and it is what keeps the console from ever learning what `ACCESS_DENIED` means. `renderer.ts` only orchestrates.

---

## Task 1: The `remote` section of the schema, and its requirements

**Requirements:** R-VPN-01, R-VPN-05, and adds R-VPN-06, R-VPN-07, R-VPN-08, R-VPN-09

**Files:**
- Modify: `packages/yonder-core/src/schema/config.ts`
- Modify: `docs/requirements.md`
- Modify: `config/defaults/config.yaml`
- Test: `packages/yonder-core/src/schema/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Config["remote"]` as `{ zerotier: { enabled: boolean; network_id: string | null } }`. Every later task reads `config.remote.zerotier`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/yonder-core/src/schema/config.test.ts`:

```ts
it("defaults remote.zerotier to disabled with no network", () => {
  const cfg = ConfigSchema.parse({ network: { ap: { psk: { secret: "ap_psk" } } }, ui: { editor: {} } });
  expect(cfg.remote.zerotier.enabled).toBe(false);
  expect(cfg.remote.zerotier.network_id).toBeNull();
});

it("accepts a 16-hex network id", () => {
  const cfg = ConfigSchema.parse({
    network: { ap: { psk: { secret: "ap_psk" } } },
    ui: { editor: {} },
    remote: { zerotier: { enabled: true, network_id: "9fef8a3bf9000001" } },
  });
  expect(cfg.remote.zerotier.network_id).toBe("9fef8a3bf9000001");
});

// A wrong id draws no complaint from the client at all - it sits in
// REQUESTING_CONFIGURATION for ever - so this is the last chance to catch one.
it.each(["9FEF8A3BF9000001", "9fef8a3bf900000", "9fef8a3bf90000012", "9fef8a3bf900000g", ""])(
  "rejects %s as a network id",
  (bad) => {
    expect(() =>
      ConfigSchema.parse({
        network: { ap: { psk: { secret: "ap_psk" } } },
        ui: { editor: {} },
        remote: { zerotier: { network_id: bad } },
      }),
    ).toThrow();
  },
);

it("rejects a key that was never a Yonder setting", () => {
  expect(() =>
    ConfigSchema.parse({
      network: { ap: { psk: { secret: "ap_psk" } } },
      ui: { editor: {} },
      remote: { zerotier: { netwrok_id: "9fef8a3bf9000001" } },
    }),
  ).toThrow();
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm test -w packages/yonder-core -- config.test`
Expected: FAIL — `cfg.remote` is undefined; the schema has no `remote` section.

- [ ] **Step 3: Add the schema**

In `packages/yonder-core/src/schema/config.ts`, above `export const ConfigSchema`:

```ts
/**
 * Sixteen lowercase hex characters. Uppercase is rejected rather than folded:
 * `zerotier-cli` takes the id verbatim, and a configuration that stores one
 * form while the client reports another is two spellings of the same network.
 */
export const ZEROTIER_NETWORK_ID = /^[0-9a-f]{16}$/;

const ZeroTier = z
  .object({
    enabled: z.boolean().default(false),
    network_id: z.string().regex(ZEROTIER_NETWORK_ID).nullable().default(null),
  })
  .strict();

const Remote = z.object({ zerotier: ZeroTier.default({}) }).strict();
```

Add to the `ConfigSchema` object literal, after `system`:

```ts
  remote: Remote.default({}),
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npm test -w packages/yonder-core -- config.test`
Expected: PASS.

- [ ] **Step 5: Add the four requirements**

In `docs/requirements.md`, append to the `R-VPN` table, after the `R-VPN-05` row at line 165:

```markdown
| R-VPN-06 | **Joined but not yet authorised is a state in its own right, and the interface says so.** Where a mesh requires a person to approve a device, the interface names that state as neither a fault nor a connection, shows the identifier that must be approved with a means of copying it, and waits indefinitely. Nothing times out and nothing is reverted while a device waits to be approved: a week in this state is a correct outcome. What this gives up is telling a mistyped network ID apart from a controller that cannot be reached — the client reports both as an ordinary join in progress, for ever, and the interface does not guess between them | 1 |
| R-VPN-07 | **Joining a mesh is kept, not held.** It is a case of R-CFG-12, and it is earned by measurement rather than by argument: a join only ever adds a route, and the client refuses a route that would overlap a network the device is already on. Approval by a person is never waited on inside a confirmation window, because a window that expires while somebody walks to their laptop discards a working configuration — and waiting to be approved is the ordinary case, not the rare one. **Each mesh earns this separately.** R-CFG-12 treats what has not been shown to be safe as load-bearing, so a second mesh is held until its own behaviour has been measured. A join that fails for a reason the device can see — a malformed network ID, a client that is not installed, a service that will not start — fails the apply and reverts like any other change | 1 |
| R-VPN-08 | **The primary mesh client installs on a board with no network.** It is carried in the offline payload, pinned to a version and a fingerprint recorded in this repository, and verified against the publisher's signature — using a key committed here rather than fetched — before it is staged. The second mesh client, whose install pulls a dependency tree and changes system-wide packet-filter alternatives, is fetched over the network by a role that runs only when it is configured. **Installing a mesh client does not start one:** the unit is stopped and disabled at install and started only when a network is configured, so a device carries no connection to anyone's infrastructure until it is asked for one | 1 |
| R-VPN-09 | **Where a mesh needs a key the operator generates, the interface says where to get one and what kind to generate, and reports when the device's access expires.** The key is held in the secrets file and handed to the client as a file, never on a command line other processes can read. Once joined, the interface reports the expiry of the device's own access — including when there is none — so an aircraft cannot quietly lose remote access on a date nobody was told about. A key is never refused for being of the wrong kind (R-CFG-06) | 2 |
```

Extend the existing `R-UI-12` row (line 270) — same ID, no renumbering — by replacing its text with:

```markdown
| R-UI-12 | **Capture every page in both palettes on every build, and fail the build when a page changes shape unreviewed.** A console nobody looks at is a console nobody has checked. **A surface that hides part of itself is captured in each of those parts** — a page whose groups are tabs renders one tab at a time, so capturing it once would quietly narrow "every page" to whichever tab happens to be first | 2 |
```

- [ ] **Step 6: Add the default to the shipped configuration**

In `config/defaults/config.yaml`, after the `system:` block:

```yaml
# Neither mesh is enabled by default (R-VPN-05). A device with none configured
# is a normal device on a local network, and carries no connection to anyone's
# infrastructure until it is asked for one.
remote:
  zerotier:
    enabled: false
    network_id: null
```

- [ ] **Step 7: Run the whole suite**

Run: `npm test`
Expected: PASS. `R-CFG-09` is why this matters — an older `config.yaml` with no `remote:` key must still load, and `Remote.default({})` is what makes it.

- [ ] **Step 8: Commit**

```bash
git add packages/yonder-core/src/schema docs/requirements.md config/defaults/config.yaml
git commit -s -m "feat(schema): a remote section, disabled, with no network — R-VPN-01, R-VPN-05"
```

---

## Task 2: Parse what `zerotier-cli` actually prints

**Requirements:** groundwork for R-VPN-01, R-VPN-06

**Files:**
- Create: `packages/yonder-core/src/remote/zerotier/parse.ts`
- Create: `packages/yonder-core/src/remote/zerotier/parse.test.ts`
- Create: `packages/yonder-core/src/remote/zerotier/fixtures/*.json`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type ZeroTierStatus = "REQUESTING_CONFIGURATION" | "OK" | "ACCESS_DENIED" | "NOT_FOUND" | "PORT_ERROR" | "CLIENT_TOO_OLD" | "AUTHENTICATION_REQUIRED"`
  - `interface ZeroTierInfo { address: string; online: boolean; version: string }`
  - `interface ZeroTierNetwork { nwid: string; name: string; status: ZeroTierStatus; portDeviceName: string; assignedAddresses: string[] }`
  - `function parseInfo(stdout: string): ZeroTierInfo`
  - `function parseNetworks(stdout: string): ZeroTierNetwork[]`

- [ ] **Step 1: Write the fixtures**

These are real output, trimmed to the fields that are read. Create
`packages/yonder-core/src/remote/zerotier/fixtures/info.json`:

```json
{
  "address": "9fef8a3bf9",
  "online": true,
  "version": "1.16.2",
  "versionMajor": 1,
  "versionMinor": 16,
  "versionRev": 2,
  "clock": 1788367039031,
  "planetWorldId": 149604618,
  "tcpFallbackActive": false
}
```

`fixtures/listnetworks-empty.json`:

```json
[]
```

`fixtures/listnetworks-requesting.json` — a join still handshaking, **and also where a
mistyped network ID stays for ever**:

```json
[
  {
    "id": "1234567890abcdef",
    "nwid": "1234567890abcdef",
    "mac": "ee:52:44:1a:43:af",
    "name": "",
    "status": "REQUESTING_CONFIGURATION",
    "type": "PRIVATE",
    "portDeviceName": "ztnksp3nl7",
    "assignedAddresses": [],
    "routes": [],
    "netconfRevision": 0
  }
]
```

`fixtures/listnetworks-access-denied.json` — note the **empty name**: the controller
tells an unauthorised member nothing about the network:

```json
[
  {
    "id": "9fef8a3bf9000001",
    "nwid": "9fef8a3bf9000001",
    "mac": "02:9f:ef:73:00:73",
    "name": "",
    "status": "ACCESS_DENIED",
    "type": "PRIVATE",
    "portDeviceName": "ztuqliuo7y",
    "assignedAddresses": [],
    "routes": [],
    "netconfRevision": 0
  }
]
```

`fixtures/listnetworks-ok.json`:

```json
[
  {
    "id": "9fef8a3bf9000001",
    "nwid": "9fef8a3bf9000001",
    "mac": "02:9f:ef:73:00:73",
    "name": "yonder-probe",
    "status": "OK",
    "type": "PRIVATE",
    "portDeviceName": "ztuqliuo7y",
    "assignedAddresses": ["10.147.20.26/24"],
    "routes": [{ "target": "10.147.20.0/24", "via": null, "flags": 0, "metric": 0 }],
    "netconfRevision": 4
  }
]
```

- [ ] **Step 2: Write the failing test**

`packages/yonder-core/src/remote/zerotier/parse.test.ts`:

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseInfo, parseNetworks } from "./parse.js";

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, "fixtures", `${name}.json`), "utf8");

describe("parseInfo", () => {
  it("reads the node address, which is what the operator must approve", () => {
    expect(parseInfo(fixture("info"))).toEqual({
      address: "9fef8a3bf9",
      online: true,
      version: "1.16.2",
    });
  });

  it("throws on output that is not JSON, rather than returning a hollow record", () => {
    expect(() => parseInfo("200 info 9fef8a3bf9 1.16.2 ONLINE")).toThrow(/could not be read/);
  });
});

describe("parseNetworks", () => {
  it("reads nothing from a node that has joined nothing", () => {
    expect(parseNetworks(fixture("listnetworks-empty"))).toEqual([]);
  });

  it("reads a join that is still handshaking", () => {
    const [n] = parseNetworks(fixture("listnetworks-requesting"));
    expect(n.nwid).toBe("1234567890abcdef");
    expect(n.status).toBe("REQUESTING_CONFIGURATION");
    expect(n.assignedAddresses).toEqual([]);
  });

  // The name is empty until the device is authorised, so the console can never
  // tell the operator which network it is waiting on by name - only by id.
  it("reads a join waiting to be authorised, and carries no network name", () => {
    const [n] = parseNetworks(fixture("listnetworks-access-denied"));
    expect(n.status).toBe("ACCESS_DENIED");
    expect(n.name).toBe("");
    expect(n.portDeviceName).toBe("ztuqliuo7y");
  });

  it("reads an authorised join and its address", () => {
    const [n] = parseNetworks(fixture("listnetworks-ok"));
    expect(n.status).toBe("OK");
    expect(n.name).toBe("yonder-probe");
    expect(n.assignedAddresses).toEqual(["10.147.20.26/24"]);
  });

  // A status this version has never seen must not crash the status line.
  it("keeps a status it does not recognise rather than discarding the network", () => {
    const [n] = parseNetworks('[{"nwid":"9fef8a3bf9000001","status":"SOMETHING_NEW"}]');
    expect(n.status).toBe("SOMETHING_NEW");
  });

  it("throws on output that is not JSON", () => {
    expect(() => parseNetworks("200 listnetworks <nwid> <name>")).toThrow(/could not be read/);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npm test -w packages/yonder-core -- remote/zerotier/parse`
Expected: FAIL — `./parse.js` does not exist.

- [ ] **Step 4: Write the parser**

`packages/yonder-core/src/remote/zerotier/parse.ts`:

```ts
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The statuses a real client printed, plus the ones its source can produce.
 *
 * A `string` fallback is deliberate. A client newer than this daemon can
 * report something not in this list, and the status line's job is to keep
 * working — a device that reports an unknown state is far better than a
 * console that throws while an aircraft is in the air. `state.ts` maps
 * anything it does not recognise to the same place a fault goes.
 */
export type ZeroTierStatus =
  | "REQUESTING_CONFIGURATION"
  | "OK"
  | "ACCESS_DENIED"
  | "NOT_FOUND"
  | "PORT_ERROR"
  | "CLIENT_TOO_OLD"
  | "AUTHENTICATION_REQUIRED"
  | (string & {});

export interface ZeroTierInfo {
  /** Ten hex characters. The thing a human approves in the controller. */
  address: string;
  online: boolean;
  version: string;
}

export interface ZeroTierNetwork {
  nwid: string;
  /**
   * **Empty until the device is authorised.** A controller tells a member it
   * has not authorised nothing about the network, so this is `""` in exactly
   * the state the operator most wants it named.
   */
  name: string;
  status: ZeroTierStatus;
  /** The interface, which exists from the moment of joining, addressed or not. */
  portDeviceName: string;
  /** CIDR strings. Empty until authorised. */
  assignedAddresses: string[];
}

function json(stdout: string, what: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    // Do not quote the output back: this message reaches the journal, and
    // there is no reason to widen what it carries.
    throw new Error(`the ${what} reported by zerotier-cli could not be read as JSON`);
  }
}

export function parseInfo(stdout: string): ZeroTierInfo {
  const raw = json(stdout, "node information") as Record<string, unknown>;
  return {
    address: typeof raw.address === "string" ? raw.address : "",
    online: raw.online === true,
    version: typeof raw.version === "string" ? raw.version : "",
  };
}

export function parseNetworks(stdout: string): ZeroTierNetwork[] {
  const raw = json(stdout, "network list");
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    const n = entry as Record<string, unknown>;
    return {
      nwid: typeof n.nwid === "string" ? n.nwid : "",
      name: typeof n.name === "string" ? n.name : "",
      status: typeof n.status === "string" ? n.status : "",
      portDeviceName: typeof n.portDeviceName === "string" ? n.portDeviceName : "",
      assignedAddresses: Array.isArray(n.assignedAddresses)
        ? n.assignedAddresses.filter((a): a is string => typeof a === "string")
        : [],
    };
  });
}
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `npm test -w packages/yonder-core -- remote/zerotier/parse`
Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/yonder-core/src/remote/zerotier
git commit -s -m "feat(remote): parse zerotier-cli output, from fixtures captured on a board"
```

---

## Task 3: The client operations

**Requirements:** R-VPN-01

**Files:**
- Create: `packages/yonder-core/src/remote/zerotier/cli.ts`
- Create: `packages/yonder-core/src/remote/zerotier/cli.test.ts`

**Interfaces:**
- Consumes: `CommandRunner`, `CommandResult` from `../../net/runner.js`; `parseInfo`, `parseNetworks`, `ZeroTierInfo`, `ZeroTierNetwork` from `./parse.js`.
- Produces:
  - `class ZeroTierCliError extends Error { readonly argv: string[]; readonly code: number }`
  - `class ZeroTierCli` with `constructor(run: CommandRunner, trace?: (line: string) => void)`, and methods `info(): Promise<ZeroTierInfo>`, `listNetworks(): Promise<ZeroTierNetwork[]>`, `join(nwid: string): Promise<void>`, `leave(nwid: string): Promise<void>`, `installed(): Promise<boolean>`.

- [ ] **Step 1: Write the failing test**

`packages/yonder-core/src/remote/zerotier/cli.test.ts`:

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import type { CommandResult, CommandRunner } from "../../net/runner.js";
import { ZeroTierCli, ZeroTierCliError } from "./cli.js";

const ok = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: "" });

/** Returns canned output per command, and records every argv it was given. */
function fakeRunner(reply: (argv: string[]) => CommandResult) {
  const calls: string[][] = [];
  const run: CommandRunner = async (argv) => {
    calls.push(argv);
    return reply(argv);
  };
  return { run, calls };
}

describe("ZeroTierCli", () => {
  it("asks for JSON, not the terse form", async () => {
    const { run, calls } = fakeRunner(() => ok('{"address":"9fef8a3bf9","online":true,"version":"1.16.2"}'));
    await new ZeroTierCli(run).info();
    expect(calls[0]).toEqual(["zerotier-cli", "-j", "info"]);
  });

  it("reads the node address", async () => {
    const { run } = fakeRunner(() => ok('{"address":"9fef8a3bf9","online":true,"version":"1.16.2"}'));
    expect((await new ZeroTierCli(run).info()).address).toBe("9fef8a3bf9");
  });

  it("lists networks", async () => {
    const { run, calls } = fakeRunner(() =>
      ok('[{"nwid":"9fef8a3bf9000001","name":"","status":"ACCESS_DENIED","portDeviceName":"zt0","assignedAddresses":[]}]'),
    );
    const nets = await new ZeroTierCli(run).listNetworks();
    expect(calls[0]).toEqual(["zerotier-cli", "-j", "listnetworks"]);
    expect(nets[0].status).toBe("ACCESS_DENIED");
  });

  it("joins by network id", async () => {
    const { run, calls } = fakeRunner(() => ok("200 join OK"));
    await new ZeroTierCli(run).join("9fef8a3bf9000001");
    expect(calls[0]).toEqual(["zerotier-cli", "join", "9fef8a3bf9000001"]);
  });

  it("leaves by network id", async () => {
    const { run, calls } = fakeRunner(() => ok("200 leave OK"));
    await new ZeroTierCli(run).leave("9fef8a3bf9000001");
    expect(calls[0]).toEqual(["zerotier-cli", "leave", "9fef8a3bf9000001"]);
  });

  // The runner never rejects, so a non-zero exit has to be turned into one here
  // or every caller silently treats a failure as a success.
  it("turns a non-zero exit into an error carrying the argv and the code", async () => {
    const { run } = fakeRunner(() => ({ code: 1, stdout: "", stderr: "missing port" }));
    await expect(new ZeroTierCli(run).join("9fef8a3bf9000001")).rejects.toBeInstanceOf(ZeroTierCliError);
  });

  it("reports the client as absent when the binary is not there", async () => {
    const { run } = fakeRunner(() => ({ code: 127, stdout: "", stderr: "command not found" }));
    expect(await new ZeroTierCli(run).installed()).toBe(false);
  });

  it("reports the client as present when it answers", async () => {
    const { run } = fakeRunner(() => ok('{"address":"9fef8a3bf9","online":true,"version":"1.16.2"}'));
    expect(await new ZeroTierCli(run).installed()).toBe(true);
  });

  // The command line goes to the journal, never to the activity pane: a status
  // poll every few seconds would otherwise bury what the operator's Join did.
  it("traces every command it runs", async () => {
    const trace = vi.fn();
    const { run } = fakeRunner(() => ok("[]"));
    await new ZeroTierCli(run, trace).listNetworks();
    expect(trace).toHaveBeenCalledWith("zerotier-cli -j listnetworks");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -w packages/yonder-core -- remote/zerotier/cli`
Expected: FAIL — `./cli.js` does not exist.

- [ ] **Step 3: Write the client**

`packages/yonder-core/src/remote/zerotier/cli.ts`:

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
import type { CommandRunner } from "../../net/runner.js";
import { parseInfo, parseNetworks, type ZeroTierInfo, type ZeroTierNetwork } from "./parse.js";

/**
 * `zerotier-cli` lives in /usr/sbin and reads a 0600 token owned by its own
 * user, so it needs root. `yonder-core` already runs as root — its unit sets
 * `Group=yonder` and no `User=` — and the console, which runs as `yonder`,
 * reaches all of this through the daemon socket and holds no privilege of its
 * own. Nothing here needs a sudoers entry, and nothing should acquire one.
 */
const BIN = "zerotier-cli";

export class ZeroTierCliError extends Error {
  constructor(
    message: string,
    readonly argv: string[],
    readonly code: number,
  ) {
    super(message);
    this.name = "ZeroTierCliError";
  }
}

export class ZeroTierCli {
  constructor(
    private readonly run: CommandRunner,
    private readonly trace: (line: string) => void = () => {},
  ) {}

  private async exec(argv: string[]): Promise<string> {
    this.trace(argv.join(" "));
    const { code, stdout, stderr } = await this.run(argv);
    if (code !== 0) {
      const said = (stderr || stdout).trim().split("\n")[0] ?? "";
      throw new ZeroTierCliError(
        said === "" ? `${argv.join(" ")} exited ${code}` : said,
        argv,
        code,
      );
    }
    return stdout;
  }

  async info(): Promise<ZeroTierInfo> {
    return parseInfo(await this.exec([BIN, "-j", "info"]));
  }

  async listNetworks(): Promise<ZeroTierNetwork[]> {
    return parseNetworks(await this.exec([BIN, "-j", "listnetworks"]));
  }

  async join(nwid: string): Promise<void> {
    await this.exec([BIN, "join", nwid]);
  }

  async leave(nwid: string): Promise<void> {
    await this.exec([BIN, "leave", nwid]);
  }

  /**
   * Whether there is a client here at all. A board installed before ZeroTier
   * was carried in the payload has none, and the renderer must say so rather
   * than fail with a shell error.
   */
  async installed(): Promise<boolean> {
    try {
      await this.info();
      return true;
    } catch {
      return false;
    }
  }
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npm test -w packages/yonder-core -- remote/zerotier/cli`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/yonder-core/src/remote/zerotier
git commit -s -m "feat(remote): typed zerotier-cli operations over the injected runner — R-VPN-01"
```

---

## Task 4: One state for the console to render

**Requirements:** R-VPN-06

**Files:**
- Create: `packages/yonder-core/src/remote/state.ts`
- Create: `packages/yonder-core/src/remote/state.test.ts`

**Interfaces:**
- Consumes: `Config` from `../schema/config.js`; `ZeroTierInfo`, `ZeroTierNetwork` from `./zerotier/parse.js`.
- Produces:
  - `type RemotePhase = "off" | "no-client" | "joining" | "waiting-for-approval" | "connected" | "fault"`
  - `interface RemoteState { phase: RemotePhase; networkId: string | null; deviceId: string | null; addresses: string[]; interface: string | null; detail: string | null }`
  - `function remoteState(input: { config: Config; installed: boolean; info: ZeroTierInfo | null; networks: ZeroTierNetwork[] }): RemoteState`

- [ ] **Step 1: Write the failing test**

`packages/yonder-core/src/remote/state.test.ts`:

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { ConfigSchema, type Config } from "../schema/config.js";
import type { ZeroTierNetwork } from "./zerotier/parse.js";
import { remoteState } from "./state.js";

const config = (network_id: string | null, enabled = network_id !== null): Config =>
  ConfigSchema.parse({
    network: { ap: { psk: { secret: "ap_psk" } } },
    ui: { editor: {} },
    remote: { zerotier: { enabled, network_id } },
  });

const info = { address: "9fef8a3bf9", online: true, version: "1.16.2" };

const net = (over: Partial<ZeroTierNetwork>): ZeroTierNetwork => ({
  nwid: "9fef8a3bf9000001",
  name: "",
  status: "REQUESTING_CONFIGURATION",
  portDeviceName: "ztuqliuo7y",
  assignedAddresses: [],
  ...over,
});

describe("remoteState", () => {
  it("is off when nothing is configured", () => {
    const s = remoteState({ config: config(null), installed: true, info, networks: [] });
    expect(s.phase).toBe("off");
    expect(s.networkId).toBeNull();
  });

  // R-VPN-05: a device with no mesh configured is a normal device, and must not
  // be told it has a problem.
  it("is off, not a fault, when no client is installed and none is configured", () => {
    const s = remoteState({ config: config(null), installed: false, info: null, networks: [] });
    expect(s.phase).toBe("off");
  });

  it("says so when a network is configured but no client is installed", () => {
    const s = remoteState({ config: config("9fef8a3bf9000001"), installed: false, info: null, networks: [] });
    expect(s.phase).toBe("no-client");
  });

  it("is joining while the client is still handshaking", () => {
    const s = remoteState({
      config: config("9fef8a3bf9000001"),
      installed: true,
      info,
      networks: [net({ status: "REQUESTING_CONFIGURATION" })],
    });
    expect(s.phase).toBe("joining");
  });

  // The state this whole feature is shaped around. It carries the ten-hex node
  // address because that is the one thing the operator must transfer to the
  // controller.
  it("waits for approval, and carries the address a human must approve", () => {
    const s = remoteState({
      config: config("9fef8a3bf9000001"),
      installed: true,
      info,
      networks: [net({ status: "ACCESS_DENIED" })],
    });
    expect(s.phase).toBe("waiting-for-approval");
    expect(s.deviceId).toBe("9fef8a3bf9");
    expect(s.networkId).toBe("9fef8a3bf9000001");
    expect(s.addresses).toEqual([]);
  });

  it("is connected once authorised, and carries the assigned address", () => {
    const s = remoteState({
      config: config("9fef8a3bf9000001"),
      installed: true,
      info,
      networks: [net({ status: "OK", name: "yonder-probe", assignedAddresses: ["10.147.20.26/24"] })],
    });
    expect(s.phase).toBe("connected");
    expect(s.addresses).toEqual(["10.147.20.26/24"]);
    expect(s.interface).toBe("ztuqliuo7y");
  });

  // A configured network the client has not joined at all is not "connected",
  // and it is not silence either.
  it("is joining when the configured network is not in the client's list", () => {
    const s = remoteState({
      config: config("9fef8a3bf9000001"),
      installed: true,
      info,
      networks: [],
    });
    expect(s.phase).toBe("joining");
  });

  it("ignores a network the configuration does not name", () => {
    const s = remoteState({
      config: config("9fef8a3bf9000001"),
      installed: true,
      info,
      networks: [net({ nwid: "aaaaaaaaaaaaaaaa", status: "OK", assignedAddresses: ["10.0.0.1/24"] })],
    });
    expect(s.phase).toBe("joining");
    expect(s.addresses).toEqual([]);
  });

  it("reports a status it does not recognise as a fault, with the status in the detail", () => {
    const s = remoteState({
      config: config("9fef8a3bf9000001"),
      installed: true,
      info,
      networks: [net({ status: "PORT_ERROR" })],
    });
    expect(s.phase).toBe("fault");
    expect(s.detail).toBe("PORT_ERROR");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -w packages/yonder-core -- remote/state`
Expected: FAIL — `./state.js` does not exist.

- [ ] **Step 3: Write the translation**

`packages/yonder-core/src/remote/state.ts`:

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
import type { Config } from "../schema/config.js";
import type { ZeroTierInfo, ZeroTierNetwork } from "./zerotier/parse.js";

/**
 * The states an operator can be in, as opposed to the states a client reports.
 *
 * `waiting-for-approval` is the one this feature is shaped around: it is
 * neither a fault nor a connection, it is reached in about four seconds, and it
 * is stable for as long as the human takes. Nothing times out of it (R-VPN-06).
 *
 * `joining` is the ambiguous one, and deliberately so. A client that cannot
 * reach a controller and a client given a network id that does not exist both
 * sit in `REQUESTING_CONFIGURATION` indefinitely — a board reported exactly
 * that for twenty seconds against `1234567890abcdef` and would have reported it
 * for ever. Guessing between "still joining" and "that id is wrong" would be
 * wrong every time a board's uplink was merely slow, so this does not guess.
 */
export type RemotePhase =
  | "off"
  | "no-client"
  | "joining"
  | "waiting-for-approval"
  | "connected"
  | "fault";

export interface RemoteState {
  phase: RemotePhase;
  /** From the configuration, so it is known before the client reports anything. */
  networkId: string | null;
  /** Ten hex characters: what a human approves in the controller. */
  deviceId: string | null;
  addresses: string[];
  interface: string | null;
  /** The client's own word, when the phase is `fault`. Never a secret. */
  detail: string | null;
}

export function remoteState(input: {
  config: Config;
  installed: boolean;
  info: ZeroTierInfo | null;
  networks: ZeroTierNetwork[];
}): RemoteState {
  const { enabled, network_id } = input.config.remote.zerotier;
  const base: RemoteState = {
    phase: "off",
    networkId: null,
    deviceId: input.info?.address ?? null,
    addresses: [],
    interface: null,
    detail: null,
  };

  // Nothing configured is not a problem to report (R-VPN-05).
  if (!enabled || network_id === null) return base;
  if (!input.installed) return { ...base, phase: "no-client", networkId: network_id };

  const net = input.networks.find((n) => n.nwid === network_id);
  // Configured but not in the client's list: the join has been asked for and
  // has not landed. That is joining, not silence.
  if (net === undefined) return { ...base, phase: "joining", networkId: network_id };

  const common = {
    ...base,
    networkId: network_id,
    interface: net.portDeviceName === "" ? null : net.portDeviceName,
  };

  switch (net.status) {
    case "REQUESTING_CONFIGURATION":
      return { ...common, phase: "joining" };
    case "ACCESS_DENIED":
      return { ...common, phase: "waiting-for-approval" };
    case "OK":
      return { ...common, phase: "connected", addresses: net.assignedAddresses };
    default:
      // Everything else - NOT_FOUND, PORT_ERROR, CLIENT_TOO_OLD, and anything a
      // newer client invents - is a fault the operator is told the name of.
      return { ...common, phase: "fault", detail: net.status };
  }
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npm test -w packages/yonder-core -- remote/state`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/yonder-core/src/remote
git commit -s -m "feat(remote): one state for the console, so it never learns what ACCESS_DENIED means — R-VPN-06"
```

---

## Task 5: The renderer, and a join that is kept rather than held

**Requirements:** R-VPN-01, R-VPN-05, R-VPN-07, R-VPN-08, R-CFG-12

**Files:**
- Create: `packages/yonder-core/src/remote/renderer.ts`
- Create: `packages/yonder-core/src/remote/renderer.test.ts`
- Modify: `packages/yonder-core/src/apply/reachability.ts`
- Test: `packages/yonder-core/src/apply/reachability.test.ts`

**Interfaces:**
- Consumes: `Renderer` from `../apply/types.js`; `ZeroTierCli` from `./zerotier/cli.js`; `CommandRunner` from `../net/runner.js`; `Config`.
- Produces: `class RemoteRenderer implements Renderer` with `readonly name = "remote"`, constructed as `new RemoteRenderer({ cli, run, statePath, log })` where `statePath` is a file under `/var/lib/yonder/`.

- [ ] **Step 1: Write the failing renderer test**

`packages/yonder-core/src/remote/renderer.test.ts`:

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CommandResult, CommandRunner } from "../net/runner.js";
import { ConfigSchema, type Config } from "../schema/config.js";
import { ZeroTierCli } from "./zerotier/cli.js";
import { RemoteRenderer } from "./renderer.js";

const config = (network_id: string | null, enabled = network_id !== null): Config =>
  ConfigSchema.parse({
    network: { ap: { psk: { secret: "ap_psk" } } },
    ui: { editor: {} },
    remote: { zerotier: { enabled, network_id } },
  });

function harness(reply: (argv: string[]) => CommandResult = () => ({ code: 0, stdout: "[]", stderr: "" })) {
  const calls: string[][] = [];
  const run: CommandRunner = async (argv) => {
    calls.push(argv);
    return reply(argv);
  };
  const log = vi.fn();
  // A real path in a temp dir: the renderer records which network it joined,
  // and the test that matters is the one where a *different* renderer instance
  // reads it back.
  const statePath = join(mkdtempSync(join(tmpdir(), "yonder-remote-")), "remote.json");
  const make = () => new RemoteRenderer({ cli: new ZeroTierCli(run), run, statePath, log });
  return { calls, log, statePath, make, renderer: make() };
}

const argvOf = (calls: string[][], head: string) => calls.filter((a) => a[0] === head);

describe("RemoteRenderer", () => {
  // R-VPN-08: installing a client must not start one. With zero networks joined
  // the daemon still holds live sessions with ZeroTier's root servers, which is
  // not something a device should do because a package is merely present.
  it("does not start the service when nothing is configured", async () => {
    const { renderer, calls } = harness();
    await renderer.render(config(null));
    expect(argvOf(calls, "systemctl").map((a) => a[1])).not.toContain("start");
  });

  it("stops the service when nothing is configured", async () => {
    const { renderer, calls } = harness();
    await renderer.render(config(null));
    expect(argvOf(calls, "systemctl")).toContainEqual(["systemctl", "stop", "zerotier-one"]);
  });

  it("starts and enables the service when a network is configured", async () => {
    const { renderer, calls } = harness();
    await renderer.render(config("9fef8a3bf9000001"));
    expect(argvOf(calls, "systemctl")).toContainEqual(["systemctl", "enable", "--now", "zerotier-one"]);
  });

  it("joins the configured network", async () => {
    const { renderer, calls } = harness();
    await renderer.render(config("9fef8a3bf9000001"));
    expect(argvOf(calls, "zerotier-cli")).toContainEqual(["zerotier-cli", "join", "9fef8a3bf9000001"]);
  });

  it("does not re-join a network it is already on", async () => {
    const joined = '[{"nwid":"9fef8a3bf9000001","name":"","status":"OK","portDeviceName":"zt0","assignedAddresses":["10.147.20.26/24"]}]';
    const { renderer, calls } = harness((argv) =>
      argv.includes("listnetworks")
        ? { code: 0, stdout: joined, stderr: "" }
        : { code: 0, stdout: "", stderr: "" },
    );
    await renderer.render(config("9fef8a3bf9000001"));
    expect(argvOf(calls, "zerotier-cli").some((a) => a[1] === "join")).toBe(false);
  });

  // Only what it owns. A network an operator joined by hand is theirs, and this
  // is not the thing that decides they have finished with it.
  it("leaves only the network it joined, never one an operator joined by hand", async () => {
    const joined = '[{"nwid":"9fef8a3bf9000001","name":"","status":"OK","portDeviceName":"zt0","assignedAddresses":[]},{"nwid":"aaaaaaaaaaaaaaaa","name":"","status":"OK","portDeviceName":"zt1","assignedAddresses":[]}]';
    const { renderer, calls } = harness((argv) =>
      argv.includes("listnetworks")
        ? { code: 0, stdout: joined, stderr: "" }
        : { code: 0, stdout: "", stderr: "" },
    );
    await renderer.render(config("9fef8a3bf9000001"));
    await renderer.render(config(null));
    const left = argvOf(calls, "zerotier-cli").filter((a) => a[1] === "leave");
    expect(left).toEqual([["zerotier-cli", "leave", "9fef8a3bf9000001"]]);
  });

  // The case instance state cannot answer. A daemon restarts between the join
  // and the leave - an upgrade, a reboot, a crash - and a renderer that
  // remembered its network in a field would come back knowing nothing and
  // leave the device on a mesh the configuration no longer names.
  it("leaves a network a previous daemon joined, after a restart", async () => {
    const joined = '[{"nwid":"9fef8a3bf9000001","name":"","status":"OK","portDeviceName":"zt0","assignedAddresses":[]}]';
    const h = harness((argv) =>
      argv.includes("listnetworks")
        ? { code: 0, stdout: joined, stderr: "" }
        : { code: 0, stdout: "", stderr: "" },
    );
    await h.make().render(config("9fef8a3bf9000001"));
    // A different instance, as after a restart, sharing only the state file.
    await h.make().render(config(null));
    const left = argvOf(h.calls, "zerotier-cli").filter((a) => a[1] === "leave");
    expect(left).toEqual([["zerotier-cli", "leave", "9fef8a3bf9000001"]]);
  });

  it("leaves nothing when it has never joined anything", async () => {
    const { renderer, calls } = harness();
    await renderer.render(config(null));
    expect(argvOf(calls, "zerotier-cli").some((a) => a[1] === "leave")).toBe(false);
  });

  // A board installed before ZeroTier was carried has no client. Say so; do not
  // fail with a shell error the operator cannot act on.
  it("fails with a reason when a network is configured and no client is installed", async () => {
    const { renderer } = harness(() => ({ code: 127, stdout: "", stderr: "command not found" }));
    await expect(renderer.render(config("9fef8a3bf9000001"))).rejects.toThrow(/not installed/);
  });

  it("says what it is doing, for the activity pane", async () => {
    const { renderer, log } = harness();
    await renderer.render(config("9fef8a3bf9000001"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("9fef8a3bf9000001"));
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -w packages/yonder-core -- remote/renderer`
Expected: FAIL — `./renderer.js` does not exist.

- [ ] **Step 3: Write the renderer**

`packages/yonder-core/src/remote/renderer.ts`:

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from "node:fs";
import type { Renderer } from "../apply/types.js";
import { writeFileDurable, unlinkDurable } from "../fs/durable.js";
import type { CommandRunner } from "../net/runner.js";
import type { Config } from "../schema/config.js";
import { ZeroTierCli } from "./zerotier/cli.js";

const UNIT = "zerotier-one";

/**
 * Turns `remote.zerotier` into a running client on the right network.
 *
 * **Installing a client does not start one.** The Debian package enables and
 * starts itself, and a daemon with zero networks joined still holds live
 * sessions with ZeroTier's root servers — a board printed four of them,
 * unprompted, moments after the package landed. A device that talks to a
 * company's infrastructure because software is merely present contradicts the
 * first thing this project claims about itself, so the installer disables the
 * unit and this renderer is the only thing that starts it (R-VPN-08, R-VPN-05).
 */
export class RemoteRenderer implements Renderer {
  readonly name = "remote";

  private readonly cli: ZeroTierCli;
  private readonly run: CommandRunner;
  private readonly statePath: string;
  private readonly log: (line: string) => void;

  constructor(opts: {
    cli: ZeroTierCli;
    run: CommandRunner;
    /** Where the joined network is recorded, under /var/lib/yonder. */
    statePath: string;
    log?: (line: string) => void;
  }) {
    this.cli = opts.cli;
    this.run = opts.run;
    this.statePath = opts.statePath;
    this.log = opts.log ?? (() => {});
  }

  /**
   * The network this renderer joined, on disk rather than in a field.
   *
   * It has to survive the process. A daemon restarts between a join and a leave
   * for entirely ordinary reasons - an upgrade, a reboot, a crash - and a
   * renderer that remembered this in memory would come back knowing nothing,
   * leave nothing, and strand the device on a mesh its configuration no longer
   * names. Recording it also keeps the leave narrow: Yonder removes what Yonder
   * joined, and a network an operator joined by hand stays theirs.
   */
  private owned(): string | null {
    try {
      const held = JSON.parse(readFileSync(this.statePath, "utf8")) as { network?: unknown };
      return typeof held.network === "string" ? held.network : null;
    } catch {
      // Absent or unreadable both mean the same thing: nothing is known to be
      // ours, so nothing is ours to leave.
      return null;
    }
  }

  private remember(network: string | null): void {
    if (network === null) unlinkDurable(this.statePath);
    else writeFileDurable(this.statePath, JSON.stringify({ network }) + "\n", 0o644);
  }

  private async systemctl(...args: string[]): Promise<void> {
    await this.run(["systemctl", ...args]);
  }

  async render(config: Config): Promise<void> {
    const { enabled, network_id } = config.remote.zerotier;
    const wanted = enabled && network_id !== null ? network_id : null;

    const held = this.owned();

    if (wanted === null) {
      // Leave only what we joined, then stop.
      if (held !== null && (await this.cli.installed())) {
        for (const net of await this.cli.listNetworks()) {
          if (net.nwid === held) {
            this.log(`zerotier: leaving ${net.nwid}`);
            await this.cli.leave(net.nwid);
          }
        }
      }
      this.remember(null);
      await this.systemctl("stop", UNIT);
      await this.systemctl("disable", UNIT);
      return;
    }

    // A network id that changed: leave the old one before joining the new, or
    // the device sits on both and the configuration describes neither.
    if (held !== null && held !== wanted && (await this.cli.installed())) {
      this.log(`zerotier: leaving ${held}`);
      await this.cli.leave(held).catch(() => {});
    }

    await this.systemctl("enable", "--now", UNIT);

    if (!(await this.cli.installed())) {
      throw new Error(
        `zerotier is configured but the client is not installed on this device; ` +
          `re-run the installer with a payload that carries it`,
      );
    }

    const joined = await this.cli.listNetworks();
    if (!joined.some((n) => n.nwid === wanted)) {
      this.log(`zerotier: joining ${wanted}`);
      await this.cli.join(wanted);
    } else {
      this.log(`zerotier: already on ${wanted}`);
    }
    this.remember(wanted);

    // Deliberately not waited on. The next thing that happens is that a human
    // approves this device in a controller, which may be a minute or a week,
    // and a render is not the place to wait for a person (R-VPN-06).
  }
}
```

- [ ] **Step 4: Run the renderer test and watch it pass**

Run: `npm test -w packages/yonder-core -- remote/renderer`
Expected: PASS, 10 tests.

- [ ] **Step 5: Write the failing reachability test**

Add to `packages/yonder-core/src/apply/reachability.test.ts`:

```ts
// A mesh join only ever adds a path. Measured on a board: joining installed one
// route for the mesh's own subnet, the default route and the LAN route were
// untouched, and a controller pushing 10.0.252.0/25 - overlapping the network
// the board was reached on - was refused by the client itself. So there is
// nothing for a confirmation window to guarantee (R-CFG-12, R-VPN-07).
it("does not hold a zerotier join", () => {
  const before = ConfigSchema.parse({ network: { ap: { psk: { secret: "ap_psk" } } }, ui: { editor: {} } });
  const after = { ...before, remote: { zerotier: { enabled: true, network_id: "9fef8a3bf9000001" } } };
  expect(affectsReachability(before, after)).toBe(false);
});

// Each mesh earns this separately. Everything is load-bearing until measured,
// and `tailscale up` installs packet-filter rules nobody has measured yet.
it("holds a change to any other part of remote", () => {
  const before = ConfigSchema.parse({ network: { ap: { psk: { secret: "ap_psk" } } }, ui: { editor: {} } });
  const after = structuredClone(before) as Config & { remote: { tailscale?: unknown } };
  after.remote.tailscale = { enabled: true };
  expect(affectsReachability(before, after)).toBe(true);
});
```

- [ ] **Step 6: Run it and watch the first assertion fail**

Run: `npm test -w packages/yonder-core -- reachability`
Expected: FAIL — `affectsReachability` returns `true`, because everything not explicitly removed is load-bearing.

- [ ] **Step 7: Earn the exemption**

In `packages/yonder-core/src/apply/reachability.ts`, extend the doc comment on
`withoutCosmetics` and the function itself:

```ts
/** The document with the fields that cannot affect reachability removed. */
function withoutCosmetics(config: Config): unknown {
  const copy = structuredClone(config) as {
    ui: Record<string, unknown>;
    remote?: Record<string, unknown>;
  };
  delete copy.ui.theme;
  // Joining a mesh only ever *adds* a path to this device; it cannot take away
  // the one the operator is using. Measured rather than assumed: on a board, a
  // join installed exactly one route - the mesh's own subnet - and left the
  // default route, the LAN route and the access-point route untouched. A
  // controller was then made to push a route overlapping the board's own LAN
  // and the client refused to install it.
  //
  // Only zerotier, and only because of that. Everything else here stays
  // load-bearing by default, which is this file's whole design: a second mesh
  // earns its own exemption with its own evidence, or does not get one
  // (R-VPN-07).
  // Optional: a configuration parsed by this schema always has `remote`, but
  // this function is the one place a missing section would throw rather than
  // simply compare unequal, and throwing here fails an apply.
  delete copy.remote?.zerotier;
  return copy;
}
```

- [ ] **Step 8: Run the tests and watch them pass**

Run: `npm test -w packages/yonder-core -- reachability`
Expected: PASS, including the pre-existing `ui.theme` cases.

- [ ] **Step 9: Run the whole suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/yonder-core/src/remote packages/yonder-core/src/apply
git commit -s -m "feat(remote): a renderer that joins, and a join that is kept not held — R-VPN-07, R-CFG-12"
```

---

## Task 6: The daemon's routes, and wiring the renderer in

**Requirements:** R-VPN-01, R-VPN-04

**Files:**
- Modify: `packages/yonder-core/src/daemon/routes.ts`
- Modify: `packages/yonder-core/src/daemon/server.ts`
- Test: `packages/yonder-core/src/daemon/routes.test.ts`

**Interfaces:**
- Consumes: `remoteState`, `RemoteState` from `../remote/state.js`; `RemoteRenderer`, `ZeroTierCli`.
- Produces: three routes —
  - `GET /remote/state` → `RemoteState`
  - `POST /remote/join` with body `{ networkId: string }` → `ApplyStatus`
  - `POST /remote/leave` → `ApplyStatus`
  and a new optional dep on the router: `remoteState?: () => Promise<RemoteState>`.

- [ ] **Step 1: Write the failing route tests**

Add to `packages/yonder-core/src/daemon/routes.test.ts`, following the existing
harness in that file:

```ts
describe("the remote routes", () => {
  it("GET /remote/state answers with the join state", async () => {
    const router = createRouter({
      ...deps,
      remoteState: async () => ({
        phase: "waiting-for-approval" as const,
        networkId: "9fef8a3bf9000001",
        deviceId: "9fef8a3bf9",
        addresses: [],
        interface: "ztuqliuo7y",
        detail: null,
      }),
    });
    const res = await router("GET", "/remote/state", undefined);
    expect(res.status).toBe(200);
    expect((res.body as { phase: string }).phase).toBe("waiting-for-approval");
  });

  // Never a 500 for a board that has no remote layer.
  it("GET /remote/state says so when this daemon has no remote layer", async () => {
    const router = createRouter({ ...deps, remoteState: undefined });
    expect((await router("GET", "/remote/state", undefined)).status).toBe(503);
  });

  it("POST /remote/join applies a configuration carrying the network id", async () => {
    const router = createRouter(deps);
    const res = await router("POST", "/remote/join", { networkId: "9fef8a3bf9000001" });
    expect(res.status).toBe(200);
    expect(applied.remote.zerotier).toEqual({ enabled: true, network_id: "9fef8a3bf9000001" });
  });

  // The last chance to catch a typo: a wrong id draws no complaint from the
  // client, it simply never finishes joining.
  it.each(["9FEF8A3BF9000001", "9fef8a3bf900000", "nonsense", ""])(
    "POST /remote/join refuses %s without touching the configuration",
    async (bad) => {
      const router = createRouter(deps);
      const res = await router("POST", "/remote/join", { networkId: bad });
      expect(res.status).toBe(400);
      expect((res.body as { error: string }).error).toMatch(/sixteen/i);
    },
  );

  it("POST /remote/leave clears the network and disables it", async () => {
    const router = createRouter(deps);
    const res = await router("POST", "/remote/leave", undefined);
    expect(res.status).toBe(200);
    expect(applied.remote.zerotier).toEqual({ enabled: false, network_id: null });
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm test -w packages/yonder-core -- daemon/routes`
Expected: FAIL — every remote route 404s.

- [ ] **Step 3: Add the routes**

In `packages/yonder-core/src/daemon/routes.ts`, add to the router's dependency type:

```ts
  /** The mesh join state. Absent on a daemon with no remote layer. */
  remoteState?: () => Promise<RemoteState>;
```

and add the three routes beside the `/net/*` ones:

```ts
      // The same shape as /net/join: the router merges one field into the
      // document and hands it to the engine. Nothing about a mesh is stored
      // anywhere else, and a network id is not a secret - it is the name of a
      // network, not a way into one - so it lives in config.yaml.
      if (method === "POST" && path === "/remote/join") {
        const wanted = (body as { networkId?: unknown } | undefined)?.networkId;
        if (typeof wanted !== "string" || !ZEROTIER_NETWORK_ID.test(wanted)) {
          return {
            status: 400,
            body: { error: "a ZeroTier network id is sixteen lowercase hexadecimal characters" },
          };
        }
        const config = loadConfig(deps.configPath);
        return {
          status: 200,
          body: await deps.engine.apply({
            ...config,
            remote: { ...config.remote, zerotier: { enabled: true, network_id: wanted } },
          }),
        };
      }

      if (method === "POST" && path === "/remote/leave") {
        const config = loadConfig(deps.configPath);
        return {
          status: 200,
          body: await deps.engine.apply({
            ...config,
            remote: { ...config.remote, zerotier: { enabled: false, network_id: null } },
          }),
        };
      }

      if (method === "GET" && path === "/remote/state") {
        if (deps.remoteState === undefined) {
          say("GET /remote/state: there is no remote layer on this daemon to ask");
          return { status: 503, body: { error: "this device cannot report its mesh state" } };
        }
        return { status: 200, body: await deps.remoteState() };
      }
```

Import `ZEROTIER_NETWORK_ID` from `../schema/config.js` and `RemoteState` from
`../remote/state.js` at the top of the file.

- [ ] **Step 4: Run the route tests and watch them pass**

Run: `npm test -w packages/yonder-core -- daemon/routes`
Expected: PASS.

- [ ] **Step 5: Wire the renderer into `buildRenderers`**

Add to `BuildRenderersOptions` in `packages/yonder-core/src/daemon/server.ts`.
**Required, not defaulted**, exactly as the `console` option beside it already
argues: a path with a default is a path a test writes to by forgetting to override
it, and this one would be `/var/lib/yonder`.

```ts
  /**
   * Where the remote renderer records the mesh it joined. **Given, never
   * defaulted**, like `console` below and for the same reason.
   */
  remoteStatePath: string;
```

Then, inside `buildRenderers`, after the network renderer is constructed and before
the console renderer:

```ts
  // After the network renderer: a mesh runs over whatever the network layer
  // just brought up, so ordering it first would join over an interface that
  // does not exist yet.
  const zerotier = new ZeroTierCli(opts.runner ?? systemRunner, opts.trace ?? trace);
  const remoteRenderer = new RemoteRenderer({
    cli: zerotier,
    run: opts.runner ?? systemRunner,
    statePath: opts.remoteStatePath,
    log,
  });
```

Every existing caller of `buildRenderers` — `startServer` and the tests that build a
renderer set — must now pass `remoteStatePath`. `startServer` passes
`join(stateDir, "remote.json")` from the state directory it already knows;
tests pass a path inside their own temp directory. The compiler will list them.

Add `remoteRenderer` to the returned `renderers` array after the network renderer,
and add `zerotier` and `remoteRenderer` to the returned object. Where `startServer`
builds the router deps, add:

```ts
    remoteState: async () =>
      remoteState({
        config: loadConfig(configPath),
        installed: await zerotier.installed(),
        info: await zerotier.info().catch(() => null),
        networks: await zerotier.listNetworks().catch(() => []),
      }),
```

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/yonder-core/src/daemon
git commit -s -m "feat(daemon): join, leave and mesh state over the socket — R-VPN-01"
```

---

## Task 7: Carry ZeroTier in the offline payload

**Requirements:** R-VPN-08, R-CFG-07

**Files:**
- Create: `installer/keys/zerotier.gpg`
- Modify: `installer/make-payload.sh`
- Modify: `installer/README.md`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `vendor/zerotier/zerotier-one_<version>_<arch>.deb`, which Task 8's role installs.

- [ ] **Step 1: Commit the publisher's key**

Fetch it once and commit it. It is a public key, and it is committed rather than
fetched at build time because **a key fetched from the host it authenticates proves
nothing**.

```bash
mkdir -p installer/keys
curl -fsSL -o installer/keys/zerotier.gpg \
  https://raw.githubusercontent.com/zerotier/ZeroTierOne/master/doc/contact%40zerotier.com.gpg
gpg --show-keys --with-fingerprint installer/keys/zerotier.gpg
```

Expected fingerprint, which must match exactly before the file is committed:

```
74A5 E9C4 58E1 A431 F1DA  57A7 1657 1988 23E5 2A61
ZeroTier, Inc. (ZeroTier Support and Release Signing Key) <contact@zerotier.com>
```

- [ ] **Step 2: Add the pinned version and fingerprints to `make-payload.sh`**

Beside `NODE_VERSION`, near the top:

```sh
# ZeroTier 1.16.2. Pinned and fingerprinted for the same reason Node is: a
# payload whose contents depend on the day it was built is not a payload.
#
# Both halves are checked at build time and they do different jobs. The
# recorded fingerprint is what a reviewer sees in a pull request when this
# version is bumped, and what makes two payloads built a week apart identical.
# The signature is what catches what a fingerprint cannot - the download site
# itself being tampered with - since the fingerprint would have been read off
# that same site when it was written down.
ZEROTIER_VERSION=${ZEROTIER_VERSION:-1.16.2}
ZEROTIER_REPO=${ZEROTIER_REPO:-https://download.zerotier.com/debian/trixie}
ZEROTIER_SHA256_arm64=e6c71707d8db57dd9bc6d6a4d5d5b8343ad244f48ff1ebd288f5f588fbdb10a4
ZEROTIER_SHA256_amd64=75589dbdc989546629e8676b186b1e7854b3fa3b5dac061b93f8c8e427af2b13
```

In the `case "$ARCH"` block that already sets `NPM_OS`/`NPM_CPU`, add the Debian
architecture name — Debian calls x86-64 `amd64`, npm calls it `x64`, and the payload
needs both:

```sh
    linux-arm64) NPM_OS=linux; NPM_CPU=arm64; DEB_ARCH=arm64 ;;
    linux-x64)   NPM_OS=linux; NPM_CPU=x64;   DEB_ARCH=amd64 ;;
```

- [ ] **Step 3: Add the payload step**

After the Node step and before the console step:

```sh
# ---------------------------------------------------------------------------
step "zerotier $ZEROTIER_VERSION for $DEB_ARCH"

command -v gpgv >/dev/null 2>&1 \
    || die "gpgv is needed to verify ZeroTier's repository signature"

ZT_DEB="zerotier-one_${ZEROTIER_VERSION}_${DEB_ARCH}.deb"
eval "ZT_EXPECTED=\$ZEROTIER_SHA256_$DEB_ARCH"
[ -n "$ZT_EXPECTED" ] || die "no recorded checksum for zerotier-one on $DEB_ARCH"

log "fetching the signed repository index"
curl -fsSL --retry 3 -o "$WORK/InRelease" "$ZEROTIER_REPO/dists/trixie/InRelease" \
    || die "could not download ZeroTier's InRelease"

log "verifying it against the key committed in installer/keys"
gpgv --keyring "$HERE/keys/zerotier.gpg" "$WORK/InRelease" >/dev/null 2>&1 \
    || die "ZeroTier's repository index is not signed by the key in installer/keys/zerotier.gpg"

log "fetching the package list"
curl -fsSL --retry 3 -o "$WORK/Packages" \
    "$ZEROTIER_REPO/dists/trixie/main/binary-$DEB_ARCH/Packages" \
    || die "could not download the package list for $DEB_ARCH"

# The index states the list's checksum; check it before believing the list.
# `awk` rather than `grep -A`: the SHA256 block is a fixed section of the
# index, and matching the file name anywhere in the document would also match
# the MD5Sum block above it.
want=$(awk '/^SHA256:/{s=1;next} /^[A-Z]/{s=0} s && $3=="main/binary-'"$DEB_ARCH"'/Packages"{print $1}' "$WORK/InRelease")
[ -n "$want" ] || die "the signed index does not list main/binary-$DEB_ARCH/Packages"
printf '%s  %s\n' "$want" "Packages" > "$WORK/packages.sha256"
( cd "$WORK" && $SHA_CHECK packages.sha256 ) >/dev/null \
    || die "the package list does not match the checksum in the signed index"

# And the list states the .deb's checksum. Matched on the exact file name so
# the check cannot pass because some other stanza happened to verify.
from_index=$(awk -v f="pool/main/z/zerotier-one/$ZT_DEB" '
    $1=="Filename:" && $2==f {found=1} $1=="SHA256:" && found {print $2; exit}' "$WORK/Packages")
[ -n "$from_index" ] || die "$ZT_DEB is not listed in the verified package list"
[ "$from_index" = "$ZT_EXPECTED" ] \
    || die "the signed index gives a different checksum for $ZT_DEB than this script records:
  index:    $from_index
  recorded: $ZT_EXPECTED
if the version was bumped deliberately, update ZEROTIER_SHA256_$DEB_ARCH"

log "fetching $ZT_DEB"
curl -fsSL --retry 3 -o "$WORK/$ZT_DEB" \
    "$ZEROTIER_REPO/pool/main/z/zerotier-one/$ZT_DEB" \
    || die "could not download $ZT_DEB"

printf '%s  %s\n' "$ZT_EXPECTED" "$ZT_DEB" > "$WORK/zt.sha256"
( cd "$WORK" && $SHA_CHECK zt.sha256 ) >/dev/null \
    || die "$ZT_DEB does not match its recorded checksum; refusing to stage it"
log "signature and checksum both match"

rm -rf "$OUT/zerotier"
mkdir -p "$OUT/zerotier"
mv "$WORK/$ZT_DEB" "$OUT/zerotier/$ZT_DEB"
log "staged $OUT/zerotier/$ZT_DEB"
```

Add to the closing `step "done"` block:

```sh
log "zerotier: $OUT/zerotier/$ZT_DEB"
```

- [ ] **Step 4: Run it and check the result**

```bash
./installer/make-payload.sh --arch linux-arm64
ls -l vendor/zerotier/
```

Expected: `zerotier-one_1.16.2_arm64.deb`, **2806628 bytes**, and the log lines
`signature and checksum both match` and `staged …`.

- [ ] **Step 5: Prove the checks actually fail**

A verification step that has never failed is a verification step nobody has tested.

```bash
ZEROTIER_VERSION=1.16.1 ./installer/make-payload.sh --arch linux-arm64
```

Expected: **failure**, with `the signed index gives a different checksum … recorded:` —
because 1.16.1 is a real version whose hash is not the recorded one.

```bash
ZEROTIER_REPO=https://download.zerotier.com/debian/bookworm ./installer/make-payload.sh --arch linux-arm64
```

Expected: either a signature failure or a checksum mismatch — never a staged file.

- [ ] **Step 6: Document it**

In `installer/README.md`, wherever the payload's contents are listed, add:

```markdown
- `vendor/zerotier/zerotier-one_<version>_<arch>.deb` — the primary mesh client.
  One file, ~2.7 MB, depending only on `adduser`, `libstdc++6` and `openssl`, all
  of which a stock Debian board already has. Pinned, fingerprinted, and verified
  against ZeroTier's repository signature using `installer/keys/zerotier.gpg`.
  Tailscale is **not** carried: it is 31 MB, pulls in `iptables` and two
  libraries that a board does not have, and switches four `update-alternatives`
  entries. It is fetched over the network by the role that installs it, which
  runs only when Tailscale is configured (R-VPN-08).
```

- [ ] **Step 7: Commit**

```bash
git add installer/keys installer/make-payload.sh installer/README.md
git commit -s -m "build(payload): carry zerotier, pinned and signature-verified — R-VPN-08, R-CFG-07"
```

---

## Task 8: Install it, and leave it stopped

**Requirements:** R-VPN-08, R-VPN-05, R-CFG-07

**Files:**
- Create: `installer/roles/40-zerotier.sh`
- Modify: `installer/README.md`

**Interfaces:**
- Consumes: `vendor/zerotier/*.deb` from Task 7; `ensure_dir`, `die`, `log`, `step`, `run` from `installer/lib/common.sh`.
- Produces: `zerotier-one` installed, **stopped and disabled**.

- [ ] **Step 1: Read what the helper library already gives you**

```bash
grep -n '^[a-z_]*()' installer/lib/common.sh
```

Use those helpers rather than raw commands, and honour `DRY_RUN` exactly as
`30-console.sh` does.

- [ ] **Step 2: Write the role**

`installer/roles/40-zerotier.sh`:

```sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Install the primary mesh client from the offline payload, and leave it off.
# shellcheck shell=sh

zt_src="$YONDER_SRC/vendor/zerotier"

# Not an error. A payload built without ZeroTier is a valid payload - the
# client is only needed by a device that will use a mesh - and R-CFG-08 says a
# freshly flashed device reaches a usable state regardless. So this role says
# what is missing and stops, rather than failing an install that is otherwise
# complete.
if [ ! -d "$zt_src" ]; then
    log "no zerotier in the payload; skipping"
    log "  build one with: installer/make-payload.sh --arch <linux-arm64|linux-x64>"
    return 0
fi

zt_deb=$(ls "$zt_src"/zerotier-one_*.deb 2>/dev/null | head -n 1)
[ -n "$zt_deb" ] || die "$zt_src exists but carries no zerotier-one .deb"

if command -v zerotier-cli >/dev/null 2>&1; then
    log "zerotier-one is already installed"
else
    log "installing $(basename "$zt_deb")"
    # apt-get, not dpkg -i: the three dependencies are all in Debian base and
    # already present on a stock board, but apt resolves them if they are not
    # and reports honestly if it cannot.
    run env DEBIAN_FRONTEND=noninteractive apt-get install -y "$zt_deb" \
        || die "could not install $(basename "$zt_deb")"
fi

# The whole point of this role's last two lines.
#
# The package enables and starts itself, and a zerotier-one with *zero networks
# joined* still holds live sessions with ZeroTier's root servers - a board
# printed four of them, unprompted, moments after the package landed. A device
# that talks to a company's infrastructure because software is merely present
# contradicts the first thing this project claims about itself.
#
# So the client ships installed and off. yonder-core starts it when, and only
# when, a network id is configured, and stops it again on leave (R-VPN-05,
# R-VPN-08).
log "stopping and disabling zerotier-one until a network is configured"
run systemctl stop zerotier-one || true
run systemctl disable zerotier-one || true
```

- [ ] **Step 3: Check it parses and behaves under `--dry-run`**

```bash
sh -n installer/roles/40-zerotier.sh
shellcheck installer/roles/40-zerotier.sh
./installer/install.sh --dry-run --only 40-zerotier
```

Expected: no syntax or shellcheck findings, and a dry run that prints the install
and the disable without performing either.

- [ ] **Step 4: Check the skip path**

```bash
mv vendor/zerotier /tmp/zt-aside && ./installer/install.sh --dry-run --only 40-zerotier
mv /tmp/zt-aside vendor/zerotier
```

Expected: `no zerotier in the payload; skipping`, exit 0. **Not** a failure.

- [ ] **Step 5: Commit**

```bash
git add installer/roles/40-zerotier.sh installer/README.md
git commit -s -m "feat(installer): install zerotier from the payload, and leave it off — R-VPN-08, R-VPN-05"
```

---

## Task 9: The console nodes

**Requirements:** R-VPN-01, R-VPN-04, R-UI-05

**Files:**
- Create: `packages/node-red-contrib-yonder-remote/package.json`
- Create: `packages/node-red-contrib-yonder-remote/tsconfig.json`
- Create: `packages/node-red-contrib-yonder-remote/vitest.config.ts`
- Create: `packages/node-red-contrib-yonder-remote/src/{state,join,leave}.ts` and matching `.html`
- Create: `packages/node-red-contrib-yonder-remote/src/state.test.ts`

**Interfaces:**
- Consumes: the daemon routes from Task 6.
- Produces: node types `yonder-remote-state`, `yonder-remote-join`, `yonder-remote-leave`. `flows/flows.json` in Task 10 refers to these names exactly.

- [ ] **Step 1: Copy the structure of an existing contrib package**

```bash
cp packages/node-red-contrib-yonder-network/tsconfig.json packages/node-red-contrib-yonder-remote/
cp packages/node-red-contrib-yonder-network/vitest.config.ts packages/node-red-contrib-yonder-remote/
```

Read `packages/node-red-contrib-yonder-network/src/scan.ts` first — it is the closest
existing node to `state.ts` and shows how a node reaches the daemon socket. **Follow
it exactly; do not invent a second way to call the socket.**

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "node-red-contrib-yonder-remote",
  "version": "0.1.0",
  "license": "GPL-3.0-or-later",
  "description": "Yonder console nodes for the mesh: join state, join and leave. Thin adapters over the yonder-core daemon socket; every decision lives in yonder-core.",
  "keywords": ["node-red", "yonder"],
  "node-red": {
    "version": ">=5.0.0",
    "nodes": {
      "yonder-remote-state": "dist/state.js",
      "yonder-remote-join": "dist/join.js",
      "yonder-remote-leave": "dist/leave.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json && node ../../scripts/copy-node-html.mjs",
    "test": "vitest run"
  },
  "dependencies": { "yonder-core": "^0.1.0" },
  "devDependencies": { "@types/node": "^20.19.43", "typescript": "^5.6.0" },
  "engines": { "node": ">=22.12" }
}
```

- [ ] **Step 3: Write the failing test**

`packages/node-red-contrib-yonder-remote/src/state.test.ts`:

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { messageFor } from "./state.js";

describe("messageFor", () => {
  // The node hands the page one object. Everything the page shows is a field
  // here, so no widget has to know what ACCESS_DENIED means.
  it("carries the address to approve while waiting", () => {
    const msg = messageFor({
      phase: "waiting-for-approval",
      networkId: "9fef8a3bf9000001",
      deviceId: "9fef8a3bf9",
      addresses: [],
      interface: "ztuqliuo7y",
      detail: null,
    });
    expect(msg.payload.label).toBe("Waiting for you to approve it");
    expect(msg.payload.deviceId).toBe("9fef8a3bf9");
    expect(msg.payload.waiting).toBe(true);
  });

  it("shows the assigned address once connected", () => {
    const msg = messageFor({
      phase: "connected",
      networkId: "9fef8a3bf9000001",
      deviceId: "9fef8a3bf9",
      addresses: ["10.147.20.26/24"],
      interface: "ztuqliuo7y",
      detail: null,
    });
    expect(msg.payload.label).toBe("Connected");
    expect(msg.payload.address).toBe("10.147.20.26/24");
  });

  it("says nothing is configured rather than reporting a problem", () => {
    const msg = messageFor({
      phase: "off",
      networkId: null,
      deviceId: null,
      addresses: [],
      interface: null,
      detail: null,
    });
    expect(msg.payload.label).toBe("Not configured");
    expect(msg.payload.waiting).toBe(false);
  });

  it("names the client's own word when there is a fault", () => {
    const msg = messageFor({
      phase: "fault",
      networkId: "9fef8a3bf9000001",
      deviceId: "9fef8a3bf9",
      addresses: [],
      interface: null,
      detail: "PORT_ERROR",
    });
    expect(msg.payload.label).toBe("PORT_ERROR");
  });
});
```

- [ ] **Step 4: Run it and watch it fail**

Run: `npm test -w packages/node-red-contrib-yonder-remote`
Expected: FAIL — `./state.js` does not exist.

- [ ] **Step 5: Write `messageFor` and the node**

In `packages/node-red-contrib-yonder-remote/src/state.ts`, alongside the node
registration copied from `scan.ts`:

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
import type { RemoteState } from "yonder-core";

/**
 * One object per state, so no widget has to know a client's vocabulary.
 *
 * `waiting` is its own field rather than a comparison the page makes, because
 * it is the state this whole surface is shaped around and it is neither a fault
 * nor a connection (R-VPN-06).
 */
export function messageFor(state: RemoteState): {
  payload: {
    label: string;
    waiting: boolean;
    networkId: string | null;
    deviceId: string | null;
    address: string | null;
    detail: string | null;
  };
} {
  const label =
    state.phase === "off"
      ? "Not configured"
      : state.phase === "no-client"
        ? "The mesh client is not installed"
        : state.phase === "joining"
          ? "Joining…"
          : state.phase === "waiting-for-approval"
            ? "Waiting for you to approve it"
            : state.phase === "connected"
              ? "Connected"
              : (state.detail ?? "Fault");

  return {
    payload: {
      label,
      waiting: state.phase === "waiting-for-approval",
      networkId: state.networkId,
      deviceId: state.deviceId,
      address: state.addresses[0] ?? null,
      detail: state.detail,
    },
  };
}
```

Export `RemoteState` from `packages/yonder-core/src/index.ts` if it is not already
exported, so this import resolves.

- [ ] **Step 6: Write `join.ts` and `leave.ts`**

Copy `packages/node-red-contrib-yonder-network/src/join.ts` and change only the route
it posts to — `/remote/join` with `{ networkId: msg.payload }`, and `/remote/leave`
with no body. **Do not add validation here:** the daemon already refuses anything
that is not sixteen lowercase hex characters, and a second copy of that rule is how
the two stop agreeing.

- [ ] **Step 7: Run the tests and watch them pass**

Run: `npm test -w packages/node-red-contrib-yonder-remote`
Expected: PASS, 4 tests.

- [ ] **Step 8: Build and check the HTML was copied**

```bash
npm run build -w packages/node-red-contrib-yonder-remote
ls packages/node-red-contrib-yonder-remote/dist/
```

Expected: `state.js`, `state.html`, `join.js`, `join.html`, `leave.js`, `leave.html`.
A missing `.html` is a node that registers and cannot be placed on a flow.

- [ ] **Step 9: Commit**

```bash
git add packages/node-red-contrib-yonder-remote
git commit -s -m "feat(console): nodes for mesh state, join and leave — R-VPN-01"
```

---

## Task 10: The ZeroTier tab, and a shape check that walks tabs

**Requirements:** R-VPN-06, R-UI-08, R-UI-10, R-UI-12

**Files:**
- Modify: `flows/flows.json`
- Modify: `scripts/capture-pages.mjs`
- Modify: `installer/roles/30-console.sh` (add the new package to the linked list)
- Test: `packages/yonder-core/src/flows.test.ts`

**Interfaces:**
- Consumes: node types `yonder-remote-state`, `yonder-remote-join`, `yonder-remote-leave` from Task 9.
- Produces: the `ZeroTier` tab, and `network-<tab>.{day,night}` shape references.

- [ ] **Step 1: Turn the Network page into a tabbed page**

In `flows/flows.json`:

- On the `page-network` node, set `"layout": "tabs"`.
- On `group-net-now`, set `"name": "Interfaces"` and `"showTitle": true`. It was an
  unnamed group, which a grid could hide and a tab strip cannot — a tab takes its
  label from its group's name.
- Set `group-net-activity` to `"order": 4`.
- Add a group:

```json
{
  "id": "group-net-zerotier",
  "type": "ui-group",
  "name": "ZeroTier",
  "page": "page-network",
  "width": 12,
  "height": 1,
  "order": 3,
  "showTitle": true,
  "className": "",
  "visible": true,
  "disabled": false,
  "groupType": "default"
}
```

The tab is named for its mesh, not `Remote`. The operator on it is about to open
ZeroTier's website; naming the tab after the thing they are going to use is the
shortest path between the console and the task. Tailscale gets its own tab in M2b.

- [ ] **Step 2: Wire the tab, with no `function` node**

Add to `group-net-zerotier`, wiring only (CLAUDE.md rule 2): a `ui-text-input` for the
network ID, a `ui-button` labelled `Join`, `ui-text` widgets bound to
`payload.label`, `payload.networkId` and `payload.deviceId`, a `ui-button` labelled
`Copy`, and a `ui-button` labelled `Leave`. Drive them from a `yonder-remote-state`
node on an `inject` with `"repeat": "5"`.

**R-UI-10: `Join` is this tab's one primary action and the only one in the group.**
`Copy` and `Leave` are secondary, and `Leave` is the destructive one, so it is never
the largest control on the surface.

**No poll tighter than 2 s** (R-UI-06); 5 s is the interval used here, and
authorisation propagates in under two seconds once granted, so nothing is lost by it.

- [ ] **Step 3: Make the shape check walk the tabs**

In `scripts/capture-pages.mjs`, `pagesFromFlows()` currently returns one entry per
`ui-page`. A tabbed page renders one tab at a time, so capturing it once would
silently narrow R-UI-12's coverage to whichever tab is first. Give each tab its own
entry:

```js
/** The pages, from the shipped flows rather than a list beside them. */
function pagesFromFlows() {
  const flows = JSON.parse(readFileSync(join(REPO, "flows/flows.json"), "utf8"));
  const base = flows.find((n) => n.type === "ui-base");
  const out = [];
  for (const p of flows.filter((n) => n.type === "ui-page")) {
    const slug = String(p.name).toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const url = (base?.path ?? "/dashboard") + p.path;
    // A tabbed page shows one group at a time, so "every page" would quietly
    // mean "the first tab" unless each tab is captured in its own right
    // (R-UI-12). The tab's label is its group's name.
    if (p.layout === "tabs") {
      const tabs = flows
        .filter((n) => n.type === "ui-group" && n.page === p.id)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      for (const [i, g] of tabs.entries()) {
        out.push({
          name: `${slug}-${String(g.name).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
          title: `${p.name} · ${g.name}`,
          url,
          tabIndex: i,
        });
      }
    } else {
      out.push({ name: slug, title: p.name, url });
    }
  }
  return out;
}
```

and, in the capture loop, after the widget selector has been waited for and before
`measure` runs:

```js
  // Select this entry's tab. Vuetify renders every tab's panel but shows one,
  // so the click is what makes the measured shape the shape a person sees.
  if (page.tabIndex !== undefined) {
    const tabs = tab.locator('.v-tab, [role="tab"]');
    if ((await tabs.count()) > page.tabIndex) {
      await tabs.nth(page.tabIndex).click();
      await tab.waitForTimeout(400);
    }
  }
```

- [ ] **Step 4: Add the package to the console role**

In `installer/roles/30-console.sh`, add `node-red-contrib-yonder-remote` to the list
of packages linked into the console tree, beside `node-red-contrib-yonder-network`.

- [ ] **Step 5: Assert the flows use the new node types**

`packages/yonder-core/src/flows.test.ts` already checks that every registered node
type is used by the shipped flows. Add:

```ts
it.each(["yonder-remote-state", "yonder-remote-join", "yonder-remote-leave"])(
  "the shipped flows use %s",
  (type) => {
    expect(JSON.stringify(flows)).toContain(`"${type}"`);
  },
);

// CLAUDE.md rule 2: a function node is JavaScript serialised next to wire
// coordinates, so it cannot be reviewed, so it cannot be merged.
it("ships no function node", () => {
  expect(flows.some((n) => n.type === "function")).toBe(false);
});
```

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Build a payload and run the page gate**

```bash
npm run build
./installer/make-payload.sh --arch linux-arm64
./scripts/verify-pages.sh
```

Expected: the flows load, every node type registers, and the capture step **fails**
on first run with `page(s) changed shape without being accepted` — because the
Network page now has tabs and four new references do not exist yet. Read the
captures in `vendor/capture/` before accepting anything.

- [ ] **Step 8: Look at the new pages, then accept the shape**

Open `vendor/capture/network-zerotier.day.png` and `network-zerotier.night.png` and
confirm: the tab strip is legible in both palettes, `Join` is the only primary action
on the tab, and nothing is clipped or spilling.

```bash
ACCEPT_SHAPE=1 ./scripts/verify-pages.sh
```

Expected: green, with new references for `network-interfaces`, `network-wi-fi`,
`network-zerotier` and `network-activity` in both palettes.
`docs/console/accepted-violations.json` must stay empty — it may only shrink.

- [ ] **Step 9: Commit**

```bash
git add flows/flows.json scripts/capture-pages.mjs installer/roles/30-console.sh \
        packages/yonder-core/src/flows.test.ts docs/console
git commit -s -m "feat(console): a ZeroTier tab, and a shape check that walks tabs — R-VPN-06, R-UI-12"
```

---

## Task 11: Prove it on a board

**Requirements:** R-VPN-01, R-VPN-04, R-VPN-06, R-VPN-08

**Files:**
- Modify: `docs/roadmap.md` (M2's exit criterion)
- Modify: `docs/known-issues.md` (only if this finds something)

Nothing above proves anything about systemd, a board, or a real controller. Unit
tests run against a fake runner by design, and `verify-pages.sh` says so in its own
header. This task is the part a person has to do.

- [ ] **Step 1: Install onto a board with no network**

Copy the repository, `vendor/` included, to a board that has never had ZeroTier, and
run the installer with the board's uplink unplugged.

```bash
sudo ./installer/install.sh
```

Expected: it completes. `zerotier-cli -j info` answers, and:

```bash
systemctl is-enabled zerotier-one   # disabled
systemctl is-active zerotier-one    # inactive
```

**Both matter.** An installed-and-running client is the defect R-VPN-08's last
sentence exists to prevent.

- [ ] **Step 2: Join from the console, and watch it wait**

Open the console, go to Network → ZeroTier, paste a real network ID, press `Join`.

Expected, in order: `Joining…` for a few seconds, then **`Waiting for you to approve
it`** with a ten-hex address and a `Copy` button. On a real board that transition took
about four seconds.

- [ ] **Step 3: Leave it waiting, deliberately**

Walk away for ten minutes. Come back.

Expected: still `Waiting for you to approve it`. **Nothing has reverted and nothing
has timed out** (R-VPN-07). If the configuration has rolled back, the reachability
exemption from Task 5 is not in effect — stop and fix that before going on.

- [ ] **Step 4: Approve it**

Authorise the device in the controller, without touching the console.

Expected: within a couple of seconds the tab shows `Connected` and an address. On a
board this propagated in under two seconds with no operator action.

- [ ] **Step 5: Open the console over the mesh**

From a machine on the same ZeroTier network and **on no shared local network**, open
`http://<the mesh address>:3000`.

Expected: the whole console, not a reduced one (R-VPN-04). This is M2's exit
criterion.

- [ ] **Step 6: Leave, and check the client stops**

Press `Leave`.

Expected: the tab returns to `Not configured`, `zerotier-cli -j listnetworks` is `[]`,
and `systemctl is-active zerotier-one` is `inactive` again.

- [ ] **Step 7: Record what actually happened**

Update M2's exit criterion in `docs/roadmap.md` to record the run — board, date,
result — in the style `docs/verifying-the-console.md` already uses. Anything that
did not behave as written above becomes a `K-` entry in `docs/known-issues.md` with
a stable number; do not fix it silently and do not leave it unrecorded.

- [ ] **Step 8: Commit**

```bash
git add docs/roadmap.md docs/known-issues.md
git commit -s -m "docs: record M2a proven on a board — R-VPN-01, R-VPN-04, R-VPN-06"
```
