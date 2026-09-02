// SPDX-License-Identifier: GPL-3.0-or-later
//
// Carry every `assets/` directory under src/ into the built tree.
//
// `tsc` copies only what it compiles, so a console built from dist/ would
// start, bind its port, and answer every request with a stack trace about a
// missing setup.html. The failure would appear on hardware, after a flash,
// because nothing that runs from src/ can see it — which is exactly the
// class of defect the installer's assert_module_graph was written for.
//
// Node rather than `cp -r` so the build script is one thing on every host,
// and so it can say what it copied.
import { cpSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, "src");
const dist = join(root, "dist");

/** Every directory named `assets` under src/, at any depth. */
function assetDirs(from) {
  const found = [];
  for (const entry of readdirSync(from)) {
    const full = join(from, entry);
    if (!statSync(full).isDirectory()) continue;
    if (entry === "assets") found.push(full);
    else found.push(...assetDirs(full));
  }
  return found;
}

if (!existsSync(dist)) {
  process.stderr.write("copy-assets: there is no dist/ to copy into; run tsc first\n");
  process.exit(1);
}

for (const dir of assetDirs(src)) {
  const target = join(dist, relative(src, dir));
  cpSync(dir, target, { recursive: true });
  process.stdout.write(`copy-assets: ${relative(root, dir)} -> ${relative(root, target)}\n`);
}
