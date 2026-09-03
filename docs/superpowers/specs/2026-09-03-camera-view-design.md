# The camera view — design

**Milestone:** M4, extending into M5 and M6 · **Date:** 2026-09-03 · **Status:** agreed, not yet planned

M4 puts one USB camera on a page. M5 adds a camera that is itself a USB host, with a gimbal
on the same link. M6 adds a second camera and a second capture stack. Three milestones, and
the temptation at each is to give that milestone's camera its own page with its own
controls — because each camera really does behave differently.

This document settles that they do not get their own pages. There is **one camera view**,
generated from what each camera answers about itself, and this is what it holds, how its
controls behave, what it does when the link degrades, and where it lands in the console.

Every cited number was measured on hardware, and the citation is the note it came from:
[`usb-camera-on-a-pi-4.md`](../../hardware/usb-camera-on-a-pi-4.md) for the pipeline,
[`dji-pocket-2-over-usb.md`](../../hardware/dji-pocket-2-over-usb.md) for the accessory
camera and its gimbal. Where a figure has no citation it is a placeholder for a
measurement not yet taken, and is marked as one.

---

## 1. One camera object, not one page per kind of camera

### The problem

A page per kind of camera is not a layout choice, it is a data model leaking onto the
screen. It happens when the software has a USB flow, a CSI flow and an accessory flow
rather than a camera, and the symptom is that the same control acquires a different name,
a different position and a different unit on each page.

The cameras in the compatibility list really are different:

| | Live picture | Aim | Zoom | Records |
|---|---|---|---|---|
| USB UVC | MJPEG, decoded and re-encoded by the board | none | none | board only |
| CSI | raw, encoded by the board | none | none | board only |
| HDMI via a CSI bridge | raw, after an EDID push | none | none | board only |
| Accessory camera (R-CAM-15) | 720p H.264, fixed, ~8 Mb/s | pan and tilt, by rate | digital, cropped by the receiver | its own card |

Nothing in that table is a *kind of page*. Every row is a different set of answers to the
same four questions.

### Decision

**A camera is an identity, a source, and a capability set read from the device.** The page
is generated from the capability set. R-CAM-14 already requires the set to be built from
what the device answers rather than from a stored list; this extends that from *what
formats it offers* to *what controls the page draws*.

The consequence that matters: a zoom control looks and behaves identically whether it is a
sensor crop, a UVC control, or a protocol message answered by cropping at the receiver.
Three implementations, one control, one name, one unit.

### The three states a capability can be in

R-CAM-14 names *present* and *advertised, not answered*. The middle row is settled here —
and named *not offered* rather than *absent*, because R-CAM-14's own text uses *absent* for
the third state, and one word with two meanings across two documents is how this gets
implemented wrong.

| State | Meaning | How it draws |
|---|---|---|
| **Present** | The device answered and the control works | The control, live |
| **Not offered** | The device does not have it | **A stated fact where the control would have been.** One row of text. Never a control that cannot be used, and never silently nothing |
| **Advertised, not answered** | The device lists it, accepts the command, and does nothing | The control stays, drawn inoperative, **carrying the reason** |

**Nothing is ever silently missing** (R-UI-15). An operator must be able to tell *this
camera cannot* from *this page failed*, and an empty space says nothing about which.

Not offered is a fact rather than a dead control for two reasons. A dead control takes the room
of a control and carries the information of a label — on a fixed camera that is a dead aim
dial, a dead zoom picker, dead focus and a dead record key, which pushes the live controls
off a tablet. And it teaches an operator to stop reading muted styling, which then costs
us the *advertised-but-not-answered* state, whose whole job is to be noticed.

The soft-key rail is the exception: it carries only actions that can be taken. A camera
that cannot record has no Record key, and the fact that it cannot is stated in the deck.

**Advertised-but-not-answered is a fault, not a feature the camera lacks**, and is drawn in the caution
tone rather than the neutral one. Something is misreporting itself, and a firmware or
kernel change may make it work. It is the state most likely to be got wrong in code,
because on the wire it is indistinguishable from success — the accessory camera's
live-view resolution was tried at fifteen values across three payload widths and every one
was acknowledged while the frame stayed 1280×720.

