// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { commandProbe } from "./probe.js";
import type { CommandRunner } from "../runner.js";

describe("commandProbe", () => {
  it("sends real traffic out of the named device", async () => {
    // Bound to the device, not merely to the routing table: the question is
    // whether *this* path works, and the default route may be another one.
    const calls: string[][] = [];
    const runner: CommandRunner = async (argv) => {
      calls.push(argv);
      return { code: 0, stdout: "", stderr: "" };
    };
    expect(await commandProbe(runner)("wwan0")).toBe(true);
    expect(calls[0]).toContain("wwan0");
  });

  it("is false when the command fails", async () => {
    const runner: CommandRunner = async () => ({ code: 1, stdout: "", stderr: "timeout" });
    expect(await commandProbe(runner)("wwan0")).toBe(false);
  });

  it("is false rather than throwing when the binary is missing", async () => {
    const runner: CommandRunner = async () => ({ code: 127, stdout: "", stderr: "not found" });
    expect(await commandProbe(runner)("wwan0")).toBe(false);
  });
});
