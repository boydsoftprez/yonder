# M4 — the camera view: whole-branch review

**Date:** 2026-09-04 · **Branch:** the M4 camera view · **Base:** `ec9bb65` · **Reviewed at:** `1279296`

Filed beside the spec and plan it reviews, as
[the camera view's design review](2026-09-03-camera-view-review.md) was.

## Provenance

One review at the end rather than per-task reviews, which is this repository's
cadence. It read the whole branch diff — 42 commits, 139 files — against the
spec, the plan, and the execution ledger, and had the development board
available to check claims on hardware.

It returned **13 must-fix, 13 should-fix, 11 worth-knowing**, and the verdict
*not mergeable*.

All thirteen must-fix were then fixed in one wave (`56f96c0` … `ee7e1aa`), and
a scoped re-review of that wave verdicted every one **addressed**, adjudicated
the four the fixer had solved differently from the proposal, and found two new
breakages the wave itself had introduced. Those were fixed in `5c8c514` and
`0952da2`.

**What remains open is the should-fix and worth-knowing material below.** None
of it blocked the merge; several items are real and worth doing, and S1 and S2
in particular question an exemption in `apply/reachability.ts`, which is a file
where being wrong costs an operator their way back to the device.

Three findings are worth carrying forward as the character of this branch:

- **M4** — an SRT output opened an unauthenticated listener on every interface,
  outside mediamtx entirely. R-SEC-13 is P1 and is the requirement this
  milestone claims to close.
- **M1** — a healthy live picture read *no contact* three seconds after it
  connected, and a component test asserted that as correct. The hazard the
  component exists to prevent, inverted.
- **M11** — the codec-rejection pattern was widened during execution to catch
  one card and began rejecting real cameras: `Display` contains `isp`.

---

## Verdict

Careful, well-evidenced work, and the honesty of the ledger and the task reports is the reason
most of what follows was findable at all. The capability model, the reachability exemption
mechanism, `settings.ts`, the mediamtx posture, the WHEP proxy and the installer are all better
than the milestone needed them to be.

The defects cluster in four places, and each cluster has one cause:

1. **`YonderPicture.vue` — the one component nothing could exercise.** The capture gate runs
   against a synthetic daemon with no media server, so it only ever photographed the
   *reconnecting* state; Task 16's browser proof went through mediamtx's own endpoint over an
   SSH tunnel, not through this component. Three real bugs live in that gap, and the worst is
   asserted as correct by its own test suite.
2. **The seam between what `yonder-core` computes and what `flows/flows.json` draws.** Four
   defects are the same shape — a value the code derives correctly, restated as a literal in
   wiring.
3. **The SRT output** — the only output kind nobody ran. Composed, unit-tested against a
   string, shipped. The string is right and the behaviour is not.
4. **Two parser guards that are right for the bench's camera and wrong for the next one.**

Thirteen must-fix, thirteen should-fix, eleven worth-knowing.

---

# Must fix before merge

## M1 · A healthy live picture reads "no contact" three seconds after it connects, and a test asserts that as correct

`packages/node-red-dashboard-2-yonder/src/ui/YonderPicture.vue:138-140`, `:257`

```js
staleFor () {
    if (this.mode !== 'live' || this.lastFrameAt === null) return 0
    return Math.max(0, Math.floor((this.now - this.lastFrameAt) / 1000) - 2)
}
```

`this.lastFrameAt` is written in exactly one place — inside `pc.ontrack` — and `ontrack` is a
**negotiation** event. It fires once, when the remote description adds the track, *before any
media flows*. Nothing else in the component ever updates it: no `timeupdate`, no
`requestVideoFrameCallback`, no `getStats()`. The field is `firstTrackAt` wearing the wrong
name. Meanwhile `this.now` advances every second from the `tick` interval.

So on a perfectly healthy stream:

| t | `staleFor` | what the operator sees |
|---|---|---|
| +3 s | 1 | badge flips to **"no contact"**, tone `bad`, hatch drawn, age counter starts |
| +5 s | 3 | `saturate(0.95) brightness(0.97)`, "3 s ago" |
| +62 s | 60 | `saturate(0.00) brightness(0.35)`, "1 min 0 s ago" — an unreadable dark rectangle |

This inverts the whole of spec §7. The four degrade signals exist because *"a badge alone is
what an operator stops seeing after ten minutes"* (`YonderPicture.vue:33-34`) — and they now
fire on every healthy session, which teaches an operator to ignore all four inside one flight.
The single hazard this component was written to prevent is a stale picture read as a live one.
This trains exactly that reflex.

**The suite locks it in.** `picture.component.test.ts:453-463`:

```js
it("desaturates, darkens, hatches and counts, all four at once", async () => {
  const { wrapper } = await live();
  await advance(5_000);
  expect(badge(wrapper)).toBe("no contact");
```

`live()` delivers a track and nothing else; `advance(5_000)` is only the passage of time. The
test believes it is simulating contact loss; it is simulating a working picture. Every test in
that describe block shares the premise, which is why none of Task 13's twelve mutation checks
could reveal it — they mutated other things.

Fix: drive `lastFrameAt` from something that tracks *media* — the video element's `timeupdate`,
`requestVideoFrameCallback`, or a periodic `pc.getStats()` reading `framesDecoded` — and rewrite
the degrade tests to stop delivering frames rather than merely letting the clock run.

## M2 · An abandoned handshake writes a false reason and its retry kills the live session

`packages/node-red-dashboard-2-yonder/src/ui/YonderPicture.vue:247-291`

`connect()` captures `pc` in a local but never re-checks `this.pc === pc` after either `await`,
and the `fetch` carries no `AbortController`. Two reachable consequences:

**The full-rate key drops the picture it was pressed for.** Hold FULL RATE → `setRate('full')`
→ `connect()` closes pc0 and opens pc1 → the full-rate session comes up and plays → the
*abandoned preview handshake* then resolves → `pc0.setRemoteDescription()` throws
`InvalidStateError` on the closed connection → the catch at `:288-291` sets `reason` and calls
`retry()` → the backoff fires → `connect()` tears down the **good** pc1. Observed in a scratch
mount: badge `"reconnecting · attempt 1"`, three fetches, and the live peer connection closed
by the stale retry.

**Off is drawn as a fault.** `setMode('off')` while the POST is in flight takes the same path,
and the `<div v-if="reason">` at `:19` renders *"this browser could not negotiate a stream
(InvalidStateError)"* underneath the "off" panel. That contradicts the component's own
invariant at `:64-68` — *"Off is not the link being down, and must not look like it"* — and
spec §6.

Fix: `if (this.pc !== pc) return` after each `await`, and abort the fetch in `teardown()`.

## M3 · `teardown()` never releases the `<video>`, so "off" keeps painting the last live frame

`YonderPicture.vue:210-212`, template `:4-11`

```js
teardown () { if (this.pc) { this.pc.close(); this.pc = null } }
```

The `<video>` element has no `v-if` and its `srcObject` is never nulled. Closing a peer
connection ends its tracks, and a media element holding an ended MediaStream keeps painting its
last decoded frame.

So `setMode('off')` leaves a **frozen live frame on screen**, in the *neutral* tone, captioned
"off", with `staleFor` pinned to 0 by `:139` — no hatch, no age counter, no degrade. Identically
in `stills` mode when `stillsUrl` is unset, which `picture.ts:26-33` documents as the normal
state today and `picture.component.test.ts:334-338` asserts: the `<img>` is `v-if`'d away and
the stale live frame shows through, badged "stills" in the *waiting* tone.

A frozen frame with nothing saying it is frozen is the hazard `:30-36` names, and here it is
drawn in the two tones that mean nothing is wrong. Null `srcObject` in `teardown()`, or `v-if`
the element to live mode.

## M4 · An SRT output opens an unauthenticated listener on every interface — R-SEC-13 (P1) broken by the milestone that claims to close it

`packages/yonder-core/src/video/pipeline.ts:174`

```ts
case "srt":
  return ["mpegtsmux", LINK, "srtsink", `uri=srt://:${output.port}`, "wait-for-connection=false"];
```

**Verified on the board.** With that element running:

```
$ ss -lun | grep 9998
UNCONN 0  0   0.0.0.0:9998   0.0.0.0:*
```

`srtsink` binds `0.0.0.0:<port>` and its `passphrase` property is unset (default `""` — no
encryption, no authentication; confirmed with `gst-inspect-1.0 srtsink` on the board). The
socket is opened by the `gst-launch-1.0` process, **not by mediamtx**, so `authInternalUsers`
in `media/config.ts` never sees it. Anyone who can reach the board — on the LAN, on the
ZeroTier mesh, or on a routable cellular address — pulls the full-rate H.264 with no
credential at all.

R-SEC-13 is *"every media listener has a stated posture, and none is reachable by default
without one"*, and the spec puts it in M4 precisely because *"M4's exit criterion is from
another network, which is the moment an unguarded listener becomes reachable by anyone on the
mesh."* This listener has no posture and appears in none of them.

**And the posture that *is* stated describes a different server.** `media/config.ts:123-124`
sets `srt: anySrt` / `srtAddress: :8890`, turning mediamtx's own SRT server on whenever any
camera has an `srt` output — and **nothing ever publishes to it**, because `sink()` goes
straight to `srtsink`. So the file opens a listener for no reason (the thing its own comment at
`:126-131` says it refuses to do) while the docstring at `:28-29` — *"SRT is off unless an
output configures it, and carries the same credential when it is on"* — describes a server
carrying nothing. Note also `:36-41`'s *"**Measured, not assumed.** Every claim above was
probed"*: the evidence listed is RTSP and WebRTC only. The SRT claim was never probed, and it
is the false one.

**R-VID-06 is not in the plan's M4 scope** (`plans/2026-09-03-m4-camera-view.md:19`). The
cheapest correct fix is to refuse an `srt` output in `refuse()` (`pipeline.ts:225`) — or drop
`srt` from `CameraOutput` — until the milestone that owns R-VID-06 builds it with a posture.
Second best: caller mode to a configured host, as `rtp` already does, and delete `srt: anySrt`.

## M5 · An SRT output on port 8890 takes every camera on the device off the air

`packages/yonder-core/src/schema/config.ts:296-320`

`ConfigSchema.superRefine` refuses an output port equal to `ui.port` and nothing else.
`{ kind: "srt", port: 8890 }` — **the exact value the branch's own fixture uses**, at
`packages/yonder-core/src/media/config.test.ts:62` and `:85` — is `SRT_PORT`. Both `srtsink`
(M4) and mediamtx's SRT server (turned on by that same output) want UDP 8890.

- mediamtx binds first → `srtsink` cannot bind → `gst-launch-1.0` exits → **the browser preview
  dies with it**, because both branches are one process.
- the pipeline binds first → mediamtx exits on its next restart, with the log
  `packages/yonder-core/src/media/ports.ts:35-37` records verbatim → **every camera on the
  device goes off the air, including the browser's.**

This is `ports.ts`'s own worked example — the one that cost Task 9 a rewrite — arriving through
a door nobody closed. Fixing M4 by removing `srt` closes this too. If `srt` stays,
`superRefine` must refuse `SRT_PORT`, `RTSP_PORT`, `WEBRTC_PORT` and `WEBRTC_LOCAL_UDP_PORT` as
well as `ui.port`.

## M6 · The full-rate RTSP path is `camera.id` in one file and `output.path` in another; they agree only in the fixture

`packages/yonder-core/src/media/config.ts:89` writes `paths[camera.id]`.
`packages/yonder-core/src/video/pipeline.ts:172` sinks to `${rtspBase}/${output.path}`.

Demonstrated with a real config (`id: "cam0"`, rtsp `path: "nose"`):

```
mediamtx paths:        [ 'cam0-preview', 'cam0' ]
pipeline publishes to: [ 'location=rtsp://127.0.0.1:8554/nose',
                         'location=rtsp://127.0.0.1:8554/cam0-preview' ]
refuse() says:         null
```

`paths` has no catch-all — asserted at `media/config.test.ts:143-148` — so mediamtx refuses the
ANNOUNCE with 400, `rtspclientsink` errors, `gst-launch-1.0` exits, and **the preview goes with
it**. The supervisor restarts five times and gives up with *"the pipeline exited with code 1"*;
nothing anywhere names the path. `refuse()` returns `null`, so the operator is not warned
before pressing Start either. And `renderReceive` prints `rtsp://yonder:…@…/nose` — a URL that
can never work, which `receive.ts:18-19` says is *"the one thing this must never do"*.

**The test cannot catch it.** `media/config.test.ts:14-15` sets `id: "cam0"` and `path: "cam0"`.
Mutation check: rewriting `paths[camera.id]` as `paths[o.path]` left **15/15 green**. Same
fixture-override-equals-base defect the branch already found once (ledger, Task 2).

Fix: declare `paths[output.path]` as well as (or instead of) `paths[camera.id]`, and give the
test a fixture where the two differ. Watch for the second-order collision an independent `path`
allows — one camera's `path` equal to another camera's `id` or `<id>-preview` — which
`superRefine` does not check either.

## M7 · `Supervisor.start()` does not cancel a pending retry, so Start on a failed camera orphans a `gst-launch-1.0` nothing can kill

`packages/yonder-core/src/video/supervisor.ts:96-108`

`start()` clears no timer, and its guard only blocks `starting` / `running`. A pipeline that
dies before it settles goes to `failed` **with `entry.retry` armed for 1–30 s**
(`supervisor.ts:170-177`) — which is exactly the state the page invites an operator to press
Start in.

Verified in a scratch test against the file's own fake clock and spawner:

```
start → exit before settle   → state "failed", retry armed
operator presses Start       → process #1 spawned  (retry NOT cleared)
retry fires 1 s later        → process #2 spawned, entry.proc = #2
stop()                       → kills #2 only

processes spawned: 3     kill counts: 0:0  1:0  2:1
```

**Process #1 is a live `gst-launch-1.0` the supervisor has lost the handle to.** It holds the
camera's `/dev/video*` node open, so every later `start()` gets `EBUSY` from `v4l2src`, and
mediamtx refuses it as a second publisher on the same path. From the console the camera is then
permanently unstartable, and only a reboot or a manual `kill` clears it. The trigger is
ordinary: any fail-fast cause — camera unplugged, mediamtx down, M6 above — followed by the
operator's natural response.

One line fixes it (`this.clock.clearTimer(entry.retry); entry.retry = null;` at the top of
`start()`, plus killing any `entry.proc` still held). The 194-line supervisor test has no case
for start-while-retry-pending; Task 7's mutation check covered `entry.stopping` and stopped
there.

## M8 · Five nodes in `flows/flows.json` hard-code the camera id `"front"`, so the Camera page is dead on every device whose camera is not called that

`flows/flows.json` — `camera-read`, `camera-controls`, `camera-settings`, `receive-camera`,
`stream-camera` all carry `"camera": "front"`, the capture fixture's name.

`packages/node-red-contrib-yonder-video/src/adapter.ts:35-40` already prefers `msg.camera` over
`config.camera`. **Nothing in the wiring sets it.** The package was built to be dynamic; the
wiring froze it.

Worse, the page is shown in exactly the case where it cannot work. `cameras-present` switches
on `payload.found` being non-empty — and `found` is the **hardware sweep** (`GET /cameras`), not
the configuration. So:

- a freshly flashed device (`config/defaults/config.yaml` now ships `cameras: []`) with a camera
  plugged in → `found` non-empty → **CAMERA appears in the nav** → every node calls
  `/cameras/front` → `404 no camera is configured with the id "front"` →
  `adapter.ts:96-104` badges "not answering" and sends `payload: null`, so every widget on the
  page draws nothing;
- a device whose camera is configured as `nose`, `cam0`, `payload` — anything but `front` →
  identical.

The task-16 report records *"the camera page is static wiring for one camera"* and defends it as
in-scope for a one-camera milestone. That defence covers one page for one camera; it does not
cover *the one camera must be named `front`*. This is wiring-only work: take the id from
`GET /cameras` and set `msg.camera`.

R-UI-03 (*"build navigation from detected hardware, so a camera that is not present has no
section"*) is met for "nothing attached" and unmet for the case that matters.

## M9 · R-UI-15 is violated in a committed capture, in the direction the last task flagged

`packages/yonder-core/src/video/present.ts:142-154` emits a fact only for capabilities that are
**not** `present`. The Live deck is two static sliders (`slider-cam-brightness`,
`slider-cam-contrast`). But `packages/yonder-core/src/video/probe/camera.ts:103-111` probes
**seven** controls, and the bench's own camera answers four of the missing ones as `present` —
from the committed fixture `scripts/fixtures/camera-globalshutter.json`:

```
zoom:         present  {min: 0,    max: 60}
focus:        present  {min: 0,    max: 1023}
exposure:     present  {min: 1,    max: 10000}
whiteBalance: present  {min: 2800, max: 6500}
```

`docs/console/capture/camera-live.day.png` is the proof. "APPLIES LIVE" shows Brightness and
Contrast. "NOT ON THIS CAMERA" lists Rotation, Aim, Recording, Stills. **Zoom, focus, exposure
and white balance appear nowhere — no control, and no fact.** An operator reads the page and
concludes the camera has two adjustable settings; it has six.

R-UI-15: *"an operator must be able to tell this camera cannot from this page failed."* Here
neither is said. R-CAM-11 names those four controls explicitly. The capture gate photographed it
and passed, because nothing checks this direction.

Honest minimum, and it is small: give `capabilityFacts()` the set of capabilities the page
actually draws, and emit a row ("offered, not on this page") for any `present` capability
outside it. That closes R-UI-15 without building four controls, and makes the gap visible to the
gate the next time it widens. The same hole covers `rotation` — R-CTL-05 is built end to end in
`controls.ts` and has no control on any page.

## M10 · A pixel format the parser cannot read donates its frame sizes to the next format, so a mode the camera cannot deliver reaches the picker

`packages/yonder-core/src/video/probe/parse.ts:17`, `:26-50`

`FORMAT_LINE` requires `'(\w{4})'` — four *word* characters. V4L2 fourccs are four *bytes*, and
several real ones carry a trailing space: `'Y16 '` (V4L2_PIX_FMT_Y16, 16-bit greyscale),
`'Y12 '`, `'Y10 '` — exactly what a thermal or greyscale camera reports. `flush()` then
early-returns when `fourcc === null` **without clearing `pending`**, so the sizes already
collected survive into the next format that *does* parse. Verified:

```
input : [0]: 'Y16 ' / Size: Discrete 160x120 / (9.000 fps)
        [1]: 'MJPG' / Size: Discrete 640x480 / (30.000 fps)
output: [ {MJPG,160,120,[9]}, {MJPG,640,480,[30]} ]
```

The 160×120 **greyscale** mode is reported as an **MJPG** mode. It passes `camera.ts:183`'s
`COMPRESSED` filter, reaches the operator's resolution picker as flyable, and `refuse()`
(`pipeline.ts:248`) accepts 160×120 as a size this camera offers — so a pipeline starts at a
mode the camera cannot deliver, and the only report is `Internal data stream error`. R-CAM-14's
whole point is that capabilities come from what the device answered; this manufactures one.

Fix: `pending = null` before the early return, and widen `FORMAT_LINE` to `'(.{4})'`.

## M11 · The codec-rejection pattern is unanchored, so real cameras are rejected *as codecs*, with a false reason

`packages/yonder-core/src/video/probe/camera.ts:165` — `/codec|decode|encode|isp|hevc/i`,
matched against the card string.

**`"Display"` contains `isp`** — D-**isp**-lay. Verified rejections of genuine cameras:

| card string | what it really is |
|---|---|
| `Studio Display` | the Apple Studio Display's built-in UVC camera |
| `LG Display Camera`, `Dell Display Camera` | monitor- and dock-integrated webcams |
| `rkisp1_mainpath` | the CSI capture node on Rockchip — **the Radxa boards the roadmap names as a target** |
| `USB Camera (H.264 Encoder)` | a camera advertising its onboard encoder — precisely the compressed source R-CAM-02 wants |

The camera does not merely fail to appear. The operator is told
*"`<card>` is a hardware codec on this board, not a camera; it advertises formats it cannot
capture (K-40)"* — so R-CAM-12's *"and why"*, the requirement this text exists to satisfy, is
actively false and sends them looking in the wrong place.

A boundary form — `/(^|[^a-z])(codec|decoder?|encoder?|isp|hevc)([^a-z]|$)/i` — still catches
`bcm2835-codec-decode`, `bcm2835-isp` and `rpi-hevc-dec` and stops catching the above.

Compounding it: mutation checks show **`isp` and `encode` are the two alternatives no test
exercises** (M10, M12 both green — deleting either leaves the suite passing). The two riskiest
terms in the pattern are the two nothing covers.

## M12 · The picture's and the hold key's costs are frozen literals that do not track the configuration — R-VID-11 (P1)

`flows/flows.json`:

```
pic-camera         cost = "preview 0.41 Mb/s · full rate 2.07 Mb/s at IP"
hold-cam-fullrate  cost = "2.07 Mb/s while held"
```

Both reach the component as `str(config.cost)` —
`packages/node-red-dashboard-2-yonder/src/picture.ts:35` and `.../holdkey.ts:31` — and both Vue
components read `props.cost` directly (`YonderPicture.vue:17`, `YonderHoldKey.vue:15`).
**Neither accepts a message override.** They are the fixture's computed values frozen at deploy
time: `present.ts`'s `atIp()` gives 2000 × 1.0335 → 2.07 and 400 × 1.0335 → 0.41.

Raise `bitrate_kbps` to 8000 (allowed, `max(20000)`) and the hold key still says *2.07 Mb/s
while held* while the readout strip beside it — which **is** computed, `present.ts:226` — says
8.27 Mb/s. The page contradicts itself, and the number an operator uses to decide whether to
spend a field uplink is wrong by 4×. Same for the preview: raise `preview.bitrate_kbps` to 2000
and the picture still says *preview 0.41 Mb/s*.

R-VID-11 is P1 and its whole point is that the interface *"states what requesting it would cost
**before** it is asked"*. `cameraStrip` already computes both numbers; they need to reach these
two props through a message, as every other value on the page does.

Related, and it belongs with the same fix: **the hold key is drawn unconditionally.** The
full-rate path exists in mediamtx only when an `rtsp` output is configured
(`media/config.ts:88-90`), and the pipeline publishes the full-rate branch only to configured
outputs (`pipeline.ts:193-195`). On a camera with only an `rtp` output — or none — holding FULL
RATE requests `/video/<id>/whep` for a path that does not exist and gets a 404. R-UI-15's own
exception clause: *"the soft-key rail carries only what can be done."*

## M13 · The development board's address is committed in a shipped unit test

`packages/yonder-core/src/video/receive.test.ts:20` and `:46`

```ts
alternatives: ["192.168.77.1", "the development board"],
…
expect(dialog).toContain("the development board");
```

`the development board` is the development board's LAN address. It also appears at
`docs/superpowers/plans/2026-09-03-m4-camera-view.md:1706` in a literal
`ssh yonder@the development board …` (account **and** address), and at `:2518` / `:2544`, which is where
the test copied it from — all three added inside this range.

CLAUDE.md rule 1: *no references to things outside this repository*; and the review brief: *no
board addresses in committed files*. The project already fixed exactly this class in commit
`a7a2ee2`, *"test(remote): fixtures should not carry a real network's identity"*. Substitute a
documentation address.

---

# Should fix

## S1 · The `preview` exemption is earned by argument, which is the thing `reachability.ts` forbids

`packages/yonder-core/src/apply/reachability.ts:52-57` exempts `preview` from the confirmation
window because *"`max(2000)` kb/s and `max(1280)` px mean no reachable setting of it can
saturate a link"*. The same file, four lines above, keeps `bitrate_kbps` and `outputs`
load-bearing because *"R-VPN-07 requires an exemption to be earned by measurement rather than by
argument"*.

The bound does not carry the argument. `present.ts:45` puts a field uplink at
`ASSUMED_UPLINK_KBPS = 5000`, and `pipeline.ts:17` says such links *"[are] often 1-5"* Mb/s.
Raising `preview.bitrate_kbps` from 400 to 2000 adds 1,654 kb/s at IP — **a third of the
optimistic assumed capacity** — on the path the console session is standing on, with no
countdown and no rollback. On a 1–2 Mb/s link it is all of it.

Concretely: an operator on a flying aircraft raises the preview bitrate, the apply commits with
no window, the console session starves, and because the change was exempt there is no timer to
bring it back. That is the failure R-NET-07 and R-CFG-03 exist for.

Either move `preview.bitrate_kbps` out of the exempt set — keeping size and rate, which is what
the spec actually asked for (*"the preview's size and rate"*) — or lower the schema ceiling to a
figure somebody has measured against a console session.

## S2 · `preview` and `controls` are subtree exemptions, in the file that refuses subtree exemptions

`reachability.ts:113-115` does `delete camera[leaf]` for each of `CAMERA_EXEMPT_LEAVES`, two of
which — `preview` and `controls` — are objects. The same file argues twice, at `:87-95` and
`:105-108`, that exemptions are named leaf by leaf *"for the reason the ZeroTier note above
gives: `delete copy.cameras` would hand the exemption to every field added under a camera later,
with nobody deciding it should have one."*

`reachability.test.ts:166-175` guards the *camera* level — `Object.keys(cameras[0])` must equal
`CAMERA_LEAVES`. Nothing guards the `Preview` or `CameraControls` level. A field added to either
next year is silently exempt, with no test going red and nothing in this file changing for a
reviewer to look at. `allow_default` is the worked example the file itself gives; this is the
same shape one level down.

Also `reachability.test.ts:179-185` asserts only the `bitrate_kbps` half of the bound the
exemption rests on. The `max(1280)` px half the comment names is unasserted.

## S3 · `probeEncoder`'s direction test is guarded by two redundant mechanisms, so neither is load-bearing

`packages/yonder-core/src/video/probe/encoder.ts:81-83`. Three mutations, all green:

| mutation | result |
|---|---|
| drop the raw-in check (`RAW.test`) | **green** |
| drop the H.264-out check (`H264.test`) | **green** |
| never probe the capture side at all | **green** |

`encoder.test.ts:42-53` is titled *"never mistakes the decoder for an encoder"* and proves
nothing: both guards reject the one decoder fixture, so removing either leaves the other to pass
the test. `probeEncoder` could decide "hardware H.264 encoder" from the output side alone and
the suite would not notice.

This is the redundancy-defeats-coverage pattern the branch already diagnosed once (ledger, Task
13). Fix: add a **converter** node to the fixture — raw in, raw out; this board really has
`/dev/video12`, `/dev/video18` and `/dev/video31` — which makes the H.264-out check load-bearing
immediately.

## S4 · The receive line prints a UDP command that cannot work

`packages/yonder-core/src/video/receive.ts:57` — `const port = rtp?.port ?? 5600;`

Three of the four renderings (`gstreamer`, `dialog`, `appsink`) are built unconditionally around
a UDP port, so a camera with only an RTSP output is handed
`gst-launch-1.0 -v udpsrc port=5600 …` and a dialog reading *Listen port: 5600*. Nothing is being
pushed there; the ground station sits and shows nothing, for ever, with no error.

The `url` rendering handles its own absent case correctly and says so (`receive.ts:96-97`). The
other three need the same treatment. `receive.ts:18-19`: *"the one thing this must never do is
print a command that does not work."*

## S5 · A single oversubscribed segment is never hatched

`packages/node-red-dashboard-2-yonder/src/ui/YonderBudget.vue:85`. `startsPast(i)` marks a
segment only if it *starts* past the mark. With `capacityKbps: 3000` and one segment of
4000 kb/s — the ordinary one-camera case — `before(0) = 0 < 3000`, so a 33% oversubscribed
uplink draws **no hatch at all**. That contradicts `YonderBudget.vue:33-34` and
`budget.html:35-36`, and it is R-VID-11 (P1) — *"what stops an operator oversubscribing a link
without being told"* — failing in the commonest configuration.

`budget.component.test.ts:99-107` locks it in: its first segment is named "under" while carrying
1200 kb/s against a 1000 kb/s capacity, and is asserted *not* over.

The ledger records this as *"hatches a segment only if it STARTS past capacity… fine for M4's
one-or-two segments"*. It is not fine for one segment, which is M4's normal case. Hatch the
portion past the mark, or hatch any segment whose *end* exceeds it.

## S6 · Every `describe()` in the video node package is unasserted, including two operator-facing sentences

`packages/node-red-contrib-yonder-video/src/` — six mutations, all green:

| mutation | result |
|---|---|
| `camera.ts describe()`: delete the whole apply branch | green |
| `camera.ts describe()`: delete the whole controls branch | green |
| **`camera.ts describe()`: drop the refusal from the badge** | green |
| **`stream.ts describe()`: drop the supervisor's reason** | green |
| `receive-line.ts describe()`: always say zero ways | green |
| `cameras.ts describe()`: drop the rejected count | green |

Those functions produce the node badge and, through `confirmed(said)`, the
`msg.yonder.message` an operator reads. Two of them carry the sentences that matter most:
R-CAM-10's refusal (*the thing an operator has to fix before Start does anything*) and the
supervisor's exit reason. The routes and payloads are well tested; the words are not tested at
all.

Also green: **`cameraId()`'s documented precedence** (`adapter.ts:29-40`). `adapter.ts` explains
at length why `msg.camera` must win over the node's own id — swap them and the suite stays
green, because `nodes.test.ts:110` supplies only a message id and `:175` only a node id, never
both. That precedence is exactly what M8's fix will rely on.

## S7 · A refused start is badged "not answering"

`packages/node-red-contrib-yonder-video/src/adapter.ts:100`. `routes.ts:405` answers a refused
start with `400 { error: found.refusal }`; `fetched()` yields `{ ok: false, message: <the
refusal> }`; the adapter then sets a flat `"not answering"` for every non-ok result. R-CAM-10's
case — the refusal an operator must fix — reads on the badge as an unreachable daemon.
`camera.ts:101-105` has a `refusal` branch built for exactly this sentence, but it runs only on
the 200 `GET` path, so it never sees a refused start.

## S8 · `identityWords` calls a good by-path identity "an enumeration number"

`packages/yonder-core/src/video/present.ts:229` sources the *name* from the configuration and
the *stability* from the detection. `daemon/routes.ts:434` sets
`byPathStable = found?.byPathStable ?? false` — false for **every rejected camera** — while
`device` is the rejection's node and therefore non-null. Verified:

```
identityWords("platform-fd500000.pcie-…-video-index0", false)
→ "… — an enumeration number; it may mean a different camera after a reboot"
```

A correctly-configured camera that is momentarily rejected — raw-only, `v4l2-ctl` failed,
unplugged — is told its stable socket identity is unstable, which sends the operator to re-plug
a camera whose identity is fine. R-CAM-05 is the requirement this text exists to report on.

## S9 · Three hand-maintained copies of the camera-id pattern, with nothing tying them together

- `packages/yonder-core/src/schema/config.ts:195` — `/^[a-z0-9][a-z0-9-]{0,31}$/`
- `packages/yonder-core/src/daemon/routes.ts:302` — the same, restated
- `packages/yonder-core/src/console/whep.ts:40` — `/^[a-z0-9][a-z0-9-]{0,39}$/` (32 + `-preview`)

Both restatements carry a comment saying the two *"are checked against each other by hand"*. The
module-graph reason for not importing the schema is sound and well argued — and it applies to
the **source**, not the tests. No test imports both.

Widen `CameraId` (say to 63 chars, or to admit `_`) and a legitimately configured camera gets
`404 no such camera` from the daemon and a 404 from the WHEP proxy — a blank picture and a page
that says the camera does not exist. Nothing goes red.

A test in `whep.test.ts` and `routes.test.ts` may import zod freely: assert that the longest
legal `CameraId` plus `-preview` matches `MEDIA_PATH`, and that `CAMERA_ID` and the schema agree
on a sample of accept/reject cases.

## S10 · `GET /cameras` refuses to answer when `config.yaml` is the thing that is broken

`packages/yonder-core/src/daemon/routes.ts:774` calls `loadConfig(deps.configPath)`, and a
`ConfigError` falls to the catch-all at `:988`, which answers **400**. So an operator whose
`config.yaml` has one bad camera field loses the Cameras page — the page that lists what
hardware is attached and what was rejected and why, which is what they need in order to fix the
file.

The route's own detection half (`deps.cameras.detect()`) needs no configuration at all. It
should answer with `found` and `rejected` and say the configuration could not be read, rather
than refusing. Compare `GET /status` at `:729`, deliberately placed in front of the gate for
exactly this reason. (Ledger, Task 15; the implementer was right to defer it and right to flag
it.)

## S11 · `flows.test.ts` does not enforce the half of CLAUDE.md rule 2 this branch is most exposed to

`packages/yonder-core/src/flows.test.ts` — 80 tests, all green. Mutation results:

| Mutation to `flows.json` | Result |
|---|---|
| add a `function` node | **3 tests red** |
| add an `exec` node | **1 test red** |
| `ui-template` carrying markup, on a camera page | **80/80 green** |
| `ui-template` carrying an inline `<script>` | **80/80 green** |
| `ui-markdown` with pasted HTML on a camera page | **80/80 green** |
| a `change` node's JSONata replaced with `$merge` + ternary + arithmetic + concat | **80/80 green** |

The behaviour half of the rule is machine-enforced; the **presentation** half — *"never markup
pasted into a `ui-template`"* — is enforced by review only. The branch complies; the guard does
not. Why each check misses it: `:82` and `:853` filter `type === "function"` only;
`EXCLUDED_NODES` (`console/settings.ts:148`) cannot list `ui-template` because Dashboard
registers it; `contribTypes()` at `:169` is an inclusion check scoped to `yonder-*`; the
"carries no prose" check at `:324` is scoped to the Network page; the stylesheet check at `:502`
is scoped to `id === "style-link"`, so a *second* `ui-template` is invisible to it.

A check that the only `ui-template` is `style-link` and that its body is the `@import` would
close it in three lines.

## S12 · Setup's group legends use the spec's three-kind vocabulary for a fourth thing

The Setup deck (`docs/console/capture/camera-setup.day.png`) draws:

- **RESTARTS THE PICTURE** — Rate (fps), Preview (kb/s)
- **STORED IN CONFIG.YAML** — Bitrate (kb/s)

The spec's own table puts **bitrate** under *restarts the picture* and is emphatic: *"Bitrate
restarts the picture, and that is a decision rather than a limitation."* And rate and preview are
equally "stored in config.yaml". The split the page actually draws is exempt-vs-load-bearing —
a real and useful distinction, wearing the labels of a different one.

The operator consequence: a bitrate change drops the picture and the legend does not say so,
while R-CTL-08/09 (*"the page says which is which"*) rest on that vocabulary meaning one thing.
Either add a fourth legend for the confirmation window, or move bitrate under *restarts the
picture* and mark the window some other way.

## S13 · `ui-number-input` posts an apply on blur

Task 16's own concern (4), and worth acting on rather than only recording: tabbing out of the
Bitrate field arms a 120-second confirmation window, during which `BUSY` refuses **every other
apply**, a network change included. The spec names that consequence itself: *"an unconfirmed
camera apply refuses every other apply for two minutes, a network change included — which on a
flying aircraft is the wrong thing to be locked out of."* An accidental blur should not be able
to cause it.

---

# Worth knowing

## W1 · Parser robustness beyond the bench's camera

All in `packages/yonder-core/src/video/probe/parse.ts`, none reachable through today's
`execFile`-based runner with today's camera, all one input away:

- **`:19`, `:55`** — `/\(([\d.]+)\s*fps\)/` accepts `1.2.3` → `NaN`, and `(0.000 fps)` → `0`.
  Verified output `rates: [0, NaN, 30]` — **not** largest-first, because the comparator
  `(a,b)=>b-a` returns `NaN`. Line 32 promises *"Largest first, so a picker's first entry is the
  best the camera offers"*; here it is 0 fps. Guard with `Number.isFinite(fps) && fps > 0`.
- **`:18`, `:48`** — `Size: Discrete 0x0` is accepted and emits a 0×0 format; nothing filters it.
- **`:61`, `:65`** — `parseControls` returns an **empty map** on CRLF input (`(.*)$` — `.` does
  not match `\r`, and `$` without `/m` anchors at end-of-string), while `parseFormats` and
  `parseDevices` survive. If `v4l2-ctl` output ever arrives over a pty, *every* control becomes
  `not-offered` and the page states them as facts the camera lacks — the wrong sentence under
  R-UI-15. `split(/\r?\n/)` at `:38`, `:65`, `:92` closes it.
- **`:18`** — `Size: Stepwise` / `Continuous` blocks are dropped entirely, so a camera that
  answered in full is rejected by `camera.ts:180` as *"this device offered no capture format"*.
- **`:95`** — `raw.replace(/\s*\(.*\)\s*:?\s*$/, "")` is leftmost-greedy, so
  `UVC Camera (046d:0825) (usb-0000:01:00.0-1.3):` becomes `"UVC Camera"` and two identical
  webcams show indistinguishable card strings. `/\s*\([^()]*\)\s*:?\s*$/` fixes it.

The ledger's suspicion that the **last** format block is not flushed is **wrong** — `parse.ts:57`
flushes after the loop, and deleting that flush is red. What is dropped is a block whose *fourcc*
the regex cannot read, which is M10.

## W2 · `probeEncoder`'s escape hatch and candidate range

`encoder.ts:65-76` — an override matching neither branch (`v4l2h264enc` with no device, `x264`,
wrong case, a typo) falls through to the probe with no signal, and `detail` then reports the
probe's answer as though it were the operator's. R-CAM-13's *"an operator may name one
explicitly to bypass the probe"* fails silently.

`encoder.ts:50` — `CANDIDATES` is hard-coded to `/dev/video10…17`. On Rockchip/Radxa the encoder
is elsewhere, so the probe returns `x264enc` with `detail: "this board offers no hardware
encoder"` — a false statement about the board rather than an unknown. Both matter at M6/M8, not
now.

## W3 · More dead tests

Beyond S3, S6 and S11:

- `present.test.ts:74` — `camera({ id: "gimbal", name: "Gimbal", bitrate_kbps: 2000 })` against a
  base whose default is already 2000 (`:29`). Deleting the override is green; changing it to 4000
  is red. The test reads as *"two cameras at different rates"* and is two identical cameras.
  Third instance of this pattern on the branch.
- `settings.ts:78` and `:92` return the identical error, and each is green when removed alone —
  only removing both is red. Two guards, neither load-bearing.
- `supply.test.ts` never checks `DIRTY` (`supply.ts:42` — the documented *"every flag set rather
  than none… the safe direction to be wrong in"*) nor the unnamed-bit rule (`:66`,
  `clean: bits === 0`, whose stated purpose is that *bit 3, the soft temperature limit*, is a bit
  this code cannot vouch for). The fixture list `["", "throttled=", "not a number", "0xZZ"]`
  looks like case coverage and is not: the `/i` flag and the `Number.isFinite` guard are both
  green.
- `camera.test.ts` never covers an H.264 camera, so `COMPRESSED` containing `H264`/`HEVC`
  (`camera.ts:77`) is unverified — and H.264 is the most likely flyable source.
- `video/src/nodes.test.ts:254` — `expect(msg.payload).toBeDefined()` on a path that sends
  `payload: null`; `expect(null).toBeDefined()` passes. Also `:208`, `:231`, and `:259-262`,
  where the address fixture `"10.147.17.42"` is its own `encodeURIComponent` output, so the
  encoding assertion is inert.
- `dashboard/src/nodes.test.ts:336-341` is an identical `build()` call to `:328-334` asserting a
  strict subset; `:352`'s comment names a *"try live again"* control that does not exist.
- `ui/facts.component.test.ts:91-102` is `not.toBe`/`not.toEqual` on values already pinned
  exactly at `:66-67` and `:77-78`.
- `parse.test.ts:82-83` and `:99-101` are subsumed by the `toEqual` on the following lines.
- `media/config.test.ts:143-148` asserts `paths` has no `all_others` key — unreachable by
  construction, since `CameraId` excludes `_`. A statement of intent, not a live guard.
  (mediamtx's catch-alls are `all`, `all_others` and `~^`-prefixed regexes; one of the three is
  named.)
- `flows.test.ts:1141` and `:1157` iterate a `.filter(...)` with **no length assertion**, unlike
  their neighbour at `:1176`; `:333`'s word budget uses `Math.max(...prose)`, so an empty array
  gives `-Infinity` and passes.

## W4 · An order dependency this branch made riskier

`flows.test.ts` (~`:640`) uses `flows.find((n) => n.type === "ui-notification")` for the
join-toast assertions. This branch added two more (`toast-cam-confirm`, `toast-cam-kept`), so
there are now three; it still resolves correctly only because `join-toast` happens to sit at a
lower array index. Reorder the file and those assertions silently retarget a camera toast.

## W5 · No test file in this repository is typechecked, and `flows.test.ts` carries a real type error

`packages/yonder-core/src/flows.test.ts:3` and `:8` both import `THEME_HREF` from
`./console/settings.js` — `TS2300: Duplicate identifier`. It never fails CI because every
`tsconfig.json` excludes `src/**/*.test.ts` and no `vitest.config.ts` has a `typecheck` block.
Confirmed by injecting `const x: number = "s";` into `capability.test.ts`: vitest stayed green
**and `tsc --noEmit` exited 0**.

Consequence for this branch: `video/capability.test.ts:16-22` — *"narrows on state, so a value
cannot be read off a capability that has none"* — is carried entirely by an `@ts-expect-error`
that is never evaluated. Only line 21 is load-bearing, and a mutation making `notOffered()`
actually return a `value` is green.

Turning it on is not a one-line change: with `exclude` removed, `settings.test.ts:69`,
`console/theme.test.ts:244`, `daemon/routes.test.ts:1022`, `flows.test.ts:3`,
`fs/durable.test.ts:121` and `net/join.test.ts:119` are all type errors today.

## W6 · Documentation this branch falsified or left stale

Each is a sentence a reader would act on:

- `docs/configuration.md:154-156` — *"**Schema only, so far.** … nothing yet turns it into a
  running stream — that lands through M4."* This branch **is** M4 and does exactly that.
- `docs/configuration.md:192-196` + `:219-221` — the `remote:` block sits under *"Sections that
  arrive with later milestones"*, whose lead says such sections are *"rejected by the schema"*.
  Verified against the shipped `ConfigSchema`: `vehicle`, `mavlink`, `network` and `gpio` are
  rejected; **`remote` is accepted** — M2a shipped 2026-09-02. The one section that works is
  filed under "do not use yet".
- `docs/configuration.md:233-234` describes the browser preview and a ground-station feed as two
  `outputs[]` entries. `CameraOutput` is `rtp | rtsp | srt` (`schema/config.ts:208-220`); the
  browser copy is the separate `preview:` object. `media/config.test.ts:150-155` proves it.
- `docs/hardware/usb-camera-on-a-pi-4.md:210-211` — *"`architecture.md` currently implies it
  does"*. `architecture.md:138-144` was corrected **in this same range** (`0386f0b`), so the
  cross-reference is now false.
- `docs/hardware/usb-camera-on-a-pi-4.md:359-362` — under "What has not been tested":
  *"A browser playing any of it."* Falsified by this range's own head commit. An underclaim, but
  still wrong.
- `packages/yonder-core/src/media/config.test.ts:160` names `/etc/yonder/mediamtx.yml`; the real
  path is `/etc/mediamtx/mediamtx.yml`.
- `packages/yonder-core/src/docs.test.ts` validates only the fenced block marked
  `<!-- yonder:reference-config -->`, which contains no `cameras:` key. The cameras example is a
  separate fence and is never checked, so the drift `4cd7331` fixed by hand can silently recur.
  Adding `cameras:` to the reference block closes it.

## W7 · Bus-id-shaped `device` values still in shipped tests

`schema/config.test.ts:192` (`usb-0000:01:00.0-1.2` — also the stale `-1.2` socket `61857df`
removed from the docs), `apply/reachability.test.ts:119` and `:156` (a third instance the ledger
missed). Valid as opaque strings for what those tests assert, but they teach a format that
resolves to nothing. The plan's literals were corrected in `240a9f9`; the shipped tests were
missed.

Related: `plans/2026-09-03-m4-camera-view.md:1027` states *"Its `by-path` is
`usb-0000:01:00.0-1.3`"*, contradicting line 307 of the same document.
`docs/hardware/usb-camera-on-a-pi-4.md:355-358` names the same string as the identity tiebreak,
which now sits beside code that resolves `/dev/v4l/by-path/`.

## W8 · Small things in the components

- `YonderPicture.vue:232` — `this.props.stillsAfterMs || 12000` discards a configured `0`, which
  `picture.ts:25` goes to some trouble (`num`) to preserve. Negatives unclamped.
- `YonderPicture.vue:324` — `setMode` has no same-mode short circuit (`setRate` at `:320` does),
  so a repeated `mode:live` tears down a working connection. It also emits
  `widget-action mode:<mode>` for a mode it was *told* to enter, creating the loop its own
  docstring at `:179-182` warns wiring must avoid.
- `YonderPicture.vue:133-137` — `streamPath` is a computed with no watcher, and Dashboard merges
  `msg.ui_update` into props, so a runtime `path` change would stream the old camera under the
  new label. No shipped flow does this today.
- `YonderPicture.vue:241`, `:335` — "stills" fetches one image, once; no interval re-fetches it,
  and `:139` zeroes `staleFor` outside live mode, so the still has no age, no hatch and no
  degrade. `picture.html:46-49` calls this *"falls back to stills"*; it is one still, held for
  ever.
- `YonderFacts.vue:7` — the binary ternary has no third arm, so any state that is not
  `advertised` renders as **"this camera has none"**, unstyled. A partial fact, or a state
  `capability.ts` gains later, becomes the console asserting a camera lacks something it knows
  nothing about. `shapes.ts:45-58` names this failure and fixes it by importing the type, but the
  `.vue` template is untyped JS so the mitigation never reaches where the failure happens.
- `YonderBudget.vue` — every defensive guard is untested: the `|| 1` that prevents
  `100 * x / 0` producing `NaN%`, the `Math.min(100, …)` clamp, the `|| Infinity`, and the `|| 0`
  that keeps `"NaN of 8.0 Mb/s"` off the screen. `budget.component.test.ts:58` exercises the
  zero-capacity path but asserts only the label.
- `YonderHoldKey.vue` — the unmount `removeEventListener` and the `document.hidden` check are
  both unguarded (the four release paths and the duplicate-collapse guards *are* well covered).
  There is also no keyboard path: Space on a `<button>` fires `click`, not `pointerdown`, so the
  full-rate key is mouse and touch only.
- `YonderPicture.vue:271` and `receive-line.ts:30-34` interpolate ids into request paths without
  encoding. Not exploitable — `whep.ts:40,77` defends the server side — but a name with a space
  or `#` becomes a 404 the picture reports as *"this camera is not streaming; start it on the
  rail"*, which is the wrong reason. `receive-line.ts:33` encodes `msg.address` and not the id,
  in the same template literal.

## W9 · `present.ts:227-228` can emit the empty string its own docstring forbids

`startCheck: view.refusal ?? "…"` passes `""` through, and `:178` says *"Always a sentence, never
an empty string. A row labelled 'cannot start' with nothing after it reads as* this camera cannot
start *— the opposite of what a null refusal means."* `runWords` at `:188` guards exactly this
case for `reason`, so the intent is established. Not reachable today — every non-null return from
`refuse()` is a non-empty template literal — but `??` should be `||`, and the same at `:228` for
`device`. This is the bug Task 16's images already caught once ("Cannot start" with an empty
value saying the opposite of the truth); the guard went into the page, not into the source.

## W10 · Miscellany

- `summarise()` (`present.ts:143-149`) renders `whiteBalance: yes` into the Cameras index — the
  only place on the console showing a camelCase field name to an operator. `LABELS` at `:110-122`
  already holds the words for all eleven.
- `apply-config` (`yonder-apply`) is fed by nothing in the shipped flows, and was before this
  change — the theme goes through `yonder-theme`. Same shape as K-30 was.
- `scripts/verify-pages.sh:321-322` omits `node-red-contrib-yonder-remote` from the by-name
  package list the other three sites carry. Pre-existing; the new video package **is** present in
  all four (root `package.json` `build` and `lint`, `installer/roles/30-console.sh:90-92`,
  `verify-pages.sh:321-322`, `flows.test.ts:47-51`).
- `CLAUDE.md:100` says *"156 numbered requirements"*; the file now holds 187 (177 before this
  branch). The status block still ends at *"M2b — Tailscale — not started"*.
- Line-number citations across documents go stale silently: `reviews/…-camera-view-review.md:113`
  cites `roadmap.md:251-253` (now 264-268) and `:296` (now 309); `known-issues.md:857` cites
  `roadmap.md:276` (now 349). This branch added 22 lines to `roadmap.md`. Citing headings would
  end the class.
- **Opinion:** the day palette draws the picture's empty frame in near-white, so a camera that is
  not streaming is a very large cream rectangle with one line of text at the bottom (visible in
  `camera-live.day.png`). Consistent with "day is the chart"; wants a look from somebody who has
  stood in sunlight with the board.

## W11 · Things this review confirmed are sound

Recorded because they were checked and it is worth knowing they were:

- **The WHEP proxy.** No path to the video bypasses the console credential. WebRTC signalling is
  loopback-only; the media UDP port carries ICE credentials from a handshake that required a
  session; RTSP requires the generated per-device credential; publish is loopback-only; RTMP,
  HLS, MoQ, API, metrics, pprof and playback are all explicitly off. The credential check
  precedes any body read. The `location` header is rewritten rather than relayed. The traversal
  guard is a pattern, not a filter, and is genuinely exercised (`"a b"` and `"cam0%2f.."` hit
  `MEDIA_PATH`; deleting it turns those red). **The one gap is SRT (M4), which does not go
  through mediamtx at all.**
- **Untrusted input to command lines.** Camera ids are matched against `CAMERA_ID` before the
  configuration is even read (`routes.ts:810-816`). `controls.ts` passes an argv array with a
  clamped number and a probe-resolved `/dev/videoN`, never a shell string.
- **`settings.ts` is clean.** `__proto__`, `constructor` and `prototype` from a parsed body are
  all refused by the allowlist at `:84-88` before any write, with no global pollution;
  `id`/`device`/`source`/`name`/`outputs` likewise; a non-object body never throws. It correctly
  does *not* run the schema itself — `apply/engine.ts:212` runs `withoutRetiredKeys` and then
  `ConfigSchema.safeParse` on exactly this document, and `retired.test.ts`'s call-site
  enumeration keeps that true.
- **`bypath.ts` is clean.** The two-names-per-node tie-break is `[...names].sort()[0]`, a plain
  code-unit sort independent of readdir order (both mutations red). Relative and absolute symlink
  targets both resolve via `posix.resolve`. A missing directory yields the visible
  `byPathStable: false` fallback.
- **`supply.ts`'s bit mapping is correct and pinned** — bits 0/1/2 now, 16/17/18 since boot; both
  mutations red. Hex parsing rejects a missing or malformed prefix into `unreadable`, and a
  command failure into `null`.
- **The mediamtx posture** was probed from a second machine rather than argued (RTSP and WebRTC),
  and the deprecated per-path credentials are asserted absent by string match.
- **The installer and units** are careful: `yonder-media` is its own account and deliberately not
  in group `yonder` (K-01); `/etc/mediamtx` is `2750 root:yonder-media` with the setgid bit
  asserted as a post-condition; `assert_daemon_can_write` ties `ReadWritePaths` to
  `MEDIA_CONFIG_PATH`; the role refuses to stop a media server the daemon owns.
- **`make-payload.sh`** pins mediamtx by recorded SHA-256, cross-checks it against the published
  `checksums.sha256`, and states plainly that agreement between two files on the same host proves
  only that nobody bumped the version without re-reading the hash. It drops the vendor's example
  configuration on purpose.
- **Requirements traceability is clean.** All ten new requirements exist with text and priority
  byte-identical to the spec's §9 table; roadmap placement matches; no ID removed, renumbered or
  reused (177 → 187); **zero dangling `R-` citations** across 68 distinct ids in changed files.
- **SPDX: clean.** 203/203 `.ts`, 11/11 `.vue`, 5/5 `.mjs`, 18/18 `.sh`, 3/3 `.service`,
  31/31 `.html`. `.json` carries none anywhere, which is the repo's convention.
- **Commits: clean.** 42/42 GPG-signed (`%G? == G`), 42/42 `Signed-off-by`.
- **`flows/flows.json` complies with rule 2.** Zero `function` nodes, zero `exec`, one
  pre-existing `ui-template` holding a 34-character `@import`, two pre-existing `ui-markdown`
  nodes of static prose on non-camera pages. Every JSONata expression the branch added is a field
  reference or a static object wrapper. All new presentation is `ui-yonder-*` instruments backed
  by real Vue SFCs with component tests. `functionExternalModules: false` and `nodesExcludes`
  untouched. No `v-html`, `innerHTML`, `new Function` or `eval` anywhere in either package.
- **The roadmap does not overclaim.** `roadmap.md:264` "Done when:" is unchanged and unticked,
  and the only added claim — "Entry gate: passed" for R-VID-13 — is backed by the measured
  section in the hardware note. The ledger's two honest shortfalls are recorded and contradicted
  nowhere in the tree.
- **`nodes.test.ts:273-284`** in the video package enforces the no-filesystem invariant
  structurally. A genuinely good test.

---

# Triage of the ledger's deferred list

Every item the ledger parks, with a decision.

| # | Item (ledger) | Decision | Reason |
|---|---|---|---|
| 1 | Task 1 — the `-1.2` vs `-1.3` by-path in a schema doc comment | **Not before merge** | Already fixed: `schema/config.ts:176-177` carries a real by-path name and an explicit "Not the bus id" paragraph. The stale value survives only in tests — see #6. |
| 2 | Task 1 — `Preview` not exported as a type | **Not before merge** | Nothing through Task 16 imports it; an unexported type has no failure mode. Export it when something needs it. |
| 3 | Task 2 — two stale spots in `docs/configuration.md` (`remote:` under "later milestones"; the outputs note) | **Fix before merge** — promoted | Both verified against the shipped schema (**W6**). The `remote:` one tells an operator that a section which *works today* will be rejected; the outputs one describes a shape that does not exist. One-line edits, read by people setting up devices. |
| 4 | Task 3 — `tsc` does not cover `*.test.ts` anywhere | **Not before merge** (repo-wide, pre-existing) | Real, and worth a chip, but it predates this branch and fixing it means a `tsconfig.test.json` per package plus six existing type errors (**W5**). Note the consequence meanwhile: an `@ts-expect-error` in a test proves nothing. |
| 5 | Task 4 — nobody has replugged the camera into another socket to confirm identity follows | **Not before merge** | A bench check, not a code change, and `byPathStable` is rendered honestly either way. Owe it before M4 is called done. |
| 6 | Task 5 — bus-id-shaped `device` in `schema/config.test.ts:192` and `reachability.test.ts:119` | **Not before merge** (**W7**) | Valid as opaque strings for what those tests assert. Fix while you are in those files — and note `reachability.test.ts:156` is a third instance the ledger missed. |
| 7 | Task 9 — `media/config.test.ts` comment names the old `/etc/yonder/mediamtx.yml` | **Not before merge** | A comment in a test. Sweep it with #3; it is line 160, not 159. |
| 8 | Task 11 — the repo disagrees with itself about the old figures' supply state (Thermals row vs K-41) | **Not before merge — but answer it** | A question for the person who was there, not a code change. The new column reads "not checked per run", which is honest. Left unanswered, the older figures stay unusable. |
| 9 | Task 15 — `GET /cameras` 400s on an unloadable `config.yaml` | **Should fix** (**S10**) | Not merge-blocking — `/status` and the journal still work — but it hides the page that diagnoses the very file that is broken, and the detection half needs no configuration at all. |
| 10 | Task 15 — `systemSpawner` has no test | **Not before merge** | Correct by construction: no test in this repo may spawn a process, which is what `ProcessSpawner` exists for. Four lines on the far side of a seam, covered on hardware by Task 16. |
| 11 | Task 16 latent bug (a) — `camera.id` vs `output.path` | **Fix before merge** (**M6**) | Reachable from a plain configuration, silently accepted by the schema and by `refuse()`, and it kills the whole pipeline including the browser preview. The test that should catch it is neutered by a fixture where the two values are equal — proved by mutation, 15/15 green. |
| 12 | Task 16 latent bug (b) — static page, R-UI-15 in the unwatched direction | **Fix before merge** (**M9**) | Not latent: the committed capture and the committed fixture demonstrate it. Four controls the bench's own camera offers are absent with nothing said. The honest minimum — a fact for a `present` capability the page does not draw — is small and needs no new controls. **And it is not the whole of the "static wiring" problem: the hard-coded id `"front"` (M8) is the sharper half, and the ledger does not record it.** |
| 13 | Task 16 — `network.modem` rejected by this schema; collides with the cellular branch | **Not before merge — but it is the merge plan** | Nothing to fix here. A real, now-known conflict between two branches; the answer is `retired.ts` or a schema section on whichever merges second. Put it in the branch description so the person doing the merge meets it before a board does. |
| 14 | Task 14 — the budget hatches a segment only if it *starts* past capacity | **Should fix** (**S5**) — promoted | The ledger's "fine for M4's one-or-two segments" is wrong in the direction that matters: with **one** segment over capacity nothing is hatched at all, which is M4's normal case and R-VID-11's whole job. `budget.component.test.ts:99-107` locks it in. |
| 15 | Task 16 concern (4) — `ui-number-input` sends on blur | **Should fix** (**S13**) | An accidental blur arms a 120-second window that refuses every other apply, a network change included. The spec names that consequence itself. |
| 16 | Task 16 concern (5) — `apply-config` fed by nothing | **Not before merge** (**W10**) | Pre-existing, same shape as K-30. Worth a chip. |
| 17 | Task 16 concern (6) — `summarise()` prints field names | **Not before merge** (**W10**) | Cosmetic, and `LABELS` already holds the words. |
| 18 | Task 16 concern (7) — the day palette's near-white empty frame | **Not before merge** (**W10**) | An opinion until somebody has stood in sunlight with the board. |
| 19 | Task 12 — touch-specific double-send owed to real hardware | **Not before merge** | Task 12b closed the coverage gap that mattered (all seven mutations red, including the two previously silent). A touch device is a bench check. |
| 20 | Task 13 — board check skipped for the degrade, the reconnect and R-VID-09 | **Fix before merge** — promoted, and it is now **M1/M2/M3** | This is the item that mattered most. Task 13 correctly claimed nothing from a run it did not do, and all three bugs in `YonderPicture.vue` live in exactly the gap that run would have closed. Task 16 has since provided a console and a configured camera, so the blocker is gone. **Do this one with a browser open.** |
| 21 | Task 16 — the two ways it falls short of M4's exit criterion | **Not before merge** | Honestly reported and correctly *not* claimed in the roadmap. The remaining gap is a sign-in-and-watch click and a cellular link — both the user's, neither a code change. Do not tick "Done when:" until both are done. |
| 22 | Task 9 — board changed (mediamtx v1.20.1, `gstreamer1.0-rtsp`) | **Not before merge** | Authorised, bounded, undo recorded, and `50-mediamtx.sh` now installs both properly. Nothing owed but eventually removing them from the dev board if a clean-install test is wanted. |

**Not on the ledger's list, and found here:** the three `YonderPicture.vue` bugs (**M1**, **M2**,
**M3**), the SRT output (**M4**, **M5**), the supervisor's uncancelled retry (**M7**), the
hard-coded `"front"` (**M8**), the parser's fourcc bleed (**M10**), the unanchored codec pattern
(**M11**), the frozen cost strings (**M12**), and the board address in `receive.test.ts`
(**M13**).

