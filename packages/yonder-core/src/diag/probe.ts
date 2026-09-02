// SPDX-License-Identifier: GPL-3.0-or-later
import { systemClock, type Clock } from "../apply/types.js";
import { systemRunner, type CommandRunner } from "../net/runner.js";
import { IPV4_PATTERN } from "../schema/config.js";

/**
 * Reachability probes (R-DIA-01, R-DIA-02).
 *
 * Two rules run through this file.
 *
 * **The host is operator input and it goes on a command line.** It is
 * validated here, where it arrives, rather than relied upon to be harmless
 * because `CommandRunner` passes an argument array. That array is the reason
 * `8.8.8.8; rm -rf /` cannot become two commands — there is no shell — but it
 * is not a reason to hand `ping` an arbitrary string. `-i0.001` is not a
 * hostname and would be read as a flag; a 300-character name is not a hostname
 * either. The rule is stated at the point of capture because the next caller
 * of this module will not read `runner.ts`.
 *
 * **A failure is a result, not an exception.** "Unreachable" is the answer to
 * the question the operator asked, and a page that renders an error where the
 * answer belongs has told them nothing. Nothing in this module rejects.
 */

/** How many echo requests a single probe may send. */
export const MAX_COUNT = 10;
export const DEFAULT_COUNT = 3;

/**
 * The hard bound on a probe, measured by this daemon rather than by `ping`.
 *
 * `ping -w` already bounds the subprocess, and this is the belt to that
 * braces: a `ping` that never exits — a wedged binary, a runner that never
 * settles — would otherwise leave a console request open until the browser
 * gave up. What it cannot do is stop the abandoned process, the same limitation
 * `ApplyEngine.withTimeout` has (K-10); `-w` is what actually ends it.
 */
export const PROBE_TIMEOUT_MS = 20_000;

/** The longest hostname DNS permits, and the longest label inside one. */
const MAX_HOSTNAME_LENGTH = 253;
const HOSTNAME_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;

/**
 * Whether this is something Yonder will hand to `ping`.
 *
 * An IPv4 address by the same octet-accurate pattern the schema holds a
 * configured address to, or a DNS hostname: dot-separated labels, each 1–63
 * characters of letters, digits and hyphens, not starting or ending with a
 * hyphen, 253 characters in total. A trailing root dot is allowed because it
 * is legal and an operator may paste one.
 *
 * **This refuses IPv6 addresses**, because they contain colons and no rule
 * here admits one. That is a real limitation on an IPv6-only cellular network
 * and it is recorded as K-22 rather than papered over with a loose pattern: a
 * validator that accepts an address shape it has not thought about is how the
 * thing it was written to stop gets through.
 *
 * A hostname cannot begin with a hyphen, which is also what stops a value
 * being read by `ping` as a flag.
 *
 * The last label may not be all digits. That is RFC 1123's own rule and it is
 * the one that catches `999.1.1.1`: every label there is a legal hostname
 * label, so a validator without this rule accepts a mistyped address as a
 * name and hands the operator a lookup failure instead of "that is not an
 * address".
 */
export function isProbeHost(host: string): boolean {
  if (host === "" || host.length > MAX_HOSTNAME_LENGTH) return false;
  if (IPV4_PATTERN.test(host)) return true;
  const name = host.endsWith(".") ? host.slice(0, -1) : host;
  if (name === "") return false;
  const labels = name.split(".");
  if (/^\d+$/.test(labels[labels.length - 1] ?? "")) return false;
  return labels.every((label) => HOSTNAME_LABEL.test(label));
}

/** Why a probe produced no reply. All of these are answers, not errors. */
export type ProbeFailure =
  | "invalid-host"
  /** Packets went out and nothing came back. */
  | "no-reply"
  /** `ping` could not run at all, or refused the request outright. */
  | "failed"
  /** This daemon stopped waiting. */
  | "timed-out";

export interface PingResult {
  /** Echoed back so a page can label the answer with the question. */
  host: string;
  reachable: boolean;
  transmitted: number | null;
  received: number | null;
  /** Mean round trip in milliseconds, when `ping` reported one. */
  rttMs: number | null;
  reason?: ProbeFailure;
  /**
   * What to tell the operator. **Yonder's own words, always.**
   *
   * Never `ping`'s stderr. A failed lookup quotes the name back, a raw socket
   * refusal names a path, and this string travels into an HTTP body served
   * over a network — which is exactly the leak the generic 500 in
   * `daemon/routes.ts` exists to stop, arriving by a route that returns 200.
   */
  detail?: string;
}

/** `3 packets transmitted, 3 received, 0% packet loss, time 2003ms` */
const SUMMARY = /(\d+)\s+packets transmitted,\s*(\d+)\s*(?:packets\s+)?received/;
/** `rtt min/avg/max/mdev = 8.294/9.117/10.352/0.884 ms` */
const RTT = /(?:rtt|round-trip)\s+min\/avg\/max(?:\/\w+)?\s*=\s*[\d.]+\/([\d.]+)\//;

export interface PingSummary {
  transmitted: number | null;
  received: number | null;
  rttMs: number | null;
}

/**
 * What `ping` said it did, out of its own summary block.
 *
 * Pure, and separate from running anything, so the shapes `ping` prints are
 * testable without a network. Anything it cannot read is null: a summary this
 * does not recognise is a fact not known, and `received` is the field the
 * caller decides reachability from, so inventing one would be inventing the
 * answer.
 */
export function parsePingSummary(stdout: string): PingSummary {
  const summary = SUMMARY.exec(stdout);
  const rtt = RTT.exec(stdout);
  const number = (text: string | undefined): number | null => {
    if (text === undefined) return null;
    const value = Number(text);
    return Number.isFinite(value) ? value : null;
  };
  return {
    transmitted: number(summary?.[1]),
    received: number(summary?.[2]),
    rttMs: number(rtt?.[1]),
  };
}

