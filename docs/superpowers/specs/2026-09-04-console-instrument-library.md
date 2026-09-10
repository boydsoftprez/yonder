# The console's instrument library, and the camera pages built from it

**Date:** 2026-09-04 · **Revised** 2026-09-04, to the interactive blueprint and review findings ·
**Extends** [the camera view design](2026-09-03-camera-view-design.md)

The M4 camera view shipped working and looking like something else. This is the
second pass: the instruments the design needs, the deck they compose into, the
mechanisms that have to exist underneath for every control on the page to do
what it says, and the five defects a person found by pressing buttons on a board.

**The blueprint is the interactive mockup at
[`docs/console/design/instrument-library/`](../../console/design/instrument-library/).**
It is built from the real component code against the real generated theme, in
the console's own shell, and it was settled by looking at it. Where this
document and the blueprint disagree about layout, the blueprint is right,
except for the explicit corrections recorded in §15. Device data, command
guards and reachability follow the requirements and the bench evidence; a
mock value does not override them. §7 enumerates every control it draws, and
what must exist for each to work.

---

## 1 · What is actually wrong, measured

Read on the development board with a live camera, not inferred from a capture.

**Eleven of the twenty-three widgets on the two camera pages are stock
Dashboard controls** — two sliders, three number inputs, two tables, four text
widgets. ADR-0009 exists to prevent exactly that.

The Live deck's `APPLIES LIVE` group is **two Vuetify sliders carrying no value
at all.** Not a bare number against its bounds, which R-UI-09 forbids — no
number. The driver's real ranges are brightness −64…64 and contrast 0…95, so a
handle position is not interpretable even in principle.

`NO CONTROL FOR THESE` carries eight rows, **four of which are the page
confessing rather than camera facts.** Zoom, focus, exposure and white balance
each read *"offered, not on this page"* while the device reports all four with
real ranges. That sentence is a fourth capability state the design does not
have, and it means *unfinished*.

**The picture is pillarboxed** — 726 px of video inside a 1230 px pane — and
**its own overlay is drawn behind it.** **The console paints in stock white
Vuetify before the theme arrives**, because the theme is an `@import` inside a
Dashboard `site:style` template (`flows/flows.json:320`): the browser must boot
Dashboard's JavaScript before the style exists, then fetch it as a second
request. **Setup is `ui-text` pairs with enormous gaps.** **The GStreamer
receive line truncates.**

### The root cause, so the plan does not repeat it

The M4 spec described the deck's *behaviour* and never said *"every control is
an instrument, and here is the list."* Underneath that, **Dashboard's grid
makes every widget occupy whole rows** (ADR-0009, context 3), so twelve
controls wired as twelve widgets can never be a three-column deck. The
implementer reached for stock widgets partly because the layout model left
nowhere else to go.

This document answers both: the list is §7, and the deck is one widget (§6).

---

## 2 · What the devices actually offer

**The bench camera** is a global-shutter USB camera. `v4l2-ctl --list-ctrls`
returns eighteen controls, against the eleven `CAPABILITY_KEYS` models and the
three `config.yaml` carries.

| Control | Range | Kind | Note |
|---|---|---|---|
| `auto_exposure` | IDs 1 and 3 only | list | Manual Mode; Aperture Priority Mode. The menu's 0…3 bounds do not offer the missing IDs |
| `exposure_time_absolute` | 1…10000 raw; 100…1000000 µs | range | **inactive** — auto exposure has it; each raw step is 100 µs |
| `gain` | 0…1023 | range | |
| `backlight_compensation` | 36…160 | range | ground against sky |
| `white_balance_automatic` | on/off | switch | |
| `white_balance_temperature` | 2800…6500 | range | **inactive** — auto has it |
| `focus_automatic_continuous` | on/off | switch | |
| `focus_absolute` | 0…1023 | range | **inactive** — autofocus has it |
| `zoom_absolute` | 0…60 | range | digital crop |
| `brightness`, `contrast`, `gamma`, `sharpness`, `saturation`, `hue` | ranges | range | |
| `power_line_frequency` | 3 modes | list | |
| `pan_absolute`, `tilt_absolute` | ±648000 step 3600 | range | **advertised. There is no motor.** |

**The accessory camera** — the DJI Pocket 2 — is documented command by command
in [`docs/hardware/dji-pocket-2-over-usb.md`](../../hardware/dji-pocket-2-over-usb.md),
with a proven / untried column against each. Proven on the bench: rate-mode
aim, attitude at 20 Hz with a limit byte, recentre, video/photo mode,
exposure mode, ISO, EV, white balance, and that zoom is digital-only and does
not reshape the USB feed. Acknowledged but unconfirmable without a card:
record. Ids known, untried: take photo, shutter, focus mode, record format,
sensor size. **Live-view resolution is not controllable** — the SDK's handlers
are stubs — so on this camera it is a stated fact, not a picker.

Three consequences decide much of this document. **The bench can exercise the
whole component set today.** **The advertised-but-not-answered state is
provable on the bench** — the ELP claims ±180° of pan and tilt it has no motor
for, and `CONTROL_MAP` has no entry for it, which is why the page currently
says `aim: none`. **There is a state nothing had drawn:** `flags=inactive`.

---

## 3 · Decisions

Every one of these was taken by looking at the blueprint, and the blueprint
carries them.

