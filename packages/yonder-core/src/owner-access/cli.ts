// SPDX-License-Identifier: GPL-3.0-or-later
import { readlinkSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { AdminClient } from "../admin/client.js";
import { runOwnerSetup } from "./setup.js";
import { createOwnerTerminal } from "./terminal.js";

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--first-boot")) {
    throw new Error("Usage: yonder-owner-setup [--first-boot]");
  }
  if (process.platform !== "linux" || process.getuid?.() !== 0) throw new Error("Owner setup requires local root administration");
  // Only the directly attached virtual console gets an initial privileged
  // prompt. Serial, SSH and arbitrary redirected input cannot use this mode.
  if (args[0] === "--first-boot" && readlinkSync("/proc/self/fd/0") !== "/dev/tty1") {
    throw new Error("First-boot setup requires tty1");
  }
  const terminal = createOwnerTerminal(process.stdin, process.stdout);
  const client = new AdminClient();
  try {
    await runOwnerSetup({
      ownerState: () => client.ownerState(),
      ownerCreate: input => client.createOwner(input),
    }, terminal);
  } finally { client.close(); terminal.close(); }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch(() => {
    process.stderr.write("Yonder Linux setup stopped. Use the console for diagnostics or retry local setup.\n");
    process.exitCode = 1;
  });
}
