# Console Instrument Library — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every control the blueprint draws does what it says — on the board,
on both cameras, in both palettes, on the camera page and on the Cockpit —
with the model, the mechanisms and the guards underneath it built, tested and
proven on hardware.

**Architecture:** Two bench spikes first, because each can change the design.
Then the model in `yonder-core`; the blueprint corrected so nothing is built
from prose; the Vue library and the gallery that renders it whole; the pages
and the five defects; the mechanisms (a runtime encoder channel, the rate
controller, viewer-scoped state, recording and photos); the accessory camera
with expiring intent and one guard for every motion command; and the Cockpit
surface. One branch, seven phases, each a review checkpoint.

**Tech Stack:** TypeScript, Zod, Vue 3 SFCs built to UMD by Vite, Vitest +
`@vue/test-utils` + jsdom, Node-RED Dashboard 2.x, Playwright, GStreamer
(`v4l2h264enc`), mediamtx, DUML over AOA.

**Spec:** [`docs/superpowers/specs/2026-09-04-console-instrument-library.md`](../specs/2026-09-04-console-instrument-library.md) — §7 is the control inventory, §8 the mechanisms, §13 the acceptance cases, §15 the blueprint corrections.
**Blueprint:** [`docs/console/design/instrument-library/`](../../console/design/instrument-library/) — the interactive mockup; where it and the spec disagree about layout, it wins, except for §15's corrections.

## Global Constraints

- **Logic and presentation live in node packages.** No `function` node, no `ui-template` markup, no `exec` node. `flows/` is wiring only.
- **Every change traces to a requirement ID.** New IDs: `R-CTL-11…14`, `R-UI-21…28`, `R-VID-16…18`, `K-46…50`. Stable; never reuse or renumber; withdraw, never delete.
- **A node without tests will not be merged. Mutation-check every guard**: delete it, confirm a named test goes red, restore it.
- **Both palettes**: `var(--yonder-*, <night fallback from tokens.css>)` only.
- **A token carrying a unit is never uppercased.** `Mb/s`, `µs`, `°/s`.
- **`emitsActions: true` on every widget that emits, and a test that presses it.** Dashboard drops a `widget-action` silently otherwise.
- **Device-native units in config; display conversion in the adapter descriptor.** Raw shutter 156 is stored as 156 and shown as 15 600 µs.
- **Nothing marked *unproven* in spec §7 ships as a live control** until the bench has driven it and the effect is recorded.
- **Yonder relays commands and never originates them** (R-CMD-04). The rate controller carries out an applied policy; the guard refuses, it never aims.
- **No credential in a committed capture** (R-SEC-10). **No board address in any committed file.** `git commit -s`, GPG-signed, never `--no-gpg-sign`.
- **Commit messages**: imperative mood, the requirement ID where one applies.
- **An exhaustive switch protects you only with all three of: every case
  `return`s, no `default:`, and the enclosing function's return type written
  out explicitly.** Measured on this repository in Task 4 by adding a fifth
  `Capability` state and counting the errors. A switch using `break` with an
  `assertNever` after it compiles identically whether or not it is exhaustive,
  so it reads as a guard and is none. An *inferred* return type defeats the
  returning form just as quietly: TypeScript widens it to `string | undefined`
  and the missing case passes. With all three in place, the fifth state
  produced exactly one error per site that needed changing. The annotation is
  load-bearing — say so where you write it, or someone tidies it away.

**Commands:** `npm test -w yonder-core` · `npm test -w node-red-dashboard-2-yonder` · `npx vitest run <file> --root packages/<pkg>` · `npm test` · `npm run lint` · `./scripts/verify-pages.sh` (`ACCEPT_SHAPE=1` to adopt a shape) · `HOLD=1 PORT=18900 ./scripts/verify-pages.sh` to stand the console up · gallery: `npm run gallery -w node-red-dashboard-2-yonder`.

**The board:** Raspberry Pi 4, user `yonder`, key-based, passwordless sudo, ELP on `/dev/video0`, EC25 modem, console on port 3000 behind a password. **Resolve `yonder.local` or ask; never assume the address.** Restarting `yonder-core` re-renders the network and can drop remote access — say so first. The Pocket 2 is in hand for Phase 5.

## File Structure

**`packages/yonder-core/src/`**

| File | Responsibility after this plan |
|---|---|
| `video/capability.ts` | Four states incl. `gated`; ten new keys; menu entries kept on a control |
| `video/probe/parse.ts` | `flags=inactive`; menu IDs and labels |
| `video/probe/camera.ts` | `CONTROL_MAP` + `GATED_BY`; pan/tilt → `aim` |
| `video/controls.ts` | Write path; menu membership; refuses gated and advertised |
| `video/descriptors.ts` | **New.** Per-control display unit, conversion, label, gate rule — the adapter boundary |
| `video/outputs.ts` | **New.** `outputReach` |
| `video/encoder.ts` | **New.** The runtime encoder channel: retune bitrate, reconfigure the preview branch |
| `video/rate.ts` | **New.** The rate controller and the size ladder |
| `video/viewers.ts` | **New.** Per-viewer delivery state; the preview-state message |
| `video/recorder.ts` | **New.** Board recording and pipeline stills, bounded (R-STO-06) |
| `video/accessory/{duml,aoa,gimbal,guard,intent,state,source}.ts` | **New.** The Pocket 2 |
| `schema/config.ts` | Controls, outputs `enabled`, stream/preview modes and envelopes, preview `size`, gimbal envelope |
| `apply/reachability.ts` | The `preview` blanket exemption removed; policy fields classified by leaf |
| `apply/draft.ts` | **New.** Draft validation and the interruption statement |
| `console/settings.ts` | The theme `<link>` in the document head |
| `daemon/routes.ts` | Controls, outputs, drafts, viewers, captures, aim, range finder |

**`packages/node-red-dashboard-2-yonder/src/`**

| File | Responsibility |
|---|---|
| `ui/YonderReadout.vue`, `YonderPicker.vue`, `YonderSegmented.vue`, `YonderSetBar.vue`, `YonderColumn.vue`, `YonderPlacard.vue`, `YonderTextField.vue`, `YonderAimPad.vue`, `YonderPositionGauge.vue`, `YonderShutter.vue`, `YonderStateOverlay.vue`, `YonderThumbStrip.vue` | **New parts** |
| `ui/YonderDeck.vue` + `deck.ts/.html` · `ui/YonderIndex.vue` + `index-widget.ts/.html` · `ui/YonderAim.vue` + `aim.ts/.html` · `ui/YonderCaptures.vue` + `captures.ts/.html` · `ui/YonderRangeFinder.vue` + `range-finder.ts/.html` | **New nodes** |
| `ui/YonderPicture.vue` | Overlays in front; aspect; drag layer; state; strip |
| `ui/YonderDataBar.vue`, `YonderSoftKeys.vue`, `YonderBudget.vue` | Clipping fixed |
| `ui/draft.ts` | **New.** The browser-session draft store, per camera |
| `gallery/` | **New.** Renders every component, every state, both palettes (R-UI-25) |

**`packages/node-red-contrib-yonder-video/src/`** — `camera.ts` feeds the deck and the aim node; `captures.ts` and `stream-address.ts` **new**.

---

# Phase 0 — two spikes that can change the design

### Task 1: Does `v4l2h264enc` take a runtime bitrate change without a respawn?

**Files:**
- Create: `docs/hardware/runtime-encoder-control.md`
- Create: `scripts/spikes/retune-bitrate.py`

**Why:** Spec §8.1 requires bitrate changes without respawning the camera
pipeline. Whether the Pi's encoder honours a runtime change is unproven. If it
does not, Task 30 isolates a preview-branch restart and the main stream's
bitrate stays Apply-with-respawn, stated on the page. Establish this before
anything is built on it.

**The pipeline must be the daemon's, element for element.** The spike exists to
de-risk Task 30, which will drive `extra-controls` on the pipeline
`video/pipeline.ts` composes. A spike that measures a different element graph
de-risks nothing. Read `compose()` and `encode()` in that file and match the
full-rate branch: `v4l2src` with `io-mode=4`, the MJPG capsfilter, `jpegdec`,
the leaky queue from `QUEUE`, `v4l2h264enc`, and the `H264_LEVEL` capsfilter
that keeps the encoder off level 1. There is no converter in that branch. The
one difference the spike may keep is opening `/dev/video0` directly where the
daemon opens the same node through `/dev/v4l/by-path/` — that is how the daemon
holds a camera's identity stable across replugs, and it is not a difference the
encoder can observe. Say so in the note rather than leaving it unremarked.

- [ ] **Step 1: Write the spike**

```python
#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Does the running encoder change bitrate when told to, without a restart?
# Run on the board with the camera idle. Configures nothing; leaves nothing.
import gi, sys, time
gi.require_version("Gst", "1.0")
from gi.repository import Gst
Gst.init(None)
# The full-rate branch of compose()/encode() in video/pipeline.ts. The level
# capsfilter is not decoration: without it the encoder fixates level 1, which
# cannot carry 720p, and the driver refuses to start on the first frame.
p = Gst.parse_launch(
    "v4l2src device=/dev/video0 io-mode=4 "
    "! image/jpeg,width=1280,height=720,framerate=30/1 ! jpegdec "
    "! queue leaky=downstream max-size-time=200000000 max-size-buffers=0 max-size-bytes=0 "
    "! v4l2h264enc name=enc extra-controls=controls,video_bitrate=1000000 "
    "! video/x-h264,level=(string)4 "
    "! h264parse ! identity name=tap ! fakesink sync=false")
tap, enc = p.get_by_name("tap"), p.get_by_name("enc")
start = time.monotonic()
bytes_seen, last_pts, gaps = [0], [None], []
def probe(pad, info):
    buf = info.get_buffer(); bytes_seen[0] += buf.get_size()
    # When each gap happened, not merely how many. A gap that precedes the
    # retune call cannot have been caused by it, and a bare count cannot say
    # so — which is the whole question this spike turns on.
    if last_pts[0] is not None and buf.pts - last_pts[0] > 3 * Gst.SECOND / 30:
        gaps.append(time.monotonic() - start)
    last_pts[0] = buf.pts; return Gst.PadProbeReturn.OK
tap.get_static_pad("src").add_probe(Gst.PadProbeType.BUFFER, probe)
p.set_state(Gst.State.PLAYING)
def rate(seconds):
    bytes_seen[0] = 0; time.sleep(seconds); return bytes_seen[0] * 8 / seconds / 1e6
before = rate(10)
s = Gst.Structure.new_empty("controls"); s.set_value("video_bitrate", 3000000)
retune_at = time.monotonic() - start
enc.set_property("extra-controls", s)             # the runtime path under test
after = rate(10)
p.set_state(Gst.State.NULL)
late = [g for g in gaps if g > retune_at]
print(f"before {before:.2f} Mb/s  after {after:.2f} Mb/s  "
      f"retune at {retune_at:.2f}s  gaps at {['%.2fs' % g for g in gaps]}  "
      f"after the retune {len(late)}")
sys.exit(0 if after > before * 2 and not late else 1)
```