---

## 2. The page

### What it is for

**A setup and monitoring page.** You use it on the ground to point, frame and tune a
camera, and it stays useful in flight as the place to change one thing. The live picture is
on it so that every control's effect is visible immediately. It is not the flying view;
the Cockpit is, and it is designed separately.

The view is built as a component with a compact form, so the Cockpit can embed it later
without a second implementation. The compact form keeps the picture, the aim gesture, the
camera strip and the degrade behaviour, and drops the control deck.

### Anatomy

Picture across the top, a readout strip under it, a control deck below that, and the
soft-key rail at the foot.

The picture is on top rather than beside the controls because that arrangement is the same
at every width: three deck columns on a desk, two on a tablet, one on a phone. Nothing is
rearranged and nothing is hidden — the columns wrap and the rail wraps with them, so there
is one page to design and one page for the capture gate to photograph. A right-hand
control rail would have to become this layout at tablet widths anyway, leaving two
arrangements of one page to maintain.

**The deck reflows on its own width, not the window's**, so it behaves identically embedded
in the Cockpit as it does standing alone.

### Three kinds of control, and the page says which

M4 requires that image controls apply live, that stream controls restart the picture, and
that the page says which is which. There is a third kind, so the group headers carry one of
three legends:

| Kind | Legend | Behaviour | Examples |
|---|---|---|---|
| Image | *applies live* | Takes effect on the running stream | Exposure, white balance, colour treatment, brightness, aim, zoom |
| Stream | *restarts the picture* | The pipeline is rebuilt; the picture drops and returns | Resolution, frame rate, codec |
| Configuration | *config.yaml* | A write to the configuration document, through the apply engine | Source, device, outputs, addresses |

Zoom is in the first row as a constraint on implementation, not as an observation: **every
zoom backend applies live.** A UVC control and a receiver-side crop already do; a sensor
crop that would rebuild the pipeline is implemented as a crop after capture instead, so that
zoom never restarts the picture on any camera.

Configuration changes go through the apply engine and are validated and journalled like any
other, but **they do not start a confirmation countdown**: `affectsReachability` gates that,
and a camera change cannot cost the operator the ability to reach the device. So no camera
control carries the irreversible tone, and *Apply* is the page's single primary action in
the select tone.

### Setup swaps the deck

Setup is done once and never in flight; the live controls are used constantly. Two soft
keys — *Live* and *Setup* — exchange the deck beneath the picture. **The picture, the
readout strip and the rail do not move.**

This is not the same as a panel covering the picture, which is rejected: on a camera you
are aiming, a panel over the frame hides the part of the shot you are aiming at. Swapping
what is *under* the picture costs the capture gate one extra state per palette, which is
what R-UI-12 was written to handle.

The Setup deck holds:

- **Identity** — name, source, and the device path. The path is held by port rather than by
  enumeration number, so it is the same camera after a reboot (R-CAM-05).
- **Encoding** — codec chosen; encoder and decoder shown read-only because they are what the
  probe answered rather than what anyone picked (R-CAM-13).
- **Outputs** — ground-station address and port, browser preview size, RTSP path, SRT.

Two soft keys exist only here. *Re-probe* asks this one camera again what it can do, for a
changed lens or new firmware. *Receive line* is section 8.

### Reading back, never remembering

R-CTL-10 requires settings to be read back rather than taken from form defaults. This
design leans on that harder than the requirement's wording implies, in three places: a
control shows what the camera reports and not what was sent; a commanded value that differs
from the reported one is drawn as a mark against the reading rather than replacing it; and
**on reconnection the page re-reads everything before showing it as current**, because the
board may have rebooted while the operator was away.

---

## 3. Aiming

### A drag is a speed, not a position

Two models were considered. Dragging to a position — where you release is where it points —
is the more obvious and fails on this link: at 300 ms you are aiming at a picture that is
already stale, you overshoot, you correct against a picture that is stale again, and you
oscillate. That is the failure R-UI-06 exists to prevent.

Dragging to a *rate* — how far you push is how fast it slews, release stops it — is what the
hardware already does, and the bench measured it:

- `gimbal/0x0C` custom speed with the control-authority flag `0x80` moves at the commanded
  rate; without the flag the frames are accepted and ignored.
- Yaw at −10 °/s for two seconds moved 24°, twice; the commanded 25° over 2.5 s including
  the tail. **The rate is accurate.**
- **A frame is valid for about half a second.** One frame then silence moved 5° and stopped,
  unchanged two seconds later.

That last property is the design. A held aim is a repeating rate command that expires. When
a finger lifts, or the link drops mid-slew, the commands stop arriving and the gimbal stops
because nothing is telling it to move. A joystick over a radio needs exactly that property,
and here it comes free.

**Tap-to-point is kept as a second gesture.** "Look at that thing over there" is one command
rather than a stream of them, and being stale by 300 ms barely costs anything when the move
is large.

### The dial

The same command, for a mouse: self-centring, and carrying **two marks rather than one** —
the commanded rate where you are pushing, and the reported attitude where the camera
actually is. Over a cellular link those two are never the same, and drawing both makes the
lag legible instead of something to fight.

### Limits come from the device

The gimbal reports them. `gimbal/0x05` byte 10 bit 1 is a limit flag, observed on only while
the head was held against the end of its yaw travel and off when released, at 20 Hz on the
same link as the video. So the dial carries the travel as an arc and the stop as a marked
band, the pointer changes to the caution tone against a stop, and a limit annunciates over
the picture (R-TEL-15). **A limit is never inferred from the shot.**

### What does not resume

On reconnection, **the commanded rate returns at zero and the dial returns centred.** The
command *is* the pointer — a finger on the picture or a mouse on the dial — and on
reconnection no pointer is down, so there is nothing to resume from. Aiming restarts when
the control is touched. A picture resumes because the request for one still stands; a slew
does not, because the input that was driving it is gone.

---

## 4. The uplink is the constraint, not the encoder

### Evidence

The `tee` costs almost nothing. Measured: one output at 68% of a core, a tee to two
branches at 70%.

The encoder costs almost nothing either. At 1080p30 the whole pipeline is 55% of one core
and 14% of the board; the split is capture 1%, software JPEG decode ~50%, hardware H.264
encode +4%. **The JPEG decode is the entire cost**, and K-40 means it cannot be moved to
hardware on this board.

What is *not* free is the uplink:

> The split is one encode copied twice inside the board, but each consumer that leaves over
> cellular costs its own bitrate. At 2 Mb/s that is 6 Mb/s of uplink for one camera, against
> a field LTE uplink that is often 1–5.

`architecture.md` currently implies the `tee` removes this trade-off. It does not, and that
sentence should be corrected in the same change as this work.

### Decision: the browser gets a separate, cheaper copy

The expensive frames are already decoded. A second encode from those frames, scaled, costs
about what 640×480 costs — 11% of one core, 3% of the board — and takes the browser's share
of the uplink down by most of an order of magnitude (R-VID-13).

**The preview's size and rate are not yet chosen.** 640×360 at 400 kb/s is the working
assumption used in the mockups; it is a placeholder for a measurement nobody has taken, and
the number that matters is what that costs on the board *and* what it looks like on a
tablet at arm's length.

**The full-rate picture stays available while the operator asks for it**, on a held soft
key, and the interface states what asking would cost *before* it is asked. That is R-VID-11
doing work rather than reporting a number.

Two consequences:

- **The adaptive ceiling is capped to the uplink less whatever the preview is taking**, so
  the two controls stop fighting. *The uplink* here is the adaptive loop's own running
  estimate (R-VID-07), not the on-demand measurement of R-DIA-03 — the on-demand figure is
  a snapshot taken on the ground, and the cap has to move with the link in flight.
- **The preview is visibly marked the whole time it is the cheap one.** An operator must
  never mistake a 640 px preview for the picture the aircraft is sending a ground station.

### The budget is an instrument, not a number

R-VID-11 asks for each output's bandwidth and their total *against the capacity of the path
they leave by*. A bounded quantity cannot be a bare figure (R-UI-09), so this is one track:
a segment per output, a mark at the measured capacity, and anything past the mark hatched
in the fault tone.

