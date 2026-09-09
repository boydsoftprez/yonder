// SPDX-License-Identifier: GPL-3.0-or-later
import YonderCockpit from "../src/ui/YonderCockpit.vue";
import {fixture as cockpitFixture} from "../cockpit/fixture.mjs";
import YonderAim from "../src/ui/YonderAim.vue";
import YonderAimPad from "../src/ui/YonderAimPad.vue";
import YonderAnnunciator from "../src/ui/YonderAnnunciator.vue";
import YonderBudget from "../src/ui/YonderBudget.vue";
import YonderCaptures from "../src/ui/YonderCaptures.vue";
import YonderColumn from "../src/ui/YonderColumn.vue";
import YonderDataBar from "../src/ui/YonderDataBar.vue";
import YonderDeck from "../src/ui/YonderDeck.vue";
import YonderFacts from "../src/ui/YonderFacts.vue";
import YonderFlow from "../src/ui/YonderFlow.vue";
import YonderGauge from "../src/ui/YonderGauge.vue";
import YonderHoldKey from "../src/ui/YonderHoldKey.vue";
import YonderIdentity from "../src/ui/YonderIdentity.vue";
import YonderIndex from "../src/ui/YonderIndex.vue";
import YonderPicker from "../src/ui/YonderPicker.vue";
import YonderPicture from "../src/ui/YonderPicture.vue";
import YonderPlacard from "../src/ui/YonderPlacard.vue";
import YonderPositionGauge from "../src/ui/YonderPositionGauge.vue";
import YonderReadout from "../src/ui/YonderReadout.vue";
import YonderSegmented from "../src/ui/YonderSegmented.vue";
import YonderSetBar from "../src/ui/YonderSetBar.vue";
import YonderShutter from "../src/ui/YonderShutter.vue";
import YonderSoftKeys from "../src/ui/YonderSoftKeys.vue";
import YonderSparkline from "../src/ui/YonderSparkline.vue";
import YonderStateOverlay from "../src/ui/YonderStateOverlay.vue";
import YonderTape from "../src/ui/YonderTape.vue";
import YonderTextField from "../src/ui/YonderTextField.vue";
import YonderThumbStrip from "../src/ui/YonderThumbStrip.vue";

/**
 * One specimen per shipped instrument (R-UI-25, CLAUDE.md rule 2).
 *
 * Every component below is imported from its real `.vue` file in `src/ui` —
 * never a built bundle — so this array shows what the source does today,
 * not what a build did the last time somebody remembered to run one.
 * `gallery.test.ts` holds both halves of that: one test that a specimen
 * exists for every component this package ships, and one that this file
 * never grows a path through a built bundle to get one.
 *
 * `props` and `payload` are chosen to draw a real, considered state of the
 * instrument, and the note beside each says what it is showing and why —
 * reusing this project's own measured numbers where it already has them,
 * rather than an empty object that would satisfy the coverage test in
 * `gallery.test.ts` and prove nothing. That test is the one most easily
 * faked (a specimen whose component renders an empty div satisfies it), so
 * `gallery.test.ts` also asserts every entry here carries either a
 * non-empty `props` or a `payload`.
 *
 * `id` is not part of this shape. Which store key a specimen's payload
 * lands under is the harness's business (`main.js` assigns one per entry),
 * not something a specimen states about itself.
 *
 * `part: true` (Task 15 on) marks a specimen whose component is a plain
 * part — `YonderReadout`, `YonderTextField`, and whatever this plan's
 * later tasks add beside them — rather than a Node-RED widget in its own
 * right. A part declares its own props directly instead of the
 * `id`/`props`/`state` wrapper every widget above needs to find its
 * `$store` entry, so `main.js` mounts it with `props` spread onto it
 * as-is, the way a real composing widget will. Omitted (falsy) for every
 * widget specimen, which is most of the entries below.
 */
/**
 * Two full deck reports, one per bench camera, built the same shape
 * `YonderDeck.vue`'s own module comment documents — never the blueprint's
 * own richer `cameras.js` fixture, which models fields (`mirror`,
 * `exposureMode`, `gimbalMode` …) this repository's real `CameraCapabilities`
 * does not have yet. `capability.ts`'s own four-state constructors, mirrored
 * here rather than imported, so a specimen reads as plain data the way
 * every other one in this file does.
 */
function range (over = {}) {
  return { min: 0, max: 100, step: 1, default: 0, current: 0, inactive: false, ...over };
}
function present (value) { return { state: "present", value }; }
function notOffered () { return { state: "not-offered" }; }
function advertised (value, reason) { return { state: "advertised", value, reason }; }
function gated (value, by) { return { state: "gated", value, by }; }

/**
 * The ELP global-shutter camera (M1's own bench unit): `auto_exposure`
 * default 3 (Aperture Priority) gates `exposure`; `white_balance_automatic`
 * and `focus_automatic_continuous` default on and gate their own controls
 * the same way — every one of the three real gates `descriptors.ts` states
 * for this camera, all three actually closed, so the gallery shows the
 * `gated` tone rather than only asserting it exists. `aim` is `advertised`,
 * not `present`: this board answers pan/tilt and nothing moves
 * (`probe/camera.ts`'s own comment, verbatim reason).
 */