- [ ] **Step 2: Run it on the board three times; record all three**

`python3-gi` and `gir1.2-gstreamer-1.0` may need installing on the board;
say so before installing.

A gap **after the retune call** is a restart, and is the finding that would
settle the question against runtime retuning. A gap before it is not evidence
either way: the queue is `leaky=downstream` exactly as the daemon's is, so it
drops under pressure by design, and a cold pipeline settles in its first
second. Report every gap with its timestamp, and let the position carry the
argument rather than the count.

If `io-mode=4` will not negotiate with this camera, drop it, run without it,
and record that it was dropped and why — do not silently substitute a
pipeline that differs from the daemon's without saying so.

**Bracket every run with the camera's USB device number as well as
`vcgencmd get_throttled`.** `lsusb -d 32e4:0234` prints `Bus 001 Device NNN`,
and that number changes whenever the camera re-enumerates. The dev board's
camera has an intermittent connection: it disconnected and came back eight
times in one 43-minute session, each time as a clean disconnect followed by a
successful re-enumeration about 70 ms later, on a supply reading
`throttled=0x0` throughout. A run whose device number differs at the end from
the start had its camera pulled out from under it and is not a reading —
discard it, say so, and run again. A bitrate that appears to fall to nothing
mid-run is what that looks like from the inside, and it would otherwise be
indistinguishable from an encoder that stopped.

- [ ] **Step 3: Record the answer and the decision**

`docs/hardware/runtime-encoder-control.md`: the command, the three readings,
where each gap fell relative to the retune, and the **decision**: runtime
retune is available (Task 30 uses `extra-controls` at runtime), or it is not
(Task 30 restarts the preview branch only; the main stream's bitrate is
Apply-with-respawn and the page says *restarts the picture*).

Every fact in the note's conditions table must be observed in this session and
its command recorded — board model and revision, kernel, architecture, and
which device node backs `v4l2h264enc`. An identifier copied from an older note
under today's date is a number that was not observed, and this board's history
of brownouts and USB dropouts is exactly why that rule is not a formality.

- [ ] **Step 4: Commit**

```bash
git add docs/hardware/runtime-encoder-control.md scripts/spikes/retune-bitrate.py
git commit -s -m "docs(hardware): whether v4l2h264enc retunes at runtime — measured, R-VID-07"
```

---

### Task 2: The gimbal's stop bound after the last frame

**Files:**
- Create: `scripts/spikes/gimbal-stop-bound.sh`
- Modify: `docs/hardware/dji-pocket-2-over-usb.md` (section *The stop bound, measured*)

**Why:** Spec §8.7: the device's ~0.5 s timeout is only the last link. Task 36
sizes its lease from this number and Task 39 measures the complete
browser-to-rest bound on top of it.

- [ ] **Step 1: Write the spike**

Using `scripts/pocket2/aoa_session.py`'s inject file, the way
`gimbal-rate-confirm.sh` does: inject yaw +10°/s frames at 10 Hz for 2 s; stop
injecting; sample the attitude push at 20 Hz until yaw is unchanged for
500 ms; print the time from the last injected frame to the last changing
sample. Five runs.

- [ ] **Step 2: Run with the Pocket 2 mounted and the handle held; recentre between runs**

- [ ] **Step 3: Record the five readings and the maximum in the hardware note**

- [ ] **Step 4: Commit**

```bash
git add scripts/spikes/gimbal-stop-bound.sh docs/hardware/dji-pocket-2-over-usb.md
git commit -s -m "docs(hardware): the gimbal's stop bound after the last frame, five runs — R-CAM-11"
```

---

# Phase 1 — the model

### Task 3: A control can be gated, and a menu keeps its entries

**Files:**
- Modify: `packages/yonder-core/src/video/probe/parse.ts`
- Modify: `packages/yonder-core/src/video/capability.ts` (`ControlRange`)
- Test: `packages/yonder-core/src/video/probe/parse.test.ts`

**Interfaces:**
- Produces: `ControlRange` gains `readonly inactive: boolean` and
  `readonly menu?: readonly { id: number; label: string }[]`. `parseControls`
  reads `flags=inactive` and, for a `(menu)` control, the indented entry lines
  that follow it (`1: Manual Mode`).

- [ ] **Step 1: Write the failing tests**

```ts
describe("a control another control has charge of", () => {
  it("reads flags=inactive as gated", () => {
    const c = parseControls(
      "         exposure_time_absolute 0x009a0902 (int)    : min=1 max=10000 step=1 default=156 value=156 flags=inactive, has-min-max");
    expect(c.get("exposure_time_absolute")?.inactive).toBe(true);
  });
  it("a control with other flags, or none, is not gated", () => {
    expect(parseControls("                     brightness 0x00980900 (int)    : min=-64 max=64 step=1 default=0 value=0 flags=has-min-max")
      .get("brightness")?.inactive).toBe(false);
    expect(parseControls("        white_balance_automatic 0x0098090c (bool)   : default=1 value=1")
      .get("white_balance_automatic")?.inactive).toBe(false);
  });
  it("matches the flag as a whole word", () => {
    expect(parseControls("                          gamma 0x00980910 (int)    : min=64 max=300 step=1 default=110 value=110 flags=deactivated")
      .get("gamma")?.inactive).toBe(false);
    // `deactivated` does not contain `inactive` at all, so it cannot tell a
    // whole-word match from a substring search — it passes either way. This
    // one discriminates: a flag that *contains* the word is not the word.
    expect(parseControls("                          gamma 0x00980910 (int)    : min=64 max=300 step=1 default=110 value=110 flags=co-inactive-extra, has-min-max")
      .get("gamma")?.inactive).toBe(false);
  });
});

describe("a menu keeps the entries the device offers", () => {
  // The ELP offers exposure IDs 1 and 3. Expanding min…max into 0,1,2,3 would
  // put two modes on the page the camera does not have.
  it("keeps only the listed entries, with their labels", () => {
    const c = parseControls([
      "                  auto_exposure 0x009a0901 (menu)   : min=0 max=3 default=3 value=3",
      "\t\t\t\t1: Manual Mode",
      "\t\t\t\t3: Aperture Priority Mode",
    ].join("\n"));
    expect(c.get("auto_exposure")?.menu).toEqual([
      { id: 1, label: "Manual Mode" }, { id: 3, label: "Aperture Priority Mode" },
    ]);
  });
  it("a range control has no menu", () => {
    expect(parseControls("                     brightness 0x00980900 (int)    : min=-64 max=64 step=1 default=0 value=0 flags=has-min-max")
      .get("brightness")?.menu).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run src/video/probe/parse.test.ts --root packages/yonder-core
```

- [ ] **Step 3: Implement**

In `ControlRange` add the two fields with a comment that `inactive` is R-UI-21
and not a fault. In `parseControls`, after the `CONTROL_LINE` match, read
`/\bflags=([\w\-, ]+)/`, split on commas, test for the whole word `inactive`;
for a `(menu)` control consume following lines matching `/^\s+(\d+):\s+(.+)$/`
until the next control line. `npm run lint` names every other construction
site; give each `inactive: false`.

- [ ] **Step 4: Run to verify it passes; mutation-check**

Change `.includes("inactive")` to `.includes("active")`: the whole-word test
goes red. Delete the menu-line loop: the entries test goes red. Restore both.

- [ ] **Step 5: Commit**

```bash
git add packages/yonder-core/src/video/probe/parse.ts packages/yonder-core/src/video/capability.ts packages/yonder-core/src/video/probe/parse.test.ts
git commit -s -m "feat(video): read flags=inactive and a menu's own entries — R-UI-21, R-CAM-14"
```

---

### Task 4: The gated capability state; advertised keeps its range

**Files:**
- Modify: `packages/yonder-core/src/video/capability.ts`
- Test: `packages/yonder-core/src/video/capability.test.ts`

**Interfaces:**
- Produces: `Capability<T>` gains
  `{ state: "gated"; value: T; by: { id: string; label: string } }` and
  `gated<T>(value, by)`. `advertised<T>(value: T | undefined, reason)` keeps a
  value so the inoperative control can be drawn. `summarise` prints
  `exposure: auto exposure has it`. **Only `present` permits a write** — Task 9.

- [ ] **Step 1: Write the failing tests**

```ts
const range = { min: 1, max: 10000, step: 1, default: 156, current: 156, inactive: true };
const by = { id: "auto_exposure", label: "auto exposure" };

it("keeps the value, because the control is real and in range", () => {
  const cap = gated(range, by);
  if (cap.state !== "gated") throw new Error("narrowing");
  expect(cap.value.max).toBe(10000); expect(cap.by.label).toBe("auto exposure");
});
it("summarises as the control that has charge, not as unanswered", () => {
  const s = summarise({ ...noCapabilities(), exposure: gated(range, by) });
  expect(s).toContain("exposure: auto exposure has it"); expect(s).not.toContain("unanswered");
});
it("advertised keeps a value too, so the dead control can be drawn", () => {
  const cap = advertised(range, "the frame never moved");
  if (cap.state !== "advertised") throw new Error("narrowing");
  expect(cap.value).toEqual(range); expect(cap.reason).toContain("never moved");
});
```

- [ ] **Step 2: Fail** — `npx vitest run src/video/capability.test.ts --root packages/yonder-core`
- [ ] **Step 3: Implement** — extend the union; `gated()`; `advertised(value, reason)` with the old one-argument form kept for existing callers; the `summarise` branch. `npm run lint`: fix every exhaustive switch **without adding `default:`**.
- [ ] **Step 4: Pass; mutation-check** — delete the `gated` branch in `summarise`: red. Restore.
- [ ] **Step 5: Teach the one consumer that silently absorbs the new state**

`capabilityFacts()` in `packages/yonder-core/src/video/present.ts` branches on
`present`, then a ternary between `advertised` and everything else — so a
`gated` capability is reported as `not-offered`, the console tells an operator
their camera *has none* of a control it has, and no compiler warns, because a
ternary is not an exhaustive switch. `YonderFacts.vue`'s own comment describes
this exact failure one layer down and was hardened against it; the producer
was not.

- `CapabilityFact["state"]` gains `"gated"`.
- The ternary becomes an exhaustive `switch` on `cap.state`, no `default:`, so
  a fifth state is a compile error here rather than a wrong sentence on a page.
- A gated capability yields `{ label, state: "gated", reason: by.label }`.
- `STATES` in `packages/node-red-dashboard-2-yonder/src/ui/YonderFacts.vue`
  gains `gated: 'another control has it'` — the register of the other three,
  with the responsible control's own name arriving as the reason. Its tone is
  neutral, the same colour as `not-offered`, and it takes **no** caution
  border: a gated control is not a fault.

```ts
it("says which control has it, and does not call the camera short of one", () => {
  const caps = { ...noCapabilities(), exposure: gated(range, by) };
  const fact = capabilityFacts(caps).find((f) => f.label === LABELS.exposure);
  expect(fact).toEqual({ label: LABELS.exposure, state: "gated", reason: "auto exposure" });
});
```

