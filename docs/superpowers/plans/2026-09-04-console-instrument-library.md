# Console Instrument Library — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every stock Dashboard widget on the two camera pages with
instruments from Yonder's own library, drawn by a deck that composes itself
from what the camera reports — and make the four capability states, the
sixteen live controls and the output reachability visible on hardware.

**Architecture:** Three phases in one branch. The model in `yonder-core` grows
first (capabilities, schema, probe map, write path, output reachability),
because nothing can be drawn before it is modelled. Then the Vue library and a
gallery that renders it whole from source in both palettes. Then the pages, the
five observed defects, and the DJI Pocket 2 as a real camera source so aim is
built against a gimbal that moves.

**Tech Stack:** TypeScript, Zod (`schema/config.ts`), Vue 3 SFCs built to UMD
by Vite, Vitest + `@vue/test-utils` + jsdom, Node-RED Dashboard 2.x,
Playwright (the capture gate), `v4l2-ctl`, GStreamer, mediamtx.

**Spec:** [`docs/superpowers/specs/2026-09-04-console-instrument-library.md`](../specs/2026-09-04-console-instrument-library.md)
**Blueprint:** [`docs/console/design/instrument-library/`](../../console/design/instrument-library/) — the drafts and their two renders. Layout, spacing and state treatment come from there.

## Global Constraints

- **Logic and presentation live in node packages.** No `function` node, no
  markup pasted into a `ui-template`, no `exec` node. `flows/` is wiring only.
- **Every change traces to a requirement ID.** New IDs this plan adds:
  `R-CTL-11`, `R-CTL-12`, `R-CTL-13`, `R-CTL-14`, `R-UI-21`, `R-UI-22`,
  `R-UI-23`, `R-UI-24`, `R-UI-25`, `R-VID-16`. IDs are stable — never reuse or
  renumber. Withdraw, never delete.
- **A node without tests will not be merged.**
- **Mutation-check every guard.** Delete the guard, confirm a test goes red,
  restore it. A guard that stays green when deleted is not a guard.
- **Both palettes.** Every rule reads `var(--yonder-*, <fallback>)`. No
  hard-coded colour anywhere, including in a fallback that is not the night
  value from `src/ui/tokens.css`.
- **A token carrying a unit is never uppercased.** `Mb/s`, never `MB/S` —
  which would say megabytes. Apply `text-transform: none` to every unit slot.
- **`emitsActions` is load-bearing.** Dashboard silently drops a
  `widget-action` from a widget that did not register `onAction` — every soft
  key once shipped dead this way with no error anywhere. Every widget that
  emits must set `emitsActions: true` **and** have a test that presses it.
- **No credential in a committed capture** (R-SEC-10). The receive line renders
  a stream password on screen; the gate must mask it.
- **The repository is self-contained.** No board address, no path outside the
  repository, in any committed file.
- **Commits are GPG-signed and DCO signed-off:** always `git commit -s`, never
  `--no-gpg-sign`.
- **Commit messages:** imperative mood, referencing the requirement ID.

**Test commands:**

| | |
|---|---|
| One package | `npm test -w yonder-core` · `npm test -w node-red-dashboard-2-yonder` |
| One file | `npx vitest run src/video/probe/parse.test.ts` (from the package dir) |
| Everything | `npm test` |
| Types | `npm run lint` |
| Pages end to end | `./scripts/verify-pages.sh` · `ACCEPT_SHAPE=1 ./scripts/verify-pages.sh` to adopt a deliberate change |
| Stand the console up | `HOLD=1 PORT=18900 ./scripts/verify-pages.sh` |

**The board.** A Raspberry Pi 4, user `yonder`, key-based, passwordless sudo,
with an ELP global-shutter camera on `/dev/video0` and a Quectel EC25.
**Its address moves — ask for the current one, never assume.** Restarting
`yonder-core` re-renders the network and can drop remote access; say so before
doing it.

## File Structure

**`packages/yonder-core/src/`**

| File | Responsibility after this plan |
|---|---|
| `video/capability.ts` | The four capability states and `CameraCapabilities`. Gains `gated`, and eleven new control keys |
| `video/probe/parse.ts` | `v4l2-ctl` output → structures. Gains the `inactive` flag and the control's gate |
| `video/probe/camera.ts` | `CONTROL_MAP`, detection. Gains the new controls and `pan`/`tilt` → `aim` |
| `video/controls.ts` | The write path. `CONTROL_NAMES` gains the new controls |
| `schema/config.ts` | `CameraControls` gains eleven fields; `CameraOutput` gains `enabled` |
| `video/outputs.ts` | **New.** Which paths can carry which output kind (R-UI-24) |
| `console/presentation.ts` | Re-exports the shapes the components import |

**`packages/node-red-dashboard-2-yonder/src/`**

| File | Responsibility |
|---|---|
| `ui/YonderReadout.vue` | **New.** Label · value · unit rows, stacked |
| `ui/YonderPicker.vue` | **New.** One value from what the device answered |
| `ui/YonderSegmented.vue` | **New.** Two or three exclusive choices, capped width |
| `ui/YonderSetBar.vue` | **New.** A bounded continuous value, two marks |
| `ui/YonderColumn.vue` | **New.** A titled group with a right-hand qualifier |
| `ui/YonderAimDial.vue` | **New.** Pan and tilt, two marks, per-axis capability |
| `ui/YonderDeck.vue` + `deck.ts` + `deck.html` | **New widget.** Composes the columns from the capability report |
| `ui/YonderIndex.vue` + `index.ts` + `index.html` | **New widget.** Camera rows and rejection rows |
| `ui/YonderPicture.vue` | Gains overlays, correct aspect, front z-order, drag layer |
| `ui/YonderDataBar.vue` | Truncation fixed |
| `ui/YonderSoftKeys.vue` | Overflow fixed |
| `ui/YonderBudget.vue` | Label/value spacing fixed |
| `gallery/` | **New.** Renders every component in every state, both palettes (R-UI-25) |

**`packages/yonder-core/src/video/accessory/`** — **new**, phase 3: `aoa.ts`
(the session), `duml.ts` (the protocol), `gimbal.ts` (rate commands and
attitude), `source.ts` (the camera source).

---

# Phase 1 — the model

### Task 1: A control can be gated by another control

**Files:**
- Modify: `packages/yonder-core/src/video/probe/parse.ts:77-100`
- Modify: `packages/yonder-core/src/video/capability.ts:68-77`
- Test: `packages/yonder-core/src/video/probe/parse.test.ts`

**Interfaces:**
- Consumes: `parseControls(stdout: string): Map<string, ControlRange>`
- Produces: `ControlRange` gains `readonly inactive: boolean`. Every existing
  construction site must set it; `false` is the default for a control with no
  `inactive` in its flags.

**Why:** `v4l2-ctl` marks a control `flags=inactive` when another control has
charge of it — `exposure_time_absolute` while `auto_exposure` is automatic.
Today the parser drops the flags entirely, so the page cannot tell a control
that is off from one that is unavailable. R-UI-21.

- [ ] **Step 1: Write the failing test**

Append to `packages/yonder-core/src/video/probe/parse.test.ts`:

```ts
describe("a control another control has charge of", () => {
  it("reads flags=inactive as gated", () => {
    const controls = parseControls([
      "                  auto_exposure 0x009a0901 (menu)   : min=0 max=3 default=3 value=3",
      "         exposure_time_absolute 0x009a0902 (int)    : min=1 max=10000 step=1 default=156 value=156 flags=inactive, has-min-max",
    ].join("\n"));
    expect(controls.get("exposure_time_absolute")?.inactive).toBe(true);
  });

  it("a control with other flags is not gated", () => {
    const controls = parseControls(
      "                     brightness 0x00980900 (int)    : min=-64 max=64 step=1 default=0 value=0 flags=has-min-max",
    );
    expect(controls.get("brightness")?.inactive).toBe(false);
  });

  it("a control with no flags at all is not gated", () => {
    const controls = parseControls(
      "        white_balance_automatic 0x0098090c (bool)   : default=1 value=1",
    );
    expect(controls.get("white_balance_automatic")?.inactive).toBe(false);
  });

  // `inactive` must not be matched inside another word. `has-min-max` and a
  // hypothetical `not-inactive` are both flags this must not read as gated.
  it("matches the flag as a whole word", () => {
    const controls = parseControls(
      "                          gamma 0x00980910 (int)    : min=64 max=300 step=1 default=110 value=110 flags=deactivated",
    );
    expect(controls.get("gamma")?.inactive).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run src/video/probe/parse.test.ts -t "gated" --root packages/yonder-core
```

Expected: FAIL — `inactive` is `undefined`, not `true`/`false`.

- [ ] **Step 3: Add the field to `ControlRange`**

In `packages/yonder-core/src/video/capability.ts`, inside `ControlRange`
(after `current`):

```ts
  /**
   * The device says this control exists and is out of reach right now,
   * because another control has charge of it — `exposure_time_absolute`
   * while `auto_exposure` is automatic (R-UI-21).
   *
   * **Not a fault.** A capability that misreports itself is `advertised` and
   * wears the caution tone because its whole job is to be noticed. This is
   * the camera behaving correctly under a setting the operator chose, so it
   * is drawn neutral and carries the way back rather than a complaint.
   */
  readonly inactive: boolean;
```

- [ ] **Step 4: Read the flag in the parser**

In `parseControls` (`parse.ts`), after `const current = field("value");`:

```ts
    // Whole word: `has-min-max` and `deactivated` both contain neither an
    // `inactive` token nor a reason to be read as one, and a substring test
    // would eventually find one that does.
    const flags = /\bflags=([\w\-, ]+)/.exec(rest)?.[1] ?? "";
    const inactive = flags.split(/\s*,\s*/).includes("inactive");
```

and add `inactive,` to the object passed to `out.set(name, {...})`.

- [ ] **Step 5: Run the test — expect PASS**

```bash
npx vitest run src/video/probe/parse.test.ts --root packages/yonder-core
```

- [ ] **Step 6: Fix every other construction site**

```bash
npm run lint 2>&1 | grep -n "inactive"
```

Add `inactive: false` to each `ControlRange` literal the type checker names —
fixtures and test helpers included. Re-run until `npm run lint` is clean.

- [ ] **Step 7: Mutation-check the guard**

Change `.includes("inactive")` to `.includes("active")` and run
`npx vitest run src/video/probe/parse.test.ts --root packages/yonder-core`.
Expected: the *whole word* test goes red. Restore.

- [ ] **Step 8: Commit**

```bash
git add packages/yonder-core/src/video/probe/parse.ts packages/yonder-core/src/video/capability.ts packages/yonder-core/src/video/probe/parse.test.ts
git commit -s -m "feat(video): read flags=inactive, so a gated control is not a missing one — R-UI-21"
```

---

### Task 2: The gated capability state

**Files:**
- Modify: `packages/yonder-core/src/video/capability.ts:42-56`
- Modify: `packages/yonder-core/src/video/capability.ts:142-150` (`summarise`)
- Test: `packages/yonder-core/src/video/capability.test.ts`

**Interfaces:**
- Produces: `Capability<T>` gains a fourth member
  `{ readonly state: "gated"; readonly value: T; readonly by: string }`, and
  `export function gated<T>(value: T, by: string): Capability<T>`. `by` is the
  operator-facing name of the control that has charge — `"auto exposure"`, not
  `"auto_exposure"`.

- [ ] **Step 1: Write the failing test**

Append to `packages/yonder-core/src/video/capability.test.ts`:

```ts
import { gated, summarise, noCapabilities, present } from "./capability.js";

const range = { min: 1, max: 10000, step: 1, default: 156, current: 156, inactive: true };

describe("gated", () => {
  it("keeps the value, because the control is real and in range", () => {
    const cap = gated(range, "auto exposure");
    expect(cap.state).toBe("gated");
    if (cap.state !== "gated") throw new Error("narrowing");
    expect(cap.value.max).toBe(10000);
    expect(cap.by).toBe("auto exposure");
  });

  it("summarises as the control that has charge, not as absent", () => {
    const caps = { ...noCapabilities(), exposure: gated(range, "auto exposure") };
    expect(summarise(caps)).toContain("exposure: auto exposure has it");
  });

  // The distinction the whole design turns on: a fault and a setting must not
  // read alike in the one line that summarises a camera.
  it("does not summarise as unanswered, which is the fault state", () => {
    const caps = { ...noCapabilities(), exposure: gated(range, "auto exposure") };
    expect(summarise(caps)).not.toContain("exposure: unanswered");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run src/video/capability.test.ts -t "gated" --root packages/yonder-core
```

Expected: FAIL — `gated` is not exported.

- [ ] **Step 3: Add the state**

In `capability.ts`, extend the union (after the `advertised` member):

```ts
  | { readonly state: "gated"; readonly value: T; readonly by: string };
```

and add the constructor beside `advertised`:

```ts
/**
 * Real, in range, and out of reach because another control has charge of it
 * (R-UI-21). `by` is what an operator calls that control — "auto exposure",
 * never "auto_exposure" — because it is printed on the page as the way back.
 */
export function gated<T>(value: T, by: string): Capability<T> {
  return { state: "gated", value, by };
}
```

