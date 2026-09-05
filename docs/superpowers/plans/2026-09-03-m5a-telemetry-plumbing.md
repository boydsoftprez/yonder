# M5a — Telemetry Plumbing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Find the flight controller on a serial port, fan its MAVLink out to ground stations without the control plane in the path, and report honestly whether the link is alive — reading nothing but heartbeats.

**Architecture:** `mavlink-router` runs as its own systemd service and owns the serial port, so a Node-RED restart is invisible to Mission Planner (`R-MAV-06`). `yonder-core` detects the port and speed *before* the router starts, generates the router's configuration from `config.yaml`, and consumes a loopback copy on `:14559`. Everything decided lives in pure modules in `yonder-core/src/mav/`; the console reaches them over the existing daemon socket and holds no privilege of its own.

**Tech Stack:** TypeScript (ESM, Node ≥22.12), Zod for the schema, Vitest, Node-RED 5 + Dashboard 2.x, `mavlink-router` (Meson/C++), systemd, `nmcli`-style injected `CommandRunner`.

**Spec:** [`2026-09-03-telemetry-plumbing-design.md`](../specs/2026-09-03-telemetry-plumbing-design.md). Section references below (§1…§10) are to that document.

## Global Constraints

- **Logic never goes in a Node-RED `function` node.** Behaviour lives in `packages/node-red-contrib-yonder-*`, presentation in `node-red-dashboard-2-yonder`. `flows/flows.json` is wiring only, and a test asserts the artefact contains no `function` node. (CLAUDE.md rule 2, ADR-0001)
- **Every change traces to a requirement ID.** Where a behaviour has no requirement, the requirement is added to `docs/requirements.md` **in the same commit**. IDs are stable — never reuse, never renumber. (CLAUDE.md rule 3)
- **Commits and tags are GPG-signed *and* DCO signed-off.** `git commit -s`, never `--no-gpg-sign`; if signing fails, fix signing. (CLAUDE.md rule 5, [ADR-0002](../../adr/0002-licence-gplv3.md) — every commit on `main` carries both.)
- **The blueprint is committed, not remembered.** The agreed screens are
  [`docs/console/design/telemetry/`](../../console/design/telemetry/README.md), and its
  README names the node type behind every control. **Build from that table, not from prose.**
  The camera view shipped eleven of twenty-three widgets as stock Dashboard controls because
  its spec described behaviour and never named instruments; that README records the cause so
  it is not repeated.
- **`R-UI-19`:** every node type the shipped flows use must be provided by a package the
  install path installs, and the build fails when one is not.
- **`R-UI-16`:** text legibility on controls is *measured* by the build in both palettes, not
  reviewed by eye.
- **Nothing shells out except a renderer**, and only through the injected `CommandRunner` from `packages/yonder-core/src/net/runner.ts`. No test may execute `mavlink-router` or open a real serial port. (ADR-0006)
- **No test waits on the wall clock.** Take the injected `Clock` from `packages/yonder-core/src/apply/types.ts`. (established across `net/`, `remote/`)
- **One declarative file is the only writer.** `/etc/mavlink-router/main.conf` is generated from `config.yaml` on every apply and never hand-edited.
- **Nothing may make the device unreachable.** Any change touching networking or configuration works *with* the rollback engine and the access-point fallback, never around it. (CLAUDE.md rule 6, `R-NET-07`, `R-CFG-03`)
- **The repository is self-contained.** No reference to paths, repositories or products outside it. (CLAUDE.md rule 1)
- **Node packages are unscoped**, named `node-red-contrib-yonder-*`.
- **Every file starts with** `// SPDX-License-Identifier: GPL-3.0-or-later`.
- **Baud rates, in sweep order:** `57600, 115200, 230400, 921600` — slowest first, so a slow link is found rather than a fast one guessed at.
- **Default ports:** ground stations `14550 / 14551 / 14552`, TCP server `5760`, loopback copy `127.0.0.1:14559`.
- **Retry cadence when nothing is found:** 30 seconds (§3).
- **Run tests with** `npx vitest run --root packages/<pkg>`. A fresh worktree has no
  `node_modules`; `npm ci` at the repository root installs the workspace. (An earlier draft
  of this line named a path on one developer's machine, which rule 1 forbids in a committed
  file — the repository is self-contained and its setup instructions have to be too.)

---

## What already exists

**The page is built.** The blueprint for this milestone is not a drawing — it is
`flows/flows.json`, standing up in the real console with real widgets, and every value on it
arriving from one `inject` and thirty-two `change` nodes carrying static payloads. Stand it
up and look at it before starting:

```bash
ACCEPT_SHAPE=1 HOLD=1 PORT=18900 ./scripts/verify-pages.sh
```

| Landed | What it is |
|---|---|
| `page-telemetry` and its five groups | Autopilot, Ground stations, Telemetry (rail), Path check (rail), and the pending banner `R-UI-15` requires |
| `group-status-telemetry` | The flow strip on the Status page, between `This board` and `Reachable by` |
| `ui-yonder-flow` | A new instrument — three places, two legs, an absent leg dashed and grey |
| `YonderSoftKeys` `caution` tone | Amber, for a key that is deliberately on and hazardous |
| 32 `mock-*` change nodes | **The work of Tasks 12 and 14 is to delete these**, one at a time, as a real node starts producing what each one fakes |

So the console tasks below are no longer "design a page and build it". They are "replace a
known static payload with a real one, and delete the node that was faking it". Every one of
them can be verified by looking at the page before and after and seeing nothing change.

