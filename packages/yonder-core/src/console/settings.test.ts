// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { createContext, runInContext } from "node:vm";
import { renderSettings, EXCLUDED_NODES, SETUP_FLOW_FILE, CONSOLE_FLOW_FILE, EDITOR_ROOT } from "./settings.js";
import { DEFAULT_CONFIG, type Config } from "../schema/config.js";

/**
 * `settings.js` is generated, so this is where most of this milestone's
 * settings tests live: a pure function, a `Config` in, a string out.
 */

const PATHS = {
  settings: "/opt/yonder/console/settings.js",
  userDir: "/var/lib/yonder/console",
  socket: "/run/yonder/core.sock",
  coreTree: "/opt/yonder/packages/yonder-core",
  unit: "yonder-console.service",
};

function config(edit: (c: Config) => void = () => {}): Config {
  const c = structuredClone(DEFAULT_CONFIG);
  edit(c);
  return c;
}

/**
 * Evaluate the generated file the way Node-RED will, with `require` stubbed,
 * and return what it exports.
 *
 * This is what makes the assertions below about *values* rather than about
 * substrings: a test that greps for `functionExternalModules: false` passes
 * on a file that is a syntax error, and a settings.js that will not parse is
 * a console that will not start.
 */
function evaluate(text: string): { exports: Record<string, unknown>; required: string[] } {
  const required: string[] = [];
  const module = { exports: {} as Record<string, unknown> };
  const sandbox = {
    module,
    exports: module.exports,
    require: (id: string) => {
      required.push(id);
      return {
        consoleGate: (opts: unknown) => ({ __gate: opts }),
        editorAuth: (opts: unknown) => ({ __editorAuth: opts }),
      };
    },
  };
  runInContext(text, createContext(sandbox));
  return { exports: module.exports, required };
}

