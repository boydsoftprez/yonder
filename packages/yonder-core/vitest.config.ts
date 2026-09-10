// SPDX-License-Identifier: GPL-3.0-or-later
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  test: { environment: "node" },
  // Browser wire round trips run from source on a clean checkout, including
  // the Node 20 floor job that deliberately does not build dist first.
  resolve: { alias: {
    "yonder-core/cockpit-wire": fileURLToPath(new URL("./src/cockpit/flight-wire.ts", import.meta.url)),
    "yonder-core/terrain": fileURLToPath(new URL("./src/terrain/index.ts", import.meta.url)),
  } },
});
