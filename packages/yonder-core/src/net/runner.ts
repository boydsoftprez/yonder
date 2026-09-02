// SPDX-License-Identifier: GPL-3.0-or-later
import { execFile } from "node:child_process";
// One list of secret-bearing names, shared with the daemon routes. Two
// lists is how one of them silently stops matching the other (R-SEC-10).
import { SECRET_KEYS, REDACTED, redactValues } from "../secrets/redact.js";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Every process execution in Yonder goes through one of these. Renderers take
 * a runner rather than calling child_process directly, so tests can assert on
 * the exact argv and return canned output without a real NetworkManager.
 */
export type CommandRunner = (argv: string[], opts?: CommandOptions) => Promise<CommandResult>;

/**
 * The few things a caller may vary about how a command is run.
 *
 * Only `env` so far, and deliberately only additions to it: a renderer says
 * which variables this one command needs, and everything else the daemon was
 * started with — PATH above all — is inherited unchanged. Replacing the
 * environment wholesale is how a child stops finding its own binaries.
 */
export interface CommandOptions {
  /** Merged over the daemon's own environment for this one child. */
  env?: Record<string, string>;
}

/**
 * The renderer logs what it ran so an operator can reproduce it by hand. That
 * log must never carry a pre-shared key.
 */
export function redactArgv(argv: string[]): string[] {
  const out = [...argv];
  for (let i = 0; i < out.length - 1; i++) {
    if (SECRET_KEYS.has(out[i])) out[i + 1] = REDACTED;
  }
  return out;
}

/** Every value this argv passed under a secret-bearing property name. */
function secretsIn(argv: string[]): string[] {
  const found: string[] = [];
  for (let i = 0; i < argv.length - 1; i++) {
    if (SECRET_KEYS.has(argv[i]) && argv[i + 1] !== "") found.push(argv[i + 1]);
  }
  return found;
}

/**
 * Strip from `text` any secret the accompanying argv carried.
 *
 * nmcli's diagnostics quote back what it could not accept, so the stderr of a
 * failed `connection modify … 802-11-wireless-security.psk <key>` can contain
 * that key — and that stderr travels inside an NmcliError, which reaches a
 * log and, before the router was fixed, an HTTP response body. Redacting by
 * *value* rather than by pattern is what makes this exact: the only secrets
 * that can appear are the ones we just passed, and we know what they were.
 */
export function redactText(text: string, argv: string[]): string {
  return redactValues(text, secretsIn(argv));
}

/** Never rejects: a non-zero exit is a result, not an exception. */
export const systemRunner: CommandRunner = (argv, opts) =>
  new Promise((resolve) => {
    const [cmd, ...args] = argv;
    // `env: undefined` is execFile's own "inherit", so the common case pays
    // nothing; a caller that asked for a variable gets the daemon's
    // environment with that variable laid over it.
    const env = opts?.env === undefined ? undefined : { ...process.env, ...opts.env };
    execFile(cmd, args, { encoding: "utf8", maxBuffer: 8 << 20, env }, (err, stdout, stderr) => {
      const code =
        err && typeof (err as NodeJS.ErrnoException & { code?: number }).code === "number"
          ? ((err as unknown as { code: number }).code)
          : err
            ? 127
            : 0;
      // execFile passes stdout/stderr as "" (not undefined) even when the
      // spawn itself fails (e.g. ENOENT for a missing binary), so a ?? here
      // would never reach the error message. Use || so an empty-but-defined
      // stderr still falls back to the error when the process never ran.
      resolve({ code, stdout: stdout ?? "", stderr: stderr || (err ? String(err.message) : "") });
    });
  });
