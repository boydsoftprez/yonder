// SPDX-License-Identifier: GPL-3.0-or-later
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * `yonder-core` from source, for the reason its sibling packages do: CI runs
 * the tests before the build, so resolving through `dist/` would either fail
 * on a clean checkout or pass against something stale.
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
