# The console's instrument library, and the camera pages built from it

**Date:** 2026-09-04 · **Supersedes nothing** · **Extends**
[the camera view design](2026-09-03-camera-view-design.md)

The M4 camera view shipped working and looking like something else. This is the
second pass: the instruments the design needs, the deck they compose into, and
the five defects a person found by pressing buttons on a board.

---

## 1 · What is actually wrong, measured

Read on the development board with a live camera, not inferred from a capture.

**Eleven of the twenty-three widgets on the two camera pages are stock
Dashboard controls** — two sliders, three number inputs, two tables, four text
widgets. ADR-0009 exists to prevent exactly that.

The Live deck's `APPLIES LIVE` group is **two Vuetify sliders carrying no value
at all.** Not a bare number against its bounds, which R-UI-09 forbids — no
number. The driver's real ranges are brightness −64…64 and contrast 0…95, so a
handle position is not interpretable even in principle. Roughly 60% of the
panel is empty.

`NO CONTROL FOR THESE` carries eight rows, **four of which are the page
confessing rather than camera facts.** Zoom, focus, exposure and white balance
each read *"offered, not on this page"* while the device reports all four with
real ranges. That sentence is a fourth capability state the design does not
have, and it means *unfinished*.

**The picture is pillarboxed.** 726 px of video inside a 1230 px pane at a
desktop width — about 250 px of dead black on each side. **Its own overlay is
drawn behind it:** the cost line is legible over the black margin and
disappears where the video begins.

**The console paints in stock white Vuetify before the theme arrives.** Caught
on the board: the first frame after a reload is a white admin panel with
sentence-case group titles, the second is Yonder. The cause is at
`flows/flows.json:320` — the theme is an `@import` inside a Dashboard
`site:style` template, so the browser must boot Dashboard's JavaScript before
the style exists at all, then fetch the stylesheet as a second request.

**Setup is `ui-text` pairs with enormous gaps** — camera name, device identity
and encoder spread down some 500 px where a readout row would take sixty.
`RESTARTS THE PICTURE` carries about 300 px of dead space beneath its two
inputs. A line of fine print renders as large right-aligned bold.

**Truncation, found:** the GStreamer receive line ends `…encoding-name=H264,payloa…`.

### The root cause, so the plan does not repeat it

The M4 spec described the deck's *behaviour* — three legends, which control
applies live — and never said *"every control is an instrument, and here is the
list."* The plan inherited the gap and filled it with what Dashboard shipped.

Underneath that sits a structural cause the plan could not have argued its way
out of. **Dashboard's grid makes every widget occupy whole rows** (ADR-0009,
context 3). Twelve controls wired as twelve widgets cannot be a three-column
deck; they are twelve slabs. The implementer reached for stock widgets partly
because the layout model left nowhere else to go.

---

## 2 · What the device actually offers

The bench camera is a global-shutter USB camera. `v4l2-ctl --list-ctrls`
returns **eighteen** controls, against the eleven `CAPABILITY_KEYS` models and
the three `config.yaml` carries.

| Control | Range | Kind | Note |
|---|---|---|---|
| `auto_exposure` | 4 modes | list | now *Aperture Priority* |
| `exposure_time_absolute` | 1…10000 | range | **inactive** — auto exposure has it |
| `gain` | 0…1023 | range | the other half of exposure |
| `backlight_compensation` | 36…160 | range | ground against sky |
| `white_balance_automatic` | on/off | switch | |
| `white_balance_temperature` | 2800…6500 | range | **inactive** — auto has it |
| `focus_automatic_continuous` | on/off | switch | |
| `focus_absolute` | 0…1023 | range | **inactive** — autofocus has it |
| `zoom_absolute` | 0…60 | range | digital crop |
| `brightness` | −64…64 | range | |
| `contrast` | 0…95 | range | |
| `gamma` | 64…300 | range | midtones |
| `sharpness` | 0…7 | range | over-sharpening wastes bitrate |
| `saturation` | 0…255 | range | |
| `hue` | ±2000 | range | |
| `power_line_frequency` | 3 modes | list | indoor flicker |
| `pan_absolute` | ±648000 step 3600 | range | **advertised. There is no motor.** |
| `tilt_absolute` | ±648000 step 3600 | range | **advertised. There is no motor.** |

