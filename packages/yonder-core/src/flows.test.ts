// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { JOIN_TOPIC } from "./net/join.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CONSOLE_HOME, EXCLUDED_NODES } from "./console/settings.js";
import { MIN_POLL_MS, PENDING_KEYS } from "./console/node.js";

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
  repeat?: string;
  [key: string]: unknown;
}

const flows = JSON.parse(readFileSync(FLOWS, "utf8")) as FlowNode[];
const text = readFileSync(FLOWS, "utf8");
const ids = new Set(flows.map((n) => n.id));

const CONSOLE_ROLE = join(ROOT, "installer", "roles", "30-console.sh");

/**
 * The packages a real install puts into the console tree, **read from the
 * role that does it** rather than restated here.
 *
 * Restating them is the defect this function exists to close. The list used to
 * be a literal in this file, and it named every package this project has —
 * while `installer/roles/30-console.sh` named four of the five. So the flows
 * were checked against packages that a device installed the shipped way never
 * received: `yonder-modem-state`, `yonder-modem-configure`, `yonder-modem-form`
 * and `yonder-reach-test` all resolved here and none of them existed on a
 * board. The Cellular tab, the `Way out` panel's data source and the Status
 * page's reachability line were dead on every installed device, and every test
 * passed, because each half was right about itself.
 *
 * Two facts that only mean something together, so they are read from one
 * place: what the flows use, and what the installer installs.
 */
function installedPackages(): string[] {
  // Backslash continuations joined first, so the loop is one line however it
  // is wrapped — the same reading installer.test.ts does of 10-base.sh.
  const role = readFileSync(CONSOLE_ROLE, "utf8").replaceAll("\\\n", " ");
  const loop = /^for pkg in (.+?); do$/m.exec(role);
  expect(
    loop,
    `${CONSOLE_ROLE} no longer has a 'for pkg in ...; do' loop. That loop is how the `
    + "console gets its Yonder packages, and this file reads it to check the flows "
    + "against what a real install actually provides.",
  ).not.toBeNull();
  return (loop?.[1] ?? "").trim().split(/\s+/).filter(Boolean);
}