Mutation-check it: make the switch return `not-offered` for `gated` and this
test goes red.

- [ ] **Step 6: Commit** — `git commit -s -m "feat(video): a fourth capability state, and advertised keeps its range — R-UI-21"`

---

### Task 5: The capabilities the devices answer

**Files:**
- Modify: `packages/yonder-core/src/video/capability.ts`
- Test: `packages/yonder-core/src/video/capability.test.ts`

**Interfaces:**
- Produces: `CameraCapabilities`, `CAPABILITY_KEYS` and `noCapabilities()` gain
  `gain`, `backlightCompensation`, `gamma`, `sharpness`, `saturation`, `hue`,
  `powerLineFrequency`, `autoExposure`, `autoWhiteBalance`, `autoFocus`, each
  `Capability<ControlRange>`.

- [ ] **Step 1: Write the failing tests**

```ts
const NEW = ["gain", "backlightCompensation", "gamma", "sharpness", "saturation", "hue",
  "powerLineFrequency", "autoExposure", "autoWhiteBalance", "autoFocus"] as const;
it("carries every control the bench camera reports", () => {
  for (const k of NEW) expect(CAPABILITY_KEYS).toContain(k);
});
it("defaults every key to not-offered", () => {
  const caps = noCapabilities();
  for (const k of CAPABILITY_KEYS) expect(caps[k].state).toBe("not-offered");
});
it("has one key per field, and no field without a key", () => {
  expect([...CAPABILITY_KEYS].sort()).toEqual(Object.keys(noCapabilities()).sort());
});
```

- [ ] **Step 2–4: Fail; add the fields, the keys and the defaults; pass; `npm run lint`**
- [ ] **Step 5: Commit** — `git commit -s -m "feat(video): model the ten controls the bench camera answers — R-CTL-11 … R-CTL-14"`

---

### Task 6: Descriptors — units, labels and gates at the adapter boundary

**Files:**
- Create: `packages/yonder-core/src/video/descriptors.ts`
- Create: `packages/yonder-core/src/video/descriptors.test.ts`
- Modify: `packages/yonder-core/src/console/presentation.ts` (re-export)

**Interfaces:**
- Produces:

```ts
export interface ControlDescriptor {
  readonly key: keyof CameraCapabilities;
  readonly label: string;                       // "Shutter" — the heading form
  readonly unit: string;                        // "µs", "K", "" — never uppercased downstream
  readonly toDisplay: (raw: number) => number;
  readonly toRaw: (shown: number) => number;
  readonly gates?: readonly (keyof CameraCapabilities)[];
  /** Which of the gate's values leave this control live. Menu id or 0/1. */
  readonly openWhen?: (gateValue: number) => boolean;
}
export const DESCRIPTORS: Record<keyof CameraCapabilities, ControlDescriptor>;
export interface DescriptorView { label; unit; min; max; step; current; default }
export function describe(key, range: ControlRange): DescriptorView;  // display units
/** The label lowercased for use inside a sentence: `auto exposure has it`. */
export function sentenceLabel(key: keyof CameraCapabilities): string;
```

**Every `label` is the heading form**, capitalised the same way, because a page
draws control headings from this field and three lowercase headings among
sixteen would be a visible defect. The one place a label appears mid-sentence
is a gated control naming the control that holds it, and that place calls
`sentenceLabel` rather than the field reading lowercase for everyone else.

**Why:** Spec §7 — V4L2 absolute exposure is 100 µs per raw unit; raw 156 is
15 600 µs. Config stores raw; the page shows µs; the conversion lives here,
once. Gates live here too: on the ELP shutter is live only under Manual (id 1);
on the Pocket 2 under Manual **or** Shutter priority.

- [ ] **Step 1: Write the failing tests**

```ts
it("converts absolute exposure at 100 µs per raw unit — current, bounds and step together", () => {
  const d = describe("exposure", { min: 1, max: 10000, step: 1, default: 156, current: 156, inactive: false });
  expect(d).toMatchObject({ current: 15600, min: 100, max: 1_000_000, step: 100, unit: "µs" });
});
it("round-trips a display value to the same raw value", () => {
  expect(DESCRIPTORS.exposure.toRaw(DESCRIPTORS.exposure.toDisplay(156))).toBe(156);
});
it("shutter is open under Manual (1) and closed under Aperture priority (3)", () => {
  expect(DESCRIPTORS.exposure.openWhen!(1)).toBe(true);
  expect(DESCRIPTORS.exposure.openWhen!(3)).toBe(false);
});
it("zoom on a UVC camera is device steps with no ratio", () => {
  expect(DESCRIPTORS.zoom.unit).toBe(""); expect(DESCRIPTORS.zoom.toDisplay(30)).toBe(30);
});
// A blocklist of three wrong spellings passes `µS`, `MHZ` and every other
// miscasing nobody thought of, which is the failure it was written to catch.
// A closed vocabulary inverts that: a unit reaches this table only by being
// added here deliberately, which is the one place the casing rule is applied.
const UNITS = new Set(["", "µs", "K"]);
it("every unit is one this project has written down, in that spelling", () => {
  for (const [key, d] of Object.entries(DESCRIPTORS)) {
    expect(UNITS, `${key} carries an unlisted unit ${JSON.stringify(d.unit)}`).toContain(d.unit);
  }
});
```

- [ ] **Step 2–4: Fail; implement; pass; mutation-check** — set exposure's factor to 1: the conversion test goes red. Restore.
- [ ] **Step 5: Commit** — `git commit -s -m "feat(video): control descriptors — display units and gates at the adapter boundary — R-CTL-10, R-CTL-11"`

---

### Task 7: Probe them; gate them; report the aim the ELP advertises

**Files:**
- Modify: `packages/yonder-core/src/video/probe/camera.ts`
- Test: `packages/yonder-core/src/video/probe/camera.test.ts`
- Fixture: `.../probe/fixtures/list-ctrls-menus-globalshutter.txt` (exists; contains the real output)

**Interfaces:**
- Produces: `CONTROL_MAP` gains ten pairs (`gain`, `backlight_compensation`,
  `gamma`, `sharpness`, `saturation`, `hue`, `power_line_frequency`,
  `auto_exposure`, `white_balance_automatic`, `focus_automatic_continuous`).
  A control whose range is `inactive` becomes `gated(range, by)` with `by.id`
  the gating key from `DESCRIPTORS[key].gates[0]` and `by.label` that key's
  `sentenceLabel()` — `auto exposure`, lowercase because it is read inside
  `exposure: auto exposure has it`, never the heading form. `pan_absolute`/`tilt_absolute`
  present → `aim: advertised(undefined, reason)`.

- [ ] **Step 1: Write the failing tests**

```ts
const listCtrls = readFileSync(join(import.meta.dirname, "fixtures/list-ctrls-menus-globalshutter.txt"), "utf8");
describe("the bench camera's controls", () => {
  // All ten, not a sample of them. Task 5 added the keys defaulting to
  // `not-offered`, which asserts *this camera does not have it* — false for
  // every one of these, and said on a page an operator reads. Any key this
  // task fails to map keeps telling that lie, so the guard has to name each.
  it("fills the ten controls that had no home", async () => {
    const caps = await capabilitiesFrom(listCtrls);
    for (const k of ["gain", "backlightCompensation", "gamma", "sharpness", "saturation",
      "hue", "powerLineFrequency", "autoExposure", "autoWhiteBalance", "autoFocus"]) {
      expect(caps[k].state).toBe("present");
    }
  });
  it("reports the pan and tilt it advertises with no motor behind them", async () => {
    const caps = await capabilitiesFrom(listCtrls);
    expect(caps.aim.state).toBe("advertised");
    if (caps.aim.state !== "advertised") throw new Error("narrowing");
    expect(caps.aim.reason).toMatch(/pan/i);
  });
  it("gates the three controls an automatic mode has charge of, keeping their range", async () => {
    const caps = await capabilitiesFrom(listCtrls);
    for (const k of ["exposure", "whiteBalance", "focus"]) expect(caps[k].state).toBe("gated");
    if (caps.exposure.state !== "gated") throw new Error("narrowing");
    expect(caps.exposure.by.label).toBe("auto exposure"); expect(caps.exposure.value.max).toBe(10000);
  });
  it("keeps only the menu ids the device listed", async () => {
    const caps = await capabilitiesFrom(listCtrls);
    if (caps.autoExposure.state !== "present") throw new Error("narrowing");
    expect(caps.autoExposure.value.menu?.map((m) => m.id)).toEqual([1, 3]);
  });
});
```

`capabilitiesFrom` stubs the runner the way the file already does for
`v4l2-ctl --list-ctrls`.

- [ ] **Step 2–4: Fail; implement; pass.** The `CONTROL_MAP`/`CONTROL_NAMES`
  cross-check stays **green** through this task, and that is not it passing
  vacuously by luck: it walks `CONTROL_NAMES` forward into `CONTROL_MAP`, so
  growing the map alone cannot trip it. It bites in Task 9, when the names
  gain entries that must agree. Do not force it red.
- [ ] **Step 5: Mutation-check** — remove the `inactive → gated` branch: red; remove the pan/tilt block: red. Restore.

- [ ] **Step 6: Prove that *inactive* is what gates, not *a gate exists*.**

The gate reads `range.inactive ? DESCRIPTORS[key].gates?.[0] : undefined`. Drop
the `range.inactive` test — gating whenever a gate is configured at all — and
every test still passes, because the one recorded fixture has all three
gate-eligible controls permanently inactive, so the two conditions are
perfectly correlated in the only device state this repository has. A
regression to that form would tell an operator a shutter is held by auto
exposure while the camera sits in Manual Mode with that shutter live and
adjustable, which is the sentence R-UI-20 and R-UI-21 exist to prevent.

Build the missing state by hand — a `ControlRange` for a gate-eligible control
with `inactive: false` — and assert it reports `present`, not `gated`. The
acceptance test is the mutation: dropping `range.inactive` from the condition
must turn this test red.

A second capture from the board, taken with `auto_exposure` in Manual Mode, is
the better evidence and should replace the hand-built range when the bench is
next available. Until then say in the test that its state is constructed and
why the fixture cannot supply it.
- [ ] **Step 6: Commit** — `git commit -s -m "feat(video): probe the controls the model gained, and report the aim this camera advertises — R-CAM-14"`

---

### Task 8: The config carries every control, in device-native units

**Files:**
- Modify: `packages/yonder-core/src/schema/config.ts` (`CameraControls`)
- Test: `packages/yonder-core/src/schema/config.test.ts`
- Modify: `docs/configuration.md`; regenerate the published schema

**Interfaces:**
- Produces: `CameraControls` gains `gain`, `backlightCompensation`, `gamma`,
  `sharpness`, `saturation`, `hue`, `exposureTime` (**raw**),
  `whiteBalanceTemperature`, `focus`, `zoom`, `powerLineFrequency`,
  `autoExposure` (**menu id**), `autoWhiteBalance`, `autoFocus` (booleans) —
  all `.nullable().default(null)`. **`null` means leave the camera alone; it is
  not zero.**

