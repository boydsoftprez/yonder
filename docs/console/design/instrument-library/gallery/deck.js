import { h, defineComponent, reactive, ref } from "vue";
import Picker from "./DraftPicker.vue";
import Segmented from "./DraftSegmented.vue";
import SetBar from "./DraftSetBar.vue";
import Readout from "./DraftReadout.vue";
import Column from "./DraftColumn.vue";
import AimDial from "./DraftAimDial.vue";
import Picture from "./DraftPicture.vue";
import SoftKeys from "../../../../packages/node-red-dashboard-2-yonder/src/ui/YonderSoftKeys.vue";
import Annunciator from "../../../../packages/node-red-dashboard-2-yonder/src/ui/YonderAnnunciator.vue";
import HoldKey from "../../../../packages/node-red-dashboard-2-yonder/src/ui/YonderHoldKey.vue";
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

const COLUMNS = [
  ["stream", "Stream"], ["preview", "Preview"], ["exposure", "Exposure"], ["colour", "Colour"],
  ["optics", "Optics"], ["rendering", "Rendering"], ["capture", "Capture"],
  ["housekeeping", "Housekeeping"], ["aim", "Aim"],
];

/* The deck decides what to draw from the report, and nothing else decides it.
   That is the whole point: a camera with no recorder has no Capture group
   without anybody having wired that. */
