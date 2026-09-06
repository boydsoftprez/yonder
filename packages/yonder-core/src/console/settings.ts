// SPDX-License-Identifier: GPL-3.0-or-later
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig } from "../config/load.js";
import type { Config } from "../schema/config.js";

/**
 * `settings.js` is generated, never hand-written.
 *
 * Pure translation: a `Config` in, the text of a file out. That is what lets
 * `ui.*` inherit M0's validate → snapshot → apply → confirm-or-revert cycle
 * for free — a `ConsoleRenderer` is just a `Renderer` that writes this string
 * — and it is why nearly all of this milestone's settings tests live against
 * this one function rather than against a running Node-RED.
 *
 * The generated file is CommonJS, because Node-RED loads it with `require`,
 * and it is a *description*: values, and two calls into `wiring.ts`. Nothing
 * with a decision in it is written here. A generated file carrying behaviour
 * is a file nobody can review a diff of, which is CLAUDE.md rule 2 applied to
 * the one other generated artefact this project ships.
 */

export interface ConsolePaths {
  /** Where the generated settings.js is written. */
  settings: string;
  /**
   * The one directory the console serves files out of, and the only place
   * `theme.css` is written.
   *
   * A directory of its own, never the console tree. Node-RED mounts
   * `httpNodeAuth` at `httpNodeRoot` *before* `httpStatic` (red.js), so
   * everything under here is behind the same login as the dashboard — which is
   * the right place for it: the palette styles the dashboard, and the login
   * page carries its own inline CSS and needs none of this. What the separate
   * directory buys is that `settings.js`, one level up, is never a candidate
   * for `express.static` at all.
   */
  publicDir: string;
  /** Node-RED's userDir: flows, the credential store, its own state. */
  userDir: string;
  /** The daemon's Unix socket, as the console must reach it. */
  socket: string;
  /** The installed yonder-core tree the generated file requires its wiring from. */
  coreTree: string;
  /** The unit the console runs as, restarted when this file changes. */
  unit: string;
}

/**
 * Generated artefacts live in `/var/lib`, never in `/opt`.
 *
 * `settings.js` and `theme.css` used to sit in `/opt/yonder/console`, beside
 * the installed console. That looked tidy and it made the device unusable on
 * the first board it ever ran on.
 *
 * `yonder-core.service` is sandboxed `ProtectSystem=strict` with
 * `ReadWritePaths=/etc/yonder /var/lib/yonder`, so from inside the daemon
 * every write under `/opt` is `EROFS`. The installer generates `settings.js`
 * as root *outside* systemd, so a fresh install looked perfect — the console
 * came up, served its setup page, and passed every post-condition. Then the
 * operator set an administrator password, the daemon stored it, and the
 * render that was supposed to flip the console into provisioned mode failed:
 *
 *     could not restart the console after the password was set:
 *     EROFS: read-only file system, open '/opt/yonder/console/public/theme.css.tmp'
 *
 * The daemon was provisioned and the console was not. The only page it served
 * was the setup page, whose POST now answers 409, so the screen contradicted
 * itself — "no administrator password yet" above "an administrator password
 * is already set" — and the only way back in was to take the card out. Every
 * step before that click reported success.
 *
 * `/opt` is installed code and the installer owns it. `settings.js` and
 * `theme.css` are variable state that the daemon rewrites on every apply, so
 * they belong under the state directory the daemon is already allowed to
 * write. Widening `ReadWritePaths` would have fixed the symptom by making the
 * sandbox mean less; this fixes it by putting the file where it always
 * belonged. `installer/lib/common.sh:assert_daemon_can_write` now fails the
 * install if these two ever drift apart again.
 */
export const DEFAULT_CONSOLE_PATHS: ConsolePaths = {
  settings: "/var/lib/yonder/console/settings.js",
  publicDir: "/var/lib/yonder/console/public",
  userDir: "/var/lib/yonder/console",
  socket: "/run/yonder/core.sock",
  coreTree: "/opt/yonder/packages/yonder-core",
  unit: "yonder-console.service",
};

/**
 * The flows file for a device with no administrator password: empty, and
 * separate from the real one.
 *
 * Separate rather than emptied, so that provisioning a device does not have
 * to un-empty anything and so an operator's flows are never what setup mode
 * is serving. In setup mode there is no flow, so there is no node, so there
 * is nothing to call — the property R-SEC-09 asks for, made structural.
 */