Three consequences decide much of this document.

**The bench can exercise the whole component set today.** Two real menus for
the picker, two real switches for the segmented control, ten real ranges with
real bounds and steps for the set bar. Nothing has to be faked to see a
component work.

**The advertised-but-not-answered state is provable on this desk.** The camera
claims a ±180° pan and tilt range it has no motor for, accepts the write, and
does not move. `CONTROL_MAP` in `video/probe/camera.ts:143` has no
`pan_absolute` entry, which is why the Cameras page currently reports
`aim: none` for a camera that advertises aim. Adding the mapping produces the
state the M4 spec calls *the one most likely to be got wrong in code*, on
hardware, for free.

**There is a state nothing has drawn.** `flags=inactive` is none of the three.
Shutter time is real, settable and in range — but only once auto exposure is
off. A control that another control has taken charge of is not absent, not
advertised-and-lying, and not simply present. It needs its own drawing.

---

## 3 · Decisions taken in this session

| | |
|---|---|
| **Scope** | Both camera pages, plus the five defects seen on the board |
| **The deck** | Drawn as one piece, composing itself from the capability report — not one framework row per control |
| **Continuous values** | A **set bar**: one track, two marks — where the camera is, and what was asked for |
| **How many controls** | All sixteen live ones — the eighteen of §2 less pan and tilt, which have no motor. Omitting a control the camera offers only moves the *"not on this page"* lie |
| **Where they live** | The flying set on Live; **every** control on Setup, grouped |
| **The Pocket 2** | R-CAM-15 pulled forward out of M5 — the accessory camera arrives with this work |
| **Aim** | Built and proven against the DJI Pocket 2, which is in hand |
| **Outputs** | An **Outputs group**: every output with its state, its cost and its reachability, each with an On/Off beside it |
| **An unreachable output** | The console **says so and does not act.** Stopping it is the operator's press |

### What "the flying set" means

**Live** carries what is reached for with an aircraft up: auto exposure and
shutter, gain, backlight compensation, auto white balance and temperature,
zoom, and — where the camera has them — aim and record. **Setup** carries every
control the device reports, grouped as *exposure · colour · rendering · optics ·
housekeeping*. A control on both pages is one value shown twice, never two.

---

## 4 · The four states a capability can be in

The M4 spec settled three. The board found a fourth.

| State | Meaning | How it draws |
|---|---|---|
| **Present** | The device answered and the control works | The control, live |
| **Not offered** | The device does not have it | A stated fact where the control would have been. One row of text. Never a control that cannot be used, and never silently nothing |
| **Advertised, not answered** | It lists it, accepts the command, does nothing | The control stays, drawn inoperative in the caution tone, **carrying the reason** |
| **Gated** *(new)* | Real and in range, but another control has charge of it | The control stays, drawn inert in the neutral tone, **naming the control that has it** — *"while auto exposure is on"*. Turning that control off makes this one live |

**Gated is not a fault and must not look like one.** Advertised-not-answered is
something misreporting itself and its whole job is to be noticed, so it is
drawn in caution. Gated is the camera working correctly — an operator chose
automatic — so it is neutral, and it carries the way back rather than a
complaint. Drawing them alike would spend the caution tone on a normal
condition, which is how an operator learns to stop reading it.

`R-UI-21` is added for this state. `R-UI-20` is unchanged.

**The soft-key rail remains the exception**: it carries only actions that can
be taken.

---

## 5 · The component set

Two new Dashboard nodes, one reworked, and the parts they are built from.

### 5.1 The deck — `ui-yonder-deck`

One node per group. It receives the camera's capability report and its current
values, and draws its own columns. **Which controls exist is decided by the
report, not by wiring.**

This is the piece that makes the rest possible, and it is the fix for the root
cause rather than a workaround for it:

- Three columns on a desk, two on a tablet, one on a phone — rewrapped, never
  rearranged, so there is one page to design and one page for the gate to
  photograph (layout B, `page-anatomy-v2.html`).
