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
    expect(confirms).toEqual(["cam-confirm", "confirm-pending"]);
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
  it("draws the Camera page from deck x2, picture, aim, annunciator, databar, holdkey, softkeys", () => {
    const types = on(camera).map((n) => n.type);
    expect(types.filter((t) => t === "ui-yonder-deck").length,
      "Live and Setup are two instances of one component").toBe(2);
    for (const kind of [
      "ui-yonder-picture", "ui-yonder-aim", "ui-yonder-annunciator",
      "ui-yonder-databar", "ui-yonder-holdkey", "ui-yonder-softkeys",
    ]) {
      expect(types, `the camera page has no ${kind}`).toContain(kind);
    }
    // One lamp for the page, not one per group: an image control, an apply
    // and a confirm are all "what this page last did", and two lamps able to
    // disagree about that is two things to read where there is one fact.
    expect(types.filter((t) => t === "ui-yonder-annunciator").length).toBe(1);
    const modes = on(camera).filter((n) => n.type === "ui-yonder-deck").map((n) => n.mode);
    expect(modes.slice().sort()).toEqual(["live", "setup"]);
  });

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
      .toEqual(["ui-yonder-budget", "ui-yonder-index", "ui-yonder-softkeys"]);
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
   * **Picture, aim, deck — and the readings under the controls, not above
   * them** (spec §5's viewport contract).
   *
   * The strip used to sit directly under the picture, which is where the
   * blueprint draws it and where it belongs on a wide screen. It cannot stay
   * there: at its widest honest value it is three lines of prose, and three
   * lines between the picture and the deck put the shutter key nine pixels
   * past a 1024×768 viewport — measured, not guessed. Spec §5 names the
   * picture, the Aim panel and Capture as what fits above the fold and says
   * the deck may run below it; the readings are not in that list. They are
   * still under whichever deck is showing, above the rail, on both.
   */
  it("puts the picture on top, aim beside it, the deck under both and the rail at the foot", () => {
    const ordered = groupsOn(camera).sort((a, b) => Number(a.order) - Number(b.order));
    expect(ordered.map((g) => g.id)).toEqual([
      "group-cam-picture", "group-cam-aim", "group-cam-live", "group-cam-setup",
      "group-cam-readout", "group-cam-receive",
      "group-cam-rail-live", "group-cam-rail-setup",
    ]);
    // **Beside, not below** (spec §5): the picture and the Aim panel share
    // one row, which is the only arrangement that puts both of them and the
    // shutter key inside 768 px of viewport. Twelve columns across the two.
    expect(Number(ordered[0]?.width) + Number(ordered[1]?.width)).toBe(12);
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
  it("gives each deck one widget and no room for anything else", () => {
    for (const id of ["group-cam-live", "group-cam-setup"]) {
      const held = flows.filter((n) => n.group === id);
      expect(held.map((n) => n.type), `${id} holds more than its deck`)
        .toEqual(["ui-yonder-deck"]);
    }
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
  it("feeds both decks the whole report, and names no capability in the wiring", () => {
    const pick = flows.find((n) => n.id === "pick-cam-deck");
    // Two moves and no composition: the whole report, then the problems a
    // refused apply left in flow context — which the deck puts beside the
    // field each names. Neither rule builds a value.
    expect((pick?.rules as { to: string; tot: string }[])).toEqual([
      { t: "set", p: "payload", pt: "msg", to: "payload.deck", tot: "jsonata" },
      { t: "set", p: "payload.problems", pt: "msg", to: "camproblems", tot: "flow" },
      { t: "set", p: "payload.problemsFor", pt: "msg", to: "camproblemsfor", tot: "flow" },
    ]);
    expect(((pick?.wires as string[][])[0] ?? []).slice().sort())
      .toEqual(["deck-cam-live", "deck-cam-setup"]);
    expect((flows.find((n) => n.id === "camera-read")?.wires as string[][])[0])
      .toContain("pick-cam-deck");

    // Not one `payload.capabilities.<key>` reference left anywhere in the
    // file. This is the same scan the old "draws a control for exactly the
    // capabilities the facts row stays silent about" test ran, asserting the
    // opposite thing: that the set is empty, because deciding where a
    // capability is drawn is `CAPABILITY_LAYOUT`'s job and `YonderDeck`'s
    // own test holds it against every key in the model.
    const named = flows.flatMap((n) =>
      JSON.stringify(n.rules ?? "").match(/payload\.capabilities\.(\w+)/g) ?? []);
    expect(named, "a capability is named in the wiring again").toEqual([]);
  });

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
    expect((line?.wires as string[][])[0]).toEqual(["pick-cam-receive"]);

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
  it("says what would stop a start, beside the key that starts it", () => {
    const bar = on(camera).find(
      (n) => n.type === "ui-yonder-databar"
        && String(n.cells).includes("startCheck"),
    );
    expect(bar, "the page never shows the start check").toBeDefined();
    const rail = flows.find((n) => n.id === String(bar?.group));
    expect(String(rail?.className), "the start check is not on the rail")
      .toContain("yonder-rail");
    expect(String(rail?.className), "and not on the rail Start is missing from")
      .toContain("yonder-deck-live");
    const cells = JSON.parse(String(bar?.cells)) as { label: string; kind?: string }[];
    expect(cells[0]?.label).not.toMatch(/^cannot/i);
    // A sentence, declared as one. Without this the cell keeps a reading's
    // `white-space: nowrap` and the strip runs 798 px past a 710 px page.
    expect(cells[0]?.kind).toBe("note");
    const feed = flows.find((n) => n.id === "pick-cam-start");
    expect((feed?.wires as string[][])[0]).toEqual([bar?.id]);
    expect((flows.find((n) => n.id === "camera-read")?.wires as string[][])[0])
      .toContain("pick-cam-start");
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
  it("answers every key each rail sends, and says so out loud when it cannot", () => {
    const rails = [
      ["keys-cam-live", "cam-live-keys", ["start", "stop", "setup"]],
      ["keys-cam-setup", "cam-setup-keys", ["live", "probe", "address"]],
    ] as const;
    for (const [railId, switchId, expected] of rails) {
      const rail = flows.find((n) => n.id === railId);
      const actions = (JSON.parse(String(rail?.keys)) as { action: string }[])
        .map((k) => k.action);
      expect(actions, `${railId} carries the wrong keys`).toEqual([...expected]);
      // The rail feeds that switch and nothing else, or the binding below is
      // a binding to a node the press never reaches.
      expect((rail?.wires as string[][])[0], `${railId} does not feed ${switchId}`)
        .toEqual([switchId]);

      const decide = flows.find((n) => n.id === switchId);
      expect(decide?.type).toBe("switch");
      expect(decide?.property).toBe("payload");
      const rules = decide?.rules as { t: string; v?: string }[];
      const wires = decide?.wires as string[][];
      // One `eq` per action, in the rail's own order, and nothing else.
      expect(rules.slice(0, -1).map((r) => `${r.t}:${String(r.v)}`),
        `${switchId} does not answer ${railId}'s keys`)
        .toEqual(actions.map((a) => `eq:${a}`));
      // Every one of them reaches something.
      for (const [i, action] of actions.entries()) {
        expect(wires[i], `${switchId} routes ${action} nowhere`).not.toEqual([]);
      }
      // And the last rule is an `else` that is heard rather than dropped.
      expect(rules[rules.length - 1]?.t, `${switchId} drops a key it does not know`)
        .toBe("else");
      expect(wires[rules.length - 1]).toEqual(["cam-key-unrouted"]);
    }
    // The reporter reaches a toast **and has something to put on it**. Wires
    // alone are not the guard: emptying its rules leaves a toast raised with
    // whatever payload the press happened to carry — the action name — which
    // is a notification that tells an operator nothing at all.
    const reporter = flows.find((n) => n.id === "cam-key-unrouted");
    expect((reporter?.wires as string[][])[0]).toEqual(["toast-cam-refused"]);
    const said = (reporter?.rules as { t: string; p: string; tot: string; to: string }[])
      .find((r) => r.p === "payload");
    expect(said?.t, "the reporter does not set the words").toBe("set");
    expect(said?.tot, "a literal sentence, not an expression over the press").toBe("str");
    // A sentence about *this console*, in an operator's words: it names what
    // did not happen and says nothing reached the camera, which is the one
    // thing they need to know before pressing it again.
    expect(said?.to).toMatch(/not wired to anything/);
    expect(said?.to).toMatch(/nothing was sent to the camera/);
  });

  /**
   * A key that reached `yonder-stream` with anything but start or stop would
   * spend a round trip to be told so, and the operator would read the daemon's
   * refusal about the deck key they pressed.
   */
  it("sends only start and stop to the pipeline", () => {
    const route = flows.find((n) => n.id === "cam-live-keys");
    const rules = route?.rules as { v?: string }[];
    const wires = route?.wires as string[][];
    const toward = (action: string): string[] =>
      wires[rules.findIndex((r) => r.v === action)] ?? [];
    // Only the two pipeline keys reach `yonder-stream`. This used to be
    // asserted as "everything that is not Setup", which was true of the
    // `else` branch as well — so a key nobody had heard of went to the
    // pipeline and was refused there rather than being reported as unwired.
    expect(toward("start")).toEqual(["cam-at-stream"]);
    expect(toward("stop")).toEqual(["cam-at-stream"]);
    for (const [i, wired] of wires.entries()) {
      if (rules[i]?.v === "start" || rules[i]?.v === "stop") continue;
      expect(wired, `output ${i} reaches the pipeline`).not.toContain("cam-at-stream");
    }
    // Setup also fetches the stream address: the deck an operator opens to find
    // it should already have it, and the committed capture of that deck is
    // what makes the gate's credential check bite (R-SEC-10).
    expect(toward("setup")).toEqual(["deck-setup", "cam-at-receive"]);
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
    expect((flows.find((n) => n.type === "ui-yonder-index")?.wires as string[][])[0])
      .toEqual(["cam-open"]);

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
    expect(cleared).toContain('"p":"camproblems"');
    expect(cleared).toContain('"p":"camproblemsfor"');
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
  it("routes a refused apply to its own answer, and carries its problems to the deck", () => {
    const route = flows.find((n) => n.id === "cam-apply-route");
    expect((route?.rules as { v?: string }[]).map((r) => r.v))
      .toEqual(["pending", "rejected", undefined]);
    const [armed, refused, kept] = route?.wires as string[][];
    expect(armed).toEqual(["cam-toast-text"]);
    expect(refused).toEqual(["cam-refused-text"]);
    expect(kept).toEqual(["cam-kept-text"]);

    const text = flows.find((n) => n.id === "cam-refused-text");
    // The problems, and the camera they are about: the node emits a fresh
    // message, so `msg.camera` does not survive the round trip on its own,
    // and a refusal that cannot say which camera it belongs to gets drawn
    // against a different one.
    expect(JSON.stringify(text?.rules)).toContain('"p":"camproblems"');
    expect(JSON.stringify(text?.rules)).toContain('"p":"camproblemsfor"');
    const toast = flows.find((n) => n.id === String((text?.wires as string[][])[0][0]));
    expect(toast?.type).toBe("ui-notification");
    // Nothing about a refusal offers a confirm: there is nothing in force to
    // keep, and a confirm control that does nothing is K-32.
    expect(toast?.allowConfirm).toBe(false);
    expect(String(toast?.name)).not.toMatch(/kept/i);

    // Cleared when an apply is *sent*, so a problem from the last attempt
    // cannot be read as one from this one.
    expect(JSON.stringify(flows.find((n) => n.id === "cam-apply-msg")?.rules))
      .toContain('"p":"camproblems"');
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
  it("keeps Record and Recentre off the rail", () => {
    const rails = groupsOn(camera).filter((g) => String(g.className).includes("yonder-rail"));
    expect(rails.length, "there is no rail to check").toBeGreaterThan(0);
    const keys = on(camera)
      .filter((n) => rails.some((r) => r.id === n.group))
      .flatMap((n) => (n.keys === undefined
        ? [{ label: String(n.label ?? ""), action: String(n.action ?? "") }]
        : JSON.parse(String(n.keys)) as { label: string; action: string }[]));
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      const said = `${key.label} ${key.action}`.toLowerCase();
      expect(said, "Record belongs under the picture it records").not.toMatch(/record|photo|shutter/);
      expect(said, "Recentre belongs on the panel that aims").not.toMatch(/recentre|recenter/);
    }
  });

  /**
   * **Every press the deck makes has somewhere to go.**
   *
   * `YonderDeck` posts six different shapes — an image control, an apply, a
   * discard, an output switch, the shutter and a deck flip — and Dashboard
   * delivers all six down one wire. A route that recognised five of them
   * would leave the sixth silently doing nothing, which is exactly the
   * failure `emitsActions` produces one layer up and is just as invisible.
   *
   * `discard` is deliberately not routed: it is the browser dropping its own
   * draft and reaches the daemon by design (`YonderDeck.discard()` clears the
   * store before it posts). `shutter` and the aim events are Task 33's and
   * Task 38's; they are named here as unrouted so that adding a route is a
   * change to this list rather than a discovery.
   */
  it("routes every press the deck makes, and names the ones it does not", () => {
    const route = flows.find((n) => n.id === "cam-deck-route");
    expect(route?.type).toBe("switch");
    expect(route?.property).toBe("payload");
    const rules = route?.rules as { t: string; v: string }[];
    expect(rules.map((r) => r.v)).toEqual(["control", "apply", "output", "mode"]);
    for (const rule of rules) expect(rule.t, "each is a has-key test").toBe("hask");

    const wires = route?.wires as string[][];
    expect(wires.map((w) => w[0]))
      .toEqual(["cam-control-msg", "cam-apply-msg", "cam-output-msg", "cam-deck-mode"]);
    // Both decks reach it, or the Setup deck's own Apply goes nowhere.
    for (const id of ["deck-cam-live", "deck-cam-setup"]) {
      expect((flows.find((n) => n.id === id)?.wires as string[][])[0]).toEqual(["cam-deck-route"]);
    }

    // **A live control never enters the apply path** — spec §10's defect 1,
    // asserted over the wiring rather than over a hypothesis. `controls` is
    // a runtime route; `apply` is the engine's.
    const control = flows.find((n) => n.id === "cam-control-msg");
    expect(JSON.stringify(control?.rules)).toContain('"to":"controls"');
    expect((control?.wires as string[][])[0]).toEqual(["cam-at-controls"]);
    expect((flows.find((n) => n.id === "cam-at-controls")?.wires as string[][])[0])
      .toEqual(["camera-controls"]);

    const apply = flows.find((n) => n.id === "cam-apply-msg");
    expect(JSON.stringify(apply?.rules)).toContain('"to":"apply"');
    expect((apply?.wires as string[][])[0]).toEqual(["cam-at-settings"]);
  });
});
