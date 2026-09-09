// SPDX-License-Identifier: GPL-3.0-or-later
// Run after building yonder-core. The console and exports share one drawing.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { brandSvg } from "../packages/yonder-core/dist/console/brand.js";
import { renderPage } from "../packages/yonder-core/dist/console/assets.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "brand", "approved");
mkdirSync(root, { recursive: true });
const exports = [
  ["yonder.svg", { treatment: "material" }],
  ["yonder-night.svg", { treatment: "material", theme: "night" }],
  ["yonder-solid.svg", {}],
  ["yonder-solid-night.svg", { theme: "night" }],
  ["yonder-outline.svg", { treatment: "outline" }],
  ["yonder-mark.svg", { treatment: "material", markOnly: true }],
  ["yonder-mark-night.svg", { treatment: "material", markOnly: true, theme: "night" }],
];
for (const [name, options] of exports) {
  const svg = brandSvg({ width: options.markOnly ? 468 : 1325, ...options });
  writeFileSync(join(root, name), `<!-- SPDX-License-Identifier: GPL-3.0-or-later -->\n${svg}\n`);
}
// A nonfunctional copy for reviewing the actual served login in the brand kit.
const login = renderPage("login")
  .replace('<title>Yonder — sign in</title>', '<title>Yonder — login design preview</title>')
  .replace('required autofocus', 'disabled')
  .replace('<button type="submit">', '<button type="button" disabled>')
  .replace(/[\t ]+$/gm, "");
writeFileSync(join(root, "login.html"), login);
process.stdout.write(`export-brand: ${exports.length} SVGs and the login preview\n`);
