// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Diagnostics go to stderr, which systemd hands to the journal. There is no
 * log framework here on purpose: the daemon's job is to stay up and keep the
 * configuration socket answering, and a logger is one more thing to fail.
 */
export function warn(message: string): void {
  process.stderr.write(`yonder-core: ${message}\n`);
}