export interface ProbeOptions {
  runner?: CommandRunner;
  clock?: Clock;
  /** Overrides PROBE_TIMEOUT_MS. Test-only. */
  timeoutMs?: number;
}

/**
 * Race a command against this daemon's own deadline.
 *
 * The deadline resolves rather than rejects, because a probe that took too
 * long is a result the operator can act on and a rejection is not.
 */
function withDeadline<T>(work: Promise<T>, clock: Clock, ms: number, onTimeout: () => T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const timer = clock.setTimer(ms, () => {
      if (settled) return;
      settled = true;
      resolve(onTimeout());
    });
    void work.then(
      (value) => { if (!settled) { settled = true; clock.clearTimer(timer); resolve(value); } },
      // A runner that rejects is a bug in the runner — systemRunner never
      // does — but a probe must still answer rather than take the daemon
      // down with an unhandled rejection.
      () => { if (!settled) { settled = true; clock.clearTimer(timer); resolve(onTimeout()); } },
    );
  });
}

/**
 * Ping a host and report what came back.
 *
 * `-c` bounds the packets, `-w` bounds the whole run in seconds, `-n` stops
 * `ping` doing a reverse lookup on every reply — which on a link with no DNS
 * is the difference between a probe that answers and one that waits out its
 * deadline doing nothing.
 *
 * `-w` is iputils' spelling. That is what Debian ships and Debian is what
 * Yonder runs on; a board with a different `ping` gets an argument it does not
 * understand, `ping` exits non-zero, and the result says the probe failed
 * rather than pretending the host is down.
 */
export async function ping(
  host: string,
  opts: ProbeOptions & { count?: number } = {},
): Promise<PingResult> {
  if (!isProbeHost(host)) {
    return {
      // The submitted value is not echoed. It is unvalidated operator input on
      // its way back into a browser, and there is nothing to gain from
      // repeating it — the page still has what was typed in it.
      host: "",
      reachable: false,
      transmitted: null,
      received: null,
      rttMs: null,
      reason: "invalid-host",
      detail: "that is not a host name or an IPv4 address",
    };
  }

  const runner = opts.runner ?? systemRunner;
  const clock = opts.clock ?? systemClock;
  const requested = opts.count ?? DEFAULT_COUNT;
  // Clamped rather than refused: an operator who asks for 100 packets wants a
  // longer test, and giving them the longest this device will run is a more
  // useful answer than an error about a number.
  const count = Number.isFinite(requested)
    ? Math.min(MAX_COUNT, Math.max(1, Math.floor(requested)))
    : DEFAULT_COUNT;
  // One second per packet plus two, which is the interval ping uses plus
  // room for the last reply. Always shorter than PROBE_TIMEOUT_MS, so the
  // subprocess ends before this daemon stops waiting on it.
  const deadlineSeconds = count + 2;

  const failure = (reason: ProbeFailure, detail: string): PingResult => ({
    host, reachable: false, transmitted: null, received: null, rttMs: null, reason, detail,
  });

  const result = await withDeadline(
    runner(["ping", "-n", "-c", String(count), "-w", String(deadlineSeconds), host]),
    clock,
    opts.timeoutMs ?? PROBE_TIMEOUT_MS,
    () => null,
  );
  if (result === null) {
    return failure("timed-out", "the probe did not finish in time");
  }

  const summary = parsePingSummary(result.stdout);
  if (result.code === 0) {
    return { host, reachable: true, ...summary };
  }
  // Exit 1 is ping's own "I sent packets and nothing came back", which is a
  // measurement. Anything else — 2 for a name that would not resolve, 127 for
  // no ping on this board — is the probe failing rather than the host being
  // down, and the two must not read the same on a page.
  if (result.code === 1) {
    return {
      host,
      reachable: false,
      ...summary,
      reason: "no-reply",
      detail: "no reply",
    };
  }
  return failure(
    "failed",
    // Deliberately not ping's stderr. See PingResult.detail.
    "the probe could not be run; the host may not resolve, or this board may have no ping",
  );
}

/**
 * The address `reachable()` probes when it is not told otherwise.
 *
 * A literal address, never a name, so that the probe answers the question the
 * operator asked instead of a different one: a name would fail on a working
 * link with broken DNS, and "the internet is down" is the wrong conclusion to
 * hand somebody standing in a field.
 */
export const DEFAULT_REACHABILITY_HOST = "1.1.1.1";

/**
 * Whether this device can reach something beyond itself.
 *
 * **What this actually tests**, because "the internet is up" is not a thing
 * that can be tested and a function claiming to test it is a lie the next
 * reader inherits: it sends ICMP echo requests to one well-known public
 * address and reports whether any came back. That is evidence, and it is
 * exactly as much as it looks like:
 *
 *   - A network that filters ICMP reports unreachable while carrying traffic
 *     perfectly well. Some cellular carriers do.
 *   - A captive portal reports reachable while carrying nothing an operator
 *     wants.
 *   - One address being down is not the internet being down.
 *
 * It is run **only when an operator asks for it** — a button on the
 * diagnostics page, never a poll, never at start-up. Yonder does not contact
 * anything off this device on its own, and this function must not become the
 * exception.
 */
export async function reachable(
  opts: ProbeOptions & { host?: string } = {},
): Promise<PingResult> {
  return ping(opts.host ?? DEFAULT_REACHABILITY_HOST, {
    ...opts,
    // Fewer packets than a manual ping: this is a yes-or-no, and the operator
    // is waiting on a page for it.
    count: 2,
  });
}
