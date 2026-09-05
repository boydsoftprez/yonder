import { h, defineComponent, reactive, ref } from "vue";
import Picker from "./DraftPicker.vue";
import Segmented from "./DraftSegmented.vue";
import SetBar from "./DraftSetBar.vue";
import Readout from "./DraftReadout.vue";
import Column from "./DraftColumn.vue";
import AimDial from "./DraftAimDial.vue";
import Picture from "./DraftPicture.vue";
import Captures from "./DraftCaptures.vue";
import RangeFinder from "./DraftRangeFinder.vue";
import SoftKeys from "../../../../../packages/node-red-dashboard-2-yonder/src/ui/YonderSoftKeys.vue";
import Annunciator from "../../../../../packages/node-red-dashboard-2-yonder/src/ui/YonderAnnunciator.vue";
import HoldKey from "../../../../../packages/node-red-dashboard-2-yonder/src/ui/YonderHoldKey.vue";
import TextField from "./DraftTextField.vue";
import { ELP, POCKET2 } from "./cameras.js";

function palette () {
  const s = getComputedStyle(document.documentElement);
  const v = (n, f) => (s.getPropertyValue("--yonder-" + n) || f).trim();
  return { display: v("display", "#04060a"), divider: v("divider", "#2b333c"),
    track: v("track", "#161b21"), label: v("label", "#7f8a95"),
    value: v("value", "#ffffff"), select: v("select", "#2ad4f0"),
    waiting: v("waiting", "#ffcf28") };
}

// Capture first (§5's viewport contract: the picture, Aim and Capture fit
// above the fold at 1440×900). Everything else keeps the pipeline order.
const COLUMNS = [
  ["capture", "Capture"], ["stream", "Stream"], ["preview", "Preview"], ["exposure", "Exposure"],
  ["colour", "Colour"], ["optics", "Optics"], ["rendering", "Rendering"],
  ["housekeeping", "Housekeeping"], ["aim", "Aim"],
];

/* The shared draft (§7 "Editing on Live and Setup"): a Live edit to a Stream
   or Preview field never touches `v` (the applied report) directly — it
   lands here, keyed by camera, until Setup's Apply or Discard. This is a
   module-level object rather than component state on purpose: main.js
   remounts DraftDeck under a fresh `key` on every Live↔Setup flip and every
   camera switch, and the spec's own words are "preserves each draft for the
   browser session" — a lifetime this module outlives every one of those
   remounts, the same way `cameras.js`'s two reports do. */
const DRAFTS = { elp: reactive({}), pocket2: reactive({}) };

/* The aim guard's precondition (§8.7, R-CAM-11): unknown until the range
   finder records it, per camera, for the browser session — same reasoning
   as DRAFTS above. The ELP has no motor, so its entry is never read. */
const ENVELOPES = reactive({ elp: true, pocket2: false });

/* Board-saved stills (§8.3, R-CAM-18) — camera-card photos never appear
   here, because Yonder cannot list, view or fetch those. The ELP has no
   card, so everything it captures lands on the board; the Pocket 2's own
   card is where its captures go today, so its list starts empty rather than
   inventing files nobody saved. */
const CAPTURES = {
  elp: reactive([
    { id: "s3", when: "2 s ago", size: "1280×720 · 1.1 MB" },
    { id: "s2", when: "14 min ago", size: "1280×720 · 1.0 MB" },
    { id: "s1", when: "41 min ago", size: "1280×720 · 1.1 MB" },
  ]),
  pocket2: reactive([]),
};

/* The deck decides what to draw from the report, and nothing else decides it.
   That is the whole point: a camera with no recorder has no Capture group
   without anybody having wired that. */
