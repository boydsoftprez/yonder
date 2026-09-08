// SPDX-License-Identifier: GPL-3.0-or-later
import type { AccessoryCommandOptions } from './aoa.js';
import type { DumlCommand } from './duml.js';
import type { IntentClock } from './intent.js';

type Command = Omit<DumlCommand, 'sequence'>;
type Pending = { command: Command; options: AccessoryCommandOptions; resolve(): void; reject(error: Error): void;
  abort?: () => void; timer?: unknown };

/** Two controller producers, each already single-flight: one active write and one waiter.
 * This serializes physical I/O only, never a camera operation's readback wait.
 * No deadline renewal, retry, or retained rate after cancellation is possible.
 */
export class AccessoryWriter {
  private active?: Pending;
  private waiting?: Pending;
  constructor(private readonly clock: IntentClock,
    private readonly endpoint: (command: Command, options: AccessoryCommandOptions) => Promise<void>) {}

  write(command: Command, options: AccessoryCommandOptions): Promise<void> {
    if (!Number.isFinite(options.deadline) || !options.signal || !options.admission)
      return Promise.reject(new Error('Accessory arbitration requires an original deadline, signal and admission'));
    if (this.waiting) return Promise.reject(new Error('Accessory arbitration capacity exceeded'));
    return new Promise<void>((resolve, reject) => {
      const entry: Pending = { command: { ...command, payload: command.payload?.slice() }, options: { ...options }, resolve, reject };
      if (!this.active) { this.start(entry); return; }
      this.waiting = entry;
      entry.abort = () => this.drop(entry, 'Accessory command canceled before dispatch');
      entry.options.signal!.addEventListener('abort', entry.abort, { once: true });
      if (entry.options.signal!.aborted) { entry.abort(); return; }
      this.arm(entry);
    });
  }
  private arm(entry: Pending): void {
    if (this.waiting !== entry) return;
    const left = entry.options.deadline! - this.clock.now();
    if (left <= 0) {
      // Controller admission notices its own original expiry and revokes its
      // signal. Thus an expired queued rate is cancellation, not link failure.
      entry.options.admission!();
      this.drop(entry, 'Accessory command expired before dispatch');
      return;
    }
    entry.timer = this.clock.setTimer(left, () => this.arm(entry));
  }
  private detach(entry: Pending): void {
    if (entry.timer !== undefined) this.clock.clearTimer(entry.timer);
    if (entry.abort) entry.options.signal!.removeEventListener('abort', entry.abort);
  }
  private drop(entry: Pending, reason: string): void {
    if (this.waiting !== entry) return;
    this.waiting = undefined; this.detach(entry); entry.reject(new Error(reason));
  }
  private start(entry: Pending): void {
    this.active = entry;
    this.detach(entry);
    if (entry.options.signal!.aborted || entry.options.deadline! <= this.clock.now()) {
      entry.options.admission!(); this.finished(entry, new Error('Accessory command retired before dispatch')); return;
    }
    // The device retains the exact admission callback and runs it at actual
    // serialized endpoint dispatch, including time spent behind protocol I/O.
    try { this.endpoint(entry.command, entry.options).then(() => this.finished(entry), error => this.finished(entry, error)); }
    catch (error) { this.finished(entry, error instanceof Error ? error : new Error(String(error))); }
  }
  private finished(entry: Pending, error?: Error): void {
    if (this.active !== entry) return;
    this.active = undefined;
    const next = this.waiting; this.waiting = undefined;
    // Retire this physical writer and promote the one waiter before resolving
    // its producer: a multi-stage camera operation cannot jump ahead of it.
    if (next) this.start(next);
    if (error) entry.reject(error); else entry.resolve();
  }
}