- [ ] **Step 1: Write the failing tests**

```ts
it("accepts every control the bench camera answers", () => {
  const p = CameraControls.parse({ brightness: 12, gain: 200, exposureTime: 156, autoExposure: 1, autoFocus: false });
  expect(p.exposureTime).toBe(156); expect(p.autoFocus).toBe(false);
});
it("defaults every control to null, never to zero", () => {
  const p = CameraControls.parse({});
  for (const k of ["gain", "exposureTime", "autoExposure", "autoWhiteBalance"]) expect(p[k]).toBeNull();
});
it("refuses a value outside any UVC range", () => { expect(() => CameraControls.parse({ gain: 10_000_000 })).toThrow(); });
// Menu membership is the adapter's job (Task 9): the schema cannot know a camera's menu.
it("accepts any int for a menu control at the schema", () => { expect(CameraControls.parse({ autoExposure: 2 }).autoExposure).toBe(2); });
```

- [ ] **Step 2–4: Fail; implement with `const ctl = (lo, hi) => z.number().int().min(lo).max(hi).nullable().default(null)` and a header comment stating null is not zero and units are device-native; pass**
- [ ] **Step 5: Regenerate the published schema the way `ee7e1aa` did; document every field with its raw unit in `docs/configuration.md`**
- [ ] **Step 6: Commit** — `git commit -s -m "feat(schema): carry every camera control the device answers, device-native — R-CTL-11 … R-CTL-14"`

---

### Task 9: Write them; refuse what the camera does not offer; re-read the gates

**Files:**
- Modify: `packages/yonder-core/src/video/controls.ts`
- Test: `packages/yonder-core/src/video/controls.test.ts`

**Interfaces:**
- Produces: `CONTROL_NAMES` gains the new entries (the `satisfies` clause
  enforces it). **Its cross-check with `CONTROL_MAP` gains the other
  direction**: today it walks the names forward into the map, so a control
  the probe reads and nothing can write passes unnoticed. Task 8 gives every
  probed control a config field, so from here the two lists should cover the
  same controls, and a missing pair is a control an operator can see and
  cannot set. Assert both directions and name the offending key. `applyControls` refuses a `not-offered` control, a `gated`
  control naming its gate, an `advertised` control with its reason, and a
  menu value not among the offered entries; sends a boolean as `1`/`0`; and
  after a gate control is written, **re-probes the keys it gates** and returns
  them as `reprobed`.

- [ ] **Step 1: Write the failing tests**

```ts
it("sends a switch as 1 or 0, which is what V4L2 takes", async () => {
  const calls: string[][] = [];
  await applyControls({ node, controls: { autoWhiteBalance: false },
    capabilities: { ...noCapabilities(), autoWhiteBalance: present(boolRange) },
    runner: async (argv) => { calls.push(argv); return ok; } });
  expect(calls.flat().join(" ")).toContain("white_balance_automatic=0");
});
it("refuses a gated control naming the setting that has charge", async () => {
  const r = await applyControls({ node, controls: { exposureTime: 400 },
    capabilities: { ...noCapabilities(), exposure: gated(range, { id: "auto_exposure", label: "auto exposure" }) }, runner });
  expect(r.refused[0].reason).toContain("auto exposure");
});
it("refuses a menu id the device did not list", async () => {
  const caps = { ...noCapabilities(), autoExposure: present({ ...range, menu: [{ id: 1, label: "Manual Mode" }, { id: 3, label: "Aperture Priority Mode" }] }) };
  const r = await applyControls({ node, controls: { autoExposure: 2 }, capabilities: caps, runner });
  expect(r.refused.map((x) => x.control)).toEqual(["autoExposure"]);
});
it("re-reads the gated controls after the gate changes", async () => {
  const r = await applyControls({ node, controls: { autoExposure: 1 }, capabilities: capsWithGates, runner: runnerThatAnswersListCtrls });
  expect(r.reprobed).toContain("exposure");
});
```

- [ ] **Step 2–4: Fail; implement; `npm test -w yonder-core` — the cross-check is green again; mutation-check each refusal and the re-probe**
- [ ] **Step 5: Commit** — `git commit -s -m "feat(video): write every modelled control; refuse a gated one and an unlisted menu id — R-CTL-11 … R-CTL-14, R-UI-21"`

---

### Task 10: Outputs can be stopped, and the console knows what can reach them

**Files:**
- Modify: `packages/yonder-core/src/schema/config.ts` (`CameraOutput.enabled`)
- Create: `packages/yonder-core/src/video/outputs.ts`, `outputs.test.ts`
- Modify: the output-to-pipeline rendering (filter on `enabled`); `console/presentation.ts` (re-export)

**Interfaces:**
- Produces: `enabled: z.boolean().default(true)` on every output kind;
  `outputReach(kind: "rtp"|"rtsp"|"srt", paths: { lan; mesh; cellular }): { direction: "outbound"|"listener"; reachable: boolean; note: string }`.

- [ ] **Step 1: Write the failing tests**

```ts
it("defaults to enabled, so an existing config means what it meant", ...);
it("keeps its path and its secret while disabled", ...);
it("renders no pipeline for a disabled output", ...);
it("the ground station dials out, so cellular carries it", () => { expect(outputReach("rtp", cell)).toMatchObject({ direction: "outbound", reachable: true }); });
it("nothing can dial in to an RTSP listener over cellular, and the note says mesh", () => {
  const r = outputReach("rtsp", cell); expect(r.reachable).toBe(false); expect(r.note).toMatch(/cellular/); expect(r.note).toMatch(/mesh/);
});
it("the mesh, and a LAN, give a listener an address a peer can reach", ...);
// The console states and does not act (R-CMD-04): a sentence, never an action.
it("returns exactly direction, reachable and note", () => { expect(Object.keys(outputReach("rtsp", cell)).sort()).toEqual(["direction", "note", "reachable"]); });
```

- [ ] **Step 2–4: Fail; implement; pass; mutation-check** — `reachable = true` for listeners: red; remove the `enabled` filter: red. Restore.
- [ ] **Step 5: Commit** — `git commit -s -m "feat(video): an output can be stopped without losing its secret, and the console says what can reach it — R-VID-16, R-UI-24"`

---

### Task 11: Stream and preview policy; the preview exemption removed; drafts validated

**Files:**
- Modify: `packages/yonder-core/src/schema/config.ts` (`Preview`, new `Stream`)
- Modify: `packages/yonder-core/src/apply/reachability.ts`
- Create: `packages/yonder-core/src/apply/draft.ts`, `draft.test.ts`
- Test: `config.test.ts`, `reachability.test.ts`
- Modify: `docs/configuration.md`; regenerate the schema

**Interfaces:**
- Produces (spec §11):
  - `stream: { mode: "fixed"|"adaptive" (fixed); floor_kbps; ceiling_kbps }`, seeded from `bitrate_kbps`; main-stream bounds `100…20000`.
  - `preview: { mode (adaptive); size: "auto"|"1280x720"|"854x480"|"640x360"; ladder_top; ladder_bottom; floor_kbps (300); ceiling_kbps (2000); bitrate_kbps (400, the Fixed target); framerate }` — **`width`/`height` migrate into `size`; both present is an error**; bounds `100…4000`.
  - `validateDraft(draft, supportedRungs): DraftProblem[]` — floor ≤ ceiling; bottom ≤ top; a held size among the rungs; **never repairs**.
  - `interruption(draft, applied): string[]` — *restarts the picture*, *preview branch only*, or nothing.
  - `CAMERA_EXEMPT_LEAVES` **loses `preview`**; every policy field is load-bearing; `controls` stays exempt; a test enumerates the schema's leaves so an unknown sibling cannot inherit an exemption.

- [ ] **Step 1: Write the failing tests**

```ts
it("defaults: stream fixed, preview adaptive at 300–2000 kb/s, ladder at the supported ends", () => {
  const c = Camera.parse(minimal);
  expect(c.stream.mode).toBe("fixed"); expect(c.preview).toMatchObject({ mode: "adaptive", floor_kbps: 300, ceiling_kbps: 2000, size: "auto" });
});
it("migrates preview width/height into size, and refuses two sources", () => {
  expect(Camera.parse({ ...minimal, preview: { width: 640, height: 360 } }).preview.size).toBe("640x360");
  expect(() => Camera.parse({ ...minimal, preview: { width: 640, height: 360, size: "854x480" } })).toThrow();
});
it("a preview ceiling of 4000 is accepted and 4001 is not", ...);
it("seeds a stream's adaptive envelope from its fixed target", () => {
  const c = Camera.parse({ ...minimal, bitrate_kbps: 3000 }); expect(c.stream.floor_kbps).toBe(3000); expect(c.stream.ceiling_kbps).toBe(3000);
});
it("validateDraft names floor > ceiling and does not fix it", () => {
  expect(validateDraft({ preview: { floor_kbps: 2000, ceiling_kbps: 300 } }, RUNGS)).toEqual([expect.objectContaining({ path: "preview.floor_kbps" })]);
});
it("validateDraft refuses a held size the camera cannot make", ...);
it("interruption says restarts the picture for a source change, preview branch only for a rung", ...);
// R-NET-07: a 4 Mb/s preview can cost reachability on a thin link.
it("preview is no longer exempt from the reachability comparison", () => {
  expect(CAMERA_EXEMPT_LEAVES).not.toContain("preview");
  expect(differs(withPreview({ ceiling_kbps: 4000 }), withPreview({ ceiling_kbps: 2000 }))).toBe(true);
});
it("controls stays exempt", () => { expect(CAMERA_EXEMPT_LEAVES).toContain("controls"); });
it("every camera leaf is classified, and an unknown sibling is load-bearing", () => {
  for (const leaf of leavesOf(Camera)) expect(EXEMPT.has(leaf) || LOAD_BEARING.has(leaf)).toBe(true);
});
```

- [ ] **Step 2–4: Fail; implement; pass; mutation-check** — put `preview` back in the exempt list: red; make `validateDraft` swap floor and ceiling instead of reporting: red. Restore.
- [ ] **Step 5: Regenerate the schema; document the fields, the defaults and the migration; commit** — `git commit -s -m "feat(schema): stream and preview policy, the size ladder, drafts validated, and no blanket preview exemption — R-VID-07, R-VID-17, R-NET-07, R-CFG-03"`

**Phase 1 checkpoint.** `npm test && npm run lint` clean. Nothing drawn yet.

---

# Phase 2 — the blueprint corrected, then the library and the gallery

### Task 12: The blueprint takes spec §15's corrections before anything is built from it

**Files:**
- Modify: `docs/console/design/instrument-library/gallery/{cameras.js,deck.js,DraftSetBar.vue,DraftPicture.vue,DraftShell.vue,gallery.css,main.js}`
- Create: `docs/console/design/instrument-library/gallery/DraftCaptures.vue`, `DraftRangeFinder.vue`
- Modify: `docs/console/design/instrument-library/README.md`; re-render every PNG

