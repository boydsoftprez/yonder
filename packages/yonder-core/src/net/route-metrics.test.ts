// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, it } from "vitest";
import { routeMetricDiffers } from "./route-metrics.js";
it("reapplies a changed default metric in either family, leaving healthy and LAN-only links alone", async () => {
  const runner = (v4: unknown, v6: unknown) => async (argv: string[]) => ({ code: 0, stderr: "", stdout: JSON.stringify(argv.includes("-4") ? v4 : v6) });
  const current = [{ dst: "default", dev: "wwan0", metric: 700 }];
  expect(await routeMetricDiffers(runner(current, current), "wwan0", 700)).toBe(false);
  expect(await routeMetricDiffers(runner(current, current), "wwan0", 100)).toBe(true);
  expect(await routeMetricDiffers(runner([], current), "wwan0", 100)).toBe(true);
  expect(await routeMetricDiffers(runner([], []), "eth0", 100)).toBe(false);
});
it("fails an unverifiable route update instead of pretending it applied", async () => {
  await expect(routeMetricDiffers(async () => ({ code: 1, stdout: "", stderr: "" }), "eth0", 100)).rejects.toThrow();
});
