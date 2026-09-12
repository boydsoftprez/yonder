// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { runOwnerSetup } from "./setup.js";
const empty = { configured: false, username: null, sshEnabled: false, sshPasswordAuthentication: false, authorizedKeyFingerprints: [] };
function terminal(answers: string[]) {
  return { write: vi.fn(), read: vi.fn(async () => { if (!answers.length) throw Error("unexpected prompt"); return answers.shift()!; }) };
}
describe("local first-owner setup", () => {
  it("skips an already configured owner without prompting or changing it", async () => {
    const client = { ownerState: vi.fn(async () => ({ ...empty, configured: true, username: "pilot" })), ownerCreate: vi.fn() };
    const tty = terminal([]); await runOwnerSetup(client, tty);
    expect(tty.read).not.toHaveBeenCalled(); expect(client.ownerCreate).not.toHaveBeenCalled();
  });
  it("requires matching hidden passwords and never prints them", async () => {
    const client = { ownerState: vi.fn(async () => empty), ownerCreate: vi.fn(async () => ({ ...empty, configured: true, username: "pilot" })) };
    const tty = terminal(["pilot", "fixture-password", "different-password", "pilot", "fixture-password", "fixture-password"]);
    await runOwnerSetup(client, tty);
    expect(client.ownerCreate).toHaveBeenCalledTimes(1);
    expect(tty.read.mock.calls.filter(call => (call as unknown[])[1] === true)).toHaveLength(4);
    expect(JSON.stringify(tty.write.mock.calls)).not.toContain("fixture-password");
  });
  it("checks state after a lost reply without resubmitting the create", async () => {
    const client = { ownerState: vi.fn().mockResolvedValueOnce(empty).mockResolvedValueOnce({ ...empty, configured: true }), ownerCreate: vi.fn(async () => { throw Error("secret native detail"); }) };
    const tty = terminal(["pilot", "fixture-password", "fixture-password"]);
    await runOwnerSetup(client, tty);
    expect(client.ownerCreate).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(tty.write.mock.calls)).not.toContain("secret native detail");
  });
  it("allows blank-name cancellation without an account mutation", async () => {
    const client = { ownerState: vi.fn(async () => empty), ownerCreate: vi.fn() };
    await runOwnerSetup(client, terminal([""])); expect(client.ownerCreate).not.toHaveBeenCalled();
  });
});