- The four capability states are expressible, because the deck decides what to
  draw. Static wiring cannot express *"this row is a fact on that camera and a
  control on this one."*
- **There is no group left for a stock widget to be dropped into.** The next
  implementer under time pressure cannot repeat this.

Props: the capability report, the current values, the column grouping, and
which of Live or Setup it is. It emits one action per control change. It
computes nothing about what a value *means* — bands come from `reading()` in
`yonder-core`, as `YonderGauge` already does.

### 5.2 The camera index — `ui-yonder-index`

One node for the Cameras page, replacing two `ui-table`s.

- A **camera row**: thumbnail, name and bus, one line of what the probe got
  back, a state annunciator with its rate, and a chevron to that camera's page.
- A **rejection row**: device path, card, and the reason in a sentence.
- Beneath, the two engine bars the mockup draws — encoding used on this board,
  and uplink across all cameras — both of which `YonderGauge` and
  `YonderBudget` already provide.

`cameras-index-day-v2.html` is the target. This is not a table: a table gives
every column equal weight, and on this page one column is a camera and one is
the reason a device was refused.

### 5.3 The picture — `ui-yonder-picture`, reworked

Additions:

- **Overlays**, in front of the video and never behind it: the `REC` pill, the
  corner box (`LINK` / `DROP`, or `SLEW` / `TILT` while aiming), the foot strip
  (`ZOOM · TILT · EV`), the hint line, and the stills countdown ring.
- **The pane is the shape of the picture.** It takes the video's aspect ratio
  and stops. The dead band is not styling — it is a pane sized to a container
  rather than to its contents.
- **A drag layer** for aim: drag sets a *rate*, release stops. Absolute
  pointing is rejected — `aim-and-bitrate.html` records why, and 300 ms of lag
  is the reason.

### 5.4 The parts inside them

Vue components with their own tests, not separately registered Dashboard
nodes. ADR-0009 requires instruments to be components; it does not require
every component to be a node.

| Part | For | Rules |
|---|---|---|
| **Picker** | One value from what the device answered — resolution, codec, bitrate, mains frequency, exposure mode | Options come from the probe, never a stored list (R-CAM-14). Carries all four states |
| **Segmented control** | Two or three exclusive choices — `Fixed \| Adaptive`, `Normal \| Mono \| Sat`, `Live \| Stills \| Off`, an auto switch | **A maximum width. It never stretches to its container** — the same rule ADR-0009 gives the engine bar's track |
| **Set bar** | A bounded continuous value — shutter, gain, backlight, brightness, contrast, gamma, sharpness, saturation, hue, zoom, focus, white-balance temperature | One track. Two marks: **where the device is**, and **what was commanded**. Drag or tap to set; steps by the driver's own step. Fixed width. This is also the bitrate bar, so *commanded versus actual* has one shape everywhere |
| **Readout row** | Label, value, unit, stacked vertically inside a column | Tabular figures. **A unit is never uppercased** — `Mb/s`, not `MB/S`, which would say megabytes. Carries an optional fine-print line beneath |
| **Column** | A titled group inside the deck | Legend in letterspaced caps, with an optional right-hand qualifier — *"rate"*, *"measured 3.2 Mb/s"*, *"restarts the picture"* |
| **Placard** | The panel header — `CAMERA · NOSE` and `USB · H.264 · 1920×1080P30` | Panel chrome, above the display |
| **Aim dial** | Pan and tilt | White mark where the gimbal is, cyan where it is being pushed. An axis that will not answer stays on the dial, struck and labelled, so a gimbal that half works is not read as one that does |

### 5.5 The Outputs group

The mockups draw outputs as a **readout** on the flying page — `RTSP — no
client`, `SRT — off` in `uplink-budget-v2.html`, `RTSP :8554/nose` as a fact
under the picture — and as a picker buried in Setup. **There is no way to stop
an output with the aircraft up.** That is a gap in the design and not only in
the build.

The Outputs group closes it. Every output, on both decks, carries four things
on one row: **what it is**, **its state**, **what it is costing right now**,
and **whether anything can reach it** — with an On/Off beside it. The state and
the cost sit together because the cost is the argument for the press.

**Outputs divide by direction, and the console has never said so.**

