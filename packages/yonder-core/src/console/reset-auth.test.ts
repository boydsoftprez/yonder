// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConsoleAuth } from "./reset-auth.js";
it("stops the console before removing persisted editor tokens and always restarts it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yonder-auth-"));
  const path = join(dir, ".sessions.json"); await writeFile(path, '{"old":"token"}');
  const calls: string[][] = [];
  try {
    await resetConsoleAuth(async argv => {
      calls.push(argv);
      if (argv[1] === "stop") expect(await readFile(path, "utf8")).toContain("old");
      if (argv[1] === "start") await expect(readFile(path)).rejects.toThrow();
      return { code: 0, stdout: "", stderr: "" };
    }, "yonder-console.service", dir);
    expect(calls).toEqual([["systemctl", "stop", "yonder-console.service"], ["systemctl", "start", "yonder-console.service"]]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
