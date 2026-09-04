# The console's instrument library, and the camera pages built from it

**Date:** 2026-09-04 · **Revised** 2026-09-04, to the interactive blueprint ·
**Extends** [the camera view design](2026-09-03-camera-view-design.md)

The M4 camera view shipped working and looking like something else. This is the
second pass: the instruments the design needs, the deck they compose into, the
mechanisms that have to exist underneath for every control on the page to do
what it says, and the five defects a person found by pressing buttons on a board.

**The blueprint is the interactive mockup at
[`docs/console/design/instrument-library/`](../../console/design/instrument-library/).**
It is built from the real component code against the real generated theme, in
the console's own shell, and it was settled by looking at it. Where this
document and the blueprint disagree, the blueprint is right and this document
is out of date. §7 enumerates every control it draws, and what must exist for
each to work.

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
| `auto_exposure` | 4 modes | list | |
| `exposure_time_absolute` | 1…10000 | range | **inactive** — auto exposure has it |
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
| **One shutter key** | `○ RECORD` in Video mode, `PHOTO` in Photo mode; `● RECORDING 00:13:47` while it runs. Beneath it, where a recording lands: the camera's card, or this board (R-CAM-17) |
| **Actions beside their object** | Record with Capture; Recentre with Aim. The rail carries `LIVE · SETUP · STREAM ADDRESS`, `APPLY` on Setup, and `FULL RATE`. A deliberate exception to R-UI-10 |
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
| **Camera · Setup** | The same, plus the four bench-only controls, the name, and the outputs table with On/Off | Apply with the confirmation window where a change is load-bearing; never from the Live deck |
| **Cameras** | Camera rows, rejection rows, the board's encode budget and the uplink | Rows open their camera; Detect again; Add by address |
| **Cockpit / mission control** (M5) | **The picture, its state overlay, and the Aim panel** — the deck is not there | The picture and the aim must not depend on the deck for anything. The state overlay is on the picture for this reason |
| **A notebook** | The primary surface. Live fits without scrolling at 1440×900 with the sidebar open | |
| **A tablet, landscape** | Aim drops below the picture at ≤1100 px; groups flow to fewer columns | Everything still reachable with a finger |
| **The capture gate** | Every page above, in both palettes, in every capability state, at notebook and tablet widths | A page that changes shape fails until somebody looks (R-UI-12) |

---

## 6 · The component set

Three Dashboard nodes, and the parts they are built from.

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
| **Aim pad** | One ring, a crosshair, axis labels, a haloed puck; a struck axis for one that will not answer | Drag sets a rate; release stops; pointer capture; stops on cancel and leave |
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

### Stream · to the ground station

| Control | Kind | Model / config | Mechanism | Proven |
|---|---|---|---|---|
| Bitrate mode `Fixed \| Adaptive` | seg | `cameras[].stream.mode` (new) | **The rate controller** (§8.1). Fixed by default | — |
| Bitrate | bar | `bitrate_kbps` (exists) | Encoder reconfigure; restarts the picture; **Apply** on Setup, never on blur | yes |
| Going out | readout | egress measured per output (R-VID-11, exists) | | yes |
| Resolution | pick | `width`/`height`/`framerate` (exist), options from the probe's formats | Pipeline respawn on Apply | yes |
| Live-view resolution (Pocket 2) | fact | `formats` not-offered | | yes — the handlers are stubs |

### Preview · to this browser

| Control | Kind | Model / config | Mechanism | Proven |
|---|---|---|---|---|
| Bitrate mode `Adaptive \| Fixed` | seg | `preview.mode` (new) | The rate controller. Adaptive by default | — |
| Going out | readout | measured | | yes |
| Size `Auto \| 1280×720 \| 854×480 \| 640×360` | pick | `preview.size` (new: `auto` or a rung); ladder bounded by `preview.ladder_top/bottom` (new) | **Resolution stepping** (§8.1): step down when pinned at the floor, up when there is headroom. A chosen rung holds | — |
| Rate | pick | `preview.framerate` (exists) | Reconfigure | yes |
| Floor · Ceiling | pick | `preview.floor_kbps`, `preview.ceiling_kbps` (new) | Bounds for the controller; shown only in Adaptive | — |
| `FULL RATE` (rail) | hold key | exists (R-VID-13) | Full-quality stream while held; cost stated | yes |

