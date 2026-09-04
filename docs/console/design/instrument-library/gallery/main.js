import { createApp, h, ref, defineComponent } from "vue";
import Shell from "./DraftShell.vue";
import Index from "./DraftIndex.vue";
import { DraftDeck } from "./deck.js";
import Budget from "../../../../packages/node-red-dashboard-2-yonder/src/ui/YonderBudget.vue";
import Gauge from "../../../../packages/node-red-dashboard-2-yonder/src/ui/YonderGauge.vue";
import SoftKeys from "../../../../packages/node-red-dashboard-2-yonder/src/ui/YonderSoftKeys.vue";
import "../../../../packages/node-red-dashboard-2-yonder/src/ui/tokens.css";
import "./gallery.css";

const messages = {};
const store = { state: { data: { messages } } };
const put = (id, payload) => { messages[id] = { payload }; };
put("deck-ann", { state: "confirmed" });
put("idx-budget", { budget: { capacityKbps: 3200, segments: [
  { label: "Nose", kbps: 3000 }, { label: "Previews", kbps: 400 },
] } });
put("idx-encode", 21);

const CAMERAS = [
  { id: "cam0", name: "Nose", bus: "USB · UVC", thumb: "", spec: "1280×720 · 30 fps · H.264",
    encoder: "hardware", probe: "usb-1.2 · ELP-USBFHD01M · aim: unanswered · zoom: present",
    state: "Streaming", tone: "", rate: "3.0" },
  { id: "cam1", name: "Gimbal", bus: "USB accessory", thumb: "tele",
    spec: "1280×720 · 30 fps · H.264", encoder: "re-encoded",
    probe: "Pocket 2 · aim: pan+tilt rate · zoom: digital crop · records to its own card",
    state: "Idle", tone: "idle", rate: "" },
];
const REJECTED = [
  { device: "/dev/video10", why: "bcm2835-codec-decode is a hardware codec on this board, not a camera.",
    note: "Listed because it looks like a camera to everything that asks (K-40)." },
  { device: "/dev/video13", why: "bcm2835-isp is a hardware codec on this board, not a camera.", note: "" },
];

const App = defineComponent({
  setup () {
    const theme = ref("night");
    const camera = ref("elp");
    const page = ref("camera-live");
    const unproven = ref(false);
    const setTheme = (t) => {
      theme.value = t;
      let link = document.getElementById("theme");
      if (!link) {
        link = document.createElement("link");
        link.id = "theme"; link.rel = "stylesheet";
        document.head.appendChild(link);
      }
      link.href = "./theme." + t + ".css";
      document.documentElement.setAttribute("data-theme", t);
    };
    setTheme("night");
    window.addEventListener("yonder-go", (e) => { page.value = e.detail; });

    const TITLES = {
      "cameras": "Cameras", "camera-live": "Camera", "camera-setup": "Camera",
      "status": "Status", "network": "Network", "log": "Log", "diagnostics": "Diagnostics",
    };

    return () => h("div", { class: "g-root" }, [
      h("div", { class: "g-bar" }, [
        h("div", { class: "g-bar__t" }, "Yonder console — draft, in the real components"),
        h("div", { class: "g-bar__c" }, [
          h("div", { class: "g-switch" }, ["night", "day"].map((t) =>
            h("button", { class: { on: theme.value === t }, onClick: () => setTheme(t) }, t))),
          h("div", { class: "g-switch" }, [
            ["cameras", "Cameras"], ["camera-live", "Camera · Live"], ["camera-setup", "Camera · Setup"],
          ].map(([k, lbl]) => h("button", {
            class: { on: page.value === k }, onClick: () => { page.value = k; },
          }, lbl))),
          h("div", { class: "g-switch" }, [
            ["elp", "ELP — aim advertised"], ["pocket2", "Pocket 2 — aim live"],
          ].map(([k, lbl]) => h("button", {
            class: { on: camera.value === k }, onClick: () => { camera.value = k; },
          }, lbl))),
          h("div", { class: "g-switch" }, [h("button", {
            class: { on: unproven.value }, onClick: () => { unproven.value = !unproven.value },
          }, "mark unproven")]),
        ]),
      ]),
      h(Shell, {
        page: page.value.startsWith("camera-") && page.value !== "cameras" ? "camera-live" : page.value,
        title: TITLES[page.value] ?? "",
        onGo: (p) => { page.value = p === "camera-live" ? "camera-live" : p; },
      }, () => page.value === "cameras"
        ? [
            h(Index, { cameras: CAMERAS, rejected: REJECTED, onOpen: () => { page.value = "camera-live"; } }),
            h("div", { class: "d-panel", style: "margin-top:16px" }, [
              h("div", { class: "d-display d-two" }, [
                h("div", { class: "d-half" }, [
                  h("div", { class: "d-grp2" }, "This board"),
                  h(Gauge, { id: "idx-encode", props: {
                    label: "Encoding used", unit: "%", min: 0, max: 100,
                    caution: 60, limit: 85, precision: 0, track: 150, series: [],
                  } }),
                  h("div", { class: "d-fine2" }, "room for one more 1080p30 stream"),
                ]),
                h("div", { class: "d-half" }, [
                  h("div", { class: "d-grp2" }, "Uplink"),
                  h(Budget, { id: "idx-budget", props: { label: "All cameras", capacityKbps: 3200, segments: [] } }),
                  h("div", { class: "d-fine2" }, "starting the gimbal would need 2.1 more"),
                ]),
              ]),
              h("div", { class: "d-rail" }, [h(SoftKeys, { id: "idx-keys", props: { passthru: false, keys: [
                { label: "Detect again", action: "detect", active: true },
                { label: "Add by address", action: "add" },
                { label: "Apply", action: "apply", tone: "warn" },
              ] } })]),
            ]),
          ]
        : [h(DraftDeck, {
            key: camera.value + page.value,
            theme: theme.value, camera: camera.value,
            mode: page.value === "camera-setup" ? "setup" : "live",
            showUnproven: unproven.value,
          })]),
    ]);
  },
});

const app = createApp(App);
// The real rail emits `widget-action` on Dashboard's socket. Here the socket is
// the harness, and a page key changes the page.
app.provide("$dataTracker", () => {});
app.provide("$socket", { on () {}, off () {},
  emit (event, id, msg) {
    if (event !== "widget-action") return;
    const go = { live: "camera-live", setup: "camera-setup" }[msg?.payload];
    if (go) window.dispatchEvent(new CustomEvent("yonder-go", { detail: go }));
  } });
app
  .mixin({ computed: { $store: () => store } })
  .mount("#app");
