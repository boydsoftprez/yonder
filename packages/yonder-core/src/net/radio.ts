// SPDX-License-Identifier: GPL-3.0-or-later
import type { Config } from "../schema/config.js";
import type { CommandRunner } from "./runner.js";

/**
 * The kernel's rfkill soft block, which a freshly flashed Raspberry Pi OS
 * carries from the first boot. Observed on a Raspberry Pi 4, Debian 13:
 *
 *     1: phy0: Wireless LAN
 *             Soft blocked: yes
 *
 * `unblock` is a no-op on a radio that is not blocked, so this is safe to
 * issue on every render.
 */
export const RFKILL_UNBLOCK_WIFI = ["rfkill", "unblock", "wifi"];

/**
 * NetworkManager's own `WirelessEnabled` flag, which is **not** the kernel's
 * rfkill state. It is persisted in NetworkManager's state file and survives
 * reboots, so clearing the kernel block alone leaves the radio down. The same
 * board said so in as many words:
 *
 *     nmcli radio all
 *     WIFI-HW   WIFI
 *     enabled   disabled
 *
 *     NetworkManager[…]: manager: rfkill: Wi-Fi enabled by radio killswitch;
 *                        disabled by state file
 *
 * Issued after the rfkill unblock, because NetworkManager re-reads the
 * killswitch when its own flag is turned on. `on` is a no-op on a radio that
 * is already enabled.
 */
export const NMCLI_RADIO_WIFI_ON = ["nmcli", "radio", "wifi", "on"];

/**
 * Whether this configuration needs a Wi-Fi radio that can be used at all.
 *
 * Not the same question as "should the access point be on the air": it is
 * the weaker one of whether Yonder has any business clearing a block someone
 * or something else applied. Three ways to answer yes, and the third is the
 * one worth stating:
 *
 * - The access point is enabled. It cannot be raised on a blocked radio.
 * - A client network is configured. Same.
 * - **The access-point fallback is enabled**, even with the access point
 *   itself disabled. R-NET-07 says the fallback raises the access point
 *   *regardless of configuration* when nothing else carries traffic, and that
 *   `nmcli connection up yonder-ap` fails on a radio the kernel has blocked.
 *   A fallback that cannot fire is not a fallback, so a configuration that
 *   keeps it is a configuration that still needs the radio available.
 *
 * Which leaves exactly one shape that means "no Wi-Fi": the access point off,
 * no client network, and the fallback explicitly disabled — the "explicitly
 * named configuration key" R-NET-07 already requires before the guarantee can
 * be given up. That is the configuration R-NET-08 will grow into, and until
 * it does, this is the closest thing to an operator saying "radio off" that
 * the schema can express. Yonder never turns a radio *off* here; it only
 * declines to turn one on.
 */
export function radioWanted(config: Config): boolean {
  const { ap, client } = config.network;
  return ap.enabled
    || ap.fallback.enabled
    || (client.ssid !== null && client.ssid !== "");
}

/**
 * Clear both locks a Raspberry Pi ships its Wi-Fi radio behind.
 *
 * Raspberry Pi OS arrives with the radio soft-blocked in the kernel *and*
 * disabled in NetworkManager's state file. They are independent: clearing
 * either one alone leaves `wlan0` in state `unavailable`, no profile can be
 * activated on it, and a freshly flashed board never raises its access point
 * — which is R-CFG-08 broken on every Raspberry Pi. Clearing both moved that
 * board's `wlan0` from `unavailable` to `disconnected` and everything worked.
 *
 * **Never fails.** Every failure here is logged and stepped over, because
 * every one of them describes a board this must not stop:
 *
 * - `rfkill` is a separate binary from `nmcli` and is not installed
 *   everywhere. A missing one comes back as exit 127 from `systemRunner`,
 *   which is not a reason to abandon a render.
 * - A board with no Wi-Fi hardware at all is legitimate. Neither command has
 *   anything to do there and neither is worth a failed render over.
 * - NetworkManager not being up yet is the cold-boot race the renderer
 *   already handles one step later, where the failure is diagnosed properly:
 *   `device status` is the next thing render() runs, and it throws.
 *
 * So this is a precondition, not a step of the render, and it is written to
 * be incapable of turning a working board into a failed apply.
 *
 * Idempotent by construction rather than by checking first: both commands are
 * no-ops on a radio that is already enabled, and reading the current state
 * would mean parsing two more command outputs to decide not to run two
 * commands that cost nothing.
 */
export async function enableWifiRadio(
  run: CommandRunner,
  log: (line: string) => void = () => {},
): Promise<void> {
  for (const argv of [RFKILL_UNBLOCK_WIFI, NMCLI_RADIO_WIFI_ON]) {
    const printed = argv.join(" ");
    try {
      const result = await run(argv);
      if (result.code !== 0) {
        const why = result.stderr.trim() || "no stderr";
        log(`network: ${printed} exited ${result.code} (${why}); carrying on without it`);
      }
    } catch (e) {
      log(`network: ${printed} could not be run (${(e as Error).message}); carrying on without it`);
    }
  }
}
