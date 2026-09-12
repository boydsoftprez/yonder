// SPDX-License-Identifier: GPL-3.0-or-later
import { runSensitiveProcess } from "../admin/sensitive-process.js";
import { validateOwnerPassword, validateOwnerPasswordHash } from "./model.js";

/** Native Linux shadow hashing; never reuse the console's application hash. */
export async function hashLinuxPassword(
  password: string,
  run: typeof runSensitiveProcess = runSensitiveProcess,
): Promise<string> {
  const plaintext = Buffer.from(`${validateOwnerPassword(password)}\n`, "utf8");
  try {
    const result = await run({
      command: "/usr/bin/mkpasswd", args: ["--method=yescrypt", "--stdin"],
      stdin: plaintext, timeoutMs: 10_000, maxOutputBytes: 1024,
    });
    try {
      return validateOwnerPasswordHash(result.stdout.toString("utf8").replace(/\n$/, ""));
    } finally { result.stdout.fill(0); }
  } finally { plaintext.fill(0); }
}
