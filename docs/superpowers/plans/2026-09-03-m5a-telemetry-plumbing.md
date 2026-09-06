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
| `packages/yonder-core/src/mav/router/stats.ts` | Pure. The router's own per-endpoint counters, out of the text it prints |
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

## Task 1: Bench — does the kernel report framing errors on this port? — **DONE, 2026-09-05**

**Answered yes**, and it changed two things. The counter discriminates hard — 1071 and 2482
framing errors at wrong rates against zero at the right one — so `R-MAV-13`'s three outcomes
stand and §10.1's fallback is not needed. But **one wrong rate produced no framing errors
either**, so errors are sufficient evidence of a mismatch and not necessary, and the sweep
leaves early on errors while waiting out the deadline on their absence. The 1300 ms deadline
is now measured: six runs answered in 739–874 ms.

It also found the trap that `SerialPort.settleAndFlush()` exists for. Full transcript:
[`hardware/an-autopilot-on-the-uart.md`](../../hardware/an-autopilot-on-the-uart.md).

*The original task follows, for the record.*

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

## Task 2: Bench — build `mavlink-router` for arm64, and what it says about its endpoints — **DONE, 2026-09-05**

**§10.2:** builds on the board, but only just — `meson`, `ninja-build`, `libsystemd-dev` and
`systemd-dev` are all missing from a stock image (the build wants the `systemd` pkg-config
module, not `libsystemd`), and a default parallel build **runs a 1 GB Pi 4 out of memory**.
`-j1` completes. The stripped binary is **325 KB**, which makes the offline payload cheap and
the on-device build the wrong idea — Task 16 stands, for stronger reasons than `R-CFG-07`.

**§10.3: it does attribute traffic per endpoint, by name.** So §6's limitation is lifted and
`LinkState.groundStations` is per-endpoint (Task 9). The first measurement said otherwise and
was wrong — the fake ground station replied to itself rather than to the router's source port,
so nothing reached the router at all.