### Bitrate is chosen, not dragged

A segmented control for Fixed or Adaptive, then a picker of real rates — or a floor and a
ceiling when adaptive. **The bar underneath stops being an input and becomes the readout of
what is actually leaving the aircraft**, which also removes an ambiguity a slider has: with
a slider you cannot tell whether the bar shows what you asked for or what you are getting.

Resolution is a picker of the modes **the camera actually reported**, and codec is a picker
of what **the board's encoder actually answered** (R-CAM-13) — which is also what lets a
configuration the board cannot sustain be refused before anything is pressed (R-CAM-10),
and what makes H.265 appear on its own when a board that encodes it arrives.

---

## 5. More than one camera

### A page per camera, and a strip

R-UI-03 requires navigation built from detected hardware — a camera that is not present has
no section. Three cameras, three entries; unplug one and its entry goes. Each page deep
links.

Under the picture is a **strip of the other cameras**. One tap switches; the thumbnails show
what the others see.

**Only the camera being watched is subscribed live.** The others are stills refreshed every
few seconds — kilobits rather than megabits. A camera that is not streaming at all shows its
last known frame with that frame's age, or its name on an empty tile if it has never
produced one; a tile is never blank without saying why. A view that subscribed to three streams to
show two pictures nobody is examining triples the uplink for nothing, and the strip's own
readout says what the current arrangement costs.

The strip is also the fall-back for a browser that cannot establish WebRTC at all
(section 6).

### A Cameras page above them

R-CAM-12 wants detection on demand that reports **what was found, what was rejected and
why**, and a rejection has nowhere to live on a page belonging to a camera that exists.

The Cameras page lists each camera with what its capability probe returned in one line —
`aim: none · zoom: none` explains why that camera's page has no Aim group before anyone goes
looking — and then lists what was seen and refused, with the reason. One rejection this
bench produces today belongs there, and one it would:

- `/dev/video10`, which is the board's JPEG decoder, advertises MJPEG, cannot be started
  (K-40), and looks like a camera to everything that asks — this bench produces it;
- a camera offering raw frames only, at a rate too slow to fly — this bench does not have
  one (its camera offers MJPEG at 90 fps beside raw at 5), but R-CAM-02's requirement for
  compressed sources means the rejection exists.

The board's encoding budget and the **total** uplink across all cameras live here rather
than on any one camera's page, because both are shared. *Starting the gimbal would need
2.1 Mb/s more* is a sentence no single camera's page can say.

---

## 6. Recording, stills, and snapshots

### Recording happens wherever the camera can

Not a mode the operator selects — a capability, like every other (R-CAM-17).

A camera with its own recorder records to its own medium at what it is capable of. The
accessory camera hands the board a live view **fixed at 720p that no message will change**,
while its own recording is not limited to that — so recording the live view instead would
keep the poorer of the two. (Its record command is proven to be accepted; what it produces
has not been read back, because the bench had no card in the camera.) A camera without a
recorder is recorded by the board from the running pipeline.

The page states **which**, and shows the remaining time on whichever medium is doing the
work. Where the camera holds the file, **Yonder never sees it** — no list, no download, no
delete — and the page says so rather than letting somebody hunt for a gallery that cannot
exist.

Board-side recording is bounded (R-STO-06): a reserve is kept that recording may not
consume, and recording ends by itself at the reserve rather than by exhausting the card.
R-STO-02 bounds what logging may take; this bounds what video may.

### Recording state is an annunciator, not a label

Because an acknowledgement is not an effect. The accessory camera **acknowledges a record
command with no card in it** — on that link `status 0x01` means the frame was well formed,
nothing more. So four states:

| State | Tone | Shown when |
|---|---|---|
| Not recording | neutral | Idle, medium present |
| Recording | fault tone, with elapsed time | The camera's own status push reports a running recording |
| **Sent, not confirmed** | caution | Acknowledged, no recording time yet |
| No medium | fault tone, key inoperative | Refused |

The third is the reason this is an annunciator. A page that turned green on the
acknowledgement would be lying, which is what R-UI-05 exists to prevent.

### Snapshot follows the same rule