const ELP_REPORT = {
  camera: { id: "elp", name: "Cam 1", spec: "USB · H.264 · 1280×720p30" },
  capabilities: {
    formats: present([{ fourcc: "MJPG", width: 1280, height: 720, rates: [90, 60, 30, 25, 20] }]),
    zoom: present(range({ min: 0, max: 60, step: 1, current: 0, default: 0 })),
    autoFocus: present(range({ min: 0, max: 1, step: 1, current: 1, default: 1 })),
    focus: gated(range({ min: 0, max: 1023, step: 1, current: 347, default: 0, inactive: true }), { id: "autoFocus", label: "auto focus" }),
    autoExposure: present(range({
      min: 0, max: 3, step: 1, current: 3, default: 3,
      menu: [{ id: 1, label: "Manual Mode" }, { id: 3, label: "Aperture Priority Mode" }],
    })),
    exposure: gated(range({ min: 1, max: 10000, step: 1, current: 156, default: 156, inactive: true }), { id: "autoExposure", label: "auto exposure" }),
    autoWhiteBalance: present(range({ min: 0, max: 1, step: 1, current: 1, default: 1 })),
    whiteBalance: gated(range({ min: 2800, max: 6500, step: 1, current: 4600, default: 4600, inactive: true }), { id: "autoWhiteBalance", label: "auto white balance" }),
    brightness: present(range({ min: -64, max: 64, step: 1, current: 0, default: 0 })),
    contrast: present(range({ min: 0, max: 95, step: 1, current: 0, default: 0 })),
    rotation: notOffered(),
    aim: advertised(undefined, "this camera advertises pan and tilt but there is no motor behind either — it accepts the command and nothing moves"),
    // The ELP has no card and no shutter, and the board records it off its
    // own pipeline — `cameraDeck()` composes these two for exactly that
    // reason, so this fixture carries what a real report now carries.
    recording: present({ medium: "board" }),
    stills: present({ source: "pipeline" }),
    saturation: present(range({ min: 0, max: 255, step: 1, current: 56, default: 56 })),
    hue: present(range({ min: -2000, max: 2000, step: 1, current: 0, default: 0 })),
    gamma: present(range({ min: 64, max: 300, step: 1, current: 110, default: 110 })),
    gain: present(range({ min: 0, max: 1023, step: 1, current: 0, default: 0 })),
    powerLineFrequency: present(range({
      min: 0, max: 3, step: 1, current: 1, default: 1,
      menu: [{ id: 0, label: "Disabled" }, { id: 1, label: "50 Hz" }, { id: 2, label: "60 Hz" }],
    })),
    sharpness: present(range({ min: 0, max: 7, step: 1, current: 0, default: 0 })),
    backlightCompensation: present(range({ min: 36, max: 160, step: 1, current: 54, default: 54 })),
  },
  descriptors: {
    zoom: { label: "Zoom", unit: "", min: 0, max: 60, step: 1, current: 0, default: 0 },
    autoFocus: { label: "Auto focus", unit: "", min: 0, max: 1, step: 1, current: 1, default: 1 },
    focus: { label: "Focus", unit: "", min: 0, max: 1023, step: 1, current: 347, default: 0 },
    autoExposure: { label: "Auto exposure", unit: "", min: 0, max: 3, step: 1, current: 3, default: 3 },
    // video/descriptors.ts: exposure is raw x100 µs — 156 is 15600.
    exposure: { label: "Shutter", unit: "µs", min: 100, max: 1000000, step: 100, current: 15600, default: 15600 },
    autoWhiteBalance: { label: "Auto white balance", unit: "", min: 0, max: 1, step: 1, current: 1, default: 1 },
    whiteBalance: { label: "Temperature", unit: "K", min: 2800, max: 6500, step: 1, current: 4600, default: 4600 },
    brightness: { label: "Brightness", unit: "", min: -64, max: 64, step: 1, current: 0, default: 0 },
    contrast: { label: "Contrast", unit: "", min: 0, max: 95, step: 1, current: 0, default: 0 },
    saturation: { label: "Saturation", unit: "", min: 0, max: 255, step: 1, current: 56, default: 56 },
    hue: { label: "Hue", unit: "", min: -2000, max: 2000, step: 1, current: 0, default: 0 },
    gamma: { label: "Gamma", unit: "", min: 64, max: 300, step: 1, current: 110, default: 110 },
    gain: { label: "Gain", unit: "", min: 0, max: 1023, step: 1, current: 0, default: 0 },
    powerLineFrequency: { label: "Mains frequency", unit: "", min: 0, max: 3, step: 1, current: 1, default: 1 },
    sharpness: { label: "Sharpness", unit: "", min: 0, max: 7, step: 1, current: 0, default: 0 },
    backlightCompensation: { label: "Backlight compensation", unit: "", min: 36, max: 160, step: 1, current: 54, default: 54 },
  },
  values: {
    zoom: 0, autoFocus: true, focus: 347, autoExposure: 3, exposure: 15600,
    autoWhiteBalance: true, whiteBalance: 4600, brightness: 0, contrast: 0,
    saturation: 56, hue: 0, gamma: 110, gain: 0, powerLineFrequency: 1,
    sharpness: 0, backlightCompensation: 54,
  },
  commanded: {},
  policy: {
    stream: { mode: "fixed", floor_kbps: 1000, ceiling_kbps: 6000, bitrate_kbps: 3000 },
    preview: {
      mode: "adaptive", size: "auto", ladder_bottom: "640x360", ladder_top: "1280x720",
      floor_kbps: 300, ceiling_kbps: 2000, bitrate_kbps: 400, framerate: 15,
    },
  },
  applied: {
    stream: { mode: "fixed", floor_kbps: 1000, ceiling_kbps: 6000, bitrate_kbps: 3010 },
    preview: {
      mode: "adaptive", size: "auto", ladder_bottom: "640x360", ladder_top: "1280x720",
      floor_kbps: 300, ceiling_kbps: 2000, bitrate_kbps: 410, framerate: 15,
    },
  },
  outputs: [
    { kind: "rtp", label: "Ground station", enabled: true, costKbps: 3010,
      reach: { direction: "outbound", reachable: true, note: "an outbound push to the configured ground station; it leaves over whichever path is active, cellular included" } },
    { kind: "rtsp", label: "RTSP", enabled: true, costKbps: 0,
      reach: { direction: "listener", reachable: false, note: "nothing can dial in to this RTSP listener over cellular; it is reachable on the mesh or a LAN" } },
  ],
  captures: { count: 3 },
  // What the recorder answered: nothing running, an hour and fifty-eight
  // minutes of headroom against the 1024 MB reserve, and the same headroom in
  // photographs. This is what draws the line under the shutter key
  // (blueprint L-45 and L-46) — the two readings differ only in a unit.
  recorder: {
    recording: false, since: null, destination: "board",
    remainingSeconds: 7080, remainingPhotos: 3900, bytes: null, ended: null,
  },
  interruption: [],
};

/**
 * The DJI Pocket 2 (M5's own accessory camera): a real gimbal — `aim` is
 * `present`, not `advertised` — and its own card, so a still lands there
 * rather than on the board (§8.3). Its image controls are fewer: this
 * protocol has no equivalent of the ELP's ten housekeeping-grade V4L2
 * controls, so `gain`, `gamma`, `sharpness`, `backlightCompensation` and
 * `powerLineFrequency` all read `not-offered` here — the gallery's own
 * demonstration of Housekeeping being omitted whole on a camera that has
 * none of it (this task's own "omits a whole group" test, at a second,
 * different camera).
 */
