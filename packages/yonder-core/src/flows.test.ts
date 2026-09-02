// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { CONSOLE_HOME, THEME_HREF } from "./console/settings.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { EXCLUDED_NODES, THEME_HREF } from "./console/settings.js";
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
  for (const pkg of ["node-red-contrib-yonder-system", "node-red-contrib-yonder-network"]) {
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
    const used = new Set(flows.map((n) => n.type).filter((t) => t.startsWith("yonder-")));
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
  it("warns, before the operator submits, what joining a network does", () => {
    const warning = flows.find((n) => n.id === "warning-join");
    const content = String(warning?.content ?? "").toLowerCase();
    expect(warning, "the Wi-Fi form has no warning on it").toBeDefined();

    // The access point is about to disappear.
    expect(content).toContain("access point");
    expect(content).toMatch(/disappear|goes away|go away/);
    // Where to find the device afterwards.
    expect(content).toContain("yonder.local");
    expect(content).toMatch(/router|client list/);
    // How long they have.
    expect(content).toMatch(/\b5 minutes\b|\bfive minutes\b/);
    // And that it comes back by itself if the password was wrong.
    expect(content).toMatch(/wrong|did not|cannot join/);
    expect(content).toMatch(/by itself|on its own|returns/);
  });

  /**
   * The honesty condition Task 6 set. `<hostname>.local` was not verified on
   * hardware for this build, so the page may not promise it — it says what it
   * needs and gives the fallback that always works.
   */
  it("does not promise that the device's name will resolve", () => {
    const warning = String(flows.find((n) => n.id === "warning-join")?.content ?? "");
    expect(warning).toMatch(/not verified|has not been verified/i);
    expect(warning).toMatch(/router/i);
  });

  /**
   * R-UI-07. Day and night, chosen by the operator and persisted in
   * `ui.theme`, never inferred from the browser or the host.
   */
  it("lets the operator choose day or night, and says what that costs", () => {
    const dropdown = flows.find((n) => n.id === "theme-choice");
    expect(dropdown?.type).toBe("ui-dropdown");
    const values = (dropdown?.options as { value: string }[]).map((o) => o.value).sort();
    expect(values).toEqual(["day", "night"]);

    // The choice goes to a node, which posts it to POST /ui/theme — which is
    // what makes it persist and what puts it behind the confirmation timer.
    expect(dropdown?.wires).toEqual([["theme-apply"]]);
    expect(flows.find((n) => n.id === "theme-apply")?.type).toBe("yonder-theme");
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