| Output | Direction | Over bare cellular | Over the mesh |
|---|---|---|---|
| **Ground station** — `rtp`, a `udpsink` | Outbound; the board dials out | **Works.** This is the flight path | Works |
| **RTSP** | Inbound listener | **Cannot work.** Nothing can dial in | Works |
| **SRT** | Inbound listener | **Cannot work** | Works |

`schema/config.ts:278` already records the fact — *"`rtsp` and `srt` are
listeners on this device"* — and nothing on the page uses it. Behind carrier
NAT nothing can dial in, so the console today prints a receive line the
operator cannot use, for a stream nothing can reach, on the link where bytes
are the scarce thing. Over ZeroTier the same output works, because the mesh
gives the board an address a peer can reach — which M2a proved on hardware.

So the sentence is per **path**, not per output, and the device already knows
which paths it has.

**The console says so and does not act** (R-CMD-04, and rule 4 of this
project). An unreachable output stays configured and drawn, carrying a plain
sentence — *nothing can reach this over cellular; it works on the mesh* — and
its receive line is marked unusable rather than offered as though it worked.
Yonder does not stop it: an operator may have a mesh coming up or be about to
land, and a device that turns an output off on its own is the aircraft
deciding.

### 5.6 What already exists and is right

`YonderGauge` is the zoned engine bar with a fixed track. `YonderDataBar` is
the horizontal label/value strip under the picture. `YonderAnnunciator`,
`YonderSoftKeys`, `YonderHoldKey`, `YonderBudget`, `YonderFacts`,
`YonderIdentity`, `YonderTape` and `YonderSparkline` stand unchanged. The set
bar shares its track geometry with `YonderGauge` rather than inventing a
second one.

---

## 6 · The accessory camera — R-CAM-15

Pulled forward from M5 because the gimbal is in hand and because a component
nothing can exercise is how `YonderPicture` and the SRT output both shipped
broken.

The bench work in `scripts/pocket2/` has already settled the protocol: DUML
encode and decode against the published dissector, an AOA session with the
board presenting as the phone, **rate** control confirmed on all axes with its
stop-when-silent behaviour measured, recentre, and attitude returning
pitch/roll/yaw with a limit byte. What does not exist is any of it inside
`yonder-core`.

This work brings across:

- An accessory camera source: the AOA session, the picture, and the command
  path on the same link.
- Aim as a real capability — rate commands out, attitude back, the limit byte
  surfacing as the annunciator R-TEL-15 asks for.
- Its own recorder and digital zoom as capabilities.

**This is a large piece of work with its own failure modes**, which is why §12
gives it its own plan rather than folding it into the widget rewrite.

---

## 7 · The five defects

**1 · A confirmation window arms from the Live deck.** `controls` is in
`CAMERA_EXEMPT_LEAVES` (`apply/reachability.ts:63`), so a live control cannot
be the cause. The leading hypothesis, to be confirmed and not assumed: Live and
Setup are groups on **one** Dashboard page, so Setup's `Bitrate (kb/s)`
`ui-number-input` is on screen while the Live deck is in use, and review
finding S13 records that it posts an apply on blur. While pending, `BUSY`
refuses every other apply for two minutes — a network change included, which on
a flying aircraft is the wrong thing to be locked out of.

Settled by the deck: a control posts on an explicit press, never on blur, and
the Live deck's controls never enter the apply path at all.

**2 · Readouts truncate.** Replaced by the readout row, which is specified with
the widest value each field can honestly hold, and measured by the gate (§11).

**3 · The flash of unstyled content.** The theme moves from an `@import` inside
a Dashboard `site:style` template into a plain `<link>` in the served document,
before any script runs. Two serialised delays become none.

**4 · The picture pane is not the shape of the picture.** §5.3.

**5 · The capture gate saw neither 2 nor 4.** §11.

---

## 8 · What the config and the model have to grow

Presentation is the smaller half. Before a control can be drawn it must be
modelled, stored, probed and written.

- **`CameraCapabilities`** — `CAPABILITY_KEYS` carries eleven. It needs gain,
  backlight compensation, gamma, sharpness, saturation, hue, mains frequency,
  and the auto switches for exposure, white balance and focus.
