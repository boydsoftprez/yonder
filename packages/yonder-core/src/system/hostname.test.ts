// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { HostnameRenderer } from "./hostname.js";
import { ConfigSchema, DEFAULT_CONFIG } from "../schema/config.js";
import type { Config } from "../schema/config.js";
import type { CommandResult, CommandRunner } from "../net/runner.js";

/** No test executes `hostnamectl`; every one of them injects a runner. */
function harness(opts: { current?: string | null; result?: Partial<CommandResult> } = {}) {
  const calls: string[][] = [];
  const lines: string[] = [];
  const runner: CommandRunner = (argv) => {
    calls.push(argv);
    return Promise.resolve({ code: 0, stdout: "", stderr: "", ...opts.result });
  };
  const renderer = new HostnameRenderer({
    runner,
    read: () => opts.current ?? null,
    log: (l) => lines.push(l),
    hostnameFile: "/nowhere/hostname",
  });
  return { renderer, calls, lines };
}

function named(hostname: string): Config {
  const config = structuredClone(DEFAULT_CONFIG);
  config.system.hostname = hostname;
  return config;
}

describe("HostnameRenderer", () => {
  it("sets the hostname the configuration asks for", async () => {
    const { renderer, calls } = harness({ current: "raspberrypi\n" });
    await renderer.render(named("yonder"));
    expect(calls).toEqual([["hostnamectl", "set-hostname", "yonder"]]);
  });

  /**
   * Idempotent by comparison rather than by hoping the command is. This runs
   * on every apply and every start-up render, and setting the hostname is not
   * free — hostnamed signals the change and NetworkManager may re-send it
   * over DHCP.
   */
  it("does nothing when the name is already right", async () => {
    const { renderer, calls, lines } = harness({ current: "yonder\n" });
    await renderer.render(named("yonder"));
    expect(calls).toEqual([]);
    expect(lines.join("\n")).toContain("already yonder");
  });

  it("sets it on a board whose /etc/hostname is missing entirely", async () => {
    const { renderer, calls } = harness({ current: null });
    await renderer.render(named("yonder"));
    expect(calls).toEqual([["hostnamectl", "set-hostname", "yonder"]]);
  });

  /**
   * **Never fails a render.** Renderers run in sequence and a failure stops
   * the ones behind it and rolls the apply back (K-19), so a board with no
   * `hostnamectl` would otherwise have every network change it will ever be
   * sent rejected because of a name. A device that cannot be reconfigured is
   * the failure rule 6 is about; a device with the wrong name is an
   * inconvenience.
   */
  it("does not fail the render when hostnamectl refuses", async () => {
    const { renderer, lines } = harness({
      current: "raspberrypi",
      result: { code: 1, stderr: "Could not set property: Access denied" },
    });
    await expect(renderer.render(named("yonder"))).resolves.toBeUndefined();
    expect(lines.join("\n")).toContain("could not set it to yonder");
  });

  it("does not fail the render on a board with no hostnamectl at all", async () => {
    // `systemRunner` reports a missing executable as exit 127.
    const { renderer } = harness({ current: "raspberrypi", result: { code: 127 } });
    await expect(renderer.render(named("yonder"))).resolves.toBeUndefined();
  });

  /**
   * The value goes on a command line. It is safe there by construction — the
   * schema holds it to /^[a-z0-9][a-z0-9-]{0,62}$/ — and this is the test that
   * says the schema is what makes that true, so a loosening fails here rather
   * than in the field.
   */
  it("cannot be handed something that is not a hostname", () => {
    for (const hostname of [
      "-flag", "a name with spaces", "UPPER", "has_underscore", "../etc/passwd",
      "a".repeat(64), "", "yonder;reboot", "$(whoami)",
    ]) {
      const config = structuredClone(DEFAULT_CONFIG) as unknown as Record<string, unknown>;
      config.system = { hostname, timezone: "UTC" };
      expect(ConfigSchema.safeParse(config).success, hostname).toBe(false);
    }
    expect(ConfigSchema.safeParse({
      ...structuredClone(DEFAULT_CONFIG),
      system: { hostname: "yonder-2", timezone: "UTC" },
    }).success).toBe(true);
  });
});
