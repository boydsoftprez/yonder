# M4 Camera View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One USB camera on one generated page — live video in a browser over a cellular link from another network, a ground station receiving the same feed, and every control on the page drawn from what the device answered rather than from a stored list.

**Architecture:** A camera is an **identity, a source, and a capability set read from the device**; the page is generated from the capability set, so a control's backend varies while the control does not. Probing and pipeline composition are **pure functions over recorded command output** — a composed pipeline is a value a test asserts without a camera present. Long-running pipelines are **spawned and supervised**, which is the whole runtime surface: resolution, codec and bitrate are a respawn, and there is no control channel into a running pipeline. mediamtx serves every browser and RTSP consumer ([ADR-0003](../../adr/0003-mediamtx-not-janus.md)) from a configuration Yonder generates, with **a stated posture for every listener it opens**.

**Tech Stack:** Node 22.12 · TypeScript (strict, ESM, NodeNext) · Zod · vitest · GStreamer 1.22 (`v4l2src`, `v4l2h264enc`, `v4l2convert`, `rtspclientsink`) · `v4l2-ctl` (v4l-utils) · mediamtx · Node-RED 5 + Dashboard 2.x · Vue 3 · POSIX `sh` (installer)

**Spec:** [2026-09-03-camera-view-design.md](../specs/2026-09-03-camera-view-design.md). **Review:** [2026-09-03-camera-view-review.md](../reviews/2026-09-03-camera-view-review.md). Every measurement quoted below was read off a real board; do not re-derive them from vendor documentation.

---

## Scope

This plan is **M4 only** — the spec spans M4, M5 and M7, and its §9 milestone table is what draws the line. M4 is the milestone that can be finished with the hardware on the bench today.

**In scope (M4).** R-CAM-02, R-CAM-05, R-CAM-07, R-CAM-10, R-CAM-12, R-CAM-13, R-CAM-14 · R-VID-01, R-VID-03, R-VID-04, R-VID-05, R-VID-08, R-VID-09, R-VID-10, R-VID-11, R-VID-13, R-VID-14, R-VID-15 · R-CTL-01, R-CTL-02, R-CTL-03, R-CTL-04, R-CTL-05, R-CTL-08, R-CTL-09, R-CTL-10 · R-SEC-13 · R-SYS-09 · R-UI-03, R-UI-15 · R-HW-01, R-HW-02.

**Out of scope, and why.**

| Deferred | To | Why |
|---|---|---|
| The aim guard, the dial, drag-to-slew, tap-to-point (spec §3) | M5 | There is no gimbal on the bench until the accessory camera arrives. A pure module with no consumer is speculative work, and the envelope it clamps to is a property of an installation that does not exist yet. **What M4 owes it is shape, not code:** Task 3's capability model must admit an `aim` capability without being reopened. |
| Recording, stills-to-storage, the recording annunciator and its tone (spec §6, R-CAM-17, R-CAM-18, R-STO-06) | M5 | The spec places them there: the accessory camera is the first with a recorder of its own. The *recording* tone lands "in the same change as the annunciator", so `Palette` gains no token here. |
| The MAVLink camera announce and command relay (spec §8, R-VID-12, R-CAM-16) | M7 | M7 is commanding. Task 3 records the flagset alignment as a naming constraint so M7 needs no translation layer. |
| Adaptive bitrate (R-VID-07) | M9 | It is the only thing that needs a control channel into a running pipeline, and it carries that cost rather than M4 paying it early (spec §11). |
| The Cockpit's embedded compact form | M5+ | The view is *built* as a component with a compact form here; what the Cockpit holds is its own design (spec §12). |
| CSI, HDMI, H.265, Radxa, more than one camera at once | M6 | Roadmap. Task 1's schema admits one `source` value, and adding the next is a one-line change with a probe behind it. |
| **The camera strip** — thumbnails of the other cameras under the picture (spec §5) | M6 | Multi-camera is M6, and a strip of one camera is a strip of nothing. The **Cameras index page** is not deferred with it: R-CAM-12's rejections need somewhere to live from the first camera onward, and Task 16 builds it. |
| **Adaptive bitrate's segmented control** (spec §4, *Fixed or Adaptive*) | M9 | With only R-VID-08's fixed bitrate in M4 there is one mode, and a two-way switch with one reachable position is a control that lies. The deck carries the picker of real rates and nothing to switch between; §10's maximum-width rule is in Global Constraints so the control arrives correct when M9 adds it. |
| **HDR (R-CTL-06) and colour treatment (R-CTL-07)** | M6 or later | Both P3, both sensor-dependent, and neither has ever been enumerated on this bench. They cost nothing to defer because the capability model already draws them: a camera that does not offer them reports `not-offered` and Task 14's facts row states it, which is R-UI-15 doing the work rather than a gap. |

**Prerequisite that is not code.** Task 4 needs `v4l2-ctl` output recorded from the board, and **no such output exists anywhere in this repository today** — the hardware note gives the command, not its answer. Task 4 Step 0 captures it. Do not write the parser against remembered format.

---

## Global Constraints

- **Licence:** GPL-3.0. Every source file carries `// SPDX-License-Identifier: GPL-3.0-or-later` (`#` form in shell, `<!-- -->` in `.vue`).
- **Commits:** GPG-signed and DCO signed-off. Always `git commit -s`. **Never `--no-gpg-sign`** — if signing fails, stop and report.
- **Node:** 22.12 minimum for console-side work, 20 for `yonder-core`. TypeScript strict. ESM with `.js` import extensions (NodeNext).
- **Requirements:** cite the `R-*` IDs each task satisfies. IDs are stable — never reuse or renumber. **This plan adds no requirements**: the nine the spec called for landed in commit `0386f0b`.
- **This repository is self-contained:** no references to paths outside it, no comparison to other products.
- **Nothing shells out except renderers and probes,** and everything that does goes through the injected `CommandRunner` (`src/net/runner.ts`) — which **never rejects: a non-zero exit is a result, not an exception.** Long-running processes go through `ProcessSpawner`, introduced in Task 7. **No test may execute `v4l2-ctl`, `gst-launch-1.0` or `mediamtx`.**
- **Logic lives in node packages, never in Node-RED `function` nodes.** `flows/flows.json` is wiring only (CLAUDE.md rule 2). Presentation is Vue components in `node-red-dashboard-2-yonder`, never markup in a `ui-template`.
- **Nothing may make the device unreachable** (CLAUDE.md rule 6). Task 2 is the whole of this plan's obligation to it and is not optional.
- **No secret is ever logged.** The RTSP credential is a `SecretRef` in `config.yaml` and a value in `/etc/yonder/secrets.yaml` at `0600`, and Task 14 asserts no captured page contains the resolved value.
- **A token carrying a unit is never uppercased** (spec §10). `Mb/s`, `kb/s`, `ms`, `fps`, `°/s` keep their case. Small caps are for labels only. This appeared three times in three components during design; it is a constraint on every component in Tasks 12–15.
- **A segmented control has a maximum width** and never stretches to its container (spec §10, R-UI-10).
- **Paths:** config `/etc/yonder/config.yaml`, secrets `/etc/yonder/secrets.yaml`, state `/var/lib/yonder/`, socket `/run/yonder/core.sock`, payload `vendor/`, mediamtx config `/etc/mediamtx/mediamtx.yml` at `0640` in a `2750 root:yonder-media` directory — **not** `/etc/yonder` at `0600`, which Task 9 proved cannot be read by the `yonder-media` user the server runs as.

---

## What already exists (on this branch)

- `src/apply/types.ts` — `Renderer` is `{ readonly name: string; render(config: Config): Promise<void> }`. `Clock` is `{ now, setTimer, clearTimer }`, injected so tests never wait on the wall clock.
- `src/apply/reachability.ts` — `affectsReachability(previous, next)`, and a private `withoutCosmetics` deleting exactly three leaves: `ui.theme`, `remote.zerotier.enabled`, `remote.zerotier.network_id`. **It deletes named leaves off a fixed object shape and has no mechanism for a repeated structure.**
- `src/apply/engine.ts` — `const BUSY: readonly ApplyState[] = ["applying", "pending", "reverting"]`. An unconfirmed apply refuses every other apply until it confirms or reverts.
- `src/net/runner.ts` — `CommandRunner = (argv: string[]) => Promise<CommandResult>`, `CommandResult = { code, stdout, stderr }`, `systemRunner`.
- `src/schema/config.ts` — `ConfigSchema` is `z.object({...}).strict()` over `version`, `network`, `ui`, `apply`, `system`, `remote`. `SecretRef = z.object({ secret: z.string().min(1) }).strict()`. `DEFAULT_CONFIG` is `ConfigSchema.parse({ version: 1, network: { ap: { psk: { secret: "ap_psk" } } }, ui: { editor: {} } })`.
- `src/secrets/store.ts` — `SecretStore#ensure(name, kind: "psk" | "password" | "token")` returns `{ value, created }` and generates once; `#resolve(ref)`; the file is written at `0600` through `writeFileDurable`.
- `src/console/theme.ts` — `Palette`, `PALETTES: Record<ThemeName, Palette>`, `themeCss(theme)`. Tones are `neutral | waiting | good | bad`, plus `irreversible`. `.yonder-tone-*` classes exist.
- `src/system/read.ts` — `FileReader = (path) => string | null`, `systemReader`, `readBoardFacts`. **There is no supply-voltage reading yet**; R-SYS-09 is unimplemented, and Task 11 is its first consumer.
- `src/daemon/routes.ts` — routes are `if (method === "..." && path === "...") { ... }` returning `{ status, body }`.
- `src/daemon/server.ts` — `buildRenderers(opts)` returns `{ renderers, renderer, consoleRenderer?, secrets, client, generated }`.
- `packages/node-red-dashboard-2-yonder/src/widget.ts` — `registerWidget(RED, { type, props, emitsActions })`, and helpers `num`, `optionalNum`, `str`, `list`. **`emitsActions` is mandatory for anything that sends:** Dashboard silently drops a `widget-action` from a widget that did not register `onAction`, and every soft key once shipped dead this way.
- `packages/node-red-dashboard-2-yonder/src/ui/tokens.css` — night-valued fallbacks for `--yonder-*`.
- `packages/node-red-contrib-yonder-network` — the contrib package to copy for structure.
- `installer/roles/40-zerotier.sh` and `installer/make-payload.sh` — the pattern Task 9 follows: fetch on a build machine against a pinned checksum and a signed index, stage into `vendor/`, install offline, leave it off until configuration says otherwise.
- `scripts/capture-pages.mjs` — the capture gate. `pagesFromFlows()` reads `flows/flows.json` and filters `n.type === "ui-page"`. **With no camera attached there is no camera page, so the gate covers none of these pages and does not complain** (spec §10). Task 16 fixes that.
- `packages/node-red-contrib-yonder-video/` — a `.gitkeep` and nothing else.
- **No contrib package shells out or holds runtime state.** All four are thin adapters over `clientFor(...)` -> `DaemonClient` -> the daemon socket, calling routes like `GET /config`. `node-red-contrib-yonder-network/src/read.ts` is the shape to copy; its `nodes.test.ts` runs them in a real Node-RED via `node-red-node-test-helper` with `clientFor` mocked, so no test opens a socket.

---

## Two decisions made while planning

Both are settled here so no task has to reopen them.

**1. There are two tees, not one.** The pipeline sketch this design inherits has a single `tee` after `h264parse` — one encode, copied. Spec §4 changes that: the browser's copy is *a second encode from the already-decoded frames*, scaled. So the graph forks **before** the encoder for the preview, and again **after** it for the two full-rate consumers. Task 6 builds that shape and the composition test asserts both.

**2. The preview's exemption is earned by its bound.** Spec §2 exempts "the preview's size and rate" from the confirmation window, while §4 establishes that everything leaving over cellular competes with the console's own path — which is an argument *against* exempting it. Both are right, and the resolution is in the schema: `preview.bitrate_kbps` is bounded at `max(2000)` and `preview.width` at `max(1280)` in Task 1, so **no reachable preview setting can saturate a link**. The exemption is safe because the range is, and Task 2's test asserts the bound rather than trusting the comment. A future task that widens the bound must move `preview` out of the exempt list in the same change; Task 2's key-set assertion is what forces that conversation.

---

## File Structure

```
packages/yonder-core/src/
├── schema/config.ts                 + Camera, CameraOutput, Preview, cameras[]   (Task 1)
├── apply/reachability.ts            + array-aware camera leaf exemption          (Task 2)
├── system/supply.ts                 vcgencmd get_throttled -> SupplyState        (Task 11)
├── system/supply.test.ts
├── media/config.ts                  pure: Config + resolved secret -> mediamtx yaml (Task 9)
├── media/config.test.ts
├── media/renderer.ts                MediaRenderer: config -> /etc/mediamtx/mediamtx.yml
├── media/renderer.test.ts
├── console/whep.ts                  authenticated proxy for the stream handshake (Task 10)
├── console/whep.test.ts
├── daemon/routes.ts                 + the camera routes                          (Task 15)
└── video/
    ├── capability.ts    the model: three states, one set, the summary line       (Task 3)
    ├── capability.test.ts
    ├── probe/
    │   ├── parse.ts     pure: v4l2-ctl output -> formats, controls, rejections   (Task 4)
    │   ├── parse.test.ts
    │   ├── camera.ts    typed probe over the injected CommandRunner
    │   ├── camera.test.ts
    │   ├── encoder.ts   R-CAM-13: which encoder this board actually has          (Task 5)
    │   ├── encoder.test.ts
    │   └── fixtures/    recorded real output, committed                          (Task 4 Step 0)
    │       ├── list-formats-ext-globalshutter.txt
    │       ├── list-ctrls-menus-globalshutter.txt
    │       ├── list-formats-out-video11.txt
    │       ├── list-formats-video10.txt    the K-40 decoder that looks like a camera
    │       └── list-devices.txt
    ├── pipeline.ts      pure: camera + capabilities -> argv                      (Task 6)
    ├── pipeline.test.ts
    ├── supervisor.ts    spawn, supervise, run state per camera (R-CTL-01)        (Task 7)
    ├── supervisor.test.ts
    ├── receive.ts       pure: four renderings of the same three facts            (Task 8)
    └── receive.test.ts

packages/node-red-contrib-yonder-video/src/       thin adapters, no logic         (Task 15)
├── red.ts               copied from the network package
├── cameras.ts           node: yonder-cameras   — detect, list, reject-with-reason
├── camera.ts            node: yonder-camera    — one camera's state and controls
├── stream.ts            node: yonder-stream    — start/stop, run state
├── receive-line.ts      node: yonder-receive-line
└── nodes.test.ts

packages/node-red-dashboard-2-yonder/src/
├── holdkey.ts / .html + ui/YonderHoldKey.vue      a soft key that is held        (Task 12)
├── picture.ts / .html + ui/YonderPicture.vue      WebRTC, degrade, age, stills   (Task 13)
├── facts.ts   / .html + ui/YonderFacts.vue        capability facts row (R-UI-15) (Task 14)
└── budget.ts  / .html + ui/YonderBudget.vue       uplink budget track (R-VID-11) (Task 14)

installer/
├── make-payload.sh                  + mediamtx, pinned and checksummed           (Task 9)
├── keys/                            (mediamtx ships checksums, not a repo key — see Task 9)
└── roles/50-mediamtx.sh             install from vendor, leave it off

scripts/
├── measure-pipeline.sh              throttle-gated measurement harness           (Task 11)
├── capture-pages.mjs                + the synthetic camera source                (Task 16)
└── fixtures/camera-globalshutter.json        checked-in capability fixture                (Task 16)

flows/flows.json                     + Cameras index page, one camera page        (Task 16)
```

**Responsibility boundaries.** `probe/parse.ts` knows `v4l2-ctl`'s output format and nothing about Yonder. `probe/camera.ts` knows which commands exist and nothing about config. `capability.ts` is the vocabulary the rest of the system speaks and has no I/O at all. `pipeline.ts` turns a camera and its capabilities into an argv and never runs one. `supervisor.ts` is the only thing that starts a process. `receive.ts` is pure text. That split is what lets almost all of this be tested on a laptop with no camera, which is also the condition CI runs in.

**Why the logic is in `yonder-core` and not in the contrib package.** The spec's §11 says `packages/node-red-contrib-yonder-video/` is where this goes, and the intent behind that sentence — not a `function` node, not markup in a `ui-template`, real source files with real tests (CLAUDE.md rule 2) — is satisfied either way, because `yonder-core` is a node package too. But the existing packages settle *which* one: **no contrib package in this repository shells out or holds runtime state.** Every one is a thin adapter over `clientFor` and the daemon socket, and the pure translation they do carry (`remote/state.ts`, `remote/format.ts`) runs no commands and owns no processes.

Three concrete reasons that is right here, rather than a convention worth following for its own sake:

- **A Node-RED redeploy destroys and recreates every node.** A `Supervisor` holding child processes inside one would drop every camera's pipeline the moment somebody edited a flow — including, on a flying aircraft, the feed a ground station is watching.
- **`receive.ts` resolves the RTSP credential** out of `/etc/yonder/secrets.yaml` at mode `0600`. Node-RED must never read that file; the daemon owns it, and the node receives finished text.
- **`MediaRenderer` is already a renderer in `yonder-core`** (Task 9) and has to agree with the supervisor about what is running. Splitting them across a socket boundary would put the two halves of one fact in two processes.

So Tasks 3–8 build `yonder-core/src/video/`, Task 15 puts daemon routes in front of it and thin nodes in front of those, and the contrib package stays the shape the other four are.

---

## Task 1: The `cameras` section of the schema

**Requirements:** R-CAM-05, R-CTL-02, R-CTL-03, R-CTL-08, R-CTL-09, R-VID-08, R-VID-13, R-SEC-13

**Files:**
- Modify: `packages/yonder-core/src/schema/config.ts`
- Modify: `packages/yonder-core/src/schema/config.test.ts`
- Modify: `config/defaults/config.yaml` (regenerated, not hand-edited)
- Modify: `schema/config.schema.json` (regenerated)

**Interfaces:**
- Consumes: nothing.
- Produces: `Config["cameras"]` as `Camera[]`, and the exported types `Camera`, `CameraOutput`, `Preview`. Every later task reads `config.cameras`.

```ts
export type Camera = {
  id: string; name: string; source: "usb"; device: string;
  enabled: boolean; autostart: boolean;
  width: number; height: number; framerate: number;
  codec: "h264"; bitrate_kbps: number;
  preview: { width: number; height: number; framerate: number; bitrate_kbps: number };
  controls: { brightness: number | null; contrast: number | null; rotation: 0 | 90 | 180 | 270 };
  outputs: CameraOutput[];
};
export type CameraOutput =
  | { kind: "rtp"; host: string; port: number }
  | { kind: "rtsp"; path: string; password: SecretRef }
  | { kind: "srt"; port: number };
```

- [ ] **Step 1: Write the failing tests**

Add to `packages/yonder-core/src/schema/config.test.ts`:

```ts
it("defaults cameras to an empty list", () => {
  const cfg = ConfigSchema.parse({
    version: 1, network: { ap: { psk: { secret: "ap_psk" } } }, ui: { editor: {} },
  });
  expect(cfg.cameras).toEqual([]);
});

it("fills a camera's defaults from its identity alone", () => {
  const cfg = ConfigSchema.parse({
    version: 1, network: { ap: { psk: { secret: "ap_psk" } } }, ui: { editor: {} },
    cameras: [{ id: "cam0", name: "Nose", source: "usb", device: "platform-fd500000.pcie-pci-0000:01:00.0-usb-0:1.3:1.0-video-index0" }],
  });
  const cam = cfg.cameras[0];
  expect(cam).toMatchObject({
    enabled: true, autostart: false,
    width: 1280, height: 720, framerate: 30,
    codec: "h264", bitrate_kbps: 2000, outputs: [],
  });
  expect(cam.preview).toEqual({ width: 640, height: 360, framerate: 15, bitrate_kbps: 400 });
  expect(cam.controls).toEqual({ brightness: null, contrast: null, rotation: 0 });
});

it("bounds the preview so no setting of it can saturate a link", () => {
  // The preview is exempt from the confirmation window (reachability.ts), and
  // that exemption is only safe because this bound exists. Widening it means
  // moving `preview` out of the exempt list in the same change.
  const base = { version: 1, network: { ap: { psk: { secret: "ap_psk" } } }, ui: { editor: {} } };
  const withPreview = (preview: unknown) =>
    ConfigSchema.safeParse({ ...base, cameras: [
      { id: "cam0", name: "Nose", source: "usb", device: "usb-1", preview },
    ] });
  expect(withPreview({ bitrate_kbps: 2000 }).success).toBe(true);
  expect(withPreview({ bitrate_kbps: 2001 }).success).toBe(false);
  expect(withPreview({ width: 1280 }).success).toBe(true);
  expect(withPreview({ width: 1281 }).success).toBe(false);
});

it("refuses two cameras with the same id", () => {
  const r = ConfigSchema.safeParse({
    version: 1, network: { ap: { psk: { secret: "ap_psk" } } }, ui: { editor: {} },
    cameras: [
      { id: "cam0", name: "A", source: "usb", device: "usb-1" },
      { id: "cam0", name: "B", source: "usb", device: "usb-2" },
    ],
  });
  expect(r.success).toBe(false);
  expect(JSON.stringify(r.error?.issues)).toContain("cam0");
});

it("refuses an output on the console's own port", () => {
  // A bind race after a reboot is a configuration that confirms while it looks
  // fine and bites on the next boot. The confirmation window never catches it,
  // because on the day it is applied nothing collides.
  const r = ConfigSchema.safeParse({
    version: 1, network: { ap: { psk: { secret: "ap_psk" } } },
    ui: { port: 3000, editor: {} },
    cameras: [{
      id: "cam0", name: "Nose", source: "usb", device: "usb-1",
      outputs: [{ kind: "srt", port: 3000 }],
    }],
  });
  expect(r.success).toBe(false);
  expect(JSON.stringify(r.error?.issues)).toContain("ui.port");
});

it("holds an RTSP password by reference, never inline", () => {
  const ok = ConfigSchema.safeParse({
    version: 1, network: { ap: { psk: { secret: "ap_psk" } } }, ui: { editor: {} },
    cameras: [{
      id: "cam0", name: "Nose", source: "usb", device: "usb-1",
      outputs: [{ kind: "rtsp", path: "cam0", password: { secret: "rtsp_password" } }],
    }],
  });
  expect(ok.success).toBe(true);
  const inline = ConfigSchema.safeParse({
    version: 1, network: { ap: { psk: { secret: "ap_psk" } } }, ui: { editor: {} },
    cameras: [{
      id: "cam0", name: "Nose", source: "usb", device: "usb-1",
      outputs: [{ kind: "rtsp", path: "cam0", password: "hunter2" }],
    }],
  });
  expect(inline.success).toBe(false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w yonder-core -- src/schema/config.test.ts`
Expected: FAIL — `cfg.cameras` is `undefined`, and `.strict()` rejects the unknown `cameras` key.

- [ ] **Step 3: Add the section to the schema**

In `packages/yonder-core/src/schema/config.ts`, above `ConfigSchema`:

```ts
/**
 * A camera's identity, source and settings.
 *
 * **The device is held by port, not by enumeration number** (R-CAM-05).
 * `/dev/video0` is whichever camera the kernel probed first this boot. The
 * `by-path` name — `platform-fd500000.pcie-pci-0000:01:00.0-usb-0:1.3:1.0-video-index0`
 * — is the socket it is plugged into, so the configured camera is the detected
 * one after a reboot and after a plug-order change. `probe/bypath.ts` resolves
 * it to a node at run time.
 *
 * **Not the bus id.** `v4l2-ctl --list-devices` prints `usb-0000:01:00.0-1.3`
 * in parentheses after the card name, which looks like an answer and is a
 * different identifier: nothing in `/dev/v4l/by-path/` is named that, so a
 * configuration holding it resolves to nothing and the operator gets a
 * gstreamer failure with no explanation. Task 6's `refuse()` is what turns
 * that into a sentence.
 *
 * **What is not here.** No capability is stored: R-CAM-14 requires formats,
 * rates and controls to come from what the device answers, and a stored copy
 * is a stale copy the first time a lens or a firmware changes. This section
 * holds what an operator *chose*; `capability.ts` holds what the camera
 * *offers*, and only one of those belongs in a file.
 */
const CameraId = z.string().regex(
  /^[a-z0-9][a-z0-9-]{0,31}$/,
  "must be lower-case letters, digits and hyphens, starting with a letter or digit",
);

/**
 * Where a stream goes.
 *
 * `rtp` is an outbound push to a ground station: no listener, nothing to
 * protect (R-VID-01). `rtsp` and `srt` are listeners on this device, so
 * R-SEC-13 applies — the RTSP path carries a generated per-device credential
 * held by reference, exactly as the access point's passphrase is.
 */
const CameraOutput = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("rtp"),
    host: z.string().regex(IPV4_PATTERN, "must be an IPv4 address, for example 192.168.1.50"),
    port,
  }).strict(),
  z.object({
    kind: z.literal("rtsp"),
    path: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
    password: SecretRef,
  }).strict(),
  z.object({ kind: z.literal("srt"), port }).strict(),
]);
export type CameraOutput = z.infer<typeof CameraOutput>;

/**
 * The cheap copy the interface watches (R-VID-13).
 *
 * **Bounded deliberately, and the bound is load-bearing.** `reachability.ts`
 * exempts this object from the confirmation window on the grounds that no
 * setting of it changes what leaves the aircraft on a path the console shares
 * — which is only true while the ceiling here is small enough that it cannot.
 * Raising either bound means moving `preview` out of that exemption in the
 * same change; `reachability.test.ts` asserts the numbers so the two cannot
 * drift apart quietly.
 */
const Preview = z.object({
  width: z.number().int().min(160).max(1280).default(640),
  height: z.number().int().min(90).max(720).default(360),
  framerate: z.number().int().min(1).max(30).default(15),
  bitrate_kbps: z.number().int().min(100).max(2000).default(400),
}).strict();

/** Image controls: applied live on the running stream, never a respawn. */
const CameraControls = z.object({
  brightness: z.number().int().min(-100).max(100).nullable().default(null),
  contrast: z.number().int().min(-100).max(100).nullable().default(null),
  /** R-CTL-05: by degrees rather than a boolean. */
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).default(0),
}).strict();

const Camera = z.object({
  id: CameraId,
  name: z.string().min(1).max(48),
  /** M6 adds `csi` and `hdmi`; M5 adds the accessory camera. One today. */
  source: z.enum(["usb"]),
  /** A `by-path` name, without the `/dev/v4l/by-path/` prefix. See above. */
  device: z.string().min(1).max(128),
  enabled: z.boolean().default(true),
  /**
   * Whether the pipeline starts at boot.
   *
   * Off by default and deliberately: R-MAV-08 autocasts telemetry because a
   * quiet aircraft is unflyable, and video has no equivalent claim. The
   * asymmetry is recorded in the spec's §12 as an unmade decision rather than
   * settled here.
   */
  autostart: z.boolean().default(false),
  width: z.number().int().min(160).max(3840).default(1280),
  height: z.number().int().min(90).max(2160).default(720),
  framerate: z.number().int().min(1).max(60).default(30),
  codec: z.enum(["h264"]).default("h264"),
  bitrate_kbps: z.number().int().min(100).max(20000).default(2000),
  preview: Preview.default({}),
  controls: CameraControls.default({}),
  outputs: z.array(CameraOutput).max(8).default([]),
}).strict();
export type Camera = z.infer<typeof Camera>;
```

Then add `cameras: z.array(Camera).max(8).default([])` to `ConfigSchema`, and attach the two cross-field checks with `.superRefine` on the **root** object — `ui.port` is not visible from inside `Camera`:

```ts
export const ConfigSchema = z.object({
  version: z.literal(1),
  network: Network,
  ui: Ui,
  apply: Apply.default({}),
  system: System.default({}),
  remote: Remote.default({}),
  cameras: z.array(Camera).max(8).default([]),
}).strict().superRefine((cfg, ctx) => {
  const seen = new Set<string>();
  for (const [i, cam] of cfg.cameras.entries()) {
    if (seen.has(cam.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cameras", i, "id"],
        message: `two cameras share the id "${cam.id}"; each camera needs its own`,
      });
    }
    seen.add(cam.id);
    for (const [j, out] of cam.outputs.entries()) {
      // The class of fault a confirmation window never catches: today's
      // port-carrying outputs are UDP against a TCP console so nothing
      // collides, and the apply confirms. The bind race happens on the next
      // boot, by which time nobody is watching a countdown.
      if ("port" in out && out.port === cfg.ui.port) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cameras", i, "outputs", j, "port"],
          message: `port ${out.port} is ui.port; the console and a stream cannot share one`,
        });
      }
    }
  }
});
```

**`DEFAULT_CONFIG` needs no change** — `cameras` defaults to `[]`, and a fresh device has no camera configured until one is detected.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w yonder-core -- src/schema/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Regenerate the published schema and the shipped default**

```bash
npm run defaults -w yonder-core && npm run schema -w yonder-core
```

Then run the full suite — `roundtrip.test.ts`, `schema/generate.test.ts` and `docs.test.ts` all read these files:

Run: `npm test -w yonder-core`
Expected: PASS. If `docs.test.ts` fails, `docs/configuration.md` needs the `cameras` section documented — add it, keyed the same way the `remote` section is.

- [ ] **Step 6: Commit**

```bash
git add packages/yonder-core/src/schema/ config/defaults/config.yaml schema/ docs/configuration.md
git commit -s -m "feat(schema): a cameras section, bounded so its preview cannot cost reachability

R-CAM-05 holds the device by port rather than by enumeration number, so the
configured camera is the detected one after a reboot. No capability is stored:
R-CAM-14 requires them read from the device, and a stored copy goes stale on
the first firmware change.

Two refusals the confirmation window would never catch: two cameras sharing an
id, and an output bound to ui.port — which collides on the next boot rather
than on the apply anybody is watching.

Refs: R-CAM-05, R-CTL-02, R-CTL-03, R-CTL-05, R-CTL-08, R-CTL-09, R-VID-08,
R-VID-13, R-SEC-13

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: An array-aware leaf exemption, so a camera apply does not lock the aircraft out

**Requirements:** R-CFG-03, R-NET-07, R-VPN-07 (the rule that an exemption is earned), R-CTL-02, R-CTL-03

**Files:**
- Modify: `packages/yonder-core/src/apply/reachability.ts`
- Modify: `packages/yonder-core/src/apply/reachability.test.ts`

**Interfaces:**
- Consumes: `Config["cameras"]` from Task 1.
- Produces: exports `CAMERA_EXEMPT_LEAVES: readonly string[]` and `CAMERA_LEAVES: readonly string[]` for the tests and for Task 16's Setup deck, which draws a countdown only where one will actually arm.

**Why this task exists, in one paragraph.** `withoutCosmetics()` compares the whole document with the parts that cannot affect reachability removed — everything is load-bearing until proven otherwise. So **a `cameras:` section falls through to load-bearing on its first commit**, and every Setup apply would arm the 120 s window on a page drawing neither a countdown nor a confirm control; the settings would revert two minutes later with nothing able to confirm them. That is K-32 replayed on the camera page. And `BUSY` includes `pending`, so an unconfirmed camera apply refuses **every other apply for two minutes, a network change included** — which on a flying aircraft is the wrong thing to be locked out of. That is the argument for keeping the exempt set as wide as the measurements honestly allow, and no wider.

- [ ] **Step 1: Write the failing tests**

Add to `packages/yonder-core/src/apply/reachability.test.ts`:

```ts
import { affectsReachability, CAMERA_EXEMPT_LEAVES, CAMERA_LEAVES } from "./reachability.js";
import { ConfigSchema, type Config } from "../schema/config.js";

const CAMERA = {
  id: "cam0", name: "Nose", source: "usb" as const, device: "platform-fd500000.pcie-pci-0000:01:00.0-usb-0:1.3:1.0-video-index0",
};
function withCamera(overrides: Record<string, unknown> = {}): Config {
  return ConfigSchema.parse({
    version: 1, network: { ap: { psk: { secret: "ap_psk" } } }, ui: { editor: {} },
    cameras: [{ ...CAMERA, ...overrides }],
  });
}

