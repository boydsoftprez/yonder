// SPDX-License-Identifier: GPL-3.0-or-later
import YonderAnnunciator from "../src/ui/YonderAnnunciator.vue";
import YonderBudget from "../src/ui/YonderBudget.vue";
import YonderDataBar from "../src/ui/YonderDataBar.vue";
import YonderFacts from "../src/ui/YonderFacts.vue";
import YonderGauge from "../src/ui/YonderGauge.vue";
import YonderHoldKey from "../src/ui/YonderHoldKey.vue";
import YonderIdentity from "../src/ui/YonderIdentity.vue";
import YonderPicker from "../src/ui/YonderPicker.vue";
import YonderPicture from "../src/ui/YonderPicture.vue";
import YonderReadout from "../src/ui/YonderReadout.vue";
import YonderSegmented from "../src/ui/YonderSegmented.vue";
import YonderSoftKeys from "../src/ui/YonderSoftKeys.vue";
import YonderSparkline from "../src/ui/YonderSparkline.vue";
import YonderTape from "../src/ui/YonderTape.vue";
import YonderTextField from "../src/ui/YonderTextField.vue";

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
export const SPECIMENS = [
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
];