export const SETUP_FLOW_FILE = "setup-flows.json";
export const CONSOLE_FLOW_FILE = "flows.json";

/** The contents of that empty flows file. */
export const EMPTY_FLOWS = "[]\n";

/**
 * Where a signed-in operator is sent, and where the console actually lives.
 *
 * The dashboard mounts itself at the `ui-base` node's `path`, so nothing at
 * all is served at `/` once a device is provisioned. The login handler used
 * to redirect there anyway, which meant the last step of first-run setup —
 * type the password you just chose, press Sign in — landed on Express's bare
 * `Cannot GET /`. Every part of the flow worked and the operator was looking
 * at a white page with an error on it.
 *
 * Exported so the middleware and `flows/flows.json` cannot drift: a test in
 * `flows.test.ts` asserts the `ui-base` node's path is exactly this.
 */
export const CONSOLE_HOME = "/dashboard";

/** Where the flow editor lives, when it lives anywhere. */
export const EDITOR_ROOT = "/editor";

/** Where `publicDir` is mounted, and therefore where `theme.css` is fetched from. */
export const STATIC_ROOT = "/yonder/";

/** The generated stylesheet's name inside `publicDir`. */
export const THEME_FILE = "theme.css";

/** What a page links to. Relative to STATIC_ROOT, and never to another host. */
export const THEME_HREF = `${STATIC_ROOT}${THEME_FILE}`;

/**
 * Core nodes that are never loaded.
 *
 * `10-function.js` is CLAUDE.md rule 2 expressed in the runtime: a `function`
 * node is JavaScript serialised into `flows.json` beside wire coordinates,
 * which cannot be reviewed and therefore cannot be merged. Excluding the node
 * means a flow carrying one does not silently work on a device.
 *
 * `90-exec.js` runs arbitrary commands as the console's user. R-SEC-05 calls
 * any code-execution surface something to gate; this one is not needed by
 * anything Yonder ships, so it is removed rather than gated.
 *
 * Matched against the node's file name, which is what Node-RED's registry
 * compares (`localfilesystem.js`, `isExcluded`).
 */
export const EXCLUDED_NODES = ["10-function.js", "90-exec.js"];

export interface RenderSettingsOptions {
  /** Whether this device has an administrator password (R-SEC-09). */
  provisioned: boolean;
  paths?: Partial<ConsolePaths>;
}

export function consolePaths(overrides?: Partial<ConsolePaths>): ConsolePaths {
  const merged = { ...DEFAULT_CONSOLE_PATHS, ...overrides };
  // `publicDir` belongs beside `settings.js`, so it is *derived* from it
  // rather than defaulted alongside it. A caller that has moved the console —
  // the installer with a different prefix, a test with a temporary directory —
  // would otherwise get a settings path in one place and a public directory
  // still pointing at the shipped one. That is not hypothetical: every
  // existing test overrides `settings` and nothing else, and a plain default
  // had them all writing into /opt/yonder on whatever machine they ran on.
  if (overrides?.publicDir === undefined) {
    merged.publicDir = join(dirname(merged.settings), "public");
  }
  return merged;
}

/** A JavaScript literal for a value, quoted so nothing in it can escape. */
function literal(value: unknown): string {
  return JSON.stringify(value);
}

const HEADER = `// SPDX-License-Identifier: GPL-3.0-or-later
//
// GENERATED FILE. Do not edit it.
//
// Written by yonder-core's ConsoleRenderer from /etc/yonder/config.yaml, and
// rewritten from scratch every time that configuration is applied — so an
// edit made here survives until the next apply and then disappears, which is
// worse than one that never worked. Change the configuration instead.
//
// The generator is packages/yonder-core/src/console/settings.ts.
`;

/**
 * The text of `settings.js` for this configuration.
 *
 * Two things decide the shape: whether the device has an administrator
 * password, and whether the operator wants the flow editor. Between them:
 *
 * | provisioned | ui.editor.enabled | flows            | httpAdminRoot |
 * |---|---|---|---|
 * | no  | either | the empty setup flows | `false` — not mounted at all |
 * | yes | no     | `flows.json`          | `false` |
 * | yes | yes    | `flows.json`          | `"/editor"`, behind adminAuth |
 */