**Why:** The gallery is the blueprint. Eight things the spec requires are not
drawn, and the M4 lesson is that nothing gets built from prose.

- [ ] **Step 1: Correct what is wrong**
  - Shutter: raw × 100 → `15 600 µs`, step 100, both cameras.
  - ELP exposure: `Aperture priority | Manual` from menu ids `[3, 1]`; nothing invented.
  - ELP zoom: device steps, no `×`.
  - Gating: the Pocket 2's shutter and ISO open under Manual **and** Shutter priority.

- [ ] **Step 2: Draw what is missing**
  - **The shared draft:** a Live edit to a stream or preview field draws the requested value as a third, hollow mark with *Pending · apply on Setup* beneath; a pending count on the rail linking to Setup; Setup lists each change with its interruption; `APPLY` and `DISCARD`; the draft survives Live↔Setup and a camera switch.
  - **Preview:** the Fixed target bar; `Smallest · Largest automatic size` pickers shown with `Auto`. **Stream:** floor and ceiling shown in Adaptive.
  - **ELP Photo mode** with *to this board*; **the captures panel** (`DraftCaptures.vue`) — board stills with view · download · delete — reachable beside Capture on Live and Setup.
  - **The sticky rail**, and the viewport contract: a 1440×900 capture with the picture, Aim and Capture above the fold; a full-page capture proving one vertical scroll, no horizontal overflow, no nested scroller.
  - **The range finder** (`DraftRangeFinder.vue`): a Setup step on a gimbal camera — one axis at a time, ≤ 5° a step, the limit flag watched, the envelope recorded per mounting and mode; the Aim panel inhibited with *envelope unknown — run the range finder* until it is.
  - **Cost as three numbers**: this viewer's delivery, the shared encode, the path total.

- [ ] **Step 3: Show the operator; take his corrections; re-render; update the README's decisions and gaps**
- [ ] **Step 4: Commit** — `git commit -s -m "docs(console): the blueprint takes the spec's corrections — drafts, captures, the range finder, the viewport contract"`

---

### Task 13: The gallery harness, in the package

**Files:**
- Create: `packages/node-red-dashboard-2-yonder/gallery/{index.html,main.js,specimens.js,gallery.css,vite.config.mjs,build-themes.mjs,gallery.test.ts}`
- Modify: `packages/node-red-dashboard-2-yonder/package.json` — `"gallery": "node gallery/build-themes.mjs && vite build --config gallery/vite.config.mjs"`

**Interfaces:**
- Produces: `SPECIMENS: { title: string; note: string; component: Component; props: object; payload: unknown }[]`; later tasks append one per component per state.

- [ ] **Step 1: Write the failing test**

```ts
import { readdirSync, readFileSync } from "node:fs";
it("has a specimen for every component in src/ui", () => {
  const components = readdirSync(uiDir).filter((f) => f.endsWith(".vue")).map((f) => f.replace(/\.vue$/, ""));
  const shown = new Set(SPECIMENS.map((s) => s.component.name ?? s.component.__name));
  for (const c of components) expect(shown).toContain(c);
});
it("renders from source, never from a built bundle", () => {
  const src = readFileSync(join(import.meta.dirname, "specimens.js"), "utf8");
  expect(src).not.toMatch(/resources\/|\/dist\//);
});
```

- [ ] **Step 2–4: Port the blueprint's harness** — components from `../src/ui/*.vue`; `provide("$dataTracker", () => {})`, `provide("$socket", { on(){}, off(){}, emit(){} })`, a `$store` of shape `{ state: { data: { messages: { [id]: { payload } } } } }`; the `<link id="theme">` **created in JavaScript** (Vite strips a static one); `base: "./"`; `build-themes.mjs` writes both palettes with `themeCss()` from `yonder-core`. Build; open; both palettes; pass.
- [ ] **Step 5: Commit** — `git commit -s -m "feat(console): render the instrument library whole, from source, in both palettes — R-UI-25"`

---

### Task 14: Three instruments the gallery caught clipping

**Files:** `ui/YonderDataBar.vue`, `ui/YonderSoftKeys.vue`, `ui/YonderBudget.vue`; new `databar.component.test.ts`, `softkeys.component.test.ts`; `budget.component.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// The defect seen on the board — `1280 × 7…` — reproduced standing alone.
it("draws every cell it was given, each value in full, and wraps rather than clips", () => {
  const w = bar(SIX_CELLS, PAYLOAD);
  expect(w.findAll(".y-bar__cell")).toHaveLength(6);
  expect(w.findAll(".y-bar__v").map((v) => v.text())).toEqual(expect.arrayContaining(["1280 × 720", "5.17 Mb/s at IP"]));
  expect(getComputedStyle(w.find(".y-bar").element).flexWrap).toBe("wrap");
});
it("six soft keys all render and the rail wraps, never scrolls", ...);   // a key nobody can see is a key that does not exist
it("separates the budget's label from its value", () => { expect(text).toContain("In use 0.0 of 3.2"); });
```

- [ ] **Step 2–4: Fail; fix (`flex-wrap`, `min-width: max-content`, a real gap); pass; look in the gallery**
- [ ] **Step 5: Commit** — `git commit -s -m "fix(console): three instruments that ran past their own edges — R-UI-25 found all three"`

---

### Task 15: The readout row and the text field

**Files:** `ui/YonderReadout.vue` + `readout.component.test.ts`; `ui/YonderTextField.vue` + `textfield.component.test.ts`; specimens

- [ ] **Step 1: Write the failing tests**

```ts
it("draws a label, a value and its unit, with a space between", () => {
  const w = rows([{ label: "Bitrate", value: "3.0", unit: "Mb/s" }]);
  expect(w.find(".y-ro__v").text()).toMatch(/3\.0\s+Mb\/s/);
});
it("never uppercases a unit", () => { expect(getComputedStyle(w.find(".y-ro__u").element).textTransform).toBe("none"); });
it("omits the unit slot when there is none; draws absent in the neutral tone", ...);
it("the text field emits on every keystroke, caps at 24, and shows n/24 while focused", ...);
```

- [ ] **Step 2–4: Fail; implement from the blueprint — the unit slot uses `margin-left: 4px`, never a leading space in the tag; pass; specimens**
- [ ] **Step 5: Commit** — `git commit -s -m "feat(console): the readout row and the text field — R-UI-08, R-UI-27"`

---

### Task 16: The picker, in all four states

**Files:** `ui/YonderPicker.vue` + `picker.component.test.ts`; specimens

**Interfaces:** props `{ label, value, options: { value, label }[], state, reason }`; emits `change`. A real `<select>` under the drawn control. `not-offered` renders nothing — the deck draws the fact.

- [ ] **Step 1: Write the failing tests**

```ts
it("offers exactly the options given — menu ids 1 and 3 are two options, never four", ...);
it("emits the chosen value", async () => { await w.find("select").setValue("3"); expect(w.emitted("change")?.[0]).toEqual(["3"]); });
it("draws advertised disabled, in the caution tone, carrying its reason", ...);
it("draws gated disabled, in the neutral tone, naming the way back — and never in caution", () => {
  expect(w.find(".y-pick__why").classes()).toContain("why-gated"); expect(w.find(".y-pick__why").classes()).not.toContain("why-advertised");
});
it("draws nothing at all when not offered", () => { expect(picker({ state: "not-offered" }).find("select").exists()).toBe(false); });
it("has a maximum width", () => { expect(getComputedStyle(el).maxWidth).not.toBe("none"); });
```

- [ ] **Step 2–4: Fail; implement; pass; mutation-check** — `why-gated` → `why-advertised`: red. Restore.
- [ ] **Step 5: Commit** — `git commit -s -m "feat(console): the picker, in all four capability states — R-CAM-14, R-UI-20, R-UI-21"`

---

### Task 17: The segmented control

**Files:** `ui/YonderSegmented.vue` + `segmented.component.test.ts`; specimens

- [ ] **Step 1: Write the failing tests** — exactly one `.on`; emits the pressed option; `maxWidth` set and `width` not `100%`; gated inert with the way back; emits nothing unless present.
- [ ] **Step 2–4: Fail; implement; pass; mutation-check** — remove `max-width`: red. Restore.
- [ ] **Step 5: Commit** — `git commit -s -m "feat(console): the segmented control, capped and never stretching — R-UI-08"`

---

### Task 18: The set bar — three marks, the device's own step, a readout when adaptive

**Files:** `ui/YonderSetBar.vue` + `setbar.component.test.ts`; specimens

**Interfaces:** props `{ label, unit, min, max, step, precision, actual, commanded, requested, state, reason, fine, readonly }`; emits `set`, snapped to `step` and clamped. `requested` is the draft's pending value — a third, hollow mark with *Pending · apply on Setup* beneath.

- [ ] **Step 1: Write the failing tests**

```ts
it("formats the device's value to its precision", ...);
it("draws a commanded mark only when it differs from the actual", ...);
it("draws a requested mark and the pending line when a draft exists", ...);
it("snaps what it emits to the device's step", async () => {
  const w = bar({ min: -648000, max: 648000, step: 3600, actual: 0 });
  await w.find(".y-sb__trk").trigger("pointerdown", { clientX: 91 });
  expect((w.emitted("set")![0] as [number])[0] % 3600).toBe(0);
});
it("clamps to the device's bounds", ...);
it("never uppercases its unit; has a fixed track width", ...);
it("gated: an em dash, no pointer, the way back, and it emits nothing", ...);
it("readonly (GOING OUT in Adaptive) emits nothing on a press", ...);
```

- [ ] **Step 2–4: Fail; implement sharing track geometry with `YonderGauge`; pass; mutation-check** snap, clamp, gated-emits-nothing, readonly-emits-nothing — each red in turn. Restore.
- [ ] **Step 5: Commit** — `git commit -s -m "feat(console): the set bar — one track, three marks, the device's own step — R-CTL-11 … R-CTL-14, R-CFG-03"`

---

### Task 19: Column, placard, position gauge, state overlay, thumb strip, shutter key

**Files:** `ui/YonderColumn.vue`, `YonderPlacard.vue`, `YonderPositionGauge.vue`, `YonderStateOverlay.vue`, `YonderThumbStrip.vue`, `YonderShutter.vue`; one `*.component.test.ts` each; specimens

- [ ] **Step 1: Write the failing tests, one block per part**

```ts
// Column
it("draws its legend and a right-hand qualifier in the given tone; none when empty", ...);
// Placard
it("draws the camera and what it is; a unit inside the right text keeps text-transform none", ...);
// Position gauge — R-UI-09
it("puts the pointer at (value − min)/(max − min) with the bounds beneath; dead is dashed with an em dash", ...);
// State overlay — R-VID-18
it("draws head, size, rate and bitrate, and the detail line", () => { expect(text).toContain("ADAPTIVE"); expect(text).toContain("1.8 of 0.3–2.0"); });
it("takes the caution tone at the floor, the fault tone on stills, select at full rate", ...);
it("shows the step line only when a step is set", ...);
it("shows this viewer's cost, the shared encode and the path total as three fields, never one sum", ...);
// Thumb strip — R-UI-03, R-VID-14
it("one thumb per camera; the active one on and Live; the others Still · n s; press emits go with the id", ...);
it("Downlink now is the measured path total, not the sum of two targets", ...);
// Shutter — R-CAM-17
it("reads RECORD in video mode and PHOTO in photo mode; press emits record or photo", ...);
it("lights and counts from recording.since; the destination line beneath", ...);
it("a second press while pending emits nothing", ...);
```