| | |
|---|---|
| **Scope** | Both camera pages, the five defects, the mechanisms every control needs, and the accessory camera |
| **The deck** | One widget that composes itself from the capability report. Not one framework row per control |
| **Every control the camera has is on Live.** | Setup adds only four bench-only items: the camera's name, mains frequency, what the card records at, and sensor size. Nothing is removed for simplicity |
| **Layout** | Picture with the **Aim panel beside it** where there is room, below it where there is not; the strip; the deck as groups **flowing into balanced columns**; outputs as one line; the rail. Notebook first, a tablet second |
| **Continuous values** | A **set bar**: one track, two marks — where the device is, what was asked for. Snaps to the device's own step |
| **Two encodes, each with a mode** | `STREAM · to the ground station`, Fixed by default. `PREVIEW · to this browser`, Adaptive by default, with a floor, a ceiling, and a Size whose `Auto` steps down a ladder with the link and whose other rungs hold |
| **The picture wears its own state** | Mode, size, rate, bitrate, pinned-at-floor, stills, full-rate — as an overlay, because in Cockpit the picture is there and the deck is not. A step shows a brief line |
| **One shutter key** | `○ RECORD` in Video mode, `PHOTO` in Photo mode; `● RECORDING 00:13:47` while it runs. Beneath it, where the video or photo lands: the camera's card, or this board (R-CAM-17, R-CAM-18) |
| **Actions beside their object** | Record with Capture; Recentre with Aim. The rail carries `LIVE · SETUP · STREAM ADDRESS`, `APPLY` and `DISCARD` for a draft on Setup, and `FULL RATE`. Amends ADR-0009's rail rule; R-UI-10's sizing and primary-action limits still apply |
| **Aim** | Rate control, drag on the pad or on the picture, release stops. Reported position drawn against its bounds; commanded rate as its own block; the pad in the adopted idiom — one ring, a crosshair, a haloed puck |
| **The Pocket 2** | R-CAM-15 pulled forward: it is in hand, and aim is built against a gimbal that moves |
| **Outputs** | Each output with its state, its cost and its reachability; an On/Off each on Setup. An unreachable output is stated, never stopped by the console |
| **Names** | `Cam 1`, `Cam 2` by default; the operator's to change; shown everywhere the camera is named |
| **More than one camera** | One page per camera in the sidebar (R-UI-03), and a strip under the picture with the others as periodic stills, with the cost of all of it |
| **"Receive line"** | Is **Stream address** |
| **Sizing** | 36 px keys, 220 px tracks with a hit zone a finger can land on, 10.5 px labels. Touch is in mind; it is not the law |

---

## 4 · The four states a capability can be in

| State | Meaning | How it draws |
|---|---|---|
| **Present** | The device answered and the control works | The control, live |
| **Not offered** | The device does not have it | A stated fact where the control would have been. One row of text, in sentence case. Never a control that cannot be used, never silently nothing |
| **Advertised, not answered** | It lists it, accepts the command, does nothing | The control stays, inoperative, in the caution tone, **carrying the reason** |
| **Gated** | Real and in range, but another control has charge of it | The control stays, inert, in the neutral tone, **naming the way back** in the operator's words — *while exposure is program*, never *while exposure is 1* |

Gated is not a fault and must not look like one. Spending the caution tone on
a camera behaving correctly is how an operator learns to stop reading it.
`R-UI-21`. The soft-key rail remains the exception: it carries only actions
that can be taken.

---

## 5 · The surfaces

The same components, the same behaviour, on every surface they appear on.
"Works" means works on all of them.

| Surface | What is on it | What it must do |
|---|---|---|
| **Camera · Live** | Picture and Aim panel; strip; every control the camera has, in groups; outputs in one line; the rail | Everything in §7 |
| **Camera · Setup** | The same, plus the four bench-only controls (including name), and the outputs table with On/Off | Review, Apply or Discard the shared draft; confirmation where a change is load-bearing; never from the Live deck |
| **Cameras** | Camera rows, rejection rows, the board's encode budget and the uplink | Rows open their camera; Detect again; Add by address |
| **Cockpit / mission control** (M5) | **The picture, its state overlay, and the Aim panel** — the deck is not there | The picture and the aim must not depend on the deck for anything. The state overlay is on the picture for this reason |
| **A notebook** | The primary surface. At 1440×900 with the sidebar open, the picture, Aim and Capture fit above the fold; the complete deck may extend below it | One vertical page scroll; no nested deck scroller or horizontal overflow. The rail remains reachable while the deck scrolls |
| **A tablet, landscape** | Aim drops below the picture at ≤1100 px; groups flow to fewer columns | Everything still reachable with a finger |
| **The capture gate** | Every page above, in both palettes, in every capability state, at notebook and tablet widths | A page that changes shape fails until somebody looks (R-UI-12) |

---

## 6 · The component set

Four Dashboard nodes, and the parts they are built from.

**`ui-yonder-deck`** — one node per camera page. Receives the capability
report and the current values; draws its own groups, flowing into columns;
decides what exists from the report. Emits one action per control change.
Live and Setup are one component in two modes. **There is no group left for a
stock widget to be dropped into.**

**`ui-yonder-index`** — the Cameras page: camera rows, rejection rows.

**`ui-yonder-picture`** — reworked: overlays in front of the video, never
behind; the pane is the shape of the picture and never taller than it needs;
the drag-to-slew layer (orb only, measured from where the finger landed); **the
state overlay**; the REC pill; `LINK · DROP` bottom-right; the thumbnail strip
of the other cameras beneath.

**`ui-yonder-aim`** — the Aim panel as its own node, because Cockpit embeds it
without the deck: the pad, reported position against bounds, commanded rate,
gimbal mode with its sentence, Recentre gimbal, the limit annunciator, and the
dead state with its reason.

The parts inside them — Vue components with their own tests, not separately
registered nodes:

