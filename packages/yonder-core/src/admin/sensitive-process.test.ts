// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { runSensitiveProcess, SensitiveProcessError } from "./sensitive-process.js";

describe("private native process boundary (R-SEC-10/14)", () => {
  it("sends sensitive input only through stdin and does not inherit the helper environment", async () => {
    process.env.YONDER_PRIVATE_TEST_SECRET = "must-not-inherit";
    const secret = "private-input-do-not-log";
    try {
      const result = await runSensitiveProcess({ command: process.execPath, args: ["-e", `
        const chunks=[]; process.stdin.on('data', c => chunks.push(c));
        process.stdin.on('end', () => process.stdout.write(JSON.stringify({
          input: Buffer.concat(chunks).toString(), argv: process.argv, env: process.env
        })));
      `], stdin: secret });
      const observed = JSON.parse(result.stdout.toString());
      expect(observed.input).toBe(secret);
      expect(JSON.stringify(observed.argv)).not.toContain(secret);
      expect(observed.env.YONDER_PRIVATE_TEST_SECRET).toBeUndefined();
      expect(observed.env.LC_ALL).toBe("C");
    } finally { delete process.env.YONDER_PRIVATE_TEST_SECRET; }
  });

  it("discards native diagnostics, even if a failed tool echoes its secret input", async () => {
    let error: unknown;
    try {
      await runSensitiveProcess({ command: process.execPath, args: ["-e", `
        process.stdin.on('data', c => { process.stdout.write(c); process.stderr.write(c); });
        process.stdin.on('end', () => { process.exitCode=7; });
      `], stdin: "private-password-value" });
    } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(SensitiveProcessError);
    expect((error as SensitiveProcessError).code).toBe("COMMAND_FAILED");
    expect(String(error)).not.toContain("private-password-value");
    expect(JSON.stringify(error)).not.toContain("private-password-value");
    expect((error as Error).cause).toBeUndefined();
  });

  it("bounds combined stdout/stderr instead of retaining unlimited diagnostics", async () => {
    await expect(runSensitiveProcess({ command: process.execPath, args: ["-e",
      "process.stderr.write(Buffer.alloc(4096)); setInterval(()=>{},1000)"], maxOutputBytes: 1024,
    })).rejects.toMatchObject({ code: "OUTPUT_LIMIT" });
  });

  it("times out a process and its descendants holding stdout open", async () => {
    await expect(runSensitiveProcess({ command: process.execPath, args: ["-e", `
      require('child_process').spawn(process.execPath, ['-e','setInterval(()=>{},1000)'], {stdio:'inherit'});
      process.exit(0);
    `], timeoutMs: 150 })).rejects.toMatchObject({ code: "TIMED_OUT" });
  });

  it("sanitizes spawn failure and refuses relative commands or unbounded requests", async () => {
    await expect(runSensitiveProcess({ command: "/no-such-private-native-tool", args: [] }))
      .rejects.toMatchObject({ code: "START_FAILED" });
    await expect(runSensitiveProcess({ command: "chpasswd", args: [] }))
      .rejects.toMatchObject({ code: "INVALID_COMMAND" });
    await expect(runSensitiveProcess({ command: process.execPath, args: [], timeoutMs: 0 }))
      .rejects.toMatchObject({ code: "INVALID_COMMAND" });
    await expect(runSensitiveProcess({ command: process.execPath, args: [], stdin: Buffer.alloc(1024 * 1024 + 1) }))
      .rejects.toMatchObject({ code: "INVALID_COMMAND" });
  });
});