- [ ] **Step 2–4: Fail; implement; pass; mutation-check** the shutter's pending guard and the strip's press.
- [ ] **Step 5: Commit** — `git commit -s -m "feat(console): the deck's remaining parts, the picture's state, and the strip of the other cameras — R-VID-18, R-UI-03, R-CAM-17"`

---

### Task 20: The aim pad — rate, a gesture id, every way a gesture ends

**Files:** `ui/YonderAimPad.vue` + `aimpad.component.test.ts`; specimens

**Interfaces:** props `{ axes: { pan, tilt, roll }, atLimit: { pitch, yaw }, inhibited: string | null }`; emits `slew` `{ pan, tilt, seq, gesture }` and `stop` `{ gesture }`. Pointer capture. The dead zone emits `stop`; leaving it again starts a new gesture. Every end — `pointerup`, `pointercancel`, `pointerleave`, `lostpointercapture`, window `blur`, `visibilitychange` to hidden, `pagehide` — emits exactly one `stop`.

- [ ] **Step 1: Write the failing tests**

```ts
it("emits a rate while dragging, never a position", ...);
it("increments seq on every slew and carries one gesture id per drag", ...);
it("the dead zone emits stop; leaving it again starts a new gesture id", ...);
for (const ev of ["pointerup", "pointercancel", "pointerleave", "lostpointercapture"])
  it(`emits exactly one stop on ${ev}`, ...);
it("emits stop when the window blurs, when the page hides, and on pagehide", ...);
it("emits nothing while inhibited, and shows the reason", () => { /* inhibited: "envelope unknown — run the range finder" */ });
it("draws the struck axis for one that will not answer", ...);
it("draws the haloed puck at the centre at rest and under the pointer while pushing", ...);
```

- [ ] **Step 2–4: Fail; implement in the adopted idiom; pass; mutation-check** each end event and the inhibit — each red in turn.
- [ ] **Step 5: Commit** — `git commit -s -m "feat(console): the aim pad — rate, a gesture id, and every way a gesture ends — R-CAM-11, R-CMD-04"`

---

### Task 21: The draft store — a browser-session draft per camera

**Files:** `ui/draft.ts` + `draft.test.ts`

**Interfaces:**
- Produces: `createDraftStore(): { get(camera), set(camera, path, value), pending(camera): { path, requested }[], clear(camera), snapshot(), restore(snapshot) }` — kept in Dashboard's client store under `yonder.draft`; survives page switches for the session; **never posts to the socket**.

- [ ] **Step 1: Write the failing tests** — a set is pending until cleared; pending survives `snapshot`/`restore` (a page switch); per camera; `clear` empties; a set never calls `emit` (a spy stays uncalled).
- [ ] **Step 2–4: Fail; implement; pass; mutation-check** — call `emit` on set: the never-posts test goes red. Restore.
- [ ] **Step 5: Commit** — `git commit -s -m "feat(console): a shared draft per camera, in the browser session, that never applies on blur — R-CFG-03, R-UI-05"`

---

### Task 22: `ui-yonder-deck` — composes itself from the report, edits into the draft

**Files:** `ui/YonderDeck.vue`, `src/deck.ts`, `src/deck.html`, `ui/deck.component.test.ts`; `package.json` manifest and node list; specimens (both cameras, Live and Setup)

**Interfaces:**
- Node `ui-yonder-deck`, `emitsActions: true`, `passthru: false`. Editor prop `mode: "live" | "setup"`. Payload:

```ts
{ camera: { id, name, spec }, capabilities: CameraCapabilities,
  descriptors: Record<key, DescriptorView>, values: Record<key, number|boolean|null>,
  commanded: Record<key, number|null>, policy: { stream, preview }, applied: { stream, preview },
  outputs: { kind, label, enabled, costKbps, reach: OutputReach }[], captures: { count }, interruption: string[] }
```

- Emits on `msg.payload`: `{ control, value }` (an image control — a live command); `{ apply: Draft }`; `{ discard: true }`; `{ output, enabled }`; `{ shutter: "record"|"stop"|"photo" }`; `{ mode: "live"|"setup" }`; `{ name }` inside the draft. **Stream and preview edits go to the draft store, never the socket.**

- [ ] **Step 1: Write the failing tests**

```ts
it("draws a control for present, a fact for not-offered, the marked control for advertised and gated", ...);
it("omits a whole group when the camera has none of it", ...);
it("uses the descriptor's units: raw 156 draws as 15 600 µs", ...);
it("offers only the menu ids the probe listed", ...);
it("draws every control on Live, and the four bench-only ones only on Setup", ...);
it("an image control posts on press through the socket", ...);              // emitsActions is load-bearing
it("a stream edit goes to the draft and never to the socket", ...);
it("tabbing out of a preview picker posts nothing", ...);                    // defect 1
it("Apply posts the whole draft once; Discard clears it and posts nothing", ...);
it("shows the pending count and the interruption before Apply", ...);
it("groups flow into columns and no group is stranded on a row of its own", ...); // asserts column-width on the container
```

- [ ] **Step 2–4: Fail; implement** — a static table maps each capability key to its group, kind and descriptor, written down for the reason `CAPABILITY_KEYS` is; register with `emitsActions: true`; add to the manifest; pass; **mutation-check** — `emitsActions: false`: the press tests go red; delete the not-offered branch: red; make a draft edit `emit`: red. Restore.
- [ ] **Step 5: Commit** — `git commit -s -m "feat(console): the deck composes itself from what the camera answers, and edits into a draft — R-UI-08, R-UI-20, R-UI-21, R-CFG-03"`

---

### Task 23: `ui-yonder-aim` — the panel the Cockpit embeds

**Files:** `ui/YonderAim.vue`, `src/aim.ts`, `src/aim.html`, `ui/aim.component.test.ts`; manifest; specimens

**Interfaces:** node `ui-yonder-aim`, `emitsActions: true`. Payload `{ state, reason, pan, tilt, bounds: { pan: [lo, hi], tilt: [lo, hi] } | null, atLimit: { pitch, yaw }, mode, modes: string[], inhibited: string | null }`. Emits `{ slew }`, `{ stop }`, `{ mode }`, `{ recentre: true }`. **Depends on nothing the deck draws** (R-UI-28).

- [ ] **Step 1: Write the failing tests** — mounts alone from its payload; position against bounds; the rate block only when present; `RATE CONTROL` / `NOT ANSWERING` badge; the mode sentence; `Recentre gimbal` emits; inhibited shows the reason and the pad emits nothing; the dead state with its reason; every emission goes through the socket.
- [ ] **Step 2–4: Fail; implement; pass; mutation-check `emitsActions`**
- [ ] **Step 5: Commit** — `git commit -s -m "feat(console): the aim panel as its own node, so the Cockpit can carry it — R-UI-28, R-CAM-11"`

---

### Task 24: `ui-yonder-index`

**Files:** `ui/YonderIndex.vue`, `src/index-widget.ts/.html`, `ui/index.component.test.ts`; manifest; specimens

- [ ] **Step 1: Write the failing tests** — camera rows with name, bus, spec, the probe summary, the annunciator, a rate with `Mb/s`; rejection rows with the reason; press emits `{ camera: id }`; *No camera* when empty.
- [ ] **Step 2–4: Fail; implement from `cameras-index-day-v2.html`; pass; mutation-check `emitsActions`**
- [ ] **Step 5: Commit** — `git commit -s -m "feat(console): the cameras index as rows — R-CAM-12"`

---

### Task 25: The picture — in front, the right shape, wearing its state

**Files:** `ui/YonderPicture.vue`, `ui/picture.component.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it("takes the video's aspect ratio from loadedmetadata and has no fixed height", ...);
it("draws every overlay in front of the video", () => { for (const sel of OVERLAYS) expect(z(sel)).toBeGreaterThan(z(".y-pic__video")); });
it("mounts the state overlay from payload.state, and the step line only on a change", ...);
it("draws the REC pill from recording, the foot strip from the descriptor's label, LINK · DROP from stats", ...);
it("draws the thumb strip from payload.cameras", ...);
it("the drag layer emits slew/stop with the pad's gesture contract, measured from where the pointer went down", ...);
it("mounts and works with no deck present", ...);                            // R-UI-28
```

- [ ] **Step 2–4: Fail; implement; pass; mutation-check** the aspect binding and each gesture end.
- [ ] **Step 5: Commit** — `git commit -s -m "fix(console): the picture is the shape of the picture, its overlays are in front, and it says what it is — R-VID-18, R-UI-28"`

**Phase 2 checkpoint.** `npm run gallery` renders every component in every state in both palettes. **Show the operator before Phase 3.**

---

# Phase 3 — the pages and the defects

### Task 26: The theme in the head; no `ui-template` survives

**Files:** `packages/yonder-core/src/console/settings.ts`; `flows/flows.json` (remove `style-link`); `console/renderer.test.ts`; `flows.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it("puts the generated stylesheet in the served document's head", () => { expect(settings).toMatch(/<link[^>]+rel="stylesheet"[^>]+\/yonder\/theme\.css/); });
it("does not load the theme with an @import", () => { expect(settings).not.toContain("@import"); });
it("has no ui-template at all, so markup cannot be pasted into one", () => { expect(flows.filter((n) => n.type === "ui-template")).toHaveLength(0); });
it("has ui-markdown only on Diagnostics", ...);
```

- [ ] **Step 2–4:** confirm the Dashboard key first — `grep -rn "headContent\|head:" vendor/console/node_modules/@flowfuse/node-red-dashboard/nodes/`; implement; delete the node; pass; `./scripts/verify-pages.sh`; under `HOLD=1`, reload with a throttled network and confirm no white frame; **mutation-check** — add a `ui-template`: red.
- [ ] **Step 5: Commit** — `git commit -s -m "fix(console): the first paint carries its own theme, and no ui-template survives — R-UI-22"`

---

### Task 27: The gate photographs readings, measures overflow, and holds the viewport contract

**Files:** `scripts/capture-pages.mjs`; `scripts/fixtures/specimens.json`; `scripts/verify-pages.sh`; `docs/console/capture/`

- [ ] **Step 1: Write the specimens** — one widest honest value per field; the stream address's password **masked in the fixture** (R-SEC-10).
- [ ] **Step 2: Replace the masks with the specimens; add the overflow check**

```js
const clipped = await tab.$$eval("*", (els) => els
  .filter((el) => el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1)
  .map((el) => `${el.className} — ${el.textContent.trim().slice(0, 40)}`));
if (clipped.length) fail(`text is clipped:\n  ${clipped.join("\n  ")}`);
```