/** The node types each installed Yonder package registers, from its manifest. */
function contribTypes(): Set<string> {
  const types = new Set<string>();
  for (const pkg of installedPackages()) {
    const manifest = JSON.parse(
      readFileSync(join(ROOT, "packages", pkg, "package.json"), "utf8"),
    ) as { "node-red": { nodes?: Record<string, string> } };
    for (const type of Object.keys(manifest["node-red"].nodes ?? {})) types.add(type);
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
   * **Every value on the Telemetry page came from the device.**
   *
   * The page was built against thirty-two `change` nodes carrying static
   * payloads and one `inject` to set them off, because the arrangement had to
   * be settled by looking at it before there was anything to read. Those
   * payloads were the specification the nodes in
   * `node-red-contrib-yonder-mavlink` were then written against — and a
   * mockup left in place beside the real source is a page that goes on
   * looking right on a device that is telling it nothing at all.
   *
   * Asserted by prefix rather than by a list, so a mock added later to settle
   * some other arrangement is caught by the same line.
   */
  it("carries no mockup scaffolding", () => {
    const mocks = flows.filter((n) => String(n.id).startsWith("mock-"));
    expect(
      mocks.map((n) => n.id),
      "flows/flows.json still has mockup scaffolding in it. A static payload beside a real "
      + "source is a page that reads correctly on a device that has told it nothing.",
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

  /**
   * The theme used to reach the page through exactly this: a `ui-template`'s
   * `@import`, injected over Dashboard's own socket connection after the SPA
   * had already booted — which is what made the console flash white on every
   * load (R-UI-22). It is linked from the served document's head now
   * (`ConsoleRenderer`, `wiring.ts`'s `headInjection`), so the flows do not
   * need to import it at all any more.
   */
  it("loads the theme from the served document's head, not by importing it here", () => {
    expect(text).not.toMatch(/@import/);
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
   * Every Yonder reader costs the daemon a request, and the daemon answers
   * most of them by shelling out. So a second timer aimed at a second copy of
   * the same reader is that whole cost paid twice, forever, for one answer -
   * and it is invisible on the page, because both copies show the same thing.
   *
   * That is exactly what happened: the Status page's one-line mesh summary and
   * the Network page's mesh panel each had their own `yonder-remote-state` on
   * its own timer, at 2 s and 5 s, both reading `GET /remote/state`. One
   * reader feeds both pages; nothing about a second copy was load-bearing.
   *
   * Only Yonder types are checked. A `change` or a `switch` on two timers is
   * plumbing and costs nothing off-board.
   */
  it("reads each thing once, however many pages show it", () => {
    const byId = new Map(flows.map((n) => [n.id, n]));
    const polled = new Map<string, string[]>();
    for (const node of flows) {
      if (node.type !== "inject" || !node.repeat) continue;
      for (const target of node.wires?.[0] ?? []) {
        const type = byId.get(target)?.type ?? "";
        if (!type.startsWith("yonder-")) continue;
        polled.set(type, [...(polled.get(type) ?? []), `${node.id} every ${String(node.repeat)} s -> ${target}`]);
      }
    }
    expect(polled.size).toBeGreaterThan(0);
    for (const [type, pollers] of polled) {
      expect(pollers, `${type} is polled ${String(pollers.length)} times: ${pollers.join(", ")}`)
        .toHaveLength(1);
    }
  });

  /**
   * A type nobody registers is a node that loads as "unknown" and does
   * nothing, which on a console is a page that is silently missing a control.
   *
   * **Checked against the packages the installer installs**, not against every
   * package in this repository (R-UI-19). Those are two different claims and
   * only the second one matters to a device: a node that exists in
   * `packages/` and is never copied into the console tree is exactly as absent
   * as one nobody wrote. See `installedPackages`.
   */
  it("uses only Yonder node types a package the installer installs registers", () => {
    const registered = contribTypes();
    // `ui-yonder-` as well as `yonder-`: the instrument widgets are Dashboard
    // widget types, and leaving them out of this check was how a renamed one
    // would have reached a board as a page with a hole in it.
    const used = new Set(
      flows.map((n) => n.type).filter((t) => t.startsWith("yonder-") || t.startsWith("ui-yonder-")),
    );
    expect(used.size).toBeGreaterThan(0);
    for (const type of used) {
      expect(
        registered.has(type),
        `${type} is used in flows/flows.json and no package installed by `
        + "installer/roles/30-console.sh registers it. On a device installed the shipped "
        + "way that node loads as 'unknown' and the page it sits on is dead. Either add "
        + "the package to that role's `for pkg in` loop, or take the node out of the flows.",
      ).toBe(true);
    }
  });

  /**
   * The capture gate stages its own console tree, and it had its own list of
   * packages to stage. That second list is why nothing noticed the first one
   * was short: `scripts/verify-pages.sh` linked all five, so every page it
   * photographed had every node it needed, on a tree no device ever gets.
   *
   * A gate that exercises a different console from the one the installer
   * builds is a gate that proves nothing about the installed device, so the
   * two lists are held equal here (R-UI-19).
   */
  it("is photographed on the same set of packages the installer installs", () => {
    const gate = readFileSync(join(ROOT, "scripts", "verify-pages.sh"), "utf8")
      .replaceAll("\\\n", " ");
    const loop = /^for pkg in (.+?); do$/m.exec(gate);
    expect(loop, "scripts/verify-pages.sh no longer stages packages with a 'for pkg in' loop")
      .not.toBeNull();
    const staged = (loop?.[1] ?? "").trim().split(/\s+/).filter(Boolean);
    expect(
      [...staged].sort(),
      "the capture gate and installer/roles/30-console.sh stage different packages. "
      + "Whichever of the two is short, the pages the gate photographs are not the pages "
      + "an installed device serves.",
    ).toEqual([...installedPackages()].sort());
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
    // Cameras and the camera page came with M4; Telemetry joined them with
    // M5a. They sit above Log and Diagnostics because the payload is what an
    // operator came to the console for, and the log is what they reach for
    // when it is not working. The list is exhaustive rather than a minimum on
    // purpose: a page added without a line here is a page nobody decided to
    // ship, and the capture gate would photograph it anyway.
    expect(pages.map((p) => p.name).sort())
      .toEqual(["Camera", "Cameras", "Cockpit", "Diagnostics", "Log", "Network", "Status", "Telemetry"]);

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
 * **No `ui-template` survives (R-UI-22, CLAUDE.md rule 2).**
 *
 * The generated stylesheet used to reach the page through one: a node
 * carrying `<link rel="stylesheet" href="/yonder/theme.css">` inside an
 * `@import`, with `templateScope: "site:style"`. That node was itself the
 * fix for an earlier defect — an *older* `ui-template` had shipped with
 * `templateScope: "site"`, which is not a scope Dashboard 2.x accepts at all,
 * so it was never injected and every `--yonder-*` variable was undefined in
 * the document. Both versions shared the one property that actually mattered:
 * a `ui-template` is markup serialised into this file beside wire
 * coordinates, so a pull request against either one was unreadable, and it
 * cannot be reviewed if it cannot be read.
 *
 * The theme is linked from the served document's head now — `ConsoleRenderer`
 * writes it into `settings.js`, and `wiring.ts`'s `headInjection` is what
 * actually splices it in — which is also the only way that link reaches the
 * page *before* the browser paints it, rather than after Dashboard's own
 * socket connects. Nothing a `ui-template` could do remains a reason to have
 * one, so none may exist: this is the assertion that keeps the door CLAUDE.md
 * rule 2 shut. If it fails, the fix is to find another way to reach Dashboard,
 * not to add the node back.
 */
describe("flows/flows.json ui-template", () => {
  it("does not exist, so markup cannot be pasted into one", () => {
    const offenders = flows.filter((n) => n.type === "ui-template").map((n) => n.id);
    expect(
      offenders,
      "the shipped flows contain a ui-template. Markup lives in Vue components under "
      + "node-red-dashboard-2-yonder, never pasted into flows.json (CLAUDE.md rule 2): a diff "
      + "against serialised markup cannot be reviewed.",
    ).toEqual([]);
  });
});

/**
 * `ui-markdown` is not banned the way `ui-template` is: it renders the
 * content a node carries, nothing else, so there is no scope to get wrong and
 * no way for it to hide behaviour. What it can still do is grow — the same
 * shape of defect R-UI-16's word budget below is for — so this names *where*
 * every surviving instance is rather than only counting them: a second one
 * added anywhere but Diagnostics should fail here, specifically, and say so.
 */
describe("flows/flows.json ui-markdown", () => {
  it("survives only on Diagnostics", () => {
    const pageNameOf = (groupId: unknown): string | undefined => {
      const group = flows.find((n) => n.type === "ui-group" && n.id === groupId);
      const page = flows.find((n) => n.type === "ui-page" && n.id === group?.page);
      return page?.name;
    };
    const notes = flows.filter((n) => n.type === "ui-markdown");
    expect(notes.map((n) => `${String(n.id)} (${String(pageNameOf(n.group))})`)).toEqual([
      `note-reach (Diagnostics)`,
    ]);
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
      // The CHANGE PENDING banner sits above every tab's own content
      // (R-UI-15) and is not part of this task; what this asserts is the
      // order of the join itself.
      .filter((n) => !String(n.className ?? "").includes("yonder-pending"))
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
    // Narrowed, not weakened, and now on two counts. R-UI-15 put a
    // `yonder-confirm` back on Status, reached from a banner that any pending
    // change raises — which closed K-30 — and the camera page uses one for a
    // bitrate apply: R-CFG-11 removed the confirmation for *joining a
    // network*, not R-CFG-03's window in general, and a camera's bitrate is
    // spend on the path the console is standing on. What must stay gone is a
    // confirmation *of the join*, asked for from a page the join takes off
    // the air. So the assertion is that the confirm controls in the flows are
    // exactly the two allowed to be there, and that nothing in the Wi-Fi
    // panel reaches either of them.
    const confirms = flows
      .filter((n) => n.type === "yonder-confirm")
      .map((n) => String(n.id))
      .sort();
    expect(confirms).toEqual(["cam-transaction-confirm", "confirm-pending"]);
    const fromJoin = flows
      .filter((n) => n.group === "group-net-join" || n.type === "yonder-join")
      .flatMap((n) => (n.wires ?? []).flat());
    for (const id of confirms) expect(fromJoin).not.toContain(id);
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
   * **R-SEC-10, and the pattern `yonder-join` already sets.** The Wi-Fi
   * passphrase is dropped the instant the body is built — "a passphrase that
   * has been sent has no reason to still be in this process". The modem
   * password used to do the opposite: written to flow context and never
   * cleared, so it survived for the life of the deployment, was re-sent on
   * every later CONNECT (including after a reload that shows the box empty),
   * and was readable in the flow editor's context sidebar.
   *
   * Asserted as *order within the one node*: the value is copied onto the
   * message and then the key is deleted, in that sequence, so CONNECT still
   * sends what was typed and nothing keeps it afterwards.
   */
  it("forgets the typed password once CONNECT has read it", () => {
    const gather = flows.find((n) => n.id === "gather-cell-form");
    const rules = gather?.rules as { t: string; p: string; pt: string; to?: string; tot?: string }[];
    const read = rules.findIndex((r) => r.t === "set" && r.p === "payload.password");
    const forget = rules.findIndex((r) => r.t === "delete" && r.p === "modemPassword" && r.pt === "flow");
    expect(read, "CONNECT no longer reads the typed password").toBeGreaterThanOrEqual(0);
    expect(forget, "the typed password is left in flow context").toBeGreaterThanOrEqual(0);
    expect(forget, "the key is cleared before CONNECT reads it").toBeGreaterThan(read);
    // And no other node puts it back.
    const writers = flows.filter((n) => (n.rules as { p?: string; pt?: string }[] | undefined)
      ?.some((r) => r.pt === "flow" && r.p === "modemPassword" && (r as { t?: string }).t !== "delete"));
    expect(writers.map((n) => n.id)).toEqual(["remember-cell-password"]);
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
    expect(String(why?.className)).toContain("yonder-qualifier");
  });

  /**
   * **The row declares that its values do not move between runs (R-UI-12).**
   *
   * Both halves of a row are `ui-text` values, so both render
   * `.nrdb-ui-text-value` — which the capture gate masks *by kind*, because
   * most instances of it carry a reading. These carry none: the interface
   * name comes from a device list and the sentence is one of five fixed
   * strings `report()` chooses between.
   *
   * Without `yonder-fixed` the three `Way out` state captures were three grey
   * rectangles apiece. The exact sentence R-NET-14 was written to abolish —
   * "Up, and not yet tested — nothing has established that it reaches
   * anything" — was invisible in every committed reference, and so was the
   * right-aligned interface name that the gate itself was written after.
   * This is the third time on this branch that masking hid the very
   * difference a state was captured to show; `yonder-fixed` is the same
   * instrument Task 11 reached for on the way-back-in panel.
   */
  it.each(PATHS)("declares $slug's name and sentence fixed, so a capture shows them", ({ slug }) => {
    expect(String(byId(`name-way-${slug}`)?.className)).toContain("yonder-fixed");
    expect(String(byId(`why-way-${slug}`)?.className)).toContain("yonder-fixed");
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

  /**
   * Fed by the mesh reader, whichever page is in front.
   *
   * This line used to carry a second `yonder-remote-state` and a second timer,
   * on the reasoning that the Status page must read "independently of which
   * Network tab is open". That reasoning does not hold: an `inject` fires on
   * the runtime's clock, and a Dashboard page that nobody is looking at does
   * not stop it. Both copies therefore ran all the time, and the second one
   * bought a duplicate `GET /remote/state` — 12 more a minute, each shelling
   * out — for a value the first already had.
   */
  it("is fed by the mesh reader, on a poll no tighter than the floor (R-UI-06)", () => {
    const readers = flows.filter((n) => n.type === "yonder-remote-state");
    expect(readers).toHaveLength(1);
    expect(readers[0]?.wires?.[0] ?? [], "the Remote line is wired to nothing that reads the mesh")
      .toContain("text-status-remote");

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
   * Every surface of this console, and the banner on each.
   *
   * A `ui-group` belongs to one page, so there is one copy per page — and on
   * the Network page one copy per *tab*, because Dashboard's tabs layout
   * renders one `ui-group` per tab: a group there would be a tab that
   * appears, which an operator on another tab would never see. R-UI-12 counts
   * a tab as a surface for exactly this reason.
   */
  // Local to this block: the merge landed the telemetry side's surface check
  // in a describe that has no `byId` of its own.
  const byId = (id: string) => flows.find((n) => n.id === id);
  const SURFACES = [
    { group: "group-status-pending", suffix: "", hidden: "group" },
    { group: "group-log-pending", suffix: "-log", hidden: "group" },
    { group: "group-diag-pending", suffix: "-diag", hidden: "group" },
    { group: "group-tel-pending", suffix: "-tel", hidden: "group" },
    // The two camera pages, reached by R-UI-15 on merge, in their own idiom.
    // The Camera page states it on the single lamp it already has — one lamp
    // for the page is this page-set's own rule, and a second annunciator is
    // exactly what that rule forbids — while the Cameras page, which had no
    // lamp, gains one above the list. Neither carries the `ui-text` pair:
    // ADR-0009 keeps stock controls off both, and the lamp's text is the same
    // message those lines are drawn from. CONFIRM and REVERT NOW are on the
    // rail, because R-UI-10 puts every action there and only there.
    { group: "group-cam-aim", suffix: "-cam", hidden: "widgets" },
    { group: "group-cameras-pending", suffix: "-cameras", hidden: "group" },
    { group: "group-cockpit-pending", suffix: "-cockpit", hidden: "group" },
    // The camera pages, reached by R-UI-15 on merge. They carry the banner in
    // their own idiom: the annunciator alone in the group (no `ui-text`, which
    // ADR-0009 keeps off these two pages) and CONFIRM/REVERT as a softkey row
    // on the rail, because R-UI-10 puts every action there and only there.
    { group: "group-cameras-pending", suffix: "-cameras", hidden: "group" },
    { group: "group-cam-pending", suffix: "-cam", hidden: "group" },
    { group: "group-net-now", suffix: "-interfaces", hidden: "widgets" },
    { group: "group-net-join", suffix: "-wifi", hidden: "widgets" },
    { group: "group-net-zerotier", suffix: "-zerotier", hidden: "widgets" },
    { group: "group-net-cellular", suffix: "-cellular", hidden: "widgets" },
    { group: "group-net-activity", suffix: "-activity", hidden: "widgets" },
  ];
  const banner = (s: string) => ({
    lamp: `ann-pending${s}`,
    what: `text-pending-what${s}`,
    why: `text-pending-why${s}`,
    keys: `keys-pending${s}`,
  });
  const inPanel = flows.filter((n) => String(n.className ?? "").includes("yonder-pending"));

  /**
   * **R-UI-15, priority 1: "every surface of the console shows that it is".**
   *
   * Counted against the pages the console actually serves and the tabs they
   * are made of, rather than against a list beside them — a page added later
   * fails this until it carries the banner too.
   */
  it("is on every page, and on every tab of the page that has them", () => {
    const surfaces = new Set<string>();
    for (const page of flows.filter((n) => n.type === "ui-page")) {
      const groups = flows.filter((n) => n.type === "ui-group" && n.page === page.id);
      // A tabs page hides every group but one, so each is its own surface. A
      // grid page shows them all at once, so the page is the surface.
      if (page.layout === "tabs") for (const g of groups) surfaces.add(String(g.id));
      else surfaces.add(String(page.id));
    }
    for (const surface of surfaces) {
      const carried = SURFACES.some((s) => s.group === surface
        || byId(s.group)?.page === surface);
      expect(carried, `${surface} has no CHANGE PENDING banner on it`).toBe(true);
    }
  });

  /**
   * **No stock control on either camera page** (ADR-0009, spec §1).
   *
   * Eleven of the twenty-three widgets on these two pages were stock
   * Dashboard controls — two sliders, three number inputs, two tables, four
   * text widgets — which is the measured defect the whole instrument library
   * exists to fix. A slider carrying no value at all is not a control an
   * operator can read (R-UI-09), and a `ui-number-input` that applies on
   * blur is spec §10's defect 1. This is the assertion that stops one
   * coming back: it names the five types by hand rather than testing "no
   * type outside this package", because a stock `ui-button` on a rail is
   * still allowed and a stock `ui-notification` is how a toast is drawn.
   */
  it("has no stock control on either camera page", () => {
    const banned = ["ui-slider", "ui-number-input", "ui-table", "ui-text", "ui-dropdown"];
    for (const page of [camera, cameras]) {
      const types = on(page).map((n) => n.type);
      for (const stock of banned) {
        expect(types, `${String(page?.name)} still carries a ${stock}`).not.toContain(stock);
      }
    }
  });

  /**
   * **The Camera page is the instruments, and nothing else** (spec §6).
   *
   * Two decks — Live and Setup, one component in two modes — the picture,
   * the Aim panel as its own node (R-UI-28, so the Cockpit can carry it
   * without a deck), one annunciator, the readout strip, and the rail's two
   * keys.
   */
  it("draws one Camera workspace and one separate Aim without an idle annunciator", () => { const types=on(camera).map(n=>n.type); expect(types.filter(t=>t==='ui-yonder-deck')).toHaveLength(1); expect(types.filter(t=>t==='ui-yonder-aim')).toHaveLength(1); expect(types).toContain('ui-yonder-picture'); expect(types).toContain('ui-yonder-holdkey'); expect(types).not.toContain('ui-yonder-annunciator'); });

  /**
   * **The Cameras page is the index, the budget and the rail** (spec §5).
   *
   * R-CAM-12 asks for what was found, what was rejected and why; both lists
   * are `ui-yonder-index`'s, drawn from one payload, rather than two
   * `ui-table`s whose columns are declared in this file.
   */
  it("draws the Cameras page from index, budget, softkeys", () => {
    const types = on(cameras).map((n) => n.type);
    expect(types.slice().sort())
      // The annunciator arrived with R-UI-15: this page had no lamp of its
      // own, so a change pending confirmation had nowhere to show while an
      // operator was looking at the camera list.
      .toEqual([
        "ui-yonder-annunciator", "ui-yonder-budget", "ui-yonder-index",
        "ui-yonder-softkeys", "ui-yonder-softkeys",
      ]);
  });

  /**
   * **R-CAM-05 in words, and the thing nothing in this repository rendered.**
   *
   * `byPathStable` was resolved, typed and tested from Task 4 onwards and no
   * surface showed it — so an operator never learned whether the camera they
   * configured would still be the one that name means after a reboot. It was
   * a table column and a `ui-text` line; both went with the stock widgets,
   * and for one commit the sentence was composed on two payloads and drawn on
   * neither. It is a cell on the readout strip and a line on every index row
   * now, both from `identityWords()`, which is where the sentence lives.
   *
   * A `note` cell, not a reading: the by-path name alone is 66 characters
   * before the sentence starts (R-UI-25 — it wraps rather than being cut).
   * The index's own half is a component fact and is held in
   * `index.component.test.ts`; this holds the half that lives in the wiring.
   */
  it("shows each camera's identity, not only its /dev node", () => {
    const bar = on(camera).find((n) => n.type === "ui-yonder-databar"
      && String(n.cells).includes("\"key\":\"identity\""));
    expect(bar, "the camera page never shows its identity").toBeDefined();
    const cell = (JSON.parse(String(bar?.cells)) as { key: string; kind?: string }[])
      .find((c) => c.key === "identity");
    expect(cell?.kind, "a 130-character sentence is not a reading").toBe("note");
    // Fed from the same read as the rest of the strip, so it can never be a
    // value this file typed in.
    expect((flows.find((n) => n.id === "pick-cam-strip")?.wires as string[][])[0])
      .toContain(bar?.id);
  });

  /**
   * R-CAM-05 and R-CAM-12, both now composed in `video/present.ts` rather
   * than assembled out of table columns here: `cameraIndex()` puts
   * `identity` on every row and carries every rejection with its reason, and
   * `present.test.ts` is what holds it to that. What this file holds is the
   * half it can see — that the page is fed the composed object and nothing
   * re-derives it in a `change` node (CLAUDE.md rule 2).
   */
  it("feeds the index from the sweep, as one composed payload", () => {
    const index = flows.find((n) => n.type === "ui-yonder-index");
    expect(index, "there is no camera index").toBeDefined();
    const pick = flows.find((n) => n.id === "pick-cameras-index");
    // A move, not a composition: one property, read whole.
    expect((pick?.rules as { p: string; to: string; tot: string }[])).toEqual([
      { t: "set", p: "payload", pt: "msg", to: "payload.index", tot: "jsonata" },
    ]);
    expect((pick?.wires as string[][])[0]).toEqual([index?.id]);
    expect((flows.find((n) => n.id === "cameras-read")?.wires as string[][])[0])
      .toContain("pick-cameras-index");
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
  /**
   * **Picture, aim, strip, deck, rail — the blueprint's own order.**
   *
   * `docs/console/design/instrument-library/fold.1440.png` draws the readings
   * directly under the picture and above the deck, and this asserts that.
   *
   * It briefly did not. The strip was moved below both decks because three
   * lines of prose between the picture and the deck put the shutter key nine
   * pixels past a 1024×768 viewport — measured, and true. But the measurement
   * was against a rule nobody asked for: spec §5 gives the above-the-fold
   * contract to one surface, "at 1440×900 with the sidebar open", and asks a
   * tablet for something else entirely — "everything still reachable with a
   * finger", which §13 repeats as "no hidden controls ... at tablet widths".
   * The gate was applying the notebook's fold list at 1024×768 as well, and
   * the page was rearranged to satisfy it.
   *
   * That is the whole shape of the mistake worth remembering: a gate rule
   * stricter than the specification silently became the specification, and
   * moved the console away from the blueprint it was built to match.
   * `capture-pages.mjs` now checks the parts where the contract is, and the
   * rail and nested-scroller checks still run at both widths, because those
   * two are asked for at both.
   *
   * **The strip above the deck is one row, and that is what pays for the
   * picture.** `fold.1440.png` draws five compact readings there and no prose.
   * Ours carried the run state and the identity sentence as full-width `note`
   * cells too, 160 px of them, and with that above the deck the picture could
   * not grow by a single row before the shutter key left the 1440x900
   * viewport — measured, at 74 px over. The sentences are their own group
   * below the deck (`group-cam-facts`), where a line of prose costs the
   * picture nothing and R-CAM-05's sentence is still on the page.
   */
  it("keeps preview/Aim first and camera controls on the same surface", () => { const ordered=groupsOn(camera).sort((a,b)=>Number(a.order)-Number(b.order)); expect(ordered.slice(0,2).map(g=>g.id)).toEqual(['group-cam-picture','group-cam-aim']); expect(ordered.map(g=>g.id)).toContain('group-cam-controls'); expect(flows.find(n=>n.id==='group-cam-controls')).toMatchObject({visible:true}); });

  /**
   * The deck is what Live and Setup exchange, and the page starts on Live.
   *
   * A page that came up with both decks drawn would be twice the height it
   * should be, and one that came up on Setup would show an operator the
   * settings when they asked for the picture.
   */
  it("starts with one unified controls group and no alternative layout", () => { expect(flows.find(n=>n.id==='group-cam-controls')?.visible).toBe(true); expect(flows.some(n=>n.id==='group-cam-setup'||n.id==='group-cam-live')).toBe(false); });

  it("expands connection details without hiding preview, Aim or transaction controls", () => { const show=flows.find(n=>n.id==='cam-show-connection'); expect(JSON.parse((show?.rules as {to:string}[])[0].to)).toEqual({groups:{show:['group-cam-receive']}}); expect(flows.some(n=>n.id==='deck-live'||n.id==='deck-setup')).toBe(false); });

  /**
   * **One widget per deck, and no group left for a stock widget to be
   * dropped into** (spec §6, verbatim).
   *
   * The three legends this test used to check — *applies live*, *restarts
   * the picture*, *stored in config.yaml* — were three Dashboard groups
   * holding eleven stock controls between them, and the legend was the only
   * thing telling an operator which kind of control they were touching.
   * `YonderDeck` draws its own columns with their own legends and qualifiers
   * from the report, so the distinction is now made per control rather than
   * per group — and the groups themselves are gone, which is what stops the
   * next `ui-number-input` finding a home.
   */
  it("has one content-sized Deck instance, with no second draft-owning widget", () => { const decks=on(camera).filter(n=>n.type==='ui-yonder-deck'); expect(decks).toHaveLength(1); expect(decks[0]).toMatchObject({id:'deck-camera',height:0,className:'yonder-content-height'}); });

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
  it("feeds authoritative pending state into the persistent camera workspace", () => { expect(flows.find(n=>n.id==='poll-pending')?.wires?.flat()).toContain('cam-workspace-pending'); expect(flows.find(n=>n.id==='cam-workspace-pending')?.rules).toEqual([{t:'set',p:'workspaceKind',pt:'msg',to:'pending',tot:'str'}]); expect(flows.find(n=>n.id==='cam-workspace-pending')?.wires).toEqual([['camera-workspace']]); });

  /**
   * A dismiss and a timeout leave the same output as the confirm. Only one of
   * them is the operator saying they can still reach the device (R-CFG-03), so
   * only one of them may reach `yonder-confirm`.
   */
  it("camera Keep and Revert require explicit keys and fresh pending status", () => { const request=flows.find(n=>n.id==='cam-transaction-request'); expect(request?.wires).toEqual([['poll-pending']]); const route=flows.find(n=>n.id==='cam-transaction-route'); expect((route?.rules as {v:string}[]).map(r=>r.v)).toEqual(['camera-confirm','camera-revert']); expect(route?.wires).toEqual([['cam-transaction-confirm'],['cam-transaction-revert']]); });

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
    // exists only where an RTSP output does (R-UI-20).
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
      expect((flows.find((n) => n.id === id)?.wires as string[][])[0]).toEqual(["pic-camera", "pic-cockpit"]);
    }
  });

  /**
   * **The picture's own output must never come back to it.** `setMode` emits
   * `mode:<mode>` when the operator changes it, so a flow that looped that
   * back would be a picture commanding itself.
   */
  it("never lets the picture's own output come back to it as a command", () => {
    const picture = flows.find((n) => n.type === "ui-yonder-picture");
    const out = (picture?.wires as string[][]).flat();

    // It has an output now — the operator asked for a Start on the picture —
    // so "wired to nothing" is no longer the way to say this. What has to
    // stay true is the thing that rule was protecting: `setMode` emits
    // `mode:<mode>`, and a path that carried that back would be a picture
    // commanding itself. Everything but `start` is dropped, by a switch whose
    // `else` output goes nowhere at all.
    for (const id of out) {
      const router = flows.find((n) => n.id === id);
      expect(router?.type, `${id} takes the picture's output and is not a switch`).toBe("switch");
      const rules = (router?.rules as { t?: string; v?: string }[]) ?? [];
      const wires = (router?.wires as string[][]) ?? [];
      expect(rules).toHaveLength(wires.length);
      const otherwise = rules.findIndex((r) => r.t === "else");
      expect(otherwise, `${id} passes anything it does not recognise`).toBeGreaterThanOrEqual(0);
      expect(wires[otherwise], `${id}'s else output leads somewhere`).toEqual([]);
      for (const r of rules) {
        if (r.t !== "else") expect(["start", "path"]).toContain(r.v);
        if (r.v === "path") expect(wires[rules.indexOf(r)]).toEqual(["cam-pic-go"]);
      }
    }
  });

  /**
   * R-UI-20 and R-CTL-10 together, and both now answered by one payload.
   *
   * The facts row and the two sliders were the same defect in two shapes:
   * a capability list and a control range, each assembled by a `change`
   * node in this file from `payload.capabilities.<key>.value.min`. Every one
   * of those was a second place a capability could be wrong. `payload.deck`
   * is the whole report — capabilities, descriptors in display units, the
   * device's current readings and what was last commanded — composed once in
   * `video/present.ts` and moved here whole. **Nothing in this file names a
   * capability**, which is the assertion below, and the one that stops the
   * list drifting from the model again (R-CAM-14).
   */
  it("feeds one complete workspace snapshot without embedding capability logic in flows", () => { const pick=flows.find(n=>n.id==='pick-cam-deck'); expect(pick?.rules).toEqual([{t:'set',p:'payload',pt:'msg',to:'payload.deck',tot:'msg'},{t:'set',p:'workspaceKind',pt:'msg',to:'report',tot:'str'}]); expect(pick?.wires).toEqual([['camera-workspace']]); expect(flows.find(n=>n.id==='camera-workspace')?.wires).toEqual([['deck-camera']]); });

  /** A slider that echoed would post a control change on every read. */
  it("lets no input on either deck echo what arrived", () => {
    for (const n of on(camera).filter((w) => /ui-(slider|number-input|text-input)/.test(w.type))) {
      expect(n.passthru ?? false, `${String(n.id)} echoes`).toBe(false);
    }
  });

  /**
   * **The stream address: all four receivers, each with a means of copying
   * it** (R-VID-15, spec §3 — *"Receive line" is Stream address*).
   *
   * The page drew two of the four. `renderReceive()` has answered a GStreamer
   * command line, a ground station's own settings, an appsink pipeline and an
   * RTSP URL since M4, and the wiring picked the first and the last — so an
   * operator holding a Mission Planner or a QGroundControl, which are the two
   * the other two renderings exist for, found nothing on the page and had to
   * read a document. That is R-VID-10's world, which R-VID-15 exists to
   * replace.
   *
   * This is also the reason the capture gate checks every committed page for
   * the device's real credential: the RTSP line carries a resolved one.
   */
  it("shows all four receivers, each with a means of copying it", () => {
    const line = flows.find((n) => n.type === "yonder-stream-address");
    expect(line, "there is no stream address node").toBeDefined();
    expect((line?.wires as string[][])[0]).toEqual(["pick-cam-receive", "cam-workspace-result"]);

    const pick = flows.find((n) => n.id === "pick-cam-receive");
    const fed = (pick?.wires as string[][])[0];
    // One identity per rendering `renderReceive()` produces, keyed on the
    // property the pick node sets — so a rendering added there and not drawn
    // here is a widget bound to nothing, which renders an em dash for ever.
    // widget id · the payload property it binds · the rendering it must read.
    // `rtsp` and `url` differ on purpose: the surface's word for the line and
    // `renderReceive()`'s word for the rendering are not the same word, and
    // that mismatch is exactly where a rule can be pointed at the wrong one.
    for (const [id, key, kind] of [
      ["identity-cam-gstreamer", "gstreamer", "gstreamer"],
      ["identity-cam-dialog", "dialog", "dialog"],
      ["identity-cam-appsink", "appsink", "appsink"],
      ["identity-cam-rtsp", "rtsp", "url"],
    ]) {
      const widget = flows.find((n) => n.id === id);
      expect(widget?.type, `${id} is not an identity`).toBe("ui-yonder-identity");
      expect(widget?.key, `${id} reads the wrong property`).toBe(key);
      expect(fed, `${id} is never fed`).toContain(id);
      // **The source, not only the target.** Asserting that *something* sets
      // `payload.dialog` says nothing about what it is set to: pointing that
      // rule at the gstreamer body leaves this file green, leaves the shape
      // reference unmoved (the identity rows are a fixed height), and hands a
      // QGroundControl operator a GStreamer command line in the Ground
      // station box. The two note rules below were already exact; these four
      // were not.
      const rules = pick?.rules as { p: string; to: string; tot: string }[];
      const rule = rules.find((r) => r.p === `payload.${key}`);
      expect(rule?.to, `payload.${key} reads the wrong rendering`)
        .toBe(`payload.renderings[kind="${kind}"].body`);
      // A move, never a composition (CLAUDE.md rule 2).
      expect(rule?.tot).toBe("jsonata");
    }
  });

  /**
   * **R-UI-24: an output nothing can reach has its address marked unusable
   * rather than offered** — and the mark is on the page, not only in the
   * payload.
   *
   * The verdict and its sentence are `video/receive.ts`'s, from
   * `outputReach()`; what this holds is that the page actually draws them.
   * A `usable: false` nobody renders is R-UI-24 satisfied in a type and
   * failed in front of the operator, which is the shape K-32 had.
   *
   * Two cells and not four, because the three UDP renderings are three ways
   * of writing one output and share one verdict — three copies of one
   * sentence is three chances to disagree about one fact.
   */
  it("draws each address's verdict beside it, in the words yonder-core chose", () => {
    const bar = flows.find((n) => n.id === "bar-cam-reach");
    expect(bar?.type, "nothing draws whether an address can be used").toBe("ui-yonder-databar");
    expect(bar?.group).toBe("group-cam-receive");
    const cells = JSON.parse(String(bar?.cells)) as { key: string; kind?: string }[];
    expect(cells.map((c) => c.key)).toEqual(["pushNote", "listenNote"]);
    // A sentence, declared as one: a reading's cell is `white-space: nowrap`
    // and would take the strip off the side of the page (R-UI-25).
    for (const c of cells) expect(c.kind, `${c.key} is a sentence, not a reading`).toBe("note");

    const pick = flows.find((n) => n.id === "pick-cam-receive");
    expect((pick?.wires as string[][])[0]).toContain("bar-cam-reach");
    // **The daemon's own note, moved and never composed here.** A JSONata
    // expression joining "unusable" to a reason beside a wire coordinate is
    // CLAUDE.md rule 2, so `receive.ts` puts the word in the sentence and
    // this file only carries it.
    const rules = pick?.rules as { p: string; to: string }[];
    for (const [p, to] of [
      ["payload.pushNote", 'payload.renderings[kind="gstreamer"].note'],
      ["payload.listenNote", 'payload.renderings[kind="url"].note'],
    ]) {
      expect(rules.find((r) => r.p === p)?.to, `${p} is not a move`).toBe(to);
    }
  });

  /**
   * **No camera's *name* is written into this file either** (R-UI-27).
   *
   * The companion to "names no camera in the wiring" below, which closed the
   * same hole for a camera's *id*. The picture carried `"label": "Front
   * camera"` — the capture fixture's name, frozen at deploy time — so a board
   * whose camera the operator has called anything else had a page labelled
   * with somebody else's camera. R-UI-27 makes the name the operator's; a
   * name in this file is a name they cannot change.
   *
   * The name reaches the page the way every other fact about the camera does:
   * composed in `video/present.ts` from the configuration, read whole.
   */
  it("writes no camera's name into the wiring, and draws the one it is sent", () => {
    expect(flows.find((n) => n.id === "pic-camera")?.label,
      "the picture is labelled with a camera name this file typed in").toBe("");
    const bar = flows.find((n) => n.id === "bar-camera");
    const cells = JSON.parse(String(bar?.cells)) as { key: string }[];
    expect(cells.map((c) => c.key), "the readout strip never names its camera")
      .toContain("name");
    // From the same composed payload as the rest of the strip, so it can
    // never be a value this file typed in.
    expect((flows.find((n) => n.id === "pick-cam-strip")?.wires as string[][])[0])
      .toContain("bar-camera");
  });

  /**
   * **R-UI-03, per camera: the page the index opens is the page navigation
   * shows, and it exists.**
   *
   * Dashboard 2 cannot create a page at run time — `ui-control` sets a page's
   * `visible` and `disabled` and nothing else, and `ui_base.js` merges only
   * that state into what it sends the browser — so "one page per detected
   * camera" is served by the camera pages this file carries, shown and hidden
   * from the sweep. That makes the join between them load-bearing and, until
   * this test, unwatched: `cameras-show-page` names a page by **id**,
   * `cam-open` navigates to one by **name**, and neither was resolved against
   * the pages that exist. A page renamed in the editor leaves `ui-control`
   * logging *No page with the name 'Camera' found* and the OPEN key doing
   * nothing at all — at run time, on a board, with every test green.
   *
   * The last clause is what makes a second camera page a data change: a
   * camera page nothing shows, or nothing hides, fails here.
   */
  it("shows and opens the same camera page, and leaves none of them unreachable", () => {
    const pages = new Map(flows.filter((n) => n.type === "ui-page").map((p) => [p.id, p]));
    const listed = (id: string, which: "show" | "hide"): string[] => {
      const to = (flows.find((n) => n.id === id)?.rules as { to: string }[])[0].to;
      return (JSON.parse(to) as { pages: Record<string, string[]> }).pages[which] ?? [];
    };
    const shown = listed("cameras-show-page", "show");
    const hidden = listed("cameras-hide-page", "hide");
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.slice().sort()).toEqual(hidden.slice().sort());
    for (const id of shown) {
      expect(pages.has(id), `navigation names ${id}, which is not a page`).toBe(true);
    }
    // Every camera page in the file is in that set. One that is not would be
    // a section for a camera that is not there — R-UI-03 exactly backwards.
    const cameraPages = [...pages.values()].filter((p) => p.id !== "page-cameras"
      && groupsOn(p).some((g) => String(g.id).startsWith("group-cam-")));
    expect(cameraPages.length).toBeGreaterThan(0);
    for (const p of cameraPages) {
      expect(shown, `${String(p.name)} is a camera page nothing shows`).toContain(p.id);
    }
    // And the index opens one of them, by the name that page actually has.
    const open = (flows.find((n) => n.id === "cam-open")?.rules as { p: string; to: string }[])
      .find((r) => r.p === "payload");
    const named = (JSON.parse(String(open?.to)) as { page: string }).page;
    const target = [...pages.values()].find((p) => p.name === named);
    expect(target, `OPEN navigates to "${named}", which no page is called`).toBeDefined();
    expect(shown, "the index opens a page navigation never shows").toContain(target?.id);
  });

  /**
   * R-CAM-10: why Start would be refused, before it is pressed — and now
   * **directly above the key it is about**.
   *
   * It used to be a `ui-text` in the readout group, four groups away from
   * START and 121 px of sentence in a 48 px box, which the capture gate
   * measured as 60% of it hidden. It is a data-bar cell on the Live rail
   * instead: the strip's own `note` kind, which wraps a sentence onto a line
   * of its own rather than asking a reading to shrink (R-UI-25), and the
   * rail is the one group that is on screen whenever START is.
   *
   * A row labelled "cannot start" with nothing after it would read as *this
   * camera cannot start*, which is the opposite of what a null refusal
   * means — so the caption is checked as well as the value.
   */
  it("keeps the start refusal visible in the camera controls", () => { expect(flows.find(n=>n.id==='bar-cam-start')).toMatchObject({group:'group-cam-controls',height:0}); expect(flows.find(n=>n.id==='camera-read')?.wires?.flat()).toContain('pick-cam-start'); });

  /**
   * **The picture's own Start, and why R-UI-10 still holds around it.**
   *
   * Starting a camera meant scrolling past the whole deck to the rail at the
   * foot of the page, with nothing above saying that was where to go. The
   * operator asked for it where they are already looking, and decided that
   * the empty picture is the place — so `ui-yonder-picture` now draws one
   * key, and it is the only action on this page that is not on the rail.
   *
   * It is not a second way of starting a camera: it sends the same `start`
   * the rail's own key sends, through a switch that reaches the same
   * `cam-at-stream`. The rule below still counts Dashboard widgets, and a key
   * drawn inside the picture is not one — so this test is what says the
   * exception exists deliberately, rather than leaving it to look like a gap.
   */
  it("keeps the picture Start and workspace Stop on the existing stream adapter", () => { expect(flows.find(n=>n.id==='cam-pic-act')?.wires?.[0]).toEqual(['cam-at-stream']); expect(flows.find(n=>n.id==='cam-video-msg')?.wires).toEqual([['cam-at-stream']]); });

  /**
   * The picture cannot offer to start a camera it has not been told is
   * stopped, so the message that names the camera carries that too.
   */
  it("tells the picture whether its camera is running", () => {
    const pick = flows.find((n) => n.id === "pick-cam-picture");
    // The daemon composes run state, aim and recorder together; wiring projects the value.
    expect(pick?.rules).toEqual([{ t: "set", p: "payload", pt: "msg", to: "payload.picture", tot: "msg" }]);
  });

  /** R-UI-10: every action on this page is on the rail, and only there. */
  it("keeps primary actions in the camera workspace and bounded preview controls", () => { expect(flows.find(n=>n.id==='deck-camera')?.wires).toEqual([['cam-deck-route']]); expect(flows.find(n=>n.id==='hold-cam-fullrate')?.group).toBe('group-cam-picture'); expect(flows.some(n=>n.id==='keys-cam-live'||n.id==='keys-cam-setup')).toBe(false); });

  /**
   * And each rail carries only what can be done from the deck it belongs to —
   * **and every key it sends is answered by the switch behind it.**
   *
   * The two halves were renamed in one commit and nothing held them together:
   * `keys-cam-setup`'s third key became `address` and `cam-setup-keys`'s third
   * rule became `address`, and setting either back leaves the whole suite
   * green. The switch was `checkall: "false"` with no `else`, so a mismatch
   * dropped the press in silence — a soft key that does nothing at all, on a
   * board, with the capture gate blind to it because the gate presses deck
   * keys and `NIGHT` and reaches Setup by a different route.
   *
   * So the actions and the rule values are compared to each other rather than
   * each to a list written twice, and the `else` every rail's switch now has
   * is asserted to reach the node that says so out loud (R-UI-05: an operator
   * must be able to tell "nothing happened" from "this did nothing").
   */
  it("routes every camera workspace action to a real consumer", () => { const route=flows.find(n=>n.id==='cam-deck-route')!; const rules=route.rules as {v:string}[]; expect(rules.map(r=>r.v)).toEqual(['nativeControl','control','apply','shutter','captures','transaction','video','refresh','connection']); expect(route.wires).toHaveLength(rules.length); for(const targets of route.wires!) expect(targets.length).toBeGreaterThan(0); });

  /**
   * A key that reached `yonder-stream` with anything but start or stop would
   * spend a round trip to be told so, and the operator would read the daemon's
   * refusal about the deck key they pressed.
   */
  it("has no layout mode command in the stream path", () => { expect(flows.find(n=>n.id==='cam-video-msg')?.rules).toEqual([{t:'set',p:'payload',pt:'msg',to:'payload.video',tot:'msg'}]); expect(flows.find(n=>n.id==='cam-pic-act')?.rules).toEqual([{t:'eq',v:'start',vt:'str'},{t:'hask',v:'path',vt:'str'},{t:'else'}]); });

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
      (n) => ["yonder-camera", "yonder-stream", "yonder-stream-address"].includes(n.type),
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

  /**
   * **The camera a row was pressed on is the camera the page then reads.**
   *
   * `ui-yonder-index` posts `{ camera: id }`, correctly. The flow behind it
   * discarded that id and set the page alone, and `flow.camera` — which every
   * `cam-at-*` node reads — was written in exactly one place, to the *first*
   * configured camera in the sweep. So on a two-camera board both rows' OPEN
   * keys opened camera one, and the development board has one camera, so it
   * would have shipped invisible.
   *
   * Two halves, and both are needed: `cam-open` has to record the choice, and
   * the sweep that runs every few seconds afterwards must not overwrite it.
   */
  /**
   * **The dead end, wired shut.**
   *
   * The operator plugged a second camera into a running board. Its row was
   * drawn, marked *Not configured*, its OPEN key inert — correctly, since a
   * camera with no configuration entry has no page — and nothing anywhere
   * could give it one. He found that by using the console; no review could,
   * because a review reads a diff and nothing in a diff is missing.
   */
  it("routes an ADD press to the one request that configures a camera", () => {
    const route = flows.find((n) => n.id === "cam-index-route");
    expect(route?.type).toBe("switch");
    expect(route?.property, "routed on the press, not on a page name").toBe("payload.adopt");
    // First output is the adoption; it must reach a node that talks to the
    // daemon, not another page switch.
    const adoptTarget = (route?.wires as string[][])[0]?.[0];
    const adopt = flows.find((n) => n.id === adoptTarget);
    expect(adopt?.type, "an adoption reaches the camera adapter").toBe("yonder-cameras");
    // And afterwards the list is read again, or the row keeps the null id it
    // was drawn with and the operator presses ADD twice.
    const after = flows.find((n) => n.id === (adopt?.wires as string[][])[0]?.[0]);
    expect(String(after?.name)).toContain("sweep again");
    expect((after?.wires as string[][])[0]).toEqual(["cameras-read"]);
  });

  /**
   * **The other half of the state the operator found a board in** (R-CAM-21).
   *
   * A camera had been moved between USB ports. Identity is the socket
   * (R-CAM-05), so each move made it a different camera and left the previous
   * entry behind — two configured cameras against ports with nothing in them,
   * and no way to clear either short of editing `config.yaml` over SSH.
   *
   * **`cam-index-route` cannot carry this on its own.** A `switch` tests one
   * property, and its property is `payload.adopt`, which is empty for an OPEN
   * press and empty for a removal alike — so its `else` output is where both
   * of them arrive and there is nothing left there to tell them apart. Hence
   * a second switch rather than a third rule, and the rule/output check below
   * is the one this repository has already shipped a defect against (7103700:
   * a switch with two outputs and one rule, so OPEN reached nothing).
   */
  it("routes a removal press to the one request that takes a camera out of the configuration", () => {
    const route = flows.find((n) => n.id === "cam-forget-route");
    expect(route?.type).toBe("switch");
    expect(route?.property, "routed on the press, not on a page name").toBe("payload.forget");
    const rules = route?.rules as { t: string }[];
    const wires = route?.wires as string[][];
    expect(rules.length, "one rule per output, or an output is unreachable").toBe(wires.length);
    expect(rules.at(-1)?.t, "the fall-through is a real rule").toBe("else");
    // It is reached from the index's own switch, not wired to the widget in
    // parallel — a widget has one output and both presses leave through it.
    expect((flows.find((n) => n.id === "cam-index-route")?.wires as string[][])[1])
      .toEqual(["cam-forget-route"]);
    const forget = flows.find((n) => n.id === wires[0]?.[0]);
    expect(forget?.type, "a removal reaches the camera adapter").toBe("yonder-cameras");
    // And afterwards the list is read again, or the row the operator just
    // removed stays on the page until the next poll.
    const after = flows.find((n) => n.id === (forget?.wires as string[][])[0]?.[0]);
    expect(String(after?.name)).toContain("sweep again");
    expect((after?.wires as string[][])[0]).toEqual(["cameras-read"]);
  });

  it("opens the camera whose row was pressed, and keeps it open", () => {
    const open = flows.find((n) => n.id === "cam-open");
    const rules = open?.rules as { p: string; pt: string; to: string; tot: string }[];
    // The choice is recorded before the page is set, and it comes off the
    // press rather than out of a list.
    expect(rules.find((r) => r.p === "camera")).toEqual({
      t: "set", p: "camera", pt: "flow", to: "payload.camera", tot: "jsonata",
    });
    const page = rules.at(-1);
    expect(page?.p).toBe("payload");
    expect(JSON.parse(String(page?.to))).toEqual({ page: "Camera" });
    // **A press is routed before it is acted on**, because a row now sends
    // two different things: `camera` to open one, `adopt` to configure one the
    // board found and nothing is configured for. The index reaches `cam-open`
    // through that switch rather than directly.
    expect((flows.find((n) => n.type === "ui-yonder-index")?.wires as string[][])[0])
      .toEqual(["cam-index-route"]);
    const route = flows.find((n) => n.id === "cam-index-route");
    expect(route?.property).toBe("payload.adopt");
    // **A switch's second output exists only if a second rule feeds it.**
    // Shipped once without the `else` and OPEN silently did nothing: the press
    // matched no rule, so it went nowhere, and every test here passed because
    // they all read wires rather than rules. The operator found it in a
    // browser within minutes.
    const routeRules = route?.rules as { t: string }[];
    expect(routeRules.length, "one rule per output, or an output is unreachable")
      .toBe((route?.wires as string[][]).length);
    expect(routeRules.at(-1)?.t, "the fall-through is a real rule").toBe("else");
    // **A press now falls through two switches, not one**, because a row
    // sends three different things and a `switch` tests one property. What
    // matters is that the last fall-through still lands on `cam-open`: an
    // OPEN press must reach the node that records the choice however many
    // hops are added in front of it. Walked rather than named, so a fourth
    // press inserted later cannot quietly leave OPEN going nowhere.
    let hop = flows.find((n) => n.id === (route?.wires as string[][])[1]?.[0]);
    while (hop?.type === "switch") {
      const rules = hop.rules as { t: string }[];
      const wires = hop.wires as string[][];
      expect(rules.length, `one rule per output on ${String(hop.id)}, or an output is unreachable`)
        .toBe(wires.length);
      expect(rules.at(-1)?.t, `${String(hop.id)}'s fall-through is a real rule`).toBe("else");
      hop = flows.find((n) => n.id === wires.at(-1)?.[0]);
    }
    expect(hop?.id, "OPEN still reaches the node that records the choice").toBe("cam-open");

    // And the sweep seeds the id only when there is nothing chosen, or when
    // what was chosen is no longer attached. Without this, the next poll puts
    // the operator back on camera one a few seconds after they left it.
    const identify = String((flows.find((n) => n.id === "cam-identify")
      ?.rules as { to: string }[])[0]?.to);
    expect(identify).toContain('$flowContext("camera")');
    expect(identify).toContain("payload.found[id != null].id");
    // **And a sweep that failed leaves the choice alone.** `yonder-cameras`
    // emits `payload: null` when the daemon does not answer, and without this
    // guard the expression evaluated to nothing and deleted `flow.camera` —
    // every widget on the camera page then asking about no camera at all. A
    // read that failed is not evidence that anything was unplugged.
    expect(identify).toContain("$exists(payload.found)");

    // A refusal belongs to one camera. Opening another clears the stash the
    // flow keeps, rather than leaving it to be drawn against the next
    // camera's matching staged path.
    const cleared = JSON.stringify(open?.rules);
    expect(cleared).not.toContain('"p":"camproblems"'); // workspace model owns camera-scoped issues
  });

  /**
   * **A refused apply is its own answer.**
   *
   * Every non-pending answer used to land on `toast-cam-kept`, the node named
   * "applied, and kept", and the `problems` the route answers with reached no
   * surface at all. The route half was right and proven; the browser threw
   * the draft away before the refusal arrived, so there was no field left to
   * mark. Now: a third branch, its own toast, and the problems into flow
   * context where `pick-cam-deck` puts them on the deck's payload.
   */
  it("routes camera results to the package-backed inline workspace", () => { expect(flows.find(n=>n.id==='camera-settings')?.wires?.flat()).toContain('cam-workspace-result'); expect(flows.find(n=>n.id==='cam-workspace-result')?.wires).toEqual([['camera-workspace']]); expect(flows.some(n=>n.id==='toast-cam-refused')).toBe(false); });

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
    expect((from?.wires as string[][])[0]).toEqual(["pic-camera", "pic-cockpit"]);
    expect(from?.rules).toEqual([{ t: "set", p: "payload", pt: "msg", to: "payload.picture", tot: "msg" }]);
    expect((flows.find((n) => n.id === "camera-read")?.wires as string[][])[0])
      .toContain("pick-cam-picture");
  });

  /**
   * **R-UI-26: an action lives beside the thing it acts on.**
   *
   * The rail carries the page's own actions — start, stop, the deck flip,
   * re-probe, the stream address, the full-rate hold. Record and Recentre are
   * not among them and must not become so: Record belongs under the picture
   * it is recording, in the deck's own Capture column, and Recentre belongs
   * on the Aim panel beside the gimbal it moves. On a rail they would be two
   * keys an operator has to look away from the picture to find, at the exact
   * moment they are watching it.
   *
   * Checked over the rails' declared keys, which is where a key would have to
   * be added for it to appear — `YonderShutter` and the Aim panel's own
   * Recentre are drawn by their components and reach no rail at all.
   */
  it("keeps recording in camera controls and recentre in standalone Aim", () => { expect(flows.find(n=>n.id==='deck-camera')?.type).toBe('ui-yonder-deck'); expect(flows.find(n=>n.id==='aim-camera')?.type).toBe('ui-yonder-aim'); expect(flows.some(n=>n.id==='keys-cam-live'||n.id==='keys-cam-setup')).toBe(false); });

  /**
   * **Every press the deck makes has somewhere to go.**
   *
   * `YonderDeck` posts seven different shapes — an image control, an apply, a
   * discard, an output switch, the shutter, the captures link and a deck flip
   * — and Dashboard delivers all of them down one wire. A route that
   * recognised six would leave the seventh silently doing nothing, which is
   * exactly the failure `emitsActions` produces one layer up and is just as
   * invisible.
   *
   * **It did.** The deck has posted `{ shutter: … }` since it was built and
   * this switch had rules for four other keys, so pressing RECORD or PHOTO on
   * the camera page did nothing at all, in silence, for as long as the key has
   * been drawn. That is the defect Task 33b was named for, and it is the
   * second time in this file: `7103700` is the identical shape one page along,
   * where OPEN reached nothing because a switch had more outputs than rules.
   *
   * `discard` is deliberately not routed: it is the browser dropping its own
   * draft and reaches the daemon by design (`YonderDeck.discard()` clears the
   * store before it posts). The aim events are Task 38's; they are named here
   * as unrouted so that adding a route is a change to this list rather than a
   * discovery.
   */
  it("routes immediate camera controls and deliberate Apply separately", () => { const route=flows.find(n=>n.id==='cam-deck-route')!; const rules=route.rules as {v:string}[]; expect(route.wires?.[rules.findIndex(r=>r.v==='nativeControl')]).toEqual(['cam-native-control-msg']); expect(route.wires?.[rules.findIndex(r=>r.v==='control')]).toEqual(['cam-control-msg']); expect(route.wires?.[rules.findIndex(r=>r.v==='apply')]).toEqual(['cam-apply-msg']); expect(rules.some(r=>r.v==='output'||r.v==='mode')).toBe(false); expect(flows.find(n=>n.id==='cam-apply-msg')?.wires).toEqual([['cam-at-settings']]); });

  /**
   * **A shutter press reaches the node that works the shutter** (R-CAM-17,
   * R-CAM-18).
   *
   * The route above proves the message leaves the switch; this proves where
   * it lands, and the two together are the whole of the defect. A press that
   * reached a `change` node and stopped there would satisfy the first and do
   * nothing, which is what it did.
   *
   * **The mapping is the node's, not a rule's** (CLAUDE.md rule 2). What
   * `shutter: "record"` means as an HTTP route is decided in
   * `node-red-contrib-yonder-video/src/captures.ts`, where it has source and
   * tests; a `change` node composing `{"action":"start"}` in JSONata beside a
   * wire coordinate would be that decision serialised into an artefact nobody
   * can review a diff of. So this asserts the press reaches the node
   * *carrying its own payload* — nothing between the deck and the daemon
   * rewrites it.
   */
  it("carries a shutter press to the captures node, unrewritten", () => {
    const at = flows.find((n) => n.id === "cam-at-captures-act");
    expect(at?.type).toBe("change");
    // Addressing only: which camera this is about. Nothing composes a body.
    expect(at?.rules).toEqual([{ t: "set", p: "camera", pt: "msg", to: "camera", tot: "flow" }]);
    const target = (at?.wires as string[][])[0]?.[0];
    const node = flows.find((n) => n.id === target);
    expect(node?.type, "a shutter press reaches the capture node").toBe("yonder-captures");

    // And its answer goes three places: the annunciator, the still's own
    // confirmation over the picture, and a fresh read of the camera — which
    // is what redraws the key, the count beside it and the panel below.
    expect((node?.wires as string[][])[0])
      .toEqual(["cam-workspace-result", "cam-saved-gate", "cam-at-read"]);
  });

  /**
   * **The captures panel is fed by the same read as everything else.**
   *
   * A panel fetched on its own could show a listing composed a poll apart
   * from the `Captures (n)` link beside the shutter key — two answers to one
   * question, on one screen. `yonder-core` composes both from one directory
   * read; the flow only selects.
   */
  it("draws the captures panel from the camera read, and routes its one press", () => {
    expect((flows.find((n) => n.id === "camera-read")?.wires as string[][])[0])
      .toContain("pick-cam-captures");
    const pick = flows.find((n) => n.id === "pick-cam-captures");
    // Selection, not composition: the shape is the daemon's own.
    expect(pick?.rules).toEqual([
      { t: "set", p: "payload", pt: "msg", to: "payload.captures", tot: "msg" },
    ]);
    expect((pick?.wires as string[][])[0]).toEqual(["caps-camera"]);
    const panel = flows.find((n) => n.id === "caps-camera");
    expect(panel?.type).toBe("ui-yonder-captures");

    // A delete is the one thing the panel sends, and it is routed rather than
    // wired straight through — with an `else` that says so, because a press
    // matching no rule is a press that does nothing in silence.
    const route = flows.find((n) => n.id === "cam-caps-route");
    expect((panel?.wires as string[][])[0]).toEqual(["cam-caps-route"]);
    const rules = route?.rules as { t: string; v?: string }[];
    expect(rules.map((r) => r.v)).toEqual(["remove", undefined]);
    expect(rules.at(-1)?.t, "the fall-through is a real rule").toBe("else");
    expect(rules.length, "one rule per output, or an output is unreachable")
      .toBe((route?.wires as string[][]).length);
    expect((route?.wires as string[][])[0]).toEqual(["cam-at-captures-act"]);
  });

  /**
   * **Only a still that landed flashes the picture** (blueprint L-18).
   *
   * The one node behind the shutter answers three different things — a
   * recorder state, a capture, and a bare name from a delete — and a banner
   * reading *Saved · to this board* over a delete would be a lie about both.
   * `held` is the field only a capture carries, and the gate is a switch
   * rather than a sentence read back out of a payload.
   */
  it("confirms a still over the picture, and nothing else", () => {
    const gate = flows.find((n) => n.id === "cam-saved-gate");
    expect(gate?.type).toBe("switch");
    expect(gate?.property).toBe("payload");
    expect(gate?.rules).toEqual([{ t: "hask", v: "held", vt: "str" }]);
    expect((gate?.rules as unknown[]).length).toBe((gate?.wires as string[][]).length);

    const saved = flows.find((n) => n.id === (gate?.wires as string[][])[0]?.[0]);
    // Copies, and no expression: the words for where it went are
    // `heldWords()`'s, in the component that draws them.
    expect(JSON.stringify(saved?.rules)).not.toContain("jsonata");
    expect((saved?.wires as string[][])[0]).toEqual(["pic-camera", "pic-cockpit"]);
  });

  /**
   * **The REC pill has a source** (blueprint L-16).
   *
   * It has been drawn since Task 19 and fed by nothing. The elapsed time is
   * counted in the component from the recorder's own `since`, so what travels
   * here is the recorder's state and not a formatted string — a five-second
   * poll formatting a stopwatch would produce a clock that ticks in fives.
   */
  it("gives the picture the recorder's own state to count from", () => {
    const pick = flows.find((n) => n.id === "pick-cam-picture");
    const rules = pick?.rules as { p: string; to: string; tot: string }[];
    expect(rules).toEqual([{ t: "set", p: "payload", pt: "msg", to: "payload.picture", tot: "msg" }]);
    // The route test proves picture.recording is the recorder observation verbatim.
  });
});

/**
 * The Telemetry page, against the artefact (R-MAV-10, R-DIA-04, R-UI-17).
 *
 * The page itself was settled by building it and looking at it; what this
 * describes is the cutover underneath it — thirty-two static payloads
 * replaced by four adapters over the daemon socket. Every assertion here is
 * about a *wire*, because that is all this file may contain: the decisions
 * are in `node-red-contrib-yonder-mavlink`, where they have source and tests
 * of their own.
 */
describe("flows/flows.json Telemetry page", () => {
  const byId = (id: string) => flows.find((n) => n.id === id);
  const wiresOf = (id: string) => ((byId(id)?.wires ?? []) as string[][]);
  /** Everything wired downstream of a node, however many hops away. */
  const reaches = (from: string): Set<string> => {
    const seen = new Set<string>();
    const queue = [from];
    while (queue.length > 0) {
      const id = queue.shift() as string;
      for (const target of wiresOf(id).flat()) {
        if (seen.has(target)) continue;
        seen.add(target);
        queue.push(target);
      }
    }
    return seen;
  };

  /**
   * Every widget on the page, and where its value has to have come from.
   *
   * `label-*` are the four captions beside the annunciators: an
   * `ui-yonder-annunciator` carries no label of its own, so the word beside
   * it is a `ui-text` whose *value* is deliberately empty — it has nothing to
   * read from the device and still needs a message to render its label.
   */
  const FROM_STATE = [
    "tel-ann-link", "tel-port", "tel-speed", "tel-vehicle", "tel-hb", "tel-heard",
    "tel-ann-recv", "tel-answered", "tel-gcs-0", "tel-gcs-1", "tel-gcs-2",
    "tel-spark", "tel-ann-state", "stat-ann-feed", "stat-flow",
  ];
  const FROM_CONFIG = [
    "tel-atboot", "tel-ingest",
    "tel-host-0", "tel-port-0", "tel-host-1", "tel-port-1", "tel-host-2", "tel-port-2",
  ];
  const COMPOSITE = ["tel-tcp", "stat-tel-bar"];
  const FROM_CHECK = ["tel-chain-1", "tel-chain-2", "tel-chain-3"];

  it("reads the link from the daemon, and nothing on the page invents one", () => {
    const measured = reaches("tel-state");
    for (const widget of [...FROM_STATE, ...COMPOSITE]) {
      expect(measured.has(widget), `${widget} is not downstream of yonder-mav-state`).toBe(true);
    }
    expect(byId("tel-state")?.type).toBe("yonder-mav-state");
  });

  it("seeds every box from the configuration the console already read (R-UI-17)", () => {
    expect(byId("seed-tel-endpoints")?.type).toBe("yonder-mav-endpoints");
    // One read of `/config` for both forms on this console. A second reader
    // on its own schedule is what would overwrite a half-typed host box.
    expect(wiresOf("read-config").flat()).toContain("seed-tel-endpoints");
    const seeded = reaches("seed-tel-endpoints");
    for (const widget of FROM_CONFIG) {
      expect(seeded.has(widget), `${widget} is not downstream of yonder-mav-endpoints`).toBe(true);
    }
    // Seven outputs, in the order the node documents them: the rail's facts,
    // then host and port for each of the three rows. A pair crossed here puts
    // a port in a host box on a real device and nothing else would say so.
    const outputs = wiresOf("seed-tel-endpoints");
    expect(outputs).toHaveLength(7);
    expect(outputs.slice(1).map((o) => o[0]))
      .toEqual(["tel-host-0", "tel-port-0", "tel-host-1", "tel-port-1", "tel-host-2", "tel-port-2"]);
  });

  /**
   * **Two readouts have no single source, and this is the wiring that joins
   * them.**
   *
   * `tel-tcp` is the TCP server's port — configuration — beside how many
   * clients are on it — a measurement. `stat-tel-bar` is two settings beside
   * two measurements. `/mav/state` carries neither setting and `config.yaml`
   * carries neither measurement, so no node could have sent either payload
   * whole: the configured half is put in flow context when the console opens
   * and the measured half arrives on every poll.
   */
  it("joins the two readouts that are half configured and half measured", () => {
    const remember = byId("remember-tel-facts");
    const rules = (remember?.rules ?? []) as { p: string; pt: string }[];
    expect(rules.map((r) => `${r.pt}.${r.p}`))
      .toEqual(["flow.telAtBoot", "flow.telIngest", "flow.telTcpAddress"]);
    expect(reaches("seed-tel-endpoints").has("remember-tel-facts")).toBe(true);

    for (const join of ["join-tel-tcp", "join-stat-tel-bar"]) {
      const node = byId(join);
      expect(node?.type, join).toBe("change");
      expect(JSON.stringify(node), join).toMatch(/\$flowContext/);
      expect(reaches("tel-state").has(join), `${join} never sees a measurement`).toBe(true);
    }
    // Only ever what those three names hold. Caching the configuration
    // itself in flow context is the defect the top-level test forbids: a
    // change node reads and writes context by reference, so the cache and
    // the document being applied become one object.
    expect(JSON.stringify(byId("join-tel-tcp"))).toMatch(/telTcpAddress/);
    expect(JSON.stringify(byId("join-stat-tel-bar"))).toMatch(/telAtBoot/);
  });

  /**
   * R-MAV-09's one control, and the reply it acts on.
   *
   * `toggle` — a button carrying no payload of its own, so the node reads the
   * current state and acts on the opposite of `telemetryRunning`. Its answer
   * is the same `MavlinkStateBody` the poll reads, so it feeds the same
   * widgets: the page turns over on the reply instead of on the next poll.
   */
  it("wires the one Stop/Start control, and lets its answer redraw the page", () => {
    expect(wiresOf("tel-runstop").flat()).toEqual(["run-telemetry"]);
    const run = byId("run-telemetry");
    expect(run?.type).toBe("yonder-mav-run");
    expect(run?.action).toBe("toggle");
    expect(wiresOf("run-telemetry")).toEqual(wiresOf("tel-state"));
  });

  it("wires Check the path to the chain, and draws all three links (R-DIA-04)", () => {
    expect(wiresOf("tel-check").flat()).toEqual(["check-path"]);
    expect(byId("check-path")?.type).toBe("yonder-mav-check");
    const checked = reaches("check-path");
    for (const row of FROM_CHECK) {
      expect(checked.has(row), `${row} is not downstream of yonder-mav-check`).toBe(true);
    }
  });

  /**
   * R-MAV-07 and R-UI-15 together. Where MAVLink is accepted from is
   * configuration and is **not** exempt from the confirmation window, so
   * pressing either key applies a whole document and the change pends — which
   * is why nothing here confirms anything: the banner every surface already
   * carries is what offers that.
   */
  it("routes the ingest keys through a switch, and applies the whole document", () => {
    expect(wiresOf("tel-keys-ingest").flat()).toEqual(["route-tel-ingest"]);
    const route = byId("route-tel-ingest");
    expect(route?.type).toBe("switch");
    const offered = (JSON.parse(String(byId("tel-keys-ingest")?.keys ?? "[]")) as { action: string }[])
      .map((k) => k.action);
    const routed = ((route?.rules ?? []) as { v: string }[]).map((r) => r.v);
    expect(routed, "a key the rail offers that the switch does not route is a dead control")
      .toEqual(offered);
    // Every branch ends at the apply, and the apply posts a whole document —
    // `yonder-apply` is the node that starts the confirmation clock, and a
    // fragment is not something the daemon will validate.
    for (const branch of wiresOf("route-tel-ingest").flat()) {
      expect(reaches(branch).has("apply-tel-ingest"), `${branch} never reaches the apply`).toBe(true);
    }
    expect(byId("apply-tel-ingest")?.type).toBe("yonder-apply");
    expect(reaches("apply-tel-ingest").has("join-toast")).toBe(true);
  });

  /**
   * **R-MAV-07's rail says which way it is set, and the capture can see it.**
   *
   * `ui-yonder-softkeys` lights whichever key its own configuration marks
   * `active` unless a message carries a list — and that configuration lights
   * `THIS DEVICE` always, which is right for the shipped default and a lie
   * the moment ingest is opened. The seed node computes the list off the same
   * field as the words above it, and this is the wire that delivers it.
   *
   * `yonder-fixed` on the two settings is the other half. Both are
   * configuration, not readings, so their text is the same on every run — and
   * without it the committed picture of the ingest-open state came out
   * byte-identical to the base one, because the only thing that differs
   * between them is inside a masked `.nrdb-ui-text-value`. A state captured
   * under its own name that asserts nothing is worse than not capturing it.
   */
  it("tells the ingest rail which way the device is actually set", () => {
    expect(wiresOf("seed-tel-endpoints")[0]).toContain("tel-keys-ingest");
    for (const id of ["tel-atboot", "tel-ingest"]) {
      expect(String(byId(id)?.className), id).toContain("yonder-fixed");
    }
  });

  it("polls the link no faster than the floor, and only from one place", () => {
    const poll = byId("tel-poll");
    expect(poll?.type).toBe("inject");
    expect(Number(poll?.repeat) * 1000).toBeGreaterThanOrEqual(MIN_POLL_MS);
    expect(wiresOf("tel-poll").flat()).toContain("tel-state");
    // Nothing else asks the daemon for the link state on a timer.
    const askers = flows.filter((n) => n.type === "yonder-mav-state").map((n) => n.id);
    expect(askers).toEqual(["tel-state"]);
  });

  it("ships no function node", () => {
    const wiring = [
      ...FROM_STATE, ...FROM_CONFIG, ...COMPOSITE, ...FROM_CHECK,
      ...reaches("tel-poll"), ...reaches("tel-keys-ingest"),
      ...reaches("tel-runstop"), ...reaches("tel-check"),
    ];
    for (const id of new Set(wiring)) {
      expect(byId(id)?.type, id).not.toBe("function");
    }
  });
});


/**
 * **What the console shows of the configuration follows the configuration**
 * (R-UI-20).
 *
 * The defect: every value on this console that comes from `config.yaml` was
 * read once — an `inject` with `once: true` and an empty `repeat` — and never
 * again, while every other poller on the page repeated. So a saved change did
 * not reach the screen until somebody redeployed the flows.
 *
 * It was found on *Accepting from*, the readout saying whether the board
 * takes MAVLink from anything that can reach it or only from itself
 * (R-MAV-07). A run opened ingest, the daemon took the change, and the page
 * went on reading `Loopback only` with `THIS DEVICE` lit — so the committed
 * reference for that state was a picture of the opposite state. K-25 recorded
 * the same fault on a theme dropdown, where being wrong is untidy; this is it
 * on the control that decides who may command the aircraft.
 *
 * **The fix is not a `repeat` on the inject, and that matters.** Ten
 * `ui-text-input` boxes hang off the same read. Re-seeding them on a clock
 * would overwrite a half-typed ground-station address or APN, which is why
 * the one-shot was chosen and is a real constraint rather than an oversight.
 * `yonder-config-watch` reads on a timer and *sends only when the document
 * changed*, so the read repeats and the re-seed does not.
 */
describe("flows/flows.json reads the configuration again", () => {
  const byId = (id: string) => flows.find((n) => n.id === id);
  const wiresOf = (id: string) => ((byId(id)?.wires ?? []) as string[][]);
  const reaches = (from: string): Set<string> => {
    const seen = new Set<string>();
    const queue = [from];
    while (queue.length > 0) {
      const id = queue.shift() as string;
      for (const target of wiresOf(id).flat()) {
        if (seen.has(target)) continue;
        seen.add(target);
        queue.push(target);
      }
    }
    return seen;
  };

  /** Every control on the console whose value is read out of `config.yaml`. */
  const FROM_CONFIG = [
    // The two readouts and the rail the defect was found on.
    "tel-atboot", "tel-ingest", "tel-keys-ingest",
    // The six ground-station boxes beside them.
    "tel-host-0", "tel-port-0", "tel-host-1", "tel-port-1", "tel-host-2", "tel-port-2",
    // And the Cellular page's four, which are the same read.
    "input-cell-apn", "input-cell-dial", "input-cell-username", "input-cell-password",
  ];

  it("watches the configuration rather than reading it once", () => {
    const watch = byId("watch-config");
    expect(watch?.type).toBe("yonder-config-watch");
    expect(wiresOf("watch-config")[0]).toEqual(["seed-cell-form", "seed-tel-endpoints"]);
  });

  /**
   * **The defect, stated as a rule.** Every other poller on this console
   * repeats — the mesh every two seconds, the way out every five, the
   * telemetry link every two. One inject did not, and it was the one feeding
   * everything read from the configuration.
   *
   * There is now no inject on this console that fires once and never again,
   * and there should not be one: a value worth putting on a page once is a
   * value worth keeping right.
   */
  it("leaves no reading on the console that is taken once and never again", () => {
    const oneShot = flows.filter(
      (n) => n.type === "inject" && n.once === true && String(n.repeat ?? "") === "",
    );
    expect(
      oneShot.map((n) => n.id),
      "an inject that fires once seeds a widget that then goes stale for ever. "
      + "That is K-25, and on `Accepting from` it is a page saying nothing can command "
      + "the aircraft while anything on the network can.",
    ).toEqual([]);
  });

  it("brings every configured control downstream of that watch (R-UI-20)", () => {
    const seeded = reaches("watch-config");
    for (const id of FROM_CONFIG) {
      expect(seeded.has(id), `${id} is not downstream of watch-config`).toBe(true);
    }
  });

  /**
   * One watcher, and it asks no faster than the floor (R-UI-06). A second one
   * would be a second schedule reading the same document, which is how two
   * halves of one page come to disagree about it.
   */
  it("asks once, on one schedule", () => {
    const watchers = flows.filter((n) => n.type === "yonder-config-watch");
    expect(watchers.map((n) => n.id)).toEqual(["watch-config"]);
    expect(Number(watchers[0].interval) * 1000).toBeGreaterThanOrEqual(MIN_POLL_MS);
  });

  /**
   * The input-driven read stays, wired to the same two seeders, and the
   * *Refresh* button on the Network page stays wired to it.
   *
   * They are different reads for different reasons: this one answers a
   * person, so it has to produce a message even when the daemon does not
   * answer, and `yonder-config-watch` deliberately produces nothing at all in
   * that case so a dropped socket cannot blank a form full of settings.
   */
  it("keeps the read a person can ask for by hand", () => {
    expect(byId("read-config")?.type).toBe("yonder-config");
    expect(wiresOf("button-reread").flat()).toContain("read-config");
    expect(wiresOf("read-config")[0]).toEqual(wiresOf("watch-config")[0]);
  });
});

describe('Cockpit restoration — R-UI-28', () => {
  const node = (id: string) => flows.find(n => n.id === id);
  const targets = (id: string) => node(id)?.wires?.flat() ?? [];

  it('serves the existing 8+4 picture and aim layout independently of a deck', () => {
    expect(node('page-cockpit')).toMatchObject({ type: 'ui-page', name: 'Cockpit', path: '/cockpit', layout: 'grid', visible: true, disabled: false, order: 5, theme: 'palette' });
    expect(node('group-cockpit-picture')).toMatchObject({ page: 'page-cockpit', width: 8 });
    expect(node('group-cockpit-aim')).toMatchObject({ page: 'page-cockpit', width: 4 });
    const groups = new Set(flows.filter(n => n.page === 'page-cockpit').map(n => n.id));
    const widgets = flows.filter(n => n.group && groups.has(n.group));
    expect(widgets.map(n => n.type).sort()).toEqual(['ui-yonder-aim', 'ui-yonder-annunciator', 'ui-yonder-picture', 'ui-yonder-softkeys']);
    expect(node('pic-cockpit')).toMatchObject({ type: 'ui-yonder-picture', path: '' });
    expect(node('aim-cockpit')).toMatchObject({ type: 'ui-yonder-aim' });
  });

  it('feeds standalone widgets with the current source-composed picture and private-aim status contracts', () => {
    expect(targets('camera-read')).toEqual(expect.arrayContaining(['pick-cam-picture', 'pick-cam-aim']));
    expect(node('pick-cam-picture')?.rules).toEqual([{ t: 'set', p: 'payload', pt: 'msg', to: 'payload.picture', tot: 'msg' }]);
    expect(targets('pick-cam-picture')).toEqual(['pic-camera', 'pic-cockpit']);
    expect(targets('pick-cam-aim')).toEqual(['aim-camera', 'aim-cockpit']);
    expect(node('pick-cam-aim')?.rules).toEqual([{ t: 'set', p: 'payload', pt: 'msg', to: 'payload.aim', tot: 'jsonata' }]);
    for (const id of ['cam-rate-full', 'cam-rate-preview', 'cam-caps-saved']) expect(targets(id)).toEqual(['pic-camera', 'pic-cockpit']);
    // Native controls remain routed through the new Task40 adapter.
    expect((node('cam-deck-route')?.rules as { v: string }[]).map(r => r.v)).toContain('nativeControl');
  });

  it('changes the selected camera on the strip without navigating out of Cockpit or echoing picture commands', () => {
    expect(targets('pic-cockpit')).toEqual(['cam-pic-act']);
    const route = node('cam-pic-act')!;
    const rules = route.rules as { t: string; v?: string }[];
    const path = rules.findIndex(r => r.t === 'hask' && r.v === 'path');
    expect(route.wires?.[path]).toEqual(['cam-pic-go']);
    expect(route.wires?.[rules.findIndex(r => r.t === 'else')]).toEqual([]);
    expect(node('cam-pic-go')?.rules).toEqual([
      { t: 'set', p: 'camera', pt: 'flow', to: 'payload.path', tot: 'msg' },
      { t: 'delete', p: 'topic', pt: 'msg' },
      { t: 'set', p: 'payload', pt: 'msg', to: '', tot: 'str' },
    ]);
    expect(targets('cam-pic-go')).toEqual(['cam-at-read','cam-at-receive']);
    expect(targets('cam-at-read')).toEqual(['camera-read']);
    expect(node('cam-thumb-select')).toBeUndefined();
  });

  it('keeps pending confirmation reachable and visible for the Cockpit surface', () => {
    expect(node('group-cockpit-pending')).toMatchObject({ page: 'page-cockpit', visible: false });
    expect(targets('poll-pending')).toEqual(expect.arrayContaining(['ann-pending-cockpit', 'keys-pending-cockpit']));
    expect(targets('keys-pending-cockpit')).toEqual(['tag-pending-key']);
    expect(JSON.parse(node('keys-pending-cockpit')?.keys as string).map((key: { action: string }) => key.action)).toEqual(['confirm', 'revert']);
    for (const operation of ['show', 'hide']) {
      const rule = (node(`${operation}-pending-banner`)?.rules as { to: string }[])[0];
      expect(JSON.parse(rule.to).groups[operation]).toContain('group-cockpit-pending');
    }
  });
});

describe('unified Camera workspace wiring — R-UI-29', () => {
  const node = (id: string) => flows.find(n => n.id === id);
  it('has one Camera Deck and one separate Aim, content-sized controls and a bounded preview', () => {
    const groups = new Set(flows.filter(n => n.page === 'page-camera').map(n => n.id));
    const widgets = flows.filter(n => groups.has(String(n.group)));
    expect(widgets.filter(n => n.type === 'ui-yonder-deck')).toHaveLength(1);
    expect(widgets.filter(n => n.type === 'ui-yonder-aim')).toHaveLength(1);
    expect(node('aim-camera')?.height).toBe(0); expect(Number(node('pic-camera')?.height)).toBeGreaterThan(0);
    expect(node('deck-setup')).toBeUndefined(); expect(node('deck-live')).toBeUndefined();
  });
  it('keeps camera confirmation authoritative and inline instead of routing through popups', () => {
    expect(node('camera-workspace')?.type).toBe('yonder-camera-workspace');
    expect(node('cam-workspace-pending')?.wires?.flat()).toContain('camera-workspace');
    expect(node('poll-pending')?.wires?.flat()).toContain('cam-transaction-route');
    expect(node('cam-transaction-confirm')?.type).toBe('yonder-confirm'); expect(node('cam-transaction-revert')?.type).toBe('yonder-revert');
    for (const id of ['cam-transaction-confirm','cam-transaction-revert']) {
      expect(node(id)?.wires?.flat()).toContain('cam-workspace-result');
      expect(node(id)?.wires?.flat()).not.toContain('say-pending');
    }
    expect(flows.some(n => n.type === 'ui-notification' && n.id.startsWith('toast-cam'))).toBe(false);
    expect(node('ann-camera')).toBeUndefined();
  });
});
