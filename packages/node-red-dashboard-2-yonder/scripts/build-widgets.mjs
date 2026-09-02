// SPDX-License-Identifier: GPL-3.0-or-later
//
// Build one UMD bundle per widget, from the manifest rather than from a list
// kept beside it. package.json's `node-red-dashboard-2.widgets` is what
// Dashboard reads at runtime; anything that enumerates widgets separately is
// a second list to forget to update, and the failure would be a widget that
// registers in Node-RED and renders as nothing on the page.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const widgets = pkg["node-red-dashboard-2"]?.widgets ?? {};
const entries = Object.entries(widgets);

if (entries.length === 0) {
  process.stderr.write("build-widgets: the manifest lists no widgets\n");
  process.exit(1);
}

for (const [type, { component, output }] of entries) {
  process.stdout.write(`build-widgets: ${component} -> dist/${output}\n`);
  execFileSync("npx", ["vite", "build", "--mode", "production"], {
    stdio: "inherit",
    env: { ...process.env, WIDGET: component, WIDGET_TYPE: type },
  });
}