The camera's own photo where it has one, at full sensor resolution and untouched by Yonder;
a frame from the running pipeline where it does not, which is lower resolution but is a file
Yonder holds and can therefore show, hand over and delete (R-CAM-18).

Two confirmations, and R-UI-05 is why they are kept apart. A flash on the picture at the
moment of the press says the command was **sent** — on a link with a third of a second of
lag, a key that dims for 300 ms says nothing at all. The fact line that follows — *photo
taken · camera card · 4000 × 3000*, or *frame grabbed · board card* — arrives when the camera
or the board reports it, and that is the only thing that says it **took effect**. The first
must never be drawn in a way that could be read as the second.

### The picture has three settings

Live, Stills, Off — with what each costs stated on each (R-VID-14).

Stills is not only a failure state. On a link that cannot carry video it is the setting an
operator would choose — a still every second or two rather than a stream — and it is the
same mechanism that draws the strip. Its cost is a small fraction of the preview's, and like
the preview's, the actual figure is unmeasured.

**Falling back to stills happens without being asked**, twelve seconds after live video
fails to establish — long enough for a slow negotiation to finish, short enough that nobody
is left staring at nothing — and the page reports **why** rather than only that it happened. A browser blocked by a
network, a carrier discarding UDP and a camera that has stopped producing frames all present
as no picture, and only one of them is worth walking outside for. *Try live again* is on the
rail, not a link inside a message.

Falling back changes nothing on the aircraft — nothing is commanded and nothing changes on
the board — so the default should simply be the useful one.

**Off is not the link being down**, and must not look like it: the neutral tone rather than
the fault tone, *not requested* rather than *no contact*, and the strip states that the
ground station is still being fed. Turning off your own view changes nothing about what the
aircraft sends anyone else.

---

## 7. When the link goes, and when it comes back

### Nothing on the aircraft changes

The pipeline's state is what the operator last set it to. The ground station's link is not
the console's link, and the console losing its own is no reason to stop feeding anyone else.
Capture, encode and the ground-station push continue. The browser's session ends because
nothing is subscribed, which is the protocol behaving.

So the only question is what the page does, and the hazard is a stale picture read as a live
one.

### The picture holds, and its age is unmissable

It desaturates, it darkens, it takes a hatch, and it carries a count that keeps running.
Four signals, because a badge alone is what an operator stops seeing after ten minutes. By
the time contact has been gone a minute the shot is barely readable and the count is the
loudest thing on it, which is correct: its only remaining value is telling the operator what
they were looking at when contact went.

Going black is rejected. It cannot be misread, and it deletes the one thing still held —
where the camera was pointing, what was in shot, where the horizon was.

**What the page must not do is claim to know about the other outputs.** A console losing its
link says nothing whatever about the aircraft's ground-station feed. The row reads *not
known from here*. Greying it out, or leaving it green, would be inventing a fact.

### Coming back

Three things restart and one never does.

- **The session reconnects on its own**, with backoff, showing the attempt count. No button:
  the operator asked for a live picture and never withdrew the request.
- **A keyframe is requested on subscribe** rather than waiting for the next natural one
  (R-VID-09). Without it a reconnection is a grey rectangle for up to a GOP. R-VID-09 is
  priority 3 today and this makes it load-bearing: it should rise to priority 2 in the same
  change, or reconnection is acknowledged to be that grey rectangle until it does.
- **Every setting is re-read from the aircraft** before being shown as current. K-41 records
  that the development board reboots by itself; a page redrawing remembered values would
  show a configuration nobody is running.
- **The gimbal does not resume.** Section 3.

---

## 8. Receiving the stream somewhere else

### The command is on the page

R-VID-10 asks that a ground station be configurable from the documentation alone. R-VID-15
is the stronger form: the exact receive-side command is **in the interface**, generated from
what the camera is doing at that moment, so nothing needs to be read.

Four renderings of the same three facts — a GStreamer command line, the settings a ground
station's own video dialog wants, a pipeline ending in an application sink for one that takes
one, and an RTSP URL. Change the codec and the depayloader in the line changes with it.

**The address is the one the operator is actually reaching the device on.** A board on a mesh
has several and only one of them is in use; the command carries that one and lists the others
beneath it rather than guessing.