---

## A note on where the defects are

Two patterns account for most of this list.

**A fact the packages compute, restated in wiring.** M6, M8 and M12 are the same mistake: the
camera id, the two cost strings, and the mediamtx path that restates `camera.id` where the
pipeline uses `output.path`. CLAUDE.md rule 2 forbids *logic* in `flows.json` and this branch
obeys it scrupulously — zero `function` nodes, no markup, every JSONata expression a field
reference. What the branch shows is that the rule has a second half nobody wrote down: **a value
the packages derive must not be restated in wiring either.** A `cost` prop that can only come
from `config` is a derived value with no way to arrive; that is a package-design problem before it
is a wiring problem.

**A guard that is right for the one camera on the bench.** M9, M10 and M11 all pass against the
Global Shutter fixture and fail against the next device: a camera that offers zoom, a fourcc with
a trailing space, a card string containing "Display". The fixture is genuinely valuable — it is
what gives the capture gate a camera at all — but it is now the only camera anything is checked
against, and three defects hid behind it. A second fixture, deliberately unlike the first, would
have caught all three.

The `YonderPicture.vue` cluster has a third cause and the plainest lesson: it is the one
component that was never run against a real stream, and its test suite mistook the passage of
time for the loss of a picture. M1 in particular is not a subtle bug — it is visible within three
seconds of opening the page — and nothing in the branch's verification could see it, because the
capture gate has no media server and the hardware proof went around the component rather than
through it.

