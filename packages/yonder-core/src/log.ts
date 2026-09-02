// SPDX-License-Identifier: GPL-3.0-or-later
import { activityLog } from "./log/activity.js";

/**
 * Diagnostics go to stderr, which systemd hands to the journal. There is no
 * log framework here on purpose: the daemon's job is to stay up and keep the
 * configuration socket answering, and a logger is one more thing to fail.
 *
 * Both of these also feed the activity buffer the console shows (R-DIA-05),
 * so the page reports what the daemon actually did rather than a second stream
 * that callers have to remember to write to. The buffer redacts on the way in
 * and hands back the line it stored, which is what is printed here — so the
 * journal and the page never carry different text (R-SEC-10).
 *
 * The info-level function is `note`, not `log`. Five classes in this package
 * already take an injected callback named `log`, and a module-level function
 * with that name would shadow one in each of them; `note` reads correctly
 * beside `warn` and cannot be confused for a parameter.
 */

/** Something went wrong, or nearly did. stderr, and the activity log. */
export function warn(message: string): void {
  process.stderr.write(`yonder-core: ${activityLog.record("warn", message)}\n`);
}

/** Something happened that an operator may want to see. stdout, and the activity log. */
export function note(message: string): void {
  process.stdout.write(`${activityLog.record("info", message)}\n`);
}

/**
 * A command this daemon ran. The journal only — never the activity log.
 *
 * The activity pane on the console is a product surface: what the *device*
 * did, in words an operator can act on. The journal is the diagnostic one,
 * and every `nmcli` invocation belongs there.
 *
 * Routing subprocess lines through `note` put them in both, and the moment a
 * status line started polling every few seconds the pane filled with
 * `nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device status` twice a tick.
 * An operator watching for what their Join did could not see it for the
 * plumbing.
 */
export function trace(message: string): void {
  process.stdout.write(`${message}\n`);
}