**Copy is on the soft-key rail**, not beside the code block. No action lives anywhere else on
a page, and a copy control floating in a panel corner is the small exception that ends the
rule. It also works the same on a tablet, where there is nothing to hover.

### And over MAVLink

R-VID-12 announces each camera, its stream and its storage on the MAVLink link Yonder already
carries, so a ground station finds the picture with nothing typed in. R-CAM-16 accepts camera
and gimbal commands arriving that way and relays them on the same terms as commands from the
interface.

Scheduled late. It is written down now because `CAMERA_INFORMATION` is a capability flagset,
which is the same idea R-CAM-14 arrived at independently, and the capability model should be
named and shaped so it maps onto that without a translation layer.

---

## 9. Requirements to add

| ID | Requirement | P |
|---|---|---|
| R-CAM-16 | Accept camera and gimbal commands arriving over MAVLink and relay them to the camera on the same terms as commands from the interface | 2 |
| R-CAM-17 | **Record to storage, wherever this camera can do it.** A camera with its own recorder records to its own medium at whatever it is capable of; a camera without one is recorded by the board from the running pipeline. The interface says which of the two is happening and shows the remaining time on the medium doing the work. Where the camera holds the file, Yonder says so rather than offering to manage a file it never sees | 2 |
| R-CAM-18 | **Capture a still on demand**, by the same rule: the camera's own photo where it has one, a frame from the running pipeline where it does not. A still the board holds can be viewed, downloaded and deleted; one the camera holds is reported as the camera's | 2 |
| R-VID-12 | Announce each camera, its stream and its storage on the MAVLink link Yonder already carries, so a ground station finds the picture without being configured by hand. R-VID-10 makes that configuration possible from the documentation; this makes it unnecessary | 2 |
| R-VID-13 | **Serve the interface a separate, cheaper copy by default**, encoded from the frames already decoded for the main output, so watching in a browser costs a fraction of what a ground-station feed costs. The full-rate picture stays available on request, and the interface states what requesting it would cost before it is requested. R-VID-05 makes simultaneous outputs possible; this is what keeps them affordable on a cellular uplink | 1 |
| R-VID-14 | **Where live video cannot be established, serve periodic stills instead**, at a stated cost and with the age of the current frame shown. The fall-back happens without being asked for and reports why it happened, and stills are also offered as a deliberate choice on a link that cannot carry video | 2 |
| R-VID-15 | **Show the exact receive-side command in the interface**, generated from what the camera is doing at that moment and carrying the address the operator is actually reaching the device on. R-VID-10 makes a ground station configurable from the documentation; this removes the need to read it | 2 |
| R-STO-06 | **Recording on the device's own medium stops before it fills it.** A reserve is kept that recording may not consume, the remaining time is shown against that reserve, and recording ends by itself when it is reached rather than by exhausting the card. R-STO-02 bounds what logging may take; this bounds what video may | 2 |
| R-UI-15 | **Nothing is silently missing.** A capability the device does not have is stated as a fact where its control would have been — never drawn as a control that cannot be used, and never simply absent, because an operator must be able to tell *this camera cannot* from *this page failed*. A capability the device advertises and does not answer keeps its control, marked inoperative and carrying the reason (R-CAM-14). Actions are the exception: the soft-key rail carries only what can be done | 2 |

R-VID-13 is the only P1 in the set. R-VID-05 — every configured output delivered at once —
is already P1, and a P1 requirement that is unaffordable on a real uplink is not met.

R-STO-06 ships with R-CAM-17 rather than after it. A recording feature that can fill the
boot card in flight is a defect from its first commit.

R-VID-15 adds to R-VID-10 rather than superseding it: a ground station can be configured
from the documentation before the device is in front of anyone, which is a different
situation from standing at the console.

**Where each lands.** Proposed here; the roadmap is where it is decided, and it is updated
in the same change as the requirements.