---

# The scoped re-review of the fix wave

**Range:** `1279296..ee7e1aa` · six commits, 34 files, +1853/−154
**Reviewed:** 2026-09-04 · scope limited to the thirteen must-fix findings and breakage
introduced by these six commits.
**Gates re-run here, not taken on report:** `npm test` exit 0 — 1527 tests across six
workspaces; `npm run lint` clean; `./scripts/verify-pages.sh` **55 passed / 0 failed**, both
palettes, every committed capture and shape in sync; 6/6 commits GPG-signed (`%G? == G`) and
6/6 carry `Signed-off-by`. Working tree clean at start and end; every mutation was run in an
isolated copy of the tree outside the repository, so no tracked file was modified at any point.

---

## Verdict

**The fix wave is complete.** All thirteen must-fix findings are addressed, and the four
departures from the review's proposals are each better than what was proposed — three of the
four arguments are correct outright, and the fourth (M2) reaches the right implementation from
a claim that is overstated.

Two things are left open and neither blocks the merge: a stale-backoff sibling of M2 that
reproduces M2's own headline failure by a different route and is newly reachable through a code
path this diff added, and a two-second window at first paint where the FULL RATE key is
enabled with no cost on it.

The quality of the fix work is high. Nine of the thirteen fixes are pinned by tests that a
mutation turns red, and the rewritten tests are the strongest part of it: every test that had
asserted the old buggy behaviour now asserts the correct behaviour and fails when the bug is
restored. That was the specific risk in a wave of this shape and it did not materialise.