| Part | For | Rules |
|---|---|---|
| **Picker** | One value from what the device answered | Options from the probe. A real `<select>` beneath the drawn control. All four states. Capped width |
| **Segmented control** | Two or three exclusive choices | **A maximum width; never stretches** |
| **Set bar** | A bounded continuous value | Two marks. Snaps to the device's step. Fixed width. In Adaptive it is a readout, `GOING OUT` |
| **Readout row** | Label · value · unit, stacked | Unit never uppercased. Capped width |
| **Column** | A titled group with a right-hand qualifier — *to the ground station*, *rate control* | |
| **Placard** | `CAMERA · CAM 2` and `ACCESSORY · H.264 · 1280×720p30` | |
| **Text field** | The camera's name | Defaults `Cam N`; 24 characters |
| **Aim pad** | One ring, a crosshair, axis labels, a haloed puck; a struck axis for one that will not answer | Drag sets a rate; the dead zone cancels that rate. Release, cancel, leave, lost pointer capture, blur and navigation end the gesture. The daemon enforces expiry independently (§8.7) |
| **Position gauge** | Pan or tilt against its bounds | R-UI-09 |
| **Shutter key** | Record or Photo, following the mode | Red ring; lit and counting while recording; the destination beneath |
| **State overlay** | What the picture is, now | On the picture; tone follows the state |
| **Thumb strip** | The other cameras as stills, and the cost | One press switches |

`YonderGauge`, `YonderDataBar`, `YonderAnnunciator`, `YonderSoftKeys`,
`YonderHoldKey`, `YonderBudget`, `YonderFacts`, `YonderIdentity`, `YonderTape`
and `YonderSparkline` stand. The gallery found three of them clipping
(`DataBar`, `SoftKeys`, `Budget`); those are fixed first.

---

## 7 · Every control, and what it needs underneath

**This is the section the first pass did not have.** A control on the page is
a promise; each row names what has to exist for the promise to be kept — the
model key, the config field, the probe, the write path, and the daemon
behaviour — and whether the bench has proven the device answers.

*Kinds:* bar = set bar · pick = picker · seg = segmented · key · fact.
*Proven:* the bench has driven it and seen the effect.

### Editing on Live and Setup — R-CTL-10, R-CFG-03, R-UI-05

Image controls send explicit live commands. Persistent stream and preview
settings edited on Live instead update a **shared draft per camera**, also
shown on Setup; they never apply on blur or navigation. Each changed field
marks its requested value *Pending Apply on Setup*, alongside the actual
value. A visible pending-change count links to Setup without applying it.

Switching Live/Setup or cameras preserves each draft for the browser session.
Setup lists the changed values and any expected interruption; `APPLY` submits
that draft once, and `DISCARD` restores the current applied values. Neither
action undoes live image commands. Applying marks requests as sent; actual
readings follow observed device/encoder state, not acknowledgements alone.
Protected changes remain pending confirmation, and a
rollback restores the previous applied values and states why. Concurrent
config changes require reloading/reviewing the draft, never silently
overwriting another operator. §11 classifies the protected fields.

### Stream · to the ground station

| Control | Kind | Model / config | Mechanism | Proven |
|---|---|---|---|---|
| Bitrate mode `Fixed \| Adaptive` | seg | `cameras[].stream.mode` (new) | **The rate controller** (§8.1). Fixed by default | — |
| Fixed bitrate | bar | `bitrate_kbps` (exists) | Fixed mode's target; staged on Live, **Apply** on Setup. Runtime encoder control (§8.1); the current implementation respawns | current respawn path only |
| Floor · Ceiling | pick | `stream.floor_kbps`, `stream.ceiling_kbps` (new) | Operator's Adaptive envelope; staged and applied on Setup. Retained while Fixed is selected | — |
| Going out | readout | egress measured per output (R-VID-11, exists) | | yes |
| Resolution | pick | `width`/`height`/`framerate` (exist), options from the probe's formats | Pipeline respawn on Apply | yes |
| Live-view resolution (Pocket 2) | fact | `formats` not-offered | | yes — the handlers are stubs |

### Preview · to this browser

| Control | Kind | Model / config | Mechanism | Proven |
|---|---|---|---|---|
| Bitrate mode `Adaptive \| Fixed` | seg | `preview.mode` (new) | The rate controller. Adaptive by default | — |
| Fixed bitrate | bar | `preview.bitrate_kbps` (exists) | Editable target in Fixed mode, retained in Adaptive; staged and applied on Setup | current respawn path only |
| Going out | readout | measured | | yes |
| Size `Auto \| 1280×720 \| 854×480 \| 640×360` | pick | `preview.size` (new: `auto` or a rung); ladder bounded by `preview.ladder_top/bottom` (new) | **Resolution stepping** (§8.1): step down when pinned at the floor, up when there is headroom. A chosen rung holds | — |
| Rate | pick | `preview.framerate` (exists) | Preview-only reconfigure after Apply (§8.1) | current respawn path only |
| Floor · Ceiling | pick | `preview.floor_kbps`, `preview.ceiling_kbps` (new) | Bounds for the controller; shown only in Adaptive | — |
| Smallest · Largest automatic size | pick | `preview.ladder_bottom`, `preview.ladder_top` (new) | Visible with Auto size; operator chooses both endpoints from supported preview rungs, then applies on Setup | — |
| `FULL RATE` (rail) | hold key | exists (R-VID-13) | Full-quality stream while held; cost stated | yes |

All stream and preview settings above remain on Live as well as Setup; they
are not additional bench-only controls. Each mode retains its own settings.
Fixed mode holds the applied size and bitrate: if Size is Auto, show the held
size and *while bitrate is fixed*. Returning to Adaptive resumes Auto inside
the applied endpoints. Validate floor ≤ ceiling, smallest ≤ largest, and a
held size against the supported rungs. Never silently repair a draft.

### Exposure · Colour · Optics · Rendering — the ELP