| Milestone | Requirements | Why there |
|---|---|---|
| M4 | R-VID-13, R-VID-14, R-VID-15, R-UI-15 | The cheap preview is what makes M4's exit criterion affordable on a field uplink; stills are its safety net; the receive line is how a ground station gets configured for that criterion; and the page cannot be built without the rule for what it draws |
| M5 | R-CAM-17, R-CAM-18, R-STO-06 | The accessory camera is the first with its own recorder, and recording arrives with it |
| M7 | R-VID-12, R-CAM-16 | M7 is commanding; a ground station commanding the camera over MAVLink belongs beside the rest of R-CMD |

---

## 10. Rules this exposed

Three, each found by rendering the design rather than by reasoning about it, and each
belonging in the widget library rather than in a reviewer's attention.

**A token carrying a unit is never uppercased.** `Mb/s` rendered as `MB/S` says megabytes.
It appeared three times in three different components — a strip readout, an annunciator and
a placard — which makes it a missing constraint rather than three mistakes. Small caps are
for labels; `Mb/s`, `kb/s`, `ms`, `fps` and `°/s` keep their case.

**A segmented control needs a maximum width.** ADR-0009 already says an engine bar's track
has a fixed width and never stretches to its container. The same must hold for the
segmented control, or every group that wraps to full width on a tablet grows a
700 px three-way switch, which is also the spirit of R-UI-10.

**CI has no camera, so the capture gate silently stops covering these pages.** R-UI-03
builds navigation from detected hardware and R-UI-12 photographs every page in both palettes
on every build. With no camera attached there is no camera page, so the gate covers none of
the pages described here and does not complain, because from its point of view there is
nothing there. **A synthetic camera source and a checked-in capability fixture are therefore
part of this work, not a testing afterthought.** The fixtures the accessory-camera bench is
already producing are the right shape for it.

---

## 11. Shape of the code

`packages/node-red-contrib-yonder-video/` is empty today. What goes in it:

- **The capability model** — a device's answers, normalised. One type, three states per
  capability, and a mapping onto MAVLink's camera flagset chosen now rather than translated
  later (section 8).
- **Probing** — per source kind, each returning a capability set. Failures are values, not
  exceptions: a rejection with a reason is what the Cameras page renders (R-CAM-12).
- **Pipeline composition** — one pipeline per camera, with the `tee` and the scaled preview
  branch. The composed pipeline is a value that can be asserted in a test without a camera.
- **The receive-line renderer** — the same facts, four renderings (section 8). Pure, and
  therefore fully testable.

Presentation goes in `node-red-dashboard-2-yonder` as Vue components, never as markup in a
`ui-template`: the picture pane with its overlays and gesture, the aim dial, the uplink
budget track, the capability facts row. `flows/` stays wiring.

Two interaction primitives do not exist in the widget library today, and they are the
riskiest interface work in this document: **a soft key that is held** — press and release,
for the full-quality preview — and **a pointer tracked across the picture** — for
drag-to-slew and tap-to-point. ADR-0009 records that every soft key once shipped dead
because a click handler was never registered. These are not clicks, and they are built and
proven before anything that depends on them.

The accessory camera's transport is its own package (`pocket2d` in
[`dji-pocket-2-over-usb.md`](../../hardware/dji-pocket-2-over-usb.md)), so a firmware change
on that camera breaks one package and not the video path. To the camera view it is one more
source with a fuller capability set.

---

## 12. What this does not cover

- **The Cockpit.** The camera view has a compact form and the Cockpit can embed it. What the
  Cockpit itself holds — attitude, map, telemetry layout — is its own design, deliberately
  not settled here.
- **Audio.** It appears nowhere in this repository, in any document. Cameras in the
  compatibility list have microphones and the media server carries audio, so the absence is
  an unmade decision rather than a settled one. It also has a dimension the video work does
  not: recording audio is treated differently from recording video in some jurisdictions,
  and the default matters. Yonder needs a position even if the position is *no audio,
  deliberately*.
- **Video at boot.** R-MAV-08 starts telemetry automatically at boot with no operator action,
  P1. There is no camera equivalent, so an aircraft powered on at a field has no picture
  until somebody opens a browser. The asymmetry looks accidental.
- **A camera that re-enumerates in flight.** R-CEL-06 requires surviving a modem disconnect
  and reconnect without operator action, P1. There is no camera equivalent, and K-41 already
  records the accessory camera needing eleven enumeration attempts with two port
  power-cycles on a marginal supply.
