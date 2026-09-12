// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

export type SensitiveProcessErrorCode = "INVALID_COMMAND" | "START_FAILED" | "INPUT_FAILED" | "TIMED_OUT" | "OUTPUT_LIMIT" | "COMMAND_FAILED";

/** Deliberately contains no native command output, arguments, input, or cause. */
export class SensitiveProcessError extends Error {
  constructor(readonly code: SensitiveProcessErrorCode) {
    super(`Linux account operation failed (${code})`);
    this.name = "SensitiveProcessError";
  }
}

/**
 * For statically chosen native operations in the root helper only. This is not an
 * RPC command runner: never populate command/args from a request or put secrets
 * there. Successful stdout is private (e.g. a shadow hash), not an API response.
 */
export function runSensitiveProcess(input: {
  command: string;
  args: readonly string[];
  stdin?: string | Buffer;
  timeoutMs?: number;
  maxOutputBytes?: number;
}): Promise<{ stdout: Buffer }> {
  const timeoutMs = input.timeoutMs ?? 10_000;
  const maxOutputBytes = input.maxOutputBytes ?? 64 * 1024;
  if (!isAbsolute(input.command) || input.command.includes("\0")
    || input.args.some(arg => typeof arg !== "string" || arg.includes("\0"))
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000
    || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 1024 * 1024
    || (input.stdin !== undefined && Buffer.byteLength(input.stdin) > 1024 * 1024)) {
    return Promise.reject(new SensitiveProcessError("INVALID_COMMAND"));
  }
  const privateInput = Buffer.from(input.stdin ?? "");
  const hasInput = input.stdin !== undefined;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(input.command, [...input.args], {
        shell: false,
        detached: process.platform !== "win32",
        stdio: [hasInput ? "pipe" : "ignore", "pipe", "pipe"],
        env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C" },
      });
    } catch {
      privateInput.fill(0);
      reject(new SensitiveProcessError("START_FAILED"));
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: SensitiveProcessErrorCode | undefined;
    let settled = false;
    const fail = (code: SensitiveProcessErrorCode) => {
      if (settled) return;
      failure ??= code;
      // Kill the private process group, including a native tool's descendants.
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { /* Already exited. The close/error events settle the request. */ }
    };
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      privateInput.fill(0);
      if (failure || code !== 0) {
        for (const chunk of chunks) chunk.fill(0);
        reject(new SensitiveProcessError(failure ?? "COMMAND_FAILED"));
      } else {
        const stdout = Buffer.concat(chunks);
        for (const chunk of chunks) chunk.fill(0);
        resolve({ stdout });
      }
    };
    const receive = (chunk: Buffer, keep: boolean) => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) fail("OUTPUT_LIMIT");
      if (keep && !failure) chunks.push(Buffer.from(chunk));
      chunk.fill(0);
    };
    const timer = setTimeout(() => fail("TIMED_OUT"), timeoutMs);
    child.stdout!.on("data", (chunk: Buffer) => receive(chunk, true));
    child.stderr!.on("data", (chunk: Buffer) => receive(chunk, false));
    child.on("error", () => { failure ??= "START_FAILED"; finish(null); });
    child.on("close", finish);
    child.stdin?.on("error", () => fail("INPUT_FAILED"));
    child.stdin?.end(privateInput, () => privateInput.fill(0));
  });
}