export function renderSettings(config: Config, opts: RenderSettingsOptions): string {
  const paths = consolePaths(opts.paths);
  const wiring = join(paths.coreTree, "dist", "console", "wiring.js");
  const editorMounted = opts.provisioned && config.ui.editor.enabled;

  const lines: string[] = [];
  lines.push(HEADER);
  lines.push(`const yonder = require(${literal(wiring)});`);
  lines.push("");
  lines.push("module.exports = {");

  lines.push(`  uiPort: ${literal(config.ui.port)},`);
  // Every interface. The access point is how an operator first reaches this
  // device and a cell link is how they reach it afterwards, so binding to
  // loopback would make the console unreachable by design. What stands in
  // front of it is the administrator password, not the bind address.
  lines.push('  uiHost: "0.0.0.0",');
  lines.push(`  userDir: ${literal(paths.userDir)},`);
  lines.push(`  flowFile: ${literal(opts.provisioned ? CONSOLE_FLOW_FILE : SETUP_FLOW_FILE)},`);
  lines.push("  flowFilePretty: true,");
  lines.push("");

  lines.push("  // CLAUDE.md rule 2, in the runtime. A function node is JavaScript");
  lines.push("  // serialised into flows.json beside wire coordinates: unreviewable, so");
  lines.push("  // unmergeable. The exec node is the other code-execution surface");
  lines.push("  // (R-SEC-05) and nothing Yonder ships needs it.");
  lines.push("  functionExternalModules: false,");
  lines.push(`  nodesExcludes: ${literal(EXCLUDED_NODES)},`);
  lines.push("  externalModules: {");
  lines.push("    palette: { allowInstall: false, allowUpload: false, allowUpdate: false },");
  lines.push("    modules: { allowInstall: false },");
  lines.push("  },");
  lines.push("");

  if (editorMounted) {
    lines.push("  // The flow editor, behind the same administrator password as the");
    lines.push("  // console — one credential on this device, checked in one place, by");
    lines.push("  // the daemon that is the only thing able to read the hash.");
    lines.push(`  httpAdminRoot: ${literal(EDITOR_ROOT)},`);
    lines.push(`  adminAuth: yonder.editorAuth({ socketPath: ${literal(paths.socket)} }),`);
  } else {
    lines.push("  // Not mounted. Absent rather than hidden: a route that answers is a");
    lines.push("  // route, whatever it answers with (R-SEC-09).");
    lines.push("  httpAdminRoot: false,");
  }
  lines.push("");

  lines.push("  // httpNodeAuth, not httpNodeMiddleware: the latter is consulted only by");
  lines.push("  // the http in node, so on a console with no flows — which is what setup");
  lines.push("  // mode is — it would never run. Node-RED applies this one with");
  lines.push("  // app.use(httpNodeRoot, fn) whether or not any flow exists.");
  lines.push("  httpNodeAuth: yonder.consoleGate({");
  lines.push(`    socketPath: ${literal(paths.socket)},`);
  lines.push(`    provisioned: ${literal(opts.provisioned)},`);
  lines.push("  }),");
  lines.push("");

  // Where the contrib nodes find the daemon.
  //
  // In settings.js rather than in flows.json, because flows.json is wiring
  // (CLAUDE.md rule 2) and a socket path in it would be a deployment detail
  // an operator could edit in the flow editor. Node-RED exposes the whole
  // settings object to a node as `RED.settings`, so one generated value
  // reaches every node without any of them carrying a default of its own.
  if (opts.provisioned) {
    lines.push("  // One directory, and only when there is a console to style. The theme");
    lines.push("  // stylesheet the ConsoleRenderer generates is served from here, same");
    lines.push("  // origin, no network (R-UI-01).");
    lines.push("  //");
    lines.push("  // Node-RED mounts httpNodeAuth before httpStatic, so this is behind the");
    lines.push("  // same login as the dashboard it styles. A directory of its own, so");
    lines.push("  // settings.js one level up is never a candidate for express.static.");
    lines.push("  //");
    lines.push("  // Absent while unprovisioned, so setup mode still serves exactly one");
    lines.push("  // page and nothing else (R-SEC-09).");
    lines.push(`  httpStatic: [{ path: ${literal(paths.publicDir)}, root: ${literal(STATIC_ROOT)} }],`);
    lines.push("");

    lines.push("  // The theme in the head, fetched with the document rather than after it.");
    lines.push("  // A ui-template used to pull this in from inside its own style block,");
    lines.push("  // injected over Dashboard's own socket connection — which does not exist");
    lines.push("  // until the SPA has already booted, so the browser always painted an");
    lines.push("  // unstyled page first and the console flashed white on every load");
    lines.push("  // (R-UI-22). dashboard.middleware is the hook @flowfuse/node-red-dashboard");
    lines.push("  // reads out of this file and runs in front of the document it serves;");
    lines.push("  // yonder.headInjection is what it does with it. The value is markup, not");
    lines.push("  // a decision — see wiring.ts.");
    lines.push(`  dashboard: { middleware: yonder.headInjection('<link rel="stylesheet" href="${THEME_HREF}">') },`);
    lines.push("");
  }

  lines.push("  // Where the yonder-* nodes find the configuration daemon. Read as");
  lines.push("  // RED.settings.yonder.socketPath; flows.json carries no path of its own.");
  lines.push("  yonder: {");
  lines.push(`    socketPath: ${literal(paths.socket)},`);
  lines.push("  },");
  lines.push("");

  lines.push("  // No audit. Node-RED's audit events carry request detail, and a");
  lines.push("  // password posted to a login route is exactly the request detail that");
  lines.push("  // would end up in the journal (R-SEC-10).");
  lines.push("  logging: {");
  lines.push("    console: { level: \"info\", metrics: false, audit: false },");
  lines.push("  },");
  lines.push("};");
  lines.push("");

  return lines.join("\n");
}