export const DraftDeck = defineComponent({
  name: "DraftDeck",
  props: { camera: { type: String, default: "elp" }, mode: { type: String, default: "live" },
           theme: { type: String, default: "night" },
           showUnproven: { type: Boolean, default: false }, link: { type: String, default: "good" },
           cameras: { type: Array, default: () => [] } },
  emits: ["go"],
  setup (props) {
    const cam = props.camera === "pocket2" ? POCKET2 : ELP;
    const v = reactive(Object.fromEntries(
      Object.entries(cam.controls).map(([k, c]) => [k, c.value])));
    const aim = reactive({ pan: 0, tilt: 0, slewPan: 0, slewTilt: 0 });
    const outputs = reactive({ rtp: "On", rtsp: "On", srt: "Off" });
    const bitrate = ref(3.0), recording = ref(false);
    const name = ref(cam.name); const flash = ref(0); const savedTo = ref(""); const fullRate = ref(false);
    const capturesOpen = ref(false);
    const pal = ref(palette());
    return { cam, v, aim, outputs, bitrate, recording, name, flash, savedTo, fullRate, capturesOpen, pal,
             refresh: () => { pal.value = palette(); } };
  },
  mounted () { this.refresh(); window.addEventListener("yonder-action", this.onAction); },
  beforeUnmount () { window.removeEventListener("yonder-action", this.onAction); },
  // Theme is a prop (not module-scoped like the palette read from it), for
  // exactly the reason an earlier pass learned the hard way: reassigning a
  // fresh palette object from `updated()` re-triggers the render that called
  // it, an infinite loop. Watching a prop fires once per real change instead.
  watch: { theme () { this.$nextTick(this.refresh); } },
  computed: {
    preview () {
      const v = this.v, link = this.link;
      const held = v.previewSize && v.previewSize !== "auto";
      const floor = Number(v.previewFloor) / 1000, ceil = Number(v.previewCeiling) / 1000;
      if (this.fullRate) return { tone: "select", head: "FULL RATE", size: "1280×720", rate: 30, mbps: 3.1,
        detail: "while held", step: "" };
      if (link === "lost") return { tone: "bad", head: "STILLS", size: "640×360", rate: 0, mbps: 0.012,
        detail: "every 2 s · live video could not be kept up", step: "fell back to stills — no frame for 6 s" };
      if (v.previewMode === "Fixed") return { tone: "label", head: "FIXED", size: held ? v.previewSize.replace("x", "×") : "640×360",
        rate: Number(v.previewRate), mbps: Number(v.previewBitrate ?? 0.4), detail: "", step: "" };
      if (held) return { tone: link === "poor" ? "waiting" : "label", head: "HELD", size: v.previewSize.replace("x", "×"),
        rate: Number(v.previewRate), mbps: link === "poor" ? floor : Math.min(ceil, 1.2),
        detail: link === "poor" ? `at the floor · ${floor.toFixed(1)} of ${floor.toFixed(1)}–${ceil.toFixed(1)} Mb/s · 1.2 s round trip` : `size held · bitrate adapting ${floor.toFixed(1)}–${ceil.toFixed(1)}`, step: "" };
      if (link === "poor") return { tone: "waiting", head: "AT THE FLOOR", size: "640×360", rate: Number(v.previewRate),
        mbps: floor, detail: `${floor.toFixed(1)} of ${floor.toFixed(1)}–${ceil.toFixed(1)} Mb/s · 1.2 s round trip`,
        step: "dropped to 640×360 — the link could not carry 720p" };
      return { tone: "label", head: "ADAPTIVE", size: "1280×720", rate: Number(v.previewRate), mbps: Math.min(ceil, 1.8),
        detail: `${Math.min(ceil, 1.8).toFixed(1)} of ${floor.toFixed(1)}–${ceil.toFixed(1)} Mb/s`, step: "" };
    },
    // Cost as three numbers (§8.2, §15's last correction), not the simulated
    // two-encode sum the picture used to add up. "Shared encode" stands for
    // whatever the one preview encode is doing for whoever needs it — a
    // second viewer, on full video regardless of what this browser session
    // sees, is why it is allowed to read differently from "this viewer" (two
    // viewers share one preview encode); this mockup does not simulate that
    // viewer as a visible fact, only the number it would produce, so the
    // divergence shows up honestly rather than always reading identical.
    cost () {
      const v = this.v;
      const ceil = Number(v.previewCeiling) / 1000;
      const othersStills = this.cameras.length > 1 ? 0.012 : 0;
      const encode = this.link === "good" || this.fullRate ? Math.min(ceil, 1.8) : Math.min(ceil, 1.2);
      const viewer = this.preview.mbps + othersStills;
      const path = this.bitrate + encode + othersStills;
      return { viewer, encode, path };
    },
    // Measured capacity of the path the encodes leave by (R-VID-11). The
    // harness moves it with the link switch; the daemon will measure it.
    uplink () {
      const cap = { good: 5.0, poor: 3.2, lost: 0.5 }[this.link] ?? 5.0;
      const total = this.cost.path;
      return { total, cap, over: total > cap };
    },
    pendingCount () { return Object.keys(DRAFTS[this.camera]).length; },
    // Setup's own listing: what changed, what it will interrupt. `streamBitrate`
    // is not a real report entry (§ below, where the bar is built by hand for
    // its own "actual vs. asked for" reasons), so it gets a small stand-in.
    pendingRows () {
      const d = DRAFTS[this.camera];
      const extra = { streamBitrate: { label: "Bitrate", unit: "Mb/s", interrupt: "current respawn path only" } };
      return Object.keys(d).map((key) => {
        const c = this.cam.controls[key] || extra[key] || {};
        let shown = d[key];
        if (Array.isArray(c.options)) {
          const opt = c.options.find((o) => String(typeof o === "object" ? o.value : o) === String(d[key]));
          if (opt) shown = typeof opt === "object" ? opt.label : opt;
        } else if (c.unit) shown = `${d[key]}${c.unit}`;
        return { key, label: c.label || key, shown, interrupt: c.interrupt || "" };
      });
    },
  },
  methods: {
    onAction (e) {
      if (e.detail === "apply") this.applyDraft();
      else if (e.detail === "discard") this.discardDraft();
    },
    draftOf (key) {
      const d = DRAFTS[this.camera];
      return Object.prototype.hasOwnProperty.call(d, key) ? d[key] : undefined;
    },
    // Picking the value already applied withdraws the draft rather than
    // recording a no-op change — Setup's list is "what will change", not
    // "every field the operator so much as touched".
    setDraft (key, value) {
      const d = DRAFTS[this.camera];
      if (String(value) === String(this.v[key])) delete d[key];
      else d[key] = value;
    },
    applyDraft () {
      const d = DRAFTS[this.camera];
      Object.assign(this.v, d);
      for (const k of Object.keys(d)) delete d[k];
    },
    discardDraft () {
      const d = DRAFTS[this.camera];
      for (const k of Object.keys(d)) delete d[k];
    },
    /* A control whose gate is not among its own `openValues` is gated by it
       (R-UI-21). `openValues` is the gate's own fact — which of its values
       leave the held control live — read off the device, never assumed from
       "the second option" or a literal id one camera happens to use. */
    stateOf (key, c) {
      for (const [gk, g] of Object.entries(this.cam.controls)) {
        if (!g.gates?.includes(key)) continue;
        const open = (g.openValues ?? []).includes(String(this.v[gk]));
        if (open) continue;
        const shown = g.kind === "pick"
          ? (g.options.find((o) => String(o.value) === String(this.v[gk]))?.label ?? this.v[gk])
          : this.v[gk];
        return { state: "gated", reason: `while ${g.label.toLowerCase()} is ${String(shown).toLowerCase()}` };
      }
      return { state: c.state, reason: c.reason ?? "" };
    },
    draw (key, c) {
      const st = this.stateOf(key, c);
      const unproven = this.showUnproven && c.proven !== true
        ? h("span", { class: "d-unproven" }, c.proven === "acknowledged" ? "acknowledged only" : c.proven === "partly" ? "partly proven" : "not tried yet")
        : null;
      const wrap = (node) => unproven ? h("div", { class: "d-wrapped" }, [node, unproven]) : node;

      if (c.state === "not-offered") {
        return h("div", { class: "d-fact" }, [
          h("span", { class: "l" }, c.label),
          h("span", { class: "v" }, c.why ?? "this camera has none"),
        ]);
      }

      // Stream and Preview are the shared draft (§7): a Live edit stages
      // here and waits for Setup's Apply, never applying on blur or nav.
      // Every other column (Exposure, Colour, Optics, Rendering, Capture,
      // Housekeeping) is "live on the running stream... never the apply
      // window" and writes `v` straight away, as it always has.
      const draftable = c.column === "stream" || c.column === "preview";
      const draft = draftable ? this.draftOf(key) : undefined;
      const pending = draft !== undefined;
      const set = (x) => { if (draftable) this.setDraft(key, x); else this.v[key] = x; };

      if (c.kind === "pick") return wrap(h(Picker, {
        label: c.label, modelValue: pending ? draft : this.v[key], options: c.options,
        state: st.state, reason: pending ? "Pending · apply on Setup" : st.reason,
        "onUpdate:modelValue": set,
      }));
      if (c.kind === "seg") return wrap(h(Segmented, {
        label: c.label, options: c.options, modelValue: pending ? draft : this.v[key],
        state: st.state, reason: pending ? "Pending · apply on Setup" : st.reason,
        "onUpdate:modelValue": set,
      }));
      if (c.kind === "bar") return wrap(h(SetBar, {
        label: c.label, unit: c.unit ?? "", min: c.min, max: c.max, step: c.step,
        precision: c.precision ?? 0, actual: this.v[key], fine: c.fine ?? "",
        pending: pending ? draft : null, ...st,
        onSet: set,
      }));
      if (c.kind === "shutter") {
        const photo = this.v.workMode === "Photo";
        const rec = this.recording && !photo;
        const freeText = photo
          ? (c.freeStills ? `${c.freeStills} photos free` : "")
          : (c.free ? `${c.free} min free` : "");
        const caps = CAPTURES[this.camera];
        return wrap(h("div", { class: "d-shutter" }, [
          h("button", { type: "button", class: ["d-shutter__b", { rec, photo }],
            onClick: () => {
              if (photo) {
                this.flash = Date.now();
                this.savedTo = c.to;
                caps.unshift({ id: "s" + this.flash, when: "just now", size: "1280×720 · 1.1 MB" });
              } else this.recording = !this.recording;
            } }, [
            photo ? null : h("i", { class: "d-shutter__dot" }),
            photo ? "Photo" : (rec ? "Recording  00:13:47" : "Record"),
          ]),
          h("span", { class: ["d-shutter__n", { warn: rec && c.note }] },
            rec ? (c.note ? `sent, not confirmed · ${c.note}` : `to ${c.to}`)
                : `to ${c.to}` + (freeText ? ` · ${freeText}` : "") + (c.note ? ` · ${c.note}` : "")),
          h("button", { type: "button", class: "d-caps-toggle",
            onClick: () => { this.capturesOpen = !this.capturesOpen; } },
            `Captures (${caps.length}) ${this.capturesOpen ? "▴" : "›"}`),
          this.capturesOpen ? h(Captures, {
            items: caps,
            onView: () => {}, onDownload: () => {},
            onDelete: (id) => { const i = caps.findIndex((x) => x.id === id); if (i >= 0) caps.splice(i, 1); },
          }) : null,
        ]));
      }
      return null;
    },
  },
  render () {
    const cam = this.cam, setup = this.mode === "setup";
    const aimLive = cam.aim.state === "present";
    const hasAim = cam.aim.state !== "not-offered";
    // §8.7/R-CAM-11: unknown bounds inhibit motion. Recorded per camera by
    // the range finder below; the ELP has no motor, so it is never inhibited
    // by this — its panel is dead for the reason it always was.
    const inhibited = aimLive && !ENVELOPES[this.camera];
    const aimUsable = aimLive && !inhibited;

    const aimPanel = hasAim ? h("div", { class: ["d-aimpanel", { dead: !aimUsable }] }, [
      h("div", { class: "d-h" }, [h("span", "Aim"),
        h("em", { class: ["d-badge", aimUsable ? "" : "warn"] }, [h("i"),
          !aimLive ? "not answering" : inhibited ? "envelope unknown" : "rate control"])]),
      h(AimDial, {
        pan: this.aim.pan, tilt: this.aim.tilt, c: this.pal,
        atLimit: aimUsable && Math.abs(this.aim.tilt) > 60,
        axes: aimUsable ? { pan: "present", tilt: "present", roll: "advertised" }
                      : { pan: "advertised", tilt: "advertised", roll: "advertised" },
        onSlew: ({ pan, tilt }) => { if (aimUsable) { this.aim.slewPan = pan; this.aim.slewTilt = tilt; } },
        onStop: () => { this.aim.slewPan = 0; this.aim.slewTilt = 0; },
      }),
      ...Object.entries(cam.controls).filter(([, c]) => c.column === "aim").map(([k, c]) => this.draw(k, c)),
      aimUsable ? h("div", { class: "d-modenote" }, {
        "Follow": "Pan and tilt follow the handle.",
        "Tilt lock": "Tilt holds where you put it; pan follows the handle.",
        "FPV": "Everything follows the handle, roll included.",
      }[this.v.gimbalMode] ?? "") : null,
      inhibited ? h("div", { class: "d-why why-advertised" }, "envelope unknown — run the range finder") : null,
      aimUsable ? h("button", { type: "button", class: "d-recentre d-recentre--soft",
        onClick: () => { this.aim.pan = 0; this.aim.tilt = 0; } }, "Recentre gimbal") : null,
      (!aimLive && cam.aim.reason) ? h("div", { class: "d-why why-advertised" }, cam.aim.reason) : null,
    ]) : null;

    const [expLabel, expValue] = cam.exposureReadout ? cam.exposureReadout(this.v) : ["", ""];
    // Zoom's display text is the camera's own fact, decided once here from
    // the report's unit (blank for the ELP's device steps, "×" for the
    // Pocket 2's calibrated digital ratio) — never a formula the picture
    // invents for itself (R-CTL-14).
    const zc = cam.controls.zoom;
    const zoomText = zc ? Number(this.v.zoom ?? 0).toFixed(zc.precision ?? 0) + (zc.unit || "") : "";
    const picture = h(Picture, {
      zoomText, expLabel, expValue, preview: this.preview,
      pan: this.aim.pan, tilt: this.aim.tilt,
      slewPan: this.aim.slewPan, slewTilt: this.aim.slewTilt, aimable: aimUsable,
      recording: this.recording, flash: this.flash, savedTo: this.savedTo,
      onSlew: ({ pan, tilt }) => { if (aimUsable) { this.aim.slewPan = pan; this.aim.slewTilt = tilt; } },
      onStop: () => { this.aim.slewPan = 0; this.aim.slewTilt = 0; },
    });

    // The other cameras, as periodic stills, so they can be seen without paying
    // for their video; one press switches.
    const thumbs = this.cameras.length > 1 ? h("div", { class: "d-thumbs" }, [
      ...this.cameras.map((c) => {
        const on = c.id === this.camera;
        return h("button", { type: "button", class: ["d-thumb", { on }],
          onClick: () => { if (!on) this.$emit("go", "camera:" + c.id); } }, [
          h("span", { class: ["d-thumb__pic", c.id === "pocket2" ? "tele" : ""] }),
          h("span", { class: "d-thumb__tag" }, [h("b", c.name), h("em", on ? "Live" : "Still · 4 s")]),
        ]);
      }),
      h("div", { class: "d-thumbs__cost" }, [
        h("em", "Other cameras"),
        h("span", [h("b", "12 kb/s"), h("em", " of stills · counted in Path total")]),
      ]),
    ]) : null;

    const strip = h("div", { class: "d-strip" }, [
      h(Annunciator, { id: "deck-ann", props: { source: "payload" } }),
      h("span", { class: "d-fact2" }, ["Browser ", h("b", "1 viewer")]),
      h("span", { class: "d-fact2" }, ["Ground station ", h("b", "10.50.x.x:5600")]),
      // Cost as three numbers (§8.2, §15): this viewer's own delivery, the
      // one shared preview encode, and the path total — not one simulated
      // sum standing in for all three, which is what this line used to be.
      h("span", { class: "d-fact2" }, ["This viewer ", h("b", `${this.cost.viewer.toFixed(this.cost.viewer < 0.1 ? 3 : 1)} Mb/s`)]),
      h("span", { class: "d-fact2" }, ["Shared encode ", h("b", `${this.cost.encode.toFixed(1)} Mb/s`)]),
      h("span", { class: ["d-fact2", { over: this.uplink.over }] }, ["Path total ",
        h("b", `${this.cost.path.toFixed(1)} of ${this.uplink.cap.toFixed(1)} Mb/s`),
        this.uplink.over ? h("em", " · over — the ground station's stream comes first") : null]),
    ]);

    const adaptiveStream = (this.draftOf("streamMode") ?? this.v.streamMode) === "Adaptive";
    const streamPending = this.draftOf("streamBitrate");
    const bitrate = h(SetBar, { label: adaptiveStream ? "Going out" : "Bitrate",
      unit: "Mb/s", min: 0.5, max: 8, step: 0.1, precision: 1,
      actual: this.bitrate, pending: adaptiveStream ? null : (streamPending ?? null),
      fine: `going out ${this.bitrate.toFixed(1)}`,
      onSet: adaptiveStream ? undefined : (x) => { this.setDraft("streamBitrate", x); } });


    const outLine = h("div", { class: "d-outline" }, [
      h("span", { class: "d-h" }, "Outputs"),
      h("span", { class: "o ok" }, ["Ground station ", h("b", "3.0 Mb/s")]),
      h("span", { class: ["o", this.outputs.rtsp === "On" ? "warn" : ""] },
        ["RTSP ", h("b", this.outputs.rtsp === "On" ? "idle · nothing can reach it over cellular" : "off")]),
      h("span", { class: "o" }, ["SRT ", h("b", this.outputs.srt === "On" ? "idle" : "off")]),
      h("span", { class: "o goto" }, "stop or start them on Setup ›"),
    ]);

    /* ---- The deck: every control the camera has. Setup adds the bench-only ones. ---- */
    const cols = COLUMNS.filter(([id]) => id !== "aim").map(([id, title]) => {
      const entries = Object.entries(cam.controls)
        .filter(([, c]) => c.column === id && (setup || !c.setup));
      if (id === "stream") {
        const adaptive = (this.draftOf("streamMode") ?? this.v.streamMode) === "Adaptive";
        const keep = entries.filter(([k]) => adaptive || (k !== "streamFloor" && k !== "streamCeiling"));
        entries.length = 0; entries.push(...keep);
        entries.splice(1, 0, ["__bitrate", { kind: "__bitrate" }]);
      }
      if (id === "preview") {
        const adaptive = (this.draftOf("previewMode") ?? this.v.previewMode) === "Adaptive";
        const auto = (this.draftOf("previewSize") ?? this.v.previewSize) === "auto";
        const keep = entries.filter(([k]) =>
          (adaptive || (k !== "previewFloor" && k !== "previewCeiling")) &&
          (auto || (k !== "previewLadderBottom" && k !== "previewLadderTop")) &&
          (!adaptive || k !== "previewBitrate"));
        entries.length = 0; entries.push(...keep);
        if (adaptive) entries.splice(1, 0, ["__pbar", { kind: "__pbar" }]);
      }
      if (id === "stream" && setup) entries.unshift(["__name", { kind: "__name" }]);
      if (!entries.length) return null;
      const note = id === "stream" ? "to the ground station" : id === "preview" ? "to this browser" : "";
      return h(Column, { title, note, noteTone: "label" }, () => [
        ...entries.map(([k, c]) => k === "__name"
          ? h(TextField, { label: "Name", modelValue: this.name, placeholder: "Cam 1", max: 24,
              hint: "shown on this page, in the camera list and on the stream address",
              "onUpdate:modelValue": (x) => { this.name = x; } })
          : k === "__bitrate" ? bitrate
          : k === "__pbar" ? h(SetBar, { label: "Going out", unit: "Mb/s", min: 0, max: 4, step: 0.1, precision: 1,
              actual: this.preview.mbps, fine: `${this.preview.head.toLowerCase()} · ${this.preview.size} · ${this.preview.rate || "—"} fps` })
          : this.draw(k, c)),
        id === "capture" && cam.readouts ? h(Readout, { rows: cam.readouts }) : null,
      ]);
    }).filter(Boolean);

    // The range finder is a Setup step (§15), not a Live one: it is how the
    // envelope the Aim panel is waiting for gets recorded in the first place.
    if (setup && hasAim && aimLive) {
      cols.push(h(Column, { title: "Aim",
        note: ENVELOPES[this.camera] ? "envelope recorded" : "envelope unknown",
        noteTone: ENVELOPES[this.camera] ? "select" : "waiting" }, () => [
        ...Object.entries(cam.controls).filter(([, c]) => c.column === "aim").map(([k, c]) => this.draw(k, c)),
        h(RangeFinder, { known: ENVELOPES[this.camera],
          "onUpdate:known": () => { ENVELOPES[this.camera] = true; } }),
      ]));
    }

    const out = (key, label, cost, note, tone) => h("div", { class: "d-out" }, [
      h("span", { class: "n" }, label), h("span", { class: "c" }, cost),
      h("span", { class: ["r", tone] }, note),
      h(Segmented, { options: ["On", "Off"], modelValue: this.outputs[key],
        "onUpdate:modelValue": (x) => { this.outputs[key] = x; } }),
    ]);
    const outTable = h("div", { class: "d-outs" }, [
      h(Column, { title: "Outputs", note: this.outputs.rtsp === "On" ? "1 unreachable" : "", noteTone: "waiting" }, () => [
        out("rtp", "Ground station", "3.0 Mb/s", "outbound — works on this link", "ok"),
        out("rtsp", "RTSP", this.outputs.rtsp === "On" ? "idle" : "off",
          "nothing can reach this over cellular · works on the mesh", "warn"),
        out("srt", "SRT", this.outputs.srt === "On" ? "idle" : "off", "inbound listener", ""),
      ]),
    ]);

    const pendingBlock = (setup && this.pendingCount) ? h("div", { class: "d-pending" }, [
      h("div", { class: "d-h" }, [h("span", "Pending changes"),
        h("em", { class: "q-select" }, `${this.pendingCount} · Apply or Discard on the rail`)]),
      ...this.pendingRows.map((r) => h("div", { class: "d-pending__row" }, [
        h("span", { class: "l" }, r.label),
        h("span", { class: "v" }, String(r.shown)),
        h("span", { class: "i" }, r.interrupt || "no interruption known"),
      ])),
    ]) : null;

    const keys = [
      { label: "Live", action: "live", active: !setup },
      { label: (!setup && this.pendingCount) ? `Setup · ${this.pendingCount}` : "Setup", action: "setup", active: setup },
      { label: "Stream address", action: "addr" },
      ...(setup ? [
        { label: "Discard", action: "discard" },
        { label: "Apply", action: "apply", tone: "warn" },
      ] : []),
    ];

    return h("div", { class: "d-panel" }, [
      h("div", { class: "d-placard" }, [
        h("span", [h("b", "Camera"), " · ", this.name]),
        h("span", cam.spec),
      ]),
      h("div", { class: "d-display" }, setup
        ? [pendingBlock, picture, strip, h("div", { class: "d-cols" }, cols.map((c) => h("div", {}, [c]))), outTable,
           h("div", { class: "d-rail" }, [h(SoftKeys, { id: "deck-keys", props: { passthru: false, keys } })])]
        : [h("div", { class: "d-stage" }, [h("div", { class: "d-stage__pic" }, [picture]), aimPanel]),
           thumbs, strip, h("div", { class: "d-cols" }, cols.map((c) => h("div", {}, [c]))), outLine,
           h("div", { class: "d-rail d-rail--two" }, [
             h(SoftKeys, { id: "deck-keys", props: { passthru: false, keys } }),
             h("div", { class: ["d-hold", { on: this.fullRate }],
               onPointerdown: () => { this.fullRate = true; }, onPointerup: () => { this.fullRate = false; },
               onPointerleave: () => { this.fullRate = false; } }, [
               h("b", "Full rate"), h("span", this.fullRate ? "1280×720 · 3.1 Mb/s · release to drop back" : "3.1 Mb/s while held"),
             ]),
           ])]),
    ]);
  },
});
