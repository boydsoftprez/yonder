// SPDX-License-Identifier: GPL-3.0-or-later
// Disposable Linux-only ZeroTier identity integration. Never uses host /etc or /var.
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ZeroTierStateAdapter } from "../dist/recovery/zerotier.js";
import { runSensitiveProcess } from "../dist/admin/sensitive-process.js";

assert(process.platform === "linux" && process.getuid() === 0 && existsSync("/.dockerenv"));
const root = "/lab/zerotier-integration", stateDirectory = join(root, "state"), scratchDirectory = join(root, "scratch");
const idtool = "/lab/package/usr/sbin/zerotier-idtool", fakeCli = "/lab/fixed/zerotier-cli", fakeSystemctl = "/lab/fixed/systemctl", fakeEnv = "/lab/fixed/env";
assert(existsSync(idtool));
mkdirSync(stateDirectory, { recursive: true, mode: 0o700 }); mkdirSync(scratchDirectory, { mode: 0o700 });
mkdirSync("/lab/fixed", { mode: 0o700 });
for (const file of [fakeCli, fakeSystemctl, fakeEnv]) writeFileSync(file, "fixed test endpoint", { mode: 0o700 });
let active = true, enabled = false, failList = false;
const native = { async run(rawCommand, rawArgs) {
  let command = rawCommand, args = rawArgs;
  if (command === fakeEnv) { command = args[1]; args = args.slice(2); }
  if (command === idtool) return (await runSensitiveProcess({ command, args })).stdout;
  if (command === fakeSystemctl) {
    if (args[0] === "show") return Buffer.from(args.includes("--property=ActiveState") ? (active ? "active\n" : "inactive\n") : (enabled ? "enabled\n" : "disabled\n"));
    if (args[0] === "stop") active = false;
    if (args[0] === "start") active = true;
    if (args[0] === "enable") enabled = true;
    if (args[0] === "disable") enabled = false;
    return Buffer.alloc(0);
  }
  if (command === fakeCli) {
    if (failList) throw new Error("injected native verification failure");
    return Buffer.from(JSON.stringify(readdirSync(join(stateDirectory, "networks.d"))
      .filter(name => /^[0-9a-f]{16}\.conf$/.test(name)).map(name => ({ nwid: name.slice(0, 16) }))));
  }
  throw new Error("unexpected fixed command");
} };
const adapter = new ZeroTierStateAdapter({ stateDirectory, scratchDirectory, idtoolPath: idtool,
  cliPath: fakeCli, systemctlPath: fakeSystemctl, envPath: fakeEnv, native, expectedUid: 0, clientWaitMs: 0 });

async function generate(prefix) {
  const folder = join(root, prefix); mkdirSync(folder, { mode: 0o700 });
  const secret = join(folder, "identity.secret"), publicPath = join(folder, "identity.public");
  await runSensitiveProcess({ command: idtool, args: ["generate", secret, publicPath], timeoutMs: 60_000 });
  chmodSync(secret, 0o600); chmodSync(publicPath, 0o600);
  return { identitySecret: readFileSync(secret, "utf8").trim(), identityPublic: readFileSync(publicPath, "utf8").trim() };
}

const first = await generate("first");
copyFileSync(join(root, "first", "identity.secret"), join(stateDirectory, "identity.secret"));
copyFileSync(join(root, "first", "identity.public"), join(stateDirectory, "identity.public"));
chmodSync(join(stateDirectory, "identity.secret"), 0o600); chmodSync(join(stateDirectory, "identity.public"), 0o644);
mkdirSync(join(stateDirectory, "networks.d"), { mode: 0o700 });
writeFileSync(join(stateDirectory, "networks.d", "aaaaaaaaaaaaaaaa.conf"), "", { mode: 0o600 });
const captured = await adapter.capture();
assert.deepEqual(captured, { ...first, memberships: [{ networkId: "aaaaaaaaaaaaaaaa" }] });
assert.deepEqual({ active, enabled }, { active: true, enabled: false });

const second = await generate("second");
failList = true;
await assert.rejects(adapter.apply({ operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  previous: { config: {}, secrets: {}, linuxOwner: null, zeroTier: captured },
  next: { config: {}, secrets: {}, linuxOwner: null,
    zeroTier: { ...second, memberships: [{ networkId: "bbbbbbbbbbbbbbbb" }] } }, context: "activation" }));
assert.equal(readFileSync(join(stateDirectory, "identity.secret"), "utf8"), first.identitySecret);
assert.deepEqual(readdirSync(join(stateDirectory, "networks.d")).filter(name => name.endsWith(".conf")), ["aaaaaaaaaaaaaaaa.conf"]);
assert.deepEqual({ active, enabled }, { active: true, enabled: false });

const recovered = { ...second, memberships: [{ networkId: "bbbbbbbbbbbbbbbb" }, { networkId: "cccccccccccccccc" }] };
for (const cut of ["secret", "public", "membership"]) {
  active = false; enabled = false; failList = false;
  rmSync(stateDirectory, { recursive: true, force: true }); mkdirSync(stateDirectory, { mode: 0o700 });
  copyFileSync(join(root, "second", "identity.secret"), join(stateDirectory, "identity.secret"));
  chmodSync(join(stateDirectory, "identity.secret"), 0o600);
  if (cut !== "secret") {
    copyFileSync(join(root, "second", "identity.public"), join(stateDirectory, "identity.public"));
    chmodSync(join(stateDirectory, "identity.public"), 0o644);
  }
  if (cut === "membership") {
    mkdirSync(join(stateDirectory, "networks.d"), { mode: 0o700 });
    writeFileSync(join(stateDirectory, "networks.d", "bbbbbbbbbbbbbbbb.conf"), "", { mode: 0o600 });
  }
  await adapter.apply({ operationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    previous: { config: {}, secrets: {}, linuxOwner: null, zeroTier: recovered },
    next: { config: {}, secrets: {}, linuxOwner: null, zeroTier: recovered }, context: "recovery" });
  assert.equal(readFileSync(join(stateDirectory, "identity.secret"), "utf8"), recovered.identitySecret);
  assert.equal(readFileSync(join(stateDirectory, "identity.public"), "utf8"), recovered.identityPublic);
  assert.deepEqual(readdirSync(join(stateDirectory, "networks.d")).filter(name => name.endsWith(".conf")).sort(),
    ["bbbbbbbbbbbbbbbb.conf", "cccccccccccccccc.conf"]);
  assert.deepEqual({ active, enabled }, { active: true, enabled: true });
}
process.stdout.write("PASS: pinned ZeroTier idtool validated capture, activation rollback, and authoritative recovery after each identity/membership write boundary.\n");
