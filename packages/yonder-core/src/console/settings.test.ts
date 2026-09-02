// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { createContext, runInContext } from "node:vm";
import {
  renderSettings, parseSettingsArgs, EXCLUDED_NODES, SETUP_FLOW_FILE, CONSOLE_FLOW_FILE, EDITOR_ROOT,
} from "./settings.js";
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

/**
 * The installer's command line into renderSettings.
 *
 * Parsed by an exported function rather than inline in main(), because an
 * argument parser exercised only by running the installer is one nobody finds
 * out is broken until a board is being built.
 */
describe("parseSettingsArgs", () => {
  it("takes the configuration and the output file", () => {
    expect(parseSettingsArgs(["/etc/yonder/config.yaml", "/opt/yonder/console/settings.js"]))
      .toEqual({
        configPath: "/etc/yonder/config.yaml",
        out: "/opt/yonder/console/settings.js",
        provisioned: false,
        paths: {},
      });
  });

  it("takes the provisioned flag in any position", () => {
    expect(parseSettingsArgs(["--provisioned", "a", "b"])?.provisioned).toBe(true);
    expect(parseSettingsArgs(["a", "--provisioned", "b"])?.provisioned).toBe(true);
    expect(parseSettingsArgs(["a", "b", "--provisioned"])?.provisioned).toBe(true);
  });

  /**
   * The defaults describe one installation layout, and the installer's prefix
   * is a variable. A generator that always writes /opt/yonder into the file
   * is wrong the moment anything is installed anywhere else, and its only
   * symptom is a console that cannot find its own wiring.
   */
  it("takes each path override", () => {
    const args = parseSettingsArgs([
      "a", "b",
      "--core-tree", "/srv/yonder/core",
      "--user-dir", "/srv/console",
      "--socket", "/srv/run/core.sock",
    ]);
    expect(args?.paths).toEqual({
      coreTree: "/srv/yonder/core",
      userDir: "/srv/console",
      socket: "/srv/run/core.sock",
    });
  });

  it("refuses a flag with nothing after it", () => {
    expect(parseSettingsArgs(["a", "b", "--core-tree"])).toBeUndefined();
  });

  /**
   * A typo silently treated as a file name would write settings.js somewhere
   * nobody asked for — and leave the console reading the one that was already
   * there.
   */
  it("refuses an unknown flag rather than treating it as a path", () => {
    expect(parseSettingsArgs(["a", "b", "--provisionned"])).toBeUndefined();
    expect(parseSettingsArgs(["a", "b", "--user-directory", "/x"])).toBeUndefined();
  });

  it("refuses too few or too many paths", () => {
    expect(parseSettingsArgs([])).toBeUndefined();
    expect(parseSettingsArgs(["a"])).toBeUndefined();
    expect(parseSettingsArgs(["a", "b", "c"])).toBeUndefined();
  });
});

/**
 * The socket path the contrib nodes read (Task 7 of M1b-2).
 *
 * Generated into settings.js rather than written into flows.json, because
 * flows.json is wiring (CLAUDE.md rule 2) and a socket path in it is a
 * deployment detail an operator could edit in the flow editor.
 */
describe("what the contrib nodes are told", () => {
  it("puts the daemon's socket in settings, where every node can read it", () => {
    const out = renderSettings(DEFAULT_CONFIG, {
      provisioned: true,
      paths: { socket: "/run/yonder/core.sock" },
    });
    expect(out).toContain("yonder: {");
    expect(out).toContain('socketPath: "/run/yonder/core.sock"');
  });

  it("takes it from the paths it was given, not from a constant", () => {
    const out = renderSettings(DEFAULT_CONFIG, {
      provisioned: true,
      paths: { socket: "/tmp/elsewhere.sock" },
    });
    expect(out).toContain('socketPath: "/tmp/elsewhere.sock"');
    expect(out).not.toContain("/run/yonder/core.sock");
  });
});
