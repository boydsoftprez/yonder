// SPDX-License-Identifier: GPL-3.0-or-later
import { createApp, defineComponent, h, ref } from "vue";
import { SPECIMENS } from "./specimens.js";
import "./gallery.css";

/**
 * The gallery harness (R-UI-25, CLAUDE.md rule 2).
 *
 * Ported from the blueprint at
 * docs/console/design/instrument-library/gallery/main.js: the same
 * `$dataTracker`/`$socket` stand-ins for Dashboard, the same store shape,
 * and the same theme-link trick. What is different is what gets mounted —
 * the blueprint drives one simulated console flow built from draft
 * components; this drives a grid of specimens, one per shipped component
 * per state, built from the real `src/ui/*.vue` files `specimens.js`
 * imports directly.
 *
 * One store entry per specimen, keyed by a synthetic id assigned here —
 * which id a specimen's payload lands under is the harness's business, not
 * something `specimens.js` states about itself.
 */
const messages = {};
SPECIMENS.forEach((specimen, i) => {
  messages["specimen-" + i] = { payload: specimen.payload };
});
const store = { state: { data: { messages } } };

/**
 * The theme link, found if it survived the build and created if it did
 * not — and always moved to the very end of `<head>`, which is the part
 * that is not optional.
 *
 * The static `<link id="theme">` in `index.html` points at a file that
 * exists only in `public/`, written there by `build-themes.mjs`, nowhere
 * in the module graph Vite can see from `index.html` itself. Whether that
 * leaves the tag stripped from the built page or merely unresolved-but-
 * present is a Vite-version question this file cannot assume an answer
 * to — it has gone both ways during this port. So both are handled:
 * created if missing, found if not. What matters more, and is not
 * version-dependent, is the tag's *position*: this package's own
 * `tokens.css` — the fallback values every component's `var(--yonder-*,
 * <fallback>)` names — is bundled by Vite into a stylesheet injected near
 * the bottom of `<head>`, and a `<link id="theme">` left sitting earlier
 * than that (wherever it happened to start out) loses the cascade to
 * those fallbacks for every variable both define. `appendChild` on a node
 * already in the document moves it rather than erroring, so calling it
 * unconditionally — not only when the link was just created — is what
 * keeps the real theme last, and winning, regardless of where the tag
 * started or which Vite version put it there. (This is also the reason
 * `main.js` does not import `tokens.css` itself: it would only reintroduce
 * the same race against this link, for a fallback the loaded theme always
 * supersedes anyway.)
 */
function setTheme (theme) {
  let link = document.getElementById("theme");
  if (!link) {
    link = document.createElement("link");
    link.id = "theme";
    link.rel = "stylesheet";
  }
  link.href = "./theme." + theme + ".css";
  document.head.appendChild(link);
  document.documentElement.setAttribute("data-theme", theme);
}

/**
 * What a specimen sees in place of Dashboard's own socket.
 *
 * There is no Node-RED behind this gallery to relay a `widget-action` on to
 * a flow — but a mock that swallowed one silently would look exactly like
 * Dashboard dropping it for want of `emitsActions: true` on the node's own
 * registration (see `widget.ts`'s note on that), and this harness exists to
 * show what a component does, not to hide whether it did anything. So every
 * press is logged and reflected onto the strip in the header — the soft
 * keys, the hold key and the picture's own mode key all emit through this
 * one path, and this is where a press pressed in the built gallery becomes
 * visible.
 */
const lastAction = ref("none yet");
function describeAction (id, msg) {
  const payload = msg && typeof msg === "object" ? msg.payload : msg;
  const topic = msg && typeof msg === "object" && msg.topic ? msg.topic + " · " : "";
  return topic + String(payload) + " (" + id + ")";
}

const Gallery = defineComponent({
  name: "Gallery",
  setup () {
    const theme = ref("day");
    const choose = (t) => {
      theme.value = t;
      setTheme(t);
    };
    return () => h("div", { class: "g-root" }, [
      h("div", { class: "g-bar" }, [
        h("span", { class: "g-bar__t" }, "Yonder instrument library — every component, from source"),
        h("div", { class: "g-switch" }, ["day", "night"].map((t) => h("button", {
          type: "button",
          class: { on: theme.value === t },
          onClick: () => choose(t),
        }, t))),
        h("span", { class: "g-bar__action" }, "Last widget action: " + lastAction.value),
      ]),
      h("div", { class: "g-page" }, [
        h("div", { class: "g-grid" }, SPECIMENS.map((specimen, i) => h("div", { class: "g-cell" }, [
          h("div", { class: "g-cap" }, specimen.title),
          h("div", { class: "g-sub" }, specimen.note),
          h("div", { class: "g-stage" }, [
            h(specimen.component, { id: "specimen-" + i, props: specimen.props }),
          ]),
        ]))),
      ]),
    ]);
  },
});

const app = createApp(Gallery);
app.provide("$dataTracker", () => {});
app.provide("$socket", {
  on () {},
  off () {},
  emit (event, id, msg) {
    if (event !== "widget-action") return;
    lastAction.value = describeAction(id, msg);
    // A developer looking at a terminal beside the browser gets the same
    // fact the header strip shows, with the full message rather than its
    // truncated one-line form.
    console.log("[gallery] widget-action", id, msg);
  },
});
app.mixin({ computed: { $store: () => store } });
setTheme("day");
app.mount("#app");