export interface SettingsArgs {
  configPath: string;
  out: string;
  provisioned: boolean;
  paths: Partial<ConsolePaths>;
}

/**
 * The command line the installer uses.
 *
 *     settings.js <config.yaml> <settings.js> [--provisioned]
 *                 [--core-tree DIR] [--user-dir DIR] [--socket PATH]
 *                 [--public-dir DIR]
 *
 * The path overrides exist because the defaults describe one installation
 * layout and the installer's own prefix is a variable. A generator that
 * always writes /opt/yonder into the file is a generator that is wrong the
 * moment anything is installed anywhere else, and wrong in a way whose only
 * symptom is a console that cannot find its own wiring.
 *
 * Separated from main() so it can be tested: an argument parser that is only
 * exercised by running the installer is one nobody finds out is broken until
 * a board is being built.
 */
export function parseSettingsArgs(argv: readonly string[]): SettingsArgs | undefined {
  const positional: string[] = [];
  const paths: Partial<ConsolePaths> = {};
  let provisioned = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    const takeValue = (): string | undefined => argv[++i];
    const PATH_FLAGS: Record<string, keyof ConsolePaths> = {
      "--core-tree": "coreTree",
      "--user-dir": "userDir",
      "--socket": "socket",
      "--public-dir": "publicDir",
    };

    const key = PATH_FLAGS[arg];
    if (key !== undefined) {
      const value = takeValue();
      // A flag with nothing after it is a truncated command line, and taking
      // the next flag as its value is how a path ends up named "--socket".
      if (value === undefined) return undefined;
      paths[key] = value;
      continue;
    }

    switch (arg) {
      case "--provisioned": provisioned = true; break;
      default:
        // An unknown flag is a typo, and a typo silently treated as a file
        // name would write settings.js somewhere nobody asked for.
        if (arg.startsWith("--")) return undefined;
        positional.push(arg);
    }
  }

  const [configPath, out] = positional;
  if (configPath === undefined || out === undefined || positional.length > 2) return undefined;
  return { configPath, out, provisioned, paths };
}

const USAGE = "usage: settings.js <config.yaml> <settings.js> [--provisioned]"
  + " [--core-tree DIR] [--user-dir DIR] [--socket PATH] [--public-dir DIR]\n";

/**
 * Generate settings.js from a configuration file.
 *
 * The installer's route into this, so the file a freshly flashed board starts
 * with and the file the next apply writes come from the same function. Two
 * generators would be two things to keep in step, and the one that drifted
 * would be the one nobody runs until a board is in the field.
 */
function main(): void {
  const args = parseSettingsArgs(process.argv.slice(2));
  if (args === undefined) {
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }
  writeFileSync(args.out, renderSettings(loadConfig(args.configPath), {
    provisioned: args.provisioned,
    paths: args.paths,
  }));
  process.stdout.write(`wrote ${args.out} (${args.provisioned ? "provisioned" : "setup mode"})\n`);
}

// Compare file URLs rather than strings so a path with a space or a
// non-ASCII character still matches (see daemon/server.ts).
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) main();