*The original task follows, for the record.*

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
Expected: the six new tests PASS, and the whole suite stays green. `roundtrip.test.ts` and `docs.test.ts` are the two most likely to notice a new section — if either fails, the failure is real, not incidental.

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
- Produces: `affectsReachability` returns `false` for `mavlink.endpoints`, `mavlink.autocast` and `mavlink.tcp_server.enabled` changes, and `true` for everything else under `mavlink` — `mavlink.tcp_server.port` included, which stays held

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

  it("turning the tcp server off is kept", () => {
    const before = withMav(DEFAULT_CONFIG.mavlink);
    const after = withMav({ ...DEFAULT_CONFIG.mavlink, tcp_server: { enabled: false, port: 5760 } });
    expect(affectsReachability(before, after)).toBe(false);
  });

  it("autocast is kept", () => {
    expect(affectsReachability(withMav(DEFAULT_CONFIG.mavlink), withMav({ ...DEFAULT_CONFIG.mavlink, autocast: false }))).toBe(false);
  });

  // The port is not like `enabled`: the schema accepts any value in range, and
  // a value the schema accepts can still be a port some other service on the
  // device already holds. R-MAV-14 only refuses the one collision it can see
  // - with `ui.port`, the console's own - so a bind failure against sshd,
  // mediamtx or the mesh client is invisible to the schema and would
  // otherwise ship kept. Still held, on purpose.
  it("moving the tcp server's port is still held", () => {
    const before = withMav(DEFAULT_CONFIG.mavlink);
    const after = withMav({ ...DEFAULT_CONFIG.mavlink, tcp_server: { enabled: true, port: 5761 } });
    expect(affectsReachability(before, after)).toBe(true);
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

  // The exemption is three named leaves, not the subtree they sit in - the
  // same regression `remote.zerotier` guards against above. A field added
  // directly under `mavlink`, or under `mavlink.tcp_server` specifically,
  // must not inherit a kept-not-held apply from its neighbours with nobody
  // deciding it should.
  it("holds a field added directly under mavlink that nobody has measured", () => {
    const before = withMav(DEFAULT_CONFIG.mavlink);
    const after = structuredClone(before) as Config & { mavlink: Record<string, unknown> };
    after.mavlink.somethingNew = { invented: "later" };
    expect(affectsReachability(before, after)).toBe(true);
  });

  it("holds a field added under mavlink.tcp_server that nobody has measured", () => {
    const before = withMav(DEFAULT_CONFIG.mavlink);
    const after = structuredClone(before) as Config & {
      mavlink: { tcp_server: Record<string, unknown> };
    };
    after.mavlink.tcp_server.somethingNew = true;
    expect(affectsReachability(before, after)).toBe(true);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run --root packages/yonder-core src/apply/reachability.test.ts`
Expected: the three "kept" tests FAIL (they return `true`); the five "still held" tests already pass, which is the point — they must keep passing after the change.

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
  // `mavlink.serial`, `mavlink.ingest` and `mavlink.tcp_server.port` are
  // deliberately absent, and each earns its absence on its own. The first
  // moves which wire the router opens, and the second opens an
  // unauthenticated command path to the vehicle (R-MAV-07); neither has been
  // shown to be safe to keep. The port is not like those two, and not like its
  // own sibling `tcp_server.enabled` either: it is a number the schema would
  // otherwise accept in full, and a value the schema accepts can still be a
  // port some other service on the device already holds. R-MAV-14 refuses
  // exactly one such collision — with `ui.port`, the console's own — which
  // leaves every other one for the window to catch, not the schema. A
  // validator is a narrower promise than a rollback.
  const mavlink = copy.mavlink;
  if (mavlink !== undefined) {
    delete mavlink.endpoints;
    delete mavlink.autocast;
    const tcp = mavlink.tcp_server as Record<string, unknown> | undefined;
    if (tcp !== undefined) {
      delete tcp.enabled;
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
Expected: PASS, all eight.

- [ ] **Step 5: Extend `R-CFG-12` in `docs/requirements.md`**

Append to `R-CFG-12`'s requirement text, in the same cell:

> **Each exemption is earned individually and named leaf by leaf.** `ui.theme` earned it by reverting a palette an operator had watched take. `remote.zerotier`'s two fields earned it on a board, where a join added exactly one route and the client refused a controller-pushed route that overlapped the device's own network. `mavlink.endpoints`, `mavlink.autocast` and `mavlink.tcp_server.enabled` earn it by construction: none of them touches an interface, a route or a radio, and the window's own remedy — revert *and reboot* — would take the video, the telemetry and the mesh off a flying aircraft in exchange for protecting nothing. `mavlink.serial`, `mavlink.ingest` and `mavlink.tcp_server.port` are deliberately not exempt — the port because a value the schema accepts in full can still be one another service on the device already holds, and R-MAV-14 checks that collision against only `ui.port`.

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

A candidate's message ID lives inside the fixed-size header, so it is read — and checked against `HEARTBEAT` — before the payload length that same header claims is ever trusted for anything. An unverified length is a number a noise byte can invent: treating it as authoritative before confirming this is even a HEARTBEAT candidate would let a bogus header's claimed length swallow whatever real frame follows it, rather than the frame being resynced past one byte at a time. Only a candidate that has already passed as `HEARTBEAT` by message ID ever waits on its length; everything else resyncs immediately, regardless of what length it claims.

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
      if (i + headerLength > this.buffer.length) break;       // need more bytes to even read the header

      // msgid lives inside the fixed-size header, so it is readable as soon
      // as the header itself is — *before* the payload length claimed by
      // that same header has been trusted for anything. Only HEARTBEAT
      // carries a CRC_EXTRA we know, so only HEARTBEAT can be checksummed;
      // everything else is resynced past one byte at a time, regardless of
      // what length it claims.
      const messageId = magic === V2
        ? this.buffer[i + 7] | (this.buffer[i + 8] << 8) | (this.buffer[i + 9] << 16)
        : this.buffer[i + 5];
      if (messageId !== HEARTBEAT) { i += 1; continue; }

      const payloadLength = this.buffer[i + 1];
      const signed = magic === V2 && (this.buffer[i + 2] & 0x01) !== 0;
      const total = headerLength + payloadLength + 2 + (signed ? 13 : 0);

      // A length we have not checksummed is a number a noise byte can invent,
      // and skipping by it steps *over* whatever follows. A bogus header
      // claiming to be a 21-byte HEARTBEAT, followed by a real one, must not
      // swallow the real frame — but that trap is already closed above: a
      // bogus header only reaches here at all once its msgid has passed as
      // HEARTBEAT, which noise does not do on purpose. What is left to
      // handle here is the ordinary streaming case, so an unverified-but-
      // plausible frame short of bytes so far is waited for, never skipped
      // past by its own claim.
      if (i + total > this.buffer.length) break;

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

§3 and `R-MAV-13`. **Task 1 settled the conditional this task used to carry:** the kernel does report framing errors per port — 1071 and 2482 in four seconds at the wrong rates against zero at the right one — so all three outcomes stand and `"noise"` stays in the union.

What Task 1 also found, and what this task must honour: **921600 produced no framing errors and no frames either.** Reading a 115200 signal at eight times its rate samples each bit eight times, and the long uniform runs frame cleanly as bytes. So errors are *sufficient* evidence of a mismatch and never *necessary* — the sweep leaves early on errors and waits out the deadline on their absence, which is why `RATE_DEADLINE_MS` is a clock and not a read count.

**Files:**
- Create: `packages/yonder-core/src/mav/detect.ts`
- Test: `packages/yonder-core/src/mav/detect.test.ts`
- Modify: `docs/requirements.md` — add `R-MAV-13`

**Interfaces:**
- Consumes: `HeartbeatScanner`, `describeVehicle` (Task 5); `MAVLINK_BAUDS` (Task 3); `Clock`
- Produces:
  ```ts
  export interface SerialPort { settleAndFlush(): Promise<void>; read(ms: number): Promise<{ bytes: Uint8Array; framingErrors: number }>; close(): Promise<void>; }
  export type OpenPort = (device: string, baud: number) => Promise<SerialPort>;
  export type DetectOutcome =
    | { kind: "found"; device: string; baud: number; vehicle: string; system: number }
    | { kind: "silent"; device: string; triedBauds: number[] }
    | { kind: "noise"; device: string; triedBauds: number[]; bytes: number };
  export function detect(opts: { device: string; open: OpenPort; bauds?: readonly number[]; first?: number; clock?: Clock }): Promise<DetectOutcome>;
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
      settleAndFlush: async () => {},
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
  // silent sends an operator to check a wire that is connected. Measured on a
  // board: the wrong rates threw 1071 and 2482 framing errors in four seconds.
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
      settleAndFlush: async () => {},
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
  /**
   * Settle, then discard anything buffered from the previous rate.
   *
   * On a board, an ascending sweep reported two checksum-valid heartbeats at a
   * rate that cannot produce them: bytes buffered at the old rate survived the
   * change and were attributed to the new one. That is the worst failure
   * available here — detection confidently naming the wrong baud, having
   * genuinely seen a valid frame — and 50 ms of settling is the whole fix.
   */
  settleAndFlush(): Promise<void>;
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
    await port.settleAndFlush();
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
        // Two signals can be read before the deadline. Silence is one.
        //
        // Framing errors are the other, and they are *sufficient* evidence of a
        // mismatch without being necessary: on a board, 57600 and 230400 threw
        // a thousand and two and a half thousand of them against zero at the
        // rate that worked — but 921600 threw none and carried no frames
        // either, because reading a 115200 signal at eight times its rate
        // samples each bit eight times and the runs frame cleanly as bytes. So
        // errors mean leave now; their absence means wait for the deadline.
        if (errorsHere > 0) break;
        if (bytesHere === 0 && clock.now() - started >= SILENT_GIVE_UP_MS) break;
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
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
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

  // The other half of "valid json of the wrong shape": a device field of the
  // right *type* but a value nothing should ever open. Deleting just the
  // length check (keeping the type check) lets this through as a real hint —
  // verified in task-7-report.md's review-round-2 section by actually
  // deleting it and watching this test fail.
  it("refuses an empty-string device", () => {
    const p = scratch();
    writeFileSync(p, JSON.stringify({ device: "", baud: 57600 }));
    expect(readHint(p)).toBeUndefined();
  });

  it("can be forgotten, and forgetting one that is not there is not an error", () => {
    const p = scratch();
    writeHint(p, { device: "/dev/ttyAMA0", baud: 57600 });
    forgetHint(p);
    expect(readHint(p)).toBeUndefined();
    expect(() => forgetHint(p)).not.toThrow();
  });

  // --- Beyond the brief: gaps in the failure modes above --------------------

  // JSON.parse happily returns a non-object top-level value — a bare literal
  // is exactly what a naive "clear the hint" writer might produce instead of
  // deleting the file. This exercises the `parsed === null` guard, which
  // "wrong shape" above never reaches because that test keeps an object at
  // the top level and only breaks a field inside it.
  it("is undefined when the file holds valid json that is not an object", () => {
    const p = scratch();
    writeFileSync(p, "null");
    expect(readHint(p)).toBeUndefined();
  });

  // A bare non-null primitive at the top level (as opposed to null, above).
  // Kept as a characterization test of the whole read path rather than of one
  // guard clause — see task-7-report.md's review-round-2 section for why:
  // destructuring a primitive box-converts it and yields undefined fields
  // rather than throwing, so `typeof device !== "string"` catches this on its
  // own even without a top-level `typeof parsed !== "object"` check. Both
  // guard shapes were tried against this exact case; only the one that
  // survives is in hint.ts now.
  it("is undefined when the file holds a bare top-level primitive", () => {
    const p = scratch();
    writeFileSync(p, "42");
    expect(readHint(p)).toBeUndefined();
  });

  // An array is also `typeof … === "object"` and not null, so it passes the
  // top-level guard and has to be caught by the per-field checks instead —
  // a distinct branch from both the null case above and the wrong-field-type
  // case the brief covers.
  it("is undefined when the json is an array rather than a record", () => {
    const p = scratch();
    writeFileSync(p, JSON.stringify(["/dev/ttyAMA0", 57600]));
    expect(readHint(p)).toBeUndefined();
  });

  // Distinct from "corrupt" above: a write torn off by a power cut or a full
  // disk leaves a *prefix* of valid-looking JSON, not scrambled bytes. Still
  // caught by the same JSON.parse/catch, but worth pinning by name since it
  // is the failure mode this file's atomic write exists to make rare, not
  // the one it makes impossible — the hint could still predate this code, or
  // be dropped there by something other than writeHint.
  it("is undefined when the file was truncated mid-write", () => {
    const p = scratch();
    const full = JSON.stringify({ device: "/dev/ttyAMA0", baud: 57600 });
    writeFileSync(p, full.slice(0, full.length - 5));
    expect(readHint(p)).toBeUndefined();
  });

  // The brief's scratch() always hands writeHint a path whose parent
  // (the mkdtemp directory itself) already exists, so it never exercises
  // directory creation. A real board's first boot writes this file before
  // anything else has necessarily created its parent, so this has to work.
  it("creates the hint's directory when it does not exist yet", () => {
    const base = mkdtempSync(join(tmpdir(), "yonder-hint-"));
    const nested = join(base, "state", "mav", "link.json");
    writeHint(nested, { device: "/dev/ttyAMA0", baud: 115200 });
    expect(readHint(nested)).toEqual({ device: "/dev/ttyAMA0", baud: 115200 });
  });

  // The other half of the same gap: forgetting a hint that was never written
  // under a directory that was never created either — still not an error.
  it("forgetting a hint under a directory that was never created is not an error", () => {
    const base = mkdtempSync(join(tmpdir(), "yonder-hint-"));
    const nested = join(base, "never", "created", "link.json");
    expect(() => forgetHint(nested)).not.toThrow();
    expect(readHint(nested)).toBeUndefined();
  });

  // Pins the file-mode choice: a port and a baud rate are not a secret (they
  // are already visible in an unauthenticated /status reply), unlike
  // secrets.yaml's 0600, so this should read 0644 the way the ZeroTier
  // membership record and config.yaml itself do.
  it("writes the hint at mode 0644", () => {
    const p = scratch();
    writeHint(p, { device: "/dev/ttyAMA0", baud: 57600 });
    expect(statSync(p).mode & 0o777).toBe(0o644);
  });

  it("leaves no temporary file behind after writing", () => {
    const p = scratch();
    writeHint(p, { device: "/dev/ttyAMA0", baud: 57600 });
    expect(existsSync(`${p}.tmp`)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run --root packages/yonder-core src/mav/hint.test.ts`
Expected: FAIL — `Cannot find module './hint.js'`.

- [ ] **Step 3: Write it**

`writeHint` and `forgetHint` go through `writeFileDurable`/`unlinkDurable` (`fs/durable.ts`) rather than a plain `writeFileSync`/`rmSync` — the same primitives every other state writer in this package uses (`config/save.ts`, `secrets/store.ts`, `apply/journal.ts`, `remote/renderer.ts`'s own membership record). The reason is `forgetHint`, not `writeHint`: a discarded hint must not be resurrected by a crash immediately afterward, and an `unlinkSync` sitting only in the page cache when power is cut would do exactly that; the directory fsync inside `unlinkDurable` is what rules it out.

```ts
// packages/yonder-core/src/mav/hint.ts
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { unlinkDurable, writeFileDurable } from "../fs/durable.js";
import { MAVLINK_BAUDS } from "../schema/config.js";

/**
 * The port and speed that worked last time — state, never configuration (§3).
 *
 * R-MAV-13: a probe's answer is remembered as a hint that is tried first and
 * discarded when it fails, so replacing a flight controller heals on the next
 * boot rather than needing a file edited. That is the reasoning R-CAM-06 was
 * withdrawn for, applied to a serial port: writing a probed value into
 * config.yaml fails twice over, because the installer seeds config.yaml only
 * when it is absent (so the value goes stale on upgrade) and an image built
 * in a chroot on a build host would bake that build machine's answer into
 * every board flashed from it. So this is a cache under /var/lib/yonder that
 * an operator never edits and nothing reads as truth.
 *
 * Every read failure here returns `undefined` rather than throwing. A hint is
 * an optimisation on the path to telemetry starting at all (R-MAV-08): the
 * worst a bad one may cost is one wasted read before the ordinary sweep, so a
 * corrupt file, a truncated one, a wrong shape, or a baud nothing sweeps for
 * must all degrade the same way — never to a failed boot. A hint naming a
 * device that no longer exists degrades the same way too, but not by any
 * check in this file: this module only ever touches the state file, never the
 * serial device itself ("this file does filesystem I/O only"), so a vanished
 * port is invisible here and is instead just an ordinary failure the next
 * detect() attempt reports.
 *
 * Written and removed the way every other state file in this package is —
 * through writeFileDurable/unlinkDurable (fs/durable.ts): a fresh temp file,
 * fsync, atomic rename, fsync the directory, so a power cut leaves either the
 * whole old hint or the whole new one, never a torn file that readHint would
 * then have to treat as corrupt anyway. remote/renderer.ts's own record of
 * which mesh network it joined is the closest sibling to this file — an
 * unauthoritative fact about the world, cached under /var/lib/yonder in
 * exactly this style — and this matches that rather than the apply journal's
 * heavier, logging discard: nothing here is safety-critical enough to warrant
 * a warning, and nothing depends on a bad file being actively removed rather
 * than merely ignored, because the next successful probe overwrites it.
 */

export interface LinkHint {
  device: string;
  baud: number;
}

/**
 * 0750, matching the installer's mode for /var/lib/yonder itself
 * (installer/roles/10-base.sh: `ensure_dir /var/lib/yonder 0750`). This is
 * only ever reached when the hint's directory does not already exist; the
 * ordinary case is that the installer created it at install time and this
 * mkdir is a no-op.
 */
const HINT_DIR_MODE = 0o750;

export function readHint(path: string): LinkHint | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  // Only null needs catching explicitly. Every other non-object JSON value —
  // a bare string, number or boolean — survives destructuring (JS boxes a
  // primitive rather than throwing) and comes out as `device: undefined`,
  // which the type check below already rejects; null is the one primitive
  // that destructuring throws on, and the one for which `typeof x` lies
  // ("object"). A `typeof parsed !== "object"` clause here once stood beside
  // this line and was deleted: every JSON value it caught, the checks below
  // already caught the same way, so no test could tell the two versions
  // apart (see hint.test.ts's "bare top-level primitive" case).
  if (parsed === null) return undefined;
  const { device, baud } = parsed as Record<string, unknown>;
  if (typeof device !== "string" || device.length === 0) return undefined;
  if (typeof baud !== "number" || !(MAVLINK_BAUDS as readonly number[]).includes(baud)) return undefined;
  return { device, baud };
}

export function writeHint(path: string, hint: LinkHint): void {
  // writeFileDurable fsyncs the containing directory, so it has to exist
  // first — config/defaults.ts's seedConfigIfAbsent creates /etc/yonder for
  // the same reason before it writes config.yaml into a fresh one.
  mkdirSync(dirname(path), { recursive: true, mode: HINT_DIR_MODE });
  // 0644: a port and a baud rate are not a secret.
  writeFileDurable(path, `${JSON.stringify(hint)}\n`, 0o644);
}

export function forgetHint(path: string): void {
  unlinkDurable(path);
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --root packages/yonder-core src/mav/hint.test.ts`
Expected: PASS, all fifteen.

- [ ] **Step 5: Commit**

```bash
rm -f node_modules
git add packages/yonder-core/src/mav/hint.ts packages/yonder-core/src/mav/hint.test.ts
git commit -s -m "feat(mav): remember the port and speed as a hint, never as configuration — R-MAV-13"
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

## Task 8b: `router/stats.ts` — what the router already knows

§6 and §10.3. **Task 2 established this task's reason to exist.** Three `LinkState` fields —
`groundStations`, `traffic` and `tcpClients` — are all measurements only `mavlink-router`
holds, and no other task reads them. This is the parser; Task 9 folds its output into state
and Task 10 fetches the text.

**Files:**
- Create: `packages/yonder-core/src/mav/router/stats.ts`
- Test: `packages/yonder-core/src/mav/router/stats.test.ts`

**Interfaces:**
- Consumes: nothing. Pure text in, numbers out.
- Produces:
  ```ts
  export interface EndpointStats {
    /** The endpoint's configured name, as it appears in the block header. */
    name: string;
    kind: "uart" | "udp" | "tcp";
    /** Cumulative since the router started. `Handled`, not `Total`. */
    received: number;
    transmitted: number;
    crcErrors: number;
    sequenceLost: number;
  }
  export function parseStats(text: string): EndpointStats[];
  ```

**Why a parser and not a protocol.** The statistics are text on stdout and nothing upstream
promises the format is stable — the spec records that coupling deliberately, as the better
trade than reporting less than the router knows. Keeping the parse in one pure function with
the real output as its fixture means a format change is one failing test naming one file,
rather than a page that quietly goes blank.

- [ ] **Step 1: Write the failing test**

The fixture is verbatim from the board, 2026-09-05 — not invented, and not reformatted.

```ts
// packages/yonder-core/src/mav/router/stats.test.ts
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { parseStats } from "./stats.js";

/** Verbatim from mavlink-router 2362c62 on a Pi 4, ReportStats = true. */
const REAL = `UDP Endpoint [7]gcs0 {
	Received messages {
		CRC error: 0 0% 0KB
		Sequence lost: 0 0%
		Handled: 21 1KB
		Total: 21
	}
	Transmitted messages {
		Total: 954 34KB
	}
}
UDP Endpoint [8]gcs1 {
	Received messages {
		CRC error: 0 0% 0KB
		Sequence lost: 0 0%
		Handled: 0 0KB
		Total: 0
	}
	Transmitted messages {
		Total: 954 34KB
	}
}
UART Endpoint [6]autopilot {
	Received messages {
		CRC error: 0 0% 0KB
		Sequence lost: 0 0%
		Handled: 955 34KB
		Total: 955
	}
	Transmitted messages {
		Total: 0 0KB
	}
}
`;

describe("parseStats", () => {
  // The measurement §6 was reversed by: the answering endpoint's count tracks
  // its replies exactly, and the silent one stays at zero.
  it("attributes received messages to the endpoint that received them", () => {
    expect(parseStats(REAL)).toEqual([
      { name: "gcs0", kind: "udp", received: 21, transmitted: 954, crcErrors: 0, sequenceLost: 0 },
      { name: "gcs1", kind: "udp", received: 0, transmitted: 954, crcErrors: 0, sequenceLost: 0 },
      { name: "autopilot", kind: "uart", received: 955, transmitted: 0, crcErrors: 0, sequenceLost: 0 },
    ]);
  });

  // `Handled` is the count that moved when a ground station answered. `Total`
  // includes messages the router saw and dropped, so a busy endpoint that
  // routes nothing back would read as answering.
  it("reads Handled, not Total", () => {
    const text = REAL.replace("\t\tHandled: 21 1KB\n\t\tTotal: 21", "\t\tHandled: 3 1KB\n\t\tTotal: 99");
    expect(parseStats(text)[0].received).toBe(3);
  });

  it("returns nothing rather than throwing on output that is not statistics", () => {
    expect(parseStats("")).toEqual([]);
    expect(parseStats("mavlink-router version 2362c62\nOpened UART\n")).toEqual([]);
  });

  // The journal interleaves. A block split by an unrelated line is still a block.
  it("skips lines that are not part of a block", () => {
    const noisy = REAL.replace("UART Endpoint [6]autopilot {", "some other log line\nUART Endpoint [6]autopilot {");
    expect(parseStats(noisy).map((e) => e.name)).toEqual(["gcs0", "gcs1", "autopilot"]);
  });

  // A truncated tail is the ordinary case when reading the last N journal
  // lines: the newest block is usually half-written.
  it("drops a block whose counters are not all present rather than guessing at zero", () => {
    const cut = REAL.slice(0, REAL.indexOf("UART Endpoint"));
    expect(parseStats(cut + "UART Endpoint [6]autopilot {\n\tReceived messages {\n").map((e) => e.name))
      .toEqual(["gcs0", "gcs1"]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run --root packages/yonder-core src/mav/router/stats.test.ts`
Expected: FAIL — `Cannot find module './stats.js'`.

- [ ] **Step 3: Write it**

A block starts on a line matching `/^(UART|UDP|TCP) Endpoint \[\d+\](\S+) \{$/` and ends at
a line that is exactly `}` at the same depth. Inside, take `Handled:`, the `Total:` under
`Transmitted messages`, `CRC error:` and `Sequence lost:`. **A block missing any of the four
is dropped, not defaulted** — a truncated read must not report a silent ground station as
having gone quiet, which is a lamp changing colour because the journal was cut mid-write.

Lowercase the endpoint kind. Keep the order the text gave, because the configuration order is
what the page's three rows are in.

**No regex over the whole text.** Parse line by line with an explicit current-block, so an
interleaved journal line cannot join two blocks.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --root packages/yonder-core src/mav/router/stats.test.ts`
Expected: PASS, all five.

- [ ] **Step 5: Commit**

```bash
rm -f node_modules
git add packages/yonder-core/src/mav/router/stats.ts packages/yonder-core/src/mav/router/stats.test.ts
git commit -s -m "feat(mav): read the router's own per-endpoint counters — R-MAV-10"
```

**What Task 2 did not settle, and this task must not pretend it did.** The bench ran with no
TCP client attached, so **nothing has established how a connected TCP client appears in this
output** — whether as its own block, as a counter on the server's, or not at all. `parseStats`
therefore reports what it sees and derives nothing. `LinkState.tcpClients` stays `null` until
a bench with a client attached says what to count, and `null` draws no number rather than a
zero nobody measured. Recorded so the gap is a known one rather than a wrong readout.

---

## Task 9: `link.ts` — one link state

§6. **Task 2 settled the question this task used to carry.** The router does attribute traffic per endpoint, so `groundStations` is an array with a state per entry, fed by `parseStats` (Task 8b) rather than inferred from the merged loopback copy.

**Files:**
- Create: `packages/yonder-core/src/mav/link.ts`
- Test: `packages/yonder-core/src/mav/link.test.ts`

**Interfaces:**
- Consumes: `Heartbeat` (Task 5), `DetectOutcome` (Task 6), `EndpointStats` (Task 8b), `Clock`, the configured
  ground-station names (`Config["mavlink"]["endpoints"]`, Task 3) — `LinkTracker` never reads `Config` itself;
  its caller (Task 10's renderer, which holds the `Config` passed to `render()`) supplies the current names on
  every `sampled()` call
- Produces:
  ```ts
  export interface LinkState {
    phase: "searching" | "silent" | "noise" | "linked" | "stopped";
    device: string | null; baud: number | null;
    vehicle: string | null; system: number | null;
    heartbeatHz: number | null; lastHeardMs: number | null;
    /**
     * One entry per configured endpoint, in configuration order.
     *
     * Per-endpoint rather than a single flag, because the router turned out to
     * keep the attribution itself: with ReportStats on, an answering endpoint's
     * received count tracks its replies exactly and a silent one stays at zero.
     * §6 originally reported only *that* someone was answering, having reasoned
     * correctly that the merged loopback copy cannot distinguish them — and
     * missed that it does not have to.
     */
    groundStations: { name: string; answering: boolean; lastHeardMs: number | null }[];
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
    /**
     * One reading of the router's own counters (Task 8b), attributed to
     * ground stations by name against `groundStationNames` — never by
     * `kind`. `yonder` (the control-plane's own loopback copy, R-MAV-05) and,
     * once opened, `inbound` (R-MAV-07) are both legitimately UDP, exactly
     * like a real ground station, so `kind` alone cannot tell them apart.
     */
    sampled(stats: EndpointStats[], groundStationNames: string[]): void;
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
import type { EndpointStats } from "./router/stats.js";
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

  // The full shape of a tracker nobody has fed yet (§the brief's "state()
  // called before any sample has arrived"), so a field a later task adds a
  // reader for has a documented starting point rather than "whatever
  // toMatchObject happened not to check".
  it("reports every field as empty before anything has been observed, heard or sampled", () => {
    expect(new LinkTracker().state()).toEqual({
      phase: "searching",
      device: null,
      baud: null,
      vehicle: null,
      system: null,
      heartbeatHz: null,
      lastHeardMs: null,
      groundStations: [],
      triedBauds: [],
      traffic: null,
      tcpClients: null,
    });
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

  // A fresh sweep result is a new measurement of the link itself. Carrying a
  // stale vehicle name through a sweep that just came back silent would be
  // reporting something this observation never measured — the same mistake
  // §6 made about ground stations, one level up.
  it("drops the old vehicle when a later sweep finds silence instead", () => {
    const t = new LinkTracker();
    t.observed({ kind: "found", device: "/dev/ttyAMA0", baud: 57600, vehicle: "ArduPlane", system: 1 });
    t.observed({ kind: "silent", device: "/dev/ttyAMA0", triedBauds: [57600] });
    expect(t.state()).toMatchObject({ phase: "silent", vehicle: null, baud: null, system: null });
  });

  it("computes a heartbeat rate from arrivals, not from a configured number", () => {
    const clock = fakeClock();
    const t = new LinkTracker({ clock });
    t.observed({ kind: "found", device: "/dev/ttyAMA0", baud: 57600, vehicle: "ArduPlane", system: 1 });
    for (let i = 0; i < 5; i += 1) { t.heard(vehicle); clock.advance(1_000); }
    expect(t.state().heartbeatHz).toBeCloseTo(1, 1);
  });

  // heartbeatHz demands two arrivals before it will claim a rate at all — a
  // single beat fixes no interval, so no measurement backs a number yet.
  it("reports no heartbeat rate from a single arrival", () => {
    const clock = fakeClock();
    const t = new LinkTracker({ clock });
    t.observed({ kind: "found", device: "/dev/ttyAMA0", baud: 57600, vehicle: "ArduPlane", system: 1 });
    t.heard(vehicle);
    expect(t.state().heartbeatHz).toBeNull();
    expect(t.state().lastHeardMs).toBe(0);
  });

  // lastHeardMs is asked, not pushed: state() has no timer of its own, so
  // "how long ago" has to grow between calls even when nothing new arrived,
  // or a console left open on a lost link would read the last good moment
  // forever.
  it("keeps aging lastHeardMs between state() calls when nothing new arrives", () => {
    const clock = fakeClock();
    const t = new LinkTracker({ clock });
    t.observed({ kind: "found", device: "/dev/ttyAMA0", baud: 57600, vehicle: "ArduPlane", system: 1 });
    t.heard(vehicle);
    clock.advance(2_500);
    expect(t.state().lastHeardMs).toBe(2_500);
    clock.advance(2_500);
    expect(t.state().lastHeardMs).toBe(5_000);
  });

  // frame.ts's `fromVehicle` is what separates the aircraft's own heartbeat
  // from a ground station's — a GCS heartbeats back too (that is the whole
  // premise of §6), and mixing one into this ring would corrupt the vehicle's
  // own rate with an arrival that says nothing about it.
  it("counts only the vehicle's own heartbeats toward the rate, never a ground station's", () => {
    const clock = fakeClock();
    const t = new LinkTracker({ clock });
    t.observed({ kind: "found", device: "/dev/ttyAMA0", baud: 57600, vehicle: "ArduPlane", system: 1 });
    t.heard(vehicle);
    clock.advance(1_000);
    t.heard(gcs);
    clock.advance(1_000);
    t.heard(vehicle);
    // Only two vehicle heartbeats were ever heard, 2 s apart - a ground
    // station's heartbeat arriving in between must not count as a second
    // vehicle arrival at half the true interval.
    expect(t.state().heartbeatHz).toBeCloseTo(0.5, 1);
  });

  // §6: this is the whole point — "configured" is not "connected". The
  // attribution comes from the router's own counters (Task 8b), never from the
  // merged loopback copy, in which every ground station identifies itself the
  // same way. Measured on a board 2026-09-05: the answering endpoint's count
  // tracked its replies exactly and the silent one stayed at zero.
  //
  // receivedKb/transmittedKb default to mirroring the message counts so
  // every test that does not care about the traffic sparkline can ignore
  // them entirely, while still keeping sampled()'s backwards-counter guard
  // self-consistent (a call site that makes `received` decrease for a
  // restart test gets a decreasing `receivedKb` for free, matching the real
  // router where every counter resets together). Tests that exercise the
  // traffic figure itself pass explicit, distinct values.
  const udp = (name: string, received: number, transmitted: number, receivedKb = received, transmittedKb = transmitted): EndpointStats =>
    ({ name, kind: "udp", received, transmitted, crcErrors: 0, sequenceLost: 0, receivedKb, transmittedKb });

  it("calls a ground station answering only once its own counter has moved", () => {
    const clock = fakeClock();
    const t = new LinkTracker({ clock });
    t.observed({ kind: "found", device: "/dev/ttyAMA0", baud: 57600, vehicle: "ArduPlane", system: 1 });
    t.heard(vehicle);

    t.sampled([udp("gcs0", 0, 954), udp("gcs1", 0, 954)], ["gcs0", "gcs1"]);
    expect(t.state().groundStations).toEqual([
      { name: "gcs0", answering: false, lastHeardMs: null },
      { name: "gcs1", answering: false, lastHeardMs: null },
    ]);

    clock.advance(1_000);
    t.sampled([udp("gcs0", 21, 1008), udp("gcs1", 0, 1008)], ["gcs0", "gcs1"]);
    expect(t.state().groundStations).toEqual([
      { name: "gcs0", answering: true, lastHeardMs: 0 },
      { name: "gcs1", answering: false, lastHeardMs: null },
    ]);
  });

  // The console must be able to say *which* one went quiet, which is the
  // whole reason this is an array — and "went quiet" is a transition: both
  // stations must be honestly established as answering first, with a real
  // counter increase against a trustworthy prior, and only then does one
  // keep replying while the other goes flat.
  //
  // Correction from review round two (2026-09-05), corrected again in round
  // three: the brief's own version of this test seeded both stations at a
  // non-zero `received` on their very first sampled() call and expected
  // gcs1 — whose counter then never moved again — to still read
  // `lastHeardMs: 7_000` at the end, crediting that first sighting itself as
  // an answer. Round two's fix changed only the final expectation to
  // `lastHeardMs: null`, which is correct under the rule but stopped this
  // test from proving a transition at all: a station that never once
  // increases was never answering to begin with, merely never-answering,
  // which "reports a configured station absent from the statistics as never
  // heard" and "never credits a first sighting as answering..." already
  // cover. This version gives gcs1 a real, counter-verified answer before
  // letting it go quiet, so the assertion exercises the one thing an array
  // of per-station state exists for: naming the one that stopped while the
  // other keeps going.
  it("names the station that went quiet, not merely that one did", () => {
    const clock = fakeClock();
    const t = new LinkTracker({ clock, windowMs: 5_000 });
    // gcs1's very first sighting is already non-zero - it may have answered
    // the router at any point before this tracker existed (R-MAV-06) - and
    // must not be credited as answering on that total alone. Checking this
    // here, before any genuine increase would overwrite it, is what makes
    // this test actually depend on that rule: a version of this test that
    // starts every station at zero would pass even with the old, wrong
    // "non-zero first sighting answers now" fallback reinstated, because a
    // later genuine increase overwrites whatever a first sighting recorded
    // regardless of which rule produced it.
    t.sampled([udp("gcs0", 0, 60), udp("gcs1", 5, 60)], ["gcs0", "gcs1"]);
    expect(t.state().groundStations).toEqual([
      { name: "gcs0", answering: false, lastHeardMs: null },
      { name: "gcs1", answering: false, lastHeardMs: null },
    ]);

    clock.advance(1_000);
    // Both now genuinely answer - a real increase against a trustworthy
    // prior, not a first-sighting total.
    t.sampled([udp("gcs0", 1, 120), udp("gcs1", 6, 120)], ["gcs0", "gcs1"]);
    expect(t.state().groundStations).toEqual([
      { name: "gcs0", answering: true, lastHeardMs: 0 },
      { name: "gcs1", answering: true, lastHeardMs: 0 },
    ]);

    clock.advance(1_000);
    // gcs0 keeps answering; gcs1 goes flat, but is still within windowMs.
    t.sampled([udp("gcs0", 2, 180), udp("gcs1", 6, 180)], ["gcs0", "gcs1"]);
    expect(t.state().groundStations).toEqual([
      { name: "gcs0", answering: true, lastHeardMs: 0 },
      { name: "gcs1", answering: true, lastHeardMs: 1_000 },
    ]);

    clock.advance(6_000);
    // gcs0 is still answering every sample; gcs1's silence has now outlasted
    // windowMs, and the tracker must name gcs1, not gcs0, as the one that
    // went quiet.
    t.sampled([udp("gcs0", 3, 540), udp("gcs1", 6, 540)], ["gcs0", "gcs1"]);
    expect(t.state().groundStations).toEqual([
      { name: "gcs0", answering: true, lastHeardMs: 0 },
      { name: "gcs1", answering: false, lastHeardMs: 7_000 },
    ]);
  });

  // `kind` cannot do this filtering: `yonder` (the control plane's own
  // loopback copy, always present, R-MAV-05) and `inbound` (the ingest
  // listener, present once R-MAV-07 is opened) are both legitimately UDP,
  // indistinguishable from a real ground station by kind alone — and
  // `yonder`'s counter moves continuously whenever telemetry is flowing at
  // all, so a kind-only filter would show Yonder's own control-plane copy as
  // a permanently-answering ground station, on every device, every boot.
  // Attribution is by name against the configured set instead, which is why
  // `sampled` takes it as a second argument.
  it("keeps only the endpoints in the configured ground-station set, in that order", () => {
    const t = new LinkTracker({ clock: fakeClock() });
    t.sampled([
      udp("gcs0", 0, 954),
      { name: "autopilot", kind: "uart", received: 955, transmitted: 0, crcErrors: 0, sequenceLost: 0, receivedKb: 34, transmittedKb: 0 },
      udp("yonder", 40, 40),
      udp("inbound", 0, 0),
      udp("gcs1", 0, 954),
    ], ["gcs0", "gcs1"]);
    expect(t.state().groundStations.map((g) => g.name)).toEqual(["gcs0", "gcs1"]);
  });

  // Even a `yonder`/`inbound` counter that happens to be *higher* than a real
  // ground station's must never leak in: the filter is by name membership,
  // not by "everything except the UART", so this must hold regardless of
  // which numbers the reserved endpoints carry.
  it("never attributes the reserved yonder or inbound endpoints, however their counters move", () => {
    const clock = fakeClock();
    const t = new LinkTracker({ clock });
    t.sampled([udp("gcs0", 0, 10), udp("yonder", 40, 40), udp("inbound", 12, 0)], ["gcs0"]);
    clock.advance(1_000);
    t.sampled([udp("gcs0", 0, 20), udp("yonder", 90, 90), udp("inbound", 30, 0)], ["gcs0"]);
    expect(t.state().groundStations).toEqual([{ name: "gcs0", answering: false, lastHeardMs: null }]);
  });

  // A ground station configured but not yet in the router's own statistics
  // at all — the router has not started, or the endpoint was just added —
  // must read as "nothing heard", not throw and not be silently omitted.
  it("reports a configured station absent from the statistics as never heard", () => {
    const t = new LinkTracker({ clock: fakeClock() });
    t.sampled([], ["gcs0", "gcs1"]);
    expect(t.state().groundStations).toEqual([
      { name: "gcs0", answering: false, lastHeardMs: null },
      { name: "gcs1", answering: false, lastHeardMs: null },
    ]);
  });

  // A block missing from one particular reading — router/stats.ts drops a
  // truncated block outright — must not be read as "went silent this
  // instant": a station's last *genuine* answer keeps aging normally rather
  // than being wiped by a read that simply did not carry it this time.
  it("keeps a station's last answer when one reading omits it, rather than resetting it", () => {
    const clock = fakeClock();
    const t = new LinkTracker({ clock, windowMs: 5_000 });
    // Establish a real answer for gcs1 first: its counter genuinely
    // increases against a trustworthy prior, which is what makes the
    // timestamp that follows an actual measurement rather than a total.
    t.sampled([udp("gcs0", 0, 10), udp("gcs1", 0, 10)], ["gcs0", "gcs1"]);
    clock.advance(500);
    t.sampled([udp("gcs0", 0, 20), udp("gcs1", 5, 20)], ["gcs0", "gcs1"]);
    clock.advance(500);
    // gcs1's block was cut short this reading and parseStats dropped it.
    t.sampled([udp("gcs0", 0, 30)], ["gcs0", "gcs1"]);
    expect(t.state().groundStations).toEqual([
      { name: "gcs0", answering: false, lastHeardMs: null },
      { name: "gcs1", answering: true, lastHeardMs: 500 },
    ]);
  });

  // The configured set can change between readings — an endpoint added or
  // removed in config.yaml. Removed means gone from the report entirely, not
  // carried forward as a stale row; added means it starts exactly like any
  // other station seen for the first time.
  it("drops a ground station's row the moment it leaves the configured set", () => {
    const t = new LinkTracker({ clock: fakeClock() });
    t.sampled([udp("gcs0", 0, 10), udp("gcs1", 5, 10)], ["gcs0", "gcs1"]);
    t.sampled([udp("gcs0", 0, 10), udp("gcs1", 5, 10)], ["gcs0"]);
    expect(t.state().groundStations).toEqual([{ name: "gcs0", answering: false, lastHeardMs: null }]);
  });

  // gcs1 already has a non-zero counter the first moment it is watched — it
  // may have answered at any point since the router started, which could be
  // long before this name was ever added to the configured set, so its
  // first sighting is reported exactly like a brand new station's: not yet
  // known to be answering. "Not backfilled" cuts both ways — no history is
  // invented for it, including a plausible-looking "just now".
  it("adds a newly configured ground station as freshly seen, not backfilled", () => {
    const clock = fakeClock();
    const t = new LinkTracker({ clock });
    t.sampled([udp("gcs0", 0, 10)], ["gcs0"]);
    clock.advance(1_000);
    t.sampled([udp("gcs0", 0, 10), udp("gcs1", 3, 6)], ["gcs0", "gcs1"]);
    expect(t.state().groundStations).toEqual([
      { name: "gcs0", answering: false, lastHeardMs: null },
      { name: "gcs1", answering: false, lastHeardMs: null },
    ]);
  });

  // The router's counters are cumulative since it started (§the bench note):
  // a lower reading than last time means the router itself restarted, not
  // that a ground station un-answered. TrafficSampler (remote/sampler.ts)
  // solves this exact problem by discarding the stale baseline; this follows
  // the same rule, per endpoint — and, per the correction above, an
  // immediate post-restart reading that is already non-zero is *still* only
  // a total, not a rate: it is treated exactly like a first sighting, not
  // credited as answering until a genuine increase is observed against it.
  it("does not credit an immediate post-restart reading as answering, even when it is non-zero", () => {
    const clock = fakeClock();
    const t = new LinkTracker({ clock, windowMs: 5_000 });
    t.sampled([udp("gcs0", 50, 100)], ["gcs0"]);
    clock.advance(1_000);
    // The router restarted: its counters are small again, but still
    // non-zero. That alone says gcs0 answered *at some point* since the
    // restart, not that it is answering *now*.
    t.sampled([udp("gcs0", 2, 4)], ["gcs0"]);
    expect(t.state().groundStations).toEqual([{ name: "gcs0", answering: false, lastHeardMs: null }]);

    clock.advance(1_000);
    // The next sample shows a genuine increase from the post-restart
    // baseline — real, timestamped evidence, exactly like the ordinary case.
    t.sampled([udp("gcs0", 5, 10)], ["gcs0"]);
    expect(t.state().groundStations).toEqual([{ name: "gcs0", answering: true, lastHeardMs: 0 }]);
  });

  it("does not call a station answering the instant the router restarts silent", () => {
    const clock = fakeClock();
    const t = new LinkTracker({ clock, windowMs: 5_000 });
    t.sampled([udp("gcs0", 50, 100)], ["gcs0"]);
    clock.advance(1_000);
    // Restarted, and nothing has answered yet since — 0 is 0, not a claim.
    t.sampled([udp("gcs0", 0, 0)], ["gcs0"]);
    expect(t.state().groundStations).toEqual([{ name: "gcs0", answering: false, lastHeardMs: null }]);
  });

  // Pins the rule directly, independent of any restart: a first sighting
  // never counts as answering, however large the total is, and it takes
  // nothing more than one further genuine increase to start counting.
  it("never credits a first sighting as answering, whatever the counter already reads", () => {
    const clock = fakeClock();
    const t = new LinkTracker({ clock });
    // A fresh tracker meeting a ground station the router has already been
    // routing to for a long time (R-MAV-06: the router survives a
    // yonder-core restart) — a large total that predates this tracker
    // entirely.
    t.sampled([udp("gcs0", 10_000, 10_000)], ["gcs0"]);
    expect(t.state().groundStations).toEqual([{ name: "gcs0", answering: false, lastHeardMs: null }]);

    clock.advance(1_000);
    t.sampled([udp("gcs0", 10_001, 10_001)], ["gcs0"]);
    expect(t.state().groundStations).toEqual([{ name: "gcs0", answering: true, lastHeardMs: 0 }]);
  });

  // Nothing has measured how a connected TCP client appears in the router's
  // output (Task 8b), so this reports nothing rather than a zero.
  it("leaves the TCP client count unmeasured rather than reporting zero", () => {
    const t = new LinkTracker({ clock: fakeClock() });
    t.sampled([udp("gcs0", 0, 954)], ["gcs0"]);
    expect(t.state().tcpClients).toBeNull();
  });

  it("reports no traffic before the router's statistics have ever been sampled", () => {
    const t = new LinkTracker({ clock: fakeClock() });
    t.observed({ kind: "found", device: "/dev/ttyAMA0", baud: 57600, vehicle: "ArduPlane", system: 1 });
    t.heard(vehicle);
    expect(t.state().traffic).toBeNull();
  });

  // The Throughput sparkline sits in the design under "Ground stations", not
  // under the autopilot half (docs/console/design/telemetry/README.md), so
  // it is the ground stations' own KB counters — the router's own unit,
  // beside the message counts already read for `groundStations` — turned
  // into a rate the way TrafficSampler turns interface byte counters into
  // one: a delta between two readings, divided by the clock time between
  // them. The very first reading is a total, not a rate, exactly as it is
  // there. KB values here are deliberately different from the message
  // counts, to prove this reads the router's own byte figure rather than
  // relabelling the message-count delta.
  it("turns the ground stations' own KB counters into a kB/s traffic rate once two readings exist", () => {
    const clock = fakeClock();
    const t = new LinkTracker({ clock });
    t.sampled([udp("gcs0", 0, 0, 0, 0), udp("gcs1", 0, 0, 0, 0)], ["gcs0", "gcs1"]);
    expect(t.state().traffic).toEqual({ rx: [], tx: [], peak: null, windowMs: 5_000 });

    clock.advance(1_000);
    // gcs0 answered 10 messages (1 KB) and both stations had 100 messages
    // (34 KB each) of telemetry mirrored to them in that second.
    t.sampled([udp("gcs0", 10, 100, 1, 34), udp("gcs1", 0, 100, 0, 34)], ["gcs0", "gcs1"]);
    expect(t.state().traffic).toEqual({ rx: [1], tx: [68], peak: 68, windowMs: 5_000 });
  });

  // Traffic history ages out on the same recency window the ground stations'
  // own `answering` flag uses — one clock, one meaning of "recent", rather
  // than a second window invented just for the sparkline.
  it("ages traffic history out of the window once it is older than windowMs", () => {
    const clock = fakeClock();
    const t = new LinkTracker({ clock, windowMs: 2_000 });
    t.sampled([udp("gcs0", 0, 0, 0, 0)], ["gcs0"]);
    clock.advance(1_000);
    t.sampled([udp("gcs0", 5, 5, 2, 3)], ["gcs0"]);
    clock.advance(3_000);
    // No further traffic, but enough time has passed that the one point of
    // history recorded so far is now outside the window and must not still
    // be reported alongside this reading's own (zero) point.
    t.sampled([udp("gcs0", 5, 5, 2, 3)], ["gcs0"]);
    expect(t.state().traffic).toEqual({ rx: [0], tx: [0], peak: 0, windowMs: 2_000 });
  });

  it("keeps the autopilot half alive when the operator stops telemetry (R-MAV-09)", () => {
    const t = new LinkTracker();
    t.observed({ kind: "found", device: "/dev/ttyAMA0", baud: 57600, vehicle: "ArduPlane", system: 1 });
    t.stopped();
    expect(t.state()).toMatchObject({ phase: "stopped", vehicle: "ArduPlane", baud: 57600 });
  });

  // R-MAV-09's other half: the loopback listener (Task 11) keeps handing the
  // stopped tracker heartbeats the whole time telemetry is off, and that must
  // not make the page claim telemetry is running again on its own.
  it("does not let a heartbeat arriving while stopped revert the phase", () => {
    const t = new LinkTracker({ clock: fakeClock() });
    t.observed({ kind: "found", device: "/dev/ttyAMA0", baud: 57600, vehicle: "ArduPlane", system: 1 });
    t.stopped();
    t.heard(vehicle);
    expect(t.state().phase).toBe("stopped");
  });

  // A fresh sweep is the one action that is unambiguously "telemetry is
  // active again" — Task 10's renderer only re-detects as an explicit
  // operator action, stopping and restarting the router around it.
  it("clears stopped once a fresh detection sweep reports back", () => {
    const t = new LinkTracker();
    t.observed({ kind: "found", device: "/dev/ttyAMA0", baud: 57600, vehicle: "ArduPlane", system: 1 });
    t.stopped();
    t.observed({ kind: "found", device: "/dev/ttyAMA0", baud: 57600, vehicle: "ArduPlane", system: 1 });
    expect(t.state().phase).toBe("linked");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run --root packages/yonder-core src/mav/link.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write it**

Implement `LinkTracker` to satisfy exactly those tests: keep the last `DetectOutcome`, a ring of vehicle-heartbeat timestamps for the rate (`heartbeatHz = (n - 1) / (last - first)` in seconds, `null` below two samples — a rate from one arrival is a claim no measurement supports), and, for the ground-station half, **the last sample at which each endpoint's `received` counter increased** — not the last heartbeat with `fromVehicle === false`, which is what an earlier draft said and what Task 2 disproved. Keep the previous sample to difference against; an endpoint seen for the first time has `lastHeardMs: null`, and one whose counter has not moved within `windowMs` is no longer answering. A first sighting is never credited **whatever the counter already reads**, restart included: the router's counters are cumulative since it started and the router itself outlives a `yonder-core` restart by design (R-MAV-06), so a fresh `LinkTracker` meeting a long-running router — the ordinary boot case, not an edge one — sees a stale non-zero total that is evidence something happened *at some point*, never evidence of the present tense. Only a counter that *moves* against a trustworthy prior reading is; a version that credited the total itself shipped once already and was caught by review (see Task 9's commit history), so this is recorded here rather than left for the code alone to say.

**Attribute `sampled`'s reading by name, never by `kind`.** An earlier draft of this step dropped endpoints whose `kind` was not `"udp"` or `"tcp"`, reasoning that this excludes the UART and nothing else needs excluding. That reasoning is wrong, and not at the margin: `router/config.ts` (Task 8) always emits `[UdpEndpoint yonder]`, the control plane's own loopback copy (R-MAV-05), and — once `mavlink.ingest.loopback_only` is opened — `[UdpEndpoint inbound]` (R-MAV-07) too, and both are `kind: "udp"` in `parseStats`'s output exactly like a real ground station, because both genuinely are UDP endpoints the router reports on. `yonder`'s `received` counter moves continuously whenever telemetry is flowing at all, so a `kind`-only filter would show Yonder's own control-plane feed as a permanently-answering ground station, on every device, on every boot, into a list the console budgets exactly three positional rows for. Filter instead by intersecting `stats` against the `groundStationNames` array the caller passes to `sampled()` on that call, keeping the result in the order `groundStationNames` gives — `LinkTracker` holds no `Config` of its own, so this name set is supplied fresh by Task 10's renderer (which does hold it) on every reading, not fixed at construction.

`windowMs` defaults to `5_000`. `stopped()` sets the phase and leaves every autopilot-side field untouched.

The shipped implementation, extracted from `packages/yonder-core/src/mav/link.ts` rather than retyped (this file went through two rounds of correction after review — see its commit history):

```ts
// packages/yonder-core/src/mav/link.ts
// SPDX-License-Identifier: GPL-3.0-or-later
import type { Clock } from "../apply/types.js";
import { systemClock } from "../apply/types.js";
import type { DetectOutcome } from "./detect.js";
import type { Heartbeat } from "./frame.js";
import type { EndpointStats } from "./router/stats.js";

/**
 * One state, everything the console's Telemetry page reads (R-MAV-10).
 *
 * §6's governing idea, carried into the type: every field here is something
 * that happened, not something that was configured. `heartbeatHz` comes from
 * the spacing between arrivals, not from a MAVLink stream rate nobody asked
 * the vehicle to honour. `groundStations[i].answering` comes from that one
 * endpoint's own counter having moved in `mavlink-router`'s own statistics,
 * never from the endpoint merely appearing in `config.yaml` — a lesson this
 * design paid for once already: an earlier draft of this same file reasoned
 * from the merged loopback copy, where every ground station looks identical,
 * and could only report *that* one was answering, not which. A field this
 * file cannot measure is `null`, never a plausible-looking zero.
 *
 * The same rule turned out to bind harder than it first looked: a counter
 * being cumulative since the router started (`EndpointStats`) means a
 * *non-zero* reading is not exempt from it either. The router survives a
 * `yonder-core` restart by design (R-MAV-06), so a fresh `LinkTracker`
 * meeting a long-running router with an already-large count is the ordinary
 * case, not an edge one — and a total on its own says only "answered at
 * some point", never "answering now". Only a counter *moving* between two
 * readings is evidence of the present tense, which is why every "answering"
 * decision below waits for a second sample before it will say yes.
 */
export interface LinkState {
  phase: "searching" | "silent" | "noise" | "linked" | "stopped";
  device: string | null;
  baud: number | null;
  vehicle: string | null;
  system: number | null;
  heartbeatHz: number | null;
  lastHeardMs: number | null;
  /**
   * One entry per configured endpoint, in configuration order.
   *
   * Per-endpoint rather than a single flag, because the router turned out to
   * keep the attribution itself: with ReportStats on, an answering endpoint's
   * received count tracks its replies exactly and a silent one stays at zero.
   * §6 originally reported only *that* someone was answering, having reasoned
   * correctly that the merged loopback copy cannot distinguish them — and
   * missed that it does not have to.
   */
  groundStations: { name: string; answering: boolean; lastHeardMs: number | null }[];
  triedBauds: number[];
  /**
   * The sparkline's two series and the TCP client count, which the page
   * needs and heartbeats cannot supply.
   *
   * An earlier draft defined this state from heartbeats alone and left a
   * later, thinner layer to produce RX/TX history and a client count out of
   * them, which no thin adapter could — every heartbeat stream looks the
   * same. `rx`/`tx` are **kilobytes per second**, in the router's own coarse
   * integer unit (`EndpointStats.receivedKb`/`.transmittedKb` — the figure
   * `mavlink-router` prints beside every count, e.g. `Handled: 21 1KB`) —
   * never a bytes-per-message conversion off the message counts, because
   * MAVLink messages vary in size and any such factor would be a configured
   * number smuggled in as a unit, the exact thing this file exists to
   * refuse. Summed across the configured ground stations, where the design's
   * Throughput instrument sits (`docs/console/design/telemetry/README.md`),
   * and turned into a rate the way `TrafficSampler` (`remote/sampler.ts`)
   * already turns an interface's byte counters into one: a delta between two
   * readings, divided by the clock time between them, with the same "a
   * counter that went backwards means a restart, not negative traffic"
   * guard. Because the router's own KB figure is coarse and integer, a slow
   * link can go several samples between it moving at all, so this series is
   * honestly lumpy rather than smoothed into a shape nobody measured. `null`
   * until that source has answered even once, rather than a zero that would
   * draw a flat line nobody measured.
   */
  traffic: { rx: number[]; tx: number[]; peak: number | null; windowMs: number } | null;
  tcpClients: number | null;
}

const DEFAULT_WINDOW_MS = 5_000;

/**
 * Heartbeats kept for the rate calculation. HEARTBEAT is nominally 1 Hz, so
 * ten of them span roughly the last ten seconds — enough to smooth over one
 * missed beat without a rate from long ago outliving its own relevance.
 */
const HEARTBEAT_RING_SIZE = 10;

/** What is kept per ground station between `sampled()` calls, so the next
    reading has something to difference against. */
interface StationRecord {
  received: number;
  transmitted: number;
  receivedKb: number;
  transmittedKb: number;
  /** When this endpoint's `received` count was last seen to *increase*
      against a reading that was itself trustworthy. `null` until that has
      genuinely happened — never seeded from a first or post-restart total
      on its own, however large, because a total alone fixes no instant. */
  lastAnsweredAtMs: number | null;
}

/** One traffic-rate reading, timestamped so it can age out of `windowMs`. */
interface TrafficPoint {
  atMs: number;
  rx: number;
  tx: number;
}

export class LinkTracker {
  private readonly clock: Clock;
  private readonly windowMs: number;

  private lastOutcome: DetectOutcome | null = null;
  private isStopped = false;

  private heartbeatRing: number[] = [];
  private lastHeartbeatAtMs: number | null = null;

  private stationRecords = new Map<string, StationRecord>();
  private lastGroundStationNames: string[] = [];

  private lastSampledAtMs: number | null = null;
  private hasSampled = false;
  private trafficHistory: TrafficPoint[] = [];

  constructor(opts: { clock?: Clock; windowMs?: number } = {}) {
    this.clock = opts.clock ?? systemClock;
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  }

  /**
   * A fresh sweep result, from `detect()` (§3). It replaces whatever was
   * known about the serial link outright, rather than layering on top of it:
   * a sweep that comes back silent has disproved whatever vehicle a previous
   * sweep found, so that vehicle's name must not survive into this reading
   * (see link.test.ts's "drops the old vehicle" case) — carrying it forward
   * would be reporting something this observation never measured, the same
   * mistake §6 made about ground stations one level up.
   *
   * Having reported back at all is also proof that detection is running
   * again, so a `stopped()` from before this call no longer applies —
   * re-detection (Task 11's `/mav/detect`) is the one explicit operator
   * action that stops and restarts the router around a fresh probe.
   */
  observed(outcome: DetectOutcome): void {
    this.lastOutcome = outcome;
    this.isStopped = false;
    this.heartbeatRing = [];
    this.lastHeartbeatAtMs = null;
  }

  /**
   * A heartbeat off the loopback feed (Task 11). Only ones the vehicle
   * itself sent count: a ground station heartbeats back too (frame.ts's
   * `fromVehicle`, and the whole premise of §6), and mixing one into this
   * ring would corrupt the vehicle's own rate with an arrival that says
   * nothing about it.
   */
  heard(heartbeat: Heartbeat): void {
    if (!heartbeat.fromVehicle) return;
    const now = this.clock.now();
    this.lastHeartbeatAtMs = now;
    this.heartbeatRing.push(now);
    if (this.heartbeatRing.length > HEARTBEAT_RING_SIZE) this.heartbeatRing.shift();
  }

  /**
   * One reading of the router's own counters (Task 8b), attributed to
   * ground stations by name against `groundStationNames` — never by `kind`.
   * `yonder` (the control-plane's own loopback copy, R-MAV-05) and, once
   * opened, `inbound` (R-MAV-07) are both legitimately UDP, exactly like a
   * real ground station, so `kind` alone cannot tell them apart; only the
   * caller's own configured names can, which is why this takes them fresh on
   * every call rather than once at construction — `LinkTracker` holds no
   * `Config` of its own.
   */
  sampled(stats: EndpointStats[], groundStationNames: string[]): void {
    const now = this.clock.now();
    const byName = new Map(stats.map((entry) => [entry.name, entry] as const));
    this.lastGroundStationNames = [...groundStationNames];

    const elapsedSeconds = this.lastSampledAtMs === null ? null : (now - this.lastSampledAtMs) / 1000;
    let rxKbDelta = 0;
    let txKbDelta = 0;
    let haveDelta = false;

    for (const name of groundStationNames) {
      const entry = byName.get(name);
      // Missing from this particular reading — a block router/stats.ts
      // dropped as truncated, or an endpoint the router has not opened yet.
      // Leave whatever is already on record exactly as it is: a station does
      // not go silent because one read of the journal happened to cut it
      // off mid-write.
      if (entry === undefined) continue;

      const prior = this.stationRecords.get(name);
      // The router's counters are cumulative since it started (measured on a
      // board, 2026-09-05), so a set of counters that has not gone backwards
      // is a real prior total to difference against. One that *has* — the
      // router restarted underneath this reading — is treated exactly like
      // an endpoint seen for the very first time: TrafficSampler
      // (remote/sampler.ts) discards its own baseline the same way when an
      // interface's counters restart under it.
      const validPrior = prior !== undefined
        && entry.received >= prior.received
        && entry.transmitted >= prior.transmitted
        && entry.receivedKb >= prior.receivedKb
        && entry.transmittedKb >= prior.transmittedKb;

      let lastAnsweredAtMs: number | null;
      if (validPrior && prior !== undefined) {
        lastAnsweredAtMs = entry.received > prior.received ? now : prior.lastAnsweredAtMs;
        if (elapsedSeconds !== null && elapsedSeconds > 0) {
          rxKbDelta += entry.receivedKb - prior.receivedKb;
          txKbDelta += entry.transmittedKb - prior.transmittedKb;
          haveDelta = true;
        }
      } else {
        // No usable prior: first sighting, or a restart just invalidated the
        // old one. Either way this reading is a *total*, not a rate, and a
        // total alone — however large — is evidence the endpoint answered
        // *at some point*, not that it is answering *now*: the count could
        // be minutes old (a fresh tracker meeting a router that has been
        // running for hours, R-MAV-06) or seconds old (a restart whose very
        // next reading already shows a reply) and this single number cannot
        // tell those apart. `heartbeatHz` already refuses the equivalent
        // claim for a single heartbeat; this is the same refusal for a
        // single counter reading. The next sample, with a real prior to
        // diff against, tells the truth either way.
        lastAnsweredAtMs = null;
      }

      this.stationRecords.set(name, {
        received: entry.received,
        transmitted: entry.transmitted,
        receivedKb: entry.receivedKb,
        transmittedKb: entry.transmittedKb,
        lastAnsweredAtMs,
      });
    }

    if (haveDelta && elapsedSeconds !== null) {
      this.trafficHistory.push({ atMs: now, rx: rxKbDelta / elapsedSeconds, tx: txKbDelta / elapsedSeconds });
    }
    const cutoff = now - this.windowMs;
    this.trafficHistory = this.trafficHistory.filter((point) => point.atMs >= cutoff);

    this.lastSampledAtMs = now;
    this.hasSampled = true;
  }

  /**
   * R-MAV-09. Ground-station routing and the serial link's own vehicle,
   * speed and heartbeat history are all left exactly as they were: stopping
   * telemetry is an operator choice about routing, not a fact about the
   * autopilot, which never hears about it and keeps heartbeating over the
   * UART regardless.
   */
  stopped(): void {
    this.isStopped = true;
  }

  state(): LinkState {
    const now = this.clock.now();
    const outcome = this.lastOutcome;

    const phase = this.isStopped
      ? "stopped"
      : outcome === null
        ? "searching"
        : outcome.kind === "found" ? "linked" : outcome.kind;

    // Below two arrivals there is no interval to measure yet — a rate from
    // one heartbeat is a claim no measurement supports.
    const heartbeatHz = this.heartbeatRing.length >= 2
      ? (this.heartbeatRing.length - 1)
        / ((this.heartbeatRing[this.heartbeatRing.length - 1] - this.heartbeatRing[0]) / 1000)
      : null;

    // Asked, not pushed: state() carries no timer of its own, so "how long
    // ago" is computed fresh against the current clock on every call rather
    // than frozen at whichever sample last touched it — otherwise a console
    // left open on a link that went quiet would read the last good moment
    // forever.
    const groundStations = this.lastGroundStationNames.map((name) => {
      const record = this.stationRecords.get(name);
      const lastHeardMs = record?.lastAnsweredAtMs != null ? now - record.lastAnsweredAtMs : null;
      return { name, answering: lastHeardMs !== null && lastHeardMs < this.windowMs, lastHeardMs };
    });

    const traffic = this.hasSampled
      ? {
          rx: this.trafficHistory.map((point) => point.rx),
          tx: this.trafficHistory.map((point) => point.tx),
          peak: this.trafficHistory.length === 0
            ? null
            : Math.max(...this.trafficHistory.flatMap((point) => [Math.abs(point.rx), Math.abs(point.tx)])),
          windowMs: this.windowMs,
        }
      : null;

    return {
      phase,
      device: outcome?.device ?? null,
      baud: outcome?.kind === "found" ? outcome.baud : null,
      vehicle: outcome?.kind === "found" ? outcome.vehicle : null,
      system: outcome?.kind === "found" ? outcome.system : null,
      heartbeatHz,
      lastHeardMs: this.lastHeartbeatAtMs === null ? null : now - this.lastHeartbeatAtMs,
      groundStations,
      triedBauds: outcome !== null && outcome.kind !== "found" ? outcome.triedBauds : [],
      traffic,
      // Nothing has measured how a connected TCP client appears in the
      // router's output (Task 8b) — whether as its own block, a counter on
      // the server's, or not at all. Reporting a derived count would be a
      // number nobody measured, so this stays null until a bench session
      // with a client attached says what to count.
      tcpClients: null,
    };
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --root packages/yonder-core src/mav/link.test.ts`
Expected: PASS, all twenty-eight — this file grew well past the ten the brief originally specified across two rounds of review (see the commit history: the KB-unit fix and the first-sighting/restart correction each added coverage, and one test was corrected in place rather than simply loosened, which is its own recorded lesson).

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
| `tel-gcs-0..2` | `{ state, message }` too, **one per ground station**, from `LinkState.groundStations[i]`. The node carries no label, so the message is the whole caption and must name the row: `"GCS 0 · answering"` (`confirmed`), `"GCS 1 · silent"` (`pending` — it answered before and has gone quiet), `"GCS 2 · not set"` or `"· no reply"` (`idle`). These replaced the rows' `ui-text` labels when Task 2 showed the router attributes traffic per endpoint |
| `tel-port`, `tel-speed`, `tel-vehicle`, `tel-hb`, `tel-heard`, `tel-answered`, `tel-atboot`, `tel-ingest`, `tel-tcp` | a plain string, already in words: `"/dev/ttyAMA0"`, `"57 600 baud"`, `"ArduPlane · system 1"`, `"1.0 Hz"`, `"0.4 s ago"`. **`tel-answered` names the station** — `"GCS 0 · 0.3 s ago"` — because three rows now carry their own state and an unattributed "last answered" asks a question the page can answer |
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

**Spec coverage.** §1 → Task 3 and the slice this whole plan implements. §2 → Task 15. §3 → Tasks 1, 6, 7. §4 → Tasks 8, 10, 16. §5 → Task 4. §6 → Tasks 2, 8b, 9. §7 → Tasks 4 and 6 (each requirement lands in the commit that implements it, per rule 3). §8 → Tasks 12, 13, 14. §9 → the file structure above. §10 → Tasks 1 and 2, deliberately first.

**A third gap, found by the pre-flight scan on 2026-09-05 and closed by Task 8b.** Three
`LinkState` fields — `groundStations`, `traffic` and `tcpClients` — each said they came from
`mavlink-router`'s own statistics, and **no task read them**. Task 10 shells out but only for
the service lifecycle; Task 11 reads heartbeats off the loopback socket. The page's sparkline,
its TCP client count and its three per-station marks would all have had no source. Task 8b is
the parser; Task 9 folds it in; Task 10 fetches the text.

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

**A correction the plan tried to make to the spec, and should not have.** An earlier draft of this paragraph claimed §5 and §7 exempted `mavlink` "by name" and that the spec "has been tightened to match". Both were false: §5 already named individual leaves, and it excluded `mavlink.tcp_server.port` on purpose, with a counterexample — a router that takes a port another service needs costs reachability by a route touching no interface, no route and no radio, and `R-MAV-14` refuses exactly one such collision while the window catches the rest. The spec was never amended. Task 4 therefore exempts **three** leaves — `mavlink.endpoints`, `mavlink.autocast` and `mavlink.tcp_server.enabled` — and leaves `mavlink.serial`, `mavlink.ingest` and `mavlink.tcp_server.port` load-bearing, which is what the spec said in the first place.