### Exposure · Colour · Optics · Rendering — the ELP

Each is one V4L2 control, probed by `CONTROL_MAP`, written by
`CONTROL_NAMES`, live on the running stream, never a respawn, never the apply
window (`controls` is exempt). All proven — the bench lists every one.

| Control | Kind | V4L2 | Gates |
|---|---|---|---|
| Auto exposure `Auto \| Manual` | seg | `auto_exposure` | shutter |
| Shutter (µs) | bar | `exposure_time_absolute` | gated by auto exposure |
| Gain · Backlight | bar | `gain` · `backlight_compensation` | |
| White balance `Auto \| Manual` | seg | `white_balance_automatic` | temperature |
| Temperature (K) | bar | `white_balance_temperature` | gated |
| Brightness · Contrast | bar | `brightness` · `contrast` | |
| Focus `Auto \| Manual` | seg | `focus_automatic_continuous` | focus |
| Focus | bar | `focus_absolute` | gated |
| Zoom (×) | bar | `zoom_absolute` | |
| Gamma · Sharpness · Saturation · Hue | bar | as named | |
| Mains frequency — *Setup only* | pick | `power_line_frequency` | |

Model: `CameraCapabilities` gains ten keys; `CameraControls` gains their
fields, `null` meaning *leave the camera alone*; `flags=inactive` becomes the
gated state carrying the gating control's operator-facing name.

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
| The pad, and drag on the picture | rate | `gimbal/0x0C`, flags `0x80`, streamed at ≥2 Hz while pushed, nothing when released; **a lost link stops the gimbal inside half a second, for free** | yes |
| Reported position, against bounds | gauge | `gimbal/0x05` push at 20 Hz | yes |
| At the limit | annunciator | byte 10 of the push (R-TEL-15) | yes — yaw stop, both ends |
| Gimbal mode `Follow \| Tilt lock \| FPV` | seg | `gimbal/0x44`; mode byte in `0x4C` | mode byte proven as part of recentre; standalone **untried** |
| Recentre gimbal | key | `gimbal/0x4C` `02 01` | yes |
| Roll — struck | state | no answer on the third axis | the mockup's drawing; the bench has one axis-by-axis run left |
| **Clamp before sending** | rule | the daemon never commands an absolute angle outside the reachable window; the bench saw the head go over the top when asked to | yes — and it is a rule, not a feature |

On the ELP the whole panel is drawn dead, in the caution tone, with the reason,
because it advertises pan and tilt and has no motor.

### Capture destination

| | Mechanism | Proven |
|---|---|---|
| *to the camera's card* | the camera's own recorder | acknowledged; no card on the bench |
| *to this board* | **Board recording** (§8.3, R-CAM-17): a bounded file on the board's card, `R-STO-06` | **unbuilt** |
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
| `REC 00:13:47` | the state push |
| The thumbnail strip: the others as *Still · 4 s*, and *Downlink now* | R-VID-14's stills mechanism, one per non-active camera; the cost is the sum |

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
stream. Rules: never outside floor and ceiling; the stream comes first when
both cannot fit; step the preview's size down one rung when the bitrate has
been pinned at the floor, and up one rung when there has been headroom — with
hysteresis, so it does not hunt. A held size never steps. Fixed mode does
nothing. **It reports every change**: that is the message the picture wears.

### 8.2 The preview-state message — R-VID-18

One message, published whenever it changes, carrying: mode, size, rate,
bitrate going out, floor, ceiling, pinned, held, full-rate, stills with their
interval, and the last step with its reason. The picture draws it; nothing else
computes it.

### 8.3 Board recording — R-CAM-17, R-STO-06

A camera with no recorder of its own records to this board: a bounded file,
the free space stated, and the same shutter key. The line under the key says
where.