const POCKET2_REPORT = {
  camera: { id: "pocket2", name: "Cam 2", spec: "Accessory · H.264 · 1280×720p30" },
  capabilities: {
    formats: present([{ fourcc: "H264", width: 1280, height: 720, rates: [30] }]),
    zoom: present(range({ min: 1, max: 10, step: 0.1, current: 1, default: 1 })),
    autoFocus: notOffered(),
    focus: notOffered(),
    autoExposure: present(range({
      min: 1, max: 4, step: 1, current: 3, default: 1,
      menu: [{ id: 1, label: "Program" }, { id: 2, label: "Shutter priority" },
        { id: 3, label: "Aperture priority" }, { id: 4, label: "Manual" }],
    })),
    exposure: gated(range({ min: 125, max: 8000, step: 1, current: 2000, default: 2000, inactive: true }), { id: "autoExposure", label: "auto exposure" }),
    autoWhiteBalance: notOffered(),
    whiteBalance: present(range({ min: 2000, max: 10000, step: 1, current: 5500, default: 5500 })),
    brightness: notOffered(),
    contrast: notOffered(),
    rotation: notOffered(),
    aim: present({ pitch: { min: -90, max: 90 }, yaw: { min: -180, max: 180 }, mode: "Follow" }),
    recording: present({ medium: "camera" }),
    stills: present({ source: "camera" }),
    saturation: notOffered(),
    hue: notOffered(),
    gamma: notOffered(),
    gain: notOffered(),
    powerLineFrequency: notOffered(),
    sharpness: notOffered(),
    backlightCompensation: notOffered(),
  },
  descriptors: {
    zoom: { label: "Zoom", unit: "×", min: 1, max: 10, step: 0.1, current: 1, default: 1 },
    autoExposure: { label: "Auto exposure", unit: "", min: 1, max: 4, step: 1, current: 3, default: 1 },
    exposure: { label: "Shutter", unit: "µs", min: 12500, max: 800000, step: 100, current: 200000, default: 200000 },
    whiteBalance: { label: "Temperature", unit: "K", min: 2000, max: 10000, step: 1, current: 5500, default: 5500 },
  },
  values: { zoom: 1, autoExposure: 3, exposure: 200000, whiteBalance: 5500 },
  commanded: {},
  policy: {
    stream: { mode: "adaptive", floor_kbps: 1500, ceiling_kbps: 8000, bitrate_kbps: 4000 },
    preview: {
      mode: "fixed", size: "854x480", ladder_bottom: "640x360", ladder_top: "1280x720",
      floor_kbps: 300, ceiling_kbps: 2000, bitrate_kbps: 400, framerate: 15,
    },
  },
  applied: {
    stream: { mode: "adaptive", floor_kbps: 1500, ceiling_kbps: 8000, bitrate_kbps: 3200 },
    preview: {
      mode: "fixed", size: "854x480", ladder_bottom: "640x360", ladder_top: "1280x720",
      floor_kbps: 300, ceiling_kbps: 2000, bitrate_kbps: 400, framerate: 15,
    },
  },
  outputs: [
    { kind: "rtp", label: "Ground station", enabled: true, costKbps: 3200,
      reach: { direction: "outbound", reachable: true, note: "an outbound push to the configured ground station; it leaves over whichever path is active, cellular included" } },
  ],
  captures: { count: 0 },
  // The Pocket 2 holds its own captures, so the board's headroom is a number
  // about the wrong medium and the honest answer is that nothing here knows.
  recorder: {
    recording: false, since: null, destination: "camera",
    remainingSeconds: null, remainingPhotos: null, bytes: null, ended: null,
  },
  interruption: ["current respawn path only"],
};

/**
 * A second, plainer camera for the Cameras index (Task 24) — a CSI sensor
 * with none of the ELP's three gates, so `summarise()`'s own output beside
 * it in the gallery reads mostly `not-offered`, the same contrast
 * `ELP_REPORT`/`POCKET2_REPORT` already draw for the deck.
 */
const BELLY_CAPABILITIES = {
  formats: present([{ fourcc: "H264", width: 1280, height: 720, rates: [30, 25, 20] }]),
  zoom: notOffered(),
  focus: notOffered(),
  exposure: present(range({ min: 1, max: 33000, step: 1, current: 10000, default: 10000 })),
  whiteBalance: notOffered(),
  brightness: present(range({ min: -1, max: 1, step: 1, current: 0, default: 0 })),
  contrast: present(range({ min: -1, max: 1, step: 1, current: 0, default: 0 })),
  rotation: present(range({ min: 0, max: 270, step: 90, current: 0, default: 0 })),
  aim: notOffered(),
  recording: notOffered(),
  stills: notOffered(),
  saturation: notOffered(),
  hue: notOffered(),
  autoWhiteBalance: notOffered(),
  gamma: notOffered(),
  gain: present(range({ min: 0, max: 16, step: 1, current: 1, default: 1 })),
  powerLineFrequency: notOffered(),
  sharpness: notOffered(),
  backlightCompensation: notOffered(),
  autoExposure: present(range({ min: 0, max: 1, step: 1, current: 1, default: 1 })),
  autoFocus: notOffered(),
};

