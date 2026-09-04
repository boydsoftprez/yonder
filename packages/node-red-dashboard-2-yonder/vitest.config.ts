// SPDX-License-Identifier: GPL-3.0-or-later
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";

/**
 * `yonder-core` from source, for the reason its sibling packages do: CI runs
 * the tests before the build, so resolving through `dist/` would either fail
 * on a clean checkout or pass against something stale.
 *
 * The Vue plugin lets a test import a `.vue` file directly, the same way
 * `vite.config.js` lets the widget build do it. Everything under `src/ui/`
 * runs against `jsdom` rather than `node`: jsdom over `happy-dom` because
 * this is a handful of files exercising `dispatchEvent`, `preventDefault`
 * and an own-property override of `document.hidden` (see
 * `holdkey.component.test.ts`), and jsdom is the more spec-faithful of the
 * two on exactly those primitives — a suite this small has nothing to gain
 * from happy-dom's speed. The rest of this package's tests — `nodes.test.ts`,
 * registering widgets against a fake Node-RED — need no DOM at all and stay
 * on the cheaper default.
 */
export default defineConfig({
  plugins: [vue()],
  test: {
    environment: "node",
    environmentMatchGlobs: [["src/ui/**", "jsdom"]],
  },
  resolve: {
    alias: {
      "yonder-core/presentation": fileURLToPath(
        new URL("../yonder-core/src/console/presentation.ts", import.meta.url),
      ),
      "yonder-core": fileURLToPath(new URL("../yonder-core/src/index.ts", import.meta.url)),
    },
  },
});