- [ ] **Step 3: Add the viewport captures** — `1440×900` with the sidebar, asserting the picture, Aim and Capture bounding boxes are inside the viewport; a full-page capture; assert no horizontal overflow, no nested scroller on the deck, and the rail's box inside the viewport at scroll bottom (the sticky rail).
- [ ] **Step 4: Capture every state spec §13 lists**, both palettes, notebook and tablet widths; review each by eye; `ACCEPT_SHAPE=1`; confirm no credential in any PNG.
- [ ] **Step 5: Prove the gate catches** — set a readout to `40px`: red. Revert.
- [ ] **Step 6: Commit** — `git commit -s -m "fix(console): the gate photographs readings, measures overflow, and holds the viewport contract — R-UI-23, R-UI-12"`

---

### Task 28: Rebuild both camera pages; wire the draft, Apply and Discard; prove defect 1

**Files:** `flows/flows.json`; `packages/yonder-core/src/flows.test.ts`; `packages/node-red-contrib-yonder-video/src/camera.ts`; `daemon/routes.ts`; `docs/adr/0009-console-visual-language.md`; `docs/requirements.md` (R-UI-10 amended)

**Interfaces:**
- `camera.ts` builds the deck's payload (capabilities, `describe()` views, values, policy, applied, outputs with `outputReach`, `interruption`) and routes emissions: `control` → `applyControls` (live, `POST /cameras/:id/controls`); `apply` → `validateDraft` then the protected apply path (`POST /cameras/:id/apply`) with its confirmation window; `discard` → nothing; `output` → `POST /cameras/:id/outputs/:kind`; `shutter` → Task 33; `slew`/`stop`/`mode`/`recentre` → Task 38.

- [ ] **Step 1: Write the failing tests**

```ts
it("has no stock control on either camera page", () => { for (const s of ["ui-slider","ui-number-input","ui-table","ui-text","ui-dropdown"]) expect(typesOn("Camera")).not.toContain(s); });
it("draws the Camera page from deck ×2, picture, aim, annunciator, databar, holdkey, softkeys", ...);
it("draws the Cameras page from index, budget, softkeys", ...);
it("uses only node types this install provides", ...);                        // R-UI-19
it("refuses an apply whose draft fails validation, returning the problems", ...);
it("an apply with a load-bearing change opens the confirmation window; a control never does", ...);
it("Record and Recentre are not on the rail", ...);                            // R-UI-26
```

- [ ] **Step 2–4: Delete the old groups; add the nodes; implement the routes; pass; `./scripts/verify-pages.sh`**
- [ ] **Step 5: Prove defect 1 on the board** — ask for the address; deploy; move a Live control (no toast); tab out of every Live field (no toast); edit bitrate on Live (pending, no toast); Apply on Setup (the window arms, correctly); while pending a network apply is refused; confirm. **If a toast appears from Live, the hypothesis was wrong — find the poster before going on.**
- [ ] **Step 6: Amend ADR-0009 with a *Resolved* section** — actions live beside the thing they act on where it is on the page (R-UI-26); the rail carries the page's own actions; and amend R-UI-10's text in `docs/requirements.md` accordingly.
- [ ] **Step 7: Commit** — `git commit -s -m "feat(console): both camera pages from instruments, editing into a draft that applies on Setup — R-UI-08, R-CFG-03, R-UI-26"`

---

### Task 29: Names, per-camera navigation, and the stream address

**Files:** `camera.ts`; `flows/flows.json`; `receive-line.ts` → `stream-address.ts` (+ html, tests)

- [ ] **Step 1: Write the failing tests** — the name field writes `cameras[].name` through the draft and Apply; the placard, page title, index row, strip and stream address read it; one Dashboard page per detected camera (R-UI-03); the stream-address node emits the four receivers' lines and marks a listener's line **unusable** when `outputReach` says so (R-UI-24).
- [ ] **Step 2–4: Fail; implement; pass**
- [ ] **Step 5: Commit** — `git commit -s -m "feat(console): a camera's name is the operator's; one page per camera; the stream address — R-UI-27, R-UI-03, R-VID-15, R-UI-24"`

**Phase 3 checkpoint.** Both pages on the board, both palettes, no stock control, no toast from Live. Defect 1 verified; 2–5 held by the gate.

---

# Phase 4 — the mechanisms

### Task 30: The runtime encoder channel

**Files:** `video/encoder.ts` + `encoder.test.ts`; `video/supervisor.ts` (a `send(id, msg)` to the process); `video/pipeline.ts`

**Interfaces:**
- Produces: `class EncoderChannel { retune(camera, encode: "stream"|"preview", kbps): Promise<Ack>; reconfigurePreview(camera, { size, fps }): Promise<Ack> }`, `Ack = { requested, observed, continuous: boolean, at } | { notControllable: string }`. Behaviour follows Task 1's decision: runtime retune where the encoder honours it; otherwise **the preview branch alone** restarts and the main stream and any board recording stay continuous. A fixed-passthrough main feed returns `notControllable`.

- [ ] **Step 1: Write the failing tests** (a fake process that records what it is sent and reports pts continuity) — retune sends the command and returns the observed rate; a preview reconfigure never touches the main branch (its pid and pts continuity asserted); failure keeps the last confirmed state and names the request; passthrough reports not controllable.
- [ ] **Step 2–4: Fail; implement per Task 1; pass; mutation-check** continuity.
- [ ] **Step 5: Commit** — `git commit -s -m "feat(video): a runtime encoder channel — bitrate without a respawn, the preview branch alone — R-VID-07"`

---

### Task 31: The rate controller and the size ladder

**Files:** `video/rate.ts` + `rate.test.ts` (a controllable clock)

**Interfaces:**
- Produces: `class RateController { constructor({ channel, clock, policy, thresholds: { tDown, tUp, hysteresisKbps } }); observe(report: { viewer, rtt, loss, egress, capacity, at }): void; tick(now): Decision[] }` — `Decision = { encode, kbps | size, reason }`, every one reported (Task 32 carries them). Rules (spec §8.1): inside the **applied** floor and ceiling; the stream's spend reserved first; step the preview's size down one rung after `tDown` pinned at the floor, up one rung after `tUp` of headroom, with hysteresis; a held size never steps; Fixed does nothing; **if even the floor cannot fit, report the shortfall and change nothing**; the most constrained fresh report wins; a stale report is not headroom; no evidence → hold and report unknown; never consumes a draft.

- [ ] **Step 1: Write the failing tests**

```ts
it("never goes outside the applied envelope", ...);
it("reserves the stream's spend before the preview gets any", ...);
it("steps down a rung only after being pinned at the floor for tDown", ...);
it("steps up only after headroom for tUp, and not straight back down", ...);
it("a held size never steps; Fixed never moves", ...);
it("when even the floor cannot fit, it reports the shortfall and changes nothing", ...);
it("uses the most constrained fresh report; a stale one is not headroom", ...);
it("with no fresh evidence it holds and reports unknown", ...);
it("every decision carries a reason", ...);
it("ignores a draft and reads only the applied policy", ...);
```

- [ ] **Step 2–4: Fail; implement; pass; mutation-check** each rule.
- [ ] **Step 5: Measure on the board** with a throttled link (`tc qdisc … netem`), choose `tDown`, `tUp` and the hysteresis so the preview does not hunt, and **record the values here:** tDown = __ s · tUp = __ s · hysteresis = __ kb/s.
- [ ] **Step 6: Commit** — `git commit -s -m "feat(video): the rate controller — inside the envelope, the stream first, a ladder with hysteresis — R-VID-07, R-VID-17"`

---

### Task 32: Viewers, and the preview-state message

**Files:** `video/viewers.ts` + `viewers.test.ts`; `daemon/routes.ts` (`/cameras/:id/viewers/:viewer`); `console/middleware.ts` (a viewer id on the WHEP session); `camera.ts`

**Interfaces:**
- Produces: `class Viewers { subscribe(viewer, camera, want: "video"|"stills"|"off"); fullRate(viewer, camera, held: boolean); report(viewer, stats); unsubscribe(viewer); state(camera, viewer): PreviewState }` with
  `PreviewState = { camera, viewer, revision, at, shared: { mode, size, fps, kbps, floor, ceiling, pinned, held, step }, mine: { delivery, source, size, fps, kbps, frameAge, interval, fullRate }, cost: { mine, shared, path } }`, published on change and on reconnect; browser stats tagged with ids and freshness.

- [ ] **Step 1: Write the failing tests** — two viewers share one encode; full rate switches only that viewer to the main stream; release, cancel, blur, disconnect and expiry end it; a viewer on stills does not move another off video; cost counts every transmitted copy once per path and shows `mine` separately; a stale stat cannot count as headroom; a page leaving unsubscribes its viewer and **no configured output changes**; revision increments on every publish; two pages of one camera in one session share the subscription.
- [ ] **Step 2–4: Fail; implement; pass; mutation-check** the full-rate isolation and unsubscribe-never-disables-an-output.
- [ ] **Step 5: Commit** — `git commit -s -m "feat(video): viewers, and the message the picture wears — R-VID-18, R-VID-11, R-VID-13"`

---

### Task 33: Board recording, pipeline stills, and the captures panel

**Files:** `video/recorder.ts` + `recorder.test.ts`; `daemon/routes.ts` (`/cameras/:id/record`, `/photo`, `/captures`); `node-red-contrib-yonder-video/src/captures.ts`; `ui/YonderCaptures.vue` + `captures.ts/.html` + test; `flows/flows.json`

**Interfaces:**
- Produces: `record(camera)`/`stop(camera)` to a bounded file with R-STO-06's reserve; `photo(camera)`: the camera's own capture where present, else a frame from the running pipeline **without restarting the source or interrupting a recording**; with no fresh frame a refusal with the reason; success only after the file is written or the camera confirms; one pending operation per camera. `captures(camera)`: list, fetch, delete.

- [ ] **Step 1: Write the failing tests** — recording stops at the reserve and says so; a pipeline photo leaves the source untouched and a recording continuous; no fresh frame → refused, never an old frame as new; a second press while pending is refused; camera-card photos are listed as such and not fetchable; the panel lists, opens, downloads and deletes with confirmation; the REC pill's source is the recorder's observed state for the board and the state push for the card.
- [ ] **Step 2–4: Fail; implement; pass; mutation-check** the reserve stop and the pending guard.
- [ ] **Step 5: Commit** — `git commit -s -m "feat(video): record to this board, a still from the pipeline, and the captures panel — R-CAM-17, R-CAM-18, R-STO-06"`

---

### Task 34: The stills strip, per viewer

**Files:** `video/viewers.ts`, the stills path in `video/`, tests

- [ ] **Step 1: Write the failing tests** — one still generated per camera per interval when requests coincide; every transmitted copy counted; frame age and interval reported; a viewer switching camera re-subscribes without disabling anything.
- [ ] **Step 2–4: Fail; implement; pass**
- [ ] **Step 5: Commit** — `git commit -s -m "feat(video): the other cameras as stills, generated once, every copy counted — R-VID-14, R-VID-11"`

