import { createApp, h, ref, defineComponent } from "vue";
import Shell from "./DraftShell.vue";
import Index from "./DraftIndex.vue";
import { DraftDeck } from "./deck.js";
import Budget from "../../../../../packages/node-red-dashboard-2-yonder/src/ui/YonderBudget.vue";
import Gauge from "../../../../../packages/node-red-dashboard-2-yonder/src/ui/YonderGauge.vue";
import SoftKeys from "../../../../../packages/node-red-dashboard-2-yonder/src/ui/YonderSoftKeys.vue";
import "../../../../../packages/node-red-dashboard-2-yonder/src/ui/tokens.css";
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
    const page = ref("camera:elp");
    const setup = ref(false);
    const camera = { get value () { return page.value.startsWith("camera:") ? page.value.slice(7) : "elp"; } };
    const unproven = ref(false);
    const link = ref("good");
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
    window.addEventListener("yonder-mode", (e) => { setup.value = e.detail === "setup"; });

    const CAMS = [{ id: "elp", name: "Cam 1" }, { id: "pocket2", name: "Cam 2" }];
    const TITLES = { cameras: "Cameras", status: "Status", network: "Network", log: "Log", diagnostics: "Diagnostics" };
    const title = () => page.value.startsWith("camera:") ? "Camera" : (TITLES[page.value] ?? "");

    return () => h("div", { class: "g-root" }, [
      h("div", { class: "g-bar" }, [
        h("div", { class: "g-bar__t" }, "Yonder console — draft, in the real components"),
        h("div", { class: "g-bar__c" }, [
          h("div", { class: "g-switch" }, ["night", "day"].map((t) =>
            h("button", { class: { on: theme.value === t }, onClick: () => setTheme(t) }, t))),
          h("div", { class: "g-switch" }, [["live", "Live"], ["setup", "Setup"]].map(([k, lbl]) =>
            h("button", { class: { on: setup.value === (k === "setup") }, onClick: () => { setup.value = k === "setup"; } }, lbl))),
          h("div", { class: "g-switch" }, [["good", "link good"], ["poor", "link poor"], ["lost", "link lost"]].map(([k, lbl]) =>
            h("button", { class: { on: link.value === k }, onClick: () => { link.value = k; } }, lbl))),
          h("div", { class: "g-switch" }, [h("button", {
            class: { on: unproven.value }, onClick: () => { unproven.value = !unproven.value },
          }, "mark unproven")]),
        ]),
      ]),
      h(Shell, {
        page: page.value, title: title(), cameras: CAMS,
        onGo: (p) => { page.value = p; },
      }, () => page.value === "cameras"
        ? [
            h(Index, { cameras: CAMERAS, rejected: REJECTED, onOpen: (id) => { page.value = "camera:" + (id === "cam0" ? "elp" : "pocket2"); } }),
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
        : page.value.startsWith("camera:") ? [h(DraftDeck, {
            key: camera.value + (setup.value ? "setup" : "live"),
            theme: theme.value, camera: camera.value,
            mode: setup.value ? "setup" : "live",
            showUnproven: unproven.value, link: link.value,
            cameras: CAMS, onGo: (p) => { page.value = p; },
          })] : [h("div", { class: "g-blank" }, TITLES[page.value] + " — not part of this mockup")]),
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
    if (msg?.payload === "live" || msg?.payload === "setup")
      window.dispatchEvent(new CustomEvent("yonder-mode", { detail: msg.payload }));
    // Apply and Discard are the deck's own rail keys (id "deck-keys"), not
    // the harness's — dispatched the same way as the mode switch above so
    // DraftDeck can hear a press without the harness knowing what a "draft"
    // is. Every other rail action (Detect again, Add by address, the
    // Cameras page's own Apply) has nothing listening and stays inert.
    else window.dispatchEvent(new CustomEvent("yonder-action", { detail: msg.payload }));
  } });
app
  .mixin({ computed: { $store: () => store } })
  .mount("#app");
