// SPDX-License-Identifier: GPL-3.0-or-later
import { systemRunner, type CommandRunner } from "../net/runner.js";

/**
 * Supply-voltage state, where the board exposes it (R-SYS-09).
 *
 * **Now is not the same as has-happened-since-boot**, and the requirement is
 * explicit about distinguishing them: an undervoltage event restarts the
 * board, and a restart in flight presents as an aircraft that went quiet with
 * nothing to explain it. A reading that only showed the present moment would
 * be clean on the very board that had just rebooted itself.
 *
 * The register is a bitfield. Bits 0-2 are what is true now — undervoltage,
 * frequency capped, throttled. Bits 16-18 are the same three, latched since
 * boot. K-41's `0x50000` is the latched pair with nothing wrong at the moment
 * it was read, which is exactly the shape this exists to catch.
 *
 * **Unreadable is not clean.** The failure this guards against is recording a
 * measurement as trustworthy when the board was browning out underneath it, so
 * every path that cannot answer answers "not clean" or nothing at all — never
 * "fine".
 */
export interface SupplyFlags {
  readonly undervoltage: boolean;
  readonly capped: boolean;
  readonly throttled: boolean;
}
export interface SupplyState {
  readonly clean: boolean;
  readonly now: SupplyFlags;
  readonly sinceBoot: SupplyFlags;
  readonly raw: string;
}

/**
 * What an unreadable register reports.
 *
 * Every flag set, rather than none: a caller that renders the flags without
 * consulting `clean` still says something wrong is happening, which is the
 * safe direction to be wrong in.
 */
const DIRTY: SupplyFlags = { undervoltage: true, capped: true, throttled: true };

const unreadable = (raw: string): SupplyState => ({
  clean: false,
  now: DIRTY,
  sinceBoot: DIRTY,
  raw,
});

export function parseThrottled(text: string): SupplyState {
  const trimmed = text.trim();
  const m = /0x([0-9a-f]+)/i.exec(trimmed);
  if (!m) return unreadable(trimmed);
  const bits = Number.parseInt(m[1], 16);
  // A register wider than a double can hold exactly is a register we did not
  // understand, and not understanding it is not the same as it being fine.
  if (!Number.isFinite(bits)) return unreadable(trimmed);
  const flags = (shift: number): SupplyFlags => ({
    undervoltage: (bits & (1 << shift)) !== 0,
    capped: (bits & (1 << (shift + 1))) !== 0,
    throttled: (bits & (1 << (shift + 2))) !== 0,
  });
  // Clean is *no bit set at all*, not merely none of the six named ones. A bit
  // this code has no name for is a bit it cannot vouch for.
  return { clean: bits === 0, now: flags(0), sinceBoot: flags(16), raw: `0x${bits.toString(16)}` };
}

/** null where the board does not expose it — unknown, not good. */
export async function readSupply(
  opts: { runner?: CommandRunner } = {},
): Promise<SupplyState | null> {
  const result = await (opts.runner ?? systemRunner)(["vcgencmd", "get_throttled"]);
  if (result.code !== 0) return null;
  return parseThrottled(result.stdout);
}