**Phase 4 checkpoint.** On the board with a throttled link: the picture steps down a rung and says why; two browsers on one camera; Full rate on one only; a board photo from the ELP while it streams; the captures panel.

---

# Phase 5 — the accessory camera

### Task 35: DUML and the AOA session

**Files:** `video/accessory/duml.ts`, `aoa.ts`, and tests

- [ ] **Step 1: Write the failing tests** — encode/decode round-trip; the CRC8 and CRC16 vectors from `scripts/pocket2/duml.py`'s reference tables; a corrupted CRC → `null`; a truncated frame → `null`; the session answers the heartbeat and keeps the live view alive with the ping the bench found.
- [ ] **Step 2–4: Port faithfully, keeping the docstring's provenance; pass; mutation-check** — change a CRC seed: the vector test goes red and the round-trip does not, which is the point of having both.
- [ ] **Step 5: Commit** — `git commit -s -m "feat(video): DUML and the accessory session, from the bench — R-CAM-15"`

---

### Task 36: Expiring intent — the browser's gesture, checked in the daemon's clock

**Files:** `video/accessory/intent.ts` + `intent.test.ts`; `daemon/routes.ts` (`/cameras/:id/aim`)

**Interfaces:**
- Produces: `class Intent { constructor({ clock, leaseMs: 500 }); issue(): { gesture, deadline }; admit(msg: { gesture, seq, deadline, rate }): Admitted | Rejected; end(gesture): void; live(now): Rate | null }`. Deadlines are daemon-issued and validated in the daemon's monotonic clock; a lease lasts ≤ 500 ms without a fresh admitted renewal; expired, out-of-order and previous-gesture messages are rejected before any write; `end` clears queued motion at once; reconnect never resumes; a late frame from an ended gesture cannot restart motion; a browser clock cannot renew anything; latency beyond the budget inhibits new motion.

- [ ] **Step 1: Write the failing tests**

```ts
it("rejects a message whose deadline has passed in the daemon's clock", ...);
it("rejects out-of-order seq, and a previous gesture", ...);
it("a lease expires 500 ms after the last admitted renewal, with no stop message at all", ...);
it("end clears queued motion at once", ...);
it("a late frame from an ended gesture cannot restart motion", ...);
it("reconnect does not resume an old gesture", ...);
it("a browser wall clock cannot renew a lease", ...);
it("latency beyond the budget inhibits new motion rather than admitting stale commands", ...);
```

- [ ] **Step 2–4: Fail; implement with an injected clock; pass; mutation-check** every rejection.
- [ ] **Step 5: Commit** — `git commit -s -m "feat(video): expiring intent — a gesture the daemon admits, leases and ends — R-CAM-11, R-CMD-04"`

---

### Task 37: The gimbal — rate, attitude, limits, recentre, mode

**Files:** `video/accessory/gimbal.ts` + `gimbal.test.ts`

- [ ] **Step 1: Write the failing tests** — a rate frame is `0x0C` with flags `0x80`, three int16 tenths in the order pitch, roll, yaw, pitch sign inverted per the bench; frames repeat at 10 Hz **only while `Intent.live()` returns a rate**; attitude decodes tenths; **pitch limit = bit 0, yaw limit = bit 1**; recentre is `0x4C 02 01`; a mode command is `0x44` (asserted at the wire only until Task 39 drives it).
- [ ] **Step 2–4: Fail; implement; pass; mutation-check** the 10 Hz gate on `live()`.
- [ ] **Step 5: Commit** — `git commit -s -m "feat(video): gimbal rate, attitude, limits and recentre, measured — R-CAM-11, R-TEL-15"`

---

### Task 38: One guard for every motion command; the range finder

**Files:** `video/accessory/guard.ts` + `guard.test.ts`; `schema/config.ts` (`cameras[].gimbal.envelope` per mode, per mounting); `daemon/routes.ts` (`/cameras/:id/range-finder`); `ui/YonderRangeFinder.vue` + `range-finder.ts/.html` + test; `flows/flows.json`

**Interfaces:**
- Produces: `guard(cmd: Rate | Recentre | Mode, ctx: { envelope, mode, attitude, attitudeAge, limits, signsVerified, stopMargin }): Allowed | Refused`. Unknown envelope, unknown mode, stale attitude or unverified signs → refused per axis with the missing precondition; motion farther into a lit limit → refused; away from it → allowed only with fresh position and a verified direction inside a known envelope; recentre and mode changes allowed only from poses the bench established; a mode change ends the active gesture; the stop-bound's continuing travel is reserved. **The envelope comes from the operator-directed range finder** — one axis at a time, ≤ 5° a step, the flag watched, recorded per mounting and mode — never an autonomous sweep, never a manufacturer's figure. No absolute pointing command is exposed.

- [ ] **Step 1: Write the failing tests** — one per rule above; and for the range finder: refuses a step over 5°; stops on the limit flag; records the envelope per mode; the guard refuses everything until it has one; the finder never runs without an operator's press per step.
- [ ] **Step 2–4: Fail; implement; pass; mutation-check** every refusal.
- [ ] **Step 5: Commit** — `git commit -s -m "feat(video): one guard for rate, recentre and mode, and the range finder that gives it its envelope — R-CAM-11, R-CMD-04"`

---

### Task 39: The state push decoded; every untried command driven; the stop bound measured

**Files:** `video/accessory/state.ts` + `state.test.ts`; `docs/hardware/dji-pocket-2-over-usb.md`

- [ ] **Step 1: Decode `camera/0x80…0x88`** from recorded pushes — mode, record time, battery, card; failing tests from the recordings; pass.
- [ ] **Step 2: Drive, under the guard, mounted, with a card in the camera:** photo `0x01`, shutter `0x28`, focus `0x24/0x30/0x32`, record format `0x18`, sensor size `0x12`, standalone mode `0x44`, and record `0x02` confirmed by the push. Record each effect in the hardware note the way it records the others. **Only what answered becomes `present`; what did not becomes `advertised` with the note's sentence.**
- [ ] **Step 3: Give the Pocket 2 its own gate rules.** Every `openWhen` in
  `video/descriptors.ts` is the bench ELP's, read off its fixture, and that
  file says so: a second device gets its own rule written the same way, never
  a branch threaded into this one's. The Pocket 2 leaves shutter live under
  Manual **or** Shutter priority, where the ELP allows Manual alone, so a
  shared table would gate a working control. Write that device's table beside
  its source, of the same `ControlDescriptor` type, and prove both rules with
  a test each. **Only what Step 2 actually drove may claim to be a gate.**
- [ ] **Step 4: Measure the complete stop bound** — browser intent to observed rest — with the browser disconnected and USB intact, five runs; record beside Task 2's device term; confirm the sum is inside Task 36's budget or shrink the lease.
- [ ] **Step 5: Commit** — `git commit -s -m "feat(video): the camera's state push, every untried command driven, and the stop bound measured end to end — R-CAM-15"`

---

### Task 40: The accessory camera is a camera

**Files:** `video/accessory/source.ts` + `source.test.ts`; `schema/config.ts` (`source: "accessory"`); `probe/camera.ts`; `camera.ts`; `flows/flows.json`; `docs/configuration.md`; `docs/roadmap.md`

- [ ] **Step 1: Write the failing tests** — detection reports `aim` present with Task 38's envelope, `recording` on the camera's card, `zoom` digital with *the feed does not change*, `formats` not-offered with the stubs sentence; rejected with a reason when nothing answers.
- [ ] **Step 2–4: Implement; pass; prove end to end on the board** — the picture reaches a browser; the deck draws the Pocket 2's controls; the Aim panel drives the gimbal from the pad and from the picture and stops on release; the ELP on the same board still draws aim as not answering; both pages captured in both palettes.
- [ ] **Step 5: Move R-CAM-15 out of M5 in the roadmap with a sentence saying why; commit** — `git commit -s -m "feat(video): the DJI Pocket 2 as a camera, with a gimbal the console drives under guard — R-CAM-15"`

---

# Phase 6 — the Cockpit surface

### Task 41: The picture and the aim panel, with no deck around them

**Files:** `flows/flows.json` (a minimal Cockpit page carrying `ui-yonder-picture` and `ui-yonder-aim` only); `flows.test.ts`; `docs/console/capture/`

- [ ] **Step 1: Write the failing test** — a page with the picture and the aim node and no deck loads; both receive their own payloads; the state overlay, thumb strip, drag layer and every aim control work with no `ui-yonder-deck` present.
- [ ] **Step 2–4: Wire; capture in both palettes; prove on the board that a drag on the Cockpit picture slews the gimbal and stops on release**
- [ ] **Step 5: Commit** — `git commit -s -m "feat(console): the picture and the aim panel stand alone, for the Cockpit — R-UI-28"`

---

### Task 42: Close the loop

- [ ] Add every new requirement to `docs/requirements.md` verbatim from spec §12; file `K-46…K-50` as fixed with their commits; record Task 31's thresholds and Task 39's measurements in the hardware notes; update the blueprint README with what each draft became; `npm test && npm run lint && ./scripts/verify-pages.sh`.
- [ ] Commit — `git commit -s -m "docs: file the requirements, the known issues and the measurements this branch closed"`

---

## Self-review

**Spec coverage.** §1 → 14, 26, 27, 28. §2 → 3, 6, 7. §3 → 12, 22, 23, 25, 28, 29. §4 → 3, 4, 16–18, 22. §5 → 27, 41. §6 → 15–25, 33, 38. §7 Stream/Preview → 11, 18, 22, 30–32; the ELP's controls → 6–9; the Pocket 2's → 35–40; Aim → 20, 23, 36–38; Capture → 19, 33; Outputs → 10; the picture → 25, 32, 34; names and the address → 29; the editing contract → 21, 22, 28. §8.1 → 30, 31. §8.2 → 32. §8.3 → 33. §8.4 → 10. §8.5 → 39. §8.6 → 34. §8.7 → 36, 38, 39. §9 → 35–40. §10 → 26–28. §11 → 8, 10, 11, 38. §12 → 28, 42. §13 → the named tests above and the board proofs in 28, 31, 39, 40, 41; the viewport contract in 27. §14 → the seven phases. §15 → 12.

**Type consistency.** `ControlRange.inactive`/`menu` (3) → 7, 9, 22. `gated(value, by: { id, label })` and `advertised(value, reason)` (4) → 7, 9, 16–18, 22. `DESCRIPTORS`/`describe()` → `DescriptorView` (6) → 22, 25. `validateDraft`/`interruption` (11) → 22, 28. `createDraftStore` (21) → 22. `outputReach` (10) → 22, 29. `EncoderChannel` (30) → 31. `Viewers.state()` → `PreviewState` (32) → 19, 25. `Intent.live()` (36) → 37; `guard` (38) → 37, 40.

**Stated dependencies.** Task 1 decides Task 30's shape. Tasks 2 and 39 size Task 36's lease. Task 28 verifies defect 1's cause rather than assuming it. Nothing in Phase 5 marked untried is wired live before Task 39 drives it. Task 12 precedes every component so nothing is built from prose.