- **Metadata.** Nothing ties a recording or a still to a time, a position, or a gimbal
  attitude, so neither can be lined up against a flight log. The parts are already there —
  the autopilot pushes position, the accessory camera pushes attitude at 20 Hz — and the join
  is cheap while the file format is undecided.
- **Field of view.** Nothing records what lens is on a camera. R-VID-12 needs it, digital
  zoom needs it to mean anything numerically, and a crosshair cannot claim to be a boresight
  without it.
- **More than one viewer.** Two browsers is two subscriptions and twice the uplink, and
  R-VID-11 counts outputs rather than viewers, so the budget would under-report. If both
  aim the gimbal, who wins is undesigned — last touch, or a claimed lock — and needs deciding
  before a second browser is ever opened on a flying aircraft.

---

## Open

Two decisions this document does not make, because each changes something outside it.

**The recording tone.** Section 6 draws a running recording in the fault tone, because a red
*REC* is the one camera convention strong enough that a green one would confuse. ADR-0009
names tones by role, and red is a fault; a recording that is working is not one. Either
recording earns a tone of its own, or it uses the *good* tone, or ADR-0009 records the one
exception.

**Where the travel arc comes from.** Section 3 draws the gimbal's travel as an arc and the
stop as a band. The device reports the *at-limit flag*; the *range* was found on the bench
by driving to each stop, once, under a guard that refused to push past one. The natural
answer is a *Find range* key in Setup that does what the bench did, guarded the same way, on
the ground — so the arc is complete before the first flight — with the arc also updating if
a stop is met at a new angle in use, so a remount corrects itself. The alternatives are a
range entered by the operator, which goes stale on a remount, or no arc until the stops have
been met in use, which leaves the dial blank for the first flight. One precondition for any
of them: the bench has not yet established which flag bit is which axis.

---

## Evidence

Everything cited above, with its source.

**The pipeline**, from [`usb-camera-on-a-pi-4.md`](../../hardware/usb-camera-on-a-pi-4.md):

| | |
|---|---|
| 1920×1080p30, whole pipeline | 55% of one core, 14% of the board |
| 1280×720p30 | 27% of one core, 7% of the board |
| 640×480p30 | 11% of one core, 3% of the board |
| Capture only | 1% |
| plus software JPEG decode | ~50% |
| plus hardware H.264 encode | +4% |
| One output | 68% of one core |
| `tee` to two branches | 70% of one core |
| Thermals | 62 → 70.1 °C over ~1 h intermittent load in open air, never throttled. **Sustained encode in a closed airframe is untested** |

**The accessory camera and its gimbal**, from
[`dji-pocket-2-over-usb.md`](../../hardware/dji-pocket-2-over-usb.md):

| | |
|---|---|
| Live picture | 720p H.264, ~8 Mb/s, continuous, held by a 1 Hz ping |
| Rate aim | `gimbal/0x0C` with control-authority flag `0x80`; without it, accepted and ignored |
| Rate accuracy | commanded 25° over 2.5 s, moved 24°, twice |
| Frame validity | **~0.5 s** — one frame then silence moved 5° and stopped |
| Limit flag | `gimbal/0x05` byte 10 bit 1, at 20 Hz; on only while held against the yaw stop |
| Zoom | digital only; accepted, does not reshape the 720p feed — cropped by the receiver |
| Live-view resolution | **not controllable**; fifteen values across three payload widths, all acknowledged, frame stayed 1280×720 |
| Record | acknowledged with no card in the camera; `status 0x01` means well-formed, not effective |

**Defects**, from [`known-issues.md`](../../known-issues.md):

- **K-40** — `/dev/video10` advertises MJPEG and cannot be started, so software JPEG decode
  is the floor and is the entire cost of the pipeline.
- **K-41** — the development board browns out: `get_throttled=0x50000`, three undervoltage
  events in the first two minutes of a boot, and spontaneous reboots. **Every figure in the
  pipeline table was measured on a board in that state, so they are a floor rather than a
  clean reading**, and should be retaken on a supply that holds.