- **`CONTROL_MAP`** (`video/probe/camera.ts:143`) — seven entries. It needs the
  new controls, and `pan_absolute`/`tilt_absolute` → `aim`, which is what makes
  the advertised state real on the bench.
- **`flags=inactive`** — parsed today and discarded. It becomes the *gated*
  state, carrying the name of the control that has charge.
- **`config.yaml`** — `CameraControls` (`schema/config.ts:326`) carries
  `brightness`, `contrast`, `rotation`. Every other control needs a field, a
  bound, and a null default meaning *leave the camera alone*.
- **`video/controls.ts`** — the write path, whose `CONTROL_NAMES` is
  cross-checked against `CONTROL_MAP` by an existing test. That check must keep
  holding across the additions.
- **`CameraOutput`** (`schema/config.ts:296`) — an output is on because it is
  in the array. Stopping one by deleting it would throw away its port, path and
  secret, so each output gains `enabled`, defaulting true, and a stopped output
  keeps everything that made it work. The reachability sentence is derived from
  the device's live paths, never stored.

---

## 9 · Requirements to add

IDs are stable and never renumbered. Current highest: `R-CTL-10`, `R-UI-20`,
`R-VID-15`, `R-CAM-18`, `K-45`.

| New | Text |
|---|---|
| **R-CTL-11** | Set exposure — the automatic mode, and where the camera allows it the shutter time, the gain and the backlight compensation, each against the bounds the device reports |
| **R-CTL-12** | Set white balance — automatic, or a colour temperature within the device's own range |
| **R-CTL-13** | Set focus — automatic, or a position within the device's own range |
| **R-CTL-14** | Set zoom within the device's own range, and state whether it is optical or a digital crop |
| **R-UI-21** | **A control another setting has charge of stays on the page, drawn inert, naming the setting that has it.** It is not a fault and is not drawn as one: the caution tone belongs to a capability that misreports itself, and spending it on a camera behaving correctly is how an operator learns to stop reading it |
| **R-UI-22** | **The interface's first paint carries its own theme.** The generated stylesheet is in the document before any script runs, so no palette but Yonder's is ever drawn |
| **R-UI-23** | **The capture gate photographs readings, not masks.** Every field renders a fixed specimen — the widest value it can honestly hold — so a reading that does not fit its field changes the page's shape and fails the build |
| **R-UI-25** | **The instrument library is rendered whole, from source, in both palettes, on every build.** Every component in every state on one captured page, so a gap in the set is visible before a page is built from it and a component that changes shape fails the build |
| **R-VID-16** | **Start and stop each output independently from the console, and show what each one is costing while it runs.** An output is stopped where its cost is stated, because the cost is the reason to stop it |
| **R-UI-24** | **An output nothing can reach is drawn as unreachable, and its receive line is marked unusable rather than offered.** The console states which of the device's current paths can carry an output — an inbound listener works on the mesh and never behind carrier NAT — and **it does not act on it**: stopping an output is the operator's press (R-CMD-04) |

Known issues to file for what was observed: the confirmation window arming from
the Live deck, the flash of unstyled content, the pillarboxed picture pane, the
overlay drawn behind the video, and the truncated receive line — `K-46` … `K-50`.

---

## 10 · The rules this work is held to

- **Logic and presentation live in node packages.** No `function` node, no
  markup in a `ui-template`. `flows/` is wiring only. Review finding S11 shows
  `flows.test.ts` enforces the behaviour half and not the presentation half —
  a `ui-template` carrying markup passes 80 of 80 today. This work closes that:
  the only permitted `ui-template` is `style-link`, and after R-UI-22 there may
  be none at all.
- **Both palettes.** Every component reads `var(--yonder-*, fallback)`. No
  hard-coded colour, anywhere.
- **A unit is never uppercased.** `Mb/s`, not `MB/S`.
- **`emitsActions` is load-bearing.** Dashboard silently drops a
  `widget-action` from a widget that did not register `onAction` — every soft
  key once shipped dead this way, with no error anywhere. Every control the
  deck and the index emit through is covered by a test that presses it.
