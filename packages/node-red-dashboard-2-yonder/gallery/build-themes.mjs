// SPDX-License-Identifier: GPL-3.0-or-later
//
// Writes both palettes as real files, from `themeCss()` in yonder-core — the
// same generator ConsoleRenderer uses to write them onto a device, and the
// one `theme.test.ts` holds to its contract there. Nothing here restates a
// colour, a threshold or a font: this script only asks yonder-core for the
// whole shell and saves the answer.
//
// Written into `public/`, not beside this script or into the build output
// directly. `vite build` empties its output directory before it writes
// anything, and it wipes anything not emitted by the bundler — including a
// CSS file written there by an earlier step. `public/` is the one place
// Vite copies forward verbatim, as the last step of a build, which is what
// gets these two files into the built site rather than leaving it unstyled
// the moment somebody actually builds it (`package.json`'s "gallery" script
// runs this before `vite build` for exactly that reason).
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { PALETTES, themeCss } from "yonder-core";

const publicDir = fileURLToPath(new URL("./public/", import.meta.url));
mkdirSync(publicDir, { recursive: true });

for (const theme of Object.keys(PALETTES)) {
  const css = themeCss(theme);
  const file = join(publicDir, `theme.${theme}.css`);
  writeFileSync(file, css);
  process.stdout.write(`build-themes: wrote theme.${theme}.css (${css.length} bytes)\n`);
}