### 8.4 Output reachability — R-UI-24

`outputReach(kind, paths)` in `yonder-core`, from the device's live paths. It
returns a sentence and never an action.

### 8.5 The camera state push — decoded

`camera/0x80`, `0x81`, `0x87`, `0x88` arrive at 10–20 Hz and are not yet
decoded. Battery, card, mode and record time come from them; the readouts and
the REC pill wait on this.

### 8.6 The stills fallback, per camera — R-VID-14

Exists in design for one picture; the strip needs one per non-active camera at
a stated interval, and their cost summed into *Downlink now*.

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
   and Setup's `ui-number-input` posts an apply on blur. Settled by the deck: a
   control posts on a press, never on blur, and the Live deck never enters the
   apply path. **Verified on the board, not assumed.**
2. **Readouts truncate.** The readout row, specified with the widest honest
   value, and the gate measures overflow (§13).
3. **The flash of unstyled content.** The theme moves into the served
   document's head, before any script. R-UI-22.
4. **The picture pane is not the shape of the picture.** §6.
5. **The gate saw neither 2 nor 4.** §13.

---

## 11 · What the config and the model grow

- `CameraCapabilities` — ten new keys; `Capability<T>` gains `gated`, carrying
  the gating control's name.
- `CONTROL_MAP` — the new controls, and `pan_absolute`/`tilt_absolute` → `aim`.
- `parseControls` — reads `flags=inactive`.
- `CameraControls` — a field per control, `null` meaning leave it alone.
- `CameraOutput.enabled`.
- **New:** `stream.mode`; `preview.mode`, `preview.size` (`auto` or a rung),
  `preview.ladder_top`, `preview.ladder_bottom`, `preview.floor_kbps`,
  `preview.ceiling_kbps`.
- The published schema regenerated; `docs/configuration.md` updated.

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
| **R-UI-26** | **An action lives beside the thing it acts on where that thing is on the page** — Record with Capture, Recentre with Aim. The rail carries the page's own actions. Amends R-UI-10 |
| **R-UI-27** | **A camera's name is the operator's.** It defaults to `Cam N`, is edited on the camera's own page, and is shown everywhere the camera is named |
| **R-UI-28** | **The picture and the aim panel work without the deck.** They are shown on the Cockpit, and depend on nothing the camera page draws around them |
| **R-VID-16** | **Start and stop each output independently from the console, and show what each is costing while it runs** |
| **R-VID-17** | **Adapt the preview's size as well as its bitrate**, down a ladder when pinned at the floor and up when there is headroom, within an operator-set top and bottom; a chosen size holds |
| **R-VID-18** | **The picture states what it is** — mode, size, rate, bitrate, and whether it is pinned, held, at full rate or on stills — on itself, and announces a step with its reason |

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

**On the board, before the branch is done:** every control in §7 marked
*proven* is moved from the console and its effect seen; the confirmation
window is shown not to arm from Live; the gimbal pans from the console and
stops on release; the picture steps down a rung on a throttled link and says
so.

---

## 14 · How this is staged

One plan, one branch, in phases that are its review checkpoints:

1. **The model** — capabilities, gated, the probe map, the schema, the write
   path, output reachability. `yonder-core` only.
2. **The library and the gallery** — the three clipping fixes; the parts; the
   four nodes; the gallery growing with them. **Shown to the operator before 3.**
3. **The pages and the defects** — both camera pages rebuilt; the five defects;
   the gate moved to specimens; per-camera navigation and the strip.
4. **The mechanisms** — the rate controller, the preview-state message, board
   recording, the stills strip.
5. **The accessory camera** — the session, the command path, aim, the state
   push decoded, every untried command driven.
6. **The Cockpit surface** — the picture and the aim panel embedded without the
   deck, proven to work there. The Cockpit page itself is M5.

**Exit:** every control the blueprint draws does what it says, on the board,
on both cameras, in both palettes, on the camera page and on the Cockpit.

---

## 15 · Open

Nothing outstanding in the design. Two things the bench still owes: which limit
bit is which axis, and the standalone gimbal work-mode command.