Four defects were found by building it rather than drawing it, and are recorded here because
they are the ones a later page will hit again: **a widget's width is relative to its group,
not to the page**; **an annunciator's `label` replaces its caption rather than titling it**,
so a labelled row is two widgets; **a `ui-text` with an empty `format` renders nothing**; and
**Vuetify floats a field's label only when the field has content**, so an unset field needs
its name in its own column or it looks like a different control.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/yonder-core/src/schema/config.ts` | *(modify)* the `mavlink` section |
| `packages/yonder-core/src/apply/reachability.ts` | *(modify)* the `R-CFG-12` exemption, leaf by leaf |
| `packages/yonder-core/src/mav/frame.ts` | Pure. Bytes → heartbeats. Not a MAVLink library and must not become one |
| `packages/yonder-core/src/mav/detect.ts` | Pure over an injected port. The sweep, and its three outcomes |
| `packages/yonder-core/src/mav/hint.ts` | The remembered port and speed. State, never configuration |
| `packages/yonder-core/src/mav/router/config.ts` | Pure. `Config` + a detected link → `mavlink-router`'s ini |
| `packages/yonder-core/src/mav/link.ts` | Pure. Heartbeats and counters → the one state the console renders |
| `packages/yonder-core/src/mav/renderer.ts` | `MavlinkRenderer implements Renderer`. The only thing here that shells out |
| `packages/yonder-core/src/mav/listener.ts` | The loopback UDP socket on `:14559`, feeding `link.ts` |
| `packages/yonder-core/src/daemon/routes.ts` | *(modify)* `/mav/*` routes |
| `packages/node-red-contrib-yonder-mavlink/` | Nodes: thin adapters over the daemon socket |
| `packages/node-red-dashboard-2-yonder/src/flow.*` | The Status page's flow strip, as a component |
| `flows/flows.json` | *(modify)* wiring only: the Telemetry page |
| `installer/roles/` | The UART role, and the `mavlink-router` payload role |
| `docs/requirements.md` | *(modify)* `R-MAV-13`; `R-CFG-12` extended |

---

## Task 1: Bench — does the kernel report framing errors on this port?

§10.1. **Do this first: it can change what `R-MAV-13` says**, and Task 5 is written against its answer.

**Files:**
- Create: `docs/hardware/an-autopilot-on-the-uart.md`
- Modify: `installer/roles/` — nothing yet; this task only measures

**Interfaces:**
- Consumes: nothing
- Produces: a recorded answer to "can we tell malformed bytes from no bytes", which Task 5's `DetectOutcome` union depends on

- [ ] **Step 1: Free the UART on the board**

On the development board (`ssh yonder@10.0.252.246`), by hand — the installer role is Task 14:

```bash
sudo cp /boot/firmware/config.txt /boot/firmware/config.txt.before-uart
printf '\n# bench: autopilot on pins 8/10\nenable_uart=1\ndtoverlay=disable-bt\n' | sudo tee -a /boot/firmware/config.txt
sudo sed -i 's/console=serial0,115200 //' /boot/firmware/cmdline.txt
sudo systemctl disable --now serial-getty@ttyAMA0.service hciuart.service
sudo reboot
```

- [ ] **Step 2: Wire the autopilot and confirm bytes arrive at all**

Pin 6 → GND, pin 8 → autopilot **RX**, pin 10 → autopilot **TX**. Then:

```bash
stty -F /dev/ttyAMA0 57600 raw -echo && timeout 5 xxd -l 256 /dev/ttyAMA0
```

Expected: bytes beginning `fd` (MAVLink v2) or `fe` (v1). If nothing, the wire is wrong — that is itself the first row of §3's table and worth recording.

- [ ] **Step 3: Read the framing-error counter at a deliberately wrong speed**

This is the measurement the whole task exists for. Save as `/tmp/icount.c` on the board:

```c
#include <stdio.h>
#include <fcntl.h>
#include <sys/ioctl.h>
#include <linux/serial.h>
#include <unistd.h>
int main(int argc, char **argv) {
  int fd = open(argv[1], O_RDONLY | O_NOCTTY);
  struct serial_icounter_struct c;
  if (ioctl(fd, TIOCGICOUNT, &c) < 0) { perror("TIOCGICOUNT"); return 1; }
  printf("rx=%d frame=%d parity=%d overrun=%d brk=%d\n",
         c.rx, c.frame, c.parity, c.overrun, c.brk);
  return 0;
}
```

```bash
cc -o /tmp/icount /tmp/icount.c
stty -F /dev/ttyAMA0 921600 raw -echo   # deliberately wrong
timeout 3 cat /dev/ttyAMA0 > /dev/null; /tmp/icount /dev/ttyAMA0
stty -F /dev/ttyAMA0 57600 raw -echo    # correct
timeout 3 cat /dev/ttyAMA0 > /dev/null; /tmp/icount /dev/ttyAMA0
```

Expected if the assumption holds: `frame` climbs sharply at the wrong speed and barely moves at the right one, while `rx` climbs at both.

- [ ] **Step 4: Record what actually happened**

Write `docs/hardware/an-autopilot-on-the-uart.md` in the voice of `docs/hardware/usb-camera-on-a-pi-4.md`: a table of what was observed with the date and the board, then what it means for the design. It must answer, in one sentence each:

1. Does `TIOCGICOUNT` report a rising `frame` count at a wrong speed? (**yes** → §3's three outcomes stand as written)
2. If not, does `rx` climb at a wrong speed while no frame ever checksums? (**yes** → the middle outcome survives by counting bytes-in against frames-accepted, and the console's wording does not change)
3. If neither — `rx` is also flat at a wrong speed — then **`R-MAV-13` reduces to two outcomes** and the wiring advice is given in both cases. Say so plainly.

Add a `<!-- yonder:hardware-observed -->` marker under the heading, as that file does.

- [ ] **Step 5: Restore the board and commit the note**

```bash
sudo cp /boot/firmware/config.txt.before-uart /boot/firmware/config.txt && sudo reboot
```

```bash
git add docs/hardware/an-autopilot-on-the-uart.md
git commit -s -m "docs(hardware): what the UART reports at a wrong baud — R-MAV-13"
```

---

## Task 2: Bench — build `mavlink-router` for arm64, and see what it says about its endpoints

§10.2 and §10.3, which are the same binary and belong in the same sitting.

**Files:**
- Modify: `docs/hardware/an-autopilot-on-the-uart.md` — a second section

**Interfaces:**
- Consumes: Task 1's board setup
- Produces: the answer that decides whether Task 8's `LinkState` carries one `answering` field or one per endpoint

- [ ] **Step 1: Build it on the board**

```bash
sudo apt-get install -y git meson ninja-build pkg-config g++ python3
git clone --recurse-submodules https://github.com/mavlink-router/mavlink-router /tmp/mr
cd /tmp/mr && meson setup build . && ninja -C build && ./build/src/mavlink-routerd --version
```

Record: the version, how long the build took, and the size of the resulting binary. That is the §10.2 cost.

- [ ] **Step 2: Run it against the autopilot and a ground station that answers**

Three things an earlier draft of this step got wrong, all of which would have produced no
evidence at all: `nc -u -l` only *receives*, so nothing ever heartbeats back and §10.3 cannot
be answered; upstream installs no `SIGUSR1` handler, so that signal **kills the router**
rather than dumping statistics; and a foreground process's stdout is not in the journal.

Statistics are a configuration setting, and they already print per-endpoint counters by name.

```bash
cat > /tmp/mr.conf <<'EOF'
[General]
ReportStats = true
TcpServerPort = 0

[UartEndpoint autopilot]
Device = /dev/ttyAMA0
Baud = 57600

[UdpEndpoint gcs0]
Mode = Normal
Address = 127.0.0.1
Port = 14550
EOF
./build/src/mavlink-routerd -c /tmp/mr.conf 2>&1 | tee /tmp/mr.log
```

In another shell, be a ground station that actually answers — a heartbeat every second to the
port the router is sending to, from the port it will see:

```bash
python3 - <<'EOF'
import socket, struct, time
def crc(b, extra):
    c = 0xffff
    for x in list(b) + [extra]:
        t = (x ^ (c & 0xff)) & 0xff; t = (t ^ (t << 4)) & 0xff
        c = ((c >> 8) ^ (t << 8) ^ (t << 3) ^ (t >> 4)) & 0xffff
    return c
pay = struct.pack('<IBBBBB', 0, 6, 8, 0, 4, 3)          # MAV_TYPE_GCS, AUTOPILOT_INVALID
head = bytes([len(pay), 0, 0, 0, 255, 190, 0, 0, 0])     # sysid 255, compid 190
frame = bytes([0xfd]) + head + pay + struct.pack('<H', crc(head + pay, 50))
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.bind(('127.0.0.1', 14550))
while True: s.sendto(frame, ('127.0.0.1', 14550)); time.sleep(1)
EOF
```

- [ ] **Step 2a: Read the statistics**

```bash
grep -A 20 -i 'stat' /tmp/mr.log | tail -40
```

- [ ] **Step 3: Answer §10.3 in one sentence**

Does the statistics output attribute received traffic to a *named endpoint*, or only totals? Append to the hardware note:

- **Per-endpoint counters exist** → Task 8's `LinkState.groundStations` becomes an array with a state per entry, and §6's "we do not claim which" is lifted. Say so, and say which field carries it.
- **Only totals** → the design as specified stands unchanged.

- [ ] **Step 4: Commit**

```bash
git add docs/hardware/an-autopilot-on-the-uart.md
git commit -s -m "docs(hardware): building mavlink-router on the board, and what it reports"
```

---

## Task 3: The `mavlink` section in the schema

[`configuration.md`](../../configuration.md) already documents a `mavlink:` block. **The schema has never had one**, so that documentation is currently a promise the code does not keep — the same shape as `K-39`. This closes it.

**Files:**
- Modify: `packages/yonder-core/src/schema/config.ts`
- Test: `packages/yonder-core/src/schema/config.test.ts` (or the existing round-trip test file — follow whichever the package already uses for schema cases)
- Modify: `docs/configuration.md`

**Interfaces:**
- Consumes: nothing
- Produces: `Config["mavlink"]` with this exact shape, which every later task reads:
  ```ts
  {
    serial: { device: string | "auto"; baud: number | "auto" };
    endpoints: { name: string; host: string; port: number }[];  // max 3
    tcp_server: { enabled: boolean; port: number };
    autocast: boolean;
    ingest: { loopback_only: boolean };
  }
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// packages/yonder-core/src/schema/mavlink.test.ts
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { ConfigSchema, DEFAULT_CONFIG } from "./config.js";

describe("the mavlink section", () => {
  it("defaults to auto detection, no endpoints, tcp on, autocast on, loopback ingest", () => {
    expect(DEFAULT_CONFIG.mavlink).toEqual({
      serial: { device: "auto", baud: "auto" },
      endpoints: [],
      tcp_server: { enabled: true, port: 5760 },
      autocast: true,
      ingest: { loopback_only: true },
    });
  });

  it("takes three ground stations and refuses a fourth (R-MAV-03)", () => {
    const three = [
      { name: "gcs0", host: "192.168.2.10", port: 14550 },
      { name: "gcs1", host: "10.147.20.8", port: 14551 },
      { name: "gcs2", host: "10.147.20.9", port: 14552 },
    ];
    expect(ConfigSchema.parse({ ...DEFAULT_CONFIG, mavlink: { ...DEFAULT_CONFIG.mavlink, endpoints: three } })
      .mavlink.endpoints).toHaveLength(3);
    expect(() => ConfigSchema.parse({
      ...DEFAULT_CONFIG,
      mavlink: { ...DEFAULT_CONFIG.mavlink, endpoints: [...three, { name: "gcs3", host: "1.2.3.4", port: 14553 }] },
    })).toThrow();
  });

  it("accepts a pinned device and baud, and refuses a baud outside the sweep", () => {
    const pinned = ConfigSchema.parse({
      ...DEFAULT_CONFIG,
      mavlink: { ...DEFAULT_CONFIG.mavlink, serial: { device: "/dev/ttyAMA0", baud: 57600 } },
    });
    expect(pinned.mavlink.serial).toEqual({ device: "/dev/ttyAMA0", baud: 57600 });
    expect(() => ConfigSchema.parse({
      ...DEFAULT_CONFIG,
      mavlink: { ...DEFAULT_CONFIG.mavlink, serial: { device: "/dev/ttyAMA0", baud: 9600 } },
    })).toThrow();
  });

  // R-MAV-14. mavlink-router starts before the console; if it takes the
  // console's port the console cannot bind and the operator loses the page
  // they would fix it from. Refused at write time, because a renderer runs
  // after the apply has already been accepted.
  it("refuses a MAVLink TCP port the device already serves on (R-MAV-14)", () => {
    const clash = { ...DEFAULT_CONFIG,
      mavlink: { ...DEFAULT_CONFIG.mavlink, tcp_server: { enabled: true, port: DEFAULT_CONFIG.ui.port } } };
    expect(() => ConfigSchema.parse(clash)).toThrow(/ui\.port|already/i);
  });

  it("allows the same port once the console has moved off it", () => {
    const moved = { ...DEFAULT_CONFIG,
      ui: { ...DEFAULT_CONFIG.ui, port: 3001 },
      mavlink: { ...DEFAULT_CONFIG.mavlink, tcp_server: { enabled: true, port: 3000 } } };
    expect(() => ConfigSchema.parse(moved)).not.toThrow();
  });

  it("is strict — a misspelled key is refused, not ignored (R-CFG-09)", () => {
    expect(() => ConfigSchema.parse({
      ...DEFAULT_CONFIG,
      mavlink: { ...DEFAULT_CONFIG.mavlink, autocasst: true },
    })).toThrow();
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run --root packages/yonder-core src/schema/mavlink.test.ts`
Expected: FAIL — `DEFAULT_CONFIG.mavlink` is `undefined`.

- [ ] **Step 3: Add the section**

In `packages/yonder-core/src/schema/config.ts`, above `ConfigSchema`:

```ts
/**
 * The rates ArduPilot is actually configured for in the field, slowest first.
 * Slowest first so a slow link is *found* rather than a fast one guessed at —
 * a wrong fast rate produces noise that a slow one would have decoded.
 */
export const MAVLINK_BAUDS = [57600, 115200, 230400, 921600] as const;

const MavlinkSerial = z
  .object({
    device: z.string().min(1).default("auto"),
    baud: z.union([z.literal("auto"), z.union(MAVLINK_BAUDS.map((b) => z.literal(b)) as [z.ZodLiteral<number>, z.ZodLiteral<number>, ...z.ZodLiteral<number>[]])])
      .default("auto"),
  })
  .strict();

/**
 * Three, because R-MAV-03 says three. The limit is in the schema rather than
 * in a renderer so a fourth is refused with the offending path named, at the
 * moment the operator writes it, rather than silently dropped later.
 */
const MavlinkEndpoint = z
  .object({ name: z.string().min(1), host: z.string().min(1), port: z.number().int().min(1).max(65535) })
  .strict();

const Mavlink = z
  .object({
    serial: MavlinkSerial.default({}),
    endpoints: z.array(MavlinkEndpoint).max(3).default([]),
    tcp_server: z.object({ enabled: z.boolean().default(true), port: z.number().int().min(1).max(65535).default(5760) })
      .strict().default({}),
    autocast: z.boolean().default(true),
    // R-MAV-07: an open MAVLink port on a routable address is an
    // unauthenticated command path to the vehicle. Closed unless asked for,
    // and the asking is logged.
    ingest: z.object({ loopback_only: z.boolean().default(true) }).strict().default({}),
  })
  .strict();