describe("renderSettings", () => {
  it("produces a file that parses and exports an object", () => {
    const { exports } = evaluate(renderSettings(config(), { provisioned: false, paths: PATHS }));
    expect(typeof exports).toBe("object");
    expect(Object.keys(exports).length).toBeGreaterThan(5);
  });

  it("says it is generated, by what, and that an edit will not survive", () => {
    const text = renderSettings(config(), { provisioned: false, paths: PATHS });
    expect(text).toContain("GENERATED FILE");
    expect(text).toContain("console/settings.ts");
    expect(text).toContain("SPDX-License-Identifier: GPL-3.0-or-later");
  });

  /**
   * CLAUDE.md rule 2, expressed in code. A function node is JavaScript
   * serialised into flows.json beside wire coordinates: unreviewable, so
   * unmergeable. This must fail loudly if someone takes it out.
   */
  it("switches the function node and external modules off", () => {
    const { exports } = evaluate(renderSettings(config(), { provisioned: true, paths: PATHS }));
    expect(exports.functionExternalModules).toBe(false);
    expect(exports.nodesExcludes).toContain("10-function.js");
    // And the palette manager cannot put one back.
    expect(exports.externalModules).toMatchObject({
      palette: { allowInstall: false, allowUpload: false, allowUpdate: false },
      modules: { allowInstall: false },
    });
  });

  it("excludes the exec node, the other code-execution surface", () => {
    const { exports } = evaluate(renderSettings(config(), { provisioned: true, paths: PATHS }));
    expect(exports.nodesExcludes).toContain("90-exec.js");
    expect(exports.nodesExcludes).toEqual(EXCLUDED_NODES);
  });

  it("takes the port from the configuration, not from a constant", () => {
    for (const port of [3000, 8080, 1880]) {
      const { exports } = evaluate(
        renderSettings(config((c) => { c.ui.port = port; }), { provisioned: true, paths: PATHS }),
      );
      expect(exports.uiPort).toBe(port);
    }
  });

  it("binds every interface, because the access point is how the device is reached", () => {
    const { exports } = evaluate(renderSettings(config(), { provisioned: true, paths: PATHS }));
    expect(exports.uiHost).toBe("0.0.0.0");
  });

  it("puts Node-RED's state where the installer prepared it", () => {
    const { exports } = evaluate(renderSettings(config(), { provisioned: true, paths: PATHS }));
    expect(exports.userDir).toBe("/var/lib/yonder/console");
  });

  describe("the flow editor", () => {
    it("is not mounted at all while unprovisioned", () => {
      const { exports } = evaluate(renderSettings(config(), { provisioned: false, paths: PATHS }));
      expect(exports.httpAdminRoot).toBe(false);
      expect(exports.adminAuth).toBeUndefined();
    });

    it("is not mounted when the operator has turned it off", () => {
      const text = renderSettings(
        config((c) => { c.ui.editor.enabled = false; }),
        { provisioned: true, paths: PATHS },
      );
      const { exports } = evaluate(text);
      expect(exports.httpAdminRoot).toBe(false);
      expect(exports.adminAuth).toBeUndefined();
    });

    it("is mounted behind adminAuth when provisioned and enabled", () => {
      const { exports } = evaluate(renderSettings(config(), { provisioned: true, paths: PATHS }));
      expect(exports.httpAdminRoot).toBe(EDITOR_ROOT);
      expect(exports.adminAuth).toEqual({ __editorAuth: { socketPath: "/run/yonder/core.sock" } });
    });
  });

  describe("the flows file", () => {
    it("is the empty setup one while unprovisioned", () => {
      const { exports } = evaluate(renderSettings(config(), { provisioned: false, paths: PATHS }));
      expect(exports.flowFile).toBe(SETUP_FLOW_FILE);
    });

    it("is the real one once provisioned", () => {
      const { exports } = evaluate(renderSettings(config(), { provisioned: true, paths: PATHS }));
      expect(exports.flowFile).toBe(CONSOLE_FLOW_FILE);
    });

    it("is a different file, so provisioning never has to un-empty anything", () => {
      expect(SETUP_FLOW_FILE).not.toBe(CONSOLE_FLOW_FILE);
    });
  });

  describe("the gate", () => {
    /**
     * httpNodeAuth rather than httpNodeMiddleware. The latter is consulted
     * only by the http in node, so on a console with no flows — which is what
     * setup mode is — it would never run and the setup page would never be
     * served.
     */
    it("is wired where Node-RED mounts it whether or not a flow exists", () => {
      const { exports } = evaluate(renderSettings(config(), { provisioned: false, paths: PATHS }));
      expect(exports.httpNodeAuth).toEqual({
        __gate: { socketPath: "/run/yonder/core.sock", provisioned: false },
      });
      expect(exports.httpNodeMiddleware).toBeUndefined();
    });

    it("is told whether the device is provisioned", () => {
      const { exports } = evaluate(renderSettings(config(), { provisioned: true, paths: PATHS }));
      expect(exports.httpNodeAuth).toEqual({
        __gate: { socketPath: "/run/yonder/core.sock", provisioned: true },
      });
    });

    it("comes from the installed package, by absolute path", () => {
      const { required } = evaluate(renderSettings(config(), { provisioned: true, paths: PATHS }));
      expect(required).toEqual(["/opt/yonder/packages/yonder-core/dist/console/wiring.js"]);
    });
  });

  /**
   * R-SEC-10. Node-RED's audit events carry request detail, and a password
   * posted to a login route is exactly the request detail that would end up
   * in the journal.
   */
  it("logs at info and audits nothing", () => {
    const { exports } = evaluate(renderSettings(config(), { provisioned: true, paths: PATHS }));
    expect(exports.logging).toEqual({ console: { level: "info", metrics: false, audit: false } });
  });

  /**
   * The generated file is world-readable on the device and is the first thing
   * anyone looks at. Nothing about the administrator password belongs in it —
   * the hash never leaves root, and this file does not even know one exists
   * beyond a boolean.
   */
  it("contains no secret and no hash", () => {
    for (const provisioned of [true, false]) {
      const text = renderSettings(config(), { provisioned, paths: PATHS });
      expect(text).not.toContain("scrypt$");
      expect(text).not.toMatch(/admin_password/);
      expect(text).not.toMatch(/secrets\.yaml/);
      expect(text).not.toMatch(/\bpassword\s*:/);
    }
  });

  it("is a pure function of the configuration and of whether a password is set", () => {
    // The renderer compares the text it would write against the file on disk
    // and restarts only on a difference, so two renders of the same inputs
    // producing different text would restart the console on every apply and
    // log the operator out each time.
    const a = renderSettings(config(), { provisioned: true, paths: PATHS });
    const b = renderSettings(config(), { provisioned: true, paths: PATHS });
    expect(a).toBe(b);
    expect(renderSettings(config(), { provisioned: false, paths: PATHS })).not.toBe(a);
  });

  it("quotes paths rather than pasting them, so an odd one cannot escape", () => {
    const text = renderSettings(config(), {
      provisioned: true,
      paths: { ...PATHS, userDir: '/var/lib/"; process.exit(1); //' },
    });
    const { exports } = evaluate(text);
    expect(exports.userDir).toBe('/var/lib/"; process.exit(1); //');
  });
});
