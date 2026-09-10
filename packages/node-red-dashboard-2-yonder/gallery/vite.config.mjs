// SPDX-License-Identifier: GPL-3.0-or-later
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath } from "node:url";

/**
 * Ported from the blueprint at
 * docs/console/design/instrument-library/gallery/vite.config.mjs, with one
 * change: `yonder-core/presentation` resolves to source here, not to
 * `packages/yonder-core`'s built output, for the same reason
 * `vitest.config.ts` beside this file does the same thing — CI, and a
 * contributor's own checkout, can run this before yonder-core has been
 * built, and a build that resolved to whatever was already on disk would
 * silently show a stale render on a checkout where yonder-core had just
 * changed. R-UI-25 is the requirement that a stale render is not evidence;
 * this is that rule applied to the one non-component import these
 * instruments make.
 *
 * `base: "./"` — a relocatable site, openable from a plain static file
 * server on any path or port, not only from the server root.
 */
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  plugins: [vue()],
  resolve: {
    alias: {
      "yonder-core/presentation": fileURLToPath(
        new URL("../../yonder-core/src/console/presentation.ts", import.meta.url),
      ),
    },
  },
});
