// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtempSync, readFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MediaRenderer } from "./renderer.js";
import { SecretStore } from "../secrets/store.js";
import { ConfigSchema } from "../schema/config.js";
import type { CommandRunner, CommandResult } from "../net/runner.js";

function bench(answer: (argv: string[]) => CommandResult = () => ({ code: 0, stdout: "", stderr: "" })) {
  const dir = mkdtempSync(join(tmpdir(), "yonder-media-"));
  const argvs: string[][] = [];
  const lines: string[] = [];
  const runner: CommandRunner = async (argv) => { argvs.push(argv); return answer(argv); };
  const secrets = new SecretStore(join(dir, "secrets.yaml"));
  const path = join(dir, "mediamtx.yml");
  const make = () => new MediaRenderer({ path, runner, secrets, log: (l) => lines.push(l) });
  return { dir, argvs, lines, runner, secrets, path, make };
}
const ran = (argvs: string[][], words: string) => argvs.some((a) => a.join(" ").includes(words));

const CFG = ConfigSchema.parse({
  version: 1, network: { ap: { psk: { secret: "ap_psk" } } }, ui: { editor: {} },
  cameras: [{
    id: "cam0", name: "Nose", source: "usb", device: "usb-1",
    outputs: [{ kind: "rtsp", password: { secret: "rtsp_password" } }],
  }],
});
const NO_CAMERA = ConfigSchema.parse({
  version: 1, network: { ap: { psk: { secret: "ap_psk" } } }, ui: { editor: {} },
});

