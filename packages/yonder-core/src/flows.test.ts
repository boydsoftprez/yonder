// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { JOIN_TOPIC } from "./net/join.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CONSOLE_HOME, EXCLUDED_NODES, THEME_HREF } from "./console/settings.js";
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
    "node-red-contrib-yonder-modem",
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

  it("serves the four pages this milestone is for", () => {
    const pages = flows.filter((n) => n.type === "ui-page");
    expect(pages.map((p) => p.name).sort())
      .toEqual(["Diagnostics", "Log", "Network", "Status"]);

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
  it("asks the operator to confirm nothing about the join", () => {
    expect(flows.find((n) => n.id === "group-net-confirm")).toBeUndefined();
    // Narrowed, not weakened. R-UI-15 put a `yonder-confirm` back on Status,
    // reached from a banner that any pending change raises — which closed
    // K-30. What R-CFG-11 removed was a confirmation *of the join*, asked for
    // from a page the join takes off the air. So the assertion is that the
    // only confirm control in the flows is that one, and that nothing in the
    // Wi-Fi panel reaches it.
    expect(flows.filter((n) => n.type === "yonder-confirm").map((n) => n.id))
      .toEqual(["confirm-pending"]);
    const fromJoin = flows
      .filter((n) => n.group === "group-net-join" || n.type === "yonder-join")
      .flatMap((n) => (n.wires ?? []).flat());
    expect(fromJoin).not.toContain("confirm-pending");
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
 * The Cellular tab, against the artefact rather than a rendering
 * (R-CEL-09, R-CEL-12, R-UI-09).
 */
describe("flows/flows.json Cellular tab", () => {
  const page = flows.find((n) => n.type === "ui-page" && n.name === "Network");
  const tabs = flows
    .filter((n) => n.type === "ui-group" && n.page === page?.id)
    .sort((a, b) => Number(a.order) - Number(b.order));
  const inTab = flows.filter((n) => n.group === "group-net-cellular");

  /**
   * A `ui-group` on a page whose layout is `tabs` **is** a tab — Dashboard's
   * `LayoutTabs` renders one `v-tab` per group — so this is also the check
   * that the tab exists at all, and where in the strip it is.
   */
  it("sits between ZeroTier and Activity in the strip", () => {
    expect(page?.layout).toBe("tabs");
    expect(tabs.map((g) => g.name))
      .toEqual(["Interfaces", "Wi-Fi", "ZeroTier", "Cellular", "Activity"]);
  });

  it.each(["yonder-modem-state", "yonder-modem-configure", "yonder-reach-test"])(
    "the shipped flows use %s",
    (type) => {
      expect(flows.some((n) => n.type === type)).toBe(true);
    },
  );

  /**
   * **The defect the gauge's second sense exists to prevent.**
   *
   * `ui-yonder-gauge` lays its bands good → caution → bad left to right and
   * fills as the value climbs, which is right for temperature and backwards
   * for signal. Without `sense`, a dying link draws as a full bar — the one
   * reading an operator glances at, saying the opposite of the truth. The
   * bounds are the standard cellular thresholds, so a number that looks
   * alarming here looks alarming to a carrier's support desk too.
   */
  it("draws both signal gauges against their bands, the right way round", () => {
    const gauges = inTab.filter((n) => n.type === "ui-yonder-gauge");
    expect(gauges.map((g) => g.label).sort()).toEqual(["QUALITY", "SIGNAL"]);
    for (const g of gauges) {
      expect(g.sense, `${String(g.label)} would draw a dying link as a full bar`)
        .toBe("higher-is-better");
    }
    const signal = gauges.find((g) => g.label === "SIGNAL");
    expect([signal?.min, signal?.max, signal?.caution, signal?.limit])
      .toEqual([-120, -70, -90, -105]);
    expect(signal?.unit).toBe("dBm");
    const quality = gauges.find((g) => g.label === "QUALITY");
    expect([quality?.min, quality?.max, quality?.caution, quality?.limit])
      .toEqual([-5, 25, 13, 0]);
    expect(quality?.unit).toBe("dB");
  });

  /**
   * A gauge places a pointer, so it needs a number. The state node computes
   * both the number and the string beside it, and these move one into the
   * message — a `function` node deriving one from the other is what
   * CLAUDE.md rule 2 forbids.
   */
  it("feeds each gauge a number, from the output that carries them", () => {
    const state = flows.find((n) => n.type === "yonder-modem-state");
    const signals = (state!.wires as string[][])[1];
    for (const id of ["pick-cell-strength", "pick-cell-quality", "bar-cell-signal"]) {
      expect(signals).toContain(id);
    }
    for (const id of ["pick-cell-strength", "pick-cell-quality"]) {
      const node = flows.find((n) => n.id === id);
      const rules = node?.rules as { p: string; to: string; tot: string }[];
      // Found by what it sets rather than by where it sits: this pick also
      // carries `msg.visible`, and which rule is written first is settled by
      // the test below for the reason it has to be.
      const onto = rules.find((r) => r.p === "payload");
      expect(onto?.tot).toBe("jsonata");
      expect(onto?.to).toMatch(/^payload\.gauges\./);
    }
  });

  /**
   * **The defect a capture found with the modem unplugged.** The tab showed a
   * `NO MODEM` lamp, "No modem found" and a dash in every fact — and then two
   * gauge tracks with their coloured bands and no needle. A gauge with no
   * needle reads as a fault, and *there is no modem* is not a fault, so the
   * gauges are **absent** rather than empty.
   *
   * The binding is `showsSignal` and never `reportsSignal`. That one is a
   * property of the *kind* of modem and is true whenever one is not an
   * appliance — including on a board with no modem in it at all, which has no
   * kind — so binding to it would have hidden nothing. The distinction is
   * settled in the modem package, where it is tested; the flow only carries
   * it onto `msg.visible`.
   *
   * `visible` is set **before** `payload` is replaced, because after that rule
   * the field is gone. This is the same wiring the `Reachable by` panel on
   * Status uses, deliberately: two surfaces drawing one modem's gauges must
   * disappear on the same board.
   */
  it.each(["strength", "quality"])("hides the %s gauge rather than emptying it", (which) => {
    const pick = flows.find((n) => n.id === `pick-cell-${which}`);
    const rules = pick?.rules as { t: string; p: string; to: string; tot: string }[];
    expect(rules.map((r) => r.p)).toEqual(["visible", "payload"]);
    expect(rules[0].to).toBe("payload.showsSignal");
    // JSONata, not a plain property read: a failed tick sends `payload: null`
    // and `null.showsSignal` throws in the latter.
    for (const r of rules) {
      expect(r.t).toBe("set");
      expect(r.tot).toBe("jsonata");
    }
    expect(rules[1].to).toBe(`payload.gauges.${which}`);
    expect((pick?.wires as string[][])[0]).toEqual([`gauge-cell-${which}`]);
  });

  /**
   * **The other defect the same capture found:** `COMPOSITION` ran off the
   * right of the viewport as
   * `cdc-wdm0 (mbim) · ttyUSB0 (ignored) · ttyUSB1 (gp…`.
   *
   * The cell was not too narrow. It was showing the wrong thing: R-CEL-03 asks
   * which mode a connected modem needs and which was chosen, and the answer is
   * one word — `MBIM` — taken from the kind of the control port. An
   * enumeration of every port including the ignored one and the GPS answers a
   * different question, and not on a page an operator glances at.
   *
   * The fix is the key, not the width. Widening the cell, wrapping it or
   * shrinking the type would each have kept the wrong answer and made it fit.
   */
  it("says which mode the modem came up in, not every port it exposes", () => {
    const bar = flows.find((n) => n.id === "bar-cell-link");
    const cells = JSON.parse(String(bar?.cells)) as { key: string; label: string }[];
    const cell = cells.find((c) => c.label === "COMPOSITION");
    expect(cell?.key).toBe("composition");
    expect(cells.some((c) => c.key === "portSummary"), "the port list is not a fact cell")
      .toBe(false);
  });

  /**
   * **R-CEL-12.** The surface that reports a broken link is the one that
   * repairs it. Four fields and a rail, on the same tab as the verdict — an
   * operator told the APN is wrong must not have to leave the console to
   * change it.
   *
   * **R-CEL-09:** no APN is suggested, completed or offered as a list. The
   * published carrier database's first answer for the SIM this was built
   * against was the value that failed.
   */
  it("carries the form that fixes what the verdict reports", () => {
    const inputs = inTab.filter((n) => n.type === "ui-text-input");
    expect(inputs.map((n) => n.topic).sort())
      .toEqual(["apn", "dial", "password", "username"]);
    const apn = inputs.find((n) => n.topic === "apn");
    expect(apn?.type, "an APN is typed, never chosen from a list").toBe("ui-text-input");
  });

  /**
   * **R-UI-17.** The defect an operator found on a board: the fact cell read
   * `APN ereseller` and the four boxes under it were empty on every load, so
   * one page gave two answers to the same question and the form implied a
   * modem nobody had configured while it was plainly connected.
   *
   * The boxes are seeded from the **configuration** — `network.modem`, through
   * the `/config` read that was already in the flows and whose output went
   * nowhere — and never from the modem's state. They are different questions:
   * while an apply is pending the configuration says one APN and the connected
   * bearer is still on the previous one, and the fact cell above keeps
   * reading the bearer.
   */
  it("seeds the form from the configuration, so it says what is set", () => {
    const read = flows.find((n) => n.id === "read-config");
    expect(read?.type).toBe("yonder-config");
    const seed = flows.find((n) => n.id === (read?.wires as string[][])[0][0]);
    expect(seed?.type, "the /config read still goes nowhere").toBe("yonder-modem-form");
    const outs = seed?.wires as string[][];
    // One output per box, in the order the node documents.
    expect(outs.length).toBe(4);
    for (const [i, box] of ["apn", "dial", "username", "password"].entries()) {
      expect(outs[i], `the ${box} box is not fed`).toContain(`input-cell-${box}`);
    }
  });

  /**
   * A seeded box that CONNECT cannot see is worse than an empty one: the
   * operator reads `ereseller`, presses CONNECT and is told the modem needs an
   * APN. `gather-cell-form` reads `flow.modemApn` and the widgets do not pass
   * their input through, so the same seed has to reach the `remember` nodes.
   */
  it("seeds what CONNECT reads, so an untouched form applies what is on screen", () => {
    const seed = flows.find((n) => n.type === "yonder-modem-form");
    const outs = seed?.wires as string[][];
    const gather = flows.find((n) => n.id === "gather-cell-form");
    const gathered = gather?.rules as { p: string; to: string; tot: string }[];
    for (const [i, box] of ["apn", "dial", "username"].entries()) {
      expect(outs[i], `CONNECT cannot see the seeded ${box}`).toContain(`remember-cell-${box}`);
      // The whole path, end to end, and not merely that a wire exists: the
      // seed sets a flow key, and CONNECT reads a flow key. Asserting only the
      // wire would pass with the two naming different keys, which is a form
      // that shows a value and applies nothing.
      const remember = flows.find((n) => n.id === `remember-cell-${box}`);
      const rules = remember?.rules as { p: string; pt: string; to: string; tot: string }[];
      expect(rules).toHaveLength(1);
      expect(rules[0].pt).toBe("flow");
      expect(rules[0].to).toBe("payload");
      const read = gathered.find((r) => r.p === `payload.${box}`);
      expect(read?.tot).toBe("flow");
      expect(read?.to, `the seed writes ${rules[0].p} and CONNECT reads ${String(read?.to)}`)
        .toBe(rules[0].p);
    }
  });

  /**
   * **R-SEC-10, and the one box that is never seeded.**
   * `network.modem.password` is a reference into secrets.yaml. Neither the
   * credential nor the reference to it goes anywhere near a form value, so the
   * password output feeds the box (to say *whether* one is set) and nothing
   * that CONNECT reads — an untouched password box must keep meaning "leave
   * the stored credential alone".
   */
  it("never seeds the password box, and never puts one where CONNECT reads", () => {
    const seed = flows.find((n) => n.type === "yonder-modem-form");
    const outs = seed?.wires as string[][];
    expect(outs[3]).toEqual(["input-cell-password"]);
    for (const out of outs) expect(out).not.toContain("remember-cell-password");
  });

  /**
   * R-SEC-10. `ui-form` renders nothing masked, so the password is its own
   * `ui-text-input`; `passthru` would put what was typed back on an outgoing
   * message.
   */
  it("masks the password and never echoes any field back", () => {
    const inputs = inTab.filter((n) => n.type === "ui-text-input");
    expect(inputs.find((n) => n.topic === "password")?.mode).toBe("password");
    for (const n of inputs) expect(n.passthru ?? false, String(n.id)).toBe(false);
  });

  /**
   * R-UI-10, and the one control on this tab that takes the link away from
   * the operator. Changing the APN re-dials; asking for a test does not.
   */
  it("puts both actions on one rail, with CONNECT as the irreversible one", () => {
    const rail = inTab.find((n) => n.type === "ui-yonder-softkeys");
    const keys = JSON.parse(String(rail?.keys)) as { label: string; action: string; tone: string }[];
    expect(keys).toEqual([
      { label: "TEST NOW", action: "test", tone: "act" },
      { label: "CONNECT", action: "connect", tone: "warn" },
    ]);
  });

  it("routes each key to the node that answers it", () => {
    const rail = inTab.find((n) => n.type === "ui-yonder-softkeys");
    expect((rail?.wires as string[][])[0]).toEqual(["route-cell-key"]);
    const route = flows.find((n) => n.id === "route-cell-key");
    expect(route?.type).toBe("switch");
    const wires = route?.wires as string[][];
    const typeOf = (id: string) => flows.find((n) => n.id === id)?.type;
    // TEST NOW asks the daemon to probe one path; CONNECT applies a section.
    expect(typeOf(wires[0][0])).toBe("change");
    expect(typeOf((flows.find((n) => n.id === wires[0][0])?.wires as string[][])[0][0]))
      .toBe("yonder-reach-test");
    expect(typeOf((flows.find((n) => n.id === wires[1][0])?.wires as string[][])[0][0]))
      .toBe("yonder-modem-configure");
  });

  /**
   * A control that says it will act and does not is worse than an absent one.
   * Both keys end somewhere an operator can see the answer.
   */
  it("says out loud what each key did", () => {
    const toast = flows.find((n) => n.type === "ui-notification");
    for (const id of ["reach-test", "modem-configure"]) {
      const out = (flows.find((n) => n.id === id)?.wires as string[][])[0];
      expect(out.length, `${id} answers nowhere`).toBeGreaterThan(0);
      const said = flows.find((n) => n.id === out[0]);
      expect((said?.wires as string[][])[0]).toContain(toast?.id);
    }
  });

  // CLAUDE.md rule 2, once more where it is easiest to break.
  it("ships no function node", () => {
    expect(inTab.some((n) => n.type === "function")).toBe(false);
  });
});

/**
 * The `Way out` rows on the Interfaces tab (R-NET-13, R-UI-11).
 *
 * They live *inside* the `Interfaces` group rather than in a group of their
 * own for the reason the Cellular tab is one group: on a page whose layout is
 * `tabs`, Dashboard's `LayoutTabs` renders one tab per `ui-group`, so a second
 * group would have put the paths on a surface of their own instead of beside
 * the addresses they explain.
 */
describe("flows/flows.json Way out rows", () => {
  const inTab = flows.filter((n) => n.group === "group-net-now");
  const byId = (id: string) => flows.find((n) => n.id === id);
  const PATHS = [
    { slug: "ethernet", key: "ethernet" },
    { slug: "modem", key: "modem" },
    { slug: "wifi", key: "wifi_client" },
  ];

  /**
   * Output 3 of `yonder-modem-state` is the rows. Nothing else may feed them:
   * a second poller would put the panel and the Cellular tab on different
   * ticks, which is what one node with four outputs exists to prevent.
   */
  it("is fed by the state node's third output, and by nothing else", () => {
    const state = flows.find((n) => n.type === "yonder-modem-state");
    expect((state!.wires as string[][])[2])
      .toEqual(["pick-way-ethernet", "pick-way-modem", "pick-way-wifi"]);
  });

  it.each(PATHS)("picks the $slug row by name, never by its place in the list", ({ slug, key }) => {
    const pick = byId(`pick-way-${slug}`);
    expect(pick?.type).toBe("change");
    const rules = pick?.rules as { t: string; p: string; to: string; tot: string }[];
    // The lamp first, while `payload` is still the list of rows.
    expect(rules.map((r) => r.p)).toEqual(["yonder", "payload"]);
    for (const r of rules) {
      expect(r.t).toBe("set");
      expect(r.tot).toBe("jsonata");
      expect(r.to).toContain(`path='${key}'`);
    }
    expect(rules[0].to).toBe(`payload[path='${key}'].status`);
  });

  /**
   * **R-UI-11: the lamp is read before the word.** A path's standing is a lit
   * annunciator and never right-aligned coloured text — and the annunciator
   * renders a `CommandStatus` from `msg.yonder`, which the row arrives
   * carrying because `pathStatus()` in the modem package built it.
   */
  it.each(PATHS)("gives $slug a name, a lamp and a sentence, in that order", ({ slug }) => {
    const row = [`name-way-${slug}`, `ann-way-${slug}`, `why-way-${slug}`];
    expect((byId(`pick-way-${slug}`)?.wires as string[][])[0]).toEqual(row);

    const name = byId(`name-way-${slug}`);
    expect(name?.type).toBe("ui-text");
    // The daemon's own word for the path, not a second copy of the vocabulary
    // in the flows — `PATH_WORDS` is where an interface is named.
    expect(name?.value).toBe("payload.name");

    const lamp = byId(`ann-way-${slug}`);
    expect(lamp?.type, "state is an indicator, not coloured text (R-UI-11)")
      .toBe("ui-yonder-annunciator");
    expect(lamp?.source).toBe("yonder");
    // No label, so the lamp says the standing the daemon settled rather than
    // a word chosen here.
    expect(lamp?.label).toBe("");

    const why = byId(`why-way-${slug}`);
    expect(why?.type).toBe("ui-text");
    expect(why?.value).toBe("payload.detail");
    // The sentence is the wide line on the row, and it wraps rather than
    // being cut off at the edge of a column.
    expect(why?.width).toBe(6);
    expect(why?.wrapText).toBe(true);
    // Prose, not a reading. Without this the sentence is drawn by
    // `.nrdb-ui-text-value` — bold, tabular and right-aligned — which is the
    // class that right-aligned an interface name inside its own column.
    expect(why?.className).toBe("yonder-qualifier");
  });

  /**
   * Three rows above the addresses, in the order `network.priority` states by
   * default. The order numbers are what Dashboard packs the group by, so this
   * is the only statement of "above" there is.
   */
  it("puts the paths above the readouts that were already there", () => {
    const order = (id: string) => Number(byId(id)?.order);
    for (const slug of ["ethernet", "modem", "wifi"]) {
      for (const part of ["name", "ann", "why"]) {
        expect(order(`${part}-way-${slug}`)).toBeLessThan(order("button-reread"));
      }
    }
    expect(order("name-way-ethernet")).toBeLessThan(order("name-way-modem"));
    expect(order("name-way-modem")).toBeLessThan(order("name-way-wifi"));
  });

  // CLAUDE.md rule 2, on the tab that gained the most wiring in this change.
  it("ships no function node", () => {
    expect(inTab.some((n) => n.type === "function")).toBe(false);
  });
});

/**
 * The Status page's own line for the mesh (R-VPN-10): everything that backs
 * "connected" reduced to the words `messageFor` already built into
 * `payload.summary`, so this page needs no arithmetic of its own to show
 * where the aircraft's link stands.
 */
describe("flows/flows.json status page remote line", () => {
  /**
   * Found by its label and then checked for its binding, not the other way
   * round. Two panels on this page now say what a subsystem is doing out of a
   * `payload.summary` — the mesh, and the link in `Reachable by` — so a
   * search by binding would return whichever happened to be written into the
   * file first and assert the other one's label.
   */
  it("shows the mesh summary, labelled Remote", () => {
    const page = flows.find((n) => n.type === "ui-page" && n.name === "Status");
    const groups = new Set(
      flows.filter((n) => n.type === "ui-group" && n.page === page?.id).map((n) => n.id),
    );
    const line = flows.find(
      (n) => n.type === "ui-text" && groups.has(String(n.group)) && n.label === "Remote",
    );
    expect(line, "the Status page has no line labelled Remote").toBeDefined();
    expect(line?.value).toBe("payload.summary");
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
 * `Reachable by` on the Status page (R-UI-05, R-UI-09, R-UI-11, R-CEL-11).
 *
 * A sibling of `This board`, in that panel's idiom — gauges over a labelled
 * strip — because it is the same kind of thing: a few live measurements and
 * the facts that identify them. `Remote` is a one-line summary and is
 * deliberately not the model here.
 *
 * Status is a `grid` page, not a `tabs` one, so a group here is a panel and
 * not a tab. That is the whole difference from the Cellular tab and the
 * `Way out` rows, both of which had to be built inside an existing group.
 */
describe("flows/flows.json Reachable by", () => {
  const byId = (id: string) => flows.find((n) => n.id === id);
  const inPanel = flows.filter((n) => n.group === "group-status-reach");

  it("is a panel of its own, full width, directly under This board", () => {
    const group = byId("group-status-reach");
    expect(group?.type).toBe("ui-group");
    expect(group?.page).toBe("page-status");
    expect(group?.name).toBe("Reachable by");
    // Full width is not decoration: it is what gives the gauge track the room
    // the bands need to separate at a glance.
    expect(group?.width).toBe(12);
    expect(Number(group?.order)).toBeGreaterThan(Number(byId("group-board")?.order));
    expect(Number(group?.order)).toBeLessThan(Number(byId("group-status-remote")?.order));
  });

  /**
   * One node, four outputs, one tick. A second poller would have Status
   * saying CELLULAR beside a Cellular tab that had not noticed yet — and the
   * disagreement is the one thing an operator cannot check.
   */
  it("is fed by the state node's fourth output, and by nothing else", () => {
    const state = flows.find((n) => n.type === "yonder-modem-state");
    expect((state!.wires as string[][])[3]).toEqual([
      "ann-reach", "text-reach-why", "bar-reach",
      "pick-reach-strength", "pick-reach-quality",
    ]);
  });

  /**
   * R-UI-11: the lamp is read before the word. The one-word answer arrives as
   * a `CommandStatus` on `msg.yonder`, built by `reachStatus()` in the modem
   * package, so no `change` node here turns a state into a colour.
   */
  it("says how the aircraft is reachable as a lit lamp, not as coloured text", () => {
    const lamp = byId("ann-reach");
    expect(lamp?.type).toBe("ui-yonder-annunciator");
    expect(lamp?.source).toBe("yonder");
    // No label, so the lamp carries the daemon's own word.
    expect(lamp?.label).toBe("");
    expect(Number(lamp?.order)).toBe(1);
  });

  /**
   * The line that says *why* the answer is that word — which path stood down,
   * and when. It is `payload.why`, composed by `reachWhy()` in the modem
   * package, and never the modem's own `summary`: that sentence is about the
   * radio, and under a lamp reading `NOTHING` it said "Connected to Dark
   * Star", which is the console contradicting itself on one line.
   */
  it("puts the sentence under it, as a qualifier and not as a reading", () => {
    const line = byId("text-reach-why");
    expect(line?.type).toBe("ui-text");
    expect(line?.value).toBe("payload.why");
    expect(line?.wrapText).toBe(true);
    // `.nrdb-ui-text-value` is large, bold, tabular and right-aligned — right
    // for an address, wrong for prose about one.
    expect(line?.className).toBe("yonder-qualifier");
    // Stacked, not side by side. The lamp hugs its caption, so reserving
    // columns beside it leaves a gap the eye reads as a missing value.
    expect(byId("ann-reach")?.width).toBe(12);
    expect(line?.width).toBe(12);
    expect(Number(line?.order)).toBeGreaterThan(Number(byId("ann-reach")?.order));
  });

  /**
   * R-UI-09, and the sentence it gained: which direction is bad is a property
   * of the quantity and is stated, never assumed. Getting `sense` wrong here
   * draws a dying link as a full bar.
   *
   * The bounds are the Cellular tab's, to the number. Two scales for one
   * quantity is two different answers to "is this signal usable", and the
   * operator would have no way to tell which page was lying.
   */
  it.each([
    { id: "gauge-reach-strength", label: "SIGNAL", unit: "dBm",
      min: -120, max: -70, caution: -90, limit: -105, twin: "gauge-cell-strength" },
    { id: "gauge-reach-quality", label: "QUALITY", unit: "dB",
      min: -5, max: 25, caution: 13, limit: 0, twin: "gauge-cell-quality" },
  ])("draws $label against the same scale the Cellular tab uses", (g) => {
    const gauge = byId(g.id);
    expect(gauge?.type).toBe("ui-yonder-gauge");
    expect(gauge?.label).toBe(g.label);
    expect(gauge?.unit).toBe(g.unit);
    expect(gauge?.sense, "a dying link drawn as a full bar (R-UI-09)").toBe("higher-is-better");
    for (const k of ["min", "max", "caution", "limit"] as const) {
      expect(gauge?.[k], `${g.label} ${k}`).toBe(g[k]);
      expect(gauge?.[k], `${g.label} ${k} differs from the Cellular tab`)
        .toBe(byId(g.twin)?.[k]);
    }
  });

  /**
   * The reason for the full-width placement, stated as a number.
   *
   * At this track width the amber and green bands separate at a glance, which
   * is the whole point of a banded gauge on a page that is glanced at. All
   * four gauges on the page read at one scale, which is what `This board`
   * going full width was for.
   */
  it("gives every gauge on the page the same, wider track", () => {
    for (const id of ["gauge-load", "gauge-temp", "gauge-mem",
                      "gauge-reach-strength", "gauge-reach-quality"]) {
      expect(byId(id)?.track, id).toBe(430);
      expect(byId(id)?.width, id).toBe(12);
    }
    // And the Cellular tab keeps its own, narrower one: it is half a tab wide.
    expect(byId("gauge-cell-strength")?.track).toBe(118);
  });

  /**
   * **It degrades rather than breaks.** On a board with no modem the gauges
   * are absent, not empty — a gauge with no needle reads as a fault, and
   * *there is no modem* is not a fault.
   *
   * The binding is a wire and not a decision: `showsSignal` is settled in the
   * modem package, where it is tested, and the flow only carries it onto
   * `msg.visible`. It is set before `payload` is replaced, because after that
   * rule the field is gone.
   */
  it.each(["strength", "quality"])("hides the %s gauge rather than emptying it", (which) => {
    const pick = byId(`pick-reach-${which}`);
    expect(pick?.type).toBe("change");
    const rules = pick?.rules as { t: string; p: string; to: string; tot: string }[];
    expect(rules.map((r) => r.p)).toEqual(["visible", "payload"]);
    expect(rules[0].to).toBe("payload.showsSignal");
    // JSONata, not a plain property read: a failed tick sends `payload: null`
    // and `null.showsSignal` throws in the latter.
    for (const r of rules) {
      expect(r.t).toBe("set");
      expect(r.tot).toBe("jsonata");
    }
    // The gauge is fed the bare number; the strings are the databar's job.
    expect(rules[1].to).toBe(`payload.gauges.${which}`);
    expect((pick?.wires as string[][])[0]).toEqual([`gauge-reach-${which}`]);
  });

  /**
   * The strip under the gauges: the facts that identify what is being
   * measured, in the words the Cellular tab already uses for them.
   *
   * Status says `SIGNAL` and `QUALITY` where the tab says RSRP and SINR — a
   * glance and a detail view — but the facts are the same facts and are
   * labelled the same way.
   */
  it("names what is being measured, under the gauges", () => {
    const bar = byId("bar-reach");
    expect(bar?.type).toBe("ui-yonder-databar");
    expect(bar?.width).toBe(12);
    const cells = JSON.parse(String(bar?.cells)) as { key: string; label: string }[];
    expect(cells.map((c) => c.key)).toEqual(["operator", "technology", "address"]);
    expect(cells.map((c) => c.label)).toEqual(["OPERATOR", "NETWORK", "ADDRESS"]);
    // The strip is the panel's floor and stays on a board with no modem, so
    // its order is below both gauges.
    for (const id of ["gauge-reach-strength", "gauge-reach-quality"]) {
      expect(Number(bar?.order)).toBeGreaterThan(Number(byId(id)?.order));
    }
  });

  /**
   * `Appearance` explained why two palettes exist — an argument that lands
   * once, on a page an operator returns to. The `Day`/`Night` rail it was
   * explaining stays, in a different group.
   */
  it("no longer explains itself, and still lets the operator choose", () => {
    expect(flows.find((n) => n.id === "group-appearance")).toBeUndefined();
    expect(flows.find((n) => n.id === "note-theme")).toBeUndefined();
    const page = flows.find((n) => n.type === "ui-page" && n.name === "Status");
    const groups = new Set(
      flows.filter((n) => n.type === "ui-group" && n.page === page?.id).map((n) => n.id),
    );
    expect(flows.filter((n) => n.type === "ui-markdown" && groups.has(String(n.group))))
      .toEqual([]);
    // The rail the panel was about.
    expect(flows.find((n) => n.id === "keys-status")?.group).toBe("group-rail-status");
  });

  // CLAUDE.md rule 2, on the page that gained the most wiring in this change.
  it("ships no function node", () => {
    expect(inPanel.some((n) => n.type === "function")).toBe(false);
    for (const id of ["pick-reach-strength", "pick-reach-quality"]) {
      expect(byId(id)?.type).toBe("change");
    }
  });
});

/**
 * **`CHANGE PENDING` (R-UI-15).**
 *
 * The confirmation timer is what makes this device unbrickable (R-CFG-03).
 * The apply engine has tracked the pending change and its deadline all along
 * and the console drew it **only on the page the change was made on** — make
 * a change on the Network page, walk to Status, and nothing said the
 * configuration reverts in ninety seconds unless somebody confirms it.
 *
 * This is also what closed K-30: `yonder-confirm` had been registered and used
 * by nothing since R-CFG-11 took away the wiring that called it.
 */
describe("flows/flows.json Change pending", () => {
  const byId = (id: string) => flows.find((n) => n.id === id);
  const inPanel = flows.filter((n) => n.group === "group-status-pending");
  const wiresOf = (id: string) => (byId(id)?.wires ?? []) as string[][];

  it("is the first panel on Status, above the board it is about to change", () => {
    const group = byId("group-status-pending");
    expect(group?.type).toBe("ui-group");
    expect(group?.page).toBe("page-status");
    expect(group?.name).toBe("Change pending");
    expect(group?.width).toBe(12);
    for (const other of ["group-board", "group-status-reach", "group-status-remote"]) {
      expect(Number(group?.order)).toBeLessThan(Number(byId(other)?.order));
    }
  });

  /**
   * **Hidden in the shipped file, not merely at the first poll.**
   *
   * Dashboard reads a group with no `visible` as visible, and group
   * visibility is server-side state that starts unset — so a console that had
   * just started would draw an empty CHANGE PENDING panel until the first
   * read said otherwise. A panel that is always there saying nothing is
   * pending is noise on a page an operator glances at, and noise on that page
   * is what makes the one time it matters invisible.
   */
  it("ships hidden, and is raised only while something is pending", () => {
    expect(byId("group-status-pending")?.visible).toBe(false);

    // The decision is a boolean the package computed. The flow routes it; it
    // does not work it out (CLAUDE.md rule 2).
    const gate = byId("route-pending-banner");
    expect(gate?.type).toBe("switch");
    expect(gate?.property).toBe("payload.pending");
    expect((gate?.rules as { t: string }[]).map((r) => r.t)).toEqual(["true", "false"]);
    expect(wiresOf("route-pending-banner"))
      .toEqual([["show-pending-banner"], ["hide-pending-banner"]]);

    // Two constants either side of it, never one conditional.
    for (const [id, key] of [["show-pending-banner", "show"], ["hide-pending-banner", "hide"]]) {
      const node = byId(id);
      expect(node?.type).toBe("change");
      const rules = node?.rules as { p: string; tot: string; to: string }[];
      expect(rules).toHaveLength(1);
      expect(rules[0].p).toBe("payload");
      expect(rules[0].tot).toBe("json");
      expect(JSON.parse(rules[0].to)).toEqual({ groups: { [key]: ["group-status-pending"] } });
      expect(wiresOf(id)).toEqual([["control-pending"]]);
    }
    // Dashboard hides a *group* only through ui-control, which needs the base.
    expect(byId("control-pending")?.type).toBe("ui-control");
    expect(byId("control-pending")?.ui).toBe(flows.find((n) => n.type === "ui-base")?.id);
  });

  /**
   * The countdown is text when it reaches the page. A clock ticking inside
   * `flows.json` would be arithmetic in wiring — on the one number that
   * decides whether an operator still has a device.
   */
  it("draws the time left as a lit caption, computed in the package", () => {
    const poller = byId("poll-pending");
    expect(poller?.type).toBe("yonder-pending");
    expect(Number(poller?.interval) * 1000).toBeGreaterThanOrEqual(MIN_POLL_MS);
    expect(wiresOf("poll-pending")[0]).toEqual([
      "ann-pending", "text-pending-what", "text-pending-why",
      "route-pending-banner", "route-pending-key",
    ]);

    const lamp = byId("ann-pending");
    expect(lamp?.type).toBe("ui-yonder-annunciator");
    expect(lamp?.group).toBe("group-status-pending");
    // From the shared channel, with no label of its own, so the words are the
    // ones `pendingChange()` wrote.
    expect(lamp?.source).toBe("yonder");
    expect(lamp?.label).toBe("");
    expect(Number(lamp?.order)).toBe(1);
    // The one annunciator on this console whose caption is a *reading* rather
    // than a state word. Without saying so, the committed picture of this page
    // would differ on every run by a second or two of countdown — which is the
    // thing masking exists to stop.
    expect(lamp?.className).toBe("yonder-live");
  });

  /**
   * Both lines are sentences, so both are qualifiers. `.nrdb-ui-text-value`
   * is `text-align: right` — the defect Task 8's capture found, on prose the
   * console had put in a readout's slot.
   */
  it("says what is in force and what the revert is for, as prose", () => {
    for (const [id, bound] of [["text-pending-what", "payload.what"], ["text-pending-why", "payload.why"]]) {
      const line = byId(id);
      expect(line?.type).toBe("ui-text");
      expect(line?.group).toBe("group-status-pending");
      expect(line?.value).toBe(bound);
      expect(line?.valueType).toBe("msg");
      expect(line?.wrapText).toBe(true);
      expect(line?.className).toBe("yonder-qualifier");
    }
    expect(Number(byId("text-pending-what")?.order))
      .toBeLessThan(Number(byId("text-pending-why")?.order));
  });

  /**
   * **`CONFIRM` is the irreversible one, and `REVERT NOW` is not.**
   *
   * This is the opposite of what most interfaces do and it is deliberate.
   * Confirming keeps a change nobody can take back automatically; reverting
   * is the safe direction, and it is the thing that gets an operator back in.
   */
  it("marks confirming as the irreversible act, and reverting as the safe one", () => {
    const keys = JSON.parse(String(byId("keys-pending")?.keys ?? "[]")) as
      { label: string; action: string; tone: string }[];
    expect(keys).toEqual([
      { label: "CONFIRM", action: "confirm", tone: "warn" },
      { label: "REVERT NOW", action: "revert", tone: "act" },
    ]);
    // R-UI-10: at most one control per page takes the irreversible tone, and
    // Status's other rail is two palette keys.
    const warnOnStatus = flows
      .filter((n) => n.type === "ui-yonder-softkeys")
      .filter((n) => String(n.group).includes("status") || n.group === "group-status-pending")
      .flatMap((n) => JSON.parse(String(n.keys ?? "[]")) as { tone?: string }[])
      .filter((k) => k.tone === "warn");
    expect(warnOnStatus).toHaveLength(1);
  });

  /**
   * A press is answered by a fresh read, so the id the two nodes act on is
   * the one the device holds at that moment — never one a flow cached and may
   * have watched expire. The key's own action rides on `msg.topic`, which the
   * read does not overwrite.
   */
  it("reads the apply id at the moment the key is pressed, and caches none", () => {
    expect(wiresOf("keys-pending")).toEqual([["tag-pending-key"]]);
    const tag = byId("tag-pending-key");
    expect(tag?.type).toBe("change");
    expect(tag?.rules).toEqual([{ t: "set", p: "topic", pt: "msg", to: "payload", tot: "msg" }]);
    expect(wiresOf("tag-pending-key")).toEqual([["poll-pending"]]);

    const route = byId("route-pending-key");
    expect(route?.type).toBe("switch");
    expect(route?.property).toBe("topic");
    expect((route?.rules as { v: string }[]).map((r) => r.v)).toEqual(["confirm", "revert"]);
    expect(wiresOf("route-pending-key")).toEqual([["confirm-pending"], ["revert-pending"]]);

    expect(byId("confirm-pending")?.type).toBe("yonder-confirm");
    expect(byId("revert-pending")?.type).toBe("yonder-revert");
    // Nothing here keeps state between one press and the next.
    expect(JSON.stringify(inPanel)).not.toMatch(/"flow"|"global"/);
  });

  /**
   * Whichever key was pressed, the operator is told what it did. Without
   * this a confirm the daemon refused — "nothing is pending confirmation" —
   * would be a key that did nothing and said nothing (R-UI-05).
   */
  it("says out loud what each key did", () => {
    for (const id of ["confirm-pending", "revert-pending"]) {
      expect(wiresOf(id)).toEqual([["say-pending"]]);
    }
    const say = byId("say-pending");
    expect(say?.type).toBe("change");
    expect((say?.rules as { to: string }[])[0].to).toBe("yonder.message");
    expect(wiresOf("say-pending")[0]).toContain(flows.find((n) => n.type === "ui-notification")?.id);
  });

  // CLAUDE.md rule 2. The countdown is the thing most likely to be reached
  // for with a function node, and it is in yonder-core.
  it("ships no function node", () => {
    const own = new Set([
      "poll-pending", "tag-pending-key", "route-pending-key", "route-pending-banner",
      "show-pending-banner", "hide-pending-banner", "control-pending",
      "confirm-pending", "revert-pending", "say-pending",
    ]);
    for (const node of flows.filter((n) => own.has(n.id) || inPanel.includes(n))) {
      expect(node.type, node.id).not.toBe("function");
    }
  });
});