export const SPECIMENS = [
  {
    title: "Cockpit — cove mission, synthetic telemetry",
    note: "The production full-viewport cockpit mounted with the user's cove mission and explicitly synthetic flight data. Source feeds and aircraft transport are absent. Instrument dialogs, mission authoring and inset expansion remain interactive. Use the dedicated cockpit harness for viewport comparisons.",
    component: YonderCockpit,
    props: { report: cockpitFixture(), embedded: true },
    payload: undefined,
    part: false,
  },
  {
    title: "Gauge — encoding used",
    note: "R-UI-09: caution at 60%, limit at 85%. 72% sits in the caution band, drawn amber.",
    component: YonderGauge,
    props: { label: "Encoding used", unit: "%", min: 0, max: 100, caution: 60, limit: 85, precision: 0, track: 150 },
    payload: 72,
  },
  {
    title: "Tape — board temperature",
    note: "Past its limit (90°C, the Pi's own throttle point): the redline and the boxed reading both read bad.",
    component: YonderTape,
    props: { min: 0, max: 100, unit: "°C", caution: 70, limit: 90, limitLabel: "THROTTLE", divisions: 5, height: 220, precision: 0 },
    payload: 93,
  },
  {
    title: "Annunciator — a change in flight",
    note: "The rail's own message wins over the shared label (R-UI-11, ADR-0005): tone comes from the state, the words from the payload.",
    component: YonderAnnunciator,
    props: { source: "payload" },
    payload: { state: "pending", message: "Applying — reverts in 1:47 unless confirmed" },
  },
  {
    title: "Data bar — status strip",
    note: "A key the payload never sent (Sats) draws as an em dash, not a zero — the same distinction R-UI-05 makes about a command, applied to a fact.",
    component: YonderDataBar,
    props: {
      cells: [
        { key: "batt", label: "Battery" },
        { key: "temp", label: "Board" },
        { key: "sig", label: "Signal" },
        { key: "sats", label: "Sats" },
        { key: "net", label: "Net", kind: "id" },
      ],
    },
    payload: { batt: "92%", temp: "41°C", sig: "-71 dBm", net: "cell-0" },
  },
  {
    title: "Facts — optics capability",
    note: "The four states this component exists to keep distinct (R-UI-20, R-UI-21), side by side — the same four rows facts.component.test.ts holds to their own words.",
    component: YonderFacts,
    props: { title: "Optics", facts: [] },
    payload: {
      facts: [
        { label: "Aim", state: "not-offered" },
        { label: "Zoom", state: "advertised", reason: "accepted, does not reshape the feed" },
        { label: "Exposure", state: "gated", reason: "auto exposure" },
        { label: "Focus", state: "undrawn" },
      ],
    },
  },
  {
    title: "Hold key — full rate",
    note: "2.07 Mb/s while held — the same measured cost of a 2000 kb/s stream at IP and UDP that holdkey.component.test.ts locks in.",
    component: YonderHoldKey,
    props: { label: "Full rate", action: "fullrate" },
    payload: { available: true, cost: "2.07 Mb/s while held" },
  },
  {
    title: "Identity — network ID",
    note: "Shown with a means of copying it (R-VPN-06) rather than a control that only looks like one.",
    component: YonderIdentity,
    props: { label: "Network ID", key: "networkId" },
    payload: { networkId: "9f2a1e7d3c5b8f01" },
  },
  {
    title: "Picture — no camera assigned",
    note: "This gallery has no media server behind it, so the honest specimen is the real fallback state (R-VID-14) — the reason text a picture shows before anything has told it which camera to negotiate, not a placeholder frame invented for this page.",
    component: YonderPicture,
    props: { label: "Camera 1" },
    payload: undefined,
  },
  {
    title: "Picture — wearing its own state, composed (Task 25)",
    note: "Task 25's own rework: every overlay this component can draw at once, on one picture, proving the composition and the stacking rather than any one part alone — each already has its own narrow specimen above (State overlay, Thumb strip). Numbers are shared with those specimens on purpose, not reinvented: the state overlay's 1.8 Mb/s of 0.3–2.0 and its three-cost row is the identical 'adaptive, inside the envelope' specimen above; the thumb strip is the identical Nose/Belly/Tail three-camera row; pan 12.4°/tilt −6.0° are the Aim panel's own reported-position specimen. `REC 00:13:47` is the blueprint's (`DraftPicture.vue`) own demo string, kept as a small deliberate echo of what this component is a rework of. This gallery has no media server, so `path` stays empty here too (R-VID-14's fallback reason is the honest thing to show behind the overlays, not a frame this page would have to invent) — the drag-to-slew layer is live and can be dragged directly, the same way the Aim pad's own 'pushing' specimen documents for a gesture no static prop can capture.",
    component: YonderPicture,
    props: { label: "Camera 1" },
    payload: {
      state: {
        head: "adaptive", size: "1280×720", rate: "15 fps", bitrate: "1.8 Mb/s", detail: "1.8 of 0.3–2.0",
        cost: { view: "0.6 Mb/s", encode: "1.8 Mb/s", path: "3.9 Mb/s" },
      },
      recording: { elapsed: "00:13:47" },
      aim: { state: "present", pan: 12.4, tilt: -6.0 },
      zoom: 3,
      exposure: 156,
      stats: { linkMbps: 3.1, dropPct: 0 },
      cameras: [
        { id: "cam-nose", name: "Nose", active: false, ageSeconds: 4,
          thumbSrc: "data:image/svg+xml;charset=utf-8," + encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="36">' +
            '<rect width="64" height="18" fill="%23a8c4de"/>' +
            '<rect y="18" width="64" height="18" fill="%238a9a5b"/></svg>') },
        { id: "cam-belly", name: "Belly", active: true, ageSeconds: 0 },
        { id: "cam-tail", name: "Tail", active: false, ageSeconds: 11 },
      ],
      downlink: "3.9 Mb/s",
    },
  },
  {
    title: "Soft keys — cameras rail",
    note: "Sized to their own words, never a stretched half-page button (R-UI-10) — one raised, one plain, one in the warn tone.",
    component: YonderSoftKeys,
    props: {
      keys: [
        { label: "Detect again", action: "detect", active: true },
        { label: "Add by address", action: "add" },
        { label: "Apply", action: "apply", tone: "warn" },
      ],
    },
    payload: undefined,
  },
  {
    title: "Sparkline — uplink RX/TX",
    note: "Ten samples, RX busier than TX — the two-line shape with its shared scale and its ceiling stated beside it (R-UI-13).",
    component: YonderSparkline,
    props: { label: "Uplink", chartHeight: 90 },
    payload: {
      peak: "3.2 Mb/s",
      span: "last 60 s",
      series: {
        rx: [120, 180, 240, 300, 260, 320, 410, 380, 300, 260],
        tx: [40, 42, 38, 45, 50, 47, 60, 55, 48, 44],
      },
    },
  },
  {
    title: "Budget — uplink, oversubscribed",
    note: "The nose camera alone (3.3 Mb/s) already exceeds the measured 3.2 Mb/s uplink; the telemetry segment on top of it starts past the mark and hatches — the one drawing of oversubscription an operator can read at a glance.",
    component: YonderBudget,
    props: { label: "Uplink", capacityKbps: 3200, segments: [] },
    payload: {
      budget: {
        capacityKbps: 3200,
        segments: [
          { label: "Nose", kbps: 3300 },
          { label: "Telemetry", kbps: 200 },
        ],
      },
    },
  },
  {
    title: "Readout — Pocket 2 status",
    note: "Battery carries its unit without shouting it; Card is not fitted, which reads as none in the neutral tone rather than the blank a bare 0 would leave (coordinator resolution 5) — the same three rows the blueprint's own POCKET2 fixture carries, with the absent Card expressed as a null value rather than a pre-formatted string.",
    component: YonderReadout,
    props: {
      rows: [
        { label: "Battery", value: "99", unit: "%" },
        { label: "Card", value: null },
        { label: "Sensor", value: "16", unit: "MP" },
      ],
    },
    payload: undefined,
    part: true,
  },
  {
    title: "Text field — camera name",
    note: "R-UI-27: Yonder ships Cam 1, Cam 2 — never a guess at a mounting, because that is a guess about somebody else's aircraft. Renamed here to Nose, the same camera Budget's own specimen shows oversubscribing this aircraft's uplink.",
    component: YonderTextField,
    props: { label: "Name", value: "Nose", placeholder: "Cam 1", max: 24 },
    payload: undefined,
    part: true,
  },
  {
    title: "Column — stream, to the ground station",
    note: "The right-hand qualifier (§6) is what tells two columns of otherwise identical controls apart: this one and Preview's own share the same fields (bitrate mode, floor, ceiling), and the qualifier is the only thing on screen saying which camera output each one is steering. The select tone marks it as the destination currently in view, the same cyan this library already uses for a live choice.",
    component: YonderColumn,
    props: { legend: "Stream", qualifier: "to the ground station", tone: "select" },
    payload: undefined,
    part: true,
  },
  {
    title: "Placard — camera identity",
    note: "The camera's own name (R-UI-27), read the way ADR-0009 draws every placard on this console: letterspaced capitals from a single ambient rule, never typed in shouting case by whoever configured the camera.",
    component: YonderPlacard,
    props: { kind: "Camera", name: "Cam 2" },
    payload: undefined,
    part: true,
  },
  {
    title: "Placard — what the accessory is, with a protected unit",
    note: "§6's own second worked example, with a real unit standing in for its illustrative one: `2.07 Mb/s` is holdkey.component.test.ts's own measured full-rate figure, carried here to show the exact hazard this part exists to avoid — the ambient uppercase that draws CAMERA and Cam 2 above must stop at the unit, or Mb/s reads MB/S and says megabytes.",
    component: YonderPlacard,
    props: { kind: "Accessory", name: "H.264 · 1280×720", unit: "2.07 Mb/s" },
    payload: undefined,
    part: true,
  },
  {
    title: "Position gauge — pan, reported",
    note: "R-UI-09: the bench's own gimbal push (§7, gimbal/0x05 at 20 Hz) reporting +134.5° of its ±180° pan range — a pointer three-quarters along the track, with both bounds written beneath it rather than a bare number nobody can judge without them.",
    component: YonderPositionGauge,
    props: { label: "Pan", value: 134.5, min: -180, max: 180, unit: "°", precision: 1 },
    payload: undefined,
    part: true,
  },
  {
    title: "Position gauge — roll, dead",
    note: "§7's own Aim table: 'Roll — struck | no answer on the third axis'. A single em dash rather than a number, no pointer on the track, and the reason named — the neutral tone, not caution, because a bench gimbal with two axes is not a fault (coordinator resolution 8's own rule for a gated control, applied here to an axis).",
    component: YonderPositionGauge,
    props: { label: "Roll", value: 0, min: -180, max: 180, unit: "°", dead: true, reason: "no answer on this axis" },
    payload: undefined,
    part: true,
  },
  {
    title: "Picker — auto exposure, present",
    note: "R-CAM-14: the bench's own auto_exposure answers menu ids 1 and 3 only (min=0 max=3 in the raw probe, but 0 and 2 are not real entries) — offering every id in that range would put a mode on the page this camera does not have. Enabled; Aperture priority is the current selection.",
    component: YonderPicker,
    props: {
      label: "Auto exposure",
      value: "3",
      options: [
        { value: "1", label: "Manual" },
        { value: "3", label: "Aperture priority" },
      ],
      state: "present",
    },
    payload: undefined,
    part: true,
  },
  {
    title: "Picker — records at, advertised",
    note: "A fault, in the caution tone (R-UI-20): the device lists 4K30 and accepts it, and the stream stays at its own default regardless. The control stays on the page, disabled, carrying why — never hidden, which would read as this page failed rather than this camera cannot.",
    component: YonderPicker,
    props: {
      label: "Records at",
      value: "3840x2160@30",
      options: [
        { value: "3840x2160@30", label: "3840×2160 · 30 fps" },
        { value: "1920x1080@60", label: "1920×1080 · 60 fps" },
        { value: "1920x1080@30", label: "1920×1080 · 30 fps" },
      ],
      state: "advertised",
      reason: "accepted; keeps recording at 1920×1080 · 30 fps",
    },
    payload: undefined,
    part: true,
  },
  {
    title: "Picker — shutter preset, gated",
    note: "Not a fault (R-UI-21): the same bench fixture behind the specimen above leaves exposure_time_absolute flags=inactive while auto_exposure sits in Aperture Priority Mode. Neutral tone, dashed box, naming the control that has it — drawing this in caution would tell an operator something is broken when nothing is.",
    component: YonderPicker,
    props: {
      label: "Shutter",
      value: "1/125",
      options: [
        { value: "1/60", label: "1/60" },
        { value: "1/125", label: "1/125" },
        { value: "1/250", label: "1/250" },
        { value: "1/500", label: "1/500" },
      ],
      state: "gated",
      reason: "while auto exposure is aperture priority",
    },
    payload: undefined,
    part: true,
  },
  {
    title: "Picker — aim, not offered",
    note: "R-UI-20: nothing draws below — no wrapper, no label, no select. The same fact YonderFacts' own specimen states in words is stated here by an empty stage, so a picker never repeats an absence YonderFacts has already reported, in a second silence of its own.",
    component: YonderPicker,
    props: {
      label: "Aim",
      value: "",
      options: [{ value: "1", label: "Centre" }],
      state: "not-offered",
    },
    payload: undefined,
    part: true,
  },
  {
    title: "Segmented — bitrate mode, present",
    note: "R-VID-08: a fixed bitrate where the operator prefers determinism, set against the adaptive mode architecture.md's own encoder config carries as its default. Capped to its own two words (R-UI-08), never a slab stretched to the card.",
    component: YonderSegmented,
    props: { label: "Bitrate", value: "Adaptive", options: ["Fixed", "Adaptive"], state: "present" },
    payload: undefined,
    part: true,
  },
  {
    title: "Segmented — anti-flicker, advertised",
    note: "A fault, in the caution tone (R-CAM-14): the bench's own power_line_frequency menu (list-ctrls-menus-globalshutter.txt) offers exactly these three entries, accepted here, with the sensor free-running regardless — the control stays on the page, disabled, carrying why, rather than vanishing as if the page had failed.",
    component: YonderSegmented,
    props: {
      label: "Anti-flicker",
      value: "50 Hz",
      options: ["Off", "50 Hz", "60 Hz"],
      state: "advertised",
      reason: "accepted; the sensor stays free-running",
    },
    payload: undefined,
    part: true,
  },
  {
    title: "Segmented — exposure priority, gated",
    note: "Not a fault (R-UI-21): the same bench fixture behind YonderPicker's own gated specimen leaves exposure_time_absolute flags=inactive while auto_exposure sits in Aperture Priority Mode. Neutral tone, dashed boxes, naming the control that has it — never the caution tone, which would tell an operator something is broken when nothing is.",
    component: YonderSegmented,
    props: {
      label: "Exposure priority",
      value: "Auto",
      options: ["Manual", "Auto"],
      state: "gated",
      reason: "while auto exposure is aperture priority",
    },
    payload: undefined,
    part: true,
  },
  {
    title: "Segmented — night mode, not offered",
    note: "R-UI-20: nothing draws below — no wrapper, no label, no buttons. This bench's global-shutter camera carries no IR-cut filter to switch, so the same absence YonderFacts states in words is stated here by an empty stage, never a second silence of this control's own.",
    component: YonderSegmented,
    props: { label: "Night mode", value: "", options: ["Day", "Night"], state: "not-offered" },
    payload: undefined,
    part: true,
  },
  {
    title: "Set bar — shutter, present",
    note: "R-CTL-11: the bench's own exposure control is raw × 100 µs (packages/yonder-core/src/video/descriptors.ts) — raw 156 is 15600 µs, the coordinator's own worked example for precision. One grabbable mark, sitting at the device's own value: nothing commanded and not yet arrived, no draft pending apply on Setup.",
    component: YonderSetBar,
    props: { label: "Shutter", unit: "µs", min: 100, max: 1000000, step: 100, precision: 0, actual: 15600, state: "present" },
    payload: undefined,
    part: true,
  },
  {
    title: "Set bar — shutter, gated",
    note: "Not a fault (R-UI-21): the same bench fixture behind YonderPicker's and YonderSegmented's own gated specimens leaves exposure_time_absolute flags=inactive while auto_exposure sits in Aperture Priority Mode. The value is not meaningfully known while another control holds it, so the readout goes to a double em dash rather than restating a number it cannot vouch for — no reading mark, no grabbable one, neutral tone, dashed track, naming the control that has it.",
    component: YonderSetBar,
    props: {
      label: "Shutter", unit: "µs", min: 100, max: 1000000, step: 100, precision: 0, actual: 15600,
      state: "gated", reason: "while auto exposure is aperture priority",
    },
    payload: undefined,
    part: true,
  },
  {
    title: "Set bar — preview bitrate, a pending draft",
    note: "Every mark this bar can draw, at once — the coordinator's own worked example (task-18-brief.md): the device reports 0.4 Mb/s (actual, a caret below the track); 1.0 Mb/s was commanded and has not arrived (a second caret, the waiting tone); 1.5 Mb/s is a Live edit not yet applied on Setup (§7) — the one solid mark on the track, and the only one a press can move. Exactly one mark may look draggable, and it is this one.",
    component: YonderSetBar,
    props: {
      label: "Bitrate", unit: "Mb/s", min: 0.1, max: 4, step: 0.1, precision: 1,
      actual: 0.4, commanded: 1.0, requested: 1.5, state: "present",
    },
    payload: undefined,
    part: true,
  },
  {
    title: "Set bar — preview bitrate, readonly (Adaptive)",
    note: "§6: 'PREVIEW · to this browser is Adaptive by default … In Adaptive the bar is a readout, GOING OUT' (R-VID-07, R-VID-13). The encoder is steering itself off the measured link, so there is nothing an operator's press would honour — readonly removes the one grabbable mark entirely rather than merely disabling it, the same way gated and advertised never draw a stray handle, and the reading stays live and in its ordinary colour throughout.",
    component: YonderSetBar,
    props: { label: "Going out", unit: "Mb/s", min: 0, max: 4, step: 0.1, precision: 1, actual: 1.8, readonly: true },
    payload: undefined,
    part: true,
  },
  {
    title: "State overlay — adaptive, inside the envelope",
    note: "§8.2's own worked string, in full: 1.8 Mb/s of an operator-set 0.3–2.0 Mb/s envelope, three cost fields rather than one sum — this browser's own 0.6 Mb/s share, the 1.8 Mb/s shared preview encode, and the 3.9 Mb/s measured total leaving this path (other viewers and thumbnail stills included, per §8.2 — not 0.6 + 1.8).",
    component: YonderStateOverlay,
    props: {
      head: "adaptive", size: "1280×720", rate: "15 fps", bitrate: "1.8 Mb/s", detail: "1.8 of 0.3–2.0",
      cost: { view: "0.6 Mb/s", encode: "1.8 Mb/s", path: "3.9 Mb/s" },
    },
    payload: undefined,
    part: true,
  },
  {
    title: "State overlay — pinned at the floor, mid-step",
    note: "The caution tone (coordinator resolution 5) and the step line together: the rate controller (§8.1) just stepped the preview down a rung, and says why beneath the reading rather than leaving an operator to infer it from a resolution change alone.",
    component: YonderStateOverlay,
    props: {
      head: "floor", size: "854×480", rate: "15 fps", bitrate: "0.3 Mb/s", detail: "0.3 of 0.3–2.0",
      step: "stepped down to 854×480 · pinned at the floor",
    },
    payload: undefined,
    part: true,
  },
  {
    title: "State overlay — stills, the R-VID-14 fall-back",
    note: "The fault tone (coordinator resolution 5): live video could not be established and this viewer fell back to periodic stills without being asked, exactly as R-VID-14 requires — stated as a fact about the link, not styled as an ordinary picture that merely looks different.",
    component: YonderStateOverlay,
    props: { head: "stills", detail: "every 2 s" },
    payload: undefined,
    part: true,
  },
  {
    title: "State overlay — held, an operator's own choice",
    note: "The neutral tone. A size the operator pinned does not step, so the controller is inside its envelope and doing nothing — which is a different fact from being at the floor, and must not borrow the caution tone that says the link is squeezing the picture.",
    component: YonderStateOverlay,
    props: { head: "held", size: "854×480", rate: "15 fps", bitrate: "1.2 Mb/s", detail: "held at 854×480" },
    payload: undefined,
    part: true,
  },
  {
    title: "State overlay — full rate, while a key is held",
    note: "The select tone. Full rate is momentary and costly, taken deliberately by holding a key, so it reads as the one state on this overlay an operator is actively spending on rather than one the link imposed. Unit-tested since Task 19 and never drawn until now.",
    component: YonderStateOverlay,
    props: { head: "full-rate", size: "1280×720", rate: "30 fps", bitrate: "3.1 Mb/s", detail: "3.1 while held" },
    payload: undefined,
    part: true,
  },
  {
    title: "Thumb strip — three cameras, one live",
    note: "R-UI-03, R-VID-14: every detected camera keeps its place in the strip, including the one already on the main picture (coordinator resolution 6 corrects §6's own looser first draft, which showed only 'the others') — Nose and Tail read their still's own age, Belly reads Live and is marked. Downlink now is this path's measured total (§8.2), not the sum any of the per-camera figures on this page would suggest.",
    component: YonderThumbStrip,
    props: {
      cameras: [
        // A still the board actually holds, so the image branch is drawn
        // rather than merely declared — it had no specimen at all until
        // review noticed. A data URI, because a gallery that fetched a file
        // would be testing the server as much as the component.
        { id: "cam-nose", name: "Nose", active: false, ageSeconds: 4,
          thumbSrc: "data:image/svg+xml;charset=utf-8," + encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="36">' +
            '<rect width="64" height="18" fill="%23a8c4de"/>' +
            '<rect y="18" width="64" height="18" fill="%238a9a5b"/></svg>') },
        { id: "cam-belly", name: "Belly", active: true, ageSeconds: 0 },
        { id: "cam-tail", name: "Tail", active: false, ageSeconds: 11 },
      ],
      downlink: "3.9 Mb/s",
    },
    payload: undefined,
    part: true,
  },
  {
    title: "Shutter — video mode, idle",
    note: "R-CAM-17: the ELP has no recorder of its own, so a press records to the board — the destination line says so before anything is recording, not only once it starts.",
    component: YonderShutter,
    props: { mode: "video", destination: "to this board · 41 GB free" },
    payload: undefined,
    part: true,
  },
  {
    title: "Shutter — recording, lit and counting",
    note: "§8.3: lit from the moment recording.since says it started, not from when this page happened to open — the elapsed reading keeps counting on its own for as long as this gallery tab stays open, the same live timer YonderPicture's own age reading uses.",
    component: YonderShutter,
    props: { mode: "video", recording: { since: Date.now() - 47000 }, destination: "to this board · 41 GB free" },
    payload: undefined,
    part: true,
  },
  {
    title: "Shutter — a press pending, photo mode",
    note: "Coordinator resolution 7: this is the one control in the whole library that starts something on the aircraft, so while a press awaits the device's own acknowledgement the key is disabled outright rather than merely styled to look busy — a second press here must be impossible to make by accident, not just discouraged.",
    component: YonderShutter,
    props: { mode: "photo", pending: true },
    payload: undefined,
    part: true,
  },
  {
    title: "Aim pad — at rest, tilt at its limit",
    note: "R-CAM-11, R-CMD-04: the haloed puck sits at the dial's own centre until an operator pushes it — this is the only control in the library where a press becomes movement on an aircraft, and at rest it commands nothing. The tilt axis is reporting its own mechanical limit (atLimit.pitch) regardless of whether anyone is pushing right now, which is why the pill can show even here.",
    component: YonderAimPad,
    props: { axes: { pan: "present", tilt: "present", roll: "present" }, atLimit: { pitch: true, yaw: false }, inhibited: null },
    payload: undefined,
    part: true,
  },
  {
    title: "Aim pad — pushing",
    note: "The same props as the resting specimen beside it — 'pushing' is transient, client-only state with no prop of its own, exactly like YonderHoldKey's own 'held'. Drag inside the dial (or hold and move) to push the puck out from centre; a real press cannot be captured as a static prop, so this specimen is the one to interact with directly, in both palettes.",
    component: YonderAimPad,
    props: { axes: { pan: "present", tilt: "present", roll: "present" } },
    payload: undefined,
    part: true,
  },
  {
    title: "Aim pad — inhibited",
    note: "Coordinator resolution 6: a general inhibition reason, shown and acted on — every one of down()'s and updateFromEvent()'s own guards refuses a press outright, not merely disables the cursor. Not the range finder's own wording (removed from this plan after the operator rejected it) — the deck supplies whatever reason is true, and here it is a gimbal that is simply not answering.",
    component: YonderAimPad,
    props: { axes: { pan: "present", tilt: "present", roll: "present" }, inhibited: "gimbal not responding" },
    payload: undefined,
    part: true,
  },
  {
    title: "Aim pad — roll not answering",
    note: "Coordinator resolution 7: an axis the device advertises and will not answer — the bench camera's roll — struck through on the pad itself rather than hidden, so an operator can tell 'this camera cannot' from 'this page failed'. Pan and tilt are unaffected: the pad is a two-axis stick and never had a gesture for roll at all.",
    component: YonderAimPad,
    props: { axes: { pan: "present", tilt: "present", roll: "not-offered" } },
    payload: undefined,
    part: true,
  },
  {
    title: "Deck — ELP, Live",
    note: "Task 22: the deck composes itself from the report alone. Exposure, colour and optics all show the `gated` tone at once — every one of the ELP's own three gates (auto exposure, auto white balance, auto focus) closed, matching the bench's own default state — and Aim carries the pan/tilt-that-does-not-move reason verbatim from probe/camera.ts, disabling the pad rather than hiding it.",
    component: YonderDeck,
    props: { mode: "live" },
    payload: ELP_REPORT,
    part: false,
  },
  {
    title: "Deck — ELP, Setup",
    note: "The same report, on Setup: Housekeeping appears (gain, backlight compensation, sharpness, mains frequency — the four bench-only controls), the camera's own Name field draws, and the rail gains Discard and Apply. Toggle Stream or Preview between Fixed and Adaptive here and in the Live specimen alike to see a group's own height change without any other group moving column — the operator's own correction to the blueprint.",
    component: YonderDeck,
    props: { mode: "setup" },
    payload: ELP_REPORT,
    part: false,
  },
  {
    title: "Deck — Pocket 2, Live",
    note: "A second camera answering a different shape entirely: Aim is `present` (a real gimbal, not the ELP's dead advertised pan/tilt) and draws the live pad; Housekeeping's own four controls are all not-offered on this camera, so the whole group is omitted on both pages — this task's own 'omits a whole group' behaviour, seen on a camera the eleven required tests do not exercise directly.",
    component: YonderDeck,
    props: { mode: "live" },
    payload: POCKET2_REPORT,
    part: false,
  },
  {
    title: "Deck — Pocket 2, Setup",
    note: "Setup on the second camera: no Housekeeping column to add (none of its four controls are offered here), so only Name and the Apply/Discard keys are new relative to Live — drawing the same fixed four-column layout with one slot legitimately shorter than the ELP's own, never reflowed to fill the gap.",
    component: YonderDeck,
    props: { mode: "setup" },
    payload: POCKET2_REPORT,
    part: false,
  },
  {
    title: "Aim panel — live, on its own",
    note: "Task 23: ui-yonder-aim, mounted with no deck and no camera page around it (R-UI-28) — everything here comes from this one payload. The badge reads RATE CONTROL in the select tone; Commanded rate is real only while dragging the pad below it. Roll stays struck through even here — no camera this project supports has a roll motor, so YonderAim.vue hardcodes it exactly as YonderDeck.buildAim() does, not derived from this payload.",
    component: YonderAim,
    props: {
      report: {
        state: "present",
        reason: "",
        pan: 12.4,
        tilt: -6.0,
        bounds: { pan: [-180, 180], tilt: [-90, 90] },
        atLimit: { pitch: false, yaw: false },
        mode: "Follow",
        modes: ["Follow", "Tilt lock", "FPV"],
        inhibited: null,
      },
    },
    payload: undefined,
    part: false,
  },
  {
    title: "Aim panel — inhibited",
    note: "The device answers aim normally (state: present) but a live guard is temporarily refusing motion (§8.7: unknown bounds, unknown mode or stale attitude inhibit non-zero motion until the missing precondition clears) — the badge still reads RATE CONTROL, since the capability itself is not the thing that is unavailable, but the pad, the gimbal-mode control and Recentre are all disabled and carry this same reason, which YonderAimPad's own inhibited prop states directly on the pad itself.",
    component: YonderAim,
    props: {
      report: {
        state: "present",
        reason: "",
        pan: -42.0,
        tilt: 8.5,
        bounds: { pan: [-180, 180], tilt: [-90, 90] },
        atLimit: { pitch: false, yaw: false },
        mode: "Follow",
        modes: ["Follow", "Tilt lock", "FPV"],
        inhibited: "attitude is stale; movement is held until it refreshes",
      },
    },
    payload: undefined,
    part: false,
  },
  {
    title: "Aim panel — not answering (ELP)",
    note: "The ELP bench camera again (compare the Deck — ELP specimens above): it advertises pan and tilt and has no motor behind either. The badge reads NOT ANSWERING in the caution tone, the reason is stated once at the top of the panel, and every control — pad, both position gauges, the mode line, Recentre — stays drawn and marked rather than disappearing (R-UI-20, coordinator resolution 7). Bounds is null because a camera that does not answer aim at all is not reporting a position either; Commanded rate is omitted entirely, since there is nothing a rate reading could mean here.",
    component: YonderAim,
    props: {
      report: {
        state: "advertised",
        reason: "this camera advertises pan and tilt but there is no motor behind either — it accepts the command and nothing moves",
        pan: 0,
        tilt: 0,
        bounds: null,
        atLimit: { pitch: false, yaw: false },
        mode: "",
        modes: [],
        inhibited: null,
      },
    },
    payload: undefined,
    part: false,
  },
  {
    title: "Aim panel — at the limit, roll struck",
    note: "A second live specimen, at tilt's own mechanical limit (atLimit.yaw, drawing the pad's own pill) and in FPV mode — included specifically to show the struck-roll treatment beside a genuinely different reading than the plain live specimen above, so it is not the only place in this gallery a reviewer can see it. Only roll ever draws this way (coordinator resolution 7): the pad is a two-axis stick and never had a gesture for a third axis at all, and no gimbal this project supports has one yet.",
    component: YonderAim,
    props: {
      report: {
        state: "present",
        reason: "",
        pan: -178.2,
        tilt: 41.0,
        bounds: { pan: [-180, 180], tilt: [-90, 90] },
        atLimit: { pitch: false, yaw: true },
        mode: "FPV",
        modes: ["Follow", "Tilt lock", "FPV"],
        inhibited: null,
      },
    },
    payload: undefined,
    part: false,
  },
  {
    title: "Cameras index — two found",
    note: "Task 24: ui-yonder-index, R-CAM-12's 'what was found' half. The ELP again (compare the Deck and Aim specimens above) alongside a second, plainer CSI camera — one streaming (the good-tone badge, a real Mb/s reading from YonderReadout) and one idle (the neutral-tone badge, and the rate reads none rather than a blank gap, since an idle camera has nothing to measure). Each row's mono second line is summarise()'s own literal output over all 21 capability keys, not a second sentence composed here — the ELP's own reads 'exposure: auto exposure has it' partway through, exactly as capability.ts's own doc comment quotes it.",
    component: YonderIndex,
    props: {
      report: {
        cameras: [
          {
            id: "elp", name: "Nose", bus: "USB · UVC",
            spec: "1280×720 · 30 fps · MJPG · hardware",
            state: "Streaming", tone: "good", rate: 1.9,
            capabilities: ELP_REPORT.capabilities,
          },
          {
            id: "csi0", name: "Belly", bus: "CSI",
            spec: "1280×720 · 30 fps · H.264 · hardware",
            state: "Idle", tone: "neutral", rate: null,
            capabilities: BELLY_CAPABILITIES,
          },
        ],
        rejected: [],
      },
    },
    payload: undefined,
    part: false,
  },
  {
    title: "Cameras index — one found, one rejected",
    note: "The half of R-CAM-12 this page exists for: a device the probe saw and refused, drawn with its reason rather than simply missing. The reason is this board's own real K-40 finding, verbatim from probe/camera.ts's own module comment — the board's JPEG decoder advertises formats it cannot capture and looks like a camera to everything that asks.",
    component: YonderIndex,
    props: {
      report: {
        cameras: [
          {
            id: "elp", name: "Nose", bus: "USB · UVC",
            spec: "1280×720 · 30 fps · MJPG · hardware",
            state: "Streaming", tone: "good", rate: 1.9,
            capabilities: ELP_REPORT.capabilities,
          },
        ],
        rejected: [
          {
            device: "/dev/video10",
            reason: "bcm2835-codec-decode is a hardware codec on this board, not a camera; it advertises formats it cannot capture (K-40)",
          },
        ],
      },
    },
    payload: undefined,
    part: false,
  },
  {
    title: "Cameras index — the board he found",
    note: "R-CAM-20, R-CAM-21, and the exact state a real board was in. A camera's identity is the socket it is on (R-CAM-05), so moving one between USB ports makes it a different camera as far as the configuration is concerned and nothing ever removed the old entry — the same physical camera had been configured three times. The page drew none of it: it mapped detections only, so the two configured cameras on empty ports had no row at all, while the navigation, built from the same configuration, carried both. Here all three are drawn — the ELP that is present and configured nowhere, offering ADD, and the two that are configured and not on the bus, each stating the socket it expects and offering the key that clears it.",
    component: YonderIndex,
    props: {
      report: {
        cameras: [
          {
            id: null, name: "GENERAL — UVC Camera", bus: "usb · /dev/video0",
            spec: "not configured",
            identity: "platform-fd500000.pcie-pci-0000:01:00.0-usb-0:1.2:1.0-video-index0 — survives a reboot",
            state: "Not configured", tone: "neutral", rate: null,
            device: "platform-fd500000.pcie-pci-0000:01:00.0-usb-0:1.2:1.0-video-index0",
            capabilities: ELP_REPORT.capabilities,
            removal: "nothing is configured on this socket, so there is nothing to remove",
          },
          {
            id: "cam0", name: "Cam1", bus: "usb · no device",
            spec: "H264 · 1280×720p30",
            identity: "platform-fd500000.pcie-pci-0000:01:00.0-usb-0:1.3:1.0-video-index0 — configured on this socket; nothing there answered",
            state: "Not attached", tone: "bad", rate: null,
            device: "platform-fd500000.pcie-pci-0000:01:00.0-usb-0:1.3:1.0-video-index0",
            capabilities: null,
            removal: null,
          },
          {
            id: "cam1", name: "Global Shutter Camera", bus: "usb · no device",
            spec: "H264 · 1280×720p30",
            identity: "platform-fd500000.pcie-pci-0000:01:00.0-usb-0:1.1:1.0-video-index0 — configured on this socket; nothing there answered",
            state: "Not attached", tone: "bad", rate: null,
            device: "platform-fd500000.pcie-pci-0000:01:00.0-usb-0:1.1:1.0-video-index0",
            capabilities: null,
            removal: null,
          },
        ],
        rejected: [],
      },
    },
    payload: undefined,
    part: false,
  },
  {
    title: "Cameras index — empty",
    note: "Coordinator resolution 4: an operator whose camera has fallen off the bus must be able to tell an empty list from a page that failed. Drawn as 'No camera.' rather than a blank pane — the same instrument, given a report that genuinely found nothing, not a broken one given no report at all.",
    component: YonderIndex,
    props: {
      report: { cameras: [], rejected: [] },
    },
    payload: undefined,
    part: false,
  },
  {
    title: "Telemetry flow — carrying",
    note: "R-MAV-10, R-UI-13. The only instrument in the set that draws a relationship rather than a quantity: what an operator reads off it is which leg is dead, a reading three separate rows would leave them to assemble. Values here are a real board's — an ArduPilot on the UART at 115 200, mavlink-router in the middle, two ground stations out over the mesh.",
    component: YonderFlow,
    props: {},
    payload: {
      from: { label: "Autopilot", detail: "/dev/ttyAMA0 · 115 200 baud" },
      through: { label: "Yonder", detail: "mavlink-router" },
      to: { label: "2 ground stations", detail: "no TCP clients" },
      legs: [
        { rate: "1.0 Hz", caption: "heartbeat" },
        { rate: "4.7 kB/s", caption: "answering" },
      ],
    },
    part: false,
  },
  {
    title: "Telemetry flow — nothing on the wire",
    note: "An absent leg is dashed and grey, never red: nothing has failed when no autopilot has been wired yet, and red would be the same lie the path check refuses to tell for a link nobody attempted. The three places are still drawn, so the shape an operator is looking for does not move between the two readings.",
    component: YonderFlow,
    props: {},
    payload: {
      from: { label: "No autopilot", detail: "nothing answering on /dev/ttyAMA0", absent: true },
      through: { label: "Yonder", detail: "mavlink-router" },
      to: { label: "2 ground stations", detail: "no TCP clients" },
      legs: [{ absent: true }, { absent: true }],
    },
    part: false,
  },
  {
    title: "Captures — three on this board and one the camera holds",
    note: "R-CAM-18, blueprint L-48. Four rows of the four things that differ between them: a still with a thumbnail, a recording with none (there is no frame to show without decoding the file, so the row carries its kind instead), a still old enough to have stopped reading 'just now', and one the camera holds — which is listed, because a photograph that exists and is not here is a fact the operator needs, and carries none of the three keys, because Yonder never saw the file. Newest first is the daemon's own order, kept.",
    component: YonderCaptures,
    props: {},
    payload: {
      camera: "cam0",
      captures: [
        {
          name: "2026-09-07T14-22-05-123Z-1280x720.jpg",
          at: Date.now() - 4_000, bytes: 1_140_000, width: 1280, height: 720, held: "board",
        },
        {
          name: "2026-09-07T13-58-11-004Z-1280x720.mkv",
          at: Date.now() - 26 * 60_000, bytes: 214_800_000, width: 1280, height: 720, held: "board",
        },
        {
          name: "2026-09-07T13-41-02-870Z-1280x720.jpg",
          at: Date.now() - 41 * 60_000, bytes: 1_020_000, width: 1280, height: 720, held: "board",
        },
        {
          name: "DJI_0007.JPG",
          at: Date.now() - 3 * 60 * 60_000, bytes: 8_400_000, width: 4000, height: 3000, held: "camera",
        },
      ],
    },
    part: false,
  },
  {
    title: "Captures — nothing saved yet",
    note: "The empty listing drawn as a sentence rather than as a blank pane, the same guarantee the Cameras index makes: an operator must be able to tell 'nothing has been captured' from 'this panel failed to load'. The two are different states here — a report that genuinely lists none, against no report at all.",
    component: YonderCaptures,
    props: {},
    payload: { camera: "cam0", captures: [] },
    part: false,
  },
];
