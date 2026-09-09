// SPDX-License-Identifier: GPL-3.0-or-later
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import type { CommandRunner } from "../net/runner.js";

/** Node-RED persists editor tokens; restarting alone does not invalidate them. */
export async function resetConsoleAuth(runner: CommandRunner, unit: string, userDir: string): Promise<void> {
  const stopped = await runner(["systemctl", "stop", unit]);
  if (stopped.code !== 0) throw new Error("Could not stop console for session revocation");
  try {
    try { await unlink(join(userDir, ".sessions.json")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  } finally {
    const started = await runner(["systemctl", "start", unit]);
    if (started.code !== 0) throw new Error("Could not restart console after password change");
  }
}