---

# Job 1 — the thirteen

## M1 · A healthy live picture read "no contact" — **ADDRESSED**

`lastFrameAt` is written only by the video element's `timeupdate`; `ontrack` now sets
`srcObject` and nothing else.

**Mutation-checked (the finding named this as high-risk).**

| mutation | result |
|---|---|
| restore the exact pre-fix code — `ontrack` sole writer, no `timeupdate` listener | **3 red**, including both new tests: *does not degrade a picture that is still arriving*, *starts counting from the last frame, not from the handshake* |
| put `lastFrameAt = Date.now()` back in `ontrack`, keep `timeupdate` | **1 red** — *falls back when the negotiation succeeded and no frame ever arrived* (the R-VID-14 half) |
| remove only the `timeupdate` registration | **10 red** |

The R-VID-14 repair the fixer claims is real and is pinned independently: the "no frame ever
arrived" test now delivers a track before waiting, so a component that took `ontrack` for a
picture fails it.

**Rewritten tests pin the correct behaviour.** The `live()` helper delivers frames as well as a
track, and the four degrade tests are about frames *stopping* rather than about the clock
running. Two new tests hold the other direction (ninety seconds of arriving frames degrade
nothing; the count starts from the last frame). Restoring the bug fails them.

## M2 · An abandoned handshake wrote a false reason and its retry killed the live session — **ADDRESSED**, with a residual that reproduces the same failure