Each is one V4L2 control, probed by `CONTROL_MAP`, written by
`CONTROL_NAMES`, live on the running stream, never a respawn, never the apply
window (`controls` is exempt). Enumeration proves the offered range or menu,
not the physical effect: each live control still needs a write/readback and
observed-effect check before it is marked proven.

| Control | Kind | V4L2 | Gates |
|---|---|---|---|
| Exposure `Aperture priority \| Manual` | seg | `auto_exposure`, offered IDs 3 and 1 | shutter; labels may be shortened without inventing menu entries |
| Shutter (µs) | bar | `exposure_time_absolute`, raw × 100 | gated by auto exposure |
| Gain · Backlight | bar | `gain` · `backlight_compensation` | |
| White balance `Auto \| Manual` | seg | `white_balance_automatic` | temperature |
| Temperature (K) | bar | `white_balance_temperature` | gated |
| Brightness · Contrast | bar | `brightness` · `contrast` | |
| Focus `Auto \| Manual` | seg | `focus_automatic_continuous` | focus |
| Focus | bar | `focus_absolute` | gated |
| Zoom (device steps) | bar | `zoom_absolute` | no × ratio until the device's scale is established |
| Gamma · Sharpness · Saturation · Hue | bar | as named | |
| Mains frequency — *Setup only* | pick | `power_line_frequency` | |

Model: `CameraCapabilities` gains ten keys; `CameraControls` gains their
fields, `null` meaning *leave the camera alone*; `flags=inactive` becomes the
gated state carrying the gating control's operator-facing name.

The probe preserves menu entry IDs and labels, not just min/max. The ELP
[fixture](../../../packages/yonder-core/src/video/probe/fixtures/list-ctrls-menus-globalshutter.txt)
offers exposure IDs **1 and 3**, so 0 and 2 must never become choices
or accepted writes. Re-read gates after an automatic-mode command answers.
Gate relationships belong in the adapter, not a universal UI rule that only
Manual permits shutter or ISO.