describe("MediaRenderer", () => {
  it("generates the RTSP credential once, per device", async () => {
    const b = bench();
    const r = b.make();
    await r.render(CFG);
    const first = b.secrets.get("rtsp_password");
    expect(first).toBeTruthy();
    await r.render(CFG);
    expect(b.secrets.get("rtsp_password")).toBe(first);
    const observer = b.secrets.get('media_observer_password');
    expect(observer).toBeTruthy();
    expect(observer).not.toBe(first);
    await r.render(CFG);
    expect(b.secrets.get('media_observer_password')).toBe(observer);
    expect(b.lines.join('\n')).not.toContain(observer);
  });

  it("generates no credential at all on a device with no camera", async () => {
    // R-SEC-07: a published image carries no credential material, and an
    // image is exactly a device with nothing configured. A secret generated
    // for a listener that is not running is a secret nothing needed.
    const b = bench();
    await b.make().render(NO_CAMERA);
    expect(b.secrets.get("rtsp_password")).toBeUndefined();
  });

  it("writes the file where mediamtx reads it, and starts the service", async () => {
    const b = bench();
    await b.make().render(CFG);
    expect(existsSync(b.path)).toBe(true);
    expect(readFileSync(b.path, "utf8")).toContain("rtspAddress");
    expect(ran(b.argvs, "restart mediamtx")).toBe(true);
  });

  it("keeps the credential out of every account but the one that serves it", async () => {
    // R-SEC-10. This file carries the RTSP password in clear, so it is not
    // world-readable: the group is the media server's own account and nothing
    // else on the device can read it.
    const b = bench();
    await b.make().render(CFG);
    expect(statSync(b.path).mode & 0o777).toBe(0o640);
  });

  it("enables the unit, or a reboot is a device with no video", async () => {
    // The installer ships mediamtx installed and off, and nothing else on the
    // device ever starts it. A `restart` alone brings it up now and not after
    // the next boot — and the render that runs at the next boot finds the file
    // unchanged and correctly does nothing, so the picture would never come
    // back. Enabling is what makes "the service follows the configuration"
    // survive a power cycle.
    const b = bench();
    await b.make().render(CFG);
    expect(ran(b.argvs, "enable mediamtx")).toBe(true);
  });

  it("does not restart the service when nothing changed", async () => {
    const b = bench();
    const r = b.make();
    await r.render(CFG);
    const after = b.argvs.length;
    await r.render(CFG);
    expect(b.argvs.length).toBe(after);
  });

  it("stops the service when the last camera goes", async () => {
    // Nothing to serve is not a reason to keep a listener open.
    const b = bench();
    const r = b.make();
    await r.render(CFG);
    const before = b.argvs.length;
    await r.render(NO_CAMERA);
    const after = b.argvs.slice(before);
    expect(ran(after, "stop mediamtx")).toBe(true);
    expect(ran(after, "disable mediamtx")).toBe(true);
  });

  it("touches nothing at all on a device that has never had a camera", async () => {
    // The branch a default device takes on every single apply. Acting here is
    // how a service somebody else set up goes away — the narrowness the mesh
    // renderer needed after a palette change stopped a client Yonder had
    // never started, on a device an operator was reaching over it.
    const b = bench();
    await b.make().render(NO_CAMERA);
    expect(b.argvs).toEqual([]);
  });

  it("takes the generated configuration away with the last camera", async () => {
    // Not tidiness, and not only R-SEC-10 keeping a credential off a disk that
    // needs none. Leaving the file behind makes the *next* camera invisible:
    // the same camera configured again renders byte-identical YAML, the
    // unchanged-file check returns early, and the service that was stopped and
    // disabled here is never started again.
    const b = bench();
    const r = b.make();
    await r.render(CFG);
    await r.render(NO_CAMERA);
    expect(existsSync(b.path)).toBe(false);
    const before = b.argvs.length;
    await r.render(CFG);
    expect(ran(b.argvs.slice(before), "restart mediamtx")).toBe(true);
  });

  it("fails the apply when the service will not start", async () => {
    // A render that reported success while the media server was down would be
    // an operator watching a console that says the camera is configured, with
    // no picture and nothing anywhere saying why.
    const b = bench((argv) => argv.includes("restart")
      ? { code: 1, stdout: "", stderr: "Job for mediamtx.service failed" }
      : { code: 0, stdout: "", stderr: "" });
    await expect(b.make().render(CFG)).rejects.toThrow(/mediamtx/);
  });

  it("says what the service said, not merely that it failed", async () => {
    const b = bench((argv) => argv.includes("restart")
      ? { code: 1, stdout: "", stderr: "Job for mediamtx.service failed; see journalctl -xeu" }
      : { code: 0, stdout: "", stderr: "" });
    await expect(b.make().render(CFG)).rejects.toThrow(/journalctl/);
  });

  it("does not fail every apply on a device whose payload carried no media server", async () => {
    // R-CFG-08. A device with no camera and no mediamtx is a perfectly valid
    // device; asking systemd to stop a unit it has never heard of must not
    // break an apply that has nothing to do with video.
    const b = bench(() => ({ code: 1, stdout: "", stderr: "Failed to stop mediamtx.service: Unit mediamtx.service not loaded." }));
    writeFileSync(b.path, "logLevel: info\n", { mode: 0o640 });
    await expect(b.make().render(NO_CAMERA)).resolves.toBeUndefined();
  });

  it("still fails when the unit is there and refuses to stop", async () => {
    const b = bench(() => ({ code: 1, stdout: "", stderr: "Failed to stop mediamtx.service: Access denied" }));
    writeFileSync(b.path, "logLevel: info\n", { mode: 0o640 });
    await expect(b.make().render(NO_CAMERA)).rejects.toThrow(/Access denied/);
  });

  it("never puts the credential in a log line", async () => {
    // R-SEC-10, checked rather than trusted: this renderer holds the password
    // in a variable and writes it to one file, and everything it says about
    // what it did has to stay clear of it.
    const b = bench();
    await b.make().render(CFG);
    const password = b.secrets.get("rtsp_password");
    expect(password).toBeTruthy();
    for (const line of b.lines) expect(line).not.toContain(password);
    for (const argv of b.argvs) expect(argv.join(" ")).not.toContain(password);
  });

  it("rewrites a file an operator has edited by hand", async () => {
    // One declarative file is the only writer. A device whose media server was
    // hand-edited is a device whose listeners are not the ones config.yaml
    // describes, so the next apply puts them back.
    const b = bench();
    const r = b.make();
    await r.render(CFG);
    writeFileSync(b.path, "rtmp: true\n", { mode: 0o640 });
    await r.render(CFG);
    expect(readFileSync(b.path, "utf8")).toContain("rtmp: false");
  });
});
