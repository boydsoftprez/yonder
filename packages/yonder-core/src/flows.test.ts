// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { CONSOLE_HOME, EXCLUDED_NODES, THEME_HREF } from "./console/settings.js";
import { DRAWN_CAPABILITIES } from "./video/present.js";
import { JOIN_TOPIC } from "./net/join.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { MIN_POLL_MS } from "./console/node.js";

/**
 * The shipped flows, asserted against the artefact.
 *
 * `settings.ts` already excludes the `function` node from the runtime, and
 * `settings.test.ts` asserts that. This file asserts the other half: that the
 * flows this project actually ships do not contain one. The two are different
 * claims — a runtime exclusion means a `function` node would not *work*, and
 * this means nobody has added one — and CLAUDE.md rule 2 is the reason both
 * are worth having. A rule enforced only against the runtime fails silently in
 * review, which is where it needs to fail loudly.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FLOWS = join(ROOT, "flows", "flows.json");

interface FlowNode {
  id: string;
  type: string;
  z?: string;
  wires?: string[][];
  group?: string;
  page?: string;
  ui?: string;
  theme?: string;
  interval?: number;
  [key: string]: unknown;
}

const flows = JSON.parse(readFileSync(FLOWS, "utf8")) as FlowNode[];
const text = readFileSync(FLOWS, "utf8");
const ids = new Set(flows.map((n) => n.id));

/** The node types each Yonder contrib package registers, from its manifest. */
function contribTypes(): Set<string> {
  const types = new Set<string>();
  for (const pkg of [
    "node-red-contrib-yonder-system",
    "node-red-contrib-yonder-network",
    "node-red-contrib-yonder-remote",
    "node-red-contrib-yonder-video",
    "node-red-dashboard-2-yonder",
  ]) {
    const manifest = JSON.parse(
      readFileSync(join(ROOT, "packages", pkg, "package.json"), "utf8"),
    ) as { "node-red": { nodes: Record<string, string> } };
    for (const type of Object.keys(manifest["node-red"].nodes)) types.add(type);
  }
  return types;
}