An `AbortController` per attempt, aborted in `teardown()`, plus a session counter bumped in
`teardown()` and captured after it in `connect()`. `mine()` is checked after four of the five
awaits, at the top of the `catch`, in `ontrack` and in `onconnectionstatechange`.

| mutation | result |
|---|---|
| no `session += 1` in `teardown()` | **3 red** |
| `catch` no longer checks `mine()` | **2 red** |
| no `signal` on the fetch | **1 red** |
| no `mine()` after the fetch await | **1 red** |

`teardown()` is the only bump site and is reached by `connect()`, `toStills()`, `setMode()`'s
non-live branch and `beforeUnmount`, so no path starts a new attempt without bumping. The
"off" case is clean — `setMode('off')` clears both timers, tears down, blanks and clears
`reason`, all synchronously.

**Adjudication of the contested claim: see the Adjudications section — the proxy claim is
correct in the test harness and wrong for a real browser, but the counter was still the right
choice.**

**Residual, and it is the finding's own headline failure.** `requestLive()` clears
`stillsTimer` but never `retryTimer`, and neither does `teardown()`. A backoff armed by a
genuinely failed earlier attempt therefore survives `setRate()` and survives the new
`streamPath` watcher, fires into `connect()`, and tears down the session that has just come
up. Reproduced twice against the shipped component:

```
FULL RATE pressed inside a pending backoff
  urls: /video/cam0-preview/whep, /video/cam0/whep, /video/cam0/whep
  pcs: 3   fullRateSessionClosed: true

ordinary startup — daemon slow, first negotiation 503s, first read then names the camera
  urls: /video/cam0-preview/whep, /video/nose-preview/whep, /video/nose-preview/whep
  pcs: 3   liveSessionClosed: true
```

The first is *"the key dropped the picture it was pressed for"* verbatim. The `requestLive()`
omission is pre-existing — identical at `1279296` — so it is not breakage this diff created,
but the second repro runs through the `streamPath` watcher that **is** new here, which puts it
on the ordinary startup path rather than only behind an operator's key press. The session
counter cannot catch it, because the timer calls `connect()` directly rather than resuming a
guarded continuation.

One line in `requestLive()` (or in `teardown()`) closes it. It is exactly the fix M7 applied to
`Supervisor.start()` in this same wave — same bug shape, same commit range, fixed in one place
and not the other. No existing test covers it: the three abandoned-handshake tests all use
`reply = "gated"`, so no attempt ever fails and no backoff is ever armed.

Second, smaller: the `catch` does not name-check `AbortError`. Its correctness rests entirely
on `session += 1` executing immediately before `abort.abort()`, with `abort()` having exactly
one call site. Correct today; a reorder or a second abort site silently reintroduces a false
reason. An explicit `if (e.name === 'AbortError') return` would make it robust.

