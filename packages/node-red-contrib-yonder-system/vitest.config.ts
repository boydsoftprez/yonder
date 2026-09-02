// SPDX-License-Identifier: GPL-3.0-or-later
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * `yonder-core` resolved from source, not from `dist/`.
 *
 * At runtime on a device these nodes require the built package through
 * node_modules, which is what the installer arranges. In a test that would
 * mean the suite could only run after a build — and CI runs the tests first,
 * deliberately, so a compile error is found by `npm run build` rather than
 * hidden behind a stale `dist/`. Pointing the alias at the TypeScript removes
 * the ordering question entirely.
 */
export default defineConfig({
  test: { environment: "node" },
  resolve: {
    alias: {
      "yonder-core/presentation": fileURLToPath(
        new URL("../yonder-core/src/console/presentation.ts", import.meta.url),
      ),
      "yonder-core": fileURLToPath(new URL("../yonder-core/src/index.ts", import.meta.url)),
    },
  },
});