- **No credential in a committed capture** (R-SEC-10). The receive line renders
  the stream password on screen, correctly; the gate must mask it and the plan
  verifies that it does.
- **The repository is self-contained.** No board address in a committed file.

---

## 11 · Testing, and the gate

**Every component has tests.** `holdkey.component.test.ts` is the worked
example; the harness — DOM environment, `@vitejs/plugin-vue`,
`@vue/test-utils` — already exists.

**Every guard is mutation-checked.** On this branch five separate guards turned
out to have no coverage behind a fully green suite. For each guard: delete it,
confirm a test goes red, restore it. A guard that stays green when deleted is
not a guard.

**The capture gate renders specimens rather than masks.** Today it covers live
readings with grey rectangles and checks geometry, so a clipped value is
invisible to it — underneath the rectangle. Instead each field renders a fixed,
deliberately awkward specimen: `1280 × 720 · 30 fps`, `5.17 Mb/s at I-frame`,
`−180.0°`, `2800 K`. The photographs stay identical build to build because the
values never change, so the gate works exactly as it does now — but a field too
narrow for its own contents shows up in the photograph. It also forces the
question *how wide must this field be* to be answered once, in writing, rather
than on a board.

**The states the gate must photograph.** Present, not offered, advertised, and
gated, on one page, in both palettes — because the four are a page's most
likely defect and the only one no unit test can see.

---

## 12 · The gallery

**A page that mounts every component, in every state, in both palettes, built
from the real sources against the real generated `theme.css`.** It is a
deliverable of this work and not a side-effect, for a reason the M4 build
demonstrates: a component library nobody can look at whole is a library whose
gaps are invisible until a page is built from it and somebody says *that isn't
what we drew*. The absence of a picker would have been obvious on one screen.

It earned that place before this document was finished. A first cut, built to
settle the layout, found four defects standing alone — with no page, no
Node-RED and no board:

| Found in the gallery | What it is |
|---|---|
| `1280 × …`, `3000 kb…`, and two cells past the edge | **`YonderDataBar` truncates in the component**, not because a page was narrow. This is the observed defect, reproduced in isolation |
| The soft-key rail runs off its own edge | Six keys do not fit and the rail neither wraps nor scrolls; three keys were simply not drawn |
| `IN USE0.0 of 3.2 Mb/s` | `YonderBudget` has no space between label and value |
| `3Mb/s`, `0×` | A leading space inside a tag is collapsed. Written and caught within the minute, because it was rendered beside eleven other things |

Requirements: it renders from `src/`, never from a built bundle, so it cannot
show something the package does not contain. It carries the four capability
states for every control. It is captured by the gate in both palettes, so a
component that changes shape fails the build the same way a page does.

## 13 · How this is staged

**One plan, one branch.** The three parts below are its phases and its review
checkpoints, not separate branches.

**Phase 1 — the model.** `CameraCapabilities`, `CONTROL_MAP` (including
`pan_absolute`/`tilt_absolute` → `aim`), the `inactive` flag becoming the gated
state, `CameraControls`, `CameraOutput.enabled`, and the write path. All in
`yonder-core`, all tested, all mutation-checked. Nothing is drawn yet.

**Phase 2 — the library and the gallery.** Picker, segmented control, set bar,
readout row, column, placard, aim dial. Then `ui-yonder-deck` and
`ui-yonder-index`. The gallery grows with them and is the review surface at
this checkpoint.

**Phase 3 — the pages, the defects and the accessory camera.** Both camera
pages rebuilt. The Outputs group. The picture reworked — overlays, aspect,
z-order. The five defects. The gate moved to specimens. Then R-CAM-15: the AOA
source, the DUML command path, aim as a real capability, the recorder and
digital zoom, with the dial and the drag layer wired to a gimbal that moves.

**Exit:** the Live deck carries every flying control the bench camera offers,
states the two it advertises and cannot honour, stops an output on a press, and
pans the Pocket 2 — seen on the board, in both palettes.

---

## 14 · Open

**Whether the deck should be one node or one per group per camera.** Layout B
draws one deck; a multi-camera page may want one per camera. Deferred to M6
rather than guessed at now.

**Nothing else.** The visual questions were settled by the mockups, and the
material ones by the board.
