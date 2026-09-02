// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { note, warn, trace } from "./log.js";
import { activityLog } from "./log/activity.js";

/**
 * The activity pane is a product surface; the journal is the diagnostic one.
 *
 * They were the same. `buildRenderers` handed one logger to both the network
 * renderer and the nmcli client, so every command line landed in the buffer
 * the console shows — and once a status line began polling every few seconds,
 * an operator watching for what their Join did saw
 * `nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device status`, twice a tick,
 * instead of anything about their Join.
 */
describe("what reaches the activity log", () => {
  beforeEach(() => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  function messages(): string[] {
    return activityLog.page(0).entries.map((e) => e.message);
  }

  it("keeps a note, which is something an operator acts on", () => {
    note("network: bringing the access point up");
    expect(messages()).toContain("network: bringing the access point up");
  });

  it("keeps a warning", () => {
    warn("the wifi client did not come up");
    expect(messages()).toContain("the wifi client did not come up");
  });

  it("does not keep a trace, which is a command line", () => {
    const command = "nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device status";
    trace(command);
    expect(messages()).not.toContain(command);
  });

  it("still writes a trace out, so the journal has it", () => {
    const command = "nmcli connection up yonder-ap";
    trace(command);
    expect(process.stdout.write).toHaveBeenCalledWith(`${command}\n`);
  });
});