```

Then add `mavlink: Mavlink.default({}),` to `ConfigSchema`, after `remote` — and give the
whole document a refinement, because the check is between two sections and cannot live in
either one:

```ts
.superRefine((config, ctx) => {
  // R-MAV-14. The router is started by yonder-core before the console is, so
  // a collision is not a race the console can win. Refused here rather than
  // in a renderer: a renderer runs after the apply has been accepted, and by
  // then the confirmation window is the only thing left to catch it.
  if (config.mavlink.tcp_server.enabled && config.mavlink.tcp_server.port === config.ui.port) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["mavlink", "tcp_server", "port"],
      message: `port ${config.ui.port} is the console's own (ui.port); MAVLink cannot take it`,
    });
  }
});
```

**`.superRefine` goes on `ConfigSchema` after `.strict()`**, and note it changes the exported
type from `ZodObject` to `ZodEffects` — anything that calls `.parse` is unaffected, but a call
site reaching for `.shape` or `.extend` is not. Check `schema/generate.ts` still emits, since
`zod-to-json-schema` handles effects differently.

- [ ] **Step 4: Run the tests and the whole suite**

Run: `npx vitest run --root packages/yonder-core`
Expected: the four new tests PASS, and all 1004 existing tests still pass. `roundtrip.test.ts` and `docs.test.ts` are the two most likely to notice a new section — if either fails, the failure is real, not incidental.

- [ ] **Step 5: Make the documentation true**

`docs/configuration.md` already shows this block. Reconcile it with what the schema now accepts — in particular add `ingest.loopback_only`, which the document does not mention, and confirm the `baud: auto` note still matches `MAVLINK_BAUDS`.

- [ ] **Step 6: Commit**

```bash
rm -f node_modules
git add packages/yonder-core/src/schema/config.ts packages/yonder-core/src/schema/mavlink.test.ts docs/configuration.md
git commit -s -m "feat(config): the mavlink section, which configuration.md already promised — R-MAV-03, R-MAV-07"
```

---

## Task 4: A telemetry endpoint change is kept, not held

§5 and §7. `R-CFG-12` exemption. **Leaf by leaf, never by subtree** — `reachability.ts` is explicit about why, and the `allow_default` comment in it is the worked example of what a subtree exemption costs.

**Files:**
- Modify: `packages/yonder-core/src/apply/reachability.ts`
- Test: `packages/yonder-core/src/apply/reachability.test.ts`
- Modify: `docs/requirements.md` — `R-CFG-12`'s text

**Interfaces:**
- Consumes: `Config["mavlink"]` from Task 3
- Produces: `affectsReachability` returns `false` for endpoint/tcp/autocast changes and `true` for everything else under `mavlink`

- [ ] **Step 1: Write the failing tests**

Append to `packages/yonder-core/src/apply/reachability.test.ts`:

```ts
describe("mavlink (R-CFG-12, R-MAV-03)", () => {
  const withMav = (mavlink: Config["mavlink"]): Config => ({ ...DEFAULT_CONFIG, mavlink });

  it("adding a ground station is kept, not held", () => {
    const before = withMav(DEFAULT_CONFIG.mavlink);
    const after = withMav({ ...DEFAULT_CONFIG.mavlink, endpoints: [{ name: "gcs0", host: "10.147.20.8", port: 14550 }] });
    expect(affectsReachability(before, after)).toBe(false);
  });

  it("turning the tcp server off, and moving its port, are both kept", () => {
    const before = withMav(DEFAULT_CONFIG.mavlink);
    expect(affectsReachability(before, withMav({ ...DEFAULT_CONFIG.mavlink, tcp_server: { enabled: false, port: 5760 } }))).toBe(false);
    expect(affectsReachability(before, withMav({ ...DEFAULT_CONFIG.mavlink, tcp_server: { enabled: true, port: 5761 } }))).toBe(false);
  });

  it("autocast is kept", () => {
    expect(affectsReachability(withMav(DEFAULT_CONFIG.mavlink), withMav({ ...DEFAULT_CONFIG.mavlink, autocast: false }))).toBe(false);
  });

  // The exemption is earned per leaf. These two are not exempt and must not
  // become so by sitting next to ones that are.
  it("pinning the serial port is still held", () => {
    const after = withMav({ ...DEFAULT_CONFIG.mavlink, serial: { device: "/dev/ttyAMA0", baud: 57600 } });
    expect(affectsReachability(withMav(DEFAULT_CONFIG.mavlink), after)).toBe(true);
  });

  it("opening ingest to the network is still held (R-MAV-07)", () => {
    const after = withMav({ ...DEFAULT_CONFIG.mavlink, ingest: { loopback_only: false } });
    expect(affectsReachability(withMav(DEFAULT_CONFIG.mavlink), after)).toBe(true);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run --root packages/yonder-core src/apply/reachability.test.ts`
Expected: the three "kept" tests FAIL (they return `true`); the two "held" tests already pass, which is the point — they must keep passing after the change.

- [ ] **Step 3: Extend `withoutCosmetics`, naming leaves**

In `packages/yonder-core/src/apply/reachability.ts`, extend the local type and add, after the zerotier block:

```ts
  // A ground-station endpoint touches no interface, no route and no radio, so
  // it cannot take away the path the operator is reaching the device on —
  // which is the only thing the confirmation window exists to protect.
  //
  // The failure this prevents is specific and bad: the window reverts *and
  // reboots*, so an operator adjusting a port mid-flight over a marginal link
  // loses the video, the telemetry and the mesh a minute after touching
  // something that could not have cost them any of it (R-CFG-12, §5).
  //
  // Leaf by leaf, exactly as `remote.zerotier` above and for the same reason.
  // `mavlink.serial` and `mavlink.ingest` are deliberately absent: the first
  // moves which wire the router opens, and the second opens an
  // unauthenticated command path to the vehicle (R-MAV-07). Neither has been
  // shown to be safe to keep, so both stay load-bearing.
  const mavlink = copy.mavlink;
  if (mavlink !== undefined) {
    delete mavlink.endpoints;
    delete mavlink.autocast;
    const tcp = mavlink.tcp_server as Record<string, unknown> | undefined;
    if (tcp !== undefined) {
      delete tcp.enabled;
      delete tcp.port;
    }
  }
```

and widen the cast at the top of the function:

```ts
  const copy = structuredClone(config) as {
    ui: Record<string, unknown>;
    remote?: { zerotier?: Record<string, unknown> };
    mavlink?: Record<string, unknown>;
  };
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --root packages/yonder-core src/apply/reachability.test.ts`
Expected: PASS, all five.

- [ ] **Step 5: Extend `R-CFG-12` in `docs/requirements.md`**

Append to `R-CFG-12`'s requirement text, in the same cell:

> **Each exemption is earned individually and named leaf by leaf.** `ui.theme` earned it by reverting a palette an operator had watched take. `remote.zerotier`'s two fields earned it on a board, where a join added exactly one route and the client refused a controller-pushed route that overlapped the device's own network. `mavlink.endpoints`, `mavlink.autocast` and `mavlink.tcp_server` earn it by construction: none of them touches an interface, a route or a radio, and the window's own remedy — revert *and reboot* — would take the video, the telemetry and the mesh off a flying aircraft in exchange for protecting nothing. `mavlink.serial` and `mavlink.ingest` are deliberately not exempt.

- [ ] **Step 6: Commit**

```bash
rm -f node_modules
git add packages/yonder-core/src/apply/reachability.ts packages/yonder-core/src/apply/reachability.test.ts docs/requirements.md
git commit -s -m "feat(apply): a telemetry endpoint change is kept, not held — R-CFG-12"
```

---

## Task 5: `frame.ts` — heartbeats out of a byte stream

**Files:**
- Create: `packages/yonder-core/src/mav/frame.ts`
- Test: `packages/yonder-core/src/mav/frame.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  ```ts
  export interface Heartbeat {
    system: number; component: number;
    /** MAV_TYPE. 6 is a ground station, not a vehicle. */
    vehicleType: number;
    /** MAV_AUTOPILOT. 3 is ArduPilot, 8 is "invalid" — what a GCS sends. */
    autopilot: number;
    /** True when this came from a vehicle rather than a ground station. */
    fromVehicle: boolean;
  }
  export class HeartbeatScanner {
    /** Feed bytes as they arrive; returns every complete heartbeat found. */
    push(chunk: Uint8Array): Heartbeat[];
    /** Frames that started but failed their checksum, since construction. */
    readonly rejected: number;
  }
  export function describeVehicle(h: Heartbeat): string;
  ```

**This file is deliberately small and must not grow into a MAVLink library.** Which library, which dialect and which version are M5b's decisions (§1). It knows one message.

- [ ] **Step 1: Write the failing test**

```ts
// packages/yonder-core/src/mav/frame.test.ts
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { HeartbeatScanner, describeVehicle } from "./frame.js";

/** Build a MAVLink v2 HEARTBEAT so the test states its own input exactly. */
function heartbeatV2(system: number, vehicleType: number, autopilot: number): Uint8Array {
  const payload = new Uint8Array(9);
  new DataView(payload.buffer).setUint32(0, 0, true); // custom_mode
  payload[4] = vehicleType;
  payload[5] = autopilot;
  payload[6] = 0;  // base_mode
  payload[7] = 4;  // system_status
  payload[8] = 3;  // mavlink_version
  const head = Uint8Array.from([payload.length, 0, 0, 0, system, 1, 0, 0, 0]);
  let crc = 0xffff;
  const acc = (b: number) => {
    let t = (b ^ (crc & 0xff)) & 0xff;
    t = (t ^ (t << 4)) & 0xff;
    crc = ((crc >> 8) ^ (t << 8) ^ (t << 3) ^ (t >> 4)) & 0xffff;
  };
  for (const b of head) acc(b);
  for (const b of payload) acc(b);
  acc(50); // CRC_EXTRA for HEARTBEAT
  return Uint8Array.from([0xfd, ...head, ...payload, crc & 0xff, crc >> 8]);
}

describe("HeartbeatScanner", () => {
  it("finds a heartbeat and reports the vehicle it came from", () => {
    const s = new HeartbeatScanner();
    const [hb] = s.push(heartbeatV2(1, 1, 3)); // fixed wing, ArduPilot
    expect(hb).toMatchObject({ system: 1, vehicleType: 1, autopilot: 3, fromVehicle: true });
    expect(describeVehicle(hb)).toBe("ArduPlane");
  });

  it("tells a ground station's heartbeat from a vehicle's (§6)", () => {
    const s = new HeartbeatScanner();
    const [hb] = s.push(heartbeatV2(255, 6, 8)); // MAV_TYPE_GCS, MAV_AUTOPILOT_INVALID
    expect(hb.fromVehicle).toBe(false);
  });

  // A camera on the same bus heartbeats with a vehicle type that is not GCS.
  // "Not a ground station" would accept it as the aircraft.
  it("does not mistake a camera or a gimbal for a flight controller", () => {
    const s = new HeartbeatScanner();
    const [cam] = s.push(heartbeatV2(1, 30, 8)); // MAV_TYPE_CAMERA, no autopilot
    expect(cam.fromVehicle).toBe(false);
  });

  // A false header's length is a number noise can invent; skipping by it steps
  // over whatever follows.
  it("finds a heartbeat hidden behind a bogus header that claims its length", () => {
    const s = new HeartbeatScanner();
    const bogus = Uint8Array.from([0xfd, 21, 0, 0, 0, 1, 1, 99, 0, 0]);
    const found = s.push(Uint8Array.from([...bogus, ...heartbeatV2(1, 1, 3)]));
    expect(found).toHaveLength(1);
  });

  it("survives being fed one byte at a time", () => {
    const s = new HeartbeatScanner();
    const frame = heartbeatV2(1, 2, 3);
    const found = frame.reduce<number>((n, b) => n + s.push(Uint8Array.of(b)).length, 0);
    expect(found).toBe(1);
  });

  it("counts a frame whose checksum fails and does not emit it", () => {
    const s = new HeartbeatScanner();
    const bad = heartbeatV2(1, 1, 3);
    bad[bad.length - 1] ^= 0xff;
    expect(s.push(bad)).toEqual([]);
    expect(s.rejected).toBe(1);
  });

  it("finds a good frame that follows garbage — this is what a wrong baud looks like", () => {
    const s = new HeartbeatScanner();
    const noise = Uint8Array.from({ length: 64 }, (_, i) => (i * 37) & 0xff);
    const found = s.push(Uint8Array.from([...noise, ...heartbeatV2(1, 1, 3)]));
    expect(found).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run --root packages/yonder-core src/mav/frame.test.ts`
Expected: FAIL — `Cannot find module './frame.js'`.

- [ ] **Step 3: Write it**

```ts
// packages/yonder-core/src/mav/frame.ts
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Enough MAVLink to recognise a heartbeat, and no more (§1).
 *
 * M5a reads nothing but heartbeats, which is a boundary chosen to defer a
 * decision rather than to make one: which library, which dialect, v1 or v2,
 * signed or not. Recognising one message needs none of that. When M5b needs
 * the rest it takes a dependency and this file goes away; growing it into a
 * MAVLink library one message at a time is how that decision gets made by
 * accident.
 */

const V1 = 0xfe;
const V2 = 0xfd;
const HEARTBEAT = 0;
/** The message-definition checksum MAVLink appends before the CRC. */
const HEARTBEAT_CRC_EXTRA = 50;
const MAV_TYPE_GCS = 6;
/** What every component that is not an autopilot puts in the autopilot field. */
const MAV_AUTOPILOT_INVALID = 8;

/** X25 / CRC-16-MCRF4XX, one byte at a time — MAVLink's own accumulator. */
function accumulate(byte: number, crc: number): number {
  let tmp = (byte ^ (crc & 0xff)) & 0xff;
  tmp = (tmp ^ (tmp << 4)) & 0xff;
  return ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xffff;
}

export interface Heartbeat {
  system: number;
  component: number;
  vehicleType: number;
  autopilot: number;
  /**
   * A ground station heartbeats back, which is what makes §6's "someone is
   * listening" a measurement rather than an assumption — and also what would
   * make a naive reader think the aircraft had two autopilots.
   */
  fromVehicle: boolean;
}

const VEHICLES: Record<number, string> = {
  1: "ArduPlane", 2: "ArduCopter", 4: "Helicopter", 6: "Ground station",
  10: "Rover", 11: "Boat", 12: "Submarine", 13: "Hexacopter",
  14: "Octocopter", 15: "Tricopter", 19: "VTOL", 20: "VTOL",
};

export function describeVehicle(h: Heartbeat): string {
  return VEHICLES[h.vehicleType] ?? `Vehicle type ${h.vehicleType}`;
}

export class HeartbeatScanner {
  private buffer = new Uint8Array(0);
  rejected = 0;

  push(chunk: Uint8Array): Heartbeat[] {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;

    const found: Heartbeat[] = [];
    let i = 0;
    while (i < this.buffer.length) {
      const magic = this.buffer[i];
      if (magic !== V1 && magic !== V2) { i += 1; continue; }
      const headerLength = magic === V2 ? 10 : 6;
      if (i + headerLength > this.buffer.length) break;       // need more bytes
      const payloadLength = this.buffer[i + 1];
      const signed = magic === V2 && (this.buffer[i + 2] & 0x01) !== 0;
      const total = headerLength + payloadLength + 2 + (signed ? 13 : 0);
      if (i + total > this.buffer.length) break;

      const messageId = magic === V2
        ? this.buffer[i + 7] | (this.buffer[i + 8] << 8) | (this.buffer[i + 9] << 16)
        : this.buffer[i + 5];

      // A length we have not checksummed is a number a noise byte can invent,
      // and skipping by it steps *over* whatever follows. A bogus header
      // claiming 21 bytes, followed by a real heartbeat, swallows the
      // heartbeat — and during a bounded probe that rejects the right baud.
      //
      // So an unverified frame advances by ONE byte, never by its own claim.
      // Only HEARTBEAT carries a CRC_EXTRA we know, so only HEARTBEAT can be
      // checksummed; everything else is resynced past rather than trusted.
      if (messageId !== HEARTBEAT) { i += 1; continue; }

      let crc = 0xffff;
      for (let k = i + 1; k < i + headerLength + payloadLength; k += 1) crc = accumulate(this.buffer[k], crc);
      crc = accumulate(HEARTBEAT_CRC_EXTRA, crc);

      const sent = this.buffer[i + headerLength + payloadLength] | (this.buffer[i + headerLength + payloadLength + 1] << 8);
      if (crc !== sent) { this.rejected += 1; i += 1; continue; }  // resync from the next byte

      const payload = this.buffer.subarray(i + headerLength, i + headerLength + payloadLength);
      const vehicleType = payload[4] ?? 0;
      const autopilot = payload[5] ?? 0;
      found.push({
        system: this.buffer[i + (magic === V2 ? 5 : 3)],
        component: this.buffer[i + (magic === V2 ? 6 : 4)],
        vehicleType,
        autopilot,
        // "Not a ground station" is not "an autopilot". Cameras, gimbals,
        // ADS-B receivers and the router itself all heartbeat, all with a
        // vehicle type that is not GCS — a Pocket 2 on the same bus would be
        // detected as the aircraft. What marks a *flight controller* is an
        // autopilot field that names one: MAV_AUTOPILOT_INVALID (8) is what
        // every non-autopilot component sends, including a GCS.
        fromVehicle: autopilot !== MAV_AUTOPILOT_INVALID && vehicleType !== MAV_TYPE_GCS,
      });
      i += total;
    }
    this.buffer = this.buffer.subarray(i);
    return found;
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --root packages/yonder-core src/mav/frame.test.ts`
Expected: PASS, all five.

- [ ] **Step 5: Commit**

```bash
rm -f node_modules
git add packages/yonder-core/src/mav/frame.ts packages/yonder-core/src/mav/frame.test.ts
git commit -s -m "feat(mav): enough MAVLink to recognise a heartbeat — R-MAV-10"
```

---

## Task 6: `detect.ts` — the sweep, and its three outcomes

§3 and `R-MAV-13`. **Read Task 1's hardware note before starting**: if it recorded that framing errors are unavailable *and* byte counts are flat at a wrong speed, drop `"noise"` from the union and say so in the requirement.

**Files:**
- Create: `packages/yonder-core/src/mav/detect.ts`
- Test: `packages/yonder-core/src/mav/detect.test.ts`
- Modify: `docs/requirements.md` — add `R-MAV-13`

**Interfaces:**
- Consumes: `HeartbeatScanner`, `describeVehicle` (Task 5); `MAVLINK_BAUDS` (Task 3); `Clock`
- Produces:
  ```ts
  export interface SerialPort { read(ms: number): Promise<{ bytes: Uint8Array; framingErrors: number }>; close(): Promise<void>; }
  export type OpenPort = (device: string, baud: number) => Promise<SerialPort>;
  export type DetectOutcome =
    | { kind: "found"; device: string; baud: number; vehicle: string; system: number }
    | { kind: "silent"; device: string; triedBauds: number[] }
    | { kind: "noise"; device: string; triedBauds: number[]; bytes: number };
  export function detect(opts: { device: string; open: OpenPort; bauds?: readonly number[]; first?: number }): Promise<DetectOutcome>;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/yonder-core/src/mav/detect.test.ts
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { detect, type OpenPort } from "./detect.js";

const heartbeatBytes = /* reuse the builder from frame.test.ts — export it from a shared test helper */ null as never;

/** A port that answers with whatever the table says for the baud it was opened at. */
function portsAnswering(table: Record<number, { bytes: Uint8Array; framingErrors: number }>): { open: OpenPort; opened: number[] } {
  const opened: number[] = [];
  const open: OpenPort = async (_device, baud) => {
    opened.push(baud);
    return {
      read: async () => table[baud] ?? { bytes: new Uint8Array(0), framingErrors: 0 },
      close: async () => {},
    };
  };
  return { open, opened };
}

describe("detect", () => {
  it("finds the autopilot and names the vehicle and speed", async () => {
    const { open } = portsAnswering({ 57600: { bytes: heartbeatBytes(1, 1, 3), framingErrors: 0 } });
    await expect(detect({ device: "/dev/ttyAMA0", open })).resolves.toMatchObject({
      kind: "found", baud: 57600, vehicle: "ArduPlane", system: 1,
    });
  });

  it("stops at the first good frame and never opens the rates behind it", async () => {
    const { open, opened } = portsAnswering({ 115200: { bytes: heartbeatBytes(1, 2, 3), framingErrors: 0 } });
    await detect({ device: "/dev/ttyAMA0", open });
    expect(opened).toEqual([57600, 115200]);
  });

  it("tries a remembered speed first, then the rest in order", async () => {
    const { open, opened } = portsAnswering({});
    await detect({ device: "/dev/ttyAMA0", open, first: 921600 });
    expect(opened).toEqual([921600, 57600, 115200, 230400, 921600]);
  });

  it("reports silence when no bytes arrive anywhere — the wiring case", async () => {
    const { open } = portsAnswering({});
    await expect(detect({ device: "/dev/ttyAMA0", open })).resolves.toMatchObject({
      kind: "silent", triedBauds: [57600, 115200, 230400, 921600],
    });
  });

  it("reports noise when bytes arrive everywhere and nothing ever parses (R-MAV-13)", async () => {
    const junk = { bytes: Uint8Array.from({ length: 200 }, (_, i) => (i * 37) & 0xff), framingErrors: 40 };
    const { open } = portsAnswering({ 57600: junk, 115200: junk, 230400: junk, 921600: junk });
    // The byte count is whatever the deadline read, which depends on the slice
    // size — so assert the *kind* and that something arrived, never a total the
    // fake would have to be counted by hand to predict.
    const outcome = await detect({ device: "/dev/ttyAMA0", open, clock: fakeClock() });
    expect(outcome.kind).toBe("noise");
    expect((outcome as { bytes: number }).bytes).toBeGreaterThan(0);
  });

  // A byte the UART could not frame never reaches the reader, so a port that
  // delivers nothing but counts framing errors is not silent — and calling it
  // silent sends an operator to check a wire that is connected.
  it("calls framing errors with no delivered bytes noise, not silence", async () => {
    const errs = { bytes: new Uint8Array(0), framingErrors: 120 };
    const { open } = portsAnswering({ 57600: errs, 115200: errs, 230400: errs, 921600: errs });
    await expect(detect({ device: "/dev/ttyAMA0", open, clock: fakeClock() }))
      .resolves.toMatchObject({ kind: "noise" });
  });

  it("ignores a ground station's heartbeat when looking for an autopilot", async () => {
    const { open } = portsAnswering({ 57600: { bytes: heartbeatBytes(255, 6, 8), framingErrors: 0 } });
    await expect(detect({ device: "/dev/ttyAMA0", open, clock: fakeClock() }))
      .resolves.toMatchObject({ kind: "noise" });
  });

  // The right rate leads with attitude and status far more often than with a
  // heartbeat. A rule that gave up after two unproductive reads abandoned it.
  it("keeps reading a rate that is producing valid non-heartbeat traffic", async () => {
    const sysStatus = validSysStatusBytes();
    let call = 0;
    const open: OpenPort = async () => ({
      read: async () => (call++ < 4
        ? { bytes: sysStatus, framingErrors: 0 }
        : { bytes: heartbeatBytes(1, 1, 3), framingErrors: 0 }),
      close: async () => {},
    });
    await expect(detect({ device: "/dev/ttyAMA0", open, clock: fakeClock() }))
      .resolves.toMatchObject({ kind: "found", baud: 57600 });
  });
});
```

**Before writing the implementation:** extract `heartbeatV2` from `frame.test.ts` into
`packages/yonder-core/src/mav/testing.ts` (exported, `SPDX` header, not shipped in
`index.ts`) and import it in both test files, replacing the `null as never` placeholder
above. Add `validSysStatusBytes()` beside it — a well-formed v2 frame with message id 1 and
a correct CRC, which the scanner must skip without treating as noise — and `fakeClock()`,
which is the one in `link.test.ts` below. **No test in this file may use the wall clock**;
`detect` takes an injected `Clock` for exactly that reason.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run --root packages/yonder-core src/mav/detect.test.ts`
Expected: FAIL — `Cannot find module './detect.js'`.

- [ ] **Step 3: Write it**

```ts
// packages/yonder-core/src/mav/detect.ts
// SPDX-License-Identifier: GPL-3.0-or-later
import { systemClock, type Clock } from "../apply/types.js";
import { MAVLINK_BAUDS } from "../schema/config.js";
import { HeartbeatScanner, describeVehicle } from "./frame.js";

/**
 * The sweep is the only mechanism (§3). A UART has to be told a speed before
 * it can turn a wire into bytes, so there is nothing to sense. Everything
 * worth doing is around it:
 *
 *   - **Leave a wrong speed as soon as it proves wrong.** At a wrong rate
 *     bytes still arrive, and bytes that never parse are proof of a mismatch
 *     in a few hundred milliseconds. The full wait is owed only to a rate at
 *     which nothing at all arrives.
 *   - **Stop on the first good frame.** A checksum that passes is certainty.
 *   - **Say which kind of nothing it was** (R-MAV-13), which is the part an
 *     operator with a wire in the wrong hole actually needs.
 */

/**
 * Each rate gets at least one heartbeat interval before it is given up on.
 *
 * HEARTBEAT is 1 Hz, so a shorter window can miss the right rate entirely —
 * and at the right rate an autopilot sends far more than heartbeats, so
 * "bytes arrived and none of them was a heartbeat" is the ordinary state of
 * affairs for the first second, not evidence of anything.
 */
const RATE_DEADLINE_MS = 1_300;
/**
 * A rate at which nothing whatever has arrived is abandoned early: silence is
 * the one signal that does not need a heartbeat interval to interpret.
 */
const SILENT_GIVE_UP_MS = 400;
/** Each read returns what is available; it does not block for its window. */
const READ_SLICE_MS = 100;

export interface SerialPort {
  read(ms: number): Promise<{ bytes: Uint8Array; framingErrors: number }>;
  close(): Promise<void>;
}

export type OpenPort = (device: string, baud: number) => Promise<SerialPort>;

export type DetectOutcome =
  | { kind: "found"; device: string; baud: number; vehicle: string; system: number }
  | { kind: "silent"; device: string; triedBauds: number[] }
  | { kind: "noise"; device: string; triedBauds: number[]; bytes: number };

export async function detect(opts: {
  device: string;
  open: OpenPort;
  bauds?: readonly number[];
  /** A remembered speed, tried before the sweep. Not removed from the sweep:
      if it fails it is retried in its turn, which costs one read and keeps the
      "tried these four" message true. */
  first?: number;
  /** Injected, so no test waits on the wall clock. */
  clock?: Clock;
}): Promise<DetectOutcome> {
  const sweep = opts.bauds ?? MAVLINK_BAUDS;
  const order = opts.first === undefined ? [...sweep] : [opts.first, ...sweep];
  const clock = opts.clock ?? systemClock;
  const tried: number[] = [];
  let bytesSeen = 0;
  let errorsSeen = 0;

  for (const baud of order) {
    if (!tried.includes(baud)) tried.push(baud);
    const port = await opts.open(opts.device, baud);
    const started = clock.now();
    try {
      const scanner = new HeartbeatScanner();
      let bytesHere = 0;
      let errorsHere = 0;

      // A deadline on the clock, not a count of reads. An earlier version gave
      // up after the second read that produced no heartbeat, which abandons
      // the *correct* rate whenever telemetry happens to lead with attitude or
      // status messages — which it usually does.
      while (clock.now() - started < RATE_DEADLINE_MS) {
        const chunk = await port.read(READ_SLICE_MS);
        bytesHere += chunk.bytes.length;
        errorsHere += chunk.framingErrors;
        const vehicle = scanner.push(chunk.bytes).find((h) => h.fromVehicle);
        if (vehicle !== undefined) {
          return { kind: "found", device: opts.device, baud, vehicle: describeVehicle(vehicle), system: vehicle.system };
        }
        // Silence is the one signal that can be read early.
        if (bytesHere === 0 && errorsHere === 0 && clock.now() - started >= SILENT_GIVE_UP_MS) break;
      }
      bytesSeen += bytesHere;
      errorsSeen += errorsHere;
    } finally {
      await port.close();
    }
  }

  // Framing errors count as arrival even when the driver delivered no bytes:
  // a byte the UART could not frame is still something reaching the pin, and
  // reporting that as silence would send an operator to check a wire that is
  // connected.
  return bytesSeen === 0 && errorsSeen === 0
    ? { kind: "silent", device: opts.device, triedBauds: [...MAVLINK_BAUDS] }
    : { kind: "noise", device: opts.device, triedBauds: [...MAVLINK_BAUDS], bytes: bytesSeen };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --root packages/yonder-core src/mav/detect.test.ts`
Expected: PASS, all six.

- [ ] **Step 5: Add `R-MAV-13` to `docs/requirements.md`**

Insert after `R-MAV-12`, in the R-MAV table, with priority `1` — the text is in §7 of the spec, copied verbatim. **If Task 1 found that neither framing errors nor byte counts distinguish a wrong speed from silence**, amend the requirement's first sentence to say two outcomes rather than three, and record why in the same cell.

- [ ] **Step 6: Commit**

```bash
rm -f node_modules
git add packages/yonder-core/src/mav/detect.ts packages/yonder-core/src/mav/detect.test.ts packages/yonder-core/src/mav/testing.ts packages/yonder-core/src/mav/frame.test.ts docs/requirements.md
git commit -s -m "feat(mav): find the autopilot, and say which kind of nothing it was — R-MAV-01, R-MAV-13"
```

---

## Task 7: `hint.ts` — remembered, never configured

§3. `R-CAM-06` was withdrawn for writing a probed result into configuration; the same reasoning applies to a serial port, so the answer lives in `/var/lib/yonder`, not `config.yaml`.

**Files:**
- Create: `packages/yonder-core/src/mav/hint.ts`
- Test: `packages/yonder-core/src/mav/hint.test.ts`

**Interfaces:**
- Consumes: `DetectOutcome` (Task 6)
- Produces:
  ```ts
  export interface LinkHint { device: string; baud: number }
  export function readHint(path: string): LinkHint | undefined;
  export function writeHint(path: string, hint: LinkHint): void;
  export function forgetHint(path: string): void;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/yonder-core/src/mav/hint.test.ts
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { forgetHint, readHint, writeHint } from "./hint.js";

const scratch = () => join(mkdtempSync(join(tmpdir(), "yonder-hint-")), "link.json");

describe("the remembered port and speed", () => {
  it("round-trips", () => {
    const p = scratch();
    writeHint(p, { device: "/dev/ttyAMA0", baud: 57600 });
    expect(readHint(p)).toEqual({ device: "/dev/ttyAMA0", baud: 57600 });
  });

  it("is undefined when it has never been written", () => {
    expect(readHint(scratch())).toBeUndefined();
  });

  // A hint is an optimisation. Anything wrong with it must degrade to the
  // full sweep, never to a failed boot — this file is on the path to
  // telemetry starting at all (R-MAV-08).
  it("is undefined rather than an exception when the file is corrupt", () => {
    const p = scratch();
    writeFileSync(p, "{ this is not json");
    expect(readHint(p)).toBeUndefined();
  });

  it("is undefined when the file is valid json of the wrong shape", () => {
    const p = scratch();
    writeFileSync(p, JSON.stringify({ device: "/dev/ttyAMA0", baud: "fast" }));
    expect(readHint(p)).toBeUndefined();
  });

  it("refuses a baud that is not one we sweep", () => {
    const p = scratch();
    writeFileSync(p, JSON.stringify({ device: "/dev/ttyAMA0", baud: 9600 }));
    expect(readHint(p)).toBeUndefined();
  });

  it("can be forgotten, and forgetting one that is not there is not an error", () => {
    const p = scratch();
    writeHint(p, { device: "/dev/ttyAMA0", baud: 57600 });
    forgetHint(p);
    expect(readHint(p)).toBeUndefined();
    expect(() => forgetHint(p)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run --root packages/yonder-core src/mav/hint.test.ts`
Expected: FAIL — `Cannot find module './hint.js'`.

- [ ] **Step 3: Write it**

```ts
// packages/yonder-core/src/mav/hint.ts
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { MAVLINK_BAUDS } from "../schema/config.js";

/**
 * The port and speed that worked last time — state, never configuration (§3).
 *
 * R-CAM-06 was withdrawn for the encoder version of this idea, and the
 * reasoning transfers without a change: the installer seeds `config.yaml`
 * only when it is absent, so a probed value written there goes stale on
 * upgrade; and an image built in a chroot on a build host would bake the
 * build machine's answer into every board. So this is a cache under
 * /var/lib/yonder that an operator never edits and nothing reads as truth.
 *
 * Every failure here returns `undefined` rather than throwing. A hint is an
 * optimisation on the path to telemetry starting at all (R-MAV-08): the worst
 * a bad one may cost is one wasted read before the ordinary sweep.
 */

export interface LinkHint {
  device: string;
  baud: number;
}

export function readHint(path: string): LinkHint | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { device, baud } = parsed as Record<string, unknown>;
  if (typeof device !== "string" || device.length === 0) return undefined;
  if (typeof baud !== "number" || !(MAVLINK_BAUDS as readonly number[]).includes(baud)) return undefined;
  return { device, baud };
}

export function writeHint(path: string, hint: LinkHint): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(hint)}\n`, { mode: 0o644 });
}

export function forgetHint(path: string): void {
  rmSync(path, { force: true });
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --root packages/yonder-core src/mav/hint.test.ts`
Expected: PASS, all six.

- [ ] **Step 5: Commit**

```bash
rm -f node_modules
git add packages/yonder-core/src/mav/hint.ts packages/yonder-core/src/mav/hint.test.ts
git commit -s -m "feat(mav): remember the port and speed as a hint, never as configuration — R-MAV-01"
```

---

## Task 8: `router/config.ts` — `mavlink-router`'s configuration, generated

§4. One writer: this text is regenerated from `config.yaml` on every apply.

**Files:**
- Create: `packages/yonder-core/src/mav/router/config.ts`
- Test: `packages/yonder-core/src/mav/router/config.test.ts`

**Interfaces:**
- Consumes: `Config["mavlink"]` (Task 3); `{ device, baud }` from `DetectOutcome` (Task 6)
- Produces: `export function routerConfig(mavlink: Config["mavlink"], link: { device: string; baud: number }): string;`

- [ ] **Step 1: Write the failing test**

```ts
// packages/yonder-core/src/mav/router/config.test.ts
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../schema/config.js";
import { routerConfig } from "./config.js";

const link = { device: "/dev/ttyAMA0", baud: 57600 };
const base = DEFAULT_CONFIG.mavlink;

describe("routerConfig", () => {
  it("names the serial device and the speed detection settled on", () => {
    const out = routerConfig(base, link);
    expect(out).toContain("[UartEndpoint autopilot]");
    expect(out).toContain("Device = /dev/ttyAMA0");
    expect(out).toContain("Baud = 57600");
  });

  it("always emits the control plane's loopback copy, even with no ground station (R-MAV-05)", () => {
    const out = routerConfig({ ...base, endpoints: [] }, link);
    expect(out).toContain("[UdpEndpoint yonder]");
    expect(out).toContain("Address = 127.0.0.1");
    expect(out).toContain("Port = 14559");
  });

  it("emits one block per ground station, named for it (R-MAV-03)", () => {
    const out = routerConfig({ ...base, endpoints: [
      { name: "gcs0", host: "192.168.2.10", port: 14550 },
      { name: "gcs1", host: "10.147.20.8", port: 14551 },
    ] }, link);
    expect(out).toContain("[UdpEndpoint gcs0]");
    expect(out).toContain("Address = 192.168.2.10");
    expect(out).toContain("[UdpEndpoint gcs1]");
    expect(out).toContain("Port = 14551");
  });

  // R-CFG-13, added with M3: what is generated matches the configuration
  // *including what it no longer says*. An operator who clears gcs1 must find
  // that block gone, not standing at its old address still receiving.
  it("drops an endpoint the configuration no longer names (R-CFG-13)", () => {
    const both = routerConfig({ ...base, endpoints: [
      { name: "gcs0", host: "192.168.2.10", port: 14550 },
      { name: "gcs1", host: "10.147.20.8", port: 14551 },
    ] }, link);
    expect(both).toContain("[UdpEndpoint gcs1]");
    const cleared = routerConfig({ ...base, endpoints: [{ name: "gcs0", host: "192.168.2.10", port: 14550 }] }, link);
    expect(cleared).not.toContain("gcs1");
    expect(cleared).not.toContain("10.147.20.8");
  });

  // Omitting the key does not disable the server — the router falls back to
  // its own default port and listens anyway. "Off" has to be said out loud.
  it("says port 0 rather than omitting the key, because omission ships a listener (R-MAV-04)", () => {
    const off = routerConfig({ ...base, tcp_server: { enabled: false, port: 5760 } }, link);
    expect(off).toContain("TcpServerPort = 0");
    expect(off).not.toContain("TcpServerPort = 5760");
  });

  // R-MAV-07. The TCP server accepts *commands*, so leaving it up while ingest
  // is closed would be an unauthenticated command path the console reports as
  // "Loopback only". Asserted rather than reviewed.
  it("keeps the tcp server down while ingest is loopback-only, however it is configured", () => {
    const closed = routerConfig({ ...base, tcp_server: { enabled: true, port: 5760 } }, link);
    expect(closed).toContain("TcpServerPort = 0");
  });

  it("raises it only when ingest has been deliberately opened", () => {
    const open = routerConfig(
      { ...base, ingest: { loopback_only: false }, tcp_server: { enabled: true, port: 5760 } }, link);
    expect(open).toContain("TcpServerPort = 5760");
    expect(open).toContain("Mode = Server");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run --root packages/yonder-core src/mav/router/config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write it**

```ts
// packages/yonder-core/src/mav/router/config.ts
// SPDX-License-Identifier: GPL-3.0-or-later
import type { Config } from "../../schema/config.js";

/**
 * `mavlink-router`'s configuration, generated from `config.yaml` and rewritten
 * from scratch on every apply (§4). Editing the file on the device survives
 * until the next apply and then disappears; that single-writer rule is what
 * makes rollback possible and it is not relaxed for this service.
 *
 * The loopback endpoint is not optional and is not configurable. It is how the
 * control plane sees traffic at all (R-MAV-05), and it is deliberately a
 * *copy*: raw MAVLink reaches a ground station without passing through
 * Node-RED, so a console restart is invisible to Mission Planner (R-MAV-06).
 */

/** Where the control plane listens. Not a setting: R-MAV-05 and R-MAV-06. */
export const LOOPBACK_PORT = 14559;

export function routerConfig(mavlink: Config["mavlink"], link: { device: string; baud: number }): string {
  const parts: string[] = [];

  // The TCP server is a *listening* socket, not a fourth destination: MAVLink
  // is bidirectional, so anything that connects to it can command the vehicle.
  // It is therefore governed by R-MAV-07 exactly as UDP ingest is.
  //
  // And "off" is written, never omitted. mavlink-router starts its TCP server
  // on its own default when the configuration is silent, so leaving the key
  // out ships the very listener an operator turned off. Port 0 disables it.
  const tcpWanted = mavlink.tcp_server.enabled && !mavlink.ingest.loopback_only;
  const general = ["[General]"];
  general.push(`TcpServerPort = ${tcpWanted ? mavlink.tcp_server.port : 0}`);
  general.push("ReportStats = true");
  parts.push(`${general.join("\n")}\n`);

  parts.push(
    `[UartEndpoint autopilot]\nDevice = ${link.device}\nBaud = ${link.baud}\n`,
  );

  parts.push(
    `[UdpEndpoint yonder]\nMode = Normal\nAddress = 127.0.0.1\nPort = ${LOOPBACK_PORT}\n`,
  );

  for (const endpoint of mavlink.endpoints) {
    parts.push(
      `[UdpEndpoint ${endpoint.name}]\nMode = Normal\nAddress = ${endpoint.host}\nPort = ${endpoint.port}\n`,
    );
  }

  // R-MAV-07. `Server` mode binds a listening socket that accepts MAVLink from
  // anywhere it is reachable, which on this device includes the mobile network
  // and the mesh — an unauthenticated way to command the aircraft. Off unless
  // configured, and the renderer logs the moment it goes on.
  if (!mavlink.ingest.loopback_only) {
    parts.push(`[UdpEndpoint inbound]\nMode = Server\nAddress = 0.0.0.0\nPort = 14540\n`);
  }

  return `${parts.join("\n")}`;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --root packages/yonder-core src/mav/router/config.test.ts`
Expected: PASS. If the `[General]` assertion fails on exact whitespace, fix the *test* to match the generator's real output rather than loosening the generator — the ingest assertion is the one that matters and it must stay exact.

- [ ] **Step 5: Commit**

```bash
rm -f node_modules
git add packages/yonder-core/src/mav/router/
git commit -s -m "feat(mav): generate mavlink-router's configuration from config.yaml — R-MAV-03, R-MAV-05, R-MAV-07"
```

---

## Task 9: `link.ts` — one link state

§6. **Check Task 2's finding first**: if the router attributes traffic per endpoint, `groundStations` becomes an array with a state per entry.

**Files:**
- Create: `packages/yonder-core/src/mav/link.ts`
- Test: `packages/yonder-core/src/mav/link.test.ts`

**Interfaces:**
- Consumes: `Heartbeat` (Task 5), `DetectOutcome` (Task 6), `Clock`
- Produces:
  ```ts
  export interface LinkState {
    phase: "searching" | "silent" | "noise" | "linked" | "stopped";
    device: string | null; baud: number | null;
    vehicle: string | null; system: number | null;
    heartbeatHz: number | null; lastHeardMs: number | null;
    groundStationAnswering: boolean; groundStationLastHeardMs: number | null;
    triedBauds: number[];
    /**
     * The sparkline's two series and the TCP client count, which the page
     * needs and heartbeats cannot supply.
     *
     * An earlier draft defined this state from heartbeats alone and left Task
     * 12 to produce RX/TX history and a client count out of them, which no
     * thin adapter could — every heartbeat stream looks the same. The numbers
     * come from `mavlink-router`'s own statistics (`ReportStats = true`,
     * §10.3), sampled on the injected `Clock` the way `TrafficSampler` already
     * samples `/sys/class/net`, and `null` until that source answers rather
     * than zero, which would draw a flat line nobody measured.
     */
    traffic: { rx: number[]; tx: number[]; peak: number | null; windowMs: number } | null;
    tcpClients: number | null;
  }
  export class LinkTracker {
    constructor(opts?: { clock?: Clock; windowMs?: number });
    observed(outcome: DetectOutcome): void;
    heard(heartbeat: Heartbeat): void;
    stopped(): void;
    state(): LinkState;
  }
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/yonder-core/src/mav/link.test.ts
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { Clock } from "../apply/types.js";
import { LinkTracker } from "./link.js";

function fakeClock(): Clock & { advance(ms: number): void } {
  let now = 1_000_000;
  return {
    now: () => now,
    setTimer: () => 0,
    clearTimer: () => {},
    advance(ms) { now += ms; },
  };
}

const vehicle = { system: 1, component: 1, vehicleType: 1, autopilot: 3, fromVehicle: true };
const gcs = { system: 255, component: 190, vehicleType: 6, autopilot: 8, fromVehicle: false };

describe("LinkTracker", () => {
  it("starts out searching, with nothing to report", () => {
    expect(new LinkTracker().state()).toMatchObject({ phase: "searching", device: null, vehicle: null });
  });

  it("carries silence through as the wiring case, with the rates tried", () => {
    const t = new LinkTracker();
    t.observed({ kind: "silent", device: "/dev/ttyAMA0", triedBauds: [57600, 115200, 230400, 921600] });
    expect(t.state()).toMatchObject({ phase: "silent", device: "/dev/ttyAMA0", triedBauds: [57600, 115200, 230400, 921600] });
  });

  it("carries noise through as its own phase (R-MAV-13)", () => {
    const t = new LinkTracker();
    t.observed({ kind: "noise", device: "/dev/ttyAMA0", triedBauds: [57600], bytes: 800 });
    expect(t.state().phase).toBe("noise");
  });

  it("reports the vehicle and speed once a link is found", () => {
    const t = new LinkTracker();
    t.observed({ kind: "found", device: "/dev/ttyAMA0", baud: 57600, vehicle: "ArduPlane", system: 1 });
    expect(t.state()).toMatchObject({ phase: "linked", baud: 57600, vehicle: "ArduPlane", system: 1 });
  });

  it("computes a heartbeat rate from arrivals, not from a configured number", () => {
    const clock = fakeClock();
    const t = new LinkTracker({ clock });
    t.observed({ kind: "found", device: "/dev/ttyAMA0", baud: 57600, vehicle: "ArduPlane", system: 1 });
    for (let i = 0; i < 5; i += 1) { t.heard(vehicle); clock.advance(1_000); }
    expect(t.state().heartbeatHz).toBeCloseTo(1, 1);
  });

  // §6: this is the whole point — "configured" is not "connected".
  it("only calls a ground station answering when one has actually answered", () => {
    const clock = fakeClock();
    const t = new LinkTracker({ clock });
    t.observed({ kind: "found", device: "/dev/ttyAMA0", baud: 57600, vehicle: "ArduPlane", system: 1 });
    t.heard(vehicle);
    expect(t.state().groundStationAnswering).toBe(false);
    t.heard(gcs);
    expect(t.state()).toMatchObject({ groundStationAnswering: true, groundStationLastHeardMs: 0 });
  });

  it("stops calling a ground station answering once it has gone quiet", () => {
    const clock = fakeClock();
    const t = new LinkTracker({ clock, windowMs: 5_000 });
    t.heard(gcs);
    clock.advance(6_000);
    expect(t.state().groundStationAnswering).toBe(false);
  });

  it("keeps the autopilot half alive when the operator stops telemetry (R-MAV-09)", () => {
    const t = new LinkTracker();
    t.observed({ kind: "found", device: "/dev/ttyAMA0", baud: 57600, vehicle: "ArduPlane", system: 1 });
    t.stopped();
    expect(t.state()).toMatchObject({ phase: "stopped", vehicle: "ArduPlane", baud: 57600 });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run --root packages/yonder-core src/mav/link.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write it**

Implement `LinkTracker` to satisfy exactly those tests: keep the last `DetectOutcome`, a ring of vehicle-heartbeat timestamps for the rate (`heartbeatHz = (n - 1) / (last - first)` in seconds, `null` below two samples — a rate from one arrival is a claim no measurement supports), and the timestamp of the last heartbeat with `fromVehicle === false` for the ground-station half. `windowMs` defaults to `5_000`. `stopped()` sets the phase and leaves every autopilot-side field untouched.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --root packages/yonder-core src/mav/link.test.ts`
Expected: PASS, all eight.

- [ ] **Step 5: Commit**

```bash
rm -f node_modules
git add packages/yonder-core/src/mav/link.ts packages/yonder-core/src/mav/link.test.ts
git commit -s -m "feat(mav): one link state, measured rather than configured — R-MAV-10"
```

---

## Task 10: `MavlinkRenderer` — the only part that shells out

§4. Boot order, the contended port, and the service.

**Files:**
- Create: `packages/yonder-core/src/mav/renderer.ts`
- Test: `packages/yonder-core/src/mav/renderer.test.ts`
- Modify: `packages/yonder-core/src/daemon/server.ts` — build and register it
- Modify: `packages/yonder-core/src/index.ts` — export it

**Interfaces:**
- Consumes: everything from Tasks 5–9; `CommandRunner`, `Clock`, `Renderer`
- Produces: `export class MavlinkRenderer implements Renderer { readonly name = "mavlink"; render(config: Config): Promise<void>; state(): LinkState; detectNow(): Promise<DetectOutcome>; }`

- [ ] **Step 1: Write the failing test**

Follow `packages/yonder-core/src/remote/renderer.test.ts` for the fake-`CommandRunner` shape. Assert, at minimum:

```ts
// The lifecycle assertions. These are the ones that stop a routine apply
// taking telemetry off a flying aircraft.
it("adopts a running router whose configuration already matches, and probes nothing", async () => { /* assert open() never called, no systemctl */ });
it("does not restart the service when an unrelated setting changed", async () => { /* assert no systemctl restart */ });
it("restarts only when the rendered configuration actually differs", async () => { /* assert exactly one restart */ });
it("re-probes on an explicit request even though a router is running", async () => { /* assert stop, open(), restart */ });

it("detects before it starts the router, because they contend for the port", async () => { /* assert order: open() calls precede the systemctl start */ });
it("writes the router's configuration with the speed detection settled on", async () => { /* assert the file content */ });
it("does not start the router when nothing was found, so retrying stays free (§3)", async () => { /* assert no systemctl start */ });
it("remembers a found port and speed, and forgets one that stopped answering", async () => { /* assert hint file */ });
it("skips detection entirely when the operator pinned a device and baud", async () => { /* assert open() never called */ });
it("logs the moment ingest is opened to the network (R-MAV-07)", async () => { /* assert the log line names it */ });
it("does not start the router at all when autocast is off (R-MAV-08, R-MAV-09)", async () => { /* assert no start */ });
```

- [ ] **Step 2: Run and watch fail** — `npx vitest run --root packages/yonder-core src/mav/renderer.test.ts`

- [ ] **Step 3: Write the renderer, and make it adopt rather than restart**

**This is the step to get right.** The apply engine calls *every* renderer on *every* apply,
and again when the daemon starts — so a `render()` that detects and restarts unconditionally
would seize the serial port from a router that is already using it (with `serial: auto`), or
bounce a healthy telemetry link every time an unrelated setting changed (with it pinned).
Either one drops the ground station mid-flight for a change that had nothing to do with it.

So `render(config)` is written as **adopt, then act only on difference**:

1. **Resolve the link without touching the port if possible.** Pinned `device`/`baud` win
   outright. Otherwise, if the service is active *and* the configuration it is running under
   matches what `routerConfig` would now produce, there is nothing to do — return. **A running
   router is evidence of a working link and is never re-probed to confirm it.**
2. Only when there is no running router, or its rendered configuration differs, resolve the
   link — hint first, then the sweep — and write the new file.
3. Restart the service **only if the file changed**, and log that it is about to, because
   restarting interrupts every ground station already receiving.
4. On `silent` or `noise`: forget the hint, do **not** start the service, and schedule the
   next attempt 30 s out on the injected `Clock`.

**Re-detection is an explicit operator action, never a side effect of an apply.** It arrives
on its own route (`POST /mav/detect`, Task 11), stops the router, probes, and restarts —
with the interruption stated on the page first.

- [ ] **Step 3a: Let the daemon write the router's configuration**

`systemd/yonder-core.service` sets `ProtectSystem=strict` with
`ReadWritePaths=/etc/yonder /var/lib/yonder`, so the first real render would fail with a
read-only filesystem and no other clue. Add `/etc/mavlink-router` to that list, in the same
commit as the renderer that needs it, and assert it the way the unit's other accounts are
asserted. **A renderer whose write is denied by the sandbox is a failure that only appears on
a board**, which is precisely the class of defect this milestone keeps finding late.

- [ ] **Step 4: Run the tests, then the whole suite**

Run: `npx vitest run --root packages/yonder-core`
Expected: everything green. `K-19` matters here — a renderer that throws stops the ones behind it, so a failed sweep must **not** throw.

- [ ] **Step 5: Register and export it**

In `daemon/server.ts`, build it alongside `RemoteRenderer` and add it to the renderer list. In `index.ts`, export `MavlinkRenderer`, `type LinkState`, `type DetectOutcome`.

- [ ] **Step 6: Commit**

```bash
rm -f node_modules
git add packages/yonder-core/src/mav/renderer.ts packages/yonder-core/src/mav/renderer.test.ts packages/yonder-core/src/daemon/server.ts packages/yonder-core/src/index.ts
git commit -s -m "feat(mav): the renderer — detect, then render, then start — R-MAV-01, R-MAV-06, R-MAV-08"
```

---

## Task 11: The loopback listener and the `/mav/*` routes

**Files:**
- Create: `packages/yonder-core/src/mav/listener.ts`, `listener.test.ts`
- Modify: `packages/yonder-core/src/daemon/routes.ts`, `routes.test.ts`

**Interfaces:**
- Consumes: `HeartbeatScanner`, `LinkTracker`, `LOOPBACK_PORT`
- Produces: routes `GET /mav/state` → `LinkState`; `POST /mav/detect`; `POST /mav/start`; `POST /mav/stop`; `GET /mav/check` → `{ autopilot, outbound, inbound }`, each `{ ok: boolean | null; detail: string }` — `null` meaning not attempted, which is what draws the dash rather than the cross (§8)

- [ ] **Step 1: Write the failing tests** — a UDP socket on an ephemeral port fed a crafted heartbeat, asserting `LinkTracker` saw it; and route tests following the existing `/remote/state` cases in `routes.test.ts`.
- [ ] **Step 2: Run and watch fail.**
- [ ] **Step 3: Implement** the `dgram` listener bound to `127.0.0.1` only, and the five routes.
- [ ] **Step 4: Run** `npx vitest run --root packages/yonder-core` — expected green, including the existing 69 route tests.
- [ ] **Step 5: Commit** — `feat(mav): the loopback feed and the console's routes — R-MAV-05, R-MAV-10, R-DIA-04`

---

## Task 12: `node-red-contrib-yonder-mavlink`

**Files:**
- Create: the package, following `packages/node-red-contrib-yonder-remote/` exactly — `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/red.ts`, and one node per route with its `.html`
- Nodes: `yonder-mav-state`, `yonder-mav-endpoints`, `yonder-mav-run`, `yonder-mav-check`

**Interfaces:**
- Consumes: `LinkState`, `DaemonClient`, `clientFor`, `fetched`, `readFailure` from `yonder-core`
- Produces: message payloads shaped for the widgets — every string already in words, so no widget learns a vocabulary (the rule `messageFor` in the remote package follows)

**The contract is already on the page.** Each node must emit exactly what the `mock-*` node
it replaces emits today, so the page does not move when the fake is deleted:

| Widget | Payload shape, from the built page |
|---|---|
| `tel-ann-link`, `tel-ann-recv`, `tel-ann-state`, `stat-ann-feed` | `{ state, message }` — a `CommandStatus`. `state` picks the tone, `message` is the caption |
| `tel-port`, `tel-speed`, `tel-vehicle`, `tel-hb`, `tel-heard`, `tel-answered`, `tel-atboot`, `tel-ingest`, `tel-tcp` | a plain string, already in words: `"/dev/ttyAMA0"`, `"57 600 baud"`, `"ArduPlane · system 1"`, `"1.0 Hz"`, `"0.4 s ago"` |
| `tel-chain-1..3` | a plain string: `"OK · 1.0 Hz"`. A link nobody attempted reads `"— not checked"`, never a cross |
| `tel-host-0..2`, `tel-port-0..2` | the configured value, so the field opens showing its setting (`R-UI-17`); an unset host is `""` |
| `tel-spark` | `{ series: { rx: number[], tx: number[] }, peak, span, known }` |
| `stat-flow` | `{ from, through, to, legs }` — each place `{ label, detail, absent }`, each leg `{ rate, caption, absent }` |
| `stat-tel-bar` | `{ atboot, ingest, heard, vehicle }` |

**Every string arrives already in words.** No widget learns a vocabulary, which is the rule
`messageFor` in the remote package already follows — the page must not know what `57600`
means or what a `DetectOutcome` is.

- [ ] **Step 1: Write the failing test** for `messageFor(state: LinkState, now?: number)`, covering all five phases and asserting the operator-facing sentences — including that the silent case names **pin 8, pin 10 and pin 6**, and the noise case names `SERIALn_PROTOCOL` and `SERIALn_BAUD`.
- [ ] **Step 2: Run and watch fail.**
- [ ] **Step 3: Implement** the nodes as thin adapters. No decision lives here. **`R-UI-17`: the endpoint node emits each field's configured value**, so the three host/port pairs open showing what the device is actually set to — an empty box on a configured device is a page giving two answers to one question.
- [ ] **Step 4: Run** `npx vitest run --root packages/node-red-contrib-yonder-mavlink`.
- [ ] **Step 5: Commit** — `feat(mavlink-nodes): thin adapters over the daemon socket — R-MAV-10`

---

## Task 13: The flow strip — **landed, nothing to do**

Built while the blueprint was, and on the page now. Left here rather than deleted so the
numbering matches the commits, and because its two decisions are ones a reviewer should be
able to find: **an absent leg is dashed and grey, never red** — nothing has failed when
telemetry is stopped on purpose — and **all three places are always drawn**, because a strip
that collapsed to whatever is working would answer "where is my telemetry going" with silence
in exactly the case an operator is asking. The `caution` soft-key tone landed with it.

*The original task text follows, for the record.*

**Files:**
- Create: `packages/node-red-dashboard-2-yonder/src/flow.ts`, `flow.html`, `src/ui/YonderFlow.vue`
- Modify: `src/red.ts`, `package.json`, `scripts/build-widgets.mjs` if it enumerates widgets
- Test: `src/nodes.test.ts` — extend

**Interfaces:**
- Consumes: `{ from, through, to }`, each `{ label, detail, absent }`, plus `legs: { rate, caption, absent }[]`
- Produces: the `yonder-flow` widget

- [ ] **Step 1: Extend `nodes.test.ts`** to assert the new node registers and its defaults, as the existing widgets are asserted.
- [ ] **Step 2: Run and watch fail.**
- [ ] **Step 3: Write the component**, reading `--yonder-*` with night fallbacks like every other widget (`R-UI-13`). Three cells and two legs; a leg with `absent` draws a dashed grey arrow. Below 1024px the grid becomes one column and the arrows point down. The blueprint is the `Status page — Telemetry` table in [the design README](../../console/design/telemetry/README.md), and the rendered target is `status-telemetry-flowing.html` and `status-telemetry-no-autopilot.html` beside it.
- [ ] **Step 4: Add the soft-key `caution` tone.** `YonderSoftKeys` has `act` and `warn`; neither means *deliberately on and hazardous*, which is what the ingest key is. Amber, matching the warning band. This is a gap in an existing component, not a new component — and the reasoning for choosing amber over red or magenta is in §8 of the spec.
- [ ] **Step 5: Run** `npx vitest run --root packages/node-red-dashboard-2-yonder`, **and the contrast gate** — `R-UI-16` measures every control's text against what is actually behind it, in both palettes, in a real browser. A new instrument that has never been measured is exactly what that requirement was added for.
- [ ] **Step 6: Commit** — `feat(instruments): the telemetry flow strip, and a caution key — R-UI-13, R-UI-16`

---

## Task 14: Cut the page over from the mockup to the daemon

**The page exists.** This task deletes the scaffolding under it. Nothing here is a design
decision: the arrangement, the widgets and the payload shapes were all settled by building
it, and this is the mechanical half.

**Files:**
- Modify: `flows/flows.json` — rewire, and delete `mock-telemetry-once` and all 32 `mock-*` nodes
- Modify: `packages/yonder-core/src/flows.test.ts`
- Modify: `docs/console/shape/` — recapture

**Interfaces:**
- Consumes: the four `yonder-mav-*` nodes from Task 12
- Produces: a page whose every value came from the device

- [ ] **Step 1: Assert the scaffolding is gone before removing it**

```ts
it("carries no mockup scaffolding — every value on the Telemetry page came from the device", () => {
  const mocks = flows.filter((n) => String(n.id).startsWith("mock-"));
  expect(mocks.map((n) => n.id)).toEqual([]);
});
```

Run it and watch it fail with all thirty-two named. That list is the task's own checklist.

- [ ] **Step 2: Rewire one group at a time, deleting each fake as its real source lands**

Wire `yonder-mav-state` to the widgets in the table in Task 12, and delete the `mock-*` node
that fed each. **After every group, stand the console up and look at it** — the page should
not move. A widget that goes blank is a payload shape that does not match what the mockup
proved, and the mockup is the specification.

- [ ] **Step 3: Wire the three actions**

`tel-send` to `yonder-mav-endpoints`, `tel-runstop` to `yonder-mav-run`, `tel-check` to
`yonder-mav-check`, and `tel-keys-ingest` through a `switch` on the key's action. **No
`function` node** — `flows.test.ts` asserts it against the artefact.

- [ ] **Step 4: Recapture all six states**

`R-UI-12`, and the machinery M3 built: drive each state through the daemon's fake and capture
it under its own name, as `status-without-modem` already is. The six are enumerated in
[the design README](../../console/design/telemetry/README.md). Inspect every PNG by eye.

- [ ] **Step 5: Commit**

```bash
npm test
git add flows/flows.json docs/console/ packages/yonder-core/src/flows.test.ts
git commit -s -m "feat(console): the Telemetry page reads the device — R-MAV-10, R-DIA-04"
```

*The original task text follows, for the record.*

**Files:**
- Modify: `flows/flows.json` — wiring only
- Modify: `packages/yonder-core/src/flows.test.ts` — it already asserts no `function` node exists; extend it for the new page
- Modify: `scripts/verify-pages.sh`, `docs/console/capture/`, `docs/console/shape/`

- [ ] **Step 1: Extend `flows.test.ts`** — assert the Telemetry page exists, that its groups are the four in §8, and that the artefact still contains no `function` node.
- [ ] **Step 2: Run and watch fail.**
- [ ] **Step 3: Build the page from the blueprint**, node type by node type. The table is *Every control is an instrument, and here is the list* in [`docs/console/design/telemetry/README.md`](../../console/design/telemetry/README.md); the rendered target is the ten HTML files beside it. **Do not substitute a stock Dashboard widget for a named instrument.** Where the table says `ui-text` with a `className`, that is the deliberate choice and the class is how the theme reaches it — the same way `yonder-qualifier` and `yonder-fixed` are applied on the pages that already ship.
- [ ] **Step 4: Carry `yonder-pending` (`R-UI-15`).** `mavlink.serial` and `mavlink.ingest` are *not* exempt from the confirmation window, so changing either pends — and the requirement is that a pending change shows on every surface, not only where it was made. The Status page's existing `yonder-pending` wiring is the pattern.
- [ ] **Step 5: Run** `HOLD=1 PORT=18900 ./scripts/verify-pages.sh` and **look at the page** in a browser in both palettes before believing it.
- [ ] **Step 6: Capture all six states.** `R-UI-12` requires a surface that hides part of itself to be captured in each part, and M3 built the machinery: `verify-pages.sh` drives real states through the daemon and captures each under its own name, as `status-without-modem` and `status-pending` already are. The six are enumerated in the design README. Then `node scripts/capture-pages.mjs --accept` and **inspect every PNG by eye before committing it**.
- [ ] **Step 7: Commit** — `feat(console): the Telemetry page — R-MAV-10, R-DIA-04, R-UI-12, R-UI-15, R-UI-17`

**Note for the reviewer:** `R-UI-12`'s *text* still speaks only of tabs, while the practice M3 established already covers states. That gap belongs to whoever next edits `R-UI-12`, not to this milestone — but this page must be captured in all six states regardless, because the machinery exists and the requirement's intent is plain.

---

## Task 15: The installer — the UART role

§2. **Do not merge this without Task 1's hardware note**, which is the only evidence these overlay lines do what they claim.

**Files:**
- Create: `installer/roles/uart.sh` (follow the naming of the roles already there)
- Modify: `installer/install.sh` — register the role
- Modify: `docs/hardware/an-autopilot-on-the-uart.md` — the wiring table as the operator-facing record

- [ ] **Step 1: Write the role**, owning one marked stanza and never touching the rest, exactly as `scripts/pocket2/enable-gadget-mode.sh` does: `enable_uart=1` and `dtoverlay=disable-bt` appended under a `# yonder-uart` marker; `console=serial0,115200` removed from `cmdline.txt`; `serial-getty@ttyAMA0` and `hciuart` disabled. Idempotent — running it twice changes nothing.
- [ ] **Step 2: Add a post-condition the image build can also satisfy**

The role runner supports one, and the obvious assertion — `/dev/ttyAMA0` exists — **fails
every image build**, because the same installer runs in a chroot on a build host where the
board's UART does not exist and an overlay has not been applied for want of a reboot.

So the post-condition asserts **what the role wrote**, not what the kernel has yet done with
it: the marked stanza is present in `config.txt`, `console=serial0` is absent from
`cmdline.txt`, and the getty is disabled. Physical availability is checked *after* a reboot,
by the daemon at start-up, and reported on the page as part of `R-MAV-13`'s silent case
rather than as an install failure.

**M2a's lesson still applies** — `deb-systemd-helper` refuses to run outside `dpkg`, and only
a post-condition caught it — but the lesson is that the post-condition must test the thing the
role is responsible for, which is the configuration, not the hardware.
- [ ] **Step 3: Run the installer on the board**, reboot, and confirm the wiring still carries MAVLink.
- [ ] **Step 4: Commit** — `feat(installer): give the autopilot the UART — R-MAV-02, R-HW-04`

---

## Task 16: The installer — `mavlink-router` in the offline payload

§10.2. Task 2 measured the cost; this pays it.

**Files:**
- Create: `installer/roles/mavlink-router.sh`, `systemd/mavlink-router.service`
- Modify: the CI workflow that builds the offline payload

- [ ] **Step 1: Build it in CI** for arm64, pinned to the version Task 2 recorded, with the fingerprint committed — the shape `R-VPN-08` defines and M2a proved.
- [ ] **Step 2: Write the role** to install from the payload with no network, and leave the unit **stopped and disabled**: `yonder-core` starts it, and only once a link has been found (§4, and the `R-VPN-08` precedent that installing a thing must not start it).

- [ ] **Step 2a: Create `/etc/mavlink-router` with an owner that can write it**

The daemon renders `main.conf` there under `ProtectSystem=strict`, so the directory has to
exist and be listed in `ReadWritePaths` (Task 10, Step 3a). Create it in this role rather than
leaving the renderer to `mkdir` into a read-only filesystem.
- [ ] **Step 3: Prove `R-CFG-07`** the way M2a did — run the role with `apt` pointed at a dead proxy and confirm `Need to get 0 B`.
- [ ] **Step 4: Commit** — `feat(installer): carry mavlink-router in the offline payload — R-CFG-07, R-MAV-06`

---

## Self-Review

**Spec coverage.** §1 → Task 3 and the slice this whole plan implements. §2 → Task 15. §3 → Tasks 1, 6, 7. §4 → Tasks 8, 10, 16. §5 → Task 4. §6 → Tasks 2, 9. §7 → Tasks 4 and 6 (each requirement lands in the commit that implements it, per rule 3). §8 → Tasks 12, 13, 14. §9 → the file structure above. §10 → Tasks 1 and 2, deliberately first.

**Two gaps I found and am recording rather than hiding:**

1. **The interruption warning still has no screen.** §5 says the console warns that applying
   an endpoint change briefly interrupts the ground stations already receiving. The built page
   does not show it — the row beside **Send telemetry here** says only whether a change is
   unsent. It belongs there, as a `ui-text` with `className: "yonder-qualifier"`, and Task 14's
   rewiring step is where it lands. **This is the one thing on the page that was designed and
   never drawn.**
2. **`R-MAV-09`'s start/stop is asserted in Task 10 and routed in Task 11, but no task makes the *service* survive a `yonder-core` restart** — that is `R-MAV-06`'s whole point and it follows from `mavlink-router` being its own systemd unit, so it is a property of Task 16's unit file rather than of any code. Task 16 must include a test that restarting `yonder-core` leaves the router running.

**Type consistency.** `DetectOutcome`, `LinkState`, `LinkHint`, `Heartbeat`, `SerialPort`, `OpenPort` and `routerConfig` are each defined once, in the task that creates them, and referenced by exactly those names afterwards. `LOOPBACK_PORT` is exported from `router/config.ts` and consumed in Task 11 rather than repeated as `14559`.

**What building the page closed, and what it opened.** Tasks 13 and 14 were written as
"design and build"; the blueprint is now built, so 13 is done and 14 is a cutover with a
thirty-two-item checklist the flows themselves produce. Four defects surfaced that no drawing
would have — they are listed under *What already exists* because the next page will hit them
too. And `R-UI-15` turned out to apply to this page after all, which the spec had reasoned to
but no screen had shown: `mavlink.serial` and `mavlink.ingest` are not exempt, so the page
pends, and `flows.test.ts` failed until it carried the banner.

**One correction the plan makes to the spec.** §5 and §7 say `mavlink` is exempted from the confirmation window "by name". `reachability.ts` names **leaves**, never subtrees, and its own comment explains that a subtree exemption silently enfranchises every field added under it later. Task 4 therefore exempts `mavlink.endpoints`, `mavlink.autocast`, `mavlink.tcp_server.enabled` and `mavlink.tcp_server.port` individually, and deliberately leaves `mavlink.serial` and `mavlink.ingest` load-bearing. **The spec has been tightened to match** in the same change as this plan: §5 and §7 now name the four exempt leaves and name `mavlink.serial` and `mavlink.ingest` as deliberately not exempt, so a later reader knows they were considered rather than missed.