V4L2 absolute exposure uses **100 µs per raw unit**, as defined by the
[kernel control reference](https://docs.kernel.org/userspace-api/media/v4l/ext-ctrls-camera.html).
Convert current, default,
min, max and step together at the adapter boundary: raw 156 is **15600 µs**,
with a 100 µs displayed step. Writes snap to that step and convert back once;
readback verifies the same raw value. This corrects both mockups, which
currently label raw 156 as µs (R-CTL-10, R-CTL-11). Retain device-native units
in stored control values and document them; the descriptor supplies display
units and conversion, so an existing config value is not reinterpreted.

### Exposure · Colour · Optics · Capture — the Pocket 2

Each is a DUML command on the accessory link (§9).

| Control | Kind | Command | Proven |
|---|---|---|---|
| Exposure `Program … Manual` | pick | `camera/0x1e` (2 B) | yes — gates ISO and shutter |
| ISO | bar | `0x2a` | yes |
| Shutter (µs) | bar | `0x28` | **no** |
| EV (±3, thirds) | bar | `0x2e` (index 16 = 0.0) | yes |
| White balance `Auto · Sunny · Cloudy · …` | pick | `0x2c` (2 B) | yes |
| Zoom 1.0–10.0× | bar | `0x34` | yes — **digital, and the feed does not change; the browser crops**, which the fine print says |
| Focus `AFC \| AFS \| Spot` | seg | `0x24`, `0x30`, `0x32` | **no** |
| Mode `Video \| Photo` | seg | `camera/0x10` | yes |
| Shutter key — Record / Photo | key | `camera/0x02` · `camera/0x01` | record acknowledged, unconfirmable with no card; photo **no** |
| Sensor `16 \| 64 MP` — *Setup only* | seg | `camera/0x12` | **no** |
| Records at — *Setup only* | pick | `camera/0x18` | **no** |
| Battery · Card · Sensor | readouts | `camera/0x80…0x88` pushes | received; **not yet decoded** |

**Nothing marked *no* ships as a live control until the bench has driven it.**
Until then it is drawn as the report says, and the plan's first task on the
accessory camera is to drive each and record the effect the way the hardware
note does. The gallery's *mark unproven* switch is that list.

### Aim

| Control | Kind | Mechanism | Proven |
|---|---|---|---|
| The pad, and drag on the picture | rate | `gimbal/0x0C`, flags `0x80`, 10 Hz while fresh operator intent remains valid; guarded and expired by the daemon (§8.7) | rate path and device timeout proven; browser-to-device expiry unbuilt |
| Reported position, against bounds | gauge | `gimbal/0x05` push at 20 Hz | yes |
| At the limit | annunciator | byte 10 of the push (R-TEL-15): bit 0 pitch, bit 1 yaw | yes — mounted run; bit 5 is not a limit |
| Gimbal mode `Follow \| Tilt lock \| FPV` | seg | `gimbal/0x44`; mode byte in `0x4C` | mode byte proven as part of recentre; standalone **untried** |
| Recentre gimbal | key | `gimbal/0x4C` `02 01`, through the same guard as rate and mode changes | proven from a clear pose; an unguarded limit-pose run stalled the motor |
| Roll — struck | state | no answer on the third axis | the mockup's drawing; the bench has one axis-by-axis run left |
| **Guard every motion command** | rule | Per-installation, per-mode bounds, fresh attitude and limit flags constrain rate, mode and Recentre before sending (§8.7). The page sends no absolute pointing command | bench evidence establishes the need; production guard unbuilt |

On the ELP the whole panel is drawn dead, in the caution tone, with the reason,
because it advertises pan and tilt and has no motor.

### Capture destination

| | Mechanism | Proven |
|---|---|---|
| *to the camera's card* | the camera's own recorder | acknowledged; no card on the bench |
| *to this board* | **Board recording** (§8.3, R-CAM-17): a bounded file on the board's card, `R-STO-06` | **unbuilt** |
| Photo *to the camera's card* / *to this board* | Camera capture where supported; otherwise a frame from the running pipeline (§8.3, R-CAM-18) | camera command untried; board fallback unbuilt |
| the line under the key | free space, or *no card in the camera* | needs the state push decoded |

### Outputs

| | Mechanism |
|---|---|
| State, cost | R-VID-11, exists |
| Reachability | `outputReach(kind, paths)` (§8.4): outbound works everywhere; a listener works on the LAN or the mesh and never behind carrier NAT |
| On / Off | `CameraOutput.enabled` (new); a stopped output keeps its port, path and secret |
| *stop or start them on Setup ›* | the one-liner on Live links to the table on Setup |

### The picture

| Overlay | Source |
|---|---|
| State — `ADAPTIVE · 1280×720 · 15 fps · 1.8 Mb/s · 1.8 of 0.3–2.0` / `AT THE FLOOR · … · 1.2 s round trip` / `HELD` / `FULL RATE` / `STILLS · every 2 s` | **a preview-state message from the daemon** (§8.2) |
| The brief step line | the same message, on a change of rung |
| `LINK · DROP` | WebRTC stats in the browser |
| `PAN · TILT · ZOOM · EV` foot strip | attitude push; the camera's own exposure control |
| `REC 00:13:47` | the camera state push or the board recorder's observed state and elapsed time, according to destination |
| The thumbnail strip: the others as *Still · 4 s*, and *Downlink now* | R-VID-14's stills mechanism, subscribed per viewer; measured traffic summed by path, including all copies (§8.2) |

### Names, navigation, stream address

| | Mechanism |
|---|---|
| Name | `cameras[].name` (exists); the text field writes it; the placard, the sidebar, the index, the strip and the stream address read it |
| One sidebar entry per camera | Dashboard's dynamic pages from detection (R-UI-03, exists) |
| Stream address | R-VID-15's receive line, renamed; a panel with the four receivers |

---

## 8 · The mechanisms that do not exist yet

These are what "implemented completely" means. Each is a phase of the plan and
each has a requirement.

### 8.1 The rate controller — R-VID-07, R-VID-17

Measures the link, moves the encoder inside the operator's envelope, and
reports what it did. Inputs: round-trip time and loss from the browser's
WebRTC statistics for the preview; egress against measured capacity for the
stream. Rules: never outside the applied floor and ceiling; reserve the
ground-station stream's spend before allocating remaining capacity to the
preview. Step Auto size down one rung when pinned at the floor, and up one
rung when there has been headroom, with hysteresis. A held size never steps;
Fixed holds its target and size. **If even the preview floor cannot fit,**
show the shortfall: do not lower the floor, stop an output or claim the
traffic fits. Stills fallback is the separately specified browser delivery
behavior (§8.6). Rate adaptation carries out an applied video policy; it
never originates an aircraft or gimbal command (R-CMD-04).

**A runtime encoder control channel is part of this work.** The current
`video/supervisor.ts` can only respawn a process containing both encodes.
Add commands and observed acknowledgements for each encode's bitrate, and
preview-only size/rate reconfiguration. Bitrate updates must not respawn the
camera pipeline; a preview rung change must leave the main stream and board
recording continuous. Isolate a preview branch restart where live
renegotiation is unavailable. A camera whose main feed is fixed passthrough
reports that fact rather than offering an ineffective bitrate controller.

The controller consumes the applied envelope, never a UI draft. Setpoints,
observed encoder settings and measured egress are separate values; failure
keeps the last confirmed state and names the failed request. A source format
change may still require a whole-pipeline restart, declared before Apply.
Choose and test timing thresholds with a controllable clock and throttled
link; record the measured values in the implementation plan. Every actual
step, and its reason, is reported to the picture.

### 8.2 The preview-state message — R-VID-18

State has **two scopes**, combined into the message for each picture:

- **Per camera:** shared preview encode mode, actual size/rate/bitrate,
  applied floor/ceiling, pinned/held, and the last step with its reason.
- **Per viewer and camera:** Video, Stills or Off; Full rate while held;
  effective media source, delivery size/rate, measured traffic, frame age and
  stills interval. A viewer is a browser session, not a camera page component.

The daemon publishes camera ID, viewer ID, state revision and observation
time, on change and on reconnect. Browser statistics are tagged with those
IDs and freshness; they do not directly rewrite another viewer's state.
Two viewers share one preview encode. Adaptation uses the most constrained
fresh report among its active video subscribers; stale reports cannot count
as headroom. If no fresh evidence exists, report unknown capacity and hold
the last confirmed setting rather than inventing an increase.

Full rate switches only that viewer to the main stream while held. It does
not raise the shared preview encode or switch another viewer out of Stills.
Release, cancel, lost capture, blur, disconnect and expiry end the request.
Two pages displaying the same camera in one session share that subscription.

Cost means **actual traffic per output/subscriber on each path**, including
other viewers and thumbnail stills (R-VID-11), not the sum of two encoder
targets. Show this viewer's cost separately from total path spend; count each
network transmission once. The daemon combines the scopes; the picture draws
the resulting state without depending on the deck or a second rate algorithm.

### 8.3 Recording and photos — R-CAM-17, R-CAM-18, R-STO-06

A camera with no recorder of its own records to this board: a bounded file,
the free space stated, and the same shutter key. The line under the key says
where. Storage reserve and the bounded-file stop behavior follow R-STO-06.

Photo mode uses the camera's own still capture when available; otherwise it
saves a frame from the running pipeline to the board. This makes Video/Photo
and the same shutter key available on the ELP too. The fallback neither
restarts the source nor interrupts a recording. With no current frame, the
key states why it cannot capture; it does not save an old frame as a new one.
Confirm success only after the camera confirms capture or the board file is
written, and state which destination received it.

Board-saved stills can be viewed, downloaded and explicitly deleted from a
captures panel reachable beside Capture on Live and Setup (R-CAM-18).
Camera-card photos are identified as such; do not imply they can be fetched
until the camera supports that operation. Mode changes and repeated shutter
presses cannot launch competing pending capture operations. Camera state and
board capture state are distinct sources for the REC pill and destination.

### 8.4 Output reachability — R-UI-24

`outputReach(kind, paths)` in `yonder-core`, from the device's live paths. It
returns a sentence and never an action.

### 8.5 The camera state push — decoded

`camera/0x80`, `0x81`, `0x87`, `0x88` arrive at 10–20 Hz and are not yet
decoded. Battery, card, mode and record time come from them; the readouts and
the REC pill wait on this.

### 8.6 The stills fallback, per camera — R-VID-14

Exists in design for one picture; the strip needs one per non-active camera at
a stated interval **for each viewer**. Generate a still once per camera when
requests coincide, but count every transmitted copy in path spend. A viewer
can fall back to stills or choose them without switching another viewer's
video. Show frame age and interval. Unsubscribing when a page leaves or a
session expires ends that viewer's media delivery; it does not disable a
configured RTSP, SRT or RTP output.

### 8.7 Aim guards and expiring intent — R-CAM-11, R-CMD-04, R-TEL-15

**The device timeout is only the last link.** The bench measured motion
ceasing about 0.5 s after the last DUML rate frame. It did not establish a
0.5 s browser-to-gimbal stop guarantee. The daemon must not keep repeating a
rate after the browser's intent has expired.

Every gesture carries a session/gesture ID, increasing sequence and a
deadline validated in the daemon's monotonic clock domain. Use daemon-issued
expiring credentials/deadlines; neither a browser wall clock nor arrival of
an old queued frame can renew the command. Reject expired, out-of-order and
previous-gesture messages before the DUML write. Fresh intent is renewed only
while the operator is pushing; the daemon's forwarding lease lasts at most
500 ms without a fresh accepted renewal. Forward at 10 Hz only while both
the command deadline and lease are valid. Release and other end events
invalidate the gesture and clear queued motion immediately. Lease expiry
ends forwarding independently of browser stop delivery; reconnect never
resumes an old gesture. Stopping cancels the operator's command and does not
originate a new aim target.

Returning to the pad's dead zone also cancels the current rate. Moving out
again while still dragging starts a new command generation; late frames from
the cancelled generation cannot restart motion.

Document and measure the complete stop bound: admitted command freshness,
remaining forwarding lease, then the device's measured timeout. The maximum
command age must be finite and enforced at receipt and dispatch; link latency
and clock uncertainty that exceed that budget inhibit new motion rather than
admitting indefinitely delayed commands. Test browser loss with USB intact,
not just USB loss. Never describe the device timeout alone as the end-to-end
bound.

**One daemon guard covers rate, mode and Recentre, from every surface.** It
uses the envelope established for this installation and gimbal mode, fresh
attitude, verified rate-to-position signs, and the camera's limit bits.
Bounds are obtained by an operator-directed mounted procedure, never an
autonomous sweep or a hard-coded manufacturer's range. Unknown bounds,
unknown mode or stale attitude inhibit non-zero motion on the affected axes
and state the missing precondition. Reserve room for the maximum continuing
travel during command expiry and stopping; a rate that would consume that
margin is refused before it reaches the device.

At a limit, refuse motion farther into it. Permit an operator's movement away
only with fresh position and a verified direction inside a known envelope;
otherwise require the mounted recovery procedure. Recentre and mode changes
are allowed only from poses and with trajectories established by the bench
to stay inside that envelope. They are not bypasses: the recorded unguarded
Recentre from a limit pose stalled the motor. A mode change ends the active
gesture and selects that mode's envelope before further rate commands. Show
refusal and its reason; do not report a command as completed merely because
it was accepted on the wire. No absolute pointing command is exposed by this
page.

---

## 9 · The accessory camera — R-CAM-15

Pulled forward from M5. The bench work in `scripts/pocket2/` settled the
protocol: DUML against the published dissector, an AOA session with the board
presenting as the phone, rate control on all axes with stop-when-silent
measured, recentre, attitude with a limit byte. None of it is in `yonder-core`.
This work brings across the session, the command path, aim as a real
capability, the recorder, digital zoom, and the state push. Every command
marked *untried* in §7 is driven and recorded before its control goes live.

---

## 10 · The five defects

1. **A confirmation window arms from the Live deck.** `controls` is exempt in
   `apply/reachability.ts`, so a live control cannot be the cause. Hypothesis
   from review finding S13, unconfirmed: Live and Setup are groups on one page,
   and Setup's `ui-number-input` posts an apply on blur. Settled by the deck: an
   image control posts on a press, never on blur; stream and preview edits
   update the shared draft (§7). The Live deck never enters the apply path.
   **Verified on the board, not assumed.**
2. **Readouts truncate.** The readout row, specified with the widest honest
   value, and the gate measures overflow (§13).
3. **The flash of unstyled content.** The theme moves into the served
   document's head, before any script. R-UI-22.
4. **The picture pane is not the shape of the picture.** §6.
5. **The gate saw neither 2 nor 4.** §13.

---

## 11 · What the config and the model grow

- `CameraCapabilities` — ten new keys; `Capability<T>` gains `gated`, carrying
  the gating control's ID and operator-facing name. Gated and advertised
  descriptors retain the range/menu needed to draw the inoperative control;
  only `present` permits a write. A guard refusal is command state, not a
  rewrite of what the camera offers.
- `CONTROL_MAP` — the new controls, and `pan_absolute`/`tilt_absolute` → `aim`.
- `parseControls` — reads `flags=inactive` **and each offered menu ID/label**.
  Range bounds must never be expanded into presumed menu entries.
- `CameraControls` — a field per control, `null` meaning leave it alone;
  device-native units in config, with explicit display conversions in the
  adapter descriptors. Validate menu membership as well as range/step.
- `CameraOutput.enabled`.
- **New:** `stream.mode`, `stream.floor_kbps`, `stream.ceiling_kbps`;
  `preview.mode`, `preview.size` (`auto` or a rung), `preview.ladder_top`,
  `preview.ladder_bottom`, `preview.floor_kbps`, `preview.ceiling_kbps`.
  Existing camera `bitrate_kbps` and `preview.bitrate_kbps` remain the Fixed
  targets. Preview `width`/`height` migration must resolve into `size`; there
  must not be two independently writable sources of preview dimensions.
- Preview targets and bounds accept 100…4000 kb/s, covering the blueprint's
  4 Mb/s choice; main-stream bounds use the existing 100…20000 kb/s range.
  New configurations default to Stream Fixed and Preview Adaptive; preview
  starts at 300…2000 kb/s, with a retained Fixed target of 400 kb/s and the
  supported ladder's smallest/largest endpoints. Migration preserves an
  existing fixed preview until the operator applies Adaptive. Initially seed
  a stream's adaptive floor and ceiling from its existing fixed target;
  widening that envelope is an explicit draft edit. All defaults must pass
  the same validation as operator settings.
- The published schema regenerated; `docs/configuration.md` updated.

### Apply and reachability — R-NET-07, R-CFG-03

The current blanket exemption for `preview` assumes at most 2000 kb/s.
**Remove it in the same change that introduces the expanded envelope.**
There is no assumption that even 2 Mb/s is safe on every cellular link.

| Change | Application |
|---|---|
| Image controls, including correct display-unit conversion | Explicit live command through the existing controls path; no confirmation window |
| Stream mode, fixed target, floor and ceiling | Shared draft; Apply on Setup through protected configuration, confirmation and rollback |
| Preview mode, fixed target, floor/ceiling, size, ladder endpoints and frame rate | Shared draft; Apply on Setup through protected configuration, confirmation and rollback |
| Source width/height/frame rate/codec | Shared draft; Apply on Setup with the interruption stated; preserve their existing reachability classification unless measurements justify a change |
| Output enabled state, addresses, ports and secrets | Apply on Setup through protected configuration; stopping/starting remains the operator's choice |
| Runtime adaptation inside the applied envelope | No config write or new confirmation; rollback restores the prior envelope and actual runtime policy |
| Viewer Video/Stills/Off and momentary Full rate | Session delivery requests, with cost stated; no persistent policy change or output toggle |

Classify by leaf: an unknown field is load-bearing by default. Tests enumerate
the schema leaves and protect the new preview limits and every policy field,
so a new sibling cannot silently inherit an exemption. Rollback must restore
the running encoder policy as well as the file; access-point fallback and
the confirmation timer retain their existing authority.

---

## 12 · Requirements to add

IDs are stable. Current highest: `R-CTL-10`, `R-UI-20`, `R-VID-15`, `R-CAM-18`,
`K-45`.

| New | Text |
|---|---|
| **R-CTL-11** | Set exposure — the automatic mode, and where the camera allows it the shutter time, the gain and the backlight compensation, each against the bounds the device reports |
| **R-CTL-12** | Set white balance — automatic, or a colour temperature within the device's own range |
| **R-CTL-13** | Set focus — automatic, or a position within the device's own range |
| **R-CTL-14** | Set zoom within the device's own range, and state whether it is optical or a digital crop, and whether it reaches the picture the operator is looking at |
| **R-UI-21** | **A control another setting has charge of stays on the page, drawn inert, naming the setting that has it** in the operator's words. It is not a fault and is not drawn as one |
| **R-UI-22** | **The interface's first paint carries its own theme.** The generated stylesheet is in the document before any script runs |
| **R-UI-23** | **The capture gate photographs readings, not masks.** Every field renders its widest honest specimen, and the gate measures clipped text |
| **R-UI-24** | **An output nothing can reach is drawn as unreachable, and its stream address marked unusable rather than offered.** The console states which of the device's paths can carry it, and does not act |
| **R-UI-25** | **The instrument library is rendered whole, from source, in both palettes, in every state, on every build** |
| **R-UI-26** | **An action lives beside the thing it acts on where that thing is on the page** — Record with Capture, Recentre with Aim. The rail carries the page's own actions. Amends ADR-0009's exclusive rail rule; R-UI-10's size and primary-action limits remain |
| **R-UI-27** | **A camera's name is the operator's.** It defaults to `Cam N`, is edited on the camera's own page, and is shown everywhere the camera is named |
| **R-UI-28** | **The picture and the aim panel work without the deck.** They are shown on the Cockpit, and depend on nothing the camera page draws around them |
| **R-VID-16** | **Start and stop each output independently from the console, and show what each is costing while it runs** |
| **R-VID-17** | **Adapt the preview's size as well as its bitrate**, down a ladder when pinned at the floor and up when there is headroom, within an operator-set top and bottom; a chosen size holds |
| **R-VID-18** | **The picture states what it is** — mode, size, rate, bitrate, and whether it is pinned, held, at full rate or on stills — on itself, and announces a step with its reason |

Amend ADR-0009's Soft keys row and the adjacent explanation in the same
implementation change as R-UI-26. Its current *no action lives anywhere else*
sentence is the conflicting rule; R-UI-10 itself does not require a rail.
The command-expiry and guard work traces to R-CAM-11, R-CMD-04 and R-TEL-15;
shared drafts and rollback to R-CFG-03/R-UI-05; board photos and their file
actions to the existing R-CAM-18. These are not deferred by this spec.

Known issues to file: the confirmation window from the Live deck, the flash of
unstyled content, the pillarboxed pane, the overlay behind the video, the
truncated receive line — `K-46` … `K-50`.

---

## 13 · Testing, and the gate

**Every component has tests; every guard is mutation-checked** — delete it,
watch a named test go red, restore. Five guards on this branch had no coverage
behind a green suite.

**The gallery is the blueprint and the gate captures it** (R-UI-25): every
component, every state, both palettes, notebook and tablet widths. The gate
renders specimens rather than masks (R-UI-23) and fails on clipped text.

**The states the gate must photograph, on a page:** present, not offered,
advertised, gated; adaptive, at the floor, held, full rate, stills; recording,
sent-not-confirmed, no card; an aim that answers and one that does not; one
camera and two.

**Acceptance cases for the reviewed gaps:**

- **Probed values:** the ELP fixture yields only exposure IDs 1 and 3;
  unsupported IDs are rejected. Raw shutter 156 displays as 15600 µs, and
  current/default/bounds/step and a round-trip write use the same conversion.
- **Drafts:** edit bitrate and preview bounds on Live, navigate to Setup and
  back, switch cameras, then Apply or Discard. No blur/navigation applies;
  pending and actual remain distinct. Cover concurrent edits, failed Apply,
  confirmation timeout and runtime-policy rollback.
- **Rates:** Fixed targets, both Adaptive envelopes and ladder endpoints
  remain operator-editable. Exercise invalid bounds, a link below the floor,
  a held size and stale link statistics. Preview bitrate/rung changes leave
  main-stream sequence/timestamps and board recording continuous.
- **Motion:** browser disconnect with USB intact, stopped renewals, late and
  reordered frames, release followed by an old queued frame, reconnect,
  stale attitude, unknown bounds and mode, each limit direction and escape,
  and Recentre/mode refusal from an unsafe pose. Measure the complete stop
  bound from browser intent to observed rest. Mutation-check every guard.
- **Viewers:** two browsers on one camera, one holding Full rate while the
  other watches preview or stills; one viewer switching camera or closing.
  Check independent delivery state and measured total traffic including
  thumbnails and duplicated network delivery, without disabling outputs.
- **Photos:** camera-card capture acknowledgement and failure; an ELP frame
  saved on the board without interrupting video, then viewed, downloaded and
  deleted. Cover no fresh frame, storage reserve and duplicate pending presses.
- **Viewport:** capture the 1440×900 viewport with sidebar and picture/Aim/
  Capture visible, plus a full-page capture proving all controls remain
  reachable. Assert no horizontal overflow, no nested deck scroll and no
  hidden controls in either palette or at tablet widths. A tall full-page PNG
  is not evidence that everything fits above the fold.

**On the board, before the branch is done:** every control in §7 marked
*proven* is moved from the console and its effect seen; the confirmation
window is shown not to arm from Live; the gimbal pans from the console and
stops on release; the picture steps down a rung on a throttled link and says
so.

---

## 14 · How this is staged

One plan, one branch, in phases that are its review checkpoints:

1. **The model** — capabilities, gated, the probe map, the schema, the write
   path, menu metadata and unit conversion, output reachability and protected
   policy fields. `yonder-core` only.
2. **The library and the gallery** — the three clipping fixes; the parts; the
   four nodes; the gallery growing with them. **Shown to the operator before 3.**
3. **The pages and the defects** — both camera pages rebuilt; the five defects;
   shared drafts; the gate moved to specimens; per-camera navigation and the
   strip; ADR-0009 amended for actions beside their objects.
4. **The mechanisms** — runtime encoder control, the rate controller, state
   scoped by camera and viewer, board recording and photos, the stills strip.
5. **The accessory camera** — the session, expiring intent and a common guard
   for all motion commands, aim, the state push decoded, every untried command
   driven under the mounted guard.
6. **The Cockpit surface** — the picture and the aim panel embedded without the
   deck, proven to work there. The Cockpit page itself is M5.

**Exit:** every control the blueprint draws does what it says, on the board,
on both cameras, in both palettes, on the camera page and on the Cockpit.

---

## 15 · Blueprint corrections and remaining evidence

The settled layout and complete control inventory stand. These review
corrections must also reach the blueprint and its README before the capture
gate treats it as the complete reference:

- Correct the ELP shutter's raw-to-µs conversion in **both** mockups; retain
  the actual menu IDs and labels, and do not label uncalibrated zoom as ×.
- Draw the shared pending draft and Setup Apply/Discard flow, Fixed preview
  target, Adaptive stream bounds and Auto-size ladder endpoints (§7).
- Add the ELP Photo fallback and access to board-saved stills (§8.3).
- Use the viewport contract in §5: the current Pocket 2 full-page render is
  about 1361 CSS px tall at 1512 px wide. Do not remove controls or shrink
  readings to preserve the former whole-page, no-scroll claim.
- Distinguish this viewer's delivery from the shared encode and total path
  traffic; the simulated two-encode sum is not production accounting.

The mounted bench run has already resolved **pitch = bit 0, yaw = bit 1**.
Remaining evidence includes standalone work-mode behavior, usable envelopes
and Recentre preconditions for each supported mounting/mode, the untried
controls in §7, camera-card recording/photo confirmation with a card, and the
end-to-end expiry and encoder-continuity cases in §13. Until demonstrated,
these are implementation gates, not claims that the hardware has answered.

The existing implementation plan predates these contracts. Revisit Tasks
11–18 and 22 against this spec and the corrected blueprint; include the
additional mechanism and acceptance work within the same plan.