describe("flows/flows.json", () => {
  it("is a list of nodes, each with an id and a type", () => {
    expect(Array.isArray(flows)).toBe(true);
    expect(flows.length).toBeGreaterThan(0);
    for (const node of flows) {
      expect(typeof node.id, JSON.stringify(node).slice(0, 80)).toBe("string");
      expect(typeof node.type, node.id).toBe("string");
    }
    expect(ids.size, "two nodes share an id").toBe(flows.length);
  });

  /**
   * **CLAUDE.md rule 2, against the artefact.**
   *
   * A `function` node is JavaScript serialised into this file beside wire
   * coordinates. A pull request against it is unreadable, so it cannot be
   * reviewed, so it cannot be merged — and that single rule is what makes this
   * project contributable. If this test fails, the fix is not to change the
   * test: it is to move whatever was written into a package under
   * `packages/`, where it has a source file and tests of its own.
   */
  it("contains no function node", () => {
    const offenders = flows.filter((n) => n.type === "function").map((n) => n.id);
    expect(
      offenders,
      "the shipped flows contain a function node. Logic lives in packages/, never in "
      + "flows.json (CLAUDE.md rule 2): a diff against serialised JavaScript cannot be "
      + "reviewed. Move it into node-red-contrib-yonder-* or yonder-core.",
    ).toEqual([]);
  });

  /**
   * The other type `settings.ts` excludes. `exec` runs arbitrary commands as
   * the console's user, and nothing Yonder ships needs it (R-SEC-05).
   */
  it("contains no node the shipped profile refuses to load", () => {
    const excluded = new Set(EXCLUDED_NODES.map((f) => f.replace(/^\d+-|\.js$/g, "")));
    for (const node of flows) {
      expect(excluded.has(node.type), `${node.id} is a ${node.type}`).toBe(false);
    }
  });

  /**
   * **R-UI-01, asserted rather than reviewed.** A Dashboard theme or template
   * that pulls a webfont from a CDN works in a lab with internet and fails in
   * a field without one — silently in the first case, at the worst possible
   * moment in the second.
   *
   * The one stylesheet the flows link is the palette the ConsoleRenderer
   * generates on the device, at a root-relative path.
   */
  it("fetches no asset from anywhere", () => {
    expect(text).not.toMatch(/(?:src|href)\s*=\s*["']https?:/i);
    expect(text).not.toMatch(/url\s*\(\s*["']?https?:/i);
    expect(text).not.toMatch(/fonts\.googleapis|fonts\.gstatic|cdnjs|unpkg|jsdelivr|cdn\./i);
    // The rule is the host, not the mechanism. This used to ban `@import`
    // outright, which read as caution and was the opposite: the flows had to
    // import the generated stylesheet somehow, and the `<link>` they carried
    // instead sat in a `ui-template` with a scope Dashboard does not accept,
    // so it was never injected and the whole palette was inert. A blanket ban
    // on the working mechanism kept the broken one passing.
    expect(text).not.toMatch(/@import\s+url\(\s*["']?(?:https?:)?\/\//i);
  });

  it("imports exactly one stylesheet, and it is the one generated on the device", () => {
    const imports = [...text.matchAll(/@import\s+url\(([^)]*)\)/g)].map((m) => m[1]);
    expect(imports).toHaveLength(1);
    expect(imports[0]).toContain(THEME_HREF);
    expect(THEME_HREF.startsWith("/")).toBe(true);
    // Root-relative, so it is same-origin whatever address the operator
    // reached the console on - the access point, the LAN, or a mesh address.
    expect(imports[0]).not.toMatch(/https?:|\/\//);
  });

  /**
   * The absolute URLs that *are* in here are operator instructions — where to
   * find the device after it has joined a network — not assets. They must
   * name this device and nothing else: an instruction pointing anywhere off
   * the board is a page telling somebody to go and look on the internet.
   */
  it("names no host but this device in the words an operator reads", () => {
    for (const [, host] of text.matchAll(/https?:\/\/([A-Za-z0-9.:-]+)/g)) {
      expect(host, "an absolute URL in the flows points somewhere off this device")
        .toMatch(/^(yonder\.local|localhost|127\.0\.0\.1|192\.168\.77\.1)(:\d+)?$/);
    }
  });

  /**
   * R-UI-06. The console has to work on a link with hundreds of milliseconds
   * of latency. `pollIntervalMs` floors this in yonder-core whatever the flows
   * say, so this is the second lock: the shipped flows should not be asking
   * for something the code has to correct.
   */
  it("asks for no poll faster than the floor", () => {
    const pollers = flows.filter((n) => typeof n.interval === "number");
    expect(pollers.length).toBeGreaterThan(0);
    for (const node of pollers) {
      expect((node.interval ?? 0) * 1000, `${node.id} polls every ${String(node.interval)} s`)
        .toBeGreaterThanOrEqual(MIN_POLL_MS);
    }
  });

  /**
   * A type nobody registers is a node that loads as "unknown" and does
   * nothing, which on a console is a page that is silently missing a control.
   * Checked against the packages' own manifests, so renaming a node in a
   * package and forgetting the flows fails here.
   */
  it("uses only Yonder node types that a package actually registers", () => {
    const registered = contribTypes();
    // `ui-yonder-` as well as `yonder-`: the instrument widgets are Dashboard
    // widget types, and leaving them out of this check was how a renamed one
    // would have reached a board as a page with a hole in it.
    const used = new Set(
      flows.map((n) => n.type).filter((t) => t.startsWith("yonder-") || t.startsWith("ui-yonder-")),
    );
    expect(used.size).toBeGreaterThan(0);
    for (const type of used) {
      expect(registered.has(type), `${type} is used in the flows but no package registers it`).toBe(true);
    }
  });

  /**
   * **Observed, not reasoned about.** Node-RED's config-node dependency scan
   * compares every string property of a config node against the ids of the
   * others, and a node's own `type` is one of those properties. So a config
   * node whose *id* is a *type* name depends on itself: Node-RED refuses to
   * start the flows with "Circular config node dependency detected", and every
   * widget then logs "No group configured" and never appears.
   *
   * The shipped flows carried exactly that — an `ui-base` with the id
   * `ui-base` — and no unit test could see it. `scripts/verify-pages.sh`
   * found it by starting a real Node-RED; this keeps it found.
   */
  it("gives no node an id that is also a node type", () => {
    const types = new Set(flows.map((n) => n.type));
    const collisions = flows.map((n) => n.id).filter((id) => types.has(id));
    expect(
      collisions,
      "a node's id is also a node type. Node-RED reads that as a config node "
      + "depending on itself and refuses to start the flows.",
    ).toEqual([]);
  });

  /**
   * A node with no `z` belongs to no tab, and Node-RED simply never
   * instantiates it. There is no error, no warning and no "unknown type" —
   * the node registers, the flow starts, and a widget that should be on a
   * page is silently absent.
   *
   * This is not hypothetical. `ui-page` is a *config* node and carries no
   * `z`, so reading one to find the tab id yields `undefined`, and every node
   * added that way was dropped on the floor. Every check in the suite passed
   * and the page rendered an empty box.
   */
  it("puts every runtime node on the tab", () => {
    const configTypes = new Set(["tab", "ui-base", "ui-page", "ui-group", "ui-theme"]);
    const tab = flows.find((n) => n.type === "tab");
    expect(tab, "there is no tab for the runtime nodes to be on").toBeDefined();

    const orphans = flows
      .filter((n) => !configTypes.has(n.type) && !n.z)
      .map((n) => `${n.type}(${n.id})`);
    expect(
      orphans,
      "a node with no z is on no tab, so Node-RED never instantiates it and "
      + "nothing says so",
    ).toEqual([]);

    for (const node of flows.filter((n) => !configTypes.has(n.type))) {
      expect(node.z, `${node.id} is on a tab that does not exist`).toBe(tab?.id);
    }
  });

  it("wires nothing to a node that is not here", () => {
    for (const node of flows) {
      for (const output of node.wires ?? []) {
        for (const target of output) {
          expect(ids.has(target), `${node.id} wires to ${target}, which does not exist`).toBe(true);
        }
      }
    }
  });

  /**
   * A widget whose group, page or dashboard does not exist never appears. The
   * page renders, the control is simply absent, and nothing says why.
   */
  it("puts every widget in a group, page and dashboard that exist", () => {
    for (const node of flows) {
      for (const key of ["group", "page", "ui", "theme"] as const) {
        const reference = node[key];
        if (typeof reference !== "string" || reference === "") continue;
        expect(ids.has(reference), `${node.id}.${key} points at ${reference}, which does not exist`)
          .toBe(true);
      }
    }
  });

  /** All four pages M1b-2 owes, each with something on it. */
  /**
   * The navigation pane is visible, not hidden behind a hamburger.
   *
   * Dashboard's `default` is "Collapsing": the pane is a drawer at every
   * width, so a console on a laptop hides its own four pages behind a button
   * for no reason. `fixed` shows the pane, and the client still falls back to
   * a drawer when it is actually narrow — `navigationStyle === "fixed" &&
   * isMobile ? "temporary" : navigationStyle` — which is what R-UI-04 wants
   * on a tablet without giving up the pane on everything else.
   */
  it("shows the navigation pane rather than collapsing it at every width", () => {
    const base = flows.find((n) => n.type === "ui-base");
    expect(base?.navigationStyle, "default collapses the pane at every width").toBe("fixed");
  });

  it("serves the pages these milestones are for", () => {
    const pages = flows.filter((n) => n.type === "ui-page");
    // Cameras and the camera page came with M4. They sit above Log and
    // Diagnostics because the payload is what an operator came to the console
    // for, and the log is what they reach for when it is not working.
    expect(pages.map((p) => p.name).sort())
      .toEqual(["Camera", "Cameras", "Diagnostics", "Log", "Network", "Status"]);

    const groups = flows.filter((n) => n.type === "ui-group");
    for (const page of pages) {
      const onIt = groups.filter((g) => g.page === page.id);
      expect(onIt.length, `${String(page.name)} has no groups on it`).toBeGreaterThan(0);
      for (const group of onIt) {
        expect(
          flows.some((n) => n.group === group.id),
          `the group "${String(group.name)}" has no widgets in it`,
        ).toBe(true);
      }
    }
  });

  /**
   * **The single most important piece of copy in the product.**
   *
   * It is the moment an operator most easily concludes the device is broken:
   * they press a button and the thing they are reading disappears. The plan
   * lists four things the form has to say before they press it, and this is
   * the test that they are all still there.
   */
  /**
   * Four facts, before the operator presses a button that takes the page away
   * from them. Asserted as facts and not as phrasing: these used to be pinned
   * to particular words — `/disappear|goes away/` — so trimming 239 words of
   * explanation down to something readable broke the tests without changing
   * anything they were actually there to protect.
   */
  /**
   * The page carries no prose at all now, so the four facts an operator needs
   * before the console disappears travel on the toast instead — delivered at
   * the moment they matter rather than sitting permanently above a form
   * nobody reads twice. `applyStatus` composes that message; `node.test.ts`
   * asserts its content.
   */
  it("carries no prose on the page that joins a network", () => {
    const page = flows.find((n) => n.type === "ui-page" && n.name === "Network");
    const groups = new Set(
      flows.filter((n) => n.type === "ui-group" && n.page === page?.id).map((n) => n.id),
    );
    const prose = flows.filter((n) => n.type === "ui-markdown" && groups.has(String(n.group)));
    expect(prose.map((n) => n.id)).toEqual([]);
  });

  /**
   * A console is read standing next to an aircraft, not at a desk. Every word
   * on it is a word between an operator and the thing they came to do, so the
   * budget is deliberately tight and deliberately enforced: this page carried
   * 448 words of explanation, 239 of them in front of one button.
   */
  it("keeps the whole console under a readable word budget", () => {
    const prose = flows
      .filter((n) => n.type === "ui-markdown")
      .map((n) => String(n.content ?? "").split(/\s+/).filter(Boolean).length);
    const total = prose.reduce((a, b) => a + b, 0);
    expect(total, `console prose is ${String(total)} words`).toBeLessThanOrEqual(200);
    expect(Math.max(...prose), "no single note may become an essay").toBeLessThanOrEqual(70);
  });

  /**
   * R-UI-07. Day and night, chosen by the operator and persisted in
   * `ui.theme`, never inferred from the browser or the host.
   *
   * This was a dropdown until the pages moved onto the soft-key rail
   * (ADR-0009). The requirement is about the *choice* and where it is kept,
   * not about the control, so the assertion is on what the operator can pick
   * and where it goes — which is what would still be true if the rail changed
   * shape again.
   */
  it("lets the operator choose day or night, and says what that costs", () => {
    const rail = flows.find((n) => n.id === "keys-status");
    expect(rail?.type).toBe("ui-yonder-softkeys");

    const actions = (JSON.parse(String(rail?.keys ?? "[]")) as { action: string }[])
      .map((k) => k.action)
      .sort();
    expect(actions).toEqual(["day", "night"]);

    // The choice goes to a node, which posts it to POST /ui/theme — which is
    // what makes it persist and what puts it behind the confirmation timer.
    expect(rail?.wires).toEqual([["theme-apply"]]);
    expect(flows.find((n) => n.id === "theme-apply")?.type).toBe("yonder-theme");
  });

  /**
   * R-UI-10, over the artefact rather than over a rendering.
   *
   * The capture gate checks this in a real browser, which is the check that
   * matters — but it needs a browser, a staged console tree and two minutes.
   * This one runs in milliseconds on every commit and catches the specific
   * mistake of reaching for a stock button again, which is how all four
   * spanning actions got there in the first place.
   */
  it("gives every soft-key rail keys that say what they do", () => {
    // Not "no stock button anywhere". The Network page deliberately keeps its
    // controls *inside* the task panel, in the order an operator does them —
    // scan, choose, passphrase, join — because there the behaviour and the
    // layout are one decision, and that decision came from a device. A rail
    // there would undo it. What R-UI-10 actually needs is that no action
    // *spans its surface*, and the capture gate checks exactly that in a real
    // browser rather than being approximated here.
    const rails = flows.filter((n) => n.type === "ui-yonder-softkeys");
    expect(rails.length).toBeGreaterThan(0);

    for (const r of rails) {
      const list = JSON.parse(String(r.keys ?? "[]")) as { label: string; action: string; tone?: string }[];
      expect(list.length, `${r.id} is a rail with no keys on it`).toBeGreaterThan(0);
      for (const k of list) {
        expect(typeof k.label, `${r.id} has a key with no label`).toBe("string");
        expect(typeof k.action, `${r.id} key "${k.label}" sends nothing`).toBe("string");
      }
      // At most one control per page takes the page away from the operator.
      const warn = list.filter((k) => k.tone === "warn");
      expect(warn.length, `${r.id} has ${warn.length} keys marked warn`).toBeLessThanOrEqual(1);
    }
  });

  /**
   * The wiring this replaced cached the configuration in `flow.yonderConfig`
   * and assigned `payload.ui.theme` through a reference to it. Node-RED's
   * change node stores and reads flow context by reference, so all three
   * steps addressed one object: choosing a theme edited the cache in place
   * whether or not the apply was ever confirmed, and a revert left the cache
   * holding a theme the device did not have.
   *
   * Asserted against the shipped artefact, not against the runtime, because
   * the whole failure was invisible from the page.
   */
  it("caches no configuration in flow context for a form to edit", () => {
    const cached = flows.filter((n) => JSON.stringify(n).includes("yonderConfig"));
    expect(cached.map((n) => n.id)).toEqual([]);
  });
});

/**
 * Every `ui-text` widget must say where its value comes from.
 *
 * Dashboard 2.x's `ui-text` has two fields that look like they select content
 * — the mustache-ish `format`, and the typed-input pair `value`/`valueType`.
 * Only the second one does anything. `nodes/widgets/ui_text.js` reads
 * `config.value`/`config.valueType` and nothing else, and there is no
 * mustache renderer anywhere in the shipped UI bundle: `format` is vestigial.
 *
 * The shipped flows carried `format: "{{msg.payload.display.model}}"` and no
 * `value`, so the widget fell through to the raw message and every field on
 * the Status page rendered the string `[object Object]` — on a real board, in
 * a browser, after everything else in this milestone had passed. Nothing
 * caught it because no test had ever opened the page: `verify-pages.sh`
 * checks HTTP bodies for substrings, and the substring it looked for was in
 * the page shell rather than in a value.
 */
describe("flows/flows.json ui-text widgets", () => {
  const texts = flows.filter((n) => n.type === "ui-text");

  it("has some", () => {
    expect(texts.length).toBeGreaterThan(0);
  });

  it("gives every one a typed-input value, because format renders nothing", () => {
    for (const n of texts) {
      expect(n.valueType, `${String(n.id)} must set valueType`).toBe("msg");
      expect(typeof n.value, `${String(n.id)} must set value`).toBe("string");
      expect(String(n.value).length, `${String(n.id)} value must not be empty`).toBeGreaterThan(0);
    }
  });

  it("leaves no subpath in format, which would read as if it still worked", () => {
    for (const n of texts) {
      expect(n.format, `${String(n.id)} should carry the stock default`).toBe("{{msg.payload}}");
    }
  });
});

/**
 * The dashboard's path and the place a signed-in operator is sent must be the
 * same string.
 *
 * They were not. `POST /login` redirected to `/`, and in a provisioned
 * console nothing is mounted there — the dashboard is at the `ui-base` node's
 * path and the editor at its own root. So the final step of first-run setup
 * ended on Express's bare `Cannot GET /`: the password was right, the session
 * cookie was set, and the operator was looking at a white page with an error.
 *
 * Two files have to agree and neither could see the other, which is what this
 * test is for.
 */
describe("flows/flows.json dashboard path", () => {
  it("mounts the dashboard where the login redirect sends people", () => {
    const base = flows.find((n) => n.type === "ui-base");
    expect(base, "the flows must contain a ui-base node").toBeDefined();
    expect(base?.path).toBe(CONSOLE_HOME);
  });
});

/**
 * The generated stylesheet has to actually reach the page.
 *
 * It did not. A `ui-template` node carried
 * `<link rel="stylesheet" href="/yonder/theme.css">` with
 * `templateScope: "site"` — and `"site"` is not one of the scopes Dashboard
 * 2.x accepts (`site:style`, `site:script`, `page:style`, `page:script`), so
 * the template was never injected at all. Every `--yonder-*` variable was
 * undefined in the document, the app bar stayed Vuetify white in both
 * palettes, and the `.yonder-tone-*` classes that ADR-0005 calls the shared
 * command-state language matched nothing.
 *
 * It was invisible because the file *was* served, correctly, at its URL: a
 * check that fetched it got 200 and the right bytes. Only the page knew it
 * was never linked.
 *
 * `site:style` sets the `<style>` element's innerHTML, so the content has to
 * be CSS. A `<link>` tag inside a stylesheet is nothing.
 */
describe("flows/flows.json stylesheet injection", () => {
  const link = flows.find((n) => n.id === "style-link");

  it("exists", () => {
    expect(link, "the flows must carry the generated stylesheet").toBeDefined();
    expect(link?.type).toBe("ui-template");
  });

  it("uses a scope Dashboard actually honours", () => {
    expect(["site:style", "page:style"]).toContain(link?.templateScope);
  });

  it("imports the path the console serves it from", () => {
    // THEME_HREF is what settings.js mounts. Two files that have to agree.
    expect(String(link?.format)).toContain(`@import url("${THEME_HREF}")`);
  });

  it("carries CSS, not markup, because site:style is a style element", () => {
    expect(String(link?.format)).not.toMatch(/<link|<style|rel=/i);
  });
});

/**
 * You pick a network. You do not transcribe one.
 *
 * The scan table and a free-text SSID box meant the console told you the name
 * and then asked you to type it back — on a phone, where the cost of a typo is
 * the access point going away for five minutes while a doomed apply rolls
 * back. `ui-form` cannot be pre-filled from a message, so a tappable table
 * could not have filled the box; what it can take is `ui_update.dropdownOptions`.
 * So the field is a dropdown and the scan feeds it.
 */
describe("flows/flows.json join controls", () => {
  const ssid = flows.find((n) => n.id === "join-ssid");
  const psk = flows.find((n) => n.id === "join-psk");
  const go = flows.find((n) => n.id === "join-go");
  const scan = flows.find((n) => n.type === "yonder-scan");

  it("asks for the network as a choice, not as typing", () => {
    expect(ssid?.type).toBe("ui-dropdown");
  });

  /**
   * The reason this is three widgets and not one form: `ui-form` renders
   * text, email, number, multiline, checkbox, switch, date, time and
   * dropdown — and nothing masked. A passphrase in a `ui-form` would be on
   * screen in clear. `ui-text-input` masks, and is its own widget.
   */
  it("masks the passphrase", () => {
    expect(psk?.type).toBe("ui-text-input");
    expect(psk?.mode).toBe("password");
  });

  it("labels each message so the node can tell them apart", () => {
    expect([ssid?.topic, psk?.topic, go?.topic]).toEqual([
      JOIN_TOPIC.ssid, JOIN_TOPIC.psk, JOIN_TOPIC.join,
    ]);
    for (const n of [ssid, psk, go]) expect(n?.topicType).toBe("str");
  });

  it("sends all three to the one node that holds them", () => {
    for (const n of [ssid, psk, go]) expect((n?.wires as string[][])[0]).toContain("join");
  });

  it("never lets a widget echo what was typed back out", () => {
    // passthru would put the passphrase on an outgoing message.
    for (const n of [ssid, psk, go]) expect(n?.passthru ?? false).toBe(false);
  });

  it("feeds the dropdown from the scan's second output", () => {
    const wires = scan?.wires as string[][];
    expect(wires?.length, "yonder-scan must have two outputs wired").toBeGreaterThanOrEqual(2);
    expect(wires[1]).toContain("join-ssid");
  });

  /**
   * There is no table any more. It listed name, signal and security beside a
   * dropdown that already carries name and signal, so it was a second copy of
   * the thing you choose from — and it existed only because the scan needed
   * somewhere to put its results before the dropdown did.
   *
   * The first output stays, unwired. It is the scan itself, which is the
   * useful thing to hang anything else off later.
   */
  it("keeps the scan's own output available, wired to nothing", () => {
    const wires = scan?.wires as string[][];
    expect(wires[0]).toEqual([]);
  });

  /**
   * One panel, in the order the operator does it: read what is about to
   * happen, scan, choose, type the passphrase, join. It used to be three
   * panels — widgets grouped by kind rather than by the task — for a single
   * thing you are trying to do.
   */
  it("puts the whole task in one group, in the order it is done", () => {
    const inGroup = flows
      .filter((n) => n.group === "group-net-join")
      .sort((a, b) => Number(a.order) - Number(b.order))
      .map((n) => n.id);
    // Access point or Wi-Fi, then choose, then the passphrase, then go.
    expect(inGroup).toEqual(["button-leave", "button-scan", "join-ssid", "join-psk", "join-go"]);
  });

  it("has no leftover panel that held only the table", () => {
    expect(flows.find((n) => n.id === "group-net-scan")).toBeUndefined();
    expect(flows.find((n) => n.type === "ui-table" && n.group === "group-net-join")).toBeUndefined();
  });

  /**
   * There is no confirmation step any more (R-CFG-11).
   *
   * There used to be a whole panel for it: join, lose the page, find the
   * device on another network, sign in, navigate back, and press "Yes, I can
   * still reach it" — inside five minutes, or a **working** configuration was
   * thrown away because somebody was slow. The device establishes for itself
   * whether the join took, so nothing is asked of the operator at all.
   */
  it("asks the operator to confirm nothing", () => {
    expect(flows.find((n) => n.id === "group-net-confirm")).toBeUndefined();
    // On *this* page. R-CFG-11 removed the confirmation for joining a network,
    // because that change takes the console away from the operator and the
    // device can establish for itself whether the join took. It did not remove
    // R-CFG-03: a camera's bitrate is spend on the path the console is
    // standing on, nobody has measured what a saturated uplink does to a
    // console session, and that apply arms a window somebody has to confirm.
    // So `yonder-confirm` is used again — on the camera page, and nowhere near
    // this one.
    const networkPage = flows.find((n) => n.type === "ui-page" && n.name === "Network");
    const network = new Set(
      flows.filter((n) => n.type === "ui-group" && n.page === networkPage?.id).map((n) => n.id),
    );
    expect(flows.filter((n) => n.type === "yonder-confirm" && network.has(String(n.group))))
      .toEqual([]);
    const words = flows
      .filter((n) => n.type === "ui-markdown" || n.type === "ui-button")
      .map((n) => `${String(n.content ?? "")} ${String(n.label ?? "")}`.toLowerCase())
      .join(" ");
    expect(words).not.toMatch(/can still reach it|confirm within|press .?yes/);
  });
});

/**
 * The page has to say something at the moment it stops being able to.
 *
 * Pressing Join takes the access point down, so the console disappears
 * mid-action. Without a toast the last thing an operator sees is a form that
 * did nothing, and the natural read of that is "it's broken" — which is
 * exactly what happened when this was tried on a phone.
 */
describe("flows/flows.json join feedback", () => {
  const toast = flows.find((n) => n.type === "ui-notification");
  const join = flows.find((n) => n.type === "yonder-join");

  it("tells the operator what is happening when they press Join", () => {
    expect(toast, "there must be somewhere for the join's answer to appear").toBeDefined();
    expect((join?.wires as string[][])[0]).toContain(toast?.id);
  });

  it("shows a countdown, so a message that lingers does not look stuck", () => {
    expect(toast?.showCountdown).toBe(true);
    expect(Number(toast?.displayTime)).toBeGreaterThanOrEqual(10);
  });

  it("can be dismissed, and asks nothing of the operator", () => {
    expect(toast?.allowDismiss).toBe(true);
    // A confirm button here would be the confirmation R-CFG-11 removed,
    // reintroduced as a popup.
    expect(toast?.allowConfirm).toBe(false);
  });

  /**
   * It stored `flow.yonderApply` for a confirm button that no longer exists,
   * and nothing read it. It is also the same flow-context caching that made
   * the theme control edit a configuration in place.
   */
  it("keeps nothing in flow context for a step that was removed", () => {
    expect(flows.find((n) => n.id === "remember-apply")).toBeUndefined();
    expect(JSON.stringify(flows)).not.toContain("yonderApply");
  });
});

/**
 * A notification belongs to the dashboard, not to a page.
 *
 * `ui_notification.js` says so in as many words — *"In contradiction to other
 * ui nodes (which belong to a group), the notification node belongs to a ui
 * instead"* — and resolves `RED.nodes.getNode(config.ui)`. Pointed at a page
 * id it silently never registers, which is exactly what happened: an operator
 * pressed Join, no toast appeared, and the page sat there telling them
 * nothing about whether they were still connected.
 */
describe("flows/flows.json notification target", () => {
  it("attaches the toast to the dashboard, not to a page", () => {
    const base = flows.find((n) => n.type === "ui-base");
    const pages = new Set(flows.filter((n) => n.type === "ui-page").map((n) => n.id));
    for (const toast of flows.filter((n) => n.type === "ui-notification")) {
      expect(toast.ui, `${String(toast.id)} must name the ui-base`).toBe(base?.id);
      expect(pages.has(String(toast.ui)), `${String(toast.id)} names a page`).toBe(false);
    }
  });
});

/**
 * The page whose job is joining a network must show whether you are on one.
 *
 * This readout was moved to Status on the reasoning that it describes what
 * the device *is*. In use that was plainly wrong: an operator who has just
 * pressed Join is standing on the Network page, and it could tell them
 * nothing — not whether it worked, not what they were connected to, not
 * whether they were in limbo.
 */
describe("flows/flows.json network page", () => {
  it("shows where the device is, on the page where you change it", () => {
    const page = flows.find((n) => n.type === "ui-page" && n.name === "Network");
    const groups = flows.filter((n) => n.type === "ui-group" && n.page === page?.id);
    const ids = new Set(groups.map((g) => g.id));
    const readouts = flows.filter((n) => ids.has(String(n.group)) && n.type === "ui-text");
    // One line that says what the radio is doing, rather than two raw
    // configuration fields the operator has to reconcile themselves.
    const values = readouts.map((n) => String(n.value));
    expect(values).toContain("payload.summary");
    expect(values).toContain("payload.address");
  });

  it("puts what you are connected to above the controls that change it", () => {
    const page = flows.find((n) => n.type === "ui-page" && n.name === "Network");
    const groups = flows
      .filter((n) => n.type === "ui-group" && n.page === page?.id)
      .sort((a, b) => Number(a.order) - Number(b.order));
    expect(groups[0]?.id).toBe("group-net-now");
    expect(groups[1]?.id).toBe("group-net-join");
  });
});

/**
 * The activity pane must accumulate, not replace.
 *
 * `yonder-activity` emits only what is new since its own cursor, so a table
 * set to `replace` is wiped the moment a poll returns nothing — which is most
 * polls on an idle device. Reported from the board: "activity shows activity
 * then clears out before I can read it".
 */
describe("flows/flows.json activity panes", () => {
  const tables = flows.filter((n) => n.type === "ui-table" && String(n.id).includes("activity"));

  it("has at least one", () => {
    expect(tables.length).toBeGreaterThan(0);
  });

  it("appends, because the source only ever sends what is new", () => {
    for (const t of tables) {
      expect(t.action, `${String(t.id)} must append`).toBe("append");
      // And is bounded, or an append-only pane is a leak with a nice name.
      expect(Number(t.maxrows)).toBeGreaterThan(0);
    }
  });
});

/**
 * The ZeroTier tab, against the artefact rather than a rendering (R-VPN-06).
 */
describe("flows/flows.json ZeroTier tab", () => {
  it.each(["yonder-remote-state", "yonder-remote-join", "yonder-remote-leave"])(
    "the shipped flows use %s",
    (type) => {
      expect(JSON.stringify(flows)).toContain(`"${type}"`);
    },
  );

  // R-VPN-06: the identifier a person must approve is shown "with a means of
  // copying it". The means is an instrument in
  // node-red-dashboard-2-yonder, because Dashboard 1.31.0 has no clipboard
  // path and CLAUDE.md rule 2 forbids the `function` node and the
  // `ui-template` script that would otherwise have supplied one.
  //
  // R-VPN-10 gives the assigned address the same treatment - the mock hands
  // it its own [copy] control - so this is two of the instrument now, told
  // apart by which property of `msg.payload` each one reads.
  it("shows the device id and the address through the instrument that can copy them", () => {
    const shown = flows.filter(
      (n) => n.group === "group-net-zerotier" && n.type === "ui-yonder-identity",
    );
    expect(shown).toHaveLength(2);
    expect(shown.map((n) => n.key).sort()).toEqual(["address", "deviceId"]);
  });

  it("wires the mesh state to both, or one shows an em dash for ever", () => {
    const state = flows.find((n) => n.type === "yonder-remote-state");
    expect(state, "the tab has no state node").toBeDefined();
    const wired = (state!.wires as string[][]).flat();
    expect(wired).toContain("identity-zt-device");
    expect(wired).toContain("identity-zt-address");
  });

  /**
   * R-VPN-10: what backs "connected" is shown beside it - direct-or-relayed,
   * latency, last heard, and traffic - each already formatted by
   * `messageFor` so the tab needs no `function` node to read it.
   */
  it("shows what backs the connection state: path, latency, traffic and last heard", () => {
    const zerotier = flows.filter((n) => n.group === "group-net-zerotier" && n.type === "ui-text");
    const values = zerotier.map((n) => String(n.value));
    expect(values).toContain("payload.path");
    expect(values).toContain("payload.latency");
    expect(values).toContain("payload.traffic");
    expect(values).toContain("payload.lastHeard");
    expect(values).toContain("payload.networkName");
  });

  /**
   * R-NET-10: a rate, beside the running total the test above already checks
   * for. Totals answer "how much has crossed this link"; this answers "how
   * fast is it moving right now" - different questions, both on the tab.
   */
  it("shows the mesh throughput as a rate, not only as a total", () => {
    const zerotier = flows.filter((n) => n.group === "group-net-zerotier" && n.type === "ui-text");
    expect(zerotier.map((n) => String(n.value))).toContain("payload.throughput");
  });

  /**
   * R-UI-13: the graph itself, generated on the device from the same message
   * as every other reading on this tab - never a raster image, and never a
   * `function` node reshaping `payload.series` for it (CLAUDE.md rule 2).
   */
  it("draws the throughput sparkline, wired to the same mesh state", () => {
    const spark = flows.find((n) => n.group === "group-net-zerotier" && n.type === "ui-yonder-sparkline");
    expect(spark, "the tab has no sparkline").toBeDefined();

    const state = flows.find((n) => n.type === "yonder-remote-state");
    const wired = (state!.wires as string[][]).flat();
    expect(wired).toContain(spark!.id);
  });

  /**
   * A control that says it will act and does not.
   *
   * The `Copy` button shipped with `"wires": [[]]` and a tooltip telling the
   * operator to select the text above and copy it by hand — it cost them the
   * ten seconds of trying before they worked that out, at an aircraft, with a
   * laptop open. A dead control is worse than an absent one, and nothing but
   * an assertion here can see one: the pages capture correctly, the node
   * tests pass, and pressing it does nothing at all.
   */
  it("has no button on the tab that goes nowhere", () => {
    const dead = flows.filter(
      (n) =>
        n.group === "group-net-zerotier"
        && n.type === "ui-button"
        && (n.wires as string[][] | undefined)?.flat().length === 0,
    );
    expect(dead.map((n) => n.id)).toEqual([]);
  });

  // CLAUDE.md rule 2: a function node is JavaScript serialised next to wire
  // coordinates, so it cannot be reviewed, so it cannot be merged.
  it("ships no function node", () => {
    expect(flows.some((n) => n.type === "function")).toBe(false);
  });
});

/**
 * The Status page's own line for the mesh (R-VPN-10): everything that backs
 * "connected" reduced to the words `messageFor` already built into
 * `payload.summary`, so this page needs no arithmetic of its own to show
 * where the aircraft's link stands.
 */
describe("flows/flows.json status page remote line", () => {
  it("shows the mesh summary, labelled Remote", () => {
    const page = flows.find((n) => n.type === "ui-page" && n.name === "Status");
    const groups = new Set(
      flows.filter((n) => n.type === "ui-group" && n.page === page?.id).map((n) => n.id),
    );
    const line = flows.find(
      (n) => n.type === "ui-text" && groups.has(String(n.group)) && n.value === "payload.summary",
    );
    expect(line, "the Status page has no line bound to payload.summary").toBeDefined();
    expect(line?.label).toBe("Remote");
  });

  // The Status page reads independently of which Network tab is open, so it
  // carries its own state node and its own inject rather than depending on
  // the ZeroTier tab's.
  it("has its own state node, fed by its own poll no tighter than the floor (R-UI-06)", () => {
    expect(flows.filter((n) => n.type === "yonder-remote-state").length).toBeGreaterThanOrEqual(2);

    const periodic = flows.filter(
      (n) => n.type === "inject" && typeof n.repeat === "string" && n.repeat !== "",
    );
    expect(periodic.length).toBeGreaterThan(0);
    for (const inj of periodic) {
      expect(Number(inj.repeat) * 1000, `${String(inj.id)} repeats every ${String(inj.repeat)} s`)
        .toBeGreaterThanOrEqual(MIN_POLL_MS);
    }
  });
});

/**
 * The camera pages (M4).
 *
 * Asserted against the artefact rather than a rendering, for the reason every
 * other block here is: the capture gate checks how these look in a browser,
 * and this checks that they are wired to the things they claim to draw. A page
 * bound to a property nothing sends renders an em dash for ever and no
 * screenshot can tell you why.
 */
describe("flows/flows.json camera pages", () => {
  const cameras = flows.find((n) => n.type === "ui-page" && n.name === "Cameras");
  const camera = flows.find((n) => n.type === "ui-page" && n.name === "Camera");
  const groupsOn = (page: FlowNode | undefined): FlowNode[] =>
    flows.filter((n) => n.type === "ui-group" && n.page === page?.id);
  const on = (page: FlowNode | undefined): FlowNode[] => {
    const ids = new Set(groupsOn(page).map((g) => g.id));
    return flows.filter((n) => ids.has(String(n.group)));
  };

  it("has both", () => {
    expect(cameras, "there is no Cameras index").toBeDefined();
    expect(camera, "there is no camera page").toBeDefined();
  });

  /**
   * R-CAM-05 in words, and the thing nothing in this repository rendered.
   *
   * `byPathStable` was resolved, typed and tested from Task 4 onwards and no
   * surface showed it — so an operator never learned whether the camera they
   * configured would still be the one that name means after a reboot. It is a
   * column here and a line on the camera page, both fed from
   * `identityWords()`, which is where the sentence lives.
   */
  it("shows each camera's identity, not only its /dev node", () => {
    const table = flows.find((n) => n.id === "table-cameras");
    const columns = (table?.columns as { key: string }[] | undefined) ?? [];
    expect(columns.map((c) => c.key)).toContain("identity");
    expect(columns.map((c) => c.key)).toContain("summary");

    const line = on(camera).find((n) => n.value === "payload.display.identity");
    expect(line, "the camera page never shows its identity").toBeDefined();
  });

  /** R-CAM-12: a rejection is a value with a reason, and the page shows both. */
  it("shows what was rejected, and why", () => {
    const table = flows.find((n) => n.id === "table-cameras-rejected");
    expect((table?.columns as { key: string }[]).map((c) => c.key)).toContain("reason");
  });

  /**
   * R-VID-11. Both totals are on the index and not on any one camera's page,
   * because both are shared: *starting the second camera would need 2.1 Mb/s
   * more* is a sentence no single camera's page can say.
   */
  it("puts the uplink budget on the index, where the total means something", () => {
    const budget = flows.find((n) => n.type === "ui-yonder-budget");
    expect(budget, "there is no uplink track").toBeDefined();
    expect(groupsOn(cameras).map((g) => g.id)).toContain(String(budget?.group));
    // Fed by the sweep, or it draws the fallback for ever.
    const sweep = flows.find((n) => n.type === "yonder-cameras");
    expect((sweep?.wires as string[][])[0]).toContain(budget?.id);
  });

  /**
   * R-UI-03: navigation from detected hardware, so a camera that is not
   * present has no section. The flows cannot create a page, so the page is
   * hidden — and the decision is a switch on what the sweep found, never a
   * guess made once when the file was written.
   */
  it("hides the camera page when there is no camera to show", () => {
    // **On a *configured* camera, not on attached hardware.** `found` is the
    // hardware sweep, so a freshly flashed device — which now ships
    // `cameras: []` — put CAMERA in the nav the moment anything was plugged
    // in, and every node on the page then asked for a camera that is not in
    // the configuration: 404, "not answering" on every badge, and a page of
    // empty widgets. `found[].id` is the configured id for the socket a
    // camera was detected on, or null, which is exactly the question.
    const decide = flows.find((n) => n.id === "cameras-present");
    expect(decide?.type).toBe("switch");
    expect(decide?.property).toBe("payload.found[id != null]");
    expect(decide?.propertyType).toBe("jsonata");
    const [present, absent] = decide?.wires as string[][];
    expect(present).toEqual(["cameras-show-page"]);
    expect(absent).toEqual(["cameras-hide-page"]);
    for (const id of ["cameras-show-page", "cameras-hide-page"]) {
      expect((flows.find((n) => n.id === id)?.wires as string[][])[0]).toEqual(["console-control"]);
    }
  });

  /**
   * **Picture, strip, deck, rail — and the deck is the only part that moves.**
   *
   * Not a panel over the frame: on a camera you are aiming, a panel over the
   * frame hides the part of the shot you are aiming at. Asserted by order: the
   * picture and the strip come first, the decks are in the middle, and both
   * rails sit at the foot.
   */
  it("puts the picture on top, the strip under it and the rail at the foot", () => {
    const ordered = groupsOn(camera).sort((a, b) => Number(a.order) - Number(b.order));
    expect(ordered[0]?.id).toBe("group-cam-picture");
    expect(ordered[1]?.id).toBe("group-cam-readout");
    expect(ordered.at(-2)?.id).toBe("group-cam-rail-live");
    expect(ordered.at(-1)?.id).toBe("group-cam-rail-setup");
  });

  /**
   * The deck is what Live and Setup exchange, and the page starts on Live.
   *
   * A page that came up with both decks drawn would be twice the height it
   * should be, and one that came up on Setup would show an operator the
   * settings when they asked for the picture.
   */
  it("starts on the Live deck, with Setup drawn nowhere", () => {
    const live = groupsOn(camera).filter((g) => String(g.className).includes("yonder-deck-live"));
    const setup = groupsOn(camera).filter((g) => String(g.className).includes("yonder-deck-setup"));
    expect(live.length).toBeGreaterThan(0);
    expect(setup.length).toBeGreaterThan(0);
    for (const g of live) expect(g.visible, `${String(g.id)} must start visible`).toBe(true);
    for (const g of setup) expect(g.visible, `${String(g.id)} must start hidden`).toBe(false);
  });

  it("exchanges exactly those two sets, and touches neither the picture nor the strip", () => {
    const swap = (id: string): { show: string[]; hide: string[] } =>
      (JSON.parse(String((flows.find((n) => n.id === id)?.rules as { to: string }[])[0].to)) as {
        groups: { show: string[]; hide: string[] };
      }).groups;
    const setup = swap("deck-setup");
    const live = swap("deck-live");
    expect(setup.show.sort()).toEqual(live.hide.sort());
    expect(setup.hide.sort()).toEqual(live.show.sort());
    for (const named of [...setup.show, ...setup.hide]) {
      expect(ids.has(named), `${named} is swapped but does not exist`).toBe(true);
      expect(named).not.toBe("group-cam-picture");
      expect(named).not.toBe("group-cam-readout");
    }
  });

  /**
   * **The three legends.** An operator has to know which kind of control they
   * are touching: one that reaches the sensor now, one that respawns the
   * pipeline, and one that edits the document the device boots from.
   */
  it("gives every deck group a header that says which kind of control it holds", () => {
    const named = (id: string): string => String(flows.find((n) => n.id === id)?.name);
    expect(named("group-cam-live")).toBe("Applies live");
    expect(named("group-cam-restarts")).toBe("Restarts the picture");
    expect(named("group-cam-stored")).toContain("config.yaml");
  });

  /**
   * **A countdown only where one will actually arm.**
   *
   * The page does not decide that and must not: `apply/reachability.ts` does,
   * from `CAMERA_EXEMPT_LEAVES`, and `applyStatus` turns the daemon's answer
   * into `pending` exactly when a deadline came back. So the toast carrying a
   * countdown and a confirm control is reached by routing on that state — a
   * page promising a confirm control that never comes, or omitting one that
   * does, is K-32 on the camera page.
   */
  it("routes the countdown on the engine's answer, never on which field was touched", () => {
    const route = flows.find((n) => n.id === "cam-apply-route");
    expect(route?.type).toBe("switch");
    expect(route?.property).toBe("yonder.state");
    expect((route?.rules as { v?: string }[])[0]?.v).toBe("pending");

    const [armed, kept] = route?.wires as string[][];
    const toastFor = (chain: string[]): FlowNode | undefined => {
      const step = flows.find((n) => n.id === chain[0]);
      return flows.find((n) => n.id === (step?.wires as string[][])[0][0]);
    };
    const pending = toastFor(armed);
    const settled = toastFor(kept);
    expect(pending?.allowConfirm, "an armed window needs a way to keep it").toBe(true);
    expect(pending?.showCountdown).toBe(true);
    expect(settled?.allowConfirm, "a kept apply must not offer a confirm that does nothing")
      .toBe(false);
  });

  /**
   * A dismiss and a timeout leave the same output as the confirm. Only one of
   * them is the operator saying they can still reach the device (R-CFG-03), so
   * only one of them may reach `yonder-confirm`.
   */
  it("confirms only on the confirm, never on a dismiss or a timeout", () => {
    const gate = flows.find((n) => n.id === "cam-confirm-gate");
    expect(gate?.type).toBe("switch");
    expect((gate?.rules as { v?: string }[])[0]?.v).toBe("confirm_clicked");
    expect((gate?.wires as string[][])[0]).toEqual(["cam-confirm"]);
    expect(flows.find((n) => n.id === "cam-confirm")?.type).toBe("yonder-confirm");
  });

  /**
   * R-VID-13. The full rate is *held*, never toggled: an operator who forgot
   * they had left it on would be spending most of a field uplink on a picture
   * nobody was looking at, and would have no reason to suspect it.
   */
  it("reaches the full rate by holding a key, and says what holding it costs", () => {
    const hold = flows.find((n) => n.type === "ui-yonder-holdkey");
    expect(hold, "there is no full-rate key").toBeDefined();
    // **The cost is read from the device, never typed in here.** It was
    // `2.07 Mb/s while held` — `cameraStrip()`'s own figure for one
    // configuration, frozen at deploy time and reachable by no message, so
    // raising the bitrate left the key saying a quarter of the truth beside a
    // readout strip that said all of it. R-VID-11 is about stating the cost
    // *before* it is asked for, so a number that cannot move is the
    // requirement failing.
    expect(hold?.cost).toBe("");
    const cost = flows.find((n) => n.id === "pick-cam-hold");
    expect((cost?.wires as string[][])[0]).toEqual(["hold-cam-fullrate"]);
    expect(JSON.stringify(cost?.rules)).toContain("payload.display.holdCost");
    // And whether there is anything to hold at all: the full-rate stream
    // exists only where an RTSP output does (R-UI-15).
    expect(JSON.stringify(cost?.rules)).toContain("payload.display.fullRate");
    expect((flows.find((n) => n.id === "camera-read")?.wires as string[][])[0])
      .toContain("pick-cam-hold");

    const edge = flows.find((n) => n.id === "cam-hold-edge");
    expect((hold?.wires as string[][])[0]).toEqual(["cam-hold-edge"]);
    const [down, up] = edge?.wires as string[][];
    expect(down).toEqual(["cam-rate-full"]);
    expect(up).toEqual(["cam-rate-preview"]);
    // And both reach the picture, or the key is a control that does nothing.
    for (const id of ["cam-rate-full", "cam-rate-preview"]) {
      expect((flows.find((n) => n.id === id)?.wires as string[][])[0]).toEqual(["pic-camera"]);
    }
  });

  /**
   * **The picture's own output must never come back to it.** `setMode` emits
   * `mode:<mode>` when the operator changes it, so a flow that looped that
   * back would be a picture commanding itself.
   */
  it("never wires the picture's output into the picture", () => {
    const picture = flows.find((n) => n.type === "ui-yonder-picture");
    expect((picture?.wires as string[][]).flat()).toEqual([]);
  });

  /**
   * R-UI-15: the facts row draws what the device answered, on `payload.facts`,
   * and the list in this file is only the fallback before the first read. A
   * capability list written into the flows would be a stored list, which is
   * the whole of what R-CAM-14 forbids.
   */
  it("feeds the facts row from the camera read rather than from a list in here", () => {
    const facts = flows.find((n) => n.type === "ui-yonder-facts");
    expect(JSON.parse(String(facts?.facts))).toEqual([]);
    const read = flows.find((n) => n.id === "camera-read");
    expect((read?.wires as string[][])[0]).toContain(facts?.id);
  });

  /**
   * R-CTL-10: the sliders take their range and their position from the device,
   * not from what this file guessed. A slider pinned to a range the camera
   * does not have is a control that reports a value it never sent.
   */
  it("takes each image control's range and current value from the device", () => {
    for (const key of ["brightness", "contrast"]) {
      const from = flows.find((n) => n.id === `cam-${key}-range`);
      const rules = from?.rules as { p: string; to: string }[];
      expect(rules[0]?.p).toBe("ui_update");
      expect(rules[0]?.to).toContain(`capabilities.${key}.value.min`);
      expect(rules[1]?.to).toBe(`payload.capabilities.${key}.value.current`);
      expect((from?.wires as string[][])[0]).toEqual([`slider-cam-${key}`]);
    }
  });

  /** A slider that echoed would post a control change on every read. */
  it("lets no input on either deck echo what arrived", () => {
    for (const n of on(camera).filter((w) => /ui-(slider|number-input|text-input)/.test(w.type))) {
      expect(n.passthru ?? false, `${String(n.id)} echoes`).toBe(false);
    }
  });

  /**
   * R-VID-15, and the reason the capture gate checks every committed page for
   * the device's real credential: this line carries a resolved one.
   */
  it("shows the receive line with a means of copying it", () => {
    const rtsp = flows.find((n) => n.id === "identity-cam-rtsp");
    expect(rtsp?.type).toBe("ui-yonder-identity");
    const line = flows.find((n) => n.type === "yonder-receive-line");
    expect((line?.wires as string[][])[0]).toEqual(["pick-cam-receive"]);
    expect((flows.find((n) => n.id === "pick-cam-receive")?.wires as string[][])[0])
      .toContain("identity-cam-rtsp");
  });

  /**
   * R-CAM-10: why Start would be refused, before it is pressed — and in words
   * that say so either way. A row labelled "cannot start" with nothing after
   * it reads as *this camera cannot start*, which is the opposite of what a
   * null refusal means.
   */
  it("says what would stop a start, and says it when nothing would", () => {
    const row = on(camera).find((n) => n.value === "payload.display.startCheck");
    expect(row, "the page never shows the start check").toBeDefined();
    expect(String(row?.label)).not.toMatch(/^cannot/i);
  });

  /** R-UI-10: every action on this page is on the rail, and only there. */
  it("puts no action anywhere but the rail", () => {
    const rails = new Set(
      groupsOn(camera).filter((g) => String(g.className).includes("yonder-rail")).map((g) => g.id),
    );
    const actions = on(camera).filter(
      (n) => n.type === "ui-button" || n.type === "ui-yonder-softkeys" || n.type === "ui-yonder-holdkey",
    );
    expect(actions.length).toBeGreaterThan(0);
    for (const a of actions) {
      expect(rails.has(String(a.group)), `${String(a.id)} is an action off the rail`).toBe(true);
    }
  });

  /** And each rail carries only what can be done from the deck it belongs to. */
  it("gives each deck the keys that deck can act on", () => {
    const keysOf = (id: string): string[] =>
      (JSON.parse(String(flows.find((n) => n.id === id)?.keys)) as { action: string }[])
        .map((k) => k.action);
    expect(keysOf("keys-cam-live")).toEqual(["start", "stop", "setup"]);
    expect(keysOf("keys-cam-setup")).toEqual(["live", "probe", "receive"]);
  });

  /**
   * A key that reached `yonder-stream` with anything but start or stop would
   * spend a round trip to be told so, and the operator would read the daemon's
   * refusal about the deck key they pressed.
   */
  it("sends only start and stop to the pipeline", () => {
    const route = flows.find((n) => n.id === "cam-live-keys");
    const [setup, rest] = route?.wires as string[][];
    // Setup also fetches the receive line: the deck an operator opens to find
    // it should already have it, and the committed capture of that deck is
    // what makes the gate's credential check bite (R-SEC-10).
    expect(setup).toEqual(["deck-setup", "cam-at-receive"]);
    expect(rest).toEqual(["cam-at-stream"]);
    expect(flows.find((n) => n.id === "stream-camera")?.type).toBe("yonder-stream");
  });

  /**
   * **No camera's id is written into this file.**
   *
   * Five nodes carried `"camera": "front"` — the capture fixture's name — so
   * the page was dead on every device whose camera is called anything else:
   * `404 no camera is configured with the id "front"`, badged "not answering",
   * every widget drawing nothing. The package was built to be dynamic —
   * `adapter.ts` prefers `msg.camera` over the node's own field — and the
   * wiring froze it.
   *
   * The id comes from `GET /cameras`, which already answers it, and reaches
   * each node through one addressing node in front of it.
   */
  it("names no camera in the wiring, and addresses every camera node by message", () => {
    const nodes = flows.filter(
      (n) => ["yonder-camera", "yonder-stream", "yonder-receive-line"].includes(n.type),
    );
    expect(nodes.length).toBeGreaterThan(0);
    for (const n of nodes) {
      expect(n.camera, `${String(n.id)} still names a camera`).toBe("");
      // Everything that feeds it sets `msg.camera` — either it is an
      // addressing node itself, or every one of its inputs is.
      const feeders = flows.filter((f) =>
        ((f.wires as string[][] | undefined) ?? []).some((out) => out.includes(String(n.id))));
      expect(feeders.length, `${String(n.id)} is fed by nothing`).toBeGreaterThan(0);
      for (const f of feeders) {
        expect(JSON.stringify(f.rules), `${String(f.id)} does not address a camera`)
          .toContain('"p":"camera"');
      }
    }
  });

  it("takes that id from the sweep, which is the only thing that knows it", () => {
    const identify = flows.find((n) => n.id === "cam-identify");
    expect((flows.find((n) => n.id === "cameras-read")?.wires as string[][])[0])
      .toContain("cam-identify");
    // The configured id for a socket something was detected on, or null.
    expect(JSON.stringify(identify?.rules)).toContain("payload.found[id != null]");
    expect(JSON.stringify(identify?.rules)).toContain('"pt":"flow"');
  });

  /**
   * R-VID-11 again, on the picture: both of its numbers were literals here.
   * The path was too, which is the same defect as the ids above — a picture
   * negotiating against `front-preview` on a device whose camera is `nose`
   * gets a 404 and reports it as a camera that is not streaming.
   */
  it("tells the picture which camera it is of, and what watching it costs", () => {
    const picture = flows.find((n) => n.type === "ui-yonder-picture");
    expect(picture?.cost).toBe("");
    expect(picture?.path).toBe("");
    const from = flows.find((n) => n.id === "pick-cam-picture");
    expect((from?.wires as string[][])[0]).toEqual(["pic-camera"]);
    expect(JSON.stringify(from?.rules)).toContain("payload.camera.id");
    expect(JSON.stringify(from?.rules)).toContain("payload.display.pictureCost");
    expect((flows.find((n) => n.id === "camera-read")?.wires as string[][])[0])
      .toContain("pick-cam-picture");
  });

  /**
   * R-UI-15, in the direction nothing was watching: a capability the camera
   * *has* and this page does not draw must be stated, or an operator reads the
   * page and concludes the camera cannot do it.
   *
   * `DRAWN_CAPABILITIES` is what `capabilityFacts()` stays silent about, so it
   * has to be the set this file actually draws a control for. This holds the
   * two together: nothing else does.
   */
  it("draws a control for exactly the capabilities the facts row stays silent about", () => {
    // Every reference in the file: the controls are fed by `change` nodes,
    // which belong to no group and so are not `on` the page in the sense the
    // helper above means.
    const drawn = new Set(
      flows
        .flatMap((n) => JSON.stringify(n.rules ?? "").match(/payload\.capabilities\.(\w+)/g) ?? [])
        .map((m) => m.replace("payload.capabilities.", "")),
    );
    // `formats` is drawn as the readout strip's size and rate rather than as a
    // control, so it is named there and not reachable by this scan.
    expect([...drawn].sort()).toEqual(
      DRAWN_CAPABILITIES.filter((k) => k !== "formats").slice().sort(),
    );
  });
});