- [ ] **Step 4: Teach `summarise` the fourth state**

In `summarise`, beside the `advertised` branch:

```ts
    if (cap.state === "gated") return `${key}: ${cap.by} has it`;
```

- [ ] **Step 5: Run the test — expect PASS**

```bash
npx vitest run src/video/capability.test.ts --root packages/yonder-core && npm run lint
```

Fix any exhaustive `switch` the type checker now reports as non-exhaustive.
**Do not add a `default:` branch** — an unhandled state must stay a type error,
which is what stops a fifth state shipping half-drawn.

- [ ] **Step 6: Mutation-check**

Delete the `gated` branch in `summarise`. Expected: the summarise test goes
red. Restore.

- [ ] **Step 7: Commit**

```bash
git add packages/yonder-core/src/video/capability.ts packages/yonder-core/src/video/capability.test.ts
git commit -s -m "feat(video): a fourth capability state — a control another setting has charge of — R-UI-21"
```

---

### Task 3: The capabilities the device actually answers

**Files:**
- Modify: `packages/yonder-core/src/video/capability.ts:95-135`
- Test: `packages/yonder-core/src/video/capability.test.ts`

**Interfaces:**
- Produces: `CameraCapabilities` gains, all `Capability<ControlRange>`:
  `gain`, `backlightCompensation`, `gamma`, `sharpness`, `saturation`, `hue`,
  `powerLineFrequency`, `autoExposure`, `autoWhiteBalance`, `autoFocus`.
  `CAPABILITY_KEYS` gains the same ten, in that order, after `contrast`.

**Why:** the bench camera answers eighteen controls; the model carries eleven.
R-CTL-11 … R-CTL-14.

- [ ] **Step 1: Write the failing test**

```ts
import { CAPABILITY_KEYS, noCapabilities } from "./capability.js";

describe("the capabilities a UVC camera actually answers", () => {
  // Written down rather than derived, for the reason CAPABILITY_KEYS itself
  // is: a capability added to the type and forgotten here is a control that
  // silently never reaches a page.
  it("carries every control the bench camera reports", () => {
    for (const key of [
      "gain", "backlightCompensation", "gamma", "sharpness", "saturation",
      "hue", "powerLineFrequency", "autoExposure", "autoWhiteBalance", "autoFocus",
    ]) {
      expect(CAPABILITY_KEYS).toContain(key);
    }
  });

  it("defaults every one of them to not-offered", () => {
    const caps = noCapabilities();
    for (const key of CAPABILITY_KEYS) {
      expect(caps[key].state).toBe("not-offered");
    }
  });

  it("has one key per field, and no field without a key", () => {
    expect([...CAPABILITY_KEYS].sort()).toEqual(Object.keys(noCapabilities()).sort());
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run src/video/capability.test.ts -t "actually answers" --root packages/yonder-core
```

- [ ] **Step 3: Add the fields and the keys**

In `CameraCapabilities`, after `contrast`:

```ts
  /** The other half of exposure: amplification, at the cost of noise. */
  readonly gain: Capability<ControlRange>;
  /** Ground against sky, which is most of what a UAS camera looks at. */
  readonly backlightCompensation: Capability<ControlRange>;
  readonly gamma: Capability<ControlRange>;
  /** Over-sharpening spends uplink on edges the encoder then has to carry. */
  readonly sharpness: Capability<ControlRange>;
  readonly saturation: Capability<ControlRange>;
  readonly hue: Capability<ControlRange>;
  readonly powerLineFrequency: Capability<ControlRange>;
  /** The switches that gate shutter, temperature and focus (R-UI-21). */
  readonly autoExposure: Capability<ControlRange>;
  readonly autoWhiteBalance: Capability<ControlRange>;
  readonly autoFocus: Capability<ControlRange>;
```

Add the same ten names to `CAPABILITY_KEYS` and to `noCapabilities()` as
`notOffered()`.

- [ ] **Step 4: Run the test — expect PASS**

```bash
npx vitest run src/video/capability.test.ts --root packages/yonder-core && npm run lint
```

- [ ] **Step 5: Commit**

```bash
git add packages/yonder-core/src/video/capability.ts packages/yonder-core/src/video/capability.test.ts
git commit -s -m "feat(video): model the ten controls the bench camera answers and the page never showed — R-CTL-11 … R-CTL-14"
```

---

### Task 4: Probe them, and stop pretending this camera has no aim

**Files:**
- Modify: `packages/yonder-core/src/video/probe/camera.ts:143-152` (`CONTROL_MAP`)
- Modify: `packages/yonder-core/src/video/probe/camera.ts` (the mapping loop)
- Test: `packages/yonder-core/src/video/probe/camera.test.ts`
- Fixture: `packages/yonder-core/src/video/probe/fixtures/list-ctrls-menus-globalshutter.txt` (already contains the real output)

**Interfaces:**
- Consumes: `parseControls` (Task 1), `gated` (Task 2), the new keys (Task 3).
- Produces: `CONTROL_MAP` gains eleven pairs. A control whose `ControlRange`
  is `inactive` becomes `gated(range, by)`, where `by` comes from a new
  `GATED_BY` map: `exposure_time_absolute` → `"auto exposure"`,
  `white_balance_temperature` → `"auto white balance"`, `focus_absolute` →
  `"auto focus"`.

**Why:** the ELP advertises `pan_absolute` and `tilt_absolute` at ±648000 in
steps of 3600 — ±180° in 1° steps — and has no motor. Mapping them to `aim`
makes the advertised-but-not-answered state provable on the bench, which is the
state the M4 spec calls the one most likely to be got wrong in code.

- [ ] **Step 1: Write the failing test**

Append to `camera.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

const listCtrls = readFileSync(
  join(import.meta.dirname, "fixtures/list-ctrls-menus-globalshutter.txt"), "utf8");

describe("the bench camera's controls", () => {
  it("fills the ten controls that had no home", async () => {
    const caps = await capabilitiesFrom(listCtrls);
    expect(caps.gain.state).toBe("present");
    expect(caps.backlightCompensation.state).toBe("present");
    expect(caps.autoExposure.state).toBe("present");
    expect(caps.autoWhiteBalance.state).toBe("present");
  });

  // The state this whole design turns on, and this camera hands it to us.
  it("reports the pan and tilt it advertises with no motor behind them", async () => {
    const caps = await capabilitiesFrom(listCtrls);
    expect(caps.aim.state).toBe("advertised");
    if (caps.aim.state !== "advertised") throw new Error("narrowing");
    expect(caps.aim.reason).toMatch(/pan/i);
  });

  it("gates the three controls an automatic mode has charge of", async () => {
    const caps = await capabilitiesFrom(listCtrls);
    expect(caps.exposure.state).toBe("gated");
    expect(caps.whiteBalance.state).toBe("gated");
    expect(caps.focus.state).toBe("gated");
    if (caps.exposure.state !== "gated") throw new Error("narrowing");
    expect(caps.exposure.by).toBe("auto exposure");
  });

  // A gated control is not an absent one: its bounds are still real, and the
  // page draws them the moment the switch above it moves.
  it("keeps a gated control's range", async () => {
    const caps = await capabilitiesFrom(listCtrls);
    if (caps.exposure.state !== "gated") throw new Error("narrowing");
    expect(caps.exposure.value.max).toBe(10000);
  });
});
```

Add the helper at the top of the describe block, matching however
`camera.test.ts` already stubs its runner — a fake `CommandRunner` returning
`{ code: 0, stdout, stderr: "" }` for `v4l2-ctl --list-ctrls`.

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run src/video/probe/camera.test.ts -t "bench camera's controls" --root packages/yonder-core
```

- [ ] **Step 3: Extend `CONTROL_MAP` and add `GATED_BY`**

```ts
export const CONTROL_MAP = [
  ["brightness", "brightness"],
  ["contrast", "contrast"],
  ["rotate", "rotation"],
  ["zoom_absolute", "zoom"],
  ["focus_absolute", "focus"],
  ["exposure_time_absolute", "exposure"],
  ["white_balance_temperature", "whiteBalance"],
  ["gain", "gain"],
  ["backlight_compensation", "backlightCompensation"],
  ["gamma", "gamma"],
  ["sharpness", "sharpness"],
  ["saturation", "saturation"],
  ["hue", "hue"],
  ["power_line_frequency", "powerLineFrequency"],
  ["auto_exposure", "autoExposure"],
  ["white_balance_automatic", "autoWhiteBalance"],
  ["focus_automatic_continuous", "autoFocus"],
] as const;

/**
 * Which control has charge of which, in the words an operator uses.
 *
 * The page prints this as the way back — *while auto exposure is on* — so it
 * is the operator's name for the switch, never V4L2's.
 */
export const GATED_BY: Record<string, string> = {
  exposure_time_absolute: "auto exposure",
  white_balance_temperature: "auto white balance",
  focus_absolute: "auto focus",
};
```

- [ ] **Step 4: Map `inactive` to `gated` where the controls are resolved**

Wherever `CONTROL_MAP` is walked to build capabilities, replace the
unconditional `present(range)` with:

```ts
    const by = GATED_BY[v4l2Name];
    caps[key] = range.inactive && by ? gated(range, by) : present(range);
```

- [ ] **Step 5: Map pan and tilt to aim**

Beside that loop:

```ts
  // R-CAM-14's third state, from a camera on the bench rather than a fixture.
  // A UVC camera can list pan and tilt with a full ±180° range and no motor
  // anywhere behind them: every write is acknowledged and the frame never
  // moves. Reporting that as `aim: none` would be the console telling the
  // operator a comfortable thing that is not true.
  const pan = controls.get("pan_absolute");
  const tilt = controls.get("tilt_absolute");
  if (pan || tilt) {
    const axes = [pan && "pan", tilt && "tilt"].filter(Boolean).join(" and ");
    caps.aim = advertised(
      `This device lists ${axes} over ±180° in 1° steps. Nothing behind it moves.`,
    );
  }
