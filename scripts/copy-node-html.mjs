// SPDX-License-Identifier: GPL-3.0-or-later
//
// Carry a contrib package's node `.html` files into its built tree.
//
// Node-RED finds a node's editor definition by looking for a `.html` file with
// the same basename, in the same directory, as the `.js` the package's
// `node-red.nodes` map names. `tsc` compiles the `.ts` and copies nothing, so
// a built package would register its nodes at runtime and show every one of
// them as "unknown node" in the flow editor — a failure that appears only once
// somebody opens the editor on a board.
//
// Run from a package directory: `node ../../scripts/copy-node-html.mjs`.
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

const src = join(process.cwd(), "src");
const dist = join(process.cwd(), "dist");

if (!existsSync(dist)) {
  process.stderr.write("copy-node-html: there is no dist/ to copy into; run tsc first\n");
  process.exit(1);
}

mkdirSync(dist, { recursive: true });
for (const entry of readdirSync(src)) {
  if (!entry.endsWith(".html")) continue;
  copyFileSync(join(src, entry), join(dist, entry));
  process.stdout.write(`copy-node-html: src/${entry} -> dist/${entry}\n`);
}
