// SPDX-License-Identifier: GPL-3.0-or-later
import type { CommandRunner } from "./runner.js";

/** Reapply only when an active default route differs from the saved request. */
export async function routeMetricDiffers(runner: CommandRunner, device: string, wanted: number): Promise<boolean> {
  const replies = await Promise.all(([4, 6] as const).map(family =>
    runner(["ip", "-j", `-${family}`, "route", "show", "default", "dev", device])));
  return replies.map(reply => {
    if (reply.code !== 0) throw new Error("Could not verify active route metrics");
    const routes: unknown = JSON.parse(reply.stdout.trim() || "[]");
    if (!Array.isArray(routes)) throw new Error("Invalid active route observation");
    return routes.some(route => route?.dst === "default" && (route.metric ?? 0) !== wanted);
  }).some(Boolean);
}