```

- [ ] **Step 6: Run the test — expect PASS**

```bash
npx vitest run src/video/probe/camera.test.ts --root packages/yonder-core && npm test -w yonder-core
```

The existing cross-check between `CONTROL_MAP` and `CONTROL_NAMES` will now
fail. **Leave it failing** — Task 6 closes it, and a red cross-check is exactly
the alarm it was written to raise.

- [ ] **Step 7: Mutation-check both new guards**

Delete the `range.inactive && by` condition (always `present`): the gated tests
go red. Restore. Delete the `if (pan || tilt)` block: the advertised test goes
red. Restore.

- [ ] **Step 8: Commit**

```bash
git add packages/yonder-core/src/video/probe/camera.ts packages/yonder-core/src/video/probe/camera.test.ts
git commit -s -m "feat(video): probe the controls the model gained, and report the aim this camera advertises — R-CAM-14"
```

---

### Task 5: The config carries every control

**Files:**
- Modify: `packages/yonder-core/src/schema/config.ts:326-332` (`CameraControls`)
- Test: `packages/yonder-core/src/schema/config.test.ts`
- Modify: `docs/configuration.md`

**Interfaces:**
- Produces: `CameraControls` gains, each `.int().nullable().default(null)`
  with the bound in the comment: `gain`, `backlightCompensation`, `gamma`,
  `sharpness`, `saturation`, `hue`, `exposureTime`, `whiteBalanceTemperature`,
  `focus`, `zoom`, `powerLineFrequency`; plus three booleans defaulting to
  `null`: `autoExposure`, `autoWhiteBalance`, `autoFocus`.
  **`null` means leave the camera alone** — it is not zero and not a default.

- [ ] **Step 1: Write the failing test**

```ts
describe("camera controls", () => {
  it("accepts every control the bench camera answers", () => {
    const parsed = CameraControls.parse({
      brightness: 12, contrast: 30, gain: 200, backlightCompensation: 54,
      gamma: 110, sharpness: 3, saturation: 56, hue: 0, exposureTime: 156,
      whiteBalanceTemperature: 4600, focus: 347, zoom: 12, powerLineFrequency: 1,
      autoExposure: true, autoWhiteBalance: true, autoFocus: false,
    });
    expect(parsed.gain).toBe(200);
    expect(parsed.autoFocus).toBe(false);
  });

  // An absent control is "leave the camera alone", and 0 is a real setting on
  // every one of these ranges. Conflating them would have Yonder writing a
  // value nobody chose on every apply.
  it("defaults every control to null, never to zero", () => {
    const parsed = CameraControls.parse({});
    expect(parsed.gain).toBeNull();
    expect(parsed.autoExposure).toBeNull();
    expect(parsed.exposureTime).toBeNull();
  });

  it("refuses a control outside the range any UVC camera could report", () => {
    expect(() => CameraControls.parse({ gain: 10_000_000 })).toThrow();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run src/schema/config.test.ts -t "camera controls" --root packages/yonder-core
```

- [ ] **Step 3: Extend the schema**

```ts
/**
 * Image controls: applied live on the running stream, never a respawn.
 *
 * **`null` is "leave the camera alone", and it is not zero.** Every range
 * here has a real zero — gain 0, hue 0, brightness 0 — so a schema that
 * defaulted to it would have Yonder writing a setting nobody chose on every
 * apply, on every camera, forever.
 *
 * The bounds are the widest any UVC device could report, not this camera's:
 * the device's own min/max come from the probe (R-CAM-14) and are what the
 * page draws against. These only catch a config file that has lost its mind.
 */
const ctl = (lo: number, hi: number) => z.number().int().min(lo).max(hi).nullable().default(null);

const CameraControls = z.object({
  brightness: ctl(-100, 100),
  contrast: ctl(-100, 100),
  gain: ctl(0, 65535),
  backlightCompensation: ctl(0, 65535),
  gamma: ctl(0, 65535),
  sharpness: ctl(0, 65535),
  saturation: ctl(0, 65535),
  hue: ctl(-32768, 32767),
  /** Microseconds, as V4L2 reports it. */
  exposureTime: ctl(0, 1_000_000),
  /** Kelvin. */
  whiteBalanceTemperature: ctl(0, 20000),
  focus: ctl(0, 65535),
  zoom: ctl(0, 65535),
  /** The V4L2 menu index: 0 disabled, 1 50 Hz, 2 60 Hz. */
  powerLineFrequency: ctl(0, 2),
  autoExposure: z.boolean().nullable().default(null),
  autoWhiteBalance: z.boolean().nullable().default(null),
  autoFocus: z.boolean().nullable().default(null),
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).default(0),
}).strict();
```

- [ ] **Step 4: Run the test — expect PASS**

```bash
npx vitest run src/schema/config.test.ts --root packages/yonder-core
```

- [ ] **Step 5: Regenerate the published schema and document the fields**

```bash
npm run build -w yonder-core
```

Regenerate the published JSON schema the same way `ee7e1aa` did, and add every
new field to the camera-controls table in `docs/configuration.md`, each with
its unit and the sentence that `null` leaves the camera alone.

- [ ] **Step 6: Commit**

```bash
git add packages/yonder-core/src/schema/config.ts packages/yonder-core/src/schema/config.test.ts docs/configuration.md
git commit -s -m "feat(schema): carry every camera control the device answers — R-CTL-11 … R-CTL-14"
```

---

### Task 6: Write them to the device

**Files:**
- Modify: `packages/yonder-core/src/video/controls.ts:60-76` (`CONTROL_NAMES`)
- Test: `packages/yonder-core/src/video/controls.test.ts`

**Interfaces:**
- Consumes: `CameraControls` (Task 5), `CONTROL_MAP` (Task 4).
- Produces: `CONTROL_NAMES` gains one entry per new schema field. The existing
  `satisfies Record<keyof Camera["controls"], string>` makes a missing one a
  compile error; the existing cross-check test (red since Task 4) goes green.

- [ ] **Step 1: Write the failing test**

```ts
describe("writing the controls the model gained", () => {
  it("sends a boolean switch as 1 or 0, which is what V4L2 takes", async () => {
    const calls: string[][] = [];
    await applyControls({
      node: "/dev/video0",
      controls: { autoWhiteBalance: false },
      capabilities: { ...noCapabilities(), autoWhiteBalance: present(boolRange) },
      runner: async (argv) => { calls.push(argv); return { code: 0, stdout: "", stderr: "" }; },
    });
    expect(calls.flat().join(" ")).toContain("white_balance_automatic=0");
  });

  it("refuses a control this camera does not offer, and says so", async () => {
    const result = await applyControls({
      node: "/dev/video0",
      controls: { gain: 200 },
      capabilities: noCapabilities(),
      runner: async () => ({ code: 0, stdout: "", stderr: "" }),
    });
    expect(result.refused.map((r) => r.control)).toContain("gain");
  });

  // R-UI-21 reaching the write path: a gated control is refused with the name
  // of the switch that has it, so the operator is told what to turn off
  // rather than that their camera is broken.
  it("refuses a gated control naming the setting that has charge", async () => {
    const result = await applyControls({
      node: "/dev/video0",
      controls: { exposureTime: 400 },
      capabilities: { ...noCapabilities(), exposure: gated(range, "auto exposure") },
      runner: async () => ({ code: 0, stdout: "", stderr: "" }),
    });
    expect(result.refused[0].reason).toContain("auto exposure");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run src/video/controls.test.ts -t "the model gained" --root packages/yonder-core
```

- [ ] **Step 3: Extend `CONTROL_NAMES`**

```ts
export const CONTROL_NAMES = {
  brightness: "brightness",
  contrast: "contrast",
  gain: "gain",
  backlightCompensation: "backlight_compensation",
  gamma: "gamma",
  sharpness: "sharpness",
  saturation: "saturation",
  hue: "hue",
  exposureTime: "exposure_time_absolute",
  whiteBalanceTemperature: "white_balance_temperature",
  focus: "focus_absolute",
  zoom: "zoom_absolute",
  powerLineFrequency: "power_line_frequency",
  autoExposure: "auto_exposure",
  autoWhiteBalance: "white_balance_automatic",
  autoFocus: "focus_automatic_continuous",
  rotation: "rotate",
} as const satisfies Record<keyof Camera["controls"], string>;
```

- [ ] **Step 4: Send booleans as 1/0, and refuse a gated control**

In `applyControls`, where the value is formatted:

```ts
    // V4L2 takes an integer for a bool control; `true` on the command line is
    // not a value it parses.
    const wire = typeof value === "boolean" ? (value ? 1 : 0) : value;
```

and beside the existing not-offered refusal:

```ts
    if (cap.state === "gated") {
      refused.push({
        control,
        reason: `${cap.by} has charge of this control. Turn it off to set it by hand.`,
      });
      continue;
    }
```

- [ ] **Step 5: Run the whole package — expect PASS, including the cross-check**

```bash
npm test -w yonder-core && npm run lint
```

The `CONTROL_MAP` / `CONTROL_NAMES` cross-check, red since Task 4, is green.

- [ ] **Step 6: Mutation-check**

Delete the `cap.state === "gated"` refusal. Expected: the gated-refusal test
goes red. Restore. Delete the boolean `wire` conversion. Expected: the
switch test goes red. Restore.

- [ ] **Step 7: Commit**

```bash
git add packages/yonder-core/src/video/controls.ts packages/yonder-core/src/video/controls.test.ts
git commit -s -m "feat(video): write every modelled control, and refuse a gated one by naming its gate — R-CTL-11 … R-CTL-14, R-UI-21"
```

---

### Task 7: An output can be stopped without being thrown away

**Files:**
- Modify: `packages/yonder-core/src/schema/config.ts:294-306` (`CameraOutput`)
- Modify: wherever outputs are rendered into mediamtx/GStreamer configuration
- Test: `packages/yonder-core/src/schema/config.test.ts`

**Interfaces:**
- Produces: every `CameraOutput` variant gains
  `enabled: z.boolean().default(true)`. A disabled output keeps its port, path
  and secret and produces no pipeline.

- [ ] **Step 1: Write the failing test**

```ts
describe("stopping an output", () => {
  it("defaults to enabled, so an existing config means what it meant", () => {
    const out = CameraOutput.parse({ kind: "rtsp", path: "nose" });
    expect(out.enabled).toBe(true);
  });

  // Deleting the output would work and would throw away the port, the path
  // and the secret — so turning it back on would be re-entering all three.
  it("keeps its path and its secret while disabled", () => {
    const out = CameraOutput.parse({
      kind: "rtsp", path: "nose", enabled: false,
      password: { secret: "rtsp_password" },
    });
    expect(out.enabled).toBe(false);
    expect(out.path).toBe("nose");
    expect(out.password).toEqual({ secret: "rtsp_password" });
  });

  it("renders no pipeline for a disabled output", () => {
    const rendered = renderOutputs([
      { kind: "rtp", host: "10.0.0.2", port: 5600, enabled: true },
      { kind: "rtsp", path: "nose", enabled: false },
    ]);
    expect(rendered).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run src/schema/config.test.ts -t "stopping an output" --root packages/yonder-core
```

- [ ] **Step 3: Add the field and honour it**

Add `enabled: z.boolean().default(true),` to each `CameraOutput` variant, and
filter on it wherever outputs become pipelines:

```ts
  // An output that is off produces nothing and keeps everything: its port,
  // its path and its secret survive, so turning it back on is one press and
  // not a form (R-VID-16).
  for (const out of camera.outputs.filter((o) => o.enabled)) {
```

- [ ] **Step 4: Run the test — expect PASS**

```bash
npm test -w yonder-core
```

- [ ] **Step 5: Mutation-check**

Remove `.filter((o) => o.enabled)`. Expected: the render test goes red.
Restore.

- [ ] **Step 6: Commit**

```bash
git add packages/yonder-core/src/schema/config.ts packages/yonder-core/src/schema/config.test.ts
git commit -s -m "feat(schema): an output can be stopped without losing its port, path and secret — R-VID-16"
```

---

### Task 8: Which paths can carry which output

**Files:**
- Create: `packages/yonder-core/src/video/outputs.ts`
- Create: `packages/yonder-core/src/video/outputs.test.ts`

**Interfaces:**
- Produces:

```ts
export type OutputDirection = "outbound" | "listener";
export interface OutputReach {
  readonly direction: OutputDirection;
  /** True when at least one current path can carry it. */
  readonly reachable: boolean;
  /** One sentence for the page. Empty when reachable and unremarkable. */
  readonly note: string;
}
export function outputReach(kind: "rtp" | "rtsp" | "srt", paths: PathKinds): OutputReach;
export interface PathKinds {
  readonly lan: boolean;
  readonly mesh: boolean;
  readonly cellular: boolean;
}
```

**Why:** R-UI-24. `schema/config.ts:278` already records that `rtsp` and `srt`
are listeners on this device; nothing on a page uses it. Behind carrier NAT
nothing can dial in, so the console prints a receive line the operator cannot
use, for a stream nothing can reach, on the link where bytes are scarce.

- [ ] **Step 1: Write the failing test**

```ts
import { outputReach } from "./outputs.js";

const cell = { lan: false, mesh: false, cellular: true };
const cellAndMesh = { lan: false, mesh: true, cellular: true };
const lan = { lan: true, mesh: false, cellular: false };

describe("which paths can carry which output", () => {
  it("the ground station dials out, so cellular carries it", () => {
    const reach = outputReach("rtp", cell);
    expect(reach.direction).toBe("outbound");
    expect(reach.reachable).toBe(true);
  });

  it("nothing can dial in to an RTSP listener over cellular", () => {
    const reach = outputReach("rtsp", cell);
    expect(reach.direction).toBe("listener");
    expect(reach.reachable).toBe(false);
    expect(reach.note).toMatch(/cellular/i);
    expect(reach.note).toMatch(/mesh/i);
  });

  // M2a proved this on hardware: the console was reached over the mesh from a
  // machine sharing no local network with the board.
  it("the mesh gives a listener an address a peer can reach", () => {
    expect(outputReach("rtsp", cellAndMesh).reachable).toBe(true);
  });

  it("a LAN carries a listener too", () => {
    expect(outputReach("srt", lan).reachable).toBe(true);
  });

  // The console states and does not act (R-CMD-04): nothing here returns an
  // instruction, a command, or a reason to stop anything.
  it("returns a sentence and never an action", () => {
    const reach = outputReach("rtsp", cell);
    expect(Object.keys(reach).sort()).toEqual(["direction", "note", "reachable"]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run src/video/outputs.test.ts --root packages/yonder-core
```

Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write it**

```ts
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Whether anything can reach an output, on the paths this device has now
 * (R-UI-24).
 *
 * `schema/config.ts` already records the fact this file acts on: `rtsp` and
 * `srt` are **listeners on this device**, and a listener needs somebody to
 * dial in. Behind carrier NAT nobody can — so a console that prints an RTSP
 * receive line over cellular is offering a stream nothing can connect to,
 * costing uplink on the link where bytes are the scarce thing.
 *
 * Over a mesh the same output works, because the mesh gives the board an
 * address a peer can reach. That was proven on hardware in M2a, from a
 * machine sharing no local network with the board.
 *
 * **This file states and never acts** (R-CMD-04, and rule 4 of this project).
 * It returns a sentence. An operator may have a mesh coming up or be about to
 * land, and a device that stops an output on its own is the aircraft deciding.
 */

export type OutputDirection = "outbound" | "listener";

export interface PathKinds {
  readonly lan: boolean;
  readonly mesh: boolean;
  readonly cellular: boolean;
}

export interface OutputReach {
  readonly direction: OutputDirection;
  readonly reachable: boolean;
  readonly note: string;
}

const DIRECTION: Record<string, OutputDirection> = {
  rtp: "outbound",
  rtsp: "listener",
  srt: "listener",
};

export function outputReach(kind: "rtp" | "rtsp" | "srt", paths: PathKinds): OutputReach {
  const direction = DIRECTION[kind] ?? "listener";
  if (direction === "outbound") {
    return {
      direction,
      reachable: paths.lan || paths.mesh || paths.cellular,
      note: "outbound — the board dials out",
    };
  }
  const reachable = paths.lan || paths.mesh;
  if (reachable) return { direction, reachable, note: "inbound listener" };
  return {
    direction,
    reachable,
    note: paths.cellular
      ? "nothing can reach this over cellular · works on the mesh"
      : "nothing can reach this on the paths this device has",
  };
}
```

- [ ] **Step 4: Run the test — expect PASS**

```bash
npx vitest run src/video/outputs.test.ts --root packages/yonder-core && npm run lint
```

- [ ] **Step 5: Export it for the console**

Add `outputReach` and its types to `console/presentation.ts`'s re-exports, the
same way `capabilityFacts` and `uplinkBudget` are exported, so the Vue
components import one implementation rather than restating the rule.

- [ ] **Step 6: Mutation-check**

Change `const reachable = paths.lan || paths.mesh;` to `= true`. Expected: the
cellular test goes red. Restore.

- [ ] **Step 7: Commit**

```bash
git add packages/yonder-core/src/video/outputs.ts packages/yonder-core/src/video/outputs.test.ts packages/yonder-core/src/console/presentation.ts
git commit -s -m "feat(video): say which paths can carry which output, and act on none of it — R-UI-24"
```

---

**Phase 1 checkpoint.** `npm test && npm run lint` clean. The model knows
everything the device answers, the four states, and which outputs a link can
carry. Nothing is drawn yet.

---

# Phase 2 — the library and the gallery

### Task 9: The gallery, rendering from source in both palettes

**Files:**
- Create: `packages/node-red-dashboard-2-yonder/gallery/index.html`
- Create: `packages/node-red-dashboard-2-yonder/gallery/main.js`
- Create: `packages/node-red-dashboard-2-yonder/gallery/gallery.css`
- Create: `packages/node-red-dashboard-2-yonder/gallery/vite.config.mjs`
- Create: `packages/node-red-dashboard-2-yonder/gallery/specimens.js`
- Modify: `packages/node-red-dashboard-2-yonder/package.json` (a `gallery` script)

**Interfaces:**
- Produces: `npm run gallery -w node-red-dashboard-2-yonder` builds to
  `gallery/dist/`. `specimens.js` exports
  `SPECIMENS: { title: string, note: string, component: Component, props: object, payload: unknown }[]`
  — later tasks append one entry per component and per state.

**Why:** R-UI-25. A library nobody can look at whole is a library whose gaps
stay invisible until a page is built from it. Build the harness before the
components so every component lands on it the day it is written.

The working prototype is in
[`docs/console/design/instrument-library/`](../../console/design/instrument-library/);
its `theme.day.css` / `theme.night.css` were generated with
`themeCss(theme)` from `yonder-core/dist/console/theme.js`.

- [ ] **Step 1: Write the failing test**

Create `packages/node-red-dashboard-2-yonder/gallery/gallery.test.ts`:

```ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SPECIMENS } from "./specimens.js";

const uiDir = join(import.meta.dirname, "../src/ui");

describe("the gallery shows the whole library", () => {
  // The requirement in one assertion: a component that exists and is not on
  // the gallery is a component nobody can see is wrong.
  it("has a specimen for every component in src/ui", () => {
    const components = readdirSync(uiDir)
      .filter((f) => f.endsWith(".vue"))
      .map((f) => f.replace(/\.vue$/, ""));
    const shown = new Set(SPECIMENS.map((s) => s.component.name ?? s.component.__name));
    for (const c of components) expect(shown).toContain(c);
  });

  it("renders from source, never from a built bundle", () => {
    const source = readFileSync(join(import.meta.dirname, "specimens.js"), "utf8");
    expect(source).not.toContain("resources/");
    expect(source).not.toContain("/dist/");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run gallery/gallery.test.ts --root packages/node-red-dashboard-2-yonder
```

- [ ] **Step 3: Build the harness**

Port the prototype from `docs/console/design/instrument-library/`. It must:

- import components from `../src/ui/*.vue`, never from `resources/`;
- provide the Dashboard injections the component tests already stub —
  `provide("$dataTracker", () => {})`, `provide("$socket", { on(){}, off(){}, emit(){} })`,
  and a `$store` of shape `{ state: { data: { messages: { [id]: { payload } } } } }`;
- create its `<link id="theme">` **in JavaScript**, because Vite strips a
  hand-written one from `index.html` at build time;
- write both palettes with `themeCss("day")` and `themeCss("night")` from
  `yonder-core`, at build time, into `gallery/dist/`;
- set `base: "./"` in the Vite config — an absolute path makes the built page
  unopenable outside a server root.

Add to `package.json`:

```json
"gallery": "node gallery/build-themes.mjs && vite build --config gallery/vite.config.mjs"
```

- [ ] **Step 4: Run it and look**

```bash
npm run gallery -w node-red-dashboard-2-yonder
npx serve packages/node-red-dashboard-2-yonder/gallery/dist -l 18930
```

Open it, press both palette keys, confirm every existing component draws.

- [ ] **Step 5: Run the test — expect PASS**

```bash
npx vitest run gallery/gallery.test.ts --root packages/node-red-dashboard-2-yonder
```

- [ ] **Step 6: Commit**

```bash
git add packages/node-red-dashboard-2-yonder/gallery packages/node-red-dashboard-2-yonder/package.json
git commit -s -m "feat(console): render the instrument library whole, from source, in both palettes — R-UI-25"
```

---

### Task 10: Three defects the gallery already found

**Files:**
- Modify: `packages/node-red-dashboard-2-yonder/src/ui/YonderDataBar.vue`
- Modify: `packages/node-red-dashboard-2-yonder/src/ui/YonderSoftKeys.vue`
- Modify: `packages/node-red-dashboard-2-yonder/src/ui/YonderBudget.vue`
- Test: `packages/node-red-dashboard-2-yonder/src/ui/databar.component.test.ts` (**new**)
- Test: `packages/node-red-dashboard-2-yonder/src/ui/softkeys.component.test.ts` (**new**)
- Modify: `packages/node-red-dashboard-2-yonder/src/ui/budget.component.test.ts`

**Why:** all three were found by rendering the library on one screen, with no
page, no Node-RED and no board. `YonderDataBar`'s truncation is the
`1280 × 7…` defect observed on the board, reproduced standing alone.

- [ ] **Step 1: Write the failing tests**

`databar.component.test.ts`:

```ts
import { mount } from "@vue/test-utils";
import YonderDataBar from "./YonderDataBar.vue";

const CELLS = [
  { key: "running", label: "Running" }, { key: "picture", label: "Picture" },
  { key: "rate", label: "Rate" }, { key: "bitrate", label: "Bitrate" },
  { key: "uplink", label: "Uplink" }, { key: "encoder", label: "Encoder" },
];
const PAYLOAD = {
  running: "running", picture: "1280 × 720", rate: "30 fps",
  bitrate: "3000 kb/s", uplink: "5.17 Mb/s at IP", encoder: "v4l2h264enc",
};

function bar () {
  return mount(YonderDataBar, {
    props: { id: "n1", props: { label: "", cells: CELLS } },
    global: {
      provide: { $dataTracker: () => {} },
      mocks: { $store: { state: { data: { messages: { n1: { payload: PAYLOAD } } } } } },
    },
  });
}

describe("a data bar that will not fit", () => {
  // The defect seen on the board: `1280 × 7…`. A reading the operator cannot
  // read is worse than no reading, because it looks like a reading.
  it("draws every cell it was given", () => {
    expect(bar().findAll(".y-bar__cell")).toHaveLength(6);
  });

  it("shows each value in full rather than clipping it", () => {
    const values = bar().findAll(".y-bar__v").map((v) => v.text());
    expect(values).toContain("1280 × 720");
    expect(values).toContain("5.17 Mb/s at IP");
  });

  it("wraps to a second row rather than running past its own edge", () => {
    expect(bar().find(".y-bar").classes()).toContain("y-bar--wrap");
  });
});
```

`softkeys.component.test.ts` — the same shape, asserting that six keys all
render (`findAll(".y-keys__key")` has length 6) and that the rail carries the
wrapping class.

In `budget.component.test.ts`, add:

```ts
  it("separates the label from the value", () => {
    expect(wrapper.find(".y-budget__top").text()).toContain("In use 0.0 of 3.2");
  });
```

- [ ] **Step 2: Run them and watch them fail**

```bash
npm test -w node-red-dashboard-2-yonder
```

- [ ] **Step 3: Fix all three**

`YonderDataBar.vue` — allow the row to wrap and stop cells from being crushed:

```css
.y-bar { display: flex; flex-wrap: wrap; row-gap: 8px; }
.y-bar__cell { flex: 0 1 auto; min-width: max-content; }
.y-bar__v { white-space: nowrap; }
```

and add `y-bar--wrap` to the root's class list.

`YonderSoftKeys.vue` — the rail wraps rather than overflowing. It must never
scroll horizontally: a key an operator cannot see is a key that does not
exist, which is how every key shipped dead once already.

```css
.y-keys { display: flex; flex-wrap: wrap; gap: 1px; }
```

`YonderBudget.vue` — put a real gap between label and value in `.y-budget__top`
(`display: flex; gap: 8px; justify-content: space-between`), not a text node.

- [ ] **Step 4: Run the tests — expect PASS**

```bash
npm test -w node-red-dashboard-2-yonder
```

- [ ] **Step 5: Look at it**

```bash
npm run gallery -w node-red-dashboard-2-yonder
```

Confirm in both palettes: six data-bar cells legible, six soft keys present,
`In use 0.0 of 3.2 Mb/s` spaced.

- [ ] **Step 6: Commit**

```bash
git add packages/node-red-dashboard-2-yonder/src/ui
git commit -s -m "fix(console): three instruments that ran past their own edges — R-UI-25 found all three"
```

---

### Task 11: The readout row

**Files:**
- Create: `packages/node-red-dashboard-2-yonder/src/ui/YonderReadout.vue`
- Create: `packages/node-red-dashboard-2-yonder/src/ui/readout.component.test.ts`
- Modify: `packages/node-red-dashboard-2-yonder/gallery/specimens.js`

**Interfaces:**
- Produces: props `rows: { label: string; value: string; unit?: string; absent?: boolean }[]`.
  Blueprint: `docs/console/design/instrument-library/DraftReadout.vue`.

- [ ] **Step 1: Write the failing test**

```ts
import { mount } from "@vue/test-utils";
import YonderReadout from "./YonderReadout.vue";

const rows = (rows) => mount(YonderReadout, { props: { rows } });

describe("the readout row", () => {
  it("draws a label, a value and its unit", () => {
    const w = rows([{ label: "Bitrate", value: "3.0", unit: "Mb/s" }]);
    expect(w.find(".y-ro__l").text()).toBe("Bitrate");
    expect(w.find(".y-ro__v").text()).toContain("3.0");
    expect(w.find(".y-ro__u").text()).toBe("Mb/s");
  });

  // A token carrying a unit is never uppercased: MB/S says megabytes, which
  // is eight times the number on the page.
  it("never uppercases a unit", () => {
    const w = rows([{ label: "Bitrate", value: "3.0", unit: "Mb/s" }]);
    expect(getComputedStyle(w.find(".y-ro__u").element).textTransform).toBe("none");
  });

  it("puts a space between the value and its unit", () => {
    const w = rows([{ label: "Bitrate", value: "3.0", unit: "Mb/s" }]);
    expect(w.find(".y-ro__v").text()).toMatch(/3\.0\s+Mb\/s/);
  });

  it("omits the unit slot when there is no unit", () => {
    expect(rows([{ label: "Codec", value: "H.264" }]).find(".y-ro__u").exists()).toBe(false);
  });

  // Not known and nothing are different answers, and only one is honest.
  it("draws an absent value in the neutral tone", () => {
    const w = rows([{ label: "HDR", value: "not on this camera", absent: true }]);
    expect(w.find(".y-ro").classes()).toContain("absent");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run src/ui/readout.component.test.ts --root packages/node-red-dashboard-2-yonder
```

- [ ] **Step 3: Write the component**

Port `DraftReadout.vue` from the blueprint, renaming classes to `y-ro__*`.
Every colour reads `var(--yonder-*, <night fallback from tokens.css>)`. The
unit slot carries `text-transform: none` and `margin-left: 4px` — a leading
space inside the tag is collapsed by HTML, which is how `3Mb/s` happened in the
prototype.

- [ ] **Step 4: Run the test — expect PASS, then add it to the gallery**

```bash
npx vitest run src/ui/readout.component.test.ts --root packages/node-red-dashboard-2-yonder
```

Append a specimen with a unit, one without, and one absent.

- [ ] **Step 5: Commit**

```bash
git add packages/node-red-dashboard-2-yonder/src/ui/YonderReadout.vue packages/node-red-dashboard-2-yonder/src/ui/readout.component.test.ts packages/node-red-dashboard-2-yonder/gallery/specimens.js
git commit -s -m "feat(console): the readout row — label, value, unit, stacked — R-UI-08"
```

---

### Task 12: The picker, in all four states

**Files:**
- Create: `packages/node-red-dashboard-2-yonder/src/ui/YonderPicker.vue`
- Create: `packages/node-red-dashboard-2-yonder/src/ui/picker.component.test.ts`
- Modify: `packages/node-red-dashboard-2-yonder/gallery/specimens.js`

**Interfaces:**
- Produces: props
  `{ label: string; value: string; options: { value: string; label: string }[]; state: "present" | "not-offered" | "advertised" | "gated"; reason: string }`.
  Emits `change` with the chosen `value`. Blueprint: `DraftPicker.vue`.

- [ ] **Step 1: Write the failing test**

```ts
describe("the picker", () => {
  it("offers what the device answered, and nothing else", () => {
    const w = picker({ options: [
      { value: "1920x1080", label: "1920×1080 · 30 fps" },
      { value: "1280x720", label: "1280×720 · 30 fps" },
    ], value: "1280x720" });
    expect(w.findAll("option")).toHaveLength(2);
  });

  it("emits the chosen value", async () => {
    const w = picker({ options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], value: "a" });
    await w.find("select").setValue("b");
    expect(w.emitted("change")?.[0]).toEqual(["b"]);
  });

  // The state whose whole job is to be noticed, in the caution tone.
  it("draws advertised inoperative, carrying its reason", () => {
    const w = picker({ state: "advertised", reason: "Fifteen values sent; the frame stayed 720p." });
    expect(w.find("select").attributes("disabled")).toBeDefined();
    expect(w.find(".y-pick__why").classes()).toContain("why-advertised");
    expect(w.text()).toContain("the frame stayed 720p");
  });

  // Not a fault, and it must not look like one — or the caution tone stops
  // meaning anything (R-UI-21).
  it("draws gated in the neutral tone, naming the way back", () => {
    const w = picker({ state: "gated", reason: "while auto exposure is on" });
    expect(w.find("select").attributes("disabled")).toBeDefined();
    expect(w.find(".y-pick__why").classes()).toContain("why-gated");
    expect(w.find(".y-pick__why").classes()).not.toContain("why-advertised");
  });

  it("draws nothing at all when the device does not offer it", () => {
    expect(picker({ state: "not-offered" }).find("select").exists()).toBe(false);
  });

  // The rule ADR-0009 gives the engine bar's track, applied here.
  it("never stretches to its container", () => {
    expect(getComputedStyle(picker({}).find(".y-pick").element).maxWidth).not.toBe("none");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run src/ui/picker.component.test.ts --root packages/node-red-dashboard-2-yonder
```

- [ ] **Step 3: Write the component**

Port `DraftPicker.vue`, with a real `<select>` beneath the drawn control — a
custom listbox would have to reimplement keyboard handling, and a native select
is what a tablet gives an operator a usable wheel for. `not-offered` renders
nothing: the deck draws the fact row instead (Task 17).

- [ ] **Step 4: Run the test — expect PASS, add all four states to the gallery**

- [ ] **Step 5: Mutation-check**

Change `why-gated` to `why-advertised` in the template. Expected: the gated
test goes red. Restore.

- [ ] **Step 6: Commit**

```bash
git add packages/node-red-dashboard-2-yonder/src/ui/YonderPicker.vue packages/node-red-dashboard-2-yonder/src/ui/picker.component.test.ts packages/node-red-dashboard-2-yonder/gallery/specimens.js
git commit -s -m "feat(console): the picker, in all four capability states — R-CAM-14, R-UI-20, R-UI-21"
```

---

### Task 13: The segmented control

**Files:**
- Create: `packages/node-red-dashboard-2-yonder/src/ui/YonderSegmented.vue`
- Create: `packages/node-red-dashboard-2-yonder/src/ui/segmented.component.test.ts`
- Modify: `packages/node-red-dashboard-2-yonder/gallery/specimens.js`

**Interfaces:**
- Produces: props `{ label, options: string[], value: string, state, reason }`,
  emits `change` with the chosen option. Blueprint: `DraftSegmented.vue`.

- [ ] **Step 1: Write the failing test**

```ts
describe("the segmented control", () => {
  it("marks the chosen option and no other", () => {
    const w = seg({ options: ["Normal", "Mono", "Sat"], value: "Mono" });
    const on = w.findAll(".y-seg__b").filter((b) => b.classes().includes("on"));
    expect(on).toHaveLength(1);
    expect(on[0].text()).toBe("Mono");
  });

  it("emits the option that was pressed", async () => {
    const w = seg({ options: ["Fixed", "Adaptive"], value: "Fixed" });
    await w.findAll(".y-seg__b")[1].trigger("click");
    expect(w.emitted("change")?.[0]).toEqual(["Adaptive"]);
  });

  // The rule this object exists to keep. A control that fills its column is
  // the slab this design language replaced, wearing a different name.
  it("has a maximum width and never stretches to its container", () => {
    const style = getComputedStyle(seg({ options: ["On", "Off"], value: "On" }).find(".y-seg").element);
    expect(style.maxWidth).not.toBe("none");
    expect(style.width).not.toBe("100%");
  });

  it("draws gated inert, in the neutral tone, naming the way back", () => {
    const w = seg({ options: ["On", "Off"], value: "On", state: "gated", reason: "while auto focus is on" });
    expect(w.findAll(".y-seg__b")[0].attributes("disabled")).toBeDefined();
    expect(w.text()).toContain("while auto focus is on");
  });

  it("emits nothing when it is not present", async () => {
    const w = seg({ options: ["On", "Off"], value: "On", state: "advertised", reason: "x" });
    await w.findAll(".y-seg__b")[1].trigger("click");
    expect(w.emitted("change")).toBeUndefined();
  });
});
```

- [ ] **Step 2–4: Run, watch it fail, port `DraftSegmented.vue`, run to PASS, add every state to the gallery**

- [ ] **Step 5: Mutation-check**

Remove `max-width` from `.y-seg`. Expected: the width test goes red. Restore.

- [ ] **Step 6: Commit**

```bash
git add packages/node-red-dashboard-2-yonder/src/ui/YonderSegmented.vue packages/node-red-dashboard-2-yonder/src/ui/segmented.component.test.ts packages/node-red-dashboard-2-yonder/gallery/specimens.js
git commit -s -m "feat(console): the segmented control, capped and never stretching — R-UI-08, R-UI-10"
```

---

### Task 14: The set bar — where it is, and what was asked for

**Files:**
- Create: `packages/node-red-dashboard-2-yonder/src/ui/YonderSetBar.vue`
- Create: `packages/node-red-dashboard-2-yonder/src/ui/setbar.component.test.ts`
- Modify: `packages/node-red-dashboard-2-yonder/gallery/specimens.js`

**Interfaces:**
- Produces: props
  `{ label, unit, min, max, step, precision, actual: number, commanded: number | null, state, reason, fine }`.
  Emits `set` with a number snapped to `step` and clamped to `[min, max]`.
  Blueprint: `DraftSetBar.vue`.

**Why:** the design has no control for a bounded continuous value, and the
device reports ten of them. One track with two marks makes *commanded versus
actual* the same shape everywhere, which is what a slow link needs.

- [ ] **Step 1: Write the failing test**

```ts
describe("the set bar", () => {
  it("draws the device's own value, formatted to its precision", () => {
    expect(bar({ actual: 3.04, precision: 1, unit: "Mb/s" }).find(".y-sb__v").text()).toContain("3.0");
  });

  // The whole reason this is one object and not two: on a slow link the gap
  // between the two marks is the operator's entire picture of what is
  // happening (R-UI-05).
  it("draws a second mark where the commanded value is", () => {
    expect(bar({ min: 0, max: 8, actual: 3.0, commanded: 3.4 }).find(".y-sb__cmd").exists()).toBe(true);
  });

  it("draws no commanded mark when the device has caught up", () => {
    expect(bar({ min: 0, max: 8, actual: 3.4, commanded: 3.4 }).find(".y-sb__cmd").exists()).toBe(false);
  });

  it("snaps what it emits to the device's own step", async () => {
    const w = bar({ min: -648000, max: 648000, step: 3600, actual: 0 });
    await w.find(".y-sb__trk").trigger("click", { offsetX: 91, target: { clientWidth: 180 } });
    const [emitted] = w.emitted("set")![0] as [number];
    expect(emitted % 3600).toBe(0);
  });

  it("clamps to the device's own bounds", async () => {
    const w = bar({ min: 0, max: 95, step: 1, actual: 40 });
    await w.find(".y-sb__trk").trigger("click", { offsetX: 9999, target: { clientWidth: 180 } });
    expect((w.emitted("set")![0] as [number])[0]).toBeLessThanOrEqual(95);
  });

  it("never uppercases its unit", () => {
    const w = bar({ actual: 3, unit: "Mb/s" });
    expect(getComputedStyle(w.find(".y-sb__u").element).textTransform).toBe("none");
  });

  it("has a fixed track width and never stretches", () => {
    expect(getComputedStyle(bar({ actual: 1 }).find(".y-sb__trk").element).width).not.toBe("100%");
  });

  // R-UI-21, and the reason the value is an em dash rather than the last one
  // read: a number nobody can change reads as a number somebody set.
  it("draws gated with no marks, an em dash, and the way back", () => {
    const w = bar({ actual: 156, state: "gated", reason: "while auto exposure is on" });
    expect(w.find(".y-sb__v").text()).toContain("——");
    expect(w.find(".y-sb__ptr").exists()).toBe(false);
    expect(w.text()).toContain("while auto exposure is on");
  });

  it("emits nothing when it is gated", async () => {
    const w = bar({ actual: 156, state: "gated", reason: "x" });
    await w.find(".y-sb__trk").trigger("click", { offsetX: 40, target: { clientWidth: 180 } });
    expect(w.emitted("set")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run src/ui/setbar.component.test.ts --root packages/node-red-dashboard-2-yonder
```

- [ ] **Step 3: Write the component**

Port `DraftSetBar.vue` and add what the draft lacks: `step` snapping, clamping,
and the `set` emission. Snap with
`Math.round((raw - min) / step) * step + min`, then clamp. The track shares its
geometry with `YonderGauge` — the same fixed width and the same fill — so the
two read as one family.

- [ ] **Step 4: Run the test — expect PASS, add every state to the gallery**

- [ ] **Step 5: Mutation-check three guards**

Remove the snap (emit `raw`): the step test goes red. Remove the clamp: the
bounds test goes red. Remove the `state === 'present'` check before emitting:
the gated-emits-nothing test goes red. Restore each.

- [ ] **Step 6: Commit**

```bash
git add packages/node-red-dashboard-2-yonder/src/ui/YonderSetBar.vue packages/node-red-dashboard-2-yonder/src/ui/setbar.component.test.ts packages/node-red-dashboard-2-yonder/gallery/specimens.js
git commit -s -m "feat(console): the set bar — one track, two marks, the device's own step — R-CTL-11 … R-CTL-14"
```

---

### Task 15: The column and the placard

**Files:**
- Create: `packages/node-red-dashboard-2-yonder/src/ui/YonderColumn.vue`
- Create: `packages/node-red-dashboard-2-yonder/src/ui/YonderPlacard.vue`
- Create: `packages/node-red-dashboard-2-yonder/src/ui/column.component.test.ts`
- Modify: `packages/node-red-dashboard-2-yonder/gallery/specimens.js`

**Interfaces:**
- Produces: `YonderColumn` — props `{ title, note, noteTone: "label" | "select" | "waiting" }`,
  default slot. `YonderPlacard` — props `{ left, right }`, rendering
  `CAMERA · NOSE` and `USB · H.264 · 1280×720P30`.

- [ ] **Step 1: Write the failing test**

```ts
describe("the column", () => {
  it("draws its legend and its right-hand qualifier", () => {
    const w = mount(YonderColumn, { props: { title: "Aim", note: "rate", noteTone: "select" } });
    expect(w.find(".y-col__h span").text()).toBe("Aim");
    expect(w.find(".y-col__note").classes()).toContain("q-select");
  });

  it("omits the qualifier when there is none", () => {
    expect(mount(YonderColumn, { props: { title: "Stream" } }).find(".y-col__note").exists()).toBe(false);
  });
});

describe("the placard", () => {
  it("draws the camera and what it is", () => {
    const w = mount(YonderPlacard, { props: { left: "Camera · Nose", right: "USB · H.264 · 1280×720p30" } });
    expect(w.text()).toContain("Nose");
    expect(w.text()).toContain("H.264");
  });

  // A resolution is not a unit and letterspaced caps are the placard's voice,
  // but `Mb/s` must never pass through it.
  it("never uppercases a unit in its right-hand text", () => {
    const w = mount(YonderPlacard, { props: { left: "Camera · Nose", right: "3.0 Mb/s" } });
    expect(w.find(".y-plac__r").text()).toContain("Mb/s");
  });
});
```

- [ ] **Step 2–4: Run, fail, port `DraftColumn.vue`, write the placard, run to PASS, add to the gallery**

The placard uppercases with `text-transform` on the element and keeps a
`.y-plac__unit` span at `text-transform: none` for any unit inside it.

- [ ] **Step 5: Commit**

```bash
git add packages/node-red-dashboard-2-yonder/src/ui/YonderColumn.vue packages/node-red-dashboard-2-yonder/src/ui/YonderPlacard.vue packages/node-red-dashboard-2-yonder/src/ui/column.component.test.ts packages/node-red-dashboard-2-yonder/gallery/specimens.js
git commit -s -m "feat(console): the deck column and the panel placard — R-UI-08"
```

---

### Task 16: The aim dial

**Files:**
- Create: `packages/node-red-dashboard-2-yonder/src/ui/YonderAimDial.vue`
- Create: `packages/node-red-dashboard-2-yonder/src/ui/aimdial.component.test.ts`
- Modify: `packages/node-red-dashboard-2-yonder/gallery/specimens.js`

**Interfaces:**
- Produces: props
  `{ pan: number; tilt: number; commandedPan: number | null; commandedTilt: number | null; rate: number | null; axes: { pan: State; tilt: State; roll: State }; atLimit: boolean }`
  where `State` is the four-state union. Emits `slew` with `{ pan: number; tilt: number }` in degrees per second, and `stop`.

**Why:** `aim-and-bitrate.html` option A. Drag sets a *rate*; release stops.
Absolute pointing was rejected there and the reason is 300 ms of lag: you aim
at a picture that is already stale, overshoot, and correct against a picture
that is stale again.

- [ ] **Step 1: Write the failing test**

```ts
describe("the aim dial", () => {
  it("marks where the gimbal is in white and where it is pushed in cyan", () => {
    const w = dial({ pan: 4.5, tilt: -18, commandedPan: 14, commandedTilt: -12 });
    expect(w.find(".y-dial__is").exists()).toBe(true);
    expect(w.find(".y-dial__push").exists()).toBe(true);
  });

  it("draws no push mark when nothing is being commanded", () => {
    expect(dial({ pan: 4.5, tilt: -18 }).find(".y-dial__push").exists()).toBe(false);
  });

  // A gimbal that half works must not read as one that does.
  it("keeps an axis that will not answer on the dial, struck and labelled", () => {
    const w = dial({ axes: { pan: "present", tilt: "present", roll: "advertised" } });
    expect(w.find(".y-dial__dead").exists()).toBe(true);
    expect(w.text()).toContain("ROLL");
  });

  it("emits a rate while dragging, not a position", async () => {
    const w = dial({ pan: 0, tilt: 0 });
    await w.find(".y-dial").trigger("pointerdown", { clientX: 59, clientY: 59 });
    await w.find(".y-dial").trigger("pointermove", { clientX: 92, clientY: 41 });
    const [payload] = w.emitted("slew")!.at(-1) as [{ pan: number; tilt: number }];
    expect(payload.pan).toBeGreaterThan(0);
    expect(payload.tilt).toBeGreaterThan(0);
  });

  // The property the whole choice rests on: let go and it stops. A dial that
  // kept slewing after release is a runaway gimbal on a laggy link.
  it("emits stop on release", async () => {
    const w = dial({ pan: 0, tilt: 0 });
    await w.find(".y-dial").trigger("pointerdown", { clientX: 59, clientY: 59 });
    await w.find(".y-dial").trigger("pointermove", { clientX: 92, clientY: 41 });
    await w.find(".y-dial").trigger("pointerup");
    expect(w.emitted("stop")).toHaveLength(1);
  });

  // A pointer that leaves the element never fires pointerup on it. Without
  // this the gimbal slews until something else stops it.
  it("emits stop when the pointer is cancelled or leaves", async () => {
    const w = dial({ pan: 0, tilt: 0 });
    await w.find(".y-dial").trigger("pointerdown", { clientX: 59, clientY: 59 });
    await w.find(".y-dial").trigger("pointercancel");
    expect(w.emitted("stop")).toHaveLength(1);
  });

  it("shows the limit as an annunciator when the gimbal reports one", () => {
    expect(dial({ atLimit: true }).find(".y-dial__limit").exists()).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run src/ui/aimdial.component.test.ts --root packages/node-red-dashboard-2-yonder
```

- [ ] **Step 3: Write the component**

An SVG dial, 118×118, generated from vector rules (R-UI-13, never a raster).
Geometry from `capability-states.html`'s dial and `aim-and-bitrate.html`
option A. Rate is proportional to distance from centre, clamped at the rim.
Use pointer capture, and bind `stop` to `pointerup`, `pointercancel` **and**
`pointerleave`.

- [ ] **Step 4: Run the test — expect PASS, add three states to the gallery**

Present, an axis advertised, and at limit.

- [ ] **Step 5: Mutation-check**

Remove the `pointercancel` handler. Expected: the cancel test goes red.
Restore. Remove the rim clamp. Expected: add an assertion that a drag far
outside the dial emits no more than the maximum rate, and confirm it goes red.

- [ ] **Step 6: Commit**

```bash
git add packages/node-red-dashboard-2-yonder/src/ui/YonderAimDial.vue packages/node-red-dashboard-2-yonder/src/ui/aimdial.component.test.ts packages/node-red-dashboard-2-yonder/gallery/specimens.js
git commit -s -m "feat(console): the aim dial — rate, not position, and it stops when you let go — R-TEL-15"
```

---

### Task 17: The deck, composing itself from the capability report

**Files:**
- Create: `packages/node-red-dashboard-2-yonder/src/ui/YonderDeck.vue`
- Create: `packages/node-red-dashboard-2-yonder/src/deck.ts`
- Create: `packages/node-red-dashboard-2-yonder/src/deck.html`
- Create: `packages/node-red-dashboard-2-yonder/src/ui/deck.component.test.ts`
- Modify: `packages/node-red-dashboard-2-yonder/package.json` (the `node-red-dashboard-2` manifest and the `node-red` node list)
- Modify: `packages/node-red-dashboard-2-yonder/gallery/specimens.js`

**Interfaces:**
- Consumes: every component from Tasks 11–16; `Capability`, `ControlRange`,
  `outputReach` from `yonder-core/presentation`.
- Produces: node type `ui-yonder-deck`, **`emitsActions: true`**. Editor props
  `{ mode: "live" | "setup" }`. Payload:

```ts
{
  placard: { left: string; right: string };
  capabilities: CameraCapabilities;
  values: Record<string, number | boolean | null>;
  commanded: Record<string, number | null>;
  outputs: { kind: "rtp" | "rtsp" | "srt"; label: string; enabled: boolean;
             costKbps: number | null; reach: OutputReach }[];
}
```

Emits `{ control: string, value: number | boolean }` or
`{ output: string, enabled: boolean }` on `msg.payload`.

**Why:** the structural fix. Dashboard's grid makes every widget occupy whole
rows, so twelve controls wired as twelve widgets can never be a three-column
deck. One widget draws its own columns, decides what exists from the report,
and leaves no group for a stock widget to be dropped into.

- [ ] **Step 1: Write the failing test**

```ts
describe("the deck draws what the camera answers", () => {
  it("draws a control for a present capability", () => {
    const w = deck({ capabilities: { ...noCapabilities(), gain: present(range(0, 1023)) } });
    expect(w.findAllComponents(YonderSetBar).some((b) => b.props("label") === "Gain")).toBe(true);
  });

  // R-UI-20. A dead control takes a control's room and carries a label's
  // information, and it teaches an operator to stop reading muted styling.
  it("states a not-offered capability as a fact, never as a dead control", () => {
    const w = deck({ capabilities: { ...noCapabilities(), gain: notOffered() } });
    expect(w.findAllComponents(YonderSetBar).some((b) => b.props("label") === "Gain")).toBe(false);
    expect(w.find(".y-deck__facts").text()).toContain("Gain");
  });

  it("keeps an advertised capability as a control, marked, with its reason", () => {
    const w = deck({ capabilities: { ...noCapabilities(), zoom: advertised("the frame never moved") } });
    const zoom = w.findAllComponents(YonderSetBar).find((b) => b.props("label") === "Zoom")!;
    expect(zoom.props("state")).toBe("advertised");
    expect(zoom.props("reason")).toContain("never moved");
  });

  it("keeps a gated capability as a control, inert, naming its gate", () => {
    const w = deck({ capabilities: { ...noCapabilities(), exposure: gated(range(1, 10000), "auto exposure") } });
    const shutter = w.findAllComponents(YonderSetBar).find((b) => b.props("label") === "Shutter")!;
    expect(shutter.props("state")).toBe("gated");
    expect(shutter.props("reason")).toContain("auto exposure");
  });

  // A camera with no gimbal has no Aim column, with nobody having wired that.
  it("omits a whole column when the camera has none of it", () => {
    const w = deck({ capabilities: noCapabilities() });
    expect(w.findAllComponents(YonderAimDial)).toHaveLength(0);
  });

  it("draws the flying set on live and every control on setup", () => {
    const caps = allPresent();
    expect(deck({ mode: "live", capabilities: caps }).text()).not.toContain("Hue");
    expect(deck({ mode: "setup", capabilities: caps }).text()).toContain("Hue");
  });

  it("shows each output's cost and whether anything can reach it", () => {
    const w = deck({ outputs: [{
      kind: "rtsp", label: "RTSP", enabled: true, costKbps: 0,
      reach: { direction: "listener", reachable: false, note: "nothing can reach this over cellular · works on the mesh" },
    }] });
    expect(w.find(".y-deck__out").text()).toContain("works on the mesh");
  });

  // Dashboard drops a widget-action from a widget that did not register
  // onAction, with no error anywhere. Every soft key shipped dead this way.
  it("emits a control change through the socket", async () => {
    const { wrapper, emitted } = deckWithSocket({
      capabilities: { ...noCapabilities(), gain: present(range(0, 1023)) },
    });
    await wrapper.findComponent(YonderSetBar).vm.$emit("set", 200);
    expect(emitted[0].payload).toEqual({ control: "gain", value: 200 });
  });

  it("emits an output being turned off", async () => {
    const { wrapper, emitted } = deckWithSocket({ outputs: [rtspOn] });
    await wrapper.findComponent(YonderSegmented).vm.$emit("change", "Off");
    expect(emitted[0].payload).toEqual({ output: "rtsp", enabled: false });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run src/ui/deck.component.test.ts --root packages/node-red-dashboard-2-yonder
```

- [ ] **Step 3: Write the component and the node**

`YonderDeck.vue` walks a static table mapping each capability key to its
column, its control kind, its operator-facing label and its unit — written
down, not derived, for the reason `CAPABILITY_KEYS` is: a capability added and
forgotten here is a control that silently never reaches a page. Live and Setup
differ only by which columns that table is filtered to.

`deck.ts` registers with **`emitsActions: true`** and `passthru: false` — the
deck is fed by the node that reads the camera's state, and forwarding its own
input would be a loop at socket speed.

Add the widget to the `node-red-dashboard-2` manifest and the `node-red.nodes`
list in `package.json`, so `scripts/build-widgets.mjs` builds it and Node-RED
loads it.

- [ ] **Step 4: Run the tests — expect PASS**

```bash
npm test -w node-red-dashboard-2-yonder && npm run lint
```

- [ ] **Step 5: Add a full deck to the gallery**

Reproduce `docs/console/design/instrument-library/deck.night.png` — the bench
camera's real values, shutter and temperature gated, aim advertised. Build and
look in both palettes.

- [ ] **Step 6: Mutation-check**

Set `emitsActions: false` in `deck.ts`. Expected: both emission tests go red.
Restore. Delete the `not-offered` branch so it draws a control. Expected: the
fact test goes red. Restore.

- [ ] **Step 7: Commit**

```bash
git add packages/node-red-dashboard-2-yonder/src packages/node-red-dashboard-2-yonder/package.json packages/node-red-dashboard-2-yonder/gallery
git commit -s -m "feat(console): the deck composes itself from what the camera answers — R-UI-08, R-UI-20, R-UI-21"
```

---

### Task 18: The cameras index

**Files:**
- Create: `packages/node-red-dashboard-2-yonder/src/ui/YonderIndex.vue`
- Create: `packages/node-red-dashboard-2-yonder/src/index-widget.ts`
- Create: `packages/node-red-dashboard-2-yonder/src/index-widget.html`
- Create: `packages/node-red-dashboard-2-yonder/src/ui/index.component.test.ts`
- Modify: `packages/node-red-dashboard-2-yonder/package.json`, `gallery/specimens.js`

**Interfaces:**
- Produces: node type `ui-yonder-index`, `emitsActions: true`. Payload
  `{ cameras: CameraRow[]; rejected: RejectionRow[] }` where
  `CameraRow = { id, name, bus, spec, summary, state: CommandState, rateMbps, href }`
  and `RejectionRow = { device, card, why }`. Emits `{ camera: id }` on a row press.

**Why:** two `ui-table`s today. A table gives every column equal weight, and on
this page one column is a camera and one is the reason a device was refused.
Target: `cameras-index-day-v2.html`.

- [ ] **Step 1: Write the failing test**

```ts
describe("the cameras index", () => {
  it("draws one row per attached camera, with what the probe got back", () => {
    const w = index({ cameras: [{
      id: "cam0", name: "Nose", bus: "USB · UVC", spec: "1280×720 · 30 fps · H.264",
      summary: "usb-1.2 · ELP · aim: unanswered · zoom: present",
      state: "confirmed", rateMbps: 3.0, href: "/dashboard/camera",
    }] });
    expect(w.findAll(".y-idx__cam")).toHaveLength(1);
    expect(w.text()).toContain("aim: unanswered");
  });

  // A rejection has nowhere to live on a page belonging to a camera that
  // exists (R-CAM-12).
  it("draws a rejected device with the reason it was refused", () => {
    const w = index({ rejected: [{
      device: "/dev/video10", card: "bcm2835-codec-decode",
      why: "a hardware codec on this board, not a camera (K-40)",
    }] });
    expect(w.find(".y-idx__rej").text()).toContain("K-40");
  });

  it("emits the camera whose row was pressed", async () => {
    const { wrapper, emitted } = indexWithSocket({ cameras: [row("cam0"), row("cam1")] });
    await wrapper.findAll(".y-idx__cam")[1].trigger("click");
    expect(emitted[0].payload).toEqual({ camera: "cam1" });
  });

  it("never uppercases a rate's unit", () => {
    const w = index({ cameras: [{ ...row("cam0"), rateMbps: 3.0 }] });
    expect(w.find(".y-idx__rate").text()).toContain("Mb/s");
  });

  it("says so plainly when nothing was found", () => {
    expect(index({ cameras: [], rejected: [] }).text()).toContain("No camera");
  });
});
```

- [ ] **Step 2–4: Run, fail, write it from `cameras-index-day-v2.html`, run to PASS**

Camera row: thumbnail slot, name and bus, the spec line, the probe summary in
the mono face, a `YonderAnnunciator` with the rate, a chevron. Rejection row:
device path in mono, card, the reason as a sentence.

- [ ] **Step 5: Add both to the gallery, and mutation-check**

Set `emitsActions: false`. Expected: the press test goes red. Restore.

- [ ] **Step 6: Commit**

```bash
git add packages/node-red-dashboard-2-yonder/src packages/node-red-dashboard-2-yonder/package.json packages/node-red-dashboard-2-yonder/gallery
git commit -s -m "feat(console): the cameras index, as rows rather than two tables — R-CAM-12, R-UI-08"
```

---

**Phase 2 checkpoint.** `npm test && npm run lint` clean, and
`npm run gallery -w node-red-dashboard-2-yonder` renders every component in
every state in both palettes. **Show the operator the gallery before starting
Phase 3.** He judges from pixels, and this is the last point at which layout is
cheap to change.

---

# Phase 3 — the pages, the defects, the camera

### Task 19: The theme is in the document before anything runs

**Files:**
- Modify: `packages/yonder-core/src/console/settings.ts`
- Modify: `flows/flows.json` (remove the `style-link` `ui-template`)
- Modify: `packages/yonder-core/src/console/renderer.test.ts`
- Modify: `packages/yonder-core/src/flows.test.ts`

**Why:** R-UI-22. The theme is an `@import` inside a Dashboard `site:style`
template (`flows/flows.json:320`), so the browser must boot Dashboard's
JavaScript before the style exists at all, then fetch the stylesheet as a
second request. Caught on the board: the first frame after a reload is a white
admin panel.

- [ ] **Step 1: Write the failing test**

```ts
describe("the first paint carries the theme", () => {
  it("puts the generated stylesheet in the served document", () => {
    const settings = renderSettings(config);
    expect(settings).toMatch(/<link[^>]+rel="stylesheet"[^>]+\/yonder\/theme\.css/);
  });

  // Two delays in series: the browser must run Dashboard's JS before the
  // style exists, then fetch it. Stock white Vuetify paints in the gap.
  it("does not load the theme with an @import from a template", () => {
    expect(renderSettings(config)).not.toContain("@import");
  });

  it("has no ui-template but the one the flows test permits", () => {
    const templates = flows.filter((n) => n.type === "ui-template");
    expect(templates).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
npm test -w yonder-core
```

- [ ] **Step 3: Move the stylesheet into the head**

Node-RED Dashboard 2 exposes the served document's head through
`ui.headContent` in `settings.js` — use it to emit
`<link rel="stylesheet" href="/yonder/theme.css">`. Delete the `style-link`
node from `flows/flows.json`.

Confirm which key this Dashboard version reads before writing the fix:

```bash
grep -rn "headContent\|head:" vendor/console/node_modules/@flowfuse/node-red-dashboard/nodes/ | head
```

- [ ] **Step 4: Run the tests and prove it on a real browser**

```bash
npm test -w yonder-core && ./scripts/verify-pages.sh
```

Then reload with a throttled network and confirm no white frame:

```bash
HOLD=1 PORT=18900 ./scripts/verify-pages.sh
```

- [ ] **Step 5: Tighten the presentation half of CLAUDE.md rule 2**

Review finding S11: a `ui-template` carrying markup passes 80 of 80 tests
today. Now that there are none, add to `flows.test.ts`:

```ts
it("has no ui-template at all, so markup cannot be pasted into one", () => {
  expect(flows.filter((n) => n.type === "ui-template")).toHaveLength(0);
});

it("has no ui-markdown outside the Diagnostics page", () => {
  const md = flows.filter((n) => n.type === "ui-markdown");
  for (const n of md) expect(pageOf(n)).toBe("Diagnostics");
});
```

- [ ] **Step 6: Mutation-check**

Add a `ui-template` node to `flows.json`. Expected: red. Remove it.

- [ ] **Step 7: Commit**

```bash
git add packages/yonder-core/src/console flows/flows.json
git commit -s -m "fix(console): the first paint carries its own theme, and no ui-template survives — R-UI-22"
```

---

### Task 20: The picture is the shape of the picture

**Files:**
- Modify: `packages/node-red-dashboard-2-yonder/src/ui/YonderPicture.vue`
- Modify: `packages/node-red-dashboard-2-yonder/src/ui/picture.component.test.ts`

**Why:** 726 px of video inside a 1230 px pane on the board, and the overlay is
drawn *behind* the video — the cost line is legible over the black margin and
disappears where the video begins.

- [ ] **Step 1: Write the failing test**

```ts
describe("the pane and the picture", () => {
  it("takes the video's aspect ratio once it knows it", async () => {
    const { wrapper, video } = await live();
    Object.defineProperty(video, "videoWidth", { value: 1280, configurable: true });
    Object.defineProperty(video, "videoHeight", { value: 720, configurable: true });
    video.dispatchEvent(new Event("loadedmetadata"));
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".y-pic").element.style.aspectRatio).toBe("1280 / 720");
  });

  it("has no fixed height that could leave a dead band", async () => {
    const { wrapper } = await live();
    expect(getComputedStyle(wrapper.find(".y-pic").element).height).not.toMatch(/^\d+px$/);
  });

  // Seen on the board: the cost line reads over the black margin and vanishes
  // where the video starts.
  it("draws every overlay in front of the video", async () => {
    const { wrapper } = await live();
    const video = Number(getComputedStyle(wrapper.find(".y-pic__video").element).zIndex || 0);
    for (const sel of [".y-pic__hud", ".y-pic__rec", ".y-pic__osd", ".y-pic__hint"]) {
      const el = wrapper.find(sel);
      if (!el.exists()) continue;
      expect(Number(getComputedStyle(el.element).zIndex)).toBeGreaterThan(video);
    }
  });

  it("draws the REC pill only while recording", async () => {
    const { wrapper } = await live({ recording: { since: 827 } });
    expect(wrapper.find(".y-pic__rec").text()).toContain("00:13:47");
  });

  it("draws the aim strip along the foot", async () => {
    const { wrapper } = await live({ osd: { zoom: "1.0×", tilt: "−18°", ev: "−0.3" } });
    expect(wrapper.find(".y-pic__osd--foot").text()).toContain("−18°");
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
npx vitest run src/ui/picture.component.test.ts --root packages/node-red-dashboard-2-yonder
```

- [ ] **Step 3: Fix the pane and add the overlays**

Bind `aspect-ratio` from `loadedmetadata`, drop any fixed height, give every
overlay a `z-index` above the video, and add the REC pill, the corner box, the
foot strip and the hint from `page-anatomy-v2.html` layout B.

- [ ] **Step 4: Run the tests — expect PASS**

- [ ] **Step 5: Mutation-check**

Remove the `aspect-ratio` binding. Expected: the aspect test goes red.
Restore.

- [ ] **Step 6: Commit**

```bash
git add packages/node-red-dashboard-2-yonder/src/ui/YonderPicture.vue packages/node-red-dashboard-2-yonder/src/ui/picture.component.test.ts
git commit -s -m "fix(console): the pane is the shape of the picture, and the overlays are in front of it — R-UI-08"
```

---

### Task 21: The gate photographs readings, not masks

**Files:**
- Modify: `scripts/capture-pages.mjs:500-540` (the masking)
- Create: `scripts/fixtures/specimens.json`
- Modify: `scripts/verify-pages.sh`

**Why:** R-UI-23. The gate covers live readings with grey rectangles and checks
geometry, so a clipped value is invisible to it — underneath the rectangle. It
saw neither the truncated readouts nor the dead band.

- [ ] **Step 1: Write the specimen table**

`scripts/fixtures/specimens.json` — one fixed, deliberately awkward value per
field: the widest each can honestly hold.

```json
{
  "picture": "1280 × 720 · 30 fps",
  "bitrate": "5.17 Mb/s at I-frame",
  "uplink": "5.17 Mb/s at IP",
  "tilt": "−180.0°",
  "whiteBalance": "2800 K",
  "identity": "platform-fd500000.pcie-pci-0000:01:00.0-usb-0:1.3:1.0-video-index0",
  "rtspUrl": "rtsp://yonder:••••••••••••••••@0.0.0.0:8554/cam0"
}
```

**The RTSP specimen is masked in the fixture itself.** R-SEC-10 names an
interface capture committed to the repository, and the receive line renders a
real password on screen.

- [ ] **Step 2: Replace masking with specimens**

Where `capture-pages.mjs` sets the mask attribute, set the element's text to
its specimen instead. Values are fixed, so the photographs stay identical build
to build and the gate works exactly as it does now — but a field too narrow for
its own contents changes the page's shape and fails.

- [ ] **Step 3: Add the overflow measurement**

```js
// A specimen only catches a field somebody chose a specimen for. This catches
// the rest, and it is the check that would have found `1280 × 7…`.
const clipped = await tab.$$eval("*", (els) => els
  .filter((el) => el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0)
  .map((el) => `${el.className} — ${el.textContent.trim().slice(0, 40)}`));
if (clipped.length) fail(`text is clipped:\n  ${clipped.join("\n  ")}`);
```

- [ ] **Step 4: Run it and accept the new shapes**

```bash
./scripts/verify-pages.sh
ACCEPT_SHAPE=1 ./scripts/verify-pages.sh
```

Review every changed capture by eye before accepting. Confirm no password
appears in any committed PNG.

- [ ] **Step 5: Prove the gate now catches what it missed**

Set a readout's width to `40px` in a component's styles. Expected:
`verify-pages.sh` fails naming the clipped element. Revert.

- [ ] **Step 6: Commit**

```bash
git add scripts docs/console/capture
git commit -s -m "fix(console): the gate photographs readings and measures overflow — R-UI-23"
```

---

### Task 22: Rebuild both camera pages

**Files:**
- Modify: `flows/flows.json`
- Modify: `packages/yonder-core/src/flows.test.ts`
- Modify: `packages/node-red-contrib-yonder-video/src/` (the node feeding the deck)

**Why:** this is what all of it was for. Eleven stock widgets go; two Yonder
widgets and the reworked picture arrive.

- [ ] **Step 1: Write the failing test**

```ts
describe("the camera pages", () => {
  // ADR-0009 is what this milestone exists to satisfy.
  it("has no stock Dashboard control on either camera page", () => {
    const STOCK = ["ui-slider", "ui-number-input", "ui-table", "ui-text", "ui-dropdown"];
    for (const page of ["Camera", "Cameras"]) {
      const types = widgetsOn(page).map((n) => n.type);
      for (const s of STOCK) expect(types).not.toContain(s);
    }
  });

  it("draws the Camera page from the deck, the picture and the rail", () => {
    expect(widgetsOn("Camera").map((n) => n.type).sort()).toEqual([
      "ui-yonder-annunciator", "ui-yonder-databar", "ui-yonder-deck",
      "ui-yonder-deck", "ui-yonder-holdkey", "ui-yonder-picture",
      "ui-yonder-softkeys",
    ]);
  });

  it("draws the Cameras page from the index and the budget", () => {
    expect(widgetsOn("Cameras").map((n) => n.type).sort()).toEqual([
      "ui-yonder-budget", "ui-yonder-index", "ui-yonder-softkeys",
    ]);
  });

  // Every node type the shipped flows use must come from a package the
  // install path installs (R-UI-19).
  it("uses only node types this install provides", () => {
    for (const n of flows) expect(providedTypes()).toContain(n.type);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm test -w yonder-core
```

- [ ] **Step 3: Rewire the pages**

Delete the `Applies live`, `No control for these`, `Restarts the picture`,
`Stored in config.yaml`, `Attached` and `Not cameras` groups and every widget
in them. Add one `ui-yonder-deck` per mode on the Camera page and one
`ui-yonder-index` on Cameras. Extend the video node to emit the deck's payload
— capabilities, values, commanded values, outputs with `outputReach` — and to
accept the deck's emissions.

**S12, closed by construction:** the legends were `RESTARTS THE PICTURE` and
`STORED IN CONFIG.YAML`, which is an exempt-versus-load-bearing distinction
wearing the vocabulary of a different one. The deck's columns are named for
what they control; whether a change restarts the picture is a per-control
qualifier on the row, not a group heading.

- [ ] **Step 4: Run the tests, then the pages**

```bash
npm test && ./scripts/verify-pages.sh
```

- [ ] **Step 5: Prove defect 1 is gone**

Ask the operator for the board's current address. Deploy, then:

1. Move a Live control. **No confirmation toast may appear.**
2. Tab out of every field on the Live deck. **No toast.**
3. Change bitrate on Setup and press Apply. A window arms — correctly.
4. While it is pending, confirm a network apply is refused, then confirm.

If a toast still appears from the Live deck, the hypothesis in spec §7 was
wrong: find what posts it before going on. Do not guess.

- [ ] **Step 6: Commit**

```bash
git add flows/flows.json packages/yonder-core/src/flows.test.ts packages/node-red-contrib-yonder-video docs/console/capture
git commit -s -m "feat(console): both camera pages built from instruments, and no stock control left — R-UI-08, ADR-0009"
```

---

### Task 23: The accessory camera speaks

**Files:**
- Create: `packages/yonder-core/src/video/accessory/duml.ts`
- Create: `packages/yonder-core/src/video/accessory/duml.test.ts`
- Create: `packages/yonder-core/src/video/accessory/aoa.ts`
- Create: `packages/yonder-core/src/video/accessory/aoa.test.ts`

**Interfaces:**
- Produces: `encode({ sender, receiver, sequence, cmdSet, cmdId, payload }): Buffer`,
  `decode(buf: Buffer): DumlFrame | null`, and
  `openAccessorySession(opts): Promise<AccessorySession>` with
  `{ send(frame: Buffer): void; on(event: "frame", fn): void; close(): void }`.

**Why:** R-CAM-15, brought forward from M5. The protocol is already settled on
the bench in `scripts/pocket2/` — DUML against the published dissector, an AOA
session with the board presenting as the phone. What does not exist is any of
it inside `yonder-core`. Port `duml.py` and `aoa_session.py` faithfully; the
CRC seeds and device types there are checked against `dji-firmware-tools`.

- [ ] **Step 1: Write the failing test**

```ts
describe("DUML", () => {
  // Round-tripping proves the two halves agree; the vectors prove they agree
  // with DJI rather than only with each other.
  it("round-trips a frame", () => {
    const frame = encode({ sender: DEV_PC, receiver: DEV_GIMBAL, sequence: 1,
      cmdSet: 4, cmdId: 0x0c, payload: Buffer.from("00000a0080", "hex") });
    const back = decode(frame)!;
    expect(back.cmdSet).toBe(4);
    expect(back.cmdId).toBe(0x0c);
    expect(back.payload.toString("hex")).toBe("00000a0080");
  });

  it("computes the CRC8 seed DJI uses", () => {
    expect(crc8(Buffer.from("550e04", "hex"))).toBe(EXPECTED_CRC8);
  });

  it("computes the CRC16 seed DJI uses", () => {
    expect(crc16(Buffer.from("550e0466...", "hex"))).toBe(EXPECTED_CRC16);
  });

  it("refuses a frame whose CRC does not check", () => {
    const frame = encode({ sender: DEV_PC, receiver: DEV_GIMBAL, sequence: 1,
      cmdSet: 4, cmdId: 0x0c, payload: Buffer.alloc(5) });
    frame[frame.length - 1] ^= 0xff;
    expect(decode(frame)).toBeNull();
  });

  it("refuses a truncated frame rather than reading past its end", () => {
    const frame = encode({ sender: DEV_PC, receiver: DEV_GIMBAL, sequence: 1,
      cmdSet: 4, cmdId: 0x0c, payload: Buffer.alloc(5) });
    expect(decode(frame.subarray(0, 6))).toBeNull();
  });
});
```

Take `EXPECTED_CRC8` and `EXPECTED_CRC16` from `scripts/pocket2/duml.py`'s own
reference tables — the comment there names the vectors.

- [ ] **Step 2: Run them and watch them fail**

```bash
npx vitest run src/video/accessory/duml.test.ts --root packages/yonder-core
```

- [ ] **Step 3: Port `duml.py` and `aoa_session.py`**

Keep the docstring from `duml.py` — the frame layout, the device types and the
CRC seeds, with their provenance.

- [ ] **Step 4: Run the tests — expect PASS**

- [ ] **Step 5: Mutation-check**

Change the CRC16 seed. Expected: the vector test goes red, and the round-trip
does **not** — which is the point of having both. Restore.

- [ ] **Step 6: Commit**

```bash
git add packages/yonder-core/src/video/accessory
git commit -s -m "feat(video): DUML and the accessory session, brought in from the bench — R-CAM-15"
```

---

### Task 24: The gimbal answers

**Files:**
- Create: `packages/yonder-core/src/video/accessory/gimbal.ts`
- Create: `packages/yonder-core/src/video/accessory/gimbal.test.ts`

**Interfaces:**
- Consumes: `encode`, `decode`, `AccessorySession` (Task 23).
- Produces: `slew(session, { pan, tilt, roll }: DegreesPerSecond): void`,
  `recentre(session): void`,
  `onAttitude(session, fn: (a: { pitch: number; roll: number; yaw: number; atLimit: boolean }) => void): void`,
  and `AIM_CAPABILITY: AimCapability`.

**Why:** the bench scripts settle the wire format:
`gimbal-rate-confirm.sh` confirms `0x0C` with flags `0x80` carries three
int16s in tenths of a degree per second and **stops when the frames stop**;
recentre is `0x4C` with payload `0201`; attitude returns pitch, roll and yaw as
int16 tenths with a limit byte at offset 10.

- [ ] **Step 1: Write the failing test**

```ts
describe("the gimbal", () => {
  it("sends a rate as tenths of a degree per second", () => {
    const sent = capture((s) => slew(s, { pan: 10, tilt: 5, roll: 0 }));
    const frame = decode(sent[0])!;
    expect(frame.cmdId).toBe(0x0c);
    expect(frame.payload.readInt16LE(0)).toBe(100);
    expect(frame.payload.readInt16LE(4)).toBe(50);
    expect(frame.payload[6]).toBe(0x80);
  });

  // Measured on the bench: one frame drives the gimbal for well under a
  // second and then it stops. Repeating is what keeps it moving, and not
  // repeating is what makes release safe.
  it("repeats while slewing and stops when told to", async () => {
    const { sent, stop } = await slewFor(250);
    expect(sent.length).toBeGreaterThan(1);
    stop();
    const after = sent.length;
    await wait(250);
    expect(sent.length).toBe(after);
  });

  it("recentres with the command the bench confirmed", () => {
    const frame = decode(capture((s) => recentre(s))[0])!;
    expect(frame.cmdId).toBe(0x4c);
    expect(frame.payload.toString("hex")).toBe("0201");
  });

  it("reads attitude as tenths of a degree", () => {
    const a = parseAttitude(Buffer.from("2cff1400d2000000000000", "hex"));
    expect(a.pitch).toBeCloseTo(-21.2);
    expect(a.yaw).toBeCloseTo(21.0);
  });

  // R-TEL-15: a reached limit is an annunciator, not a number to interpret.
  it("reads the limit flag the camera sets", () => {
    const a = parseAttitude(Buffer.from("2cff1400d200000000000001", "hex"));
    expect(a.atLimit).toBe(true);
  });
});
```

- [ ] **Step 2: Run them and watch them fail, then write `gimbal.ts`**

- [ ] **Step 3: Prove it on the gimbal**

Connect the Pocket 2. Confirm a slew moves it, that releasing stops it inside
a second, that recentre works, and that driving to a stop sets the limit flag.
**Record what you measured in the commit message**, the way the bench scripts do.

- [ ] **Step 4: Mutation-check**

Remove the repeat timer. Expected: the repeat test goes red, and the gimbal
visibly stutters on hardware. Restore.

- [ ] **Step 5: Commit**

```bash
git add packages/yonder-core/src/video/accessory
git commit -s -m "feat(video): gimbal rate, recentre and attitude, measured against the camera — R-CAM-15, R-TEL-15"
```

---

### Task 25: The accessory camera is a camera

**Files:**
- Create: `packages/yonder-core/src/video/accessory/source.ts`
- Create: `packages/yonder-core/src/video/accessory/source.test.ts`
- Modify: `packages/yonder-core/src/schema/config.ts:337` (`source` gains `accessory`)
- Modify: `packages/yonder-core/src/video/probe/camera.ts` (detection)
- Modify: `flows/flows.json`
- Modify: `docs/configuration.md`, `docs/roadmap.md`

**Interfaces:**
- Consumes: Tasks 23–24.
- Produces: `source: "accessory"` in the camera schema; a detection that
  reports `CameraCapabilities` with `aim` **present** (from `AIM_CAPABILITY`),
  `zoom` present as a digital crop, and `recording` present on the camera's own
  card.

- [ ] **Step 1: Write the failing test**

```ts
describe("the accessory camera", () => {
  it("reports aim as present, which no USB camera on this bench does", async () => {
    const caps = await accessoryCapabilities(fakeSession);
    expect(caps.aim.state).toBe("present");
  });

  it("reports its own recorder rather than the board's", async () => {
    const caps = await accessoryCapabilities(fakeSession);
    if (caps.recording.state !== "present") throw new Error("narrowing");
    expect(caps.recording.value.medium).toBe("camera");
  });

  // R-CAM-15: the picture and the commands arrive on the same link.
  it("says its zoom is a digital crop rather than optical", async () => {
    const caps = await accessoryCapabilities(fakeSession);
    expect(summarise(caps)).toContain("zoom");
  });

  it("is rejected with a reason when no accessory answers", async () => {
    const result = await detectAccessory(silentSession);
    expect(result.rejected[0].why).toMatch(/did not answer/i);
  });
});
```

- [ ] **Step 2–4: Run, fail, write it, run to PASS**

- [ ] **Step 5: Prove it end to end on the board**

Ask for the current address. Configure the Pocket 2 as a camera and confirm:
the picture reaches a browser; the deck draws an **Aim** column with the dial;
a drag on the picture slews the gimbal and release stops it; the ELP on the
same board still draws **aim advertised** with its reason. **Capture both
pages in both palettes.**

- [ ] **Step 6: Update the roadmap**

Move R-CAM-15 out of M5's list into this milestone, with a line saying it came
forward because the camera was in hand and aim could not be built blind.

- [ ] **Step 7: Commit**

```bash
git add packages/yonder-core/src flows/flows.json docs
git commit -s -m "feat(video): the DJI Pocket 2 as a camera, with a gimbal the console drives — R-CAM-15"
```

---

### Task 26: Close the loop

**Files:**
- Modify: `docs/requirements.md`, `docs/known-issues.md`, `docs/roadmap.md`
- Modify: `docs/console/design/instrument-library/README.md`

- [ ] **Step 1: Add every new requirement**

`R-CTL-11` … `R-CTL-14`, `R-UI-21` … `R-UI-25`, `R-VID-16`, verbatim from the
spec's §9 table with its priority column.

- [ ] **Step 2: File the known issues**

`K-46` … `K-50` for the five observed defects, each marked fixed by this
branch, with the commit that fixed it.

- [ ] **Step 3: Note what the drafts became**

Add a line to the blueprint README saying which package components each draft
became, so the drafts read as history rather than as something to build from.

- [ ] **Step 4: Run everything**

```bash
npm test && npm run lint && ./scripts/verify-pages.sh
```

- [ ] **Step 5: Commit**

```bash
git add docs
git commit -s -m "docs: file the requirements and the known issues this branch closed"
```

---

## Self-review

**Spec coverage.** §1 defects → Tasks 10, 19, 20, 21, 22. §2 eighteen controls
→ Tasks 1, 3, 4, 5, 6. §3 decisions → Tasks 5, 14, 17, 22. §4 four states →
Tasks 1, 2, 4, 12, 13, 14, 17. §5 components → Tasks 11–18, 20. §5.5 outputs →
Tasks 7, 8, 17. §6 accessory camera → Tasks 23, 24, 25. §7 five defects → 22
(1), 10 + 21 (2), 19 (3), 20 (4), 21 (5). §8 model growth → Tasks 1–8. §9
requirements → Task 26. §11 testing → every task. §12 gallery → Task 9.

**Type consistency.** `ControlRange.inactive` (Task 1) is read in Task 4 and
tested in Task 6. `gated(value, by)` (Task 2) is constructed in Task 4,
refused in Task 6, and drawn in Tasks 12–14, 17. `outputReach` (Task 8) is
consumed by Task 17's payload and drawn in Task 22. `CONTROL_MAP` (Task 4) and
`CONTROL_NAMES` (Task 6) are cross-checked by the existing test, which is
deliberately left red between them.

**Known gap, stated rather than hidden.** Task 22 step 5 verifies the
confirmation-window defect against a hypothesis this plan has not confirmed. If
the toast still appears, that step becomes a debugging task and the plan is
wrong about the cause — which is why it is a verification step with an explicit
*do not guess* rather than a fix.