describe("camera leaves", () => {
  it("exempts resolution, rate, codec, preview and image controls", () => {
    const before = withCamera();
    expect(affectsReachability(before, withCamera({ width: 1920, height: 1080 }))).toBe(false);
    expect(affectsReachability(before, withCamera({ framerate: 15 }))).toBe(false);
    expect(affectsReachability(before, withCamera({ codec: "h264" }))).toBe(false);
    expect(affectsReachability(before, withCamera({ preview: { width: 320, bitrate_kbps: 200 } }))).toBe(false);
    expect(affectsReachability(before, withCamera({ controls: { brightness: 20 } }))).toBe(false);
  });

  it("keeps bitrate and outputs load-bearing — they are egress on the console's own path", () => {
    const before = withCamera();
    expect(affectsReachability(before, withCamera({ bitrate_kbps: 8000 }))).toBe(true);
    expect(affectsReachability(before, withCamera({
      outputs: [{ kind: "rtp", host: "192.168.1.50", port: 5600 }],
    }))).toBe(true);
  });

  it("keeps adding and removing a camera load-bearing", () => {
    const none = ConfigSchema.parse({
      version: 1, network: { ap: { psk: { secret: "ap_psk" } } }, ui: { editor: {} },
    });
    expect(affectsReachability(none, withCamera())).toBe(true);
  });

  it("keeps identity, device, enabled and autostart load-bearing", () => {
    const before = withCamera();
    expect(affectsReachability(before, withCamera({ name: "Tail" }))).toBe(true);
    expect(affectsReachability(before, withCamera({ device: "platform-fd500000.pcie-pci-0000:01:00.0-usb-0:1.3:1.0-video-index0" }))).toBe(true);
    expect(affectsReachability(before, withCamera({ enabled: false }))).toBe(true);
    expect(affectsReachability(before, withCamera({ autostart: true }))).toBe(true);
  });

  // The K-32 prevention, and the whole reason this file lists leaves rather
  // than subtrees. A field added to Camera next year is load-bearing by
  // default — which is right — but nobody would have *decided* that. This
  // fails the moment the shape changes, and the fix is to add the new key to
  // one of the two lists on purpose.
  it("forces a decision when the camera schema grows a field", () => {
    expect([...CAMERA_LEAVES].sort()).toEqual([
      "autostart", "bitrate_kbps", "codec", "controls", "device", "enabled",
      "framerate", "height", "id", "name", "outputs", "preview", "source", "width",
    ]);
    expect(Object.keys(withCamera().cameras[0]).sort()).toEqual([...CAMERA_LEAVES].sort());
    expect([...CAMERA_EXEMPT_LEAVES].sort()).toEqual([
      "codec", "controls", "framerate", "height", "preview", "width",
    ]);
  });

  // The preview's exemption is earned by its bound, not by argument. If the
  // ceiling moves, this fails and `preview` has to leave the exempt list.
  it("holds the preview to the bound its exemption rests on", () => {
    const tooFast = ConfigSchema.safeParse({
      version: 1, network: { ap: { psk: { secret: "ap_psk" } } }, ui: { editor: {} },
      cameras: [{ ...CAMERA, preview: { bitrate_kbps: 2001 } }],
    });
    expect(tooFast.success).toBe(false);
  });

  it("refuses a subtree exemption for cameras", () => {
    // `delete copy.cameras` would hand the exemption to every field added
    // later, with nobody deciding it should have one. The proof it was not
    // done that way: a load-bearing leaf still registers.
    expect(affectsReachability(withCamera(), withCamera({ bitrate_kbps: 3000 }))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w yonder-core -- src/apply/reachability.test.ts`
Expected: FAIL — `CAMERA_EXEMPT_LEAVES` is not exported, and every "exempts" assertion returns `true`.

- [ ] **Step 3: Add the exemption**

In `packages/yonder-core/src/apply/reachability.ts`:

```ts
/**
 * Every key on a camera. Not derived — written down, so that adding a field to
 * the schema fails a test rather than silently acquiring a default.
 */
export const CAMERA_LEAVES = [
  "id", "name", "source", "device", "enabled", "autostart",
  "width", "height", "framerate", "codec", "bitrate_kbps",
  "preview", "controls", "outputs",
] as const;

/**
 * The camera leaves that cannot cost the operator their way back to the
 * device.
 *
 * The test for membership is not "is this cosmetic" but **"does changing this
 * alter what leaves the aircraft on the path the console is standing on"**.
 * The console reaches a flying aircraft over the same cellular uplink the
 * video leaves by, so an added output or a raised ceiling is spend on that
 * path — and nobody has yet measured what a saturated uplink does to a console
 * session on a board. R-VPN-07 requires an exemption to be earned by
 * measurement rather than by argument, so `bitrate_kbps` and `outputs` stay
 * load-bearing until somebody measures.
 *
 * `preview` is the one entry here that *is* egress on that path, and it is
 * exempt because the schema bounds it: `max(2000)` kb/s and `max(1280)` px
 * mean no reachable setting of it can saturate a link. The exemption is safe
 * because the range is. Widening either bound means removing `preview` from
 * this list in the same change — `reachability.test.ts` asserts the bound so
 * the two cannot drift apart quietly.
 *
 * Everything absent falls through to load-bearing, which is this file's whole
 * design: `id`, `name`, `device`, `enabled` and `autostart` all change what
 * the aircraft is doing or which hardware it is doing it with.
 */
export const CAMERA_EXEMPT_LEAVES = [
  "width", "height", "framerate", "codec", "preview", "controls",
] as const;
```

Then, inside `withoutCosmetics`, after the ZeroTier block:

```ts
  // Named leaf by leaf, on each element, for the reason the ZeroTier note
  // above gives: `delete copy.cameras` would hand the exemption to every
  // field added under a camera later, with nobody deciding it should have
  // one and nothing in this file changing for a reviewer to look at.
  //
  // The array itself stays. Adding a camera, removing one, or reordering the
  // list is load-bearing: each is a different set of pipelines running on the
  // aircraft, and the count is what the uplink is shared between.
  for (const camera of (copy as { cameras?: Record<string, unknown>[] }).cameras ?? []) {
    for (const leaf of CAMERA_EXEMPT_LEAVES) delete camera[leaf];
  }
```

and widen the local type on `copy` to carry `cameras?: Record<string, unknown>[]`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w yonder-core -- src/apply/reachability.test.ts`
Expected: PASS, all eight cases.

- [ ] **Step 5: Run the whole apply suite**

Run: `npm test -w yonder-core -- src/apply/`
Expected: PASS. `engine.test.ts` must be unaffected: nothing about the state machine changed.

- [ ] **Step 6: Commit**

```bash
git add packages/yonder-core/src/apply/
git commit -s -m "feat(apply): camera leaves exempted one by one, never by subtree

A cameras: section falls through to load-bearing on its first commit, so every
Setup apply would arm the 120 s window on a page drawing no countdown and no
confirm control, and revert two minutes later. K-32 replayed on the camera
page. BUSY includes pending, so it would also refuse a network change for
those two minutes — on a flying aircraft, the wrong thing to be locked out of.

Exempt: width, height, framerate, codec, preview, controls. Load-bearing:
bitrate and every entry in outputs[], because both are egress on the same
uplink the console reaches the aircraft over, and nobody has measured what a
saturated uplink does to a console session. R-VPN-07: earned by measurement,
not by argument.

The preview is exempt because the schema bounds it at 2000 kb/s and 1280 px.
Widening either bound means removing it from the list in the same change; the
test asserts the numbers so they cannot drift apart quietly.

Refs: R-CFG-03, R-NET-07, R-VPN-07

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: The capability model

**Requirements:** R-CAM-14, R-UI-15

**Files:**
- Create: `packages/yonder-core/src/video/capability.ts`
- Test: `packages/yonder-core/src/video/capability.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the vocabulary every later task speaks.

```ts
export type Capability<T> =
  | { readonly state: "present"; readonly value: T }
  | { readonly state: "not-offered" }
  | { readonly state: "advertised"; readonly reason: string };
export function present<T>(value: T): Capability<T>;
export function notOffered<T>(): Capability<T>;
export function advertised<T>(reason: string): Capability<T>;
export interface VideoFormat { fourcc: string; width: number; height: number; rates: number[] }
export interface ControlRange { min: number; max: number; step: number; default: number; current: number }
export interface CameraCapabilities { formats; zoom; focus; exposure; whiteBalance; brightness; contrast; aim; recording; stills }
export function summarise(caps: CameraCapabilities): string;
export const CAPABILITY_KEYS: readonly (keyof CameraCapabilities)[];
```

- [ ] **Step 1: Write the failing test**

`packages/yonder-core/src/video/capability.test.ts`:

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
  present, notOffered, advertised, summarise, CAPABILITY_KEYS,
  type CameraCapabilities,
} from "./capability.js";

const FIXED: CameraCapabilities = {
  formats: present([{ fourcc: "MJPG", width: 1280, height: 720, rates: [30] }]),
  zoom: notOffered(), focus: notOffered(), exposure: notOffered(),
  whiteBalance: notOffered(), brightness: notOffered(), contrast: notOffered(),
  aim: notOffered(), recording: notOffered(), stills: notOffered(),
};

describe("the three states", () => {
  it("narrows on state, so a value cannot be read off a capability that has none", () => {
    const z = notOffered<number>();
    // @ts-expect-error — there is no `value` on a capability that is not offered
    void z.value;
    const p = present(3);
    expect(p.state === "present" && p.value).toBe(3);
  });

  it("makes an advertised capability carry its reason", () => {
    const a = advertised<number>("acknowledged at fifteen values; the frame stayed 1280x720");
    expect(a.state).toBe("advertised");
    expect(a.state === "advertised" && a.reason).toContain("1280x720");
  });
});

describe("summarise", () => {
  // The Cameras index page's one line per camera (spec section 5). It explains
  // why a camera's page has no Aim group before anyone goes looking for one.
  it("names every capability, so nothing is silently missing", () => {
    const line = summarise(FIXED);
    for (const key of CAPABILITY_KEYS) expect(line).toContain(key);
  });

  it("reads as facts, not as a list of blanks", () => {
    expect(summarise(FIXED)).toBe(
      "formats: 1 · zoom: none · focus: none · exposure: none · whiteBalance: none · " +
      "brightness: none · contrast: none · aim: none · recording: none · stills: none",
    );
  });

  it("marks an advertised capability apart from an absent one", () => {
    const line = summarise({ ...FIXED, zoom: advertised("accepted, does not reshape the feed") });
    expect(line).toContain("zoom: unanswered");
    expect(line).not.toContain("zoom: none");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w yonder-core -- src/video/capability.test.ts`
Expected: FAIL — `./capability.js` does not exist.

- [ ] **Step 3: Write the model**

`packages/yonder-core/src/video/capability.ts`:

```ts
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * What a camera can do, as the camera answered it (R-CAM-14).
 *
 * The cameras this project supports really are different — one has a gimbal
 * and its own card, three have neither — but none of those differences is a
 * *kind of page*. Every one is a different set of answers to the same
 * questions, so a camera is an identity, a source and this, and the page is
 * generated from it. The consequence that matters: a zoom control looks and
 * behaves identically whether it is a sensor crop, a UVC control, or a
 * protocol message answered by cropping at the receiver.
 *
 * **Three states, and the middle one is the reason this is a union rather
 * than an optional.**
 *
 * - `present` — the device answered and the control works.
 * - `not-offered` — the device does not have it. The page states this as a
 *   fact where the control would have been: one row of text, never a control
 *   that cannot be used and never silently nothing (R-UI-15).
 * - `advertised` — the device lists it, accepts the command, and does
 *   nothing. **This is a fault, not a feature the camera lacks**, and it
 *   carries its reason. It is the state most likely to be got wrong in code,
 *   because on the wire it is indistinguishable from success: the accessory
 *   camera's live-view resolution was tried at fifteen values across three
 *   payload widths and every one was acknowledged while the frame stayed
 *   1280x720.
 *
 * A discriminated union rather than `{ value?: T }` because the compiler is
 * then the thing that stops a caller reading a value off a capability that has
 * none — which is the whole failure this vocabulary exists to prevent.
 *
 * **The field names are chosen to map onto MAVLink's `CAMERA_CAP_FLAGS`
 * without a translation layer.** `CAMERA_INFORMATION` carries a capability
 * flagset, which is the same idea this arrived at independently, and R-VID-12
 * in M7 turns these into bits: `zoom` -> HAS_BASIC_ZOOM, `focus` ->
 * HAS_BASIC_FOCUS, `recording` -> CAPTURE_VIDEO, `stills` -> CAPTURE_IMAGE,
 * `formats` -> HAS_VIDEO_STREAM. No numeric value is written here: M7 reads
 * them from the dialect it links against rather than from a copy in this file
 * that could drift from it.
 */
export type Capability<T> =
  | { readonly state: "present"; readonly value: T }
  | { readonly state: "not-offered" }
  | { readonly state: "advertised"; readonly reason: string };

export function present<T>(value: T): Capability<T> {
  return { state: "present", value };
}
export function notOffered<T>(): Capability<T> {
  return { state: "not-offered" };
}
/** `reason` is shown on the inoperative control, so write it for an operator. */
export function advertised<T>(reason: string): Capability<T> {
  return { state: "advertised", reason };
}

/** One capture mode the device offered: a pixel format, a size and its rates. */
export interface VideoFormat {
  readonly fourcc: string;
  readonly width: number;
  readonly height: number;
  /** Frames per second, largest first. */
  readonly rates: readonly number[];
}

/** A V4L2 control's range, as the device reported it (R-CTL-10). */
export interface ControlRange {
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly default: number;
  /** What the device says it is *now* — never what was last sent. */
  readonly current: number;
}

/** What a gimbal can reach. M5 fills it; M4 always reports `not-offered`. */
export interface AimCapability {
  readonly pitch: { readonly min: number | null; readonly max: number | null };
  readonly yaw: { readonly min: number | null; readonly max: number | null };
  /** The work mode the envelope was learned in; an envelope is per mode. */
  readonly mode: string;
}

/** Where a recording lands. M5 fills it. */
export interface RecordingCapability {
  readonly medium: "camera" | "board";
}

/** Where a still comes from, and therefore whether Yonder can show it. */
export interface StillsCapability {
  readonly source: "camera" | "pipeline";
}

export interface CameraCapabilities {
  readonly formats: Capability<readonly VideoFormat[]>;
  readonly zoom: Capability<ControlRange>;
  readonly focus: Capability<ControlRange>;
  readonly exposure: Capability<ControlRange>;
  readonly whiteBalance: Capability<ControlRange>;
  readonly brightness: Capability<ControlRange>;
  readonly contrast: Capability<ControlRange>;
  readonly aim: Capability<AimCapability>;
  readonly recording: Capability<RecordingCapability>;
  readonly stills: Capability<StillsCapability>;
}

/**
 * Written down rather than derived, so that adding a capability fails a test
 * instead of quietly not appearing on the page it was added for.
 */
export const CAPABILITY_KEYS = [
  "formats", "zoom", "focus", "exposure", "whiteBalance",
  "brightness", "contrast", "aim", "recording", "stills",
] as const satisfies readonly (keyof CameraCapabilities)[];

/** A camera with nothing answered. The base every probe builds on. */
export function noCapabilities(): CameraCapabilities {
  return {
    formats: notOffered(), zoom: notOffered(), focus: notOffered(),
    exposure: notOffered(), whiteBalance: notOffered(), brightness: notOffered(),
    contrast: notOffered(), aim: notOffered(), recording: notOffered(),
    stills: notOffered(),
  };
}

/**
 * One line per camera for the Cameras index page (spec section 5).
 *
 * `aim: none · zoom: none` explains why that camera's page has no Aim group
 * before anyone goes looking for one — which is R-UI-15 applied a level up
 * from the page it governs.
 */
export function summarise(caps: CameraCapabilities): string {
  return CAPABILITY_KEYS.map((key) => {
    const cap = caps[key] as Capability<unknown>;
    if (cap.state === "not-offered") return `${key}: none`;
    if (cap.state === "advertised") return `${key}: unanswered`;
    if (key === "formats") return `${key}: ${(cap.value as readonly unknown[]).length}`;
    return `${key}: yes`;
  }).join(" · ");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w yonder-core -- src/video/capability.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/yonder-core/src/video/
git commit -s -m "feat(video): a camera is a capability set, in three states

R-CAM-14 requires a camera's formats, rates and controls to come from what the
device answers. This is the vocabulary: present, not-offered, and
advertised-but-not-answered — a discriminated union rather than an optional
value, so the compiler stops a caller reading a value off a capability that
has none.

The middle state is the one that matters. On the wire it is indistinguishable
from success: fifteen live-view resolutions across three payload widths were
all acknowledged while the frame stayed 1280x720. So it keeps its control,
drawn inoperative, carrying the reason (R-UI-15).

Field names map onto MAVLink CAMERA_CAP_FLAGS without a translation layer.
No numeric value is written here — M7 reads them from its dialect.

Refs: R-CAM-14, R-UI-15

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: Probing a camera

**Requirements:** R-CAM-02, R-CAM-05, R-CAM-12, R-CAM-14, R-CTL-04, R-CTL-10

**Files:**
- Create: `packages/yonder-core/src/video/probe/parse.ts`
- Create: `packages/yonder-core/src/video/probe/camera.ts`
- Create: `packages/yonder-core/src/video/probe/fixtures/*.txt`
- Test: `packages/yonder-core/src/video/probe/parse.test.ts`, `probe/camera.test.ts`

**Interfaces:**
- Consumes: `Capability`, `VideoFormat`, `ControlRange`, `noCapabilities` (Task 3); `CommandRunner` from `yonder-core`.
- Produces:

```ts
export function parseFormats(stdout: string): VideoFormat[];
export function parseControls(stdout: string): Map<string, ControlRange>;
export function parseDevices(stdout: string): { card: string; nodes: string[] }[];
export type Rejection = { device: string; card: string; reason: string };
export type Detection = { device: string; card: string; byPath: string; capabilities: CameraCapabilities };
export interface DetectResult { found: Detection[]; rejected: Rejection[] }
export function detectCameras(opts?: { runner?: CommandRunner; readLink?: (p: string) => string | null }): Promise<DetectResult>;
export function probeCamera(byPath: string, opts?): Promise<Detection | Rejection>;
```

- [ ] **Step 0: Capture the fixtures from the board — this is not optional**

**No `v4l2-ctl` output exists anywhere in this repository.** The hardware note gives the commands; nobody has recorded an answer. Writing a parser against remembered format is how this task fails silently.

On the development board, with the USB camera attached. **Its address moves between networks** — the controller dispatching this task supplies the current one; do not hardcode it here or in any committed file.

```bash
B=yonder@<address the controller gave you>
F=packages/yonder-core/src/video/probe/fixtures
mkdir -p "$F"
ssh $B 'v4l2-ctl --list-devices'                        > "$F/list-devices.txt"
ssh $B 'v4l2-ctl -d /dev/video0 --list-formats-ext'     > "$F/list-formats-ext-globalshutter.txt"
ssh $B 'v4l2-ctl -d /dev/video0 --list-ctrls-menus'     > "$F/list-ctrls-menus-globalshutter.txt"
ssh $B 'v4l2-ctl -d /dev/video1 --list-formats-ext'     > "$F/list-formats-ext-video1.txt"
ssh $B 'v4l2-ctl -d /dev/video10 --list-formats'        > "$F/list-formats-video10.txt"
ssh $B 'v4l2-ctl -d /dev/video11 --list-formats-out'    > "$F/list-formats-out-video11.txt"
ssh $B 'v4l2-ctl -d /dev/video19 --list-formats-ext'    > "$F/list-formats-ext-video19.txt"
ssh $B 'ls -l /dev/v4l/by-path/'                        > "$F/by-path.txt"
```

`/dev/video1` and `/dev/video19` are in that list because of what the board actually reports — see Step 0b.

**Commit them in this task**, exactly as `remote/zerotier/fixtures/` holds recorded ZeroTier output. If the board is unreachable, stop and say so — do not proceed to Step 1.

- [ ] **Step 0b: read what the board actually reports, because it changes two rules**

`v4l2-ctl --list-devices` on this board returns **five cards, sixteen nodes**, and only one of them is a camera:

```
bcm2835-codec-decode (platform:bcm2835-codec):   /dev/video10 …12, 18, 31
bcm2835-isp (platform:bcm2835-isp):              /dev/video13 …16, 20 …23
rpi-hevc-dec (platform:rpi-hevc-dec):            /dev/video19
Global Shutter Camera: Global S (usb-0000:01:00.0-1.3):  /dev/video0, /dev/video1
bcm2835-codec (vchiq:bcm2835-codec):             (media node only)
```

Two things follow, and both are corrections to what this task would otherwise have built:

1. **`rpi-hevc-dec` matches neither `codec` nor `decoder` nor `isp`.** A card pattern of `/codec|decoder|isp/i` lets `/dev/video19` through to format probing. It happens to be caught by the compressed-format check — it offers only raw `Nc12`/`NC12` planes — but the reason an operator would then read is *"this camera offers only raw frames"*, which invites them to go looking for a camera setting on a hardware HEVC decoder. **The pattern is `/codec|decode|encode|isp|hevc/i`.**

2. **The real camera owns two nodes, and the second offers nothing.** `/dev/video1` answers `Type: Video Capture` with no formats beneath it — it is the metadata node every UVC camera has. Probing it node-by-node produces a rejection row sitting beside the camera that was just found, which on the Cameras page reads as *something went wrong with your camera* when nothing did. **So a card yields at most one row: if any node under it was accepted, its siblings are not rejections.** R-UI-15 is about capabilities on a camera's page, not about every `/dev` node the kernel created.

The camera itself answers `MJPG` at 1920×1080, 1920×1200 and 1600×1200, at 90, 60, 30, 25, 20, 15, 10 and 5 fps — so the rate parser's *parenthesised figure, not 1/interval* rule has real output to prove itself against, and `refuse()` in Task 6 has a real list of offered modes. Its `by-path` is `usb-0000:01:00.0-1.3`.

- [ ] **Step 1: Write the failing parser tests**

`packages/yonder-core/src/video/probe/parse.test.ts`. **Write the expectations from the fixture you captured**, not from this plan — the plan cannot know your camera. The shape:

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFormats, parseControls, parseDevices } from "./parse.js";

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");

describe("parseFormats", () => {
  const formats = parseFormats(fixture("list-formats-ext-globalshutter.txt"));

  it("reads every discrete size under every pixel format", () => {
    // Replace with the counts your fixture actually contains.
    expect(formats.length).toBeGreaterThan(0);
    expect(new Set(formats.map((f) => f.fourcc))).toContain("MJPG");
  });

  it("keeps rates largest first, so a picker's first entry is the best one", () => {
    for (const f of formats) {
      expect([...f.rates]).toEqual([...f.rates].sort((a, b) => b - a));
    }
  });

  it("converts an interval to a rate, not the other way round", () => {
    // v4l2-ctl prints "Interval: Discrete 0.033s (30.000 fps)". The rate is
    // the parenthesised figure; deriving 1/0.033 gives 30.3 and a picker that
    // offers a rate the camera never named.
    const mjpg = formats.filter((f) => f.fourcc === "MJPG");
    for (const f of mjpg) for (const r of f.rates) expect(Number.isInteger(r)).toBe(true);
  });

  it("returns an empty list rather than throwing on output it cannot read", () => {
    expect(parseFormats("")).toEqual([]);
    expect(parseFormats("VIDIOC_ENUM_FMT: failed: Inappropriate ioctl for device")).toEqual([]);
  });
});

describe("parseControls", () => {
  const controls = parseControls(fixture("list-ctrls-menus-globalshutter.txt"));

  it("reads a range control's bounds and its current value", () => {
    const b = controls.get("brightness");
    expect(b).toBeDefined();
    expect(b!.min).toBeLessThan(b!.max);
    expect(b!.step).toBeGreaterThan(0);
  });

  it("reads the current value from the device, never the default", () => {
    // R-CTL-10: a control shows what the camera reports, not what was sent.
    // v4l2-ctl prints `value=` for the reading and `default=` for the factory
    // setting, and they differ on any camera anyone has touched.
    for (const range of controls.values()) {
      expect(Number.isFinite(range.current)).toBe(true);
    }
  });

  it("returns an empty map rather than throwing on unreadable output", () => {
    expect(parseControls("").size).toBe(0);
  });
});

describe("parseDevices", () => {
  it("groups every node under the card that owns it", () => {
    const devices = parseDevices(fixture("list-devices.txt"));
    expect(devices.length).toBeGreaterThan(0);
    for (const d of devices) {
      expect(d.card).not.toBe("");
      expect(d.nodes.every((n) => n.startsWith("/dev/"))).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -w yonder-core -- src/video/probe/parse.test.ts`
Expected: FAIL — `./parse.js` does not exist.

- [ ] **Step 3: Write the parser**

`packages/yonder-core/src/video/probe/parse.ts`. Three pure functions over the fixture text, and **nothing here throws** — R-CAM-12 renders a rejection with a reason, and an exception is not a reason.

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
import type { ControlRange, VideoFormat } from "../capability.js";

/**
 * `v4l2-ctl` output, parsed.
 *
 * **Nothing in this file throws.** R-CAM-12 asks for what was found, what was
 * rejected, and why — so a device that answers nothing is an empty list and a
 * reason, never an exception. A probe that threw would take the Cameras page
 * down with the one camera it could not read.
 *
 * The formats these regexes match were recorded off a board and committed
 * beside this file. Do not adjust them against remembered output; adjust the
 * fixture, from the board, and let the test tell you what changed.
 */

const FORMAT_LINE = /^\s*\[\d+\]:\s*'(\w{4})'/;
const SIZE_LINE = /^\s*Size:\s*Discrete\s+(\d+)x(\d+)/;
const INTERVAL_LINE = /\(([\d.]+)\s*fps\)/;

export function parseFormats(stdout: string): VideoFormat[] {
  const out: VideoFormat[] = [];
  let fourcc: string | null = null;
  let pending: { width: number; height: number; rates: number[] } | null = null;

  const flush = (): void => {
    if (fourcc === null || pending === null) return;
    out.push({
      fourcc,
      width: pending.width,
      height: pending.height,
      // Largest first, so a picker's first entry is the best the camera offers.
      rates: [...new Set(pending.rates)].sort((a, b) => b - a),
    });
    pending = null;
  };

  for (const line of stdout.split("\n")) {
    const format = FORMAT_LINE.exec(line);
    if (format) { flush(); fourcc = format[1]; continue; }
    const size = SIZE_LINE.exec(line);
    if (size) {
      flush();
      pending = { width: Number(size[1]), height: Number(size[2]), rates: [] };
      continue;
    }
    const interval = INTERVAL_LINE.exec(line);
    // The parenthesised figure, not 1/interval: `Interval: Discrete 0.033s
    // (30.000 fps)` derives 30.3 the other way, and a picker then offers a
    // rate the camera never named.
    if (interval && pending) pending.rates.push(Math.round(Number(interval[1])));
  }
  flush();
  return out;
}

const CONTROL_LINE =
  /^\s*(\w+)\s+0x[0-9a-f]+\s+\((?:int|menu|bool)\)\s*:\s*(.*)$/;

export function parseControls(stdout: string): Map<string, ControlRange> {
  const out = new Map<string, ControlRange>();
  for (const line of stdout.split("\n")) {
    const m = CONTROL_LINE.exec(line);
    if (!m) continue;
    const [, name, rest] = m;
    const field = (key: string): number | null => {
      const f = new RegExp(`\\b${key}=(-?\\d+)`).exec(rest);
      return f ? Number(f[1]) : null;
    };
    // `value=` is what the device reports now; `default=` is the factory
    // setting. R-CTL-10 wants the reading, and a control that showed the
    // default would be showing a form default by another name.
    const current = field("value");
    if (current === null) continue;
    out.set(name, {
      min: field("min") ?? 0,
      max: field("max") ?? 1,
      step: field("step") ?? 1,
      default: field("default") ?? current,
      current,
    });
  }
  return out;
}

export function parseDevices(stdout: string): { card: string; nodes: string[] }[] {
  const out: { card: string; nodes: string[] }[] = [];
  let current: { card: string; nodes: string[] } | null = null;
  for (const raw of stdout.split("\n")) {
    if (raw.trim() === "") continue;
    if (!/^\s/.test(raw)) {
      current = { card: raw.replace(/\s*\(.*\)\s*:?\s*$/, "").trim(), nodes: [] };
      out.push(current);
      continue;
    }
    const node = raw.trim();
    if (current && node.startsWith("/dev/")) current.nodes.push(node);
  }
  return out;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -w yonder-core -- src/video/probe/parse.test.ts`
Expected: PASS. **If a regex does not match your fixture, fix the regex, not the fixture** — the fixture is what the board said.

- [ ] **Step 5: Write the failing detection test**

`packages/yonder-core/src/video/probe/camera.test.ts`:

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectCameras, probeCamera } from "./camera.js";
import type { CommandRunner } from "../../net/runner.js";

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");

/** A runner that answers from the recorded fixtures and executes nothing. */
function benchRunner(overrides: Record<string, string> = {}): CommandRunner {
  return async (argv) => {
    const key = argv.join(" ");
    for (const [match, stdout] of Object.entries(overrides)) {
      if (key.includes(match)) return { code: 0, stdout, stderr: "" };
    }
    if (key.includes("--list-devices")) return { code: 0, stdout: fixture("list-devices.txt"), stderr: "" };
    if (key.includes("/dev/video10")) return { code: 0, stdout: fixture("list-formats-video10.txt"), stderr: "" };
    if (key.includes("--list-formats-ext")) return { code: 0, stdout: fixture("list-formats-ext-globalshutter.txt"), stderr: "" };
    if (key.includes("--list-ctrls-menus")) return { code: 0, stdout: fixture("list-ctrls-menus-globalshutter.txt"), stderr: "" };
    return { code: 1, stdout: "", stderr: "no such device" };
  };
}

describe("detectCameras", () => {
  it("finds the camera and reports what it can do", async () => {
    const r = await detectCameras({ runner: benchRunner() });
    expect(r.found.length).toBeGreaterThan(0);
    expect(r.found[0].capabilities.formats.state).toBe("present");
  });

  it("rejects the board's own JPEG decoder, with the reason", async () => {
    // K-40: /dev/video10 advertises MJPEG, cannot be started, and looks like a
    // camera to everything that asks. An operator who is not told why it
    // vanished will go looking for it.
    const r = await detectCameras({ runner: benchRunner() });
    const decoder = r.rejected.find((x) => x.device.includes("video10"));
    expect(decoder).toBeDefined();
    expect(decoder!.reason).toContain("hardware codec");
  });

  it("rejects the board's HEVC decoder by its card, not by its formats", async () => {
    // rpi-hevc-dec matches neither "codec" nor "decoder" nor "isp". Before the
    // pattern was widened it reached format probing and was rejected for
    // offering only raw frames — a true sentence that sends an operator
    // looking for a camera setting on a hardware decoder.
    const r = await detectCameras({ runner: benchRunner() });
    const hevc = r.rejected.find((x) => x.card.includes("hevc"));
    expect(hevc).toBeDefined();
    expect(hevc!.reason).toContain("hardware codec");
  });

  it("reports one row per card, so a camera's metadata node is not a rejection", async () => {
    // A UVC camera owns two nodes and the second answers no formats. A
    // rejection sitting beside the camera that was just found reads as
    // "something went wrong with your camera" when nothing did.
    const r = await detectCameras({ runner: benchRunner() });
    const cameraCard = r.found[0].card;
    expect(r.rejected.some((x) => x.card === cameraCard)).toBe(false);
  });

  it("rejects a camera that offers no compressed format", async () => {
    // R-CAM-02 is compressed sources. A raw-only camera at a rate too slow to
    // fly is a rejection with a reason, not an empty page.
    const rawOnly = [
      "ioctl: VIDIOC_ENUM_FMT",
      "\t[0]: 'YUYV' (YUYV 4:2:2)",
      "\t\tSize: Discrete 640x480",
      "\t\t\tInterval: Discrete 0.200s (5.000 fps)",
    ].join("\n");
    const r = await detectCameras({ runner: benchRunner({ "--list-formats-ext": rawOnly }) });
    expect(r.found).toHaveLength(0);
    expect(r.rejected.some((x) => x.reason.includes("compressed"))).toBe(true);
  });

  it("never throws — a failed probe is a rejection", async () => {
    const dead: CommandRunner = async () => ({ code: 1, stdout: "", stderr: "boom" });
    await expect(detectCameras({ runner: dead })).resolves.toMatchObject({ found: [] });
  });

  it("carries the by-path name, so the configured camera survives a reboot", async () => {
    // R-CAM-05. /dev/video0 is whichever camera the kernel probed first this
    // boot; the by-path name is the socket it is plugged into.
    const r = await detectCameras({
      runner: benchRunner(),
      readLink: (p) => (p.includes("video0") ? "platform-fd500000.pcie-pci-0000:01:00.0-usb-0:1.3:1.0-video-index0" : null),
    });
    expect(r.found[0].byPath).toContain("usb-");
  });
});
```

- [ ] **Step 6: Write `probe/camera.ts`**

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
import { systemRunner, type CommandRunner } from "../net/runner.js";
import {
  noCapabilities, present, type CameraCapabilities, type ControlRange,
} from "../capability.js";
import { parseControls, parseDevices, parseFormats } from "./parse.js";

/**
 * Detection on demand (R-CAM-12).
 *
 * **A rejection is a value.** "What was found, what was rejected and why" is
 * the requirement, and a thrown exception carries none of the third. Every
 * failure in this file becomes a `Rejection` with a sentence an operator can
 * act on, and the Cameras page renders both lists.
 *
 * Two rejections this bench produces today:
 *
 *   - `/dev/video10` is the board's JPEG *decoder*. It advertises MJPEG,
 *     cannot be started (K-40), and looks like a camera to everything that
 *     asks. Without a stated reason it simply would not appear, and an
 *     operator would go looking for the camera that vanished.
 *   - A camera offering raw frames only. R-CAM-02 is compressed sources; raw
 *     at 5 fps is not a flyable picture, and the software JPEG decode that
 *     dominates this pipeline has nothing to decode.
 */
export interface Rejection {
  readonly device: string;
  readonly card: string;
  readonly reason: string;
}
export interface Detection {
  readonly device: string;
  readonly card: string;
  /** The socket, not the enumeration number (R-CAM-05). */
  readonly byPath: string;
  readonly capabilities: CameraCapabilities;
}
export interface DetectResult {
  readonly found: Detection[];
  readonly rejected: Rejection[];
}

export interface ProbeOptions {
  runner?: CommandRunner;
  /** Injected so a test resolves by-path names without a /dev tree. */
  readLink?: (path: string) => string | null;
}

/** Formats that carry compressed video, and are therefore flyable (R-CAM-02). */
const COMPRESSED = new Set(["MJPG", "JPEG", "H264", "HEVC"]);

/** V4L2 control names this page draws, mapped to the capability they fill. */
const CONTROL_MAP = [
  ["brightness", "brightness"],
  ["contrast", "contrast"],
  ["zoom_absolute", "zoom"],
  ["focus_absolute", "focus"],
  ["exposure_time_absolute", "exposure"],
  ["white_balance_temperature", "whiteBalance"],
] as const;

export async function detectCameras(opts: ProbeOptions = {}): Promise<DetectResult> {
  const runner = opts.runner ?? systemRunner;
  const found: Detection[] = [];
  const rejected: Rejection[] = [];

  const listed = await runner(["v4l2-ctl", "--list-devices"]);
  if (listed.code !== 0) {
    return {
      found,
      rejected: [{
        device: "", card: "",
        reason: `v4l2-ctl could not list devices: ${listed.stderr.trim() || `exit ${listed.code}`}`,
      }],
    };
  }

  for (const device of parseDevices(listed.stdout)) {
    // **A card yields at most one row.** A UVC camera owns two nodes — the
    // capture node and a metadata node that answers `Type: Video Capture` with
    // no formats beneath it. Probing node by node puts a rejection beside the
    // camera that was just found, which on the Cameras page reads as
    // "something went wrong with your camera" when nothing did. R-UI-15 is
    // about capabilities on a camera's page, not about every /dev node the
    // kernel created.
    const outcomes: (Detection | Rejection)[] = [];
    for (const node of device.nodes) {
      outcomes.push(await probeNode(node, device.card, runner, opts.readLink));
    }
    const accepted = outcomes.find((o): o is Detection => "capabilities" in o);
    if (accepted) found.push(accepted);
    else if (outcomes.length > 0) rejected.push(outcomes[0] as Rejection);
  }
  return { found, rejected };
}

async function probeNode(
  node: string,
  card: string,
  runner: CommandRunner,
  readLink?: (path: string) => string | null,
): Promise<Detection | Rejection> {
  // K-40, checked by card rather than by node number: the decoder is
  // /dev/video10 on this board and need not be on another, but a codec always
  // announces itself as one.
  //
  // `decode|encode|hevc` and not `decoder`: this board carries an
  // `rpi-hevc-dec` card that matches none of the obvious words, and letting it
  // through means an operator reads "this camera offers only raw frames" about
  // a hardware HEVC decoder — a true sentence that sends them looking for a
  // camera setting that does not exist.
  if (/codec|decode|encode|isp|hevc/i.test(card)) {
    return {
      device: node, card,
      reason: `${card} is a hardware codec on this board, not a camera; it advertises formats it cannot capture (K-40)`,
    };
  }

  const formats = await runner(["v4l2-ctl", "-d", node, "--list-formats-ext"]);
  if (formats.code !== 0) {
    return {
      device: node, card,
      reason: `could not read this device's formats: ${formats.stderr.trim() || `exit ${formats.code}`}`,
    };
  }
  const parsed = parseFormats(formats.stdout);
  if (parsed.length === 0) {
    return { device: node, card, reason: "this device offered no capture format" };
  }
  const compressed = parsed.filter((f) => COMPRESSED.has(f.fourcc));
  if (compressed.length === 0) {
    return {
      device: node, card,
      reason: `this camera offers only raw frames (${[...new Set(parsed.map((f) => f.fourcc))].join(", ")}); Yonder needs a compressed source (R-CAM-02)`,
    };
  }

  const controls = await runner(["v4l2-ctl", "-d", node, "--list-ctrls-menus"]);
  const ranges: Map<string, ControlRange> =
    controls.code === 0 ? parseControls(controls.stdout) : new Map();

  const capabilities: CameraCapabilities = { ...noCapabilities(), formats: present(compressed) };
  const filled = capabilities as { [K in keyof CameraCapabilities]: CameraCapabilities[K] };
  for (const [v4l2Name, key] of CONTROL_MAP) {
    const range = ranges.get(v4l2Name);
    // Absent is `not-offered`, which noCapabilities() already set. A device
    // that *listed* the control and refused to read it is the advertised
    // state, and probeControl below is where M5 will distinguish them; today
    // v4l2-ctl does not separate the two, and inventing the distinction here
    // would be worse than not drawing it.
    if (range) Object.assign(filled, { [key]: present(range) });
  }

  const byPath = readLink?.(node) ?? node;
  return { device: node, card, byPath, capabilities };
}

/** One camera, re-probed — the Setup deck's *Re-probe* key. */
export async function probeCamera(
  node: string,
  card: string,
  opts: ProbeOptions = {},
): Promise<Detection | Rejection> {
  return probeNode(node, card, opts.runner ?? systemRunner, opts.readLink);
}
```

- [ ] **Step 7: Run the tests**

Run: `npm test -w yonder-core -- src/video/`
Expected: PASS. Adjust the fixture-derived expectations to your recorded output; do not adjust the recorded output.

- [ ] **Step 8: Commit**

```bash
git add packages/yonder-core/src/video/probe/
git commit -s -m "feat(video): probe a camera, and make every rejection a value with a reason

R-CAM-12 asks for what was found, what was rejected and why. A thrown
exception carries none of the third and would take the Cameras page down with
the one camera it could not read, so nothing in probe/ throws.

Two rejections this bench produces: /dev/video10, the board's own JPEG decoder
that advertises MJPEG and cannot be started (K-40) — without a stated reason
it would simply not appear, and an operator would go looking for a camera that
vanished — and a camera offering raw frames only, which R-CAM-02 excludes.

Fixtures are recorded from the board and committed. The rates come from the
parenthesised fps figure, not from 1/interval, which derives 30.3 and offers a
rate the camera never named. Controls read value=, never default=: R-CTL-10
wants the reading, and the default is a form default by another name.

Refs: R-CAM-02, R-CAM-05, R-CAM-12, R-CAM-14, R-CTL-04, R-CTL-10

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: The encoder probe

**Requirements:** R-CAM-07, R-CAM-13, R-HW-01, R-HW-02

**Files:**
- Create: `packages/yonder-core/src/video/probe/encoder.ts`
- Test: `packages/yonder-core/src/video/probe/encoder.test.ts`

**Interfaces:**
- Consumes: `CommandRunner` only. **Not `parseFormats`** — it needs a `Size:` line to flush a format, and `--list-formats` / `--list-formats-out` never emit one. This probe matches the fourcc directly.
- Produces:

```ts
export interface Encoder {
  readonly element: "v4l2h264enc" | "x264enc";
  readonly device: string | null;   // the M2M node, null for software
  readonly hardware: boolean;
  readonly codec: "h264";
  /** Shown read-only in the Setup deck: what the probe answered, not a choice. */
  readonly detail: string;
}
export function probeEncoder(opts?: { runner?: CommandRunner; override?: string }): Promise<Encoder>;
```

**Why a probe and not a table.** R-CAM-13 is explicit: *"by probing the hardware, not from a table of board names"*. R-CAM-06 is withdrawn for the same reason — resolving the encoder at install time bakes a build host's answer into a board's image. A Pi 4 has hardware H.264 on an M2M node; a Pi 5 does not and needs `x264enc` (R-HW-02). The board says which; a name does not.

- [ ] **Step 1: Write the failing test**

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { probeEncoder } from "./encoder.js";
import type { CommandRunner } from "../../net/runner.js";

const HARDWARE_OUT = [
  "ioctl: VIDIOC_ENUM_FMT",
  "\tType: Video Output Multiplanar",
  "\t[0]: 'YU12' (Planar YUV 4:2:0)",
].join("\n");
const HARDWARE_CAP = [
  "ioctl: VIDIOC_ENUM_FMT",
  "\tType: Video Capture Multiplanar",
  "\t[0]: 'H264' (H.264, compressed)",
].join("\n");

function runner(nodes: Record<string, { out: string; cap: string }>): CommandRunner {
  return async (argv) => {
    const key = argv.join(" ");
    for (const [node, answer] of Object.entries(nodes)) {
      if (!key.includes(node)) continue;
      if (key.includes("--list-formats-out")) return { code: 0, stdout: answer.out, stderr: "" };
      if (key.includes("--list-formats")) return { code: 0, stdout: answer.cap, stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "No such file or directory" };
  };
}

it("finds the board's hardware H.264 encoder and names the node", async () => {
  const e = await probeEncoder({
    runner: runner({ "/dev/video11": { out: HARDWARE_OUT, cap: HARDWARE_CAP } }),
  });
  expect(e).toMatchObject({ element: "v4l2h264enc", device: "/dev/video11", hardware: true });
});

it("falls back to software where the board has no encoder (R-HW-02)", async () => {
  const e = await probeEncoder({ runner: runner({}) });
  expect(e).toMatchObject({ element: "x264enc", device: null, hardware: false });
  expect(e.detail).toContain("software");
});

it("never mistakes the decoder for an encoder", async () => {
  // K-40: /dev/video10 takes JPEG in and gives raw out. An encoder takes raw
  // in and gives H.264 out. The direction is the whole test, and a probe that
  // only looked for "a node that mentions H264" would pick a decoder that
  // cannot be started.
  const decoder = {
    out: "\tType: Video Output Multiplanar\n\t[0]: 'JPEG' (JFIF JPEG, compressed)",
    cap: "\tType: Video Capture Multiplanar\n\t[0]: 'YU12' (Planar YUV 4:2:0)",
  };
  const e = await probeEncoder({ runner: runner({ "/dev/video10": decoder }) });
  expect(e.hardware).toBe(false);
});

it("lets an operator name one explicitly, bypassing the probe (R-CAM-13)", async () => {
  const e = await probeEncoder({ runner: runner({}), override: "v4l2h264enc:/dev/video11" });
  expect(e).toMatchObject({ element: "v4l2h264enc", device: "/dev/video11", hardware: true });
  expect(e.detail).toContain("named by the operator");
});

it("never throws when no video node exists at all", async () => {
  const dead: CommandRunner = async () => ({ code: 1, stdout: "", stderr: "boom" });
  await expect(probeEncoder({ runner: dead })).resolves.toMatchObject({ hardware: false });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -w yonder-core -- src/video/probe/encoder.test.ts`
Expected: FAIL — `./encoder.js` does not exist.

- [ ] **Step 3: Write the probe**

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
import { systemRunner, type CommandRunner } from "../net/runner.js";

/**
 * Which encoder this board actually has (R-CAM-13, R-CAM-07).
 *
 * **Probed, never looked up.** R-CAM-06 is withdrawn because resolving this at
 * install time fails twice over: the installer seeds config.yaml only when
 * absent, so the value goes stale on upgrade, and an image build runs the
 * installer in a chroot on a build host, which would bake a build machine's
 * answer into a board's image.
 *
 * **The direction is the test.** A memory-to-memory node has an output side
 * (what you feed it) and a capture side (what it gives back). An encoder takes
 * raw in and gives H.264 out; the decoder K-40 records does the opposite. A
 * probe that only looked for a node mentioning H264 would pick the decoder,
 * which advertises MJPEG and cannot be started.
 */
export interface Encoder {
  readonly element: "v4l2h264enc" | "x264enc";
  readonly device: string | null;
  readonly hardware: boolean;
  readonly codec: "h264";
  readonly detail: string;
}

/** The M2M nodes worth asking. Cheap: each is two ioctls against a node. */
const CANDIDATES = Array.from({ length: 8 }, (_, i) => `/dev/video${10 + i}`);

const RAW = /'(YU12|NV12|YUYV|NV21|YV12)'/;
const H264 = /'H264'/;

const SOFTWARE: Encoder = {
  element: "x264enc", device: null, hardware: false, codec: "h264",
  detail: "software H.264 (x264enc) — this board offers no hardware encoder",
};

export async function probeEncoder(
  opts: { runner?: CommandRunner; override?: string } = {},
): Promise<Encoder> {
  // R-CAM-13's escape hatch: "An operator may name one explicitly to bypass
  // the probe." Written `element:device`, or bare `x264enc`.
  if (opts.override) {
    const [element, device] = opts.override.split(":");
    if (element === "x264enc") {
      return { ...SOFTWARE, detail: "software H.264 (x264enc) — named by the operator" };
    }
    if (element === "v4l2h264enc" && device) {
      return {
        element: "v4l2h264enc", device, hardware: true, codec: "h264",
        detail: `hardware H.264 on ${device} — named by the operator, not probed`,
      };
    }
  }

  const runner = opts.runner ?? systemRunner;
  for (const node of CANDIDATES) {
    const out = await runner(["v4l2-ctl", "-d", node, "--list-formats-out"]);
    if (out.code !== 0 || !RAW.test(out.stdout)) continue;
    const cap = await runner(["v4l2-ctl", "-d", node, "--list-formats"]);
    if (cap.code !== 0 || !H264.test(cap.stdout)) continue;
    return {
      element: "v4l2h264enc", device: node, hardware: true, codec: "h264",
      detail: `hardware H.264 on ${node} — raw in, H.264 out`,
    };
  }
  return SOFTWARE;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -w yonder-core -- src/video/probe/encoder.test.ts`
Expected: PASS, all five cases.

- [ ] **Step 5: Verify against the board**

```bash
ssh yonder@<board> 'for d in /dev/video1?; do echo "== $d"; v4l2-ctl -d $d --list-formats-out 2>&1 | head -4; v4l2-ctl -d $d --list-formats 2>&1 | head -4; done'
```

Expected: `/dev/video11` shows raw on the output side and `H264` on the capture side. If a different node answers, the probe still finds it — that is the point — but record the board's answer in the commit message.

- [ ] **Step 6: Commit**

```bash
git add packages/yonder-core/src/video/probe/encoder.ts packages/yonder-core/src/video/probe/encoder.test.ts
git commit -s -m "feat(video): find the encoder by asking the board, never by its name

R-CAM-13. R-CAM-06 is withdrawn because resolving this at install time goes
stale on upgrade and bakes a build host's answer into an image.

The direction is the test. An M2M node has an output side and a capture side;
an encoder takes raw in and gives H.264 out, and the decoder K-40 records does
the opposite. A probe that only looked for a node mentioning H264 would pick
the decoder that cannot be started.

A Pi 5 has no hardware encoder and falls back to x264enc, which is R-HW-02
rather than a failure. An operator may still name one explicitly.

Refs: R-CAM-07, R-CAM-13, R-HW-01, R-HW-02

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6: Pipeline composition, with every branch bounded

**Requirements:** R-VID-01, R-VID-03, R-VID-04, R-VID-05, R-VID-08, R-VID-09, R-VID-13, R-CAM-10

**Files:**
- Create: `packages/yonder-core/src/video/pipeline.ts`
- Test: `packages/yonder-core/src/video/pipeline.test.ts`

**Interfaces:**
- Consumes: `Camera`, `CameraOutput` (Task 1); `CameraCapabilities` (Task 3); `Encoder` (Task 5).
- Produces:

```ts
export const QUEUE: readonly string[];   // the bounded, leaky branch queue
export interface ComposeOptions { camera: Camera; capabilities: CameraCapabilities; encoder: Encoder; rtspBase: string }
export function compose(opts: ComposeOptions): string[];   // argv for gst-launch-1.0
export function refuse(opts: ComposeOptions): string | null; // R-CAM-10, before anything is pressed
```

**Two structural points settled in planning.**

**There are two tees.** The sketch this design inherits forks once, after `h264parse`. Spec §4 changes that: the browser's copy is *a second encode from the already-decoded frames*, scaled, which is what takes the browser's share of the uplink down by most of an order of magnitude. So the graph forks **before** the encoder for the preview and **again after** it for the two full-rate consumers.

**Every branch is bounded and drops rather than blocks.** A bare `queue` *blocks* when it fills. A ground station that stops reading, a media server that stalls, or a TCP connection that goes quiet then applies back-pressure through the tee, stalls the shared encoder, and takes every other branch down with it — including the one the operator is watching. That is invisible until the day it matters and then presents as the whole video system dying for no reason, so it is asserted on the composed pipeline.

- [ ] **Step 1: Write the failing test**

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { compose, refuse, QUEUE } from "./pipeline.js";
import { present, noCapabilities } from "./capability.js";
import type { Camera } from "../schema/config.js";

const CAMERA: Camera = {
  id: "cam0", name: "Nose", source: "usb", device: "platform-fd500000.pcie-pci-0000:01:00.0-usb-0:1.3:1.0-video-index0",
  enabled: true, autostart: false,
  width: 1280, height: 720, framerate: 30, codec: "h264", bitrate_kbps: 2000,
  preview: { width: 640, height: 360, framerate: 15, bitrate_kbps: 400 },
  controls: { brightness: null, contrast: null, rotation: 0 },
  outputs: [
    { kind: "rtp", host: "192.168.1.50", port: 5600 },
    { kind: "rtsp", path: "cam0", password: { secret: "rtsp_password" } },
  ],
};
const CAPS = {
  ...noCapabilities(),
  formats: present([{ fourcc: "MJPG", width: 1280, height: 720, rates: [30, 24, 15] }]),
};
const HW = {
  element: "v4l2h264enc" as const, device: "/dev/video11", hardware: true,
  codec: "h264" as const, detail: "hardware H.264 on /dev/video11",
};
const opts = { camera: CAMERA, capabilities: CAPS, encoder: HW, rtspBase: "rtsp://127.0.0.1:8554" };
const argv = () => compose(opts);
const text = () => argv().join(" ");

describe("compose", () => {
  it("captures the format the camera actually offered", () => {
    expect(text()).toContain("v4l2src");
    expect(text()).toContain("image/jpeg,width=1280,height=720,framerate=30/1");
  });

  it("decodes once and forks before the encoder", () => {
    // Spec section 4: the expensive frames are already decoded, and the
    // preview is a second encode from those frames. One jpegdec, two encodes.
    expect(text().match(/jpegdec/g)).toHaveLength(1);
    expect(text().match(/v4l2h264enc/g)).toHaveLength(2);
    expect(text()).toContain("tee name=raw");
    expect(text()).toContain("tee name=main");
  });

  it("scales the preview with the board's own resizer, not in software", () => {
    // That hardware sits idle once the ISP converter is out of the main path.
    expect(text()).toContain("v4l2convert");
    expect(text()).toContain("width=640,height=360");
    expect(text()).not.toContain("videoscale");
  });

  it("runs a short keyframe interval on the preview branch only", () => {
    // R-VID-09 on the path where a person is watching a grey rectangle. The
    // ground-station branch keeps a long GOP; asking the media server to
    // demand a keyframe would need a control channel M4 does not have.
    expect(text()).toContain("h264_i_frame_period=15");
    expect(text().match(/h264_i_frame_period/g)).toHaveLength(1);
    // ...and it is on the preview's encode, not the full-rate one: the short
    // GOP appears after the branch that carries v4l2convert.
    const previewBranch = text().slice(text().indexOf("v4l2convert"));
    expect(previewBranch).toContain("h264_i_frame_period=15");
  });

  it("bounds every branch off both tees, and drops rather than blocks", () => {
    // A bare queue blocks when it fills, applies back-pressure through the
    // tee, stalls the shared encoder, and takes every other branch down with
    // it — including the one the operator is watching.
    const branches = argv().filter((a) => a === "queue");
    expect(branches.length).toBeGreaterThanOrEqual(3);
    for (const token of QUEUE.slice(1)) {
      expect(argv().filter((a) => a === token).length).toBe(branches.length);
    }
    expect(QUEUE).toContain("leaky=downstream");
    expect(QUEUE).toContain("max-size-time=200000000");
    expect(QUEUE).toContain("max-size-buffers=0");
    expect(QUEUE).toContain("max-size-bytes=0");
  });

  it("pushes RTP to the configured ground station", () => {
    expect(text()).toContain("rtph264pay");
    expect(text()).toContain("host=192.168.1.50");
    expect(text()).toContain("port=5600");
  });

  it("publishes the full-rate stream and the preview under separate paths", () => {
    expect(text()).toContain("rtsp://127.0.0.1:8554/cam0");
    expect(text()).toContain("rtsp://127.0.0.1:8554/cam0-preview");
  });

  it("carries a fixed bitrate, in bits, on both encodes (R-VID-08)", () => {
    expect(text()).toContain("video_bitrate=2000000");
    expect(text()).toContain("video_bitrate=400000");
  });

  it("uses x264enc where the board has no hardware encoder", () => {
    const soft = compose({ ...opts, encoder: {
      element: "x264enc", device: null, hardware: false, codec: "h264",
      detail: "software",
    } });
    expect(soft.join(" ")).toContain("x264enc");
    expect(soft.join(" ")).toContain("bitrate=2000");   // x264enc counts in kb/s
    expect(soft.join(" ")).not.toContain("video_bitrate");
  });

  it("never shells out — the composition is a value", () => {
    expect(Array.isArray(argv())).toBe(true);
    expect(argv()[0]).toBe("gst-launch-1.0");
  });
});

describe("refuse", () => {
  it("refuses a mode the camera never offered, before anything is pressed", () => {
    // R-CAM-10. The picker is built from what the camera reported, so this is
    // the second line of defence, not the first — but a config file edited by
    // hand does not go through a picker.
    expect(refuse({ ...opts, camera: { ...CAMERA, width: 3840, height: 2160 } }))
      .toContain("3840x2160");
  });

  it("refuses a rate the camera did not offer at that size", () => {
    expect(refuse({ ...opts, camera: { ...CAMERA, framerate: 60 } })).toContain("60");
  });

  it("refuses a preview larger than the capture it is scaled from", () => {
    expect(refuse({ ...opts, camera: {
      ...CAMERA, width: 640, height: 360,
      preview: { width: 1280, height: 720, framerate: 15, bitrate_kbps: 400 },
    } })).toContain("preview");
  });

  it("says nothing about a configuration the board can sustain", () => {
    expect(refuse(opts)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -w yonder-core -- src/video/pipeline.test.ts`
Expected: FAIL — `./pipeline.js` does not exist.

- [ ] **Step 3: Write the composer**

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
import type { Camera, CameraOutput } from "../schema/config.js";
import type { CameraCapabilities } from "./capability.js";
import type { Encoder } from "./probe/encoder.js";

/**
 * One camera, one pipeline, composed as a value (R-VID-05).
 *
 * **Nothing here runs anything.** The composed pipeline is an argv a test
 * asserts without a camera, which is also the condition CI runs in.
 *
 * **The shape, and why it is not the obvious one.** The sketch this design
 * inherits forks once, after h264parse: one encode, copied to two consumers.
 * That is right about the encoder — the tee costs almost nothing, 68% of a
 * core for one output against 70% for two — and wrong about the uplink, where
 * each consumer that leaves over cellular costs its own bitrate. At 2 Mb/s
 * that is 6 Mb/s for one camera against a field LTE uplink that is often 1-5.
 *
 * So the graph forks twice:
 *
 *     v4l2src ! image/jpeg ! jpegdec ! tee name=raw
 *       raw. ! queue ! ENCODE(full) ! h264parse ! tee name=main
 *         main. ! queue ! rtph264pay ! udpsink        (R-VID-01)
 *         main. ! queue ! rtspclientsink              (R-VID-03/04, via mediamtx)
 *       raw. ! queue ! v4l2convert ! videorate ! ENCODE(preview) ! h264parse
 *            ! rtspclientsink                          (R-VID-13)
 *
 * The preview is a *second encode from frames already decoded*. The JPEG
 * decode is the entire cost of this pipeline — 1% capture, ~50% software
 * decode, +4% hardware encode — so a second encode off the decoded frames is
 * cheap in a way a second capture would not be, and it takes the browser's
 * share of the uplink down by most of an order of magnitude.
 *
 * The downscale uses the board's own resizer. That hardware sits idle once the
 * ISP converter is out of the main path, and software scaling of 1080p at
 * 30 fps is the one term the substituted 11% figure contains no allowance for
 * at all.
 *
 * **The preview branch runs a short keyframe interval and the ground-station
 * branch does not.** A reconnecting browser is a late joiner and without a
 * keyframe watches a grey rectangle for up to a whole group of pictures
 * (R-VID-09). Asking the media server to demand one from the encoder needs a
 * control channel M4 does not have, over an interface nobody has exercised.
 * Since section 4 already made these two separate encodes, a short GOP on the
 * cheap one costs a few tens of kb/s on a branch running at a few hundred —
 * and it is the only branch with a person watching the rectangle. A late-
 * joining *ground station* still wants the control channel, and waits for one.
 */

/**
 * The queue on every branch off every tee.
 *
 * **A bare `queue` blocks when it fills.** A ground station that stops
 * reading, a media server that stalls, or a TCP connection that goes quiet
 * applies back-pressure through the tee, stalls the shared encoder, and takes
 * every other branch down with it — including the one the operator is
 * watching. That would make the spec's central claim about link loss —
 * *capture, encode and the ground-station push continue* — false rather than
 * merely untested.
 *
 * Bounded by time rather than by buffers or bytes, because 200 ms is a
 * latency budget and a buffer count is not. `max-size-buffers=0` and
 * `max-size-bytes=0` disable the other two limits, which default to non-zero
 * and would otherwise bound the queue first and by the wrong measure.
 */
export const QUEUE = [
  "queue", "leaky=downstream",
  "max-size-time=200000000", "max-size-buffers=0", "max-size-bytes=0",
] as const;

export interface ComposeOptions {
  readonly camera: Camera;
  readonly capabilities: CameraCapabilities;
  readonly encoder: Encoder;
  /** Where mediamtx listens, on loopback. */
  readonly rtspBase: string;
}

/** `! element prop=v !` — GStreamer's link token, as its own argv entry. */
const LINK = "!";

function encode(encoder: Encoder, kbps: number, shortGop: boolean): string[] {
  if (encoder.element === "x264enc") {
    // x264enc counts in kb/s and takes key-int-max in frames. `tune=zerolatency`
    // because a B-frame reorder buffer is latency on a link that already has
    // 300 ms of it (R-UI-06).
    return [
      "x264enc", `bitrate=${kbps}`, "speed-preset=veryfast", "tune=zerolatency",
      ...(shortGop ? ["key-int-max=15"] : []),
    ];
  }
  const controls = [`video_bitrate=${kbps * 1000}`, ...(shortGop ? ["h264_i_frame_period=15"] : [])];
  return ["v4l2h264enc", `device=${encoder.device}`, `extra-controls=controls,${controls.join(",")}`];
}

function sink(output: CameraOutput, rtspBase: string, id: string): string[] {
  switch (output.kind) {
    case "rtp":
      // config-interval=-1 sends SPS/PPS with every keyframe. Without it a
      // ground station started after the stream never gets the parameter sets
      // and shows nothing, with no error, for ever.
      return ["rtph264pay", "config-interval=-1", "pt=96", LINK,
        "udpsink", `host=${output.host}`, `port=${output.port}`, "sync=false"];
    case "rtsp":
      return ["rtspclientsink", `location=${rtspBase}/${output.path}`, "latency=0"];
    case "srt":
      return ["mpegtsmux", LINK, "srtsink", `uri=srt://:${output.port}`, "wait-for-connection=false"];
  }
}

export function compose(opts: ComposeOptions): string[] {
  const { camera, encoder, rtspBase } = opts;
  const argv: string[] = ["gst-launch-1.0", "-q"];
  const push = (...tokens: string[]): void => { argv.push(...tokens); };

  push(
    "v4l2src", `device=/dev/v4l/by-path/${camera.device}`, "io-mode=4", LINK,
    `image/jpeg,width=${camera.width},height=${camera.height},framerate=${camera.framerate}/1`, LINK,
    "jpegdec", LINK,
    "tee", "name=raw",
  );

  // The full-rate encode, then the fork to its consumers.
  push("raw.", LINK, ...QUEUE, LINK, ...encode(encoder, camera.bitrate_kbps, false), LINK,
    "h264parse", LINK, "tee", "name=main");
  for (const output of camera.outputs) {
    push("main.", LINK, ...QUEUE, LINK, ...sink(output, rtspBase, camera.id));
  }

  // The cheap copy the interface watches (R-VID-13), always published, always
  // under its own path so the console can never subscribe to the wrong one.
  push(
    "raw.", LINK, ...QUEUE, LINK,
    "v4l2convert", LINK,
    `video/x-raw,width=${camera.preview.width},height=${camera.preview.height}`, LINK,
    "videorate", LINK, `video/x-raw,framerate=${camera.preview.framerate}/1`, LINK,
    ...encode(encoder, camera.preview.bitrate_kbps, true), LINK,
    "h264parse", LINK,
    "rtspclientsink", `location=${rtspBase}/${camera.id}-preview`, "latency=0",
  );

  return argv;
}

/**
 * Why this configuration cannot be sustained, or null (R-CAM-10).
 *
 * The pickers are built from what the camera reported, so this is the second
 * line of defence rather than the first — but `config.yaml` is a file an
 * operator may edit by hand, and a pipeline that fails to start says
 * `Internal data stream error` and nothing else.
 */
export function refuse(opts: ComposeOptions): string | null {
  const { camera, capabilities } = opts;
  if (capabilities.formats.state !== "present") {
    return "this camera has not answered with any capture format";
  }
  const formats = capabilities.formats.value;
  const size = formats.find((f) => f.width === camera.width && f.height === camera.height);
  if (!size) {
    const offered = formats.map((f) => `${f.width}x${f.height}`).join(", ");
    return `this camera does not offer ${camera.width}x${camera.height}; it offers ${offered}`;
  }
  if (!size.rates.includes(camera.framerate)) {
    return `this camera does not offer ${camera.framerate} fps at ${camera.width}x${camera.height}; it offers ${size.rates.join(", ")}`;
  }
  if (camera.preview.width > camera.width || camera.preview.height > camera.height) {
    return `the preview is ${camera.preview.width}x${camera.preview.height}, larger than the ${camera.width}x${camera.height} it is scaled from`;
  }
  return null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -w yonder-core -- src/video/pipeline.test.ts`
Expected: PASS, all fourteen cases.

- [ ] **Step 5: Run the composed pipeline on the board, by hand, once**

The composition is a value and the tests prove its shape; only the board proves it starts.

```bash
npm run build -w yonder-core
node -e '
  const { compose } = require("./packages/yonder-core/dist/video/pipeline.js");
  /* paste the CAMERA / CAPS / HW literals from the test */
  console.log(compose({ camera: CAMERA, capabilities: CAPS, encoder: HW, rtspBase: "rtsp://127.0.0.1:8554" }).join(" "));
'
```

Copy the printed line to the board and run it. Expected: it starts and stays up. **mediamtx is not installed until Task 9**, so the two `rtspclientsink` branches will fail to connect — that is expected here; what this step proves is that capture, decode, both encodes and the RTP push work. Note in the commit message whether it did.

- [ ] **Step 6: Commit**

```bash
git add packages/yonder-core/src/video/pipeline.ts packages/yonder-core/src/video/pipeline.test.ts
git commit -s -m "feat(video): compose one pipeline per camera, with every branch bounded

Two tees, not one. The inherited sketch forks after h264parse — right about
the encoder, wrong about the uplink, where each consumer that leaves over
cellular costs its own bitrate: 6 Mb/s for one camera against a field LTE
uplink that is often 1-5. So the browser's copy is a second encode from frames
already decoded, scaled by the board's own resizer, which is R-VID-13.

Every branch queue is bounded by time and drops the oldest. A bare queue
blocks when it fills: a ground station that stops reading applies back-pressure
through the tee, stalls the shared encoder, and takes every other branch down
with it — including the one the operator is watching. Invisible until the day
it matters, then the whole video system dies for no reason, so the composition
test asserts it.

A short keyframe interval on the preview branch only. That is R-VID-09
satisfied on the path where a person is watching a grey rectangle, arranged in
the pipeline rather than commanded — a control channel into a running pipeline
is M9's cost to pay, not M4's.

Refs: R-VID-01, R-VID-03, R-VID-04, R-VID-05, R-VID-08, R-VID-09, R-VID-13,
R-CAM-10

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 7: Run state per camera

**Requirements:** R-CTL-01, R-CTL-10, R-UI-05

**Files:**
- Create: `packages/yonder-core/src/video/supervisor.ts`
- Test: `packages/yonder-core/src/video/supervisor.test.ts`

**Interfaces:**
- Consumes: `compose`, `refuse` (Task 6); `Clock` from `yonder-core`.
- Produces:

```ts
export type RunState = "stopped" | "starting" | "running" | "failed";
export interface CameraRun { readonly id: string; readonly state: RunState; readonly since: number; readonly reason?: string; readonly restarts: number }
export interface SpawnedProcess { kill(signal?: string): void; on(event: "exit" | "error", fn: (arg: unknown) => void): void }
export type ProcessSpawner = (argv: string[]) => SpawnedProcess;
export class Supervisor {
  constructor(opts: { spawner?: ProcessSpawner; clock?: Clock });
  start(id: string, argv: string[]): void;
  stop(id: string): void;
  state(id: string): CameraRun;
  all(): CameraRun[];
}
```

**Why a new abstraction rather than `CommandRunner`.** `CommandRunner` is for a command that exits and hands back its output. A pipeline runs until it is stopped. `ProcessSpawner` is injected for the same reason `CommandRunner` is: **no test may spawn `gst-launch-1.0`.**

**What this task deliberately does not build.** A control channel into a running pipeline. Start, stop and run state are process lifecycle; resolution, codec and bitrate are a respawn; the keyframe on reconnect is arranged in the pipeline (Task 6). R-VID-07's adaptive loop in M9 is the only thing that needs a running handle, and it carries that cost.

- [ ] **Step 1: Write the failing test**

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { Supervisor, type ProcessSpawner, type SpawnedProcess } from "./supervisor.js";

function fakeClock() {
  let now = 1_000_000;
  const timers: { at: number; fn: () => void }[] = [];
  return {
    clock: {
      now: () => now,
      setTimer: (ms: number, fn: () => void) => { const t = { at: now + ms, fn }; timers.push(t); return t; },
      clearTimer: (h: unknown) => { const i = timers.indexOf(h as never); if (i >= 0) timers.splice(i, 1); },
    },
    advance(ms: number) {
      now += ms;
      for (const t of [...timers]) if (t.at <= now) { timers.splice(timers.indexOf(t), 1); t.fn(); }
    },
  };
}

function fakeSpawner() {
  const spawned: { argv: string[]; proc: SpawnedProcess; exit(code: number): void }[] = [];
  const spawner: ProcessSpawner = (argv) => {
    const handlers: Record<string, ((a: unknown) => void)[]> = { exit: [], error: [] };
    const proc: SpawnedProcess = {
      kill: vi.fn(),
      on: (event, fn) => { handlers[event].push(fn); },
    };
    spawned.push({ argv, proc, exit: (code) => handlers.exit.forEach((h) => h(code)) });
    return proc;
  };
  return { spawner, spawned };
}

const ARGV = ["gst-launch-1.0", "-q", "v4l2src"];

describe("Supervisor", () => {
  it("starts stopped, because video does not autocast", () => {
    const s = new Supervisor({ spawner: fakeSpawner().spawner, clock: fakeClock().clock });
    expect(s.state("cam0")).toMatchObject({ state: "stopped", restarts: 0 });
  });

  it("reports starting, then running once the pipeline has held", () => {
    const { spawner } = fakeSpawner();
    const { clock, advance } = fakeClock();
    const s = new Supervisor({ spawner, clock });
    s.start("cam0", ARGV);
    // R-UI-05: sent is not taken effect. A pipeline that exits after 200 ms
    // was never running, and a page that said "running" on the spawn call
    // would have reported the command, not its effect.
    expect(s.state("cam0").state).toBe("starting");
    advance(3000);
    expect(s.state("cam0").state).toBe("running");
  });

  it("is failed, with the reason, when the pipeline exits during start-up", () => {
    const { spawner, spawned } = fakeSpawner();
    const { clock, advance } = fakeClock();
    const s = new Supervisor({ spawner, clock });
    s.start("cam0", ARGV);
    advance(500);
    spawned[0].exit(255);
    expect(s.state("cam0")).toMatchObject({ state: "failed" });
    expect(s.state("cam0").reason).toContain("255");
  });

  it("restarts a pipeline that dies after it was running, with backoff", () => {
    const { spawner, spawned } = fakeSpawner();
    const { clock, advance } = fakeClock();
    const s = new Supervisor({ spawner, clock });
    s.start("cam0", ARGV);
    advance(3000);
    spawned[0].exit(1);
    expect(s.state("cam0").state).toBe("starting");
    advance(1000);
    expect(spawned).toHaveLength(2);
    expect(s.state("cam0").restarts).toBe(1);
  });

  it("gives up after repeated failures rather than restarting for ever", () => {
    const { spawner, spawned } = fakeSpawner();
    const { clock, advance } = fakeClock();
    const s = new Supervisor({ spawner, clock });
    s.start("cam0", ARGV);
    for (let i = 0; i < 6; i++) { advance(3000); spawned[spawned.length - 1].exit(1); advance(30_000); }
    expect(s.state("cam0").state).toBe("failed");
    expect(s.state("cam0").reason).toContain("gave up");
  });

  it("stops on request, and does not restart what an operator stopped", () => {
    const { spawner, spawned } = fakeSpawner();
    const { clock, advance } = fakeClock();
    const s = new Supervisor({ spawner, clock });
    s.start("cam0", ARGV);
    advance(3000);
    s.stop("cam0");
    expect(spawned[0].proc.kill).toHaveBeenCalled();
    spawned[0].exit(0);
    advance(60_000);
    expect(spawned).toHaveLength(1);
    expect(s.state("cam0").state).toBe("stopped");
  });

  it("keeps each camera's state apart", () => {
    const { spawner } = fakeSpawner();
    const { clock, advance } = fakeClock();
    const s = new Supervisor({ spawner, clock });
    s.start("cam0", ARGV);
    advance(3000);
    expect(s.state("cam1").state).toBe("stopped");
    expect(s.all().map((r) => r.id).sort()).toEqual(["cam0"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -w yonder-core -- src/video/supervisor.test.ts`
Expected: FAIL — `./supervisor.js` does not exist.

- [ ] **Step 3: Write the supervisor**

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
import { systemClock, type Clock } from "../apply/types.js";

/**
 * Spawning and supervising one pipeline per camera (R-CTL-01).
 *
 * **This is the whole runtime surface in M4.** Start and stop are process
 * lifecycle; resolution, codec and bitrate are a respawn; a keyframe on
 * reconnect is arranged in the pipeline rather than commanded. What M4
 * therefore does not build is a control channel into a running pipeline —
 * R-VID-07's adaptive bitrate in M9 cannot be built without one, so it carries
 * that cost rather than this milestone paying it early.
 *
 * **Stopping is a runtime action, not a configuration write.** It survives no
 * apply and no reboot: a camera configured to autostart comes back streaming.
 * That is deliberate — Start and Stop are the only controls on the camera page
 * that stop the aircraft *sending*, and an operator watching the uplink track
 * go past its mark needs something that acts now rather than something that
 * takes a confirmation window to arm.
 */
export type RunState = "stopped" | "starting" | "running" | "failed";

export interface CameraRun {
  readonly id: string;
  readonly state: RunState;
  readonly since: number;
  readonly reason?: string;
  readonly restarts: number;
}

/** The part of a child process this file uses. Injected; see ProcessSpawner. */
export interface SpawnedProcess {
  kill(signal?: string): void;
  on(event: "exit" | "error", fn: (arg: unknown) => void): void;
}

/**
 * Injected for the reason `CommandRunner` is: no test spawns
 * `gst-launch-1.0`. A separate type because a pipeline does not exit and hand
 * back its output — it runs until something stops it.
 */
export type ProcessSpawner = (argv: string[]) => SpawnedProcess;

/** How long a pipeline must hold before it counts as running (R-UI-05). */
const SETTLE_MS = 2_000;
/** Backoff between restarts, and how many before giving up. */
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const MAX_RESTARTS = 5;

interface Entry {
  run: CameraRun;
  argv: string[];
  proc: SpawnedProcess | null;
  settle: unknown;
  retry: unknown;
  /** Set while an operator's stop is in flight, so an exit is not a failure. */
  stopping: boolean;
}

export class Supervisor {
  private readonly spawner: ProcessSpawner;
  private readonly clock: Clock;
  private readonly entries = new Map<string, Entry>();

  constructor(opts: { spawner?: ProcessSpawner; clock?: Clock } = {}) {
    this.clock = opts.clock ?? systemClock;
    this.spawner = opts.spawner ?? (() => { throw new Error("no spawner configured"); });
  }

  start(id: string, argv: string[]): void {
    const existing = this.entries.get(id);
    if (existing && (existing.run.state === "starting" || existing.run.state === "running")) return;
    const entry: Entry = existing ?? {
      run: { id, state: "stopped", since: this.clock.now(), restarts: 0 },
      argv, proc: null, settle: null, retry: null, stopping: false,
    };
    entry.argv = argv;
    entry.stopping = false;
    entry.run = { ...entry.run, restarts: 0, reason: undefined };
    this.entries.set(id, entry);
    this.spawn(id, entry);
  }

  stop(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) {
      this.entries.set(id, {
        run: { id, state: "stopped", since: this.clock.now(), restarts: 0 },
        argv: [], proc: null, settle: null, retry: null, stopping: false,
      });
      return;
    }
    entry.stopping = true;
    this.clock.clearTimer(entry.settle);
    this.clock.clearTimer(entry.retry);
    entry.settle = null;
    entry.retry = null;
    entry.proc?.kill("SIGTERM");
    entry.proc = null;
    entry.run = { ...entry.run, state: "stopped", since: this.clock.now(), reason: undefined };
  }

  state(id: string): CameraRun {
    return this.entries.get(id)?.run
      ?? { id, state: "stopped", since: this.clock.now(), restarts: 0 };
  }

  all(): CameraRun[] {
    return [...this.entries.values()].map((e) => e.run);
  }

  private spawn(id: string, entry: Entry): void {
    entry.run = { ...entry.run, state: "starting", since: this.clock.now() };
    const proc = this.spawner(entry.argv);
    entry.proc = proc;

    // R-UI-05: a spawn call is the command being sent. A pipeline that exits
    // after 200 ms was never running, and a page that turned green on the
    // spawn would be reporting the command rather than its effect.
    entry.settle = this.clock.setTimer(SETTLE_MS, () => {
      if (entry.proc !== proc) return;
      entry.run = { ...entry.run, state: "running", since: this.clock.now(), reason: undefined };
    });

    const ended = (why: string): void => {
      if (entry.proc !== proc) return;
      this.clock.clearTimer(entry.settle);
      entry.proc = null;
      if (entry.stopping) return;
      if (entry.run.restarts >= MAX_RESTARTS) {
        entry.run = {
          ...entry.run, state: "failed", since: this.clock.now(),
          reason: `${why}; gave up after ${MAX_RESTARTS} restarts`,
        };
        return;
      }
      const attempt = entry.run.restarts;
      entry.run = {
        ...entry.run, state: entry.run.state === "running" ? "starting" : "failed",
        since: this.clock.now(), reason: why, restarts: attempt + 1,
      };
      entry.retry = this.clock.setTimer(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)], () => {
        this.spawn(id, entry);
      });
    };

    proc.on("exit", (code) => ended(`the pipeline exited with code ${String(code)}`));
    proc.on("error", (e) => ended(`the pipeline could not be started: ${String(e)}`));
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -w yonder-core -- src/video/supervisor.test.ts`
Expected: PASS, all seven cases.

- [ ] **Step 5: Commit**

```bash
git add packages/yonder-core/src/video/supervisor.ts packages/yonder-core/src/video/supervisor.test.ts
git commit -s -m "feat(video): spawn and supervise one pipeline per camera

R-CTL-01, and the whole runtime surface in M4: start and stop are process
lifecycle, resolution and bitrate are a respawn, and the keyframe on reconnect
is arranged in the pipeline. No control channel into a running pipeline —
R-VID-07's adaptive loop in M9 is the only thing that needs one, and it
carries that cost rather than this milestone paying it early.

A pipeline must hold for two seconds before it counts as running. R-UI-05: a
spawn call is the command being sent, and one that exits after 200 ms was
never running. Restarts back off and then give up, so a camera unplugged in
flight does not respawn for ever.

Stopping survives no apply and no reboot: a camera configured to autostart
comes back streaming. Start and Stop are the only controls on this page that
stop the aircraft sending, and they act now rather than arming a window.

ProcessSpawner is injected for the reason CommandRunner is — no test spawns
gst-launch-1.0.

Refs: R-CTL-01, R-CTL-10, R-UI-05

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 8: The receive line

**Requirements:** R-VID-10, R-VID-15, R-SEC-13

**Files:**
- Create: `packages/yonder-core/src/video/receive.ts`
- Test: `packages/yonder-core/src/video/receive.test.ts`

**Interfaces:**
- Consumes: `Camera`, `CameraOutput` (Task 1).
- Produces:

```ts
export interface ReceiveFacts { camera: Camera; address: string; alternatives: string[]; rtspPassword: string | null; rtspPort: number }
export interface Rendering { kind: "gstreamer" | "dialog" | "appsink" | "url"; title: string; body: string }
export function renderReceive(facts: ReceiveFacts): Rendering[];
```

**The point of this task.** R-VID-10 makes a ground station configurable from the documentation alone. R-VID-15 is the stronger form: the exact command is *in the interface*, generated from what the camera is doing at that moment, so nothing needs to be read. Pure, and therefore fully testable.

- [ ] **Step 1: Write the failing test**

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { renderReceive, type ReceiveFacts } from "./receive.js";
import type { Camera } from "../schema/config.js";

const CAMERA: Camera = {
  id: "cam0", name: "Nose", source: "usb", device: "platform-fd500000.pcie-pci-0000:01:00.0-usb-0:1.3:1.0-video-index0",
  enabled: true, autostart: false,
  width: 1280, height: 720, framerate: 30, codec: "h264", bitrate_kbps: 2000,
  preview: { width: 640, height: 360, framerate: 15, bitrate_kbps: 400 },
  controls: { brightness: null, contrast: null, rotation: 0 },
  outputs: [
    { kind: "rtp", host: "192.168.1.50", port: 5600 },
    { kind: "rtsp", path: "cam0", password: { secret: "rtsp_password" } },
  ],
};
const FACTS: ReceiveFacts = {
  camera: CAMERA,
  address: "192.168.191.42",
  alternatives: ["192.168.77.1", "198.51.100.20"],
  rtspPassword: "Kx7-mfPq-2Rn4",
  rtspPort: 8554,
};

describe("renderReceive", () => {
  it("gives four renderings of the same three facts", () => {
    expect(renderReceive(FACTS).map((r) => r.kind))
      .toEqual(["gstreamer", "dialog", "appsink", "url"]);
  });

  it("names the depayloader that matches the codec", () => {
    const gst = renderReceive(FACTS)[0].body;
    expect(gst).toContain("rtph264depay");
    expect(gst).toContain("avdec_h264");
    expect(gst).toContain("port=5600");
  });

  it("carries the address the operator is actually reaching the device on", () => {
    // A board on a mesh has several and only one is in use. The command
    // carries that one; the others are listed beneath rather than guessed at.
    const url = renderReceive(FACTS)[3].body;
    expect(url).toContain("192.168.191.42");
    expect(url).not.toContain("192.168.77.1");
    const dialog = renderReceive(FACTS)[1].body;
    expect(dialog).toContain("192.168.77.1");
    expect(dialog).toContain("198.51.100.20");
  });

  it("resolves the RTSP credential into the URL, so nobody types it", () => {
    expect(renderReceive(FACTS)[3].body).toContain("Kx7-mfPq-2Rn4");
    expect(renderReceive(FACTS)[3].body).toContain(`rtsp://yonder:`);
    expect(renderReceive(FACTS)[3].body).toContain(":8554/cam0");
  });

  it("says so rather than printing half a URL when the secret is unresolved", () => {
    const body = renderReceive({ ...FACTS, rtspPassword: null })[3].body;
    expect(body).not.toContain("yonder:@");
    expect(body).toContain("not yet generated");
  });

  it("omits an RTSP rendering entirely when no RTSP output is configured", () => {
    const noRtsp = { ...FACTS, camera: { ...CAMERA, outputs: [CAMERA.outputs[0]] } };
    expect(renderReceive(noRtsp).find((r) => r.kind === "url")?.body).toContain("no RTSP output");
  });

  it("keeps units in their own case", () => {
    // Mb/s rendered as MB/S says megabytes. This appeared three times in
    // three components during design.
    for (const r of renderReceive(FACTS)) expect(r.body).not.toContain("MB/S");
    expect(renderReceive(FACTS)[1].body).toContain("Mb/s");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -w yonder-core -- src/video/receive.test.ts`
Expected: FAIL — `./receive.js` does not exist.

- [ ] **Step 3: Write the renderer**

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
import type { Camera } from "../schema/config.js";

/**
 * The exact receive-side command, in the interface (R-VID-15).
 *
 * R-VID-10 makes a ground station configurable from the documentation alone,
 * which is what you need before the device is in front of anyone. This is the
 * stronger form for when you are standing at the console: the command is
 * generated from what the camera is doing at that moment, so nothing needs to
 * be read. Change the codec and the depayloader in the line changes with it.
 *
 * **The address is the one the operator is actually reaching the device on.**
 * A board on a mesh has several and only one of them is in use; the command
 * carries that one and lists the others beneath it rather than guessing.
 *
 * Pure, and therefore fully testable — which matters because the one thing
 * this must never do is print a command that does not work.
 */
export interface ReceiveFacts {
  readonly camera: Camera;
  /** The address this console session arrived on. */
  readonly address: string;
  /** Every other address this device answers on. */
  readonly alternatives: readonly string[];
  /** Resolved from secrets.yaml, or null before it has been generated. */
  readonly rtspPassword: string | null;
  readonly rtspPort: number;
}

export interface Rendering {
  readonly kind: "gstreamer" | "dialog" | "appsink" | "url";
  readonly title: string;
  readonly body: string;
}

/** The depayloader and decoder for a codec. One place, so they cannot drift. */
const CODEC = {
  h264: { depay: "rtph264depay", parse: "h264parse", decode: "avdec_h264" },
} as const;

export function renderReceive(facts: ReceiveFacts): Rendering[] {
  const { camera, address, alternatives, rtspPassword, rtspPort } = facts;
  const c = CODEC[camera.codec];
  const rtp = camera.outputs.find((o) => o.kind === "rtp");
  const rtsp = camera.outputs.find((o) => o.kind === "rtsp");
  const port = rtp?.port ?? 5600;

  const caps =
    `application/x-rtp,media=video,clock-rate=90000,encoding-name=${camera.codec.toUpperCase()},payload=96`;

  return [
    {
      kind: "gstreamer",
      title: "A GStreamer command line",
      body: [
        `gst-launch-1.0 -v udpsrc port=${port} caps="${caps}"`,
        `  ! rtpjitterbuffer latency=100 ! ${c.depay} ! ${c.parse} ! ${c.decode}`,
        `  ! videoconvert ! autovideosink sync=false`,
      ].join(" \\\n"),
    },
    {
      kind: "dialog",
      title: "A ground station's own video settings",
      body: [
        `Video source:    UDP`,
        `Listen port:     ${port}`,
        `Codec:           ${camera.codec.toUpperCase()}`,
        `Picture:         ${camera.width}x${camera.height} at ${camera.framerate} fps`,
        `Bitrate:         ${(camera.bitrate_kbps / 1000).toFixed(1)} Mb/s`,
        ``,
        `This device also answers on: ${alternatives.length ? alternatives.join(", ") : "no other address"}`,
      ].join("\n"),
    },
    {
      kind: "appsink",
      title: "A pipeline ending in an application sink",
      body:
        `udpsrc port=${port} caps="${caps}" ` +
        `! rtpjitterbuffer latency=100 ! ${c.depay} ! ${c.parse} ! ${c.decode} ` +
        `! videoconvert ! video/x-raw,format=BGRA ! appsink name=sink emit-signals=true sync=false`,
    },
    {
      kind: "url",
      title: "An RTSP URL",
      body: rtsp === undefined || rtsp.kind !== "rtsp"
        ? "This camera has no RTSP output configured. Add one in Setup to receive over RTSP."
        : rtspPassword === null
          ? `rtsp://yonder:<password>@${address}:${rtspPort}/${rtsp.path}\n\n` +
            "This device's RTSP password has not yet been generated; it is created the first " +
            "time the media server is configured."
          : `rtsp://yonder:${rtspPassword}@${address}:${rtspPort}/${rtsp.path}`,
    },
  ];
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -w yonder-core -- src/video/receive.test.ts`
Expected: PASS, all seven cases.

- [ ] **Step 5: Commit**

```bash
git add packages/yonder-core/src/video/receive.ts packages/yonder-core/src/video/receive.test.ts
git commit -s -m "feat(video): the receive command in the interface, not in a document

R-VID-15. R-VID-10 makes a ground station configurable from the documentation
alone, which is what you need before the device is in front of anyone; this is
the form for standing at the console. Four renderings of the same three facts,
generated from what the camera is doing at that moment.

The address is the one the operator is actually reaching the device on. A
board on a mesh has several and only one is in use, so the command carries
that one and lists the others beneath it rather than guessing.

The RTSP credential is resolved into the URL so nobody types it, and when it
has not been generated yet the line says so rather than printing half a URL
that would fail with an authentication error nobody could explain.

Refs: R-VID-10, R-VID-15, R-SEC-13

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 9: mediamtx, with a stated posture for every listener it opens

**Requirements:** R-SEC-13, R-SEC-01, R-SEC-07, R-VID-03, R-VID-04, R-VID-06, R-CFG-08

**Files:**
- Create: `packages/yonder-core/src/media/config.ts`
- Create: `packages/yonder-core/src/media/renderer.ts`
- Test: `packages/yonder-core/src/media/config.test.ts`, `media/renderer.test.ts`
- Modify: `packages/yonder-core/src/daemon/server.ts` (register `MediaRenderer` in `buildRenderers`)
- Modify: `installer/make-payload.sh`
- Create: `installer/roles/50-mediamtx.sh`
- Modify: `packages/yonder-core/src/installer.test.ts`

**Interfaces:**
- Consumes: `Config`, `SecretStore`, `Renderer` from `yonder-core`.
- Produces:

```ts
export interface MediaFacts { config: Config; rtspPassword: string }
export function mediamtxConfig(facts: MediaFacts): string;   // pure: yaml text
export class MediaRenderer implements Renderer { readonly name = "media"; render(config: Config): Promise<void> }
```

**The problem this task solves.** The media server listens on its own ports. The interface's password is checked by the console on the console's port, and **nothing in that path touches the media server** — so without a decision here, M4's exit criterion (*from another network*, meaning over the mesh) is met by a picture anyone on the overlay can watch without logging in. Each listener gets its own answer.

| Listener | Posture |
|---|---|
| **WebRTC (the browser's picture)** | Behind the interface's own credential. The console proxies the small HTTP exchange that carries the keys (Task 10); the video itself flows directly and stays fast. |
| **RTSP** | A generated **per-device** credential — Mission Planner and QGroundControl cannot hold a console session. One per device rather than one per camera: a set of them buys the ability to hand out one camera and not another, which nobody has asked for. |
| **SRT** | Off unless an `srt` output is configured; the same generated credential when it is. |
| **RTP push** | Nothing to protect — outbound to a configured address with no listener. |
| **RTMP, HLS** | **Off.** mediamtx offers them, nothing in this design uses them, and a listener that exists for no reason is a listener nobody is watching. |

- [ ] **Step 1: Write the failing config test**

`packages/yonder-core/src/media/config.test.ts`:

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { mediamtxConfig } from "./config.js";
import { ConfigSchema } from "../schema/config.js";

const base = {
  version: 1, network: { ap: { psk: { secret: "ap_psk" } } }, ui: { port: 3000, editor: {} },
};
const withCamera = (extra: Record<string, unknown> = {}) => ConfigSchema.parse({
  ...base,
  cameras: [{
    id: "cam0", name: "Nose", source: "usb", device: "usb-1",
    outputs: [{ kind: "rtsp", path: "cam0", password: { secret: "rtsp_password" } }],
    ...extra,
  }],
});
const yaml = (cfg = withCamera()) => parse(mediamtxConfig({ config: cfg, rtspPassword: "Kx7-mfPq-2Rn4" }));

describe("mediamtxConfig", () => {
  it("switches off every protocol nothing in the configuration uses", () => {
    // A listener that exists for no reason is a listener nobody is watching.
    const y = yaml();
    expect(y.rtmp).toBe(false);
    expect(y.hls).toBe(false);
    expect(y.srt).toBe(false);
  });

  it("turns SRT on only when an SRT output is configured", () => {
    const y = yaml(withCamera({ outputs: [{ kind: "srt", port: 8890 }] }));
    expect(y.srt).toBe(true);
  });

  it("binds WebRTC to loopback, because the console proxies its handshake", () => {
    // R-SEC-13: the exchange that carries the encryption keys goes through
    // one authenticated route. A WebRTC listener on 0.0.0.0 would hand the
    // keys to anyone on the mesh and make that route decoration.
    expect(yaml().webrtcAddress).toMatch(/^127\.0\.0\.1:/);
  });

  it("gives every RTSP path a credential, and never a shared default", () => {
    const y = yaml();
    const path = y.paths["cam0"];
    expect(path.readUser).toBe("yonder");
    expect(path.readPass).toBe("Kx7-mfPq-2Rn4");
    // R-SEC-01: no shared default that protects the vehicle or its data.
    expect(path.readPass).not.toMatch(/yonder|admin|password|changeme/i);
  });

  it("publishes from loopback only, so nothing outside can inject a stream", () => {
    // R-SEC-04's spirit: the pipeline publishes over loopback. A publish path
    // open to the network is a write path into what the aircraft appears to
    // be sending.
    const path = yaml().paths["cam0"];
    expect(path.publishIPs).toEqual(["127.0.0.1/32"]);
  });

  it("declares a path for the cheap preview as well as the full stream", () => {
    const y = yaml();
    expect(Object.keys(y.paths).sort()).toEqual(["cam0", "cam0-preview"]);
  });

  it("gives the preview the same credential as its camera", () => {
    expect(yaml().paths["cam0-preview"].readPass).toBe("Kx7-mfPq-2Rn4");
  });

  it("declares no path at all for a camera with no RTSP output", () => {
    const y = yaml(withCamera({ outputs: [{ kind: "rtp", host: "192.168.1.50", port: 5600 }] }));
    // The preview still needs a path — that is how the browser reaches it —
    // but the full-rate stream is not published where nobody asked for it.
    expect(Object.keys(y.paths)).toEqual(["cam0-preview"]);
  });

  it("writes no secret into a log level that would print one", () => {
    const y = yaml();
    expect(y.logLevel).toBe("info");
    expect(mediamtxConfig({ config: withCamera(), rtspPassword: "Kx7-mfPq-2Rn4" }))
      .not.toContain("logLevel: debug");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -w yonder-core -- src/media/config.test.ts`
Expected: FAIL — `./config.js` does not exist.

- [ ] **Step 3: Write `media/config.ts`**

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
import { stringify } from "yaml";
import type { Config } from "../schema/config.js";

/**
 * The media server's configuration, generated from Yonder's (R-SEC-13).
 *
 * **One declarative file is the only writer.** This is generated from
 * config.yaml exactly as the NetworkManager keyfiles are, so there is no
 * second place where a listener could be turned on.
 *
 * **Every listener has a stated posture, and none is reachable by default
 * without one.** The interface's password is checked by the console on the
 * console's port, and nothing in that path touches this server — so without
 * this file, M4's exit criterion of watching video *from another network* is
 * met by a picture anyone on the mesh can watch without logging in.
 *
 *   - **WebRTC** binds to loopback. Setting up a stream begins with one small
 *     HTTP exchange carrying the keys that encrypt the video; the console
 *     proxies *that exchange* behind its own credential (console/whep.ts),
 *     and the video itself flows directly and stays fast. Somebody who cannot
 *     log in never obtains the keys.
 *   - **RTSP** carries a generated per-device credential, because Mission
 *     Planner and QGroundControl cannot hold a console session. Per device
 *     rather than per camera: a set of them buys the ability to hand out one
 *     camera and not another, which nobody has asked for.
 *   - **SRT** is off unless an output configures it, and carries the same
 *     credential when it is on.
 *   - **RTMP and HLS are off.** Nothing in this design uses them.
 *
 * Publishing is loopback-only on every path. The pipeline publishes from this
 * board; a publish path open to the network would be a write path into what
 * the aircraft appears to be sending.
 */
export interface MediaFacts {
  readonly config: Config;
  /** Resolved from secrets.yaml. Never logged, never in a support bundle. */
  readonly rtspPassword: string;
}

/** Where mediamtx listens. The console proxies WebRTC from loopback. */
export const RTSP_PORT = 8554;
export const WEBRTC_PORT = 8889;
export const SRT_PORT = 8890;

export function mediamtxConfig(facts: MediaFacts): string {
  const { config, rtspPassword } = facts;
  const cameras = config.cameras;
  const anySrt = cameras.some((c) => c.outputs.some((o) => o.kind === "srt"));

  const paths: Record<string, unknown> = {};
  for (const camera of cameras) {
    const credential = {
      readUser: "yonder",
      readPass: rtspPassword,
      // The pipeline is on this board. Anything else publishing here would be
      // injecting into what the aircraft appears to be sending.
      publishIPs: ["127.0.0.1/32"],
      source: "publisher",
    };
    // The preview always has a path: it is how the browser reaches the
    // picture, and R-VID-13 makes it the default the interface watches.
    paths[`${camera.id}-preview`] = credential;
    if (camera.outputs.some((o) => o.kind === "rtsp")) {
      paths[camera.id] = credential;
    }
  }

  return stringify({
    logLevel: "info",
    logDestinations: ["stdout"],

    // R-VID-04. Publishing and reading both happen here; the credential above
    // is what separates them.
    rtsp: true,
    rtspAddress: `:${RTSP_PORT}`,
    rtspTransports: ["tcp", "udp"],

    // R-VID-03, behind the console (console/whep.ts). Loopback deliberately:
    // a listener on 0.0.0.0 hands the encryption keys to anyone on the mesh
    // and makes the authenticated route decoration.
    webrtc: true,
    webrtcAddress: `127.0.0.1:${WEBRTC_PORT}`,
    webrtcLocalUDPAddress: `:${WEBRTC_PORT + 1}`,

    // R-VID-06, and only where something asked for it.
    srt: anySrt,
    srtAddress: `:${SRT_PORT}`,

    // Off. mediamtx offers them; nothing in this design uses them.
    rtmp: false,
    hls: false,

    paths,
  }, { lineWidth: 0 });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -w yonder-core -- src/media/config.test.ts`
Expected: PASS, all nine cases.

- [ ] **Step 5: Write the renderer and its test**

`packages/yonder-core/src/media/renderer.test.ts` asserts three things — the file is written where mediamtx reads it, the credential is generated once through `SecretStore#ensure`, and the service is restarted only when the file changed:

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MediaRenderer } from "./renderer.js";
import { SecretStore } from "../secrets/store.js";
import { ConfigSchema } from "../schema/config.js";
import type { CommandRunner } from "../net/runner.js";

function bench() {
  const dir = mkdtempSync(join(tmpdir(), "yonder-media-"));
  const argvs: string[][] = [];
  const runner: CommandRunner = async (argv) => { argvs.push(argv); return { code: 0, stdout: "", stderr: "" }; };
  const secrets = new SecretStore(join(dir, "secrets.yaml"));
  return { dir, argvs, runner, secrets, path: join(dir, "mediamtx.yml") };
}
const CFG = ConfigSchema.parse({
  version: 1, network: { ap: { psk: { secret: "ap_psk" } } }, ui: { editor: {} },
  cameras: [{
    id: "cam0", name: "Nose", source: "usb", device: "usb-1",
    outputs: [{ kind: "rtsp", path: "cam0", password: { secret: "rtsp_password" } }],
  }],
});

describe("MediaRenderer", () => {
  it("generates the RTSP credential once, per device", async () => {
    const b = bench();
    const r = new MediaRenderer({ path: b.path, runner: b.runner, secrets: b.secrets });
    await r.render(CFG);
    const first = b.secrets.get("rtsp_password");
    expect(first).toBeTruthy();
    await r.render(CFG);
    expect(b.secrets.get("rtsp_password")).toBe(first);
  });

  it("writes the file where mediamtx reads it, and starts the service", async () => {
    const b = bench();
    await new MediaRenderer({ path: b.path, runner: b.runner, secrets: b.secrets }).render(CFG);
    expect(existsSync(b.path)).toBe(true);
    expect(readFileSync(b.path, "utf8")).toContain("rtspAddress");
    expect(b.argvs.some((a) => a.join(" ").includes("restart mediamtx"))).toBe(true);
  });

  it("does not restart the service when nothing changed", async () => {
    const b = bench();
    const r = new MediaRenderer({ path: b.path, runner: b.runner, secrets: b.secrets });
    await r.render(CFG);
    const after = b.argvs.length;
    await r.render(CFG);
    expect(b.argvs.length).toBe(after);
  });

  it("stops the service when no camera is configured", async () => {
    // Nothing to serve is not a reason to keep a listener open.
    const b = bench();
    const empty = ConfigSchema.parse({
      version: 1, network: { ap: { psk: { secret: "ap_psk" } } }, ui: { editor: {} },
    });
    await new MediaRenderer({ path: b.path, runner: b.runner, secrets: b.secrets }).render(empty);
    expect(b.argvs.some((a) => a.join(" ").includes("stop mediamtx"))).toBe(true);
  });
});
```

`packages/yonder-core/src/media/renderer.ts`:

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, readFileSync } from "node:fs";
import { writeFileDurable } from "../fs/durable.js";
import { systemRunner, type CommandRunner } from "../net/runner.js";
import type { SecretStore } from "../secrets/store.js";
import type { Config } from "../schema/config.js";
import type { Renderer } from "../apply/types.js";
import { mediamtxConfig } from "./config.js";

/**
 * Turns the camera configuration into the media server's (ADR-0003).
 *
 * The credential is generated **once, per device**, exactly as the access
 * point's passphrase is: the configuration holds a reference, the value lands
 * in secrets.yaml at 0600, and the operator never types it because the receive
 * line resolves it and hands them the whole URL to copy. It inherits R-SEC-01
 * (no shared default), R-SEC-07 (never in a published image) and R-SEC-10
 * (never in a log, an error, or a support bundle) without further work.
 *
 * **The service follows the configuration.** No camera means nothing to serve,
 * and nothing to serve is not a reason to keep a listener open.
 */
export class MediaRenderer implements Renderer {
  readonly name = "media";
  private readonly path: string;
  private readonly runner: CommandRunner;
  private readonly secrets: SecretStore;

  constructor(opts: { path?: string; runner?: CommandRunner; secrets: SecretStore }) {
    this.path = opts.path ?? "/etc/mediamtx/mediamtx.yml";
    this.runner = opts.runner ?? systemRunner;
    this.secrets = opts.secrets;
  }

  async render(config: Config): Promise<void> {
    if (config.cameras.length === 0) {
      await this.runner(["systemctl", "stop", "mediamtx"]);
      return;
    }
    const { value: rtspPassword } = this.secrets.ensure("rtsp_password", "password");
    const next = mediamtxConfig({ config, rtspPassword });
    const current = existsSync(this.path) ? readFileSync(this.path, "utf8") : null;
    if (current === next) {
      // An unchanged file is an unchanged server. Restarting anyway would drop
      // every viewer's picture on an apply that changed a different section.
      return;
    }
    writeFileDurable(this.path, next, 0o600);
    await this.runner(["systemctl", "restart", "mediamtx"]);
  }
}
```

Register it in `buildRenderers` in `src/daemon/server.ts`, beside `RemoteRenderer`, and add `rtsp_password` to whatever list `server.wiring.test.ts` asserts the generated secrets against.

- [ ] **Step 6: Run the media tests and the daemon suite**

Run: `npm test -w yonder-core -- src/media/ src/daemon/`
Expected: PASS.

- [ ] **Step 7: Add mediamtx to the payload and its installer role**

In `installer/make-payload.sh`, following the ZeroTier block's shape. mediamtx publishes a release tarball and a `checksums.sha256` beside it — **not a signed apt index**, so there is no repository key to verify and the pinned checksum in this script is the whole of the trust. Say that in a comment rather than leaving a reader to notice:

```sh
MEDIAMTX_VERSION=${MEDIAMTX_VERSION:-1.9.3}
MEDIAMTX_BASE=${MEDIAMTX_BASE:-https://github.com/bluenviron/mediamtx/releases/download}
# Pinned by hand from the release's own checksums.sha256, verified once on a
# machine with a network. Unlike ZeroTier's apt index there is nothing signed
# to check against, so this constant is the entire trust anchor: bumping the
# version means re-reading the checksum, not editing the number and hoping.
MEDIAMTX_SHA256_arm64=
MEDIAMTX_SHA256_amd64=
```

Fill both in from the release's own checksum file, once, on a machine with a network:

```bash
curl -fsSL https://github.com/bluenviron/mediamtx/releases/download/v1.9.3/checksums.sha256 \
  | grep -E 'linux_(arm64|amd64)\.tar\.gz'
```

Paste the two hashes into the constants above. Bumping the version means re-running this, not editing the number.

Stage into `vendor/mediamtx/`.

**One package the board does not have.** `rtspclientsink` lives in `gstreamer1.0-rtsp`, which is **not installed** on the development board — verified in Task 6, where a pipeline carrying it failed to parse at all rather than merely failing to connect. Every RTSP branch in `pipeline.ts` depends on it, which is both full-rate consumers and the preview. Install it in this role alongside mediamtx, from the payload if the payload carries it and from `apt` otherwise, and fail loudly if it is absent afterwards — a missing element here takes the whole video path down, not one branch.

Then `installer/roles/50-mediamtx.sh`, copying `40-zerotier.sh` line for line in structure — a missing payload is a log line and `return 0`, not an error (R-CFG-08) — installing the binary to `/usr/local/bin/mediamtx`, writing a unit that runs it as a dedicated `yonder-media` user with `ExecStart=/usr/local/bin/mediamtx /etc/mediamtx/mediamtx.yml`, and then:

```sh
# Installed and off, for the reason 40-zerotier.sh is: a media server present
# on a device with no camera configured is a listener nobody decided to open.
# MediaRenderer starts it when, and only when, a camera is configured.
#
# The same ownership check 40-zerotier.sh learned the hard way: an operator
# upgrading a device while watching video over it must not have the picture
# taken away by a role that ran after the daemon already started the service.
if [ -f /etc/mediamtx/mediamtx.yml ]; then
    log "yonder-core owns mediamtx (a camera is configured); leaving it running"
else
    log "stopping and disabling mediamtx until a camera is configured"
    try systemctl stop mediamtx
    disable_unit_offline mediamtx.service
    assert_unit_disabled mediamtx.service
fi
```

- [ ] **Step 8: Verify the installer**

Run: `./scripts/verify-installer-lib.sh && npm test -w yonder-core -- src/installer.test.ts`
Expected: PASS. `installer.test.ts` enumerates roles; add `50-mediamtx.sh` to whatever list it asserts.

- [ ] **Step 9: Commit**

```bash
git add packages/yonder-core/src/media/ packages/yonder-core/src/daemon/ installer/ packages/yonder-core/src/installer.test.ts
git commit -s -m "feat(media): mediamtx from the payload, with a posture for every listener

R-SEC-13. The interface's password is checked by the console on the console's
port, and nothing in that path touches the media server — so without this,
M4's exit criterion of video *from another network* is met by a picture anyone
on the mesh can watch without logging in.

WebRTC binds to loopback and the console proxies its handshake, so somebody
who cannot log in never obtains the keys that decrypt the video. RTSP carries
a generated per-device credential because a ground station cannot hold a
console session — per device, not per camera: a set buys the ability to hand
out one camera and not another, which nobody asked for. SRT only where an
output configures it. RTMP and HLS off: a listener that exists for no reason
is a listener nobody is watching. Publishing is loopback-only on every path.

Installed from the payload and left off, as ZeroTier is, with the same
ownership check — an operator upgrading a device while watching video over it
must not lose the picture to a role that ran after the daemon started the
service. mediamtx ships checksums rather than a signed index, so the pinned
constant is the whole trust anchor and the comment says so.

Refs: R-SEC-13, R-SEC-01, R-SEC-07, R-VID-03, R-VID-04, R-VID-06, R-CFG-08

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 10: The browser's picture, behind the console's own credential

**Requirements:** R-SEC-13, R-SEC-04, R-SEC-12, R-VID-03

**Files:**
- Create: `packages/yonder-core/src/console/whep.ts`
- Test: `packages/yonder-core/src/console/whep.test.ts`
- Modify: `packages/yonder-core/src/console/wiring.ts` (or wherever console routes are registered — follow what `middleware.ts` and `session.ts` already do)

**Interfaces:**
- Consumes: the console's existing session check (`console/session.ts`, `console/middleware.ts`).
- Produces:

```ts
export const WHEP_PREFIX = "/video";
export interface WhepOptions { fetch?: typeof globalThis.fetch; webrtcPort?: number }
export function whepHandler(opts?: WhepOptions):
  (req: { method: string; path: string; body: string; authenticated: boolean }) =>
    Promise<{ status: number; body: string; headers?: Record<string, string> }>;
```

**How this works, in one paragraph.** Setting up a WebRTC stream begins with **one small HTTP exchange** — the browser posts an SDP offer, the server answers — and the keys that encrypt the video are carried in it. The console proxies *that exchange* and nothing else: the video itself flows directly from mediamtx to the browser over UDP and stays fast. One authenticated route in front of one request, and no second credential anywhere. mediamtx's WebRTC listener is on loopback (Task 9), so there is no way round it.

**R-SEC-12 holds.** This is a route in the console that forwards an HTTP request; the console still cannot start, stop or reconfigure the media server.

- [ ] **Step 1: Write the failing test**

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { whepHandler, WHEP_PREFIX } from "./whep.js";

const OFFER = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\n";
const ANSWER = "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\n";

function handler(fetchImpl?: typeof globalThis.fetch) {
  return whepHandler({
    fetch: fetchImpl ?? (vi.fn(async () => new Response(ANSWER, {
      status: 201, headers: { "content-type": "application/sdp", location: "/cam0-preview/whep/abc" },
    })) as unknown as typeof globalThis.fetch),
    webrtcPort: 8889,
  });
}
const post = (path: string, authenticated: boolean) =>
  ({ method: "POST", path, body: OFFER, authenticated });

describe("the WHEP proxy", () => {
  it("refuses an unauthenticated offer", async () => {
    // Without this, M4's exit criterion is met by a picture anyone on the
    // mesh can watch. The video is what the credential is protecting; the
    // handshake is where it is protected.
    const r = await handler()(post(`${WHEP_PREFIX}/cam0-preview/whep`, false));
    expect(r.status).toBe(401);
    expect(r.body).not.toContain("v=0");
  });

  it("forwards an authenticated offer to mediamtx on loopback", async () => {
    const fetchImpl = vi.fn(async () => new Response(ANSWER, {
      status: 201, headers: { "content-type": "application/sdp" },
    }));
    const r = await handler(fetchImpl as unknown as typeof globalThis.fetch)(
      post(`${WHEP_PREFIX}/cam0-preview/whep`, true),
    );
    expect(r.status).toBe(201);
    expect(r.body).toBe(ANSWER);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8889/cam0-preview/whep");
    expect(init.body).toBe(OFFER);
  });

  it("refuses a path that is not a media path", async () => {
    // The proxy target is built from the request path, so this is the one
    // place a traversal could reach something other than a stream.
    for (const bad of ["../admin", "cam0/../../etc", "a b", "cam0%2f.."]) {
      const r = await handler()(post(`${WHEP_PREFIX}/${bad}/whep`, true));
      expect(r.status).toBe(404);
    }
  });

  it("answers a mediamtx that is not running with a reason, not a stack trace", async () => {
    const dead = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    const r = await handler(dead as unknown as typeof globalThis.fetch)(
      post(`${WHEP_PREFIX}/cam0-preview/whep`, true),
    );
    expect(r.status).toBe(503);
    expect(r.body).toContain("media server");
  });

  it("passes a 404 from mediamtx through as a 404", async () => {
    // A camera that is configured but not started has no path yet. The page
    // must be able to tell that apart from "you are not logged in".
    const none = vi.fn(async () => new Response("stream not found", { status: 404 }));
    const r = await handler(none as unknown as typeof globalThis.fetch)(
      post(`${WHEP_PREFIX}/cam0-preview/whep`, true),
    );
    expect(r.status).toBe(404);
  });

  it("handles only the one method WHEP needs", async () => {
    const r = await handler()({ method: "GET", path: `${WHEP_PREFIX}/cam0-preview/whep`, body: "", authenticated: true });
    expect(r.status).toBe(405);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -w yonder-core -- src/console/whep.test.ts`
Expected: FAIL — `./whep.js` does not exist.

- [ ] **Step 3: Write the proxy**

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
import { WEBRTC_PORT } from "../media/config.js";

/**
 * The browser's picture, behind the interface's own credential (R-SEC-13).
 *
 * The media server listens on its own ports and the console's password is
 * checked on the console's port, so nothing in the interface's authentication
 * touches the media server. Without this route, M4's exit criterion — usable
 * video *from another network*, meaning over the mesh — is met by a picture
 * anyone on the overlay can watch without logging in.
 *
 * **Only the handshake is proxied.** Setting up a WebRTC stream begins with
 * one small HTTP exchange: the browser posts an SDP offer, the server answers,
 * and the keys that encrypt the video are carried in it. This forwards *that
 * exchange* and nothing else. The video itself flows directly from the media
 * server to the browser over UDP and stays fast — proxying it would put a
 * Node process in the path of every frame, which is the one thing this design
 * cannot afford. Somebody who cannot log in never obtains the keys, and
 * therefore cannot watch.
 *
 * mediamtx's WebRTC listener is bound to loopback (media/config.ts), so there
 * is no way round this route rather than merely a discouragement from taking
 * one.
 *
 * **R-SEC-12 holds.** This forwards an HTTP request. The console still cannot
 * start, stop or reconfigure the media server.
 */
export const WHEP_PREFIX = "/video";

/** A media path: the same shape the schema allows a camera id, plus -preview. */
const MEDIA_PATH = /^[a-z0-9][a-z0-9-]{0,39}$/;

export interface WhepOptions {
  /** Injected so a test never opens a socket. */
  fetch?: typeof globalThis.fetch;
  webrtcPort?: number;
}

export interface WhepRequest {
  method: string;
  path: string;
  body: string;
  authenticated: boolean;
}

export interface WhepResponse {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

export function whepHandler(opts: WhepOptions = {}): (req: WhepRequest) => Promise<WhepResponse> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const port = opts.webrtcPort ?? WEBRTC_PORT;

  return async (req) => {
    if (req.method !== "POST") return { status: 405, body: "only POST is used to set up a stream" };
    // The credential check comes before anything reads the body, so an
    // unauthenticated request cannot make this process do work either.
    if (!req.authenticated) return { status: 401, body: "log in to watch this camera" };

    const rest = req.path.slice(WHEP_PREFIX.length + 1);
    const [name, verb] = rest.split("/");
    // The proxy target is built from the request path, so this is the one
    // place a traversal could reach something that is not a stream. Matched
    // against a pattern rather than filtered for `..`, because a filter is a
    // list of the tricks somebody thought of.
    if (verb !== "whep" || !MEDIA_PATH.test(name ?? "")) {
      return { status: 404, body: "no such camera stream" };
    }

    let answer: Response;
    try {
      answer = await doFetch(`http://127.0.0.1:${port}/${name}/whep`, {
        method: "POST",
        headers: { "content-type": "application/sdp" },
        body: req.body,
      });
    } catch {
      // The reason matters: a camera that is configured but not started, a
      // media server that is not running, and a browser blocked by a network
      // all present as no picture, and only one of them is worth walking
      // outside for.
      return { status: 503, body: "the media server is not answering; is the camera started?" };
    }

    return {
      status: answer.status,
      body: await answer.text(),
      headers: {
        "content-type": answer.headers.get("content-type") ?? "application/sdp",
        ...(answer.headers.has("location")
          ? { location: `${WHEP_PREFIX}/${name}/whep` }
          : {}),
      },
    };
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -w yonder-core -- src/console/whep.test.ts`
Expected: PASS, all six cases.

- [ ] **Step 5: Wire it into the console and prove the route is authenticated**

Register the handler in the console's route table beside the existing ones, reusing the same session check `middleware.ts` applies. Then add one assertion to `console/wiring.test.ts` — that a request to `/video/...` without a session is refused — because a route that is authenticated only by convention is a route that stops being authenticated the day somebody reorders the table.

Run: `npm test -w yonder-core -- src/console/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/yonder-core/src/console/
git commit -s -m "feat(console): proxy the stream handshake, so the picture needs a login

R-SEC-13. Setting up a WebRTC stream begins with one small HTTP exchange, and
the keys that encrypt the video are carried in it. The console proxies that
exchange — not the video, which continues to flow directly and stays fast, and
which a Node process in the path of every frame could not afford.

mediamtx's WebRTC listener is on loopback, so this is the only way in rather
than merely the intended one. The path is matched against a pattern rather
than filtered for '..', because a filter is a list of the tricks somebody
thought of.

A media server that is not answering gets a 503 with a reason. A camera that
is configured but not started gets mediamtx's own 404. An operator has to be
able to tell those apart from 'you are not logged in' — all three present as
no picture, and only one is worth walking outside for.

R-SEC-12 holds: this forwards an HTTP request; the console still cannot start,
stop or reconfigure the media server.

Refs: R-SEC-13, R-SEC-04, R-SEC-12, R-VID-03

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 11: The measurement harness, gated on a supply that holds

**Requirements:** R-SYS-09, R-VID-11, R-VID-13

**Files:**
- Create: `packages/yonder-core/src/system/supply.ts`
- Test: `packages/yonder-core/src/system/supply.test.ts`
- Create: `scripts/measure-pipeline.sh`
- Modify: `docs/hardware/usb-camera-on-a-pi-4.md` (record what you measure)

**Interfaces:**
- Consumes: `FileReader` / `CommandRunner` from `yonder-core`.
- Produces:

```ts
export interface SupplyState { clean: boolean; now: { undervoltage: boolean; throttled: boolean; capped: boolean }; sinceBoot: { undervoltage: boolean; throttled: boolean; capped: boolean }; raw: string }
export function parseThrottled(hex: string): SupplyState;
export function readSupply(opts?: { runner?: CommandRunner }): Promise<SupplyState | null>;
```

**This is M4's entry gate, and it is a blocking one.** R-VID-13 is the only P1 in the camera set and the milestone's exit criterion rests on it, and **its cost has never been measured**. The 11% of a core recorded for 640×480 is the *whole* pipeline at that size — dominated by a JPEG decode the preview branch does not perform, and containing no term at all for downscaling 1080p at 30 fps. It is a substitution from a different pipeline. Worse, every figure in the Evidence table was taken on a board that was browning out (K-41: `get_throttled=0x50000`, three undervoltage events in the first two minutes of a boot, spontaneous reboots).

So the harness reads the throttle register before and after each run and **refuses to record the result unless both reads are clean**, with the supply state carried as a column beside the figure.

- [ ] **Step 1: Write the failing test**

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { parseThrottled, readSupply } from "./supply.js";
import type { CommandRunner } from "../net/runner.js";

describe("parseThrottled", () => {
  it("reads a clean board as clean", () => {
    const s = parseThrottled("0x0");
    expect(s.clean).toBe(true);
    expect(s.now).toEqual({ undervoltage: false, throttled: false, capped: false });
    expect(s.sinceBoot).toEqual({ undervoltage: false, throttled: false, capped: false });
  });

  it("distinguishes now from has-happened-since-boot (R-SYS-09)", () => {
    // The whole point of the requirement. An undervoltage event restarts the
    // board, and a restart in flight presents as an aircraft that went quiet
    // with nothing to explain it — so 'it happened' has to survive the moment
    // it stopped happening. Bits 0-2 are now; bits 16-18 are since boot.
    const s = parseThrottled("0x50000");
    expect(s.now.undervoltage).toBe(false);
    expect(s.sinceBoot.undervoltage).toBe(true);
    expect(s.sinceBoot.capped).toBe(true);
    expect(s.clean).toBe(false);
  });

  it("reads a board browning out right now", () => {
    const s = parseThrottled("0x50005");
    expect(s.now.undervoltage).toBe(true);
    expect(s.now.capped).toBe(true);
    expect(s.clean).toBe(false);
  });

  it("treats output it cannot read as not clean", () => {
    // The failure mode that matters is recording a number as clean when it
    // was not. Unreadable is dirty.
    for (const bad of ["", "throttled=", "not a number", "0xZZ"]) {
      expect(parseThrottled(bad).clean).toBe(false);
    }
  });

  it("accepts the vcgencmd form as well as a bare word", () => {
    expect(parseThrottled("throttled=0x0").clean).toBe(true);
  });
});

describe("readSupply", () => {
  it("returns null on a board with no vcgencmd, rather than claiming clean", () => {
    // R-SYS-09 is 'where the board exposes it'. A board that does not is
    // unknown, and unknown is not the same as good.
    const none: CommandRunner = async () => ({ code: 127, stdout: "", stderr: "not found" });
    return expect(readSupply({ runner: none })).resolves.toBeNull();
  });

  it("reads the register through the injected runner", async () => {
    const ok: CommandRunner = async () => ({ code: 0, stdout: "throttled=0x0\n", stderr: "" });
    await expect(readSupply({ runner: ok })).resolves.toMatchObject({ clean: true });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -w yonder-core -- src/system/supply.test.ts`
Expected: FAIL — `./supply.js` does not exist.

- [ ] **Step 3: Write the reading**

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
import { systemRunner, type CommandRunner } from "../net/runner.js";

/**
 * Supply-voltage state, where the board exposes it (R-SYS-09).
 *
 * **Now is not the same as has-happened-since-boot**, and the requirement is
 * explicit about distinguishing them: an undervoltage event restarts the
 * board, and a restart in flight presents as an aircraft that went quiet with
 * nothing to explain it. A reading that only showed the present moment would
 * be clean on the very board that had just rebooted itself.
 *
 * The register is a bitfield. Bits 0-2 are what is true now — undervoltage,
 * frequency capped, throttled. Bits 16-18 are the same three, latched since
 * boot. K-41's `0x50000` is the latched pair with nothing wrong at the moment
 * it was read, which is exactly the shape this exists to catch.
 *
 * **Unreadable is not clean.** The failure this guards against is recording a
 * measurement as trustworthy when the board was browning out underneath it, so
 * every path that cannot answer answers "not clean" or nothing at all — never
 * "fine".
 */
export interface SupplyFlags {
  readonly undervoltage: boolean;
  readonly capped: boolean;
  readonly throttled: boolean;
}
export interface SupplyState {
  readonly clean: boolean;
  readonly now: SupplyFlags;
  readonly sinceBoot: SupplyFlags;
  readonly raw: string;
}

const DIRTY: SupplyFlags = { undervoltage: true, capped: true, throttled: true };

export function parseThrottled(text: string): SupplyState {
  const m = /0x([0-9a-f]+)/i.exec(text.trim());
  if (!m) return { clean: false, now: DIRTY, sinceBoot: DIRTY, raw: text.trim() };
  const bits = Number.parseInt(m[1], 16);
  if (!Number.isFinite(bits)) {
    return { clean: false, now: DIRTY, sinceBoot: DIRTY, raw: text.trim() };
  }
  const flags = (shift: number): SupplyFlags => ({
    undervoltage: (bits & (1 << shift)) !== 0,
    capped: (bits & (1 << (shift + 1))) !== 0,
    throttled: (bits & (1 << (shift + 2))) !== 0,
  });
  const now = flags(0);
  const sinceBoot = flags(16);
  return { clean: bits === 0, now, sinceBoot, raw: `0x${bits.toString(16)}` };
}

/** null where the board does not expose it — unknown, not good. */
export async function readSupply(
  opts: { runner?: CommandRunner } = {},
): Promise<SupplyState | null> {
  const result = await (opts.runner ?? systemRunner)(["vcgencmd", "get_throttled"]);
  if (result.code !== 0) return null;
  return parseThrottled(result.stdout);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -w yonder-core -- src/system/supply.test.ts`
Expected: PASS, all seven cases.

- [ ] **Step 5: Write the harness**

`scripts/measure-pipeline.sh` — a POSIX `sh` script, run on the board, that takes a composed pipeline on its command line, reads the throttle register before and after, and **refuses to print a result unless both reads are clean**:

```sh
#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Measure a pipeline's cost, and refuse to record it on a supply that does not
# hold (R-SYS-09).
#
# K-41 records this development board browning out: get_throttled=0x50000,
# three undervoltage events in the first two minutes of a boot, and spontaneous
# reboots. Every figure in the pipeline table in
# docs/hardware/usb-camera-on-a-pi-4.md was measured on a board in that state,
# so those numbers are a floor rather than a clean reading.
#
# This is what stops them being retaken badly. A dirty read before or after the
# run is a refusal to print a figure, not a warning beside one — a warning
# beside a number is a number somebody will copy into a table.
#
# Usage:
#   scripts/measure-pipeline.sh --label "preview branch, 640x360p15" -- gst-launch-1.0 ...
set -eu

DURATION=${DURATION:-60}
LABEL="unlabelled"
while [ $# -gt 0 ]; do
    case "$1" in
        --label) LABEL=$2; shift 2 ;;
        --duration) DURATION=$2; shift 2 ;;
        --) shift; break ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
done
[ $# -gt 0 ] || { echo "nothing to measure; give a pipeline after --" >&2; exit 2; }

command -v vcgencmd >/dev/null 2>&1 || {
    echo "this board does not expose vcgencmd, so the supply cannot be checked" >&2
    echo "refusing to record a figure that cannot be qualified" >&2
    exit 1
}

before=$(vcgencmd get_throttled)
[ "$before" = "throttled=0x0" ] || {
    echo "the supply was already not clean before the run: $before" >&2
    echo "refusing to measure. Fix the supply (K-41) and try again." >&2
    exit 1
}

"$@" >/dev/null 2>&1 &
pid=$!
# Let the pipeline settle before sampling: the first seconds are negotiation
# and buffer fill, and averaging them in flatters the steady-state figure.
sleep 5
cpu=$(ps -p "$pid" -o %cpu= | tr -d ' ')
sleep "$DURATION"
cpu_end=$(ps -p "$pid" -o %cpu= | tr -d ' ')
temp=$(vcgencmd measure_temp)
kill "$pid" 2>/dev/null || true
wait "$pid" 2>/dev/null || true

after=$(vcgencmd get_throttled)
[ "$after" = "throttled=0x0" ] || {
    echo "the supply went out during the run: $after" >&2
    echo "refusing to record this figure. The number is real; the conditions were not." >&2
    exit 1
}

printf '%-40s  cpu %5s%% -> %5s%%  %s  supply %s\n' \
    "$LABEL" "$cpu" "$cpu_end" "$temp" "clean"
```

- [ ] **Step 6: Run the two measurements M4's entry gate needs**

On the board, on a supply that holds:

```bash
# 1. The preview branch as it will actually be built — scaled off the decoded
#    frames with the board's own resizer, which is the figure the 11% was
#    standing in for. Expect materially less; expect to be surprised either way.
scripts/measure-pipeline.sh --label "preview branch 640x360p15 off decoded frames" -- <the compose() output>

# 2. The whole pipeline, both encodes, as Task 6 composes it.
scripts/measure-pipeline.sh --label "full pipeline 1280x720p30 + preview" -- <the compose() output>
```

**If the harness refuses, the supply is the finding.** Fix it and re-run; do not record a figure it declined to print. If the board cannot be made clean, stop and report — this is M4's entry gate and the milestone leans on this number.

- [ ] **Step 7: Record what you measured**

Add a row to the pipeline table in `docs/hardware/usb-camera-on-a-pi-4.md` with the supply state as its own column, and **correct the 640×480 row's note** now that the preview branch has a real figure. Update the spec's Evidence table in the same change — the row currently reads "*that has never been measured*", and leaving it there once it has been is how a document stops being believed.

- [ ] **Step 8: Commit**

```bash
git add packages/yonder-core/src/system/supply.ts packages/yonder-core/src/system/supply.test.ts scripts/measure-pipeline.sh docs/hardware/usb-camera-on-a-pi-4.md docs/superpowers/specs/2026-09-03-camera-view-design.md
git commit -s -m "feat(system): read the supply, and refuse to measure on one that does not hold

R-SYS-09's first consumer, and M4's entry gate. R-VID-13 is the only P1 in the
camera set and the exit criterion rests on it, and its cost has never been
measured: the 11% standing in for it is the whole 640x480 pipeline including a
JPEG decode this branch never performs, with no term at all for downscaling
1080p at 30 fps. A substitution from a different pipeline.

Every figure in the table was taken on a board that was browning out (K-41).
So the harness reads the throttle register before and after each run and
refuses to print a figure unless both reads are clean — a refusal rather than
a warning beside the number, because a warning beside a number is a number
somebody will copy into a table.

Now is not the same as has-happened-since-boot, and R-SYS-09 is explicit about
distinguishing them: an undervoltage restarts the board, and a restart in
flight presents as an aircraft that went quiet with nothing to explain it.
K-41's 0x50000 is the latched pair with nothing wrong at the moment it was
read, which is exactly the shape this catches. Unreadable is not clean.

Refs: R-SYS-09, R-VID-11, R-VID-13

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 12: A soft key that is held

**Requirements:** R-VID-11, R-UI-10, R-UI-05

**Files:**
- Create: `packages/node-red-dashboard-2-yonder/src/holdkey.ts`, `holdkey.html`
- Create: `packages/node-red-dashboard-2-yonder/src/ui/YonderHoldKey.vue`
- Modify: `packages/node-red-dashboard-2-yonder/package.json` (`node-red.nodes` and `node-red-dashboard-2.widgets`)
- Modify: `packages/node-red-dashboard-2-yonder/src/shapes.ts`
- Test: `packages/node-red-dashboard-2-yonder/src/nodes.test.ts`

**Interfaces:**
- Consumes: `registerWidget`, `str`, `num` (`widget.ts`).
- Produces: node type `ui-yonder-holdkey`, component `YonderHoldKey`. Emits `{ payload: "<action>:down" }` on press and `{ payload: "<action>:up" }` on release.

**Why this is its own task, and an early one.** The spec calls this one of the two riskiest pieces of interface work in the document, and says both are *"built and proven before anything that depends on them"*. ADR-0009 records that every soft key once shipped dead because Dashboard silently drops a `widget-action` from a widget that did not register `onAction` — the nodes were right, the wiring was right, the pages captured correctly, and pressing a key did nothing. **A key that has to be held has four more ways to fail than one that is clicked**, and the full-rate preview (R-VID-11: "the full-rate picture stays available while the operator asks for it, on a held soft key") is the first thing that depends on it.

The four ways: a pointer that leaves the button while held; a pointer cancelled by the browser (a scroll gesture on a tablet, a notification); a key held when the page is hidden or the socket drops; and touch firing a synthetic mouse event after the touch event, sending everything twice.

- [ ] **Step 1: Write the failing node test**

`packages/node-red-dashboard-2-yonder/src/nodes.test.ts` already has the helpers this needs: `build(module, config)` constructs a widget and hands back `{ node, group, type, props, events }` — `props` is what the module passed to `group.register`, and `events` is its third argument. Modules use `export =`, so they are imported at **module scope** alongside the existing seven, not inside a test body.

Add the import beside them:

```ts
const holdkeyNode = (await import("./holdkey.js")).default ?? await import("./holdkey.js");
```

and the cases:

```ts
describe("the hold key", () => {
  it("registers as a widget that sends", () => {
    // Dashboard drops a widget-action from a widget that did not register
    // onAction — no error, no warning. Every soft key on this console once
    // shipped dead this way.
    const { type, events } = build(holdkeyNode, { label: "Full rate", action: "fullrate" });
    expect(type).toBe("ui-yonder-holdkey");
    expect(events).toMatchObject({ onAction: true });
  });

  it("carries the cost of holding it, so the page states it before it is asked", () => {
    // R-VID-11: the interface states what asking would cost *before* it is
    // asked. A held key with no cost on it is a key whose consequence is a
    // surprise.
    const { props } = build(holdkeyNode, { label: "Full rate", action: "fullrate", cost: "2.0 Mb/s" });
    expect(props).toMatchObject({ label: "Full rate", action: "fullrate", cost: "2.0 Mb/s" });
  });

  it("keeps a unit in the case it was given", () => {
    // Mb/s rendered as MB/S says megabytes. The component's stylesheet is
    // where that is enforced; this is the half that can be asserted.
    const { props } = build(holdkeyNode, { label: "Full rate", action: "fullrate", cost: "2.0 Mb/s" });
    expect(props!.cost).toBe("2.0 Mb/s");
  });

  it("does not draw itself when it has no dashboard group", () => {
    // A widget dragged onto a flow before it has a group is a normal
    // intermediate state in the editor, not a fault. Node-RED must load the
    // rest of the flow either way.
    const { node } = build(holdkeyNode, { label: "Full rate", action: "fullrate" }, null);
    expect(node.error).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -w node-red-dashboard-2-yonder`
Expected: FAIL — `./holdkey.js` does not exist.

- [ ] **Step 3: Write the node**

`packages/node-red-dashboard-2-yonder/src/holdkey.ts`:

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
import { registerWidget, str } from "./widget.js";
import type { RED } from "./red.js";

/**
 * `ui-yonder-holdkey` — a soft key that acts while it is held (R-VID-11).
 *
 * The cheap preview is what the interface watches by default (R-VID-13), and
 * the full-rate picture stays available *while the operator asks for it*. A
 * toggle would be wrong: an operator who forgot they had left it on would be
 * spending most of a field uplink on a picture nobody was looking at, and
 * would have no reason to suspect it. Holding costs what it costs for as long
 * as you hold it, and the key states that cost before it is pressed.
 *
 * **This is a primitive, and it is deliberately built before anything that
 * needs it.** ADR-0009 records that every soft key on this console once
 * shipped dead, because Dashboard drops a `widget-action` from a widget that
 * never registered `onAction` — no error, no warning. A key that must be *held*
 * has four more ways to fail than one that is clicked, and every one of them
 * leaves the aircraft sending a stream nobody asked for.
 */
export = function register(RED: RED): void {
  registerWidget(RED, {
    type: "ui-yonder-holdkey",
    emitsActions: true,
    props: (_node, config) => ({
      label: str(config.label),
      action: str(config.action),
      /** What holding this costs, stated before it is asked (R-VID-11). */
      cost: str(config.cost),
      tone: str(config.tone, "plain"),
    }),
  });
};
```

`holdkey.html` copies `softkeys.html`'s editor form, with fields `label`, `action`, `cost`, `tone`.

- [ ] **Step 4: Write the component**

`packages/node-red-dashboard-2-yonder/src/ui/YonderHoldKey.vue`:

```vue
<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
    <button
        type="button"
        class="y-hold"
        :class="['tone-' + (props.tone || 'plain'), { held }]"
        :aria-pressed="held ? 'true' : 'false'"
        @pointerdown.prevent="down"
        @pointerup="up"
        @pointercancel="up"
        @pointerleave="up"
        @contextmenu.prevent
    >
        <span class="y-hold__label">{{ props.label }}</span>
        <span v-if="props.cost" class="y-hold__cost">{{ props.cost }}</span>
    </button>
</template>

<script>
/**
 * A soft key that acts while it is held (R-VID-11).
 *
 * **Pointer events, not mouse and touch.** A touch fires a synthetic mouse
 * event after the touch event, so a component listening to both sends
 * everything twice — which here means asking for the full-rate stream twice
 * and releasing it once. Pointer events are one stream for both.
 *
 * **Four releases, not one.** `pointerup` is the ordinary case.
 * `pointercancel` is the browser taking the gesture away — a scroll on a
 * tablet, a notification. `pointerleave` is a finger or a cursor that slid off
 * the button while held. And `visibilitychange` is a page that went to the
 * background still holding it. Every one of them leaves the aircraft sending
 * a full-rate stream nobody is watching if it is missed, and on a cellular
 * uplink that is most of the link.
 *
 * `setPointerCapture` is deliberately *not* used. Capturing would keep
 * delivering events after the pointer left the button, which sounds like the
 * safer choice and is the opposite: it makes `pointerleave` never fire, so a
 * finger dragged off the key keeps the expensive stream running with nothing
 * on screen indicating it.
 *
 * `preventDefault` on pointerdown stops the browser starting a text
 * selection or a drag, either of which swallows the release.
 */
export default {
    name: 'YonderHoldKey',
    inject: ['$socket', '$dataTracker'],
    props: {
        id: { type: String, required: true },
        props: { type: Object, default: () => ({}) },
        state: { type: Object, default: () => ({}) }
    },
    data () {
        return { held: false }
    },
    created () {
        this.$dataTracker(this.id)
    },
    mounted () {
        this.onHidden = () => { if (document.hidden) this.up() }
        document.addEventListener('visibilitychange', this.onHidden)
    },
    beforeUnmount () {
        document.removeEventListener('visibilitychange', this.onHidden)
        // A component torn down mid-hold must still release. Navigating away
        // from the page is not a reason to keep paying for the stream.
        this.up()
    },
    methods: {
        down () {
            if (this.held) return
            this.held = true
            this.send('down')
        },
        up () {
            if (!this.held) return
            this.held = false
            this.send('up')
        },
        send (edge) {
            // widget-action rather than widget-change: a press is an event,
            // not a value to restore on reload. A console that replayed the
            // last key pressed when a browser reconnected would be
            // originating an action nobody asked for.
            this.$socket.emit('widget-action', this.id, {
                payload: `${this.props.action}:${edge}`,
                topic: this.props.label
            })
        }
    }
}
</script>

<style scoped>
.y-hold {
    display: inline-flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    /* R-UI-10 and ADR-0009: sized to its words, never to its container. */
    max-width: 220px;
    padding: 8px 14px;
    border: 1px solid var(--yonder-divider, #2b333c);
    border-radius: 3px;
    background: var(--yonder-track, #161b21);
    color: var(--yonder-value, #fff);
    font-family: var(--yonder-font, system-ui, sans-serif);
    cursor: pointer;
    /* A held key must not be interpreted as a scroll or a text selection. */
    touch-action: none;
    user-select: none;
}
.y-hold.held {
    border-color: var(--yonder-select, #2ad4f0);
    color: var(--yonder-select, #2ad4f0);
}
.y-hold__label {
    font-size: 13px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
}
.y-hold__cost {
    /* Never uppercased: Mb/s rendered as MB/S says megabytes. */
    font-family: var(--yonder-font-mono, ui-monospace, monospace);
    font-size: 11px;
    color: var(--yonder-label, #7f8a95);
    text-transform: none;
}
</style>
```

Register both halves in `package.json`: `"ui-yonder-holdkey": "dist/holdkey.js"` under `node-red.nodes`, and `"ui-yonder-holdkey": { "output": "ui-yonder-holdkey.umd.js", "component": "YonderHoldKey" }` under `node-red-dashboard-2.widgets`.

- [ ] **Step 5: Run the tests and the build**

Run: `npm test -w node-red-dashboard-2-yonder && npm run build -w node-red-dashboard-2-yonder`
Expected: PASS, and `ui-yonder-holdkey.umd.js` in the build output.

- [ ] **Step 6: Prove it in a browser before anything depends on it**

Put one on a scratch page, wire its output to a debug node, and check on a desktop **and on a tablet**:

- press and hold → one `fullrate:down`, no repeats;
- release → one `fullrate:up`;
- press, drag off the button, release outside → `down` then `up`, exactly once each;
- press, then switch browser tab → `up` arrives without a release;
- on the tablet: one pair per press, not two.

**Do not proceed to Task 13 until all five hold.** The last one is what catches the synthetic-mouse-event double-send, and it does not reproduce on a desktop.

- [ ] **Step 7: Commit**

```bash
git add packages/node-red-dashboard-2-yonder/
git commit -s -m "feat(console): a soft key that acts while it is held

The full-rate picture stays available while the operator asks for it
(R-VID-11), and holding is the right gesture: a toggle left on would spend most
of a field uplink on a picture nobody is watching, with no reason to suspect
it. The key states the cost before it is pressed.

Four releases, not one — pointerup, pointercancel, pointerleave, and a page
that went to the background still holding it. Missing any of them leaves the
aircraft sending a full-rate stream nobody is watching. setPointerCapture is
deliberately not used: it would make pointerleave never fire, which sounds
safer and is the opposite.

Pointer events rather than mouse and touch, because a touch fires a synthetic
mouse event afterwards and a component listening to both asks twice and
releases once. That does not reproduce on a desktop.

Built and proven before anything depends on it — ADR-0009 records that every
soft key on this console once shipped dead, because Dashboard drops a
widget-action from a widget that never registered onAction.

Refs: R-VID-11, R-UI-05, R-UI-10

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 13: The picture

**Requirements:** R-VID-03, R-VID-09, R-VID-14, R-UI-05, R-UI-06

**Files:**
- Create: `packages/node-red-dashboard-2-yonder/src/picture.ts`, `picture.html`
- Create: `packages/node-red-dashboard-2-yonder/src/ui/YonderPicture.vue`
- Modify: `packages/node-red-dashboard-2-yonder/package.json`
- Test: `packages/node-red-dashboard-2-yonder/src/nodes.test.ts`

**Interfaces:**
- Consumes: the WHEP route from Task 10 (`POST /video/<path>/whep`).
- Produces: node type `ui-yonder-picture`, component `YonderPicture`. Props: `{ path, label, mode: "live"|"stills"|"off", stillsUrl, cost }`.

**What this component owns.** The live picture and the three things that happen to it: it reconnects on its own, it degrades visibly when contact is lost, and it falls back to stills without being asked.

**The hazard, stated once.** A stale picture read as a live one. So four signals at once — desaturate, darken, hatch, and a running count — because a badge alone is what an operator stops seeing after ten minutes. Going black is rejected: it cannot be misread, and it deletes the one thing still held — where the camera was pointing, what was in shot, where the horizon was.

**Three things this must not claim.** It must not claim to know about the other outputs (a console losing its link says nothing about the aircraft's ground-station feed — the row reads *not known from here*). It must not draw *Off* like a lost link (*not requested*, neutral tone — turning off your own view changes nothing about what the aircraft sends anyone else). And it must report **why** live video failed, because a browser blocked by a network, a carrier discarding UDP and a camera that has stopped producing frames all present as no picture, and only one of them is worth walking outside for.

- [ ] **Step 1: Write the failing node test**

Add the module-scope import beside the others, then the cases, using the same `build()` helper Task 12 used:

```ts
const pictureNode = (await import("./picture.js")).default ?? await import("./picture.js");
```

```ts
describe("the picture", () => {
  it("registers as a widget that sends", () => {
    // It sends: the mode changes and 'try live again' are actions.
    const { type, events } = build(pictureNode, { path: "cam0" });
    expect(type).toBe("ui-yonder-picture");
    expect(events).toMatchObject({ onAction: true });
  });

  it("defaults to the cheap preview path, never the full-rate one", () => {
    // R-VID-13 makes the cheap copy the default. A component that defaulted
    // to the full stream would spend most of a field uplink the moment
    // somebody opened a page, with no reason to suspect it.
    expect(build(pictureNode, { path: "cam0" }).props).toMatchObject({ path: "cam0-preview" });
  });

  it("does not append -preview twice", () => {
    expect(build(pictureNode, { path: "cam0-preview" }).props).toMatchObject({ path: "cam0-preview" });
  });

  it("falls back to twelve seconds when the field is blank", () => {
    // Long enough for a slow negotiation to finish, short enough that nobody
    // is left staring at nothing. `num` treats an empty string as absent, not
    // as zero — a zero here would fall back to stills instantly.
    expect(build(pictureNode, { path: "cam0", stillsAfterMs: "" }).props)
      .toMatchObject({ stillsAfterMs: 12_000 });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -w node-red-dashboard-2-yonder`
Expected: FAIL — `./picture.js` does not exist.

- [ ] **Step 3: Write the node**

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
import { num, registerWidget, str } from "./widget.js";
import type { RED } from "./red.js";

/**
 * `ui-yonder-picture` — the live picture, and what happens to it (R-VID-03).
 *
 * **The cheap copy is the default, always** (R-VID-13). A component that
 * defaulted to the full-rate stream would spend most of a field uplink the
 * moment somebody opened a page, and the operator would have no reason to
 * suspect it. The full rate is reached by holding a key (holdkey.ts), which is
 * both deliberate and self-limiting.
 */
export = function register(RED: RED): void {
  registerWidget(RED, {
    type: "ui-yonder-picture",
    emitsActions: true,
    props: (_node, config) => {
      const path = str(config.path);
      return {
        /** Always the preview path. The full rate is a held key, not a default. */
        path: path.endsWith("-preview") ? path : `${path}-preview`,
        label: str(config.label),
        /** How long to wait for live video before serving stills (R-VID-14). */
        stillsAfterMs: num(config.stillsAfterMs, 12_000),
        cost: str(config.cost),
      };
    },
  });
};
```

- [ ] **Step 4: Write the component**

`packages/node-red-dashboard-2-yonder/src/ui/YonderPicture.vue`. The template is a `<video>` under an overlay layer; the script owns the WHEP negotiation, the reconnect loop and the degrade timer.

```vue
<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
    <div class="y-pic" :class="'y-pic--' + mode">
        <video
            ref="video"
            class="y-pic__video"
            :style="{ filter: degradeFilter }"
            autoplay
            muted
            playsinline
        ></video>
        <img v-if="mode === 'stills' && stillSrc" class="y-pic__video" :src="stillSrc" alt="" />
        <div v-if="staleFor > 0" class="y-pic__hatch"></div>
        <div class="y-pic__hud">
            <span class="y-pic__badge" :class="'tone-' + tone">{{ caption }}</span>
            <span v-if="staleFor > 0" class="y-pic__age">{{ ageText }}</span>
        </div>
        <div v-if="reason" class="y-pic__reason">{{ reason }}</div>
        <div v-if="mode === 'off'" class="y-pic__off">
            not requested · the ground station is still being fed
        </div>
    </div>
</template>

<script>
/**
 * The live picture, and the three things that happen to it (R-VID-03).
 *
 * **The hazard is a stale picture read as a live one.** So when contact goes,
 * four signals at once: it desaturates, it darkens, it takes a hatch, and it
 * carries a count that keeps running. A badge alone is what an operator stops
 * seeing after ten minutes. By the time contact has been gone a minute the
 * shot is barely readable and the count is the loudest thing on it, which is
 * correct — its only remaining value is telling the operator what they were
 * looking at when contact went.
 *
 * **Going black is rejected.** It cannot be misread, and it deletes the one
 * thing still held: where the camera was pointing, what was in shot, where the
 * horizon was.
 *
 * **Nothing on the aircraft changes when this browser's link goes.** The
 * pipeline's state is what the operator last set it to; the ground station's
 * link is not the console's link. This component therefore never draws a claim
 * about the other outputs — a console losing its link says nothing whatever
 * about the aircraft's ground-station feed, and the row that reports it reads
 * 'not known from here'. Greying it out, or leaving it green, would be
 * inventing a fact.
 *
 * **The session reconnects on its own, with backoff, showing the attempt
 * count.** No button: the operator asked for a live picture and never withdrew
 * the request. The picture returns immediately when it does, because the
 * preview branch runs a short keyframe interval of its own (pipeline.ts) — so
 * a reconnecting browser is a late joiner that does not have to wait out a
 * group of pictures.
 *
 * **Falling back to stills happens without being asked**, twelve seconds after
 * live video fails to establish: long enough for a slow negotiation to finish,
 * short enough that nobody is left staring at nothing. It changes nothing on
 * the aircraft, so the default should simply be the useful one — and it
 * reports *why*, because a browser blocked by a network, a carrier discarding
 * UDP and a camera that has stopped producing frames all present as no
 * picture, and only one of them is worth walking outside for.
 *
 * **Off is not the link being down**, and must not look like it: the neutral
 * tone rather than the fault tone, 'not requested' rather than 'no contact'.
 * Turning off your own view changes nothing about what the aircraft sends
 * anyone else, and the caption says so.
 */
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000]

export default {
    name: 'YonderPicture',
    inject: ['$socket', '$dataTracker'],
    props: {
        id: { type: String, required: true },
        props: { type: Object, default: () => ({}) },
        state: { type: Object, default: () => ({}) }
    },
    data () {
        return {
            mode: 'live',
            pc: null,
            attempt: 0,
            lastFrameAt: null,
            now: Date.now(),
            reason: '',
            stillSrc: '',
            timer: null,
            tick: null
        }
    },
    computed: {
        staleFor () {
            if (this.mode !== 'live' || this.lastFrameAt === null) return 0
            return Math.max(0, Math.floor((this.now - this.lastFrameAt) / 1000) - 2)
        },
        degradeFilter () {
            if (this.staleFor === 0) return 'none'
            // Saturation to zero and brightness to a third over a minute. Both
            // curves are deliberately slow at the start: a two-second network
            // hiccup should not make the picture flinch.
            const t = Math.min(1, this.staleFor / 60)
            return `saturate(${(1 - t).toFixed(2)}) brightness(${(1 - 0.65 * t).toFixed(2)})`
        },
        tone () {
            if (this.mode === 'off') return 'neutral'
            if (this.staleFor > 0) return 'bad'
            if (this.mode === 'stills') return 'waiting'
            return 'good'
        },
        caption () {
            if (this.mode === 'off') return 'off'
            if (this.mode === 'stills') return 'stills'
            if (this.staleFor > 0) return 'no contact'
            return this.attempt > 0 ? `reconnecting · attempt ${this.attempt}` : 'live · preview'
        },
        ageText () {
            const s = this.staleFor
            return s < 60 ? `${s} s ago` : `${Math.floor(s / 60)} min ${s % 60} s ago`
        }
    },
    created () {
        this.$dataTracker(this.id)
    },
    mounted () {
        this.tick = setInterval(() => { this.now = Date.now() }, 1000)
        this.connect()
    },
    beforeUnmount () {
        clearInterval(this.tick)
        clearTimeout(this.timer)
        this.teardown()
    },
    methods: {
        teardown () {
            if (this.pc) { this.pc.close(); this.pc = null }
        },
        async connect () {
            this.teardown()
            const pc = new RTCPeerConnection()
            this.pc = pc
            pc.addTransceiver('video', { direction: 'recvonly' })
            pc.ontrack = (e) => {
                this.$refs.video.srcObject = e.streams[0]
                this.lastFrameAt = Date.now()
                this.attempt = 0
                this.reason = ''
            }
            pc.onconnectionstatechange = () => {
                if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) this.retry()
            }
            try {
                const offer = await pc.createOffer()
                await pc.setLocalDescription(offer)
                // Through the console's own route, not straight at the media
                // server: the exchange carries the keys that encrypt the video,
                // and it is what puts the picture behind the interface's
                // credential (R-SEC-13).
                const answer = await fetch(`/video/${this.props.path}/whep`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/sdp' },
                    body: offer.sdp
                })
                if (!answer.ok) {
                    // Distinguished deliberately. Only one of these is worth
                    // walking outside for.
                    this.reason = answer.status === 401
                        ? 'this session is not logged in'
                        : answer.status === 404
                            ? 'this camera is not streaming; start it on the rail'
                            : 'the media server is not answering'
                    return this.retry()
                }
                await pc.setRemoteDescription({ type: 'answer', sdp: await answer.text() })
            } catch (e) {
                this.reason = `this browser could not negotiate a stream (${e.name || 'error'})`
                this.retry()
            }
            clearTimeout(this.timer)
            this.timer = setTimeout(() => {
                // Twelve seconds: long enough for a slow negotiation to
                // finish, short enough that nobody is left staring at nothing.
                // Falling back changes nothing on the aircraft, so the default
                // is simply the useful one (R-VID-14).
                if (this.mode === 'live' && this.lastFrameAt === null) this.mode = 'stills'
            }, this.props.stillsAfterMs || 12000)
        },
        retry () {
            if (this.mode !== 'live') return
            const wait = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]
            this.attempt += 1
            clearTimeout(this.timer)
            // No button. The operator asked for a live picture and never
            // withdrew the request.
            this.timer = setTimeout(() => this.connect(), wait)
        },
        setMode (mode) {
            this.mode = mode
            this.reason = ''
            if (mode === 'live') { this.attempt = 0; this.lastFrameAt = null; this.connect() } else this.teardown()
            this.$socket.emit('widget-action', this.id, { payload: `mode:${mode}`, topic: this.props.label })
        }
    }
}
</script>

<style scoped>
.y-pic { position: relative; background: var(--yonder-display, #04060a); aspect-ratio: 16 / 9; overflow: hidden; }
.y-pic__video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; transition: filter 1s linear; }
/* The hatch is the third of four signals, and the one that cannot be mistaken
   for a dark scene or a badly exposed shot. */
.y-pic__hatch {
    position: absolute; inset: 0; pointer-events: none;
    background: repeating-linear-gradient(45deg,
        transparent 0 14px,
        color-mix(in srgb, var(--yonder-bad, #ff4034) 22%, transparent) 14px 16px);
}
.y-pic__hud { position: absolute; top: 8px; left: 8px; display: flex; gap: 8px; align-items: baseline; }
.y-pic__badge {
    font-family: var(--yonder-font, system-ui, sans-serif);
    font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase;
    padding: 2px 6px; border-radius: 2px;
    background: color-mix(in srgb, var(--yonder-display, #04060a) 70%, transparent);
}
.y-pic__age {
    /* Not uppercased: `s` and `min` are units. */
    font-family: var(--yonder-font-mono, ui-monospace, monospace);
    font-size: 15px; font-weight: 600; text-transform: none;
    color: var(--yonder-bad, #ff4034);
}
.y-pic__reason, .y-pic__off {
    position: absolute; left: 8px; right: 8px; bottom: 8px;
    font-family: var(--yonder-font, system-ui, sans-serif); font-size: 12px;
    color: var(--yonder-label, #7f8a95);
    background: color-mix(in srgb, var(--yonder-display, #04060a) 70%, transparent);
    padding: 4px 6px; border-radius: 2px;
}
.tone-neutral { color: var(--yonder-neutral, #6b7580); }
.tone-waiting { color: var(--yonder-waiting, #ffcf28); }
.tone-good    { color: var(--yonder-good, #35d06a); }
.tone-bad     { color: var(--yonder-bad, #ff4034); }
</style>
```

Register both halves in `package.json` as Task 12 did.

- [ ] **Step 5: Run the tests and the build**

Run: `npm test -w node-red-dashboard-2-yonder && npm run build -w node-red-dashboard-2-yonder`
Expected: PASS.

- [ ] **Step 6: Prove the degrade path on the board**

Start a camera, open the page, watch live video, then **pull the board's network cable** (or `sudo nmcli con down` the interface it is reached on) and watch:

- the picture holds rather than going black;
- it desaturates and darkens over the following minute;
- a hatch appears;
- the count runs and stays the loudest thing on the frame;
- the badge reads `no contact`, never anything about the ground station.

Then restore the link: the session reconnects on its own, and **the picture returns without a visible grey rectangle** — that is the short GOP from Task 6 doing its job, and it is the one part of R-VID-09 that only the board can prove.

- [ ] **Step 7: Commit**

```bash
git add packages/node-red-dashboard-2-yonder/
git commit -s -m "feat(console): the picture, and what happens to it when contact goes

R-VID-03 over WebRTC through the console's own route, so the picture is behind
the interface's credential. Always the preview path: a component defaulting to
the full-rate stream would spend most of a field uplink the moment a page
opened.

The hazard is a stale picture read as a live one, so four signals at once —
desaturate, darken, hatch, and a count that keeps running. A badge alone is
what an operator stops seeing after ten minutes. Going black is rejected: it
cannot be misread, and it deletes the one thing still held, which is where the
camera was pointing when contact went.

It reconnects on its own, with backoff and an attempt count, and no button:
the operator asked for a live picture and never withdrew the request. The
picture comes back without a grey rectangle because the preview branch runs a
short keyframe interval of its own — R-VID-09 on the path where a person is
watching.

Stills after twelve seconds, without being asked, reporting why: a browser
blocked by a network, a carrier discarding UDP and a camera producing no
frames all present as no picture, and only one is worth walking outside for.
Off is drawn neutral and says 'not requested' — turning off your own view
changes nothing about what the aircraft sends anyone else. And nothing here
ever claims to know about the ground station's feed.

Refs: R-VID-03, R-VID-09, R-VID-14, R-UI-05, R-UI-06

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 14: The facts row and the uplink budget

**Requirements:** R-UI-15, R-UI-09, R-VID-11

**Files:**
- Create: `packages/node-red-dashboard-2-yonder/src/facts.ts`, `facts.html`, `ui/YonderFacts.vue`
- Create: `packages/node-red-dashboard-2-yonder/src/budget.ts`, `budget.html`, `ui/YonderBudget.vue`
- Modify: `packages/node-red-dashboard-2-yonder/src/shapes.ts`, `package.json`
- Test: `packages/node-red-dashboard-2-yonder/src/nodes.test.ts`

**Interfaces:**
- Produces: node types `ui-yonder-facts` and `ui-yonder-budget`.

```ts
// shapes.ts
export interface CapabilityFact { label: string; state: "not-offered" | "advertised"; reason?: string }
export interface BudgetSegment { label: string; kbps: number }
```

**Two components, one task, because they are the same idea at two scales.** The facts row is R-UI-15 on one camera: *nothing is silently missing*. The budget track is R-UI-09 on the whole uplink: *a bounded quantity is drawn against its bounds*.

**Why a fact and not a dead control.** A dead control takes the room of a control and carries the information of a label — on a fixed camera that is a dead aim dial, a dead zoom picker, dead focus and a dead record key, which pushes the live controls off a tablet. And it teaches an operator to stop reading muted styling, which then costs us the *advertised-but-not-answered* state, whose whole job is to be noticed.

**So the two states are drawn differently, and this is the point of the component.** *Not offered* is a stated fact in the neutral tone: one row of text where the control would have been. *Advertised, not answered* keeps its control, drawn inoperative, **in the caution tone and carrying the reason** — because something is misreporting itself and a firmware change may fix it. It is a fault, not a feature the camera lacks.

- [ ] **Step 1: Write the failing tests**

Module-scope imports beside the others, then the cases, using the same `build()` helper:

```ts
const factsNode = (await import("./facts.js")).default ?? await import("./facts.js");
const budgetNode = (await import("./budget.js")).default ?? await import("./budget.js");
```

```ts
describe("the facts row and the budget", () => {
  it("registers both without onAction, because both are read-only", () => {
    // A facts row that could emit is a facts row that could originate a
    // command. Read-only instruments leave it off, as every other one does.
    expect(build(factsNode, { facts: "[]" }).events).toEqual({});
    expect(build(budgetNode, { segments: "[]" }).events).toEqual({});
  });

  it("draws nothing, and says so, when the facts list is malformed", () => {
    // A widget that cannot render its own configuration must not stop the
    // console starting — a console that will not start is a device the
    // operator cannot reach. `list()` already has this behaviour; this is the
    // assertion that these two widgets use it rather than JSON.parse.
    const { node, props } = build(factsNode, { facts: "{not json" });
    expect(node.error).toHaveBeenCalledTimes(1);
    expect(props).toMatchObject({ facts: [] });
  });

  it("reads a facts list from the editor form", () => {
    const facts = JSON.stringify([
      { label: "aim", state: "not-offered" },
      { label: "zoom", state: "advertised", reason: "accepted, does not reshape the feed" },
    ]);
    const { props } = build(factsNode, { title: "This camera has no", facts });
    expect(props!.facts).toHaveLength(2);
    expect((props!.facts as { state: string }[])[1].state).toBe("advertised");
  });

  it("takes the uplink capacity as the mark the segments are drawn against", () => {
    const { props } = build(budgetNode, { label: "Uplink", capacityKbps: "5000", segments: "[]" });
    expect(props).toMatchObject({ capacityKbps: 5000 });
  });

  it("has no capacity rather than a false one when the field is blank", () => {
    // Zero is the honest answer: nothing has measured this path yet, and a
    // made-up ceiling is a mark an operator would trust.
    expect(build(budgetNode, { segments: "[]" }).props).toMatchObject({ capacityKbps: 0 });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -w node-red-dashboard-2-yonder`
Expected: FAIL — neither module exists.

- [ ] **Step 3: Write both nodes**

`facts.ts`:

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
import { list, registerWidget, str } from "./widget.js";
import type { RED } from "./red.js";
import type { CapabilityFact } from "./shapes.js";

/**
 * `ui-yonder-facts` — what this camera cannot do, stated (R-UI-15).
 *
 * **Nothing is ever silently missing.** An operator must be able to tell *this
 * camera cannot* from *this page failed*, and an empty space says nothing
 * about which.
 *
 * A fact rather than a dead control, for two reasons. A dead control takes the
 * room of a control and carries the information of a label — on a fixed camera
 * that is a dead aim dial, a dead zoom picker, dead focus and a dead record
 * key, which pushes the live controls off a tablet. And it teaches an operator
 * to stop reading muted styling, which then costs us the advertised state,
 * whose whole job is to be noticed.
 *
 * The soft-key rail is the exception R-UI-15 names: it carries only actions
 * that can be taken. A camera that cannot record has no Record key, and the
 * fact that it cannot is stated here.
 *
 * Read-only, deliberately. A facts row that could emit is a facts row that
 * could originate a command.
 */
export = function register(RED: RED): void {
  registerWidget(RED, {
    type: "ui-yonder-facts",
    props: (node, config) => ({
      title: str(config.title),
      facts: list<CapabilityFact>(config.facts, node, "facts"),
    }),
  });
};
```

`budget.ts`:

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
import { list, num, registerWidget, str } from "./widget.js";
import type { RED } from "./red.js";
import type { BudgetSegment } from "./shapes.js";

/**
 * `ui-yonder-budget` — what is leaving, against what the path can carry
 * (R-VID-11, R-UI-09).
 *
 * R-VID-11 asks for each output's bandwidth and their total *against the
 * capacity of the path they leave by*, and R-UI-09 says a bounded quantity
 * cannot be a bare figure. So this is one track: a segment per output, a mark
 * at the measured capacity, and anything past the mark hatched in the fault
 * tone.
 *
 * The bar is a **readout, not an input**. That removes an ambiguity a slider
 * has: with a slider you cannot tell whether the bar shows what you asked for
 * or what you are getting. Bitrate is chosen with a picker beside it.
 *
 * The tee costs almost nothing — 68% of a core for one output against 70% for
 * two — but each consumer that leaves over cellular costs its own bitrate. At
 * 2 Mb/s that is 6 Mb/s for one camera against a field LTE uplink that is
 * often 1-5, and this is the instrument that makes that visible before it is
 * discovered.
 *
 * **It says which layer it counts.** Measured on the board over an 8 s
 * steady-state window, one 2000 kb/s stream is 2003 kb/s of elementary stream,
 * 2022 kb/s once RTP framing is added, and ~2067 kb/s at IP and UDP — 3.2%
 * apart end to end. Rate control itself is within 0.2%, so every discrepancy an
 * operator sees between the configured figure and this track is framing, not
 * the encoder missing its target. A bar that does not name its layer invites
 * exactly the wrong conclusion, and the number an uplink actually carries is
 * the IP one.
 */
export = function register(RED: RED): void {
  registerWidget(RED, {
    type: "ui-yonder-budget",
    props: (node, config) => ({
      label: str(config.label),
      capacityKbps: num(config.capacityKbps, 0),
      segments: list<BudgetSegment>(config.segments, node, "segments"),
    }),
  });
};
```

- [ ] **Step 4: Write both components**

`ui/YonderFacts.vue` — a list of rows, tone by state:

```vue
<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
    <div class="y-facts">
        <div v-if="props.title" class="y-facts__title">{{ props.title }}</div>
        <div v-for="fact in props.facts" :key="fact.label" class="y-facts__row" :class="'is-' + fact.state">
            <span class="y-facts__label">{{ fact.label }}</span>
            <span class="y-facts__state">{{ fact.state === 'advertised' ? 'not answering' : 'this camera has none' }}</span>
            <span v-if="fact.reason" class="y-facts__reason">{{ fact.reason }}</span>
        </div>
    </div>
</template>

<script>
/**
 * What this camera cannot do, stated where the control would have been
 * (R-UI-15).
 *
 * **The two states look different, and that is the whole component.**
 * `not-offered` is a fact in the neutral tone — the camera does not have it,
 * nothing is wrong, and the row exists only so nobody goes looking.
 * `advertised` is a *fault* in the caution tone, carrying its reason: the
 * device lists the capability, accepts the command, and does nothing.
 * Something is misreporting itself and a firmware or kernel change may make it
 * work.
 *
 * Drawing them the same would be the failure this exists to prevent — and the
 * advertised state is the one most likely to be got wrong in code, because on
 * the wire it is indistinguishable from success.
 */
export default {
    name: 'YonderFacts',
    inject: ['$dataTracker'],
    props: {
        id: { type: String, required: true },
        props: { type: Object, default: () => ({}) },
        state: { type: Object, default: () => ({}) }
    },
    created () { this.$dataTracker(this.id) }
}
</script>

<style scoped>
.y-facts { font-family: var(--yonder-font, system-ui, sans-serif); font-size: 12px; }
.y-facts__title {
    font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--yonder-label, #7f8a95); margin-bottom: 6px;
}
.y-facts__row { display: flex; gap: 10px; align-items: baseline; padding: 3px 0; }
.y-facts__label { min-width: 90px; color: var(--yonder-value, #fff); }
.y-facts__row.is-not-offered .y-facts__state { color: var(--yonder-neutral, #6b7580); }
.y-facts__row.is-advertised { border-left: 3px solid var(--yonder-waiting, #ffcf28); padding-left: 7px; }
.y-facts__row.is-advertised .y-facts__state { color: var(--yonder-waiting, #ffcf28); font-weight: 600; }
.y-facts__reason { color: var(--yonder-label, #7f8a95); font-style: italic; }
</style>
```

`ui/YonderBudget.vue` — one track, a segment per output, a mark at capacity, anything past it hatched:

```vue
<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
    <div class="y-budget">
        <div class="y-budget__head">
            <span class="y-budget__label">{{ props.label }}</span>
            <span class="y-budget__total">{{ mbps(total) }} of {{ mbps(props.capacityKbps) }} Mb/s</span>
        </div>
        <div class="y-budget__track">
            <div
                v-for="(seg, i) in props.segments"
                :key="seg.label + i"
                class="y-budget__seg"
                :class="{ over: startsPast(i) }"
                :style="{ width: pct(seg.kbps), left: pct(before(i)) }"
                :title="seg.label + ' — ' + mbps(seg.kbps) + ' Mb/s'"
            ></div>
            <div class="y-budget__mark" :style="{ left: pct(props.capacityKbps) }"></div>
        </div>
        <div class="y-budget__legend">
            <span v-for="(seg, i) in props.segments" :key="'l' + i" class="y-budget__key">
                {{ seg.label }} {{ mbps(seg.kbps) }} Mb/s
            </span>
        </div>
    </div>
</template>

<script>
/**
 * What is leaving, against what the path can carry (R-VID-11, R-UI-09).
 *
 * A bounded quantity cannot be a bare figure, so this is one track with a
 * segment per output and a mark at the measured capacity. Anything past the
 * mark is hatched in the fault tone, which is the only drawing of
 * oversubscription an operator can read at a glance.
 *
 * A **readout, not an input.** With a slider you cannot tell whether the bar
 * shows what you asked for or what you are getting.
 */
export default {
    name: 'YonderBudget',
    inject: ['$dataTracker'],
    props: {
        id: { type: String, required: true },
        props: { type: Object, default: () => ({}) },
        state: { type: Object, default: () => ({}) }
    },
    created () { this.$dataTracker(this.id) },
    computed: {
        total () { return (this.props.segments || []).reduce((n, s) => n + (s.kbps || 0), 0) },
        // The track is scaled to whichever is larger, so an oversubscribed
        // uplink still fits on screen and the mark moves left instead of the
        // bar running off the end.
        scale () { return Math.max(this.total, this.props.capacityKbps || 0) || 1 }
    },
    methods: {
        mbps (kbps) { return ((kbps || 0) / 1000).toFixed(1) },
        pct (kbps) { return `${Math.min(100, (100 * (kbps || 0)) / this.scale).toFixed(2)}%` },
        before (i) { return (this.props.segments || []).slice(0, i).reduce((n, s) => n + (s.kbps || 0), 0) },
        startsPast (i) { return this.before(i) >= (this.props.capacityKbps || Infinity) }
    }
}
</script>

<style scoped>
.y-budget { font-family: var(--yonder-font, system-ui, sans-serif); }
.y-budget__head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 4px; }
.y-budget__label { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--yonder-label, #7f8a95); }
/* Never uppercased: Mb/s rendered as MB/S says megabytes. */
.y-budget__total { font-family: var(--yonder-font-mono, ui-monospace, monospace); font-size: 12px; text-transform: none; color: var(--yonder-value, #fff); }
.y-budget__track {
    position: relative; height: 14px;
    /* ADR-0009: a track has a fixed maximum and never stretches to fill. */
    max-width: 420px;
    background: var(--yonder-track, #161b21);
    border: 1px solid var(--yonder-divider, #2b333c);
}
.y-budget__seg { position: absolute; top: 0; bottom: 0; background: var(--yonder-select, #2ad4f0); opacity: 0.75; border-right: 1px solid var(--yonder-display, #04060a); }
.y-budget__seg.over {
    background: repeating-linear-gradient(45deg,
        var(--yonder-bad, #ff4034) 0 5px, transparent 5px 10px);
}
.y-budget__mark { position: absolute; top: -3px; bottom: -3px; width: 2px; background: var(--yonder-value, #fff); }
.y-budget__legend { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 4px; font-family: var(--yonder-font-mono, ui-monospace, monospace); font-size: 11px; color: var(--yonder-label, #7f8a95); text-transform: none; }
</style>
```

Add both to `package.json`'s two registries, and add `CapabilityFact` and `BudgetSegment` to `shapes.ts`.

- [ ] **Step 5: Run the tests and the build**

Run: `npm test -w node-red-dashboard-2-yonder && npm run build -w node-red-dashboard-2-yonder`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/node-red-dashboard-2-yonder/
git commit -s -m "feat(console): a facts row and an uplink budget track

R-UI-15 on one camera and R-UI-09 on the whole uplink — the same idea at two
scales: nothing silently missing, nothing bounded shown bare.

A fact, not a dead control. A dead control takes the room of a control and
carries the information of a label; on a fixed camera that is a dead aim dial,
a dead zoom picker, dead focus and a dead record key, which pushes the live
controls off a tablet. And it teaches an operator to stop reading muted
styling, which costs us the state whose whole job is to be noticed.

So the two states are drawn differently, and that is the point of the
component. Not-offered is a fact in the neutral tone. Advertised-but-not-
answered keeps its control, drawn inoperative in the caution tone, carrying
the reason — it is a fault, not a feature the camera lacks, and on the wire it
is indistinguishable from success.

The budget is a readout, not an input: with a slider you cannot tell whether
the bar shows what you asked for or what you are getting. The tee costs almost
nothing, but each consumer that leaves over cellular costs its own bitrate.

Refs: R-UI-15, R-UI-09, R-VID-11

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 15: The daemon routes, and the nodes in front of them

**Requirements:** R-CAM-12, R-CTL-01, R-CTL-10, R-VID-15, R-SEC-10, R-SEC-12

**Files:**
- Modify: `packages/yonder-core/src/daemon/routes.ts`
- Modify: `packages/yonder-core/src/daemon/routes.test.ts`
- Modify: `packages/yonder-core/src/daemon/server.ts` (hold one `Supervisor` for the process's lifetime)
- Create: `packages/node-red-contrib-yonder-video/package.json`, `tsconfig.json`, `vitest.config.ts`
- Create: `packages/node-red-contrib-yonder-video/src/red.ts`, `cameras.ts`, `camera.ts`, `stream.ts`, `receive-line.ts` and their `.html` forms
- Test: `packages/node-red-contrib-yonder-video/src/nodes.test.ts`

**Interfaces:**
- Consumes: `detectCameras`, `probeCamera` (Task 4), `probeEncoder` (Task 5), `compose`/`refuse` (Task 6), `Supervisor` (Task 7), `renderReceive` (Task 8), `SecretStore`.
- Produces: five daemon routes and four Node-RED node types.

| Route | Answers |
|---|---|
| `GET /cameras` | `{ found, rejected }` from `detectCameras`, each `found` carrying its `summarise()` line (R-CAM-12) |
| `GET /cameras/:id` | one camera's capability set and its settings **read back from the device** (R-CTL-10) |
| `POST /cameras/:id/probe` | re-probe this one camera — the Setup deck's *Re-probe* key |
| `POST /cameras/:id/run` | `{ action: "start" \| "stop" }`, through `Supervisor`; answers the run state (R-CTL-01) |
| `GET /cameras/:id/receive-line` | the four renderings, with the RTSP credential resolved (R-VID-15) |

**And close R-SYS-09's second half.** Task 11 built `system/supply.ts` and nothing consumes it, so the requirement's *"record an occurrence in the log"* is still open — which is the half that matters in flight, because an undervoltage restarts the board and a restart presents as an aircraft that went quiet with nothing to explain it. Sample the supply where the daemon already samples other system state, and write a log entry when a latched bit is set that was not set at the last read. Log the transition, not the state: a board that has been dirty since boot would otherwise fill the log with the same line. `log/activity.ts` is the existing writer — read it rather than inventing a second one.

**The Supervisor lives in the daemon, for the process's lifetime.** `buildRenderers` is where it is constructed, beside the renderers. A Node-RED redeploy destroys and recreates every node; a supervisor inside one would drop every camera's pipeline the moment somebody edited a flow.

- [ ] **Step 1: Write the failing route tests**

Add to `packages/yonder-core/src/daemon/routes.test.ts`, following the `if (method === "..." && path === "...")` shape the file already asserts against:

```ts
describe("the camera routes", () => {
  it("lists what was found and what was rejected, with reasons", async () => {
    const r = await router({ cameras: fixtureDetection() }).handle("GET", "/cameras");
    expect(r.status).toBe(200);
    const body = r.body as { found: unknown[]; rejected: { reason: string }[] };
    expect(body.found).toHaveLength(1);
    expect(body.rejected[0].reason).toContain("hardware codec");
  });

  it("starts and stops a camera, and answers the run state", async () => {
    const r = router({ cameras: fixtureDetection() });
    const started = await r.handle("POST", "/cameras/cam0/run", { action: "start" });
    expect(started.status).toBe(200);
    expect((started.body as { state: string }).state).toBe("starting");
    const stopped = await r.handle("POST", "/cameras/cam0/run", { action: "stop" });
    expect((stopped.body as { state: string }).state).toBe("stopped");
  });

  it("refuses a configuration the board cannot sustain, before starting anything", async () => {
    // R-CAM-10. config.yaml is a file an operator may edit by hand, and a
    // pipeline that fails to start says 'Internal data stream error' and
    // nothing else.
    const r = router({ cameras: fixtureDetection(), camera: { width: 3840, height: 2160 } });
    const out = await r.handle("POST", "/cameras/cam0/run", { action: "start" });
    expect(out.status).toBe(400);
    expect(JSON.stringify(out.body)).toContain("3840x2160");
  });

  it("refuses an unknown camera rather than starting a pipeline for it", async () => {
    const out = await router({ cameras: fixtureDetection() })
      .handle("POST", "/cameras/../../etc/run", { action: "start" });
    expect(out.status).toBe(404);
  });

  it("resolves the RTSP credential into the receive line, and nowhere else", async () => {
    // R-SEC-10: never in a log, an error, or a support bundle. This route is
    // the one place the value is allowed out, because the operator is being
    // handed a URL to copy.
    const r = router({ cameras: fixtureDetection() });
    const line = await r.handle("GET", "/cameras/cam0/receive-line");
    expect(JSON.stringify(line.body)).toContain("rtsp://yonder:");
    const list = await r.handle("GET", "/cameras");
    expect(JSON.stringify(list.body)).not.toContain("rtsp://yonder:");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -w yonder-core -- src/daemon/routes.test.ts`
Expected: FAIL — every camera route returns the router's 404.

- [ ] **Step 3: Add the five routes**

In `packages/yonder-core/src/daemon/routes.ts`, following the existing shape exactly. Three rules to carry:

```ts
// The camera id comes off a URL, so it is matched against the same pattern the
// schema allows rather than trusted. It reaches `compose()` and becomes a
// media path and a file path; this is the one place a traversal could get in.
const CAMERA_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

// A start is refused before it is attempted (R-CAM-10). A pipeline that fails
// to start says "Internal data stream error" and nothing else, and an operator
// deserves to be told which of their settings the camera does not offer.
const why = refuse({ camera, capabilities, encoder, rtspBase });
if (why !== null) return { status: 400, body: { error: why } };

// The credential leaves the daemon on exactly one route. Everything else
// answers with the reference, never the value (R-SEC-10).
```

Construct one `Supervisor` in `buildRenderers` and pass it to `router()` the way the throttle already is.

- [ ] **Step 4: Run the daemon suite**

Run: `npm test -w yonder-core -- src/daemon/`
Expected: PASS.

- [ ] **Step 5: Scaffold the contrib package**

Copy `packages/node-red-contrib-yonder-network`'s `tsconfig.json`, `vitest.config.ts` and `src/red.ts` verbatim. Delete `src/.gitkeep`. `package.json`:

```json
{
  "name": "node-red-contrib-yonder-video",
  "version": "0.1.0",
  "license": "GPL-3.0-or-later",
  "description": "Yonder console nodes for cameras: detection, capability, run state and the receive line. Thin adapters over the yonder-core daemon socket; every decision lives in yonder-core.",
  "keywords": ["node-red", "yonder"],
  "node-red": {
    "version": ">=5.0.0",
    "nodes": {
      "yonder-cameras": "dist/cameras.js",
      "yonder-camera": "dist/camera.js",
      "yonder-stream": "dist/stream.js",
      "yonder-receive-line": "dist/receive-line.js"
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

- [ ] **Step 6: Write the failing node tests**

`packages/node-red-contrib-yonder-video/src/nodes.test.ts`, copying the harness from `node-red-contrib-yonder-network/src/nodes.test.ts` — a real Node-RED through `node-red-node-test-helper`, with `clientFor` mocked so **no test opens a socket**:

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import helper from "node-red-node-test-helper";
import type { DaemonClient, DaemonReply, DaemonRequest } from "yonder-core";

const replies: DaemonReply[] = [];
const asked: DaemonRequest[] = [];

vi.mock("yonder-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("yonder-core")>();
  return {
    ...actual,
    clientFor: (): DaemonClient => ({
      request: (req: DaemonRequest): Promise<DaemonReply> => {
        asked.push(req);
        return Promise.resolve(
          replies.shift() ?? { ok: false, reason: "unreachable", message: "no reply scripted" },
        );
      },
    } as unknown as DaemonClient),
  };
});

const camerasNode = (await import("./cameras.js")).default ?? await import("./cameras.js");
const cameraNode = (await import("./camera.js")).default ?? await import("./camera.js");
const streamNode = (await import("./stream.js")).default ?? await import("./stream.js");
const receiveNode = (await import("./receive-line.js")).default ?? await import("./receive-line.js");

const ok = (body: unknown): DaemonReply => ({ ok: true, status: 200, body });

interface Received {
  payload?: unknown;
  yonder?: { state?: string; message?: string };
}

/** Copied from the network package: load one node, send it a message, read the output. */
function send(node: unknown, type: string, message: Record<string, unknown> = {}): Promise<Received> {
  const flow = [{ id: "n1", type, wires: [["n2"]] }, { id: "n2", type: "helper" }];
  return new Promise((resolve, reject) => {
    void helper.load(node, flow, () => {
      const sink = helper.getNode("n2") as unknown as { on(e: string, f: (m: Received) => void): void };
      sink.on("input", (msg) => { resolve(msg); });
      (helper.getNode("n1") as unknown as { receive(m: unknown): void }).receive(message);
      setTimeout(() => { reject(new Error(`no message from ${type}`)); }, 4_000);
    });
  });
}

beforeAll((): Promise<void> => new Promise((r) => { void helper.startServer(r); }));
afterAll((): Promise<void> => new Promise((r) => { void helper.stopServer(r); }));
afterEach(async () => { await helper.unload(); replies.length = 0; asked.length = 0; });

describe("yonder-cameras", () => {
  it("reads the detection, rejections included", async () => {
    replies.push(ok({ found: [{ id: "cam0", summary: "aim: none · zoom: yes" }], rejected: [{ reason: "decoder" }] }));
    const msg = await send(camerasNode, "yonder-cameras");
    expect(asked).toEqual([{ method: "GET", path: "/cameras" }]);
    expect((msg.payload as { rejected: unknown[] }).rejected).toHaveLength(1);
  });
});

describe("yonder-camera", () => {
  it("reads settings back from the daemon rather than echoing what was sent", async () => {
    // R-CTL-10, and the spec leans on it harder than the wording implies: a
    // control shows what the camera reports, never what was sent.
    replies.push(ok({ id: "cam0", settings: { brightness: 128 } }));
    const msg = await send(cameraNode, "yonder-camera", { payload: { brightness: 200 }, camera: "cam0" });
    expect((msg.payload as { settings: { brightness: number } }).settings.brightness).toBe(128);
  });
});

describe("yonder-stream", () => {
  it("puts a command state on msg.yonder, like every other node", async () => {
    // ADR-0005: one command-state language, so a control means the same thing
    // on every page. A node inventing its own status text is the drift that
    // language was written to prevent.
    replies.push(ok({ state: "starting" }));
    const msg = await send(streamNode, "yonder-stream", { payload: "start", camera: "cam0" });
    expect(asked).toEqual([{ method: "POST", path: "/cameras/cam0/run", body: { action: "start" } }]);
    expect(msg.yonder?.state).toBeDefined();
  });

  it("reports a daemon that is not answering, rather than claiming a stop", async () => {
    const msg = await send(streamNode, "yonder-stream", { payload: "stop", camera: "cam0" });
    expect(msg.yonder?.state).not.toBe("ok");
    expect(msg.yonder?.message).toContain("unreachable");
  });
});

describe("yonder-receive-line", () => {
  it("asks the daemon for the finished text and never resolves a secret itself", async () => {
    // Node-RED must never read /etc/yonder/secrets.yaml. The daemon owns it;
    // this node receives text that already has the credential in it.
    replies.push(ok({ renderings: [{ kind: "url", body: "rtsp://yonder:Kx7@10.0.0.1:8554/cam0" }] }));
    const msg = await send(receiveNode, "yonder-receive-line", { camera: "cam0" });
    expect(asked).toEqual([{ method: "GET", path: "/cameras/cam0/receive-line" }]);
    expect(msg.payload).toBeDefined();
  });
});
```

- [ ] **Step 7: Write the four nodes**

Thin adapters, each following `node-red-contrib-yonder-network/src/read.ts`: `clientFor(...)`, one route, `fetched(...)` / `readFailure(...)` for the command state, no decisions of their own. `yonder-cameras` reads `GET /cameras`; `yonder-camera` reads `GET /cameras/:id` and posts settings; `yonder-stream` posts `/cameras/:id/run`; `yonder-receive-line` reads `/cameras/:id/receive-line`. Each `.html` is a `registerType` editor form copied from the network package's equivalent.

- [ ] **Step 8: Run the tests**

Run: `npm test -w node-red-contrib-yonder-video && npm run build -w node-red-contrib-yonder-video`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/yonder-core/src/daemon/ packages/node-red-contrib-yonder-video/
git commit -s -m "feat(video): five daemon routes, and four thin nodes in front of them

The supervisor lives in the daemon for the process's lifetime. A Node-RED
redeploy destroys and recreates every node, so a supervisor inside one would
drop every camera's pipeline the moment somebody edited a flow — including, on
a flying aircraft, the feed a ground station is watching.

The nodes are adapters, like every other contrib package here: clientFor, one
route, no decisions. yonder-receive-line in particular never reads
secrets.yaml — the daemon owns that file at 0600 and hands back finished text.

A camera id comes off a URL, so it is matched against the same pattern the
schema allows rather than trusted: it becomes a media path and a file path
downstream. A start is refused before it is attempted (R-CAM-10), because a
pipeline that fails to start says 'Internal data stream error' and nothing
else, and an operator deserves to know which setting their camera does not
offer.

The credential leaves the daemon on exactly one route, and a test asserts it
is absent from the others (R-SEC-10).

Refs: R-CAM-12, R-CAM-10, R-CTL-01, R-CTL-10, R-VID-15, R-SEC-10, R-SEC-12

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 16: The pages, and the camera CI does not have

**Requirements:** R-UI-03, R-UI-12, R-UI-15, R-CFG-03, R-SEC-10

**Files:**
- Modify: `flows/flows.json`
- Modify: `scripts/capture-pages.mjs`
- Create: `scripts/fixtures/camera-globalshutter.json`
- Modify: `docs/roadmap.md` (tick M4's entry gate)

**Interfaces:**
- Consumes: the nodes from Task 15 and the widgets from Tasks 12–14.
- Produces: two pages — a **Cameras** index and one page per detected camera.

**The problem this task exists to fix.** R-UI-03 builds navigation from detected hardware and R-UI-12 photographs every page in both palettes on every build. **With no camera attached there is no camera page, so the gate covers none of the pages in this plan and does not complain**, because from its point of view there is nothing there. A synthetic camera source and a checked-in capability fixture are therefore part of this work, not a testing afterthought.

- [ ] **Step 1: Write the checked-in capability fixture**

`scripts/fixtures/camera-globalshutter.json` — the shape `detectCameras` returns, recorded from the board in Task 4 and pinned here:

```json
{
  "found": [{
    "device": "/dev/video0",
    "card": "Global Shutter Camera: Global S",
    "byPath": "platform-fd500000.pcie-pci-0000:01:00.0-usb-0:1.3:1.0-video-index0",
    "capabilities": {
      "formats": { "state": "present", "value": [
        { "fourcc": "MJPG", "width": 1920, "height": 1080, "rates": [30] },
        { "fourcc": "MJPG", "width": 1280, "height": 720, "rates": [30, 24, 15] },
        { "fourcc": "MJPG", "width": 640, "height": 480, "rates": [30] }
      ] },
      "zoom":         { "state": "present", "value": { "min": 100, "max": 500, "step": 1, "default": 100, "current": 100 } },
      "focus":        { "state": "not-offered" },
      "exposure":     { "state": "present", "value": { "min": 3, "max": 2047, "step": 1, "default": 250, "current": 250 } },
      "whiteBalance": { "state": "present", "value": { "min": 2000, "max": 6500, "step": 1, "default": 4000, "current": 4000 } },
      "brightness":   { "state": "present", "value": { "min": 0, "max": 255, "step": 1, "default": 128, "current": 128 } },
      "contrast":     { "state": "present", "value": { "min": 0, "max": 255, "step": 1, "default": 128, "current": 128 } },
      "aim":          { "state": "not-offered" },
      "recording":    { "state": "not-offered" },
      "stills":       { "state": "present", "value": { "source": "pipeline" } }
    }
  }],
  "rejected": [{
    "device": "/dev/video10",
    "card": "bcm2835-codec-decode",
    "reason": "bcm2835-codec-decode is a hardware codec on this board, not a camera; it advertises formats it cannot capture (K-40)"
  }]
}
```

**Adjust it to what your board actually answered in Task 4.** Its value is that it is real; a made-up fixture captures a page nobody will ever see.

- [ ] **Step 2: Build the two pages in `flows/flows.json`**

Wiring only (CLAUDE.md rule 2). Two `ui-page` entries:

**Cameras** — one row per camera with its `summarise()` line, then the rejections with their reasons, then the board's encoding budget and the **total** uplink across all cameras (Task 14's budget widget). Both totals live here rather than on any one camera's page, because both are shared: *starting the gimbal would need 2.1 Mb/s more* is a sentence no single camera's page can say.

**One page per camera**, laid out top to bottom, because that arrangement is the same at every width — three deck columns on a desk, two on a tablet, one on a phone:

1. `ui-yonder-picture` (Task 13)
2. a readout strip: run state, resolution, rate, bitrate, uplink
3. the control deck, in groups whose headers carry one of three legends — *applies live*, *restarts the picture*, *config.yaml* — plus `ui-yonder-facts` for everything this camera cannot do
4. `ui-yonder-softkeys`: Start, Stop, Live, Setup, Try live again, Copy, and — on the Setup deck only — Re-probe and Receive line, plus the `ui-yonder-holdkey` for the full-rate picture

*Live* and *Setup* exchange the deck beneath the picture; **the picture, the readout strip and the rail do not move**. Not a panel over the frame: on a camera you are aiming, a panel over the frame hides the part of the shot you are aiming at.

**The Setup deck draws a countdown only where one will actually arm.** Task 2 exports `CAMERA_EXEMPT_LEAVES`; a change touching only those commits with no countdown, and a change touching an output or a bitrate arms the window and draws the countdown and the confirm control **in the irreversible tone** — because that apply really can take the page away.

- [ ] **Step 3: Give the capture gate a camera**

In `scripts/capture-pages.mjs`, add a synthetic source: when `--synthetic-cameras <fixture>` is passed, seed the daemon's camera detection from `scripts/fixtures/camera-globalshutter.json` instead of probing, so the camera pages exist and are photographed.

Then add the assertion R-SEC-10 needs. `capture-pages.mjs` already masks live readings; add a **check** rather than a mask:

```js
// The receive-line page shows a resolved credential. R-UI-12 commits these
// images, so a captured page carrying the real one would put a secret in the
// repository for ever — and R-SEC-10 says never in a log, an error, or a
// support bundle. The fixture carries a visibly fake value; this is what
// proves the real one never got in.
//
// Same shape as K-32: a rule nobody notices is broken until it already is.
const secret = readSecret("rtsp_password");
if (secret && html.includes(secret)) {
  fail(`${page.name} contains the resolved RTSP credential; the fixture value must be used for capture`);
}
```

- [ ] **Step 4: Run the whole gate**

```bash
npm run build && ./scripts/verify-pages.sh
node scripts/capture-pages.mjs --base-url http://localhost:3000 --password "$PW" \
  --palette day --synthetic-cameras scripts/fixtures/camera-globalshutter.json
node scripts/capture-pages.mjs --base-url http://localhost:3000 --password "$PW" \
  --palette night --synthetic-cameras scripts/fixtures/camera-globalshutter.json --accept
```

Expected: both camera pages captured in both palettes, no clipping, no action spanning its container, no sideways scroll, and the credential check passing. **Look at the images.** The Network page's join warning was 706 px of text in a 372 px widget with every unit test passing, and nothing in this repository had ever looked at one.

- [ ] **Step 5: Tick M4's entry gate in the roadmap**

R-VID-13's roadmap entry carries an entry gate: *"its cost is measured on a supply that holds before the milestone leans on it."* Task 11 measured it. Replace the gate's text with the figure and the supply state, and leave the sentence explaining why the 11% was never it.

- [ ] **Step 6: Commit**

```bash
git add flows/flows.json scripts/ docs/roadmap.md
git commit -s -m "feat(console): the camera pages, and the camera CI does not have

R-UI-03 builds navigation from detected hardware and R-UI-12 photographs every
page on every build — so with no camera attached there is no camera page, the
gate covers none of this work, and it does not complain, because from its
point of view there is nothing there. A synthetic source and a checked-in
capability fixture recorded from the board are part of this work, not a
testing afterthought.

One page per camera, generated from the capability set. Picture on top at
every width — three deck columns on a desk, two on a tablet, one on a phone —
so there is one page to design and one page for the gate to photograph. Live
and Setup exchange the deck beneath the picture; the picture, the strip and
the rail do not move. Not a panel over the frame: on a camera you are aiming,
a panel over the frame hides the part of the shot you are aiming at.

The Setup deck draws a countdown only where one will actually arm, from the
exempt list reachability.ts exports — so the page cannot promise a confirm
control that never comes, or omit one that does.

The receive-line page shows a resolved credential, and R-UI-12 commits its
images. The fixture carries a visibly fake value and the gate asserts the real
one never got in. Same shape as K-32: a rule nobody notices is broken until it
already is.

Refs: R-CAM-12, R-CTL-01, R-CTL-10, R-UI-03, R-UI-12, R-UI-15, R-VID-15,
R-SEC-10

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Done when

The milestone's own exit criterion, unchanged: **you watch usable video in a browser, over a cellular link, from another network — while a ground station receives the same feed. On a Raspberry Pi 4.**

Plus the four things this plan adds to it:

1. **A camera apply does not arm a window the page cannot confirm** (Task 2), and does not lock out a network change for two minutes while it waits.
2. **The picture is behind the console's own credential** (Tasks 9, 10) — *from another network* is not met by a stream anyone on the mesh can watch.
3. **R-VID-13's cost is measured on a supply that holds** (Task 11), and the 11% standing in for it is gone from every table.
4. **The capture gate has a camera** (Task 16), so these pages are photographed in both palettes like every other.

---

## Notes for whoever executes this

- **Per-task reviews are off on this repository.** Run implementers back to back and take one whole-branch review at the end.
- **Tasks 1–8 need no hardware except Task 4 Step 0 and Task 5 Step 5.** Tasks 11, 12 Step 6, 13 Step 6 and 16 Step 4 all need the board.
- **Task 12 gates Task 13.** The held key is proven in a browser on a tablet before the picture depends on it; the double-send failure does not reproduce on a desktop.
- **Task 11 is M4's entry gate.** If the harness refuses to record a figure, the supply is the finding — do not work around it.
- If a task turns out to be wrong about the code, **the code wins**: read the file, fix the plan's assumption in the commit message, and say so.
