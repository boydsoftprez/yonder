// SPDX-License-Identifier: GPL-3.0-or-later
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import type { ReadStream, WriteStream } from "node:tty";
import type { OwnerSetupTerminal } from "./setup.js";

/** Keep password echo and readline history off. No credentials enter argv. */
export function createOwnerTerminal(input: ReadStream, output: WriteStream): OwnerSetupTerminal & { close(): void } {
  if (!input.isTTY || !output.isTTY) throw new Error("Owner setup requires an interactive terminal");
  let hidden = false;
  const sink = new Writable({ write(chunk, _encoding, done) { if (!hidden) output.write(chunk); done(); } });
  const rl = createInterface({ input, output: sink, terminal: true, historySize: 0 });
  let pending: ((error: Error) => void) | undefined;
  let closed = false;
  rl.on("SIGINT", () => rl.close());
  rl.on("close", () => { closed = true; pending?.(new Error("Owner setup cancelled")); pending = undefined; });
  return {
    write(message) { output.write(message); },
    read(prompt, secret = false) {
      if (closed) return Promise.reject(new Error("Owner setup cancelled"));
      output.write(prompt);
      hidden = secret;
      return new Promise((resolve, reject) => {
        pending = reject;
        rl.question("", answer => { pending = undefined; if (secret) output.write("\n"); hidden = false; resolve(answer); });
      });
    },
    close() { hidden = false; rl.close(); sink.end(); },
  };
}
