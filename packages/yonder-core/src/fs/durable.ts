// SPDX-License-Identifier: GPL-3.0-or-later
import { openSync, writeSync, fsyncSync, fchmodSync, closeSync, renameSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Force a directory's own contents to media.
 *
 * A rename is atomic but not, on its own, durable: the new file's data can be
 * on disk while the directory entry that publishes it is still in the page
 * cache. A power cut in that window loses the rename and leaves the old file.
 * Flushing the directory closes it.
 */
export function fsyncDir(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Write a file so that a power cut leaves either the whole old content or the
 * whole new one, and so that a call that has returned is genuinely on media:
 * fresh temp file beside the target, fsync the data, rename, fsync the
 * directory (R-STO-03).
 *
 * `mode` is applied with fchmod rather than left to the open() mode argument,
 * so the result does not depend on the caller's umask — a secrets file must be
 * 0600 whatever the shell that started the daemon was set to.
 */
export function writeFileDurable(path: string, data: string, mode: number): void {
  const tmp = `${path}.tmp`;
  // "wx" refuses to reuse a temp file left by an earlier crash, which could
  // otherwise carry permissions wider than `mode`; remove any such leftover
  // first so the refusal never becomes a permanent failure.
  try {
    unlinkSync(tmp);
  } catch {
    /* nothing left over */
  }
  const fd = openSync(tmp, "wx", mode);
  try {
    fchmodSync(fd, mode);
    const buf = Buffer.from(data, "utf8");
    let written = 0;
    while (written < buf.length) {
      written += writeSync(fd, buf, written, buf.length - written);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  fsyncDir(dirname(path));
}

/**
 * Remove a file and force the removal itself to media. Used for the apply
 * journal: a deletion still sitting in the page cache resurrects the journal
 * after a power cut, which would revert a change the operator confirmed.
 */
export function unlinkDurable(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    // A failed unlink leaves the rollback record alive. Treating EIO/EROFS
    // as absence would acknowledge confirmation and then revert it on boot.
    throw error;
  }
  fsyncDir(dirname(path));
}