## M3 · `teardown()` never released the `<video>` — **ADDRESSED**

`blank()` is split from `teardown()`, and the split is right: a reconnect must not delete the
last frame between attempts.

| mutation | result |
|---|---|
| `blank()` made a no-op | **2 red** — *lets go of the last live frame, rather than freezing it under 'off'*, and the stills case |
| `blank()` moved into `teardown()` (blanks on reconnect too) | **1 red** — *does not blank the picture it is reconnecting to replace* |
| drop the `blank()` in `toStills()` | **48 green — survived** |

The survivor is defensive rather than load-bearing: `toStills()` is reachable only with
`lastFrameAt === null`, which is the state in which nothing has painted, so there is no frame
to release. Harmless, but it is inconsistent with the fix report's claim that *"where a
mutation stayed green the guard was either given a test that could see it or removed"* — this
one is neither.

## M4 · An SRT output opened an unauthenticated listener — **ADDRESSED**

| mutation | result |
|---|---|
| delete the `refuse()` SRT guard | **2 red** |
| restore the old `srtsink` in place of the `throw` | **1 red** |
| `media/config.ts` turns the SRT server back on for an `srt` output | **1 red** |

**The wiring is right, not just the string.** `POST /cameras/:id/run`
(`packages/yonder-core/src/daemon/routes.ts:503-505`) computes `refusal` through the same
`view()` the page reads and returns `400` with the operator sentence **before** `compose()` is
called. So the `throw` in `sink()` is genuinely unreachable in production and the operator gets
a clean refusal, not a 500.

Keeping `srt` in `CameraOutput` rather than deleting it is the right call for the reason
given — it is what gives M5's guard something to guard, and it lets a configuration already
holding one load and be corrected.

Coverage gap, not a defect: nothing in `routes.test.ts` mentions SRT, so the
refuse-before-compose ordering the safety argument rests on is pinned only by inspection.

## M5 · An SRT output on 8890 took every camera off the air — **ADDRESSED**

| mutation | result |
|---|---|
| delete the collision guard | **1 red** |
| widen it to `rtp` as well (the over-broad direction) | **1 red** — *leaves a ground station's own port alone* |
| drop `SRT_PORT` from `BOUND_ON_THIS_DEVICE` | **1 red** |
| drop the `<id>-preview` media-path claim | **1 red** — *refuses two cameras that would publish to one media path* |

The test loops all four ports rather than asserting one, imports them from `media/ports.ts`
rather than restating literals, and asserts the negative direction in two places (port 9998
accepted; an `rtp` output on 8554 accepted). The narrowing to `srt` only is correct — an `rtp`
port names a socket on the ground station, and `udpsink` binds nothing here.

## M6 · `camera.id` in one file, `output.path` in another — **ADDRESSED**, and the departure was right

The set-equality test **does** fail when the composed `location=` and the declared paths
disagree, in both directions:

| mutation | result |
|---|---|
| `media/config.ts` declares `<id>-full` instead of `<id>` | **2 red** |
| pipeline publishes full rate to `<id>-full` | **1 red** — *declares exactly the paths the pipeline publishes to, and no others* |
| pipeline publishes preview to `<id>-prev` | **1 red** — same test |
| `media/config.ts` gates the full-rate path on `rtp` instead of `rtsp` | **3 red** |

The swap that left 15/15 green in the original review cannot be expressed any more — the field
it swapped no longer exists.

**Adjudication: the fixer is right, and see the Adjudications section for the evidence.**

## M7 · `start()` did not cancel a pending retry — **ADDRESSED**, and the unreachability claim is correct

The two lines are at the top of `start()`. The new test is pinned **twice**: a verbatim copy of
`Supervisor` with those two lines deleted produces 3 spawns where the test asserts 2, and
leaves the first process unkilled where the test asserts which one `stop()` kills.

**The declined half is genuinely unreachable.** The invariant is
`entry.proc !== null ⇒ state ∈ {starting, running}`, and it is structural: `spawn()` sets
`state = "starting"` *before* assigning `entry.proc`, `ended()` nulls `proc` before both of its
`failed` writes, and `stop()` nulls it synchronously. Attacked with `error` instead of `exit`,
a forced second event on one child, the gave-up branch, `stop()` during `starting`, three
`start()` calls in one tick, and a spawner whose `kill()` delivers `exit` inline — then a
seeded fuzz of 400 runs × 40 steps over two cameras, asserting the invariant and an orphan
count after every step. **368 `start()` calls landed on `failed` with a retry genuinely armed;
zero invariant violations, zero orphans.** Review part (b) would be dead code.

The settle-timer clear is correctly dropped too, for two independent reasons: no path reaches
`spawn()` with an armed settle (measured — exactly one pending timer either side), and a leaked
settle callback is inert because it closes over its own `proc` and returns on
`entry.proc !== proc`.

## M8 · Five nodes hard-coded the camera id `"front"` — **ADDRESSED**

No `"front"` anywhere in `flows/flows.json`; all five `camera` fields are `""` and
`pic-camera.path` is `""`. `cameras-read` → `cam-identify` (a `change` node, jsonata
`(payload.found[id != null].id)[0]`) → `flow.camera`; five `cam-at-*` `change` nodes put it on
`msg.camera` in front of each camera node.

**`found[].id` is the right field** — `routes.ts:796` sets it to the configured camera whose
`device` matches the detected by-path name, `?? null` otherwise. So `id != null` genuinely
separates configured from merely attached, which is the half that made the page appear where it
could not work.

**CLAUDE.md rule 2 intact:** zero `function` nodes (37 `change`, 0 `function`); the JSONata does
selection only, never composition.

**Empty-camera failure is graceful, not a 404:** `adapter.ts`'s `cameraId()` returns null and
the node badges "no camera" without calling the daemon.

Bounded residuals, none blocking: with two cameras configured the page shows whichever the
kernel enumerated first (defensible for a one-camera milestone, but undocumented and
unasserted); a failed sweep clears `flow.camera` until it recovers; and `pic-camera.label` is
still the fixture's `"Front camera"` — inert, since the widget never renders it.

## M9 · R-UI-15 violated in a committed capture — **ADDRESSED**

| mutation | result |
|---|---|
| `DRAWN_CAPABILITIES` gains one the page does not draw | **2 red** (present + flows) |
| `DRAWN_CAPABILITIES` loses one the page does draw | **3 red** |
| restore the old behaviour — `present` emits no row | **2 red** |

The regenerated `docs/console/capture/camera-live.day.png` shows the group as **"NO CONTROL FOR
THESE"** with Zoom / Focus / Exposure / White balance reading *offered, not on this page* and
Rotation / Aim / Recording / Stills reading *this camera has none* — eight rows where the
pre-fix capture had four. The shape json carries geometry only; its single change is the facts
box `h: 168 → 228` in both palettes, and the page gate confirms nothing is clipped.

`undrawn` is declared once and re-exported through `presentation.ts` → `shapes.ts` → `facts.ts`,
so there is no second copy to drift, and `YonderFacts.vue` now has a lookup with a real
fallback rather than the binary ternary that would have rendered the new state as a false claim
about the camera.

`DRAWN_CAPABILITIES` is hand-maintained but genuinely coupled: `flows.test.ts` scans every
node's rules for `payload.capabilities.(\w+)` and asserts set equality. The coupling is by
convention — a control wired through a different property would drift silently — and the
`formats` exemption is hand-carved.

## M10 · A fourcc the parser could not read donated its sizes — **ADDRESSED**

| mutation | result |
|---|---|
| `FORMAT_LINE` back to `\w{4}` | **1 red** — *reads a fourcc with a trailing space* |
| `flush()` no longer drops the orphaned pending block | **1 red** — *never lends one format's sizes to the next one* |

Both halves independently pinned, with the greyscale-then-MJPEG input from the finding.

## M11 · The codec-rejection pattern rejected real cameras — **ADDRESSED**

All five named false rejections now pass; all four recorded Pi codecs are still rejected.
Every alternative in the pattern is load-bearing under mutation. **Adjudication and the
residual risk are in the Adjudications section.**

## M12 · The picture's and the hold key's costs were frozen literals — **ADDRESSED**

`cameraStrip()` computes `pictureCost`, `holdCost` and `fullRate`. The arithmetic is right —
`atIp(k) = round(k × 1.0335)`, so the fixture reproduces the old literals exactly (400 → 0.41,
2000 → 2.07) and **moves** (8000 → 8.27), which is the whole point. Both widgets prefer the
message over the editor prop, using the store-payload pattern eleven widgets in the package
already ship — the claim about `YonderBudget` and `YonderFacts` is confirmed, not merely
asserted.

`flows.test.ts` asserts `hold.cost === ""`, `picture.cost === ""`, `picture.path === ""`, and
that the values come from `payload.display.*`. A restored literal fails the first three.

The related half is fixed: `fullRate = camera.outputs.some(o => o.kind === "rtsp")` — keyed on
`kind` alone, so M6's removal of `path` does not affect detection.

Residual: see New breakage #2.

## M13 · The development board's address in a shipped unit test — **ADDRESSED**