export const DraftDeck = defineComponent({
  name: "DraftDeck",
  props: { camera: { type: String, default: "elp" }, mode: { type: String, default: "live" },
           showUnproven: { type: Boolean, default: false }, link: { type: String, default: "good" },
           cameras: { type: Array, default: () => [] } },
  emits: ["go"],
  setup (props) {
    const cam = props.camera === "pocket2" ? POCKET2 : ELP;
    const v = reactive(Object.fromEntries(
      Object.entries(cam.controls).map(([k, c]) => [k, c.value])));
    const aim = reactive({ pan: 0, tilt: 0, slewPan: 0, slewTilt: 0 });
    const outputs = reactive({ rtp: "On", rtsp: "On", srt: "Off" });
    const bitrate = ref(3.0), commanded = ref(3.4), recording = ref(false);
    const name = ref(cam.name); const flash = ref(0); const fullRate = ref(false);
    const pal = ref(palette());
    return { cam, v, aim, outputs, bitrate, commanded, recording, name, flash, fullRate, pal,
             refresh: () => { pal.value = palette(); } };
  },
  mounted () { this.refresh(); },
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
        rate: Number(v.previewRate), mbps: 0.4, detail: "", step: "" };
      if (held) return { tone: link === "poor" ? "waiting" : "label", head: "HELD", size: v.previewSize.replace("x", "×"),
        rate: Number(v.previewRate), mbps: link === "poor" ? floor : Math.min(ceil, 1.2),
        detail: link === "poor" ? `at the floor · ${floor.toFixed(1)} of ${floor.toFixed(1)}–${ceil.toFixed(1)} Mb/s · 1.2 s round trip` : `size held · bitrate adapting ${floor.toFixed(1)}–${ceil.toFixed(1)}`, step: "" };
      if (link === "poor") return { tone: "waiting", head: "AT THE FLOOR", size: "640×360", rate: Number(v.previewRate),
        mbps: floor, detail: `${floor.toFixed(1)} of ${floor.toFixed(1)}–${ceil.toFixed(1)} Mb/s · 1.2 s round trip`,
        step: "dropped to 640×360 — the link could not carry 720p" };
      return { tone: "label", head: "ADAPTIVE", size: "1280×720", rate: Number(v.previewRate), mbps: Math.min(ceil, 1.8),
        detail: `${Math.min(ceil, 1.8).toFixed(1)} of ${floor.toFixed(1)}–${ceil.toFixed(1)} Mb/s`, step: "" };
    },
    // Measured capacity of the path the encodes leave by (R-VID-11). The
    // harness moves it with the link switch; the daemon will measure it.
    uplink () {
      const cap = { good: 5.0, poor: 3.2, lost: 0.5 }[this.link] ?? 5.0;
      const total = this.bitrate + this.preview.mbps;
      return { total, cap, over: total > cap };
    },
  },
  methods: {
    /* A control whose gate is not on Manual is gated by it (R-UI-21). */
    stateOf (key, c) {
      for (const [gk, g] of Object.entries(this.cam.controls)) {
        if (!g.gates?.includes(key)) continue;
        const open = g.kind === "seg" ? this.v[gk] !== g.options[0] : this.v[gk] === "4";
        if (open) continue;
        // The operator's word for the setting, never the wire value — the page
        // prints this as the way back, and "while exposure is 1" is not one.
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
      if (c.kind === "pick") return wrap(h(Picker, {
        label: c.label, modelValue: this.v[key], options: c.options, ...st,
        "onUpdate:modelValue": (x) => { this.v[key] = x; },
      }));
      if (c.kind === "seg") return wrap(h(Segmented, {
        label: c.label, options: c.options, modelValue: this.v[key], ...st,
        "onUpdate:modelValue": (x) => { this.v[key] = x; },
      }));
      if (c.kind === "bar") return wrap(h(SetBar, {
        label: c.label, unit: c.unit ?? "", min: c.min, max: c.max, step: c.step,
        precision: c.precision ?? 0, actual: this.v[key], fine: c.fine ?? "", ...st,
        onSet: (x) => { this.v[key] = x; },
      }));
      if (c.kind === "shutter") {
        const photo = this.v.workMode === "Photo";
        const rec = this.recording && !photo;
        return wrap(h("div", { class: "d-shutter" }, [
          h("button", { type: "button", class: ["d-shutter__b", { rec, photo }],
            onClick: () => { if (photo) this.flash = Date.now(); else this.recording = !this.recording; } }, [
            photo ? null : h("i", { class: "d-shutter__dot" }),
            photo ? "Photo" : (rec ? "Recording  00:13:47" : "Record"),
          ]),
          h("span", { class: ["d-shutter__n", { warn: rec && c.note }] },
            rec ? (c.note ? `sent, not confirmed · ${c.note}` : `to ${c.to}`)
                : `to ${c.to}` + (c.free ? ` · ${c.free} min free` : "") + (c.note ? ` · ${c.note}` : "")),
        ]));
      }
      return null;
    },
  },
  render () {
    const cam = this.cam, setup = this.mode === "setup";
    const aimLive = cam.aim.state === "present";
    const hasAim = cam.aim.state !== "not-offered";

    const aimPanel = hasAim ? h("div", { class: ["d-aimpanel", { dead: !aimLive }] }, [
      h("div", { class: "d-h" }, [h("span", "Aim"),
        h("em", { class: ["d-badge", aimLive ? "" : "warn"] }, [h("i"), aimLive ? "rate control" : "not answering"])]),
      h(AimDial, {
        pan: this.aim.pan, tilt: this.aim.tilt, c: this.pal,
        atLimit: aimLive && Math.abs(this.aim.tilt) > 60,
        axes: aimLive ? { pan: "present", tilt: "present", roll: "advertised" }
                      : { pan: "advertised", tilt: "advertised", roll: "advertised" },
        onSlew: ({ pan, tilt }) => { this.aim.slewPan = pan; this.aim.slewTilt = tilt; },
        onStop: () => { this.aim.slewPan = 0; this.aim.slewTilt = 0; },
      }),
      ...Object.entries(cam.controls).filter(([, c]) => c.column === "aim").map(([k, c]) => this.draw(k, c)),
      aimLive ? h("div", { class: "d-modenote" }, {
        "Follow": "Pan and tilt follow the handle.",
        "Tilt lock": "Tilt holds where you put it; pan follows the handle.",
        "FPV": "Everything follows the handle, roll included.",
      }[this.v.gimbalMode] ?? "") : null,
      aimLive ? h("button", { type: "button", class: "d-recentre d-recentre--soft",
        onClick: () => { this.aim.pan = 0; this.aim.tilt = 0; } }, "Recentre gimbal") : null,
      cam.aim.reason ? h("div", { class: "d-why why-advertised" }, cam.aim.reason) : null,
    ]) : null;

    const [expLabel, expValue] = cam.exposureReadout ? cam.exposureReadout(this.v) : ["", ""];
    const picture = h(Picture, {
      zoom: this.v.zoom ?? 0, expLabel, expValue, preview: this.preview,
      pan: this.aim.pan, tilt: this.aim.tilt,
      slewPan: this.aim.slewPan, slewTilt: this.aim.slewTilt, aimable: aimLive,
      recording: this.recording,
      onSlew: ({ pan, tilt }) => { this.aim.slewPan = pan; this.aim.slewTilt = tilt; },
      onStop: () => { this.aim.slewPan = 0; this.aim.slewTilt = 0; },
    });

    // The other cameras, as periodic stills, so they can be seen without paying
    // for their video; one press switches. The cost of all of it, stated.
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
        h("em", "Downlink now"),
        h("span", [h("b", `${this.preview.mbps.toFixed(1)} Mb/s`), " + ", h("b", "12 kb/s"), h("em", " of stills")]),
      ]),
    ]) : null;

    const strip = h("div", { class: "d-strip" }, [
      h(Annunciator, { id: "deck-ann", props: { source: "payload" } }),
      h("span", { class: "d-fact2" }, ["Browser ", h("b", "1 viewer")]),
      h("span", { class: "d-fact2" }, ["Ground station ", h("b", "10.50.x.x:5600")]),
      h("span", { class: ["d-fact2", { over: this.uplink.over }] }, ["Uplink ",
        h("b", `${this.uplink.total.toFixed(1)} of ${this.uplink.cap.toFixed(1)} Mb/s`),
        this.uplink.over ? h("em", " · over — the ground station's stream comes first") : null]),
    ]);

    const bitrate = h(SetBar, { label: this.v.streamMode === "Adaptive" ? "Going out" : "Bitrate",
      unit: "Mb/s", min: 0.5, max: 8, step: 0.1, precision: 1,
      actual: this.bitrate, commanded: this.commanded,
      fine: `going out ${this.bitrate.toFixed(1)} · asked for ${this.commanded.toFixed(1)}`,
      onSet: (x) => { this.commanded = x; } });


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
      if (id === "stream") entries.splice(1, 0, ["__bitrate", { kind: "__bitrate" }]);
      if (id === "preview") {
        const adaptive = this.v.previewMode === "Adaptive";
        const keep = entries.filter(([k]) => adaptive || (k !== "previewFloor" && k !== "previewCeiling"));
        entries.length = 0; entries.push(...keep);
        entries.splice(1, 0, ["__pbar", { kind: "__pbar" }]);
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

    const keys = [
      { label: "Live", action: "live", active: !setup },
      { label: "Setup", action: "setup", active: setup },
      { label: "Stream address", action: "addr" },
      ...(setup ? [{ label: "Apply", action: "apply", tone: "warn" }] : []),
    ];

    return h("div", { class: "d-panel" }, [
      h("div", { class: "d-placard" }, [
        h("span", [h("b", "Camera"), " · ", this.name]),
        h("span", cam.spec),
      ]),
      h("div", { class: "d-display" }, setup
        ? [picture, strip, h("div", { class: "d-cols" }, cols.map((c) => h("div", {}, [c]))), outTable,
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