`the development board` → `198.51.100.20` (RFC 5737) in `receive.test.ts`, with the note in the shape
`a7a2ee2` used. The plan document's copies are placeholders now (`yonder@<board>`,
`yonder@<address the controller gave you>`). Swept the whole tree: no board address remains in
`packages/`, `flows/`, `config/`, `installer/` or `scripts/`. The one surviving copy is in
`docs/superpowers/specs/2026-09-02-remote-access-design.md` (recorded `ip route` output),
pre-existing and outside this range — the fixer disclosed it, and M13's own text scoped itself
to what this branch added.

---

# Job 2 — new breakage

Only breakage in these six commits. Both entries are small and neither blocks the merge.

1. **A stale backoff tears down a session that has just come up, newly reachable on the
   ordinary startup path.** `requestLive()` never clears `retryTimer`, and the new `streamPath`
   watcher calls `requestLive()`. Daemon slow to start → first negotiation 503s → backoff armed
   → the first `camera-read` names the camera → new session connects and paints → the stale
   backoff fires and closes it. Reproduced. The omission is pre-existing; the new trigger is
   not. One line fixes it, and it is the same line M7 added to `Supervisor.start()` in this
   same wave.

2. **The FULL RATE key is enabled and shows no cost at all for roughly two seconds at first
   paint.** Both props are now `""` in the wiring, so `v-if="cost"` is false until the first
   read (`camera-poll` `onceDelay: 2` plus a round trip), while `available()` is
   `sent.available !== false` — undefined defaults to **true**. Observed directly: no
   `disabled` attribute, no `unavailable` class, no cost element. So on a camera with no RTSP
   output the key is briefly pressable, which is the 404 the fix's related half exists to
   prevent, and R-VID-11's *state the cost before it is asked* is unmet in that window. Also
   recurs after any failed read, since JSONata drops undefined keys and the payload becomes
   `{}`. Both defaults fail **open**; defaulting `available` to false and the cost to a
   placeholder would fail closed, which is the direction this file argues for elsewhere.

Nothing else. `npm run lint` is clean, no stale `output.path` reference survives anywhere,
`config/schema/yonder.schema.json` regenerates byte-identical to what is committed, the
committed fixture loads through the schema, and the page gate passes 55/55 with every capture
and shape in sync.

## Rewritten tests — the specific risk in a wave of this shape

Every test that had asserted the old buggy behaviour now asserts the correct behaviour and goes
red when the bug is restored. Checked one by one:

| rewritten test | judgement |
|---|---|
| `picture.component.test.ts` — the whole `the degrade, when contact goes` block | **Load-bearing.** `live()` now delivers frames; restoring the pre-fix component fails two of them. |
| `picture.component.test.ts` — `does not fall back when a frame has arrived` | **Load-bearing.** Delivers frames rather than a track. |
| `media/config.test.ts` — `turns SRT on only when an SRT output is configured` → `never turns the SRT server on` | **Load-bearing.** Asserts `false`; the mutation restoring `anySrt` fails it. |
| `flows.test.ts` — `expect(n.camera).toBe("front")` → `toBe("")` | **Load-bearing.** Fails on a restored literal. Minor gap: the feeder check greps for `"p":"camera"` and would accept `pt:"flow"`. |
| `flows.test.ts` — `hides the camera page when nothing is attached` | **Load-bearing.** Pins both the jsonata property and its `propertyType`. |
| `flows.test.ts` — the hold key's `toMatch(/Mb\/s/)` (which passed *because of* the frozen literal) | **Load-bearing** now. Small loss: the old units-case guard was dropped and nothing replaced it. |
| `present.test.ts` — `capabilityFacts` every-fact-is-`not-offered` | **Load-bearing.** The explicit `["Zoom","Focus","Exposure","White balance"]` assertion goes red on the old behaviour; a second test passes a different drawn set, so a hard-coded list is caught too. |
| `facts.component.test.ts` — pairwise `not.toBe` on two rows | **Strengthened** to three rows via `new Set(...).size === 3`, plus an unknown-state test that fails if the binary ternary returns. |
| `holdkey.component.test.ts` — `mountKey()` signature | **Safe.** Pre-existing press/release tests still call it with no payload and still pass, so state-machine coverage is unchanged. |

---

# Adjudications — the four contested fixes

## M2 — the Vue proxy claim: **overstated, but the implementation choice is right**

The fixer wrote *"`this.pc === pc` is always false: `data` is reactive, so `this.pc` hands back
a proxy."* Settled empirically by mounting the real component under the package's own
vitest/jsdom setup:

```
Object.prototype.toString.call(FakePeerConnection instance) → "[object Object]"
Object.prototype.toString.call(a Symbol.toStringTag-branded instance) → "[object RTCPeerConnection]"

this.pc === pc, plain fake              → false   isReactive(this.pc) → true
this.pc === pc, toStringTag-branded     → true    isReactive(this.pc) → false
toRaw(this.pc) === pc                   → true
```

The mechanism is Vue's `targetTypeMap`: assignment stores the raw object, and the read re-wraps
it **only if** `toRawType()` is `"Object"`. The suite's `FakePeerConnection` is a bare ES class,
so it is proxied and the review's guard is dead **in the test**. A real browser
`RTCPeerConnection` carries a WebIDL `Symbol.toStringTag`, is never proxied, and the review's
guard **would work in production**. Corroborating: if it were proxied, `teardown()`'s
`this.pc.close()` would already be throwing `Illegal invocation` on real hardware.

So the claim as written is false. The conclusion still stands: the guard could not have been
*tested* in this harness, and a counter is environment-independent. **Right implementation,
wrong stated reason** — worth correcting in the record so the reasoning is not reused.

## M6 — remove `path` rather than declare both: **the fixer is right**

Verified the argument rather than accepting it. `YonderPicture.vue:178-182` derives the
full-rate path by stripping `-preview` from the configured or told name — so the browser's
full-rate WHEP request is always `/video/<camera.id>/whep`. Declaring `paths[output.path]`
*as well as* `paths[camera.id]` would fix the ANNOUNCE (the pipeline publishes to
`output.path`, which mediamtx would then accept) and leave `<camera.id>` declared with
`source: publisher` and nothing publishing to it — so the full-rate key would get no stream.
Declaring it *instead of* would break the preview relationship `whep.ts`'s `MEDIA_PATH` and
`picture.ts` are both built on. "Declare both" moves the defect; removing the field closes it.

One name per camera is also what the rest of the branch was already written to, and the
second-order collision the review flagged (`nose` vs `nose-preview`) is now refused by
`superRefine`, mutation-checked red.

## M7 — the declined `entry.proc` kill: **the fixer is right**

Established above by state-machine mapping and fuzz. The claim rests on an ordering detail the
fixer did not spell out — `spawn()` sets `state = "starting"` before assigning `entry.proc` —
but it holds, and the review's part (b) would be dead code.

## M11 — the boundary regex and its replacement: **Claim A correct; Claim B correct for every case the finding named, over-claimed beyond it**

**Claim A is correct.** The review's proposed
`/(^|[^a-z])(codec|decoder?|encoder?|isp|hevc)([^a-z]|$)/i` **does** match
`USB Camera (H.264 Encoder)` — `Encoder` sits between a space and a `)`, both of which satisfy
`[^a-z]`. It fixes four of the five named false rejections and not the fifth. Declining it as
written was justified.

**Claim B holds for the finding's own lists** — 9/9 cameras accepted, 8/8 codecs rejected,
including all four recorded in the Pi fixture. Every alternative is load-bearing under
mutation, though each rests on exactly one test input and three of those inputs are invented
rather than recorded from a board. Note `Studio Display` does **not** exercise the whitespace
condition — neither word is an exact token — so `USB Camera (H.264 Encoder)` is its sole cover.

**The over-claim is "every hardware codec on this board".** The rule is exact for the Raspberry
Pi the fixtures came from. It is not exact for the other target CLAUDE.md names: on
Rockchip/Radxa the codec nodes are `rkvdec` (single letter-run, no exact token → accepted as a
camera) and hantro's `rockchip,rk3399-vpu-dec` (runs `rockchip, rk, vpu, dec` → accepted). A
codec with a human-readable card such as `Qualcomm Venus video decoder` is waived by the
whitespace condition despite literally containing the word "decoder", so the rationale *a card
with spaces is a product name* is empirically false.

That direction is **soft**, and the fixer argued for it deliberately and correctly: a
wrongly-accepted codec is rejected a moment later by the format probe with a true sentence,
whereas a wrongly-rejected camera is invisible under a false one. The asymmetry argument is
sound and I would not reopen it.

The direction that still has no backstop is the M11 failure itself — a whitespace-free capture
node with a standalone `isp` letter-run is invisible with a false reason. The one confirmed
instance is `sun6i-isp-capture` (Allwinner), which is **not** a board Yonder targets;
`rkisp1_mainpath`, the Radxa case the finding named, is accepted. So the residual is real but
does not reach a targeted board today. Testing letter-runs regardless of whitespace, with
`capture`/`main`/`self` treated as camera markers, would close both directions — worth a
should-fix, not a blocker.

Two accuracy notes on the fixer's own evidence: the test asserts `unicam-isp` is a codec, but
`unicam` is the Pi's CSI-2 **camera** receiver (`cap->card = "unicam"`, devices
`unicam-image` / `unicam-embedded`) — that fixture row is fabricated and points the wrong way.
And `camera.ts:97` calls `rkisp1_mainpath` a card string; it is the video-device name, the card
being `rkisp1`. Both are accepted, so neither is harmful.

---

# Observed, out of scope

None of these blocks anything; none is in the six commits.

- **`stop()` drops the process handle at SIGTERM time.** `Supervisor.stop()` sends one
  `SIGTERM`, nulls `entry.proc` on the next line, arms no escalation timer, and never looks at
  the child again. A `gst-launch-1.0` wedged on a USB camera that has gone away — precisely the
  `/dev/video*` failure mode M7 is about — is then unreferenced and alive, and the next
  `start()` yields two pipelines on the same node. Same end state as M7 by a different route.
  `stop()` is untouched by this diff, and this needs a larger change than M7 (retain the
  handle, arm a SIGKILL escalation, release on `exit`). Worth its own finding.
- **No route-level test for the SRT refusal.** `refuse()` is unit-tested and the ordering in
  `routes.ts` is correct, but nothing pins *`POST /cameras/:id/run` with an `srt` output returns
  400 rather than throwing*, which is what the M4 safety argument rests on.
- **The `-preview` suffix is still assembled in three places** (`picture.ts`,
  `YonderPicture.vue`, `media/config.ts`) — the fixer's own Concern 2. Nothing disagrees today
  and the pipeline is pinned against the media server, but the widget is pinned against
  neither. Same class as M6, one level down.
- **`docs/superpowers/specs/2026-09-02-remote-access-design.md`** still carries the board's LAN
  address in recorded `ip route` output. Pre-existing, disclosed, outside M13's scope.
- **A throwing spawner would wedge an entry in `starting` for ever**, since `spawn()` sets the
  state before calling it. Not reachable — `compose()` always makes `argv[0]` the literal
  `gst-launch-1.0`, and a missing binary is an async `error` event, which is handled. On the
  record only.
