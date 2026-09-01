// SPDX-License-Identifier: GPL-3.0-or-later
import { systemClock, type Clock, type Renderer } from "../apply/types.js";
import type { Config } from "../schema/config.js";
import type { SecretStore } from "../secrets/store.js";
import { NmcliClient, type DeviceInfo } from "./nmcli/client.js";
import { writeDnsmasqConf, DNSMASQ_DROPIN } from "./dnsmasq.js";
import { enableWifiRadio, radioWanted } from "./radio.js";
import {
  desiredProfiles, AP_CONNECTION, CLIENT_CONNECTION, ETHERNET_CONNECTION,
  type Interfaces,
} from "./profiles.js";

/** The only connection names this renderer will ever create or delete. */
const OWNED = new Set([AP_CONNECTION, CLIENT_CONNECTION, ETHERNET_CONNECTION]);

/**
 * How long to wait, after the first render, for a Wi-Fi radio NetworkManager
 * has not finished bringing up.
 *
 * On a cold boot `yonder-core` can start before NetworkManager has finished
 * with the radio. A real Raspberry Pi 4 printed this moments before the
 * daemon's first render would have run:
 *
 *     lo:loopback:connected (externally):lo
 *     eth0:ethernet:unavailable:
 *     wlan0:wifi:unavailable:
 *
 * A render against that list creates no working access point, and the
 * fallback watchdog's only action is `nmcli connection up yonder-ap` — a
 * profile that a render is the only thing that creates. So a slow radio was a
 * device that came up with no access point and no way to recover it, which is
 * the exact failure R-NET-07 exists to prevent.
 *
 * Bounded, and bounded well short of the 90 s fallback deadline, because
 * waiting is only ever worth doing while the radio might still appear. 30 s
 * is far longer than the few seconds a driver takes and still leaves the
 * watchdog most of its window. It also sits inside the 60 s per-renderer
 * timeout, so a render that waits cannot be the thing that trips it.
 */
export const RADIO_WAIT_MS = 30_000;

/** How often `device status` is re-read while waiting for the radio. */
export const RADIO_POLL_MS = 1_000;

/**
 * States that mean "NetworkManager knows about this device but cannot act on
 * it yet". `unavailable` is the one a real board printed for a radio still
 * coming up; `unknown` is NetworkManager saying it has no idea, which is not
 * something to configure against either.
 *
 * Everything else counts as usable, `disconnected` very much included — that
 * is a radio ready to be given a profile, which is all the access point
 * needs. `unmanaged` counts as usable too, deliberately: it means an operator
 * has told NetworkManager to keep its hands off, and waiting 30 s for that to
 * change would be waiting for a decision, not for hardware.
 */
const RADIO_NOT_READY = new Set(["unavailable", "unknown"]);

/**
 * Whether a device row describes something NetworkManager can act on.
 *
 * Compared on the first whitespace-delimited word, because a state is not
 * always a single one: the same board printed `connected (externally)` for
 * its loopback device, and a NetworkManager that ever appends a parenthesised
 * reason to `unavailable` must still be read as unavailable.
 */
export function deviceIsUsable(state: string): boolean {
  const word = state.trim().toLowerCase().split(/\s+/)[0] ?? "";
  return word !== "" && !RADIO_NOT_READY.has(word);
}

/** `wlan0=unavailable`, for a log line that says which radio and why. */
function describe(devices: DeviceInfo[]): string {
  return devices.map((d) => `${d.device}=${d.state}`).join(" ") || "no wifi device";
}

export interface NetworkRendererOptions {
  client: NmcliClient;
  secrets: SecretStore;
  dnsmasqPath?: string;
  log?: (line: string) => void;
  /**
   * Drives waitForRadio's bounded wait. Injected for the same reason as
   * everywhere else in this daemon: no test may wait on the wall clock.
   */
  clock?: Clock;
  /** Overrides RADIO_WAIT_MS. Test-only. */
  radioWaitMs?: number;
  /** Overrides RADIO_POLL_MS. Test-only. */
  radioPollMs?: number;
}

export class NetworkRenderer implements Renderer {
  readonly name = "network";
  private readonly client: NmcliClient;
  private readonly secrets: SecretStore;
  private readonly dnsmasqPath: string;
  private readonly log: (line: string) => void;
  private readonly clock: Clock;
  private readonly radioWaitMs: number;
  private readonly radioPollMs: number;
  private waitTimer: unknown;
  private wakeWait: (() => void) | undefined;
  private waitCancelled = false;

  constructor(opts: NetworkRendererOptions) {
    this.client = opts.client;
    this.secrets = opts.secrets;
    this.dnsmasqPath = opts.dnsmasqPath ?? DNSMASQ_DROPIN;
    this.log = opts.log ?? (() => {});
    this.clock = opts.clock ?? systemClock;
    this.radioWaitMs = opts.radioWaitMs ?? RADIO_WAIT_MS;
    this.radioPollMs = opts.radioPollMs ?? RADIO_POLL_MS;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      // Cancelled while the last poll was still in flight. Parking on a timer
      // now would mean waiting a full interval — or, on a clock a test drives
      // by hand, for ever — to notice something already decided.
      if (this.waitCancelled) { resolve(); return; }
      this.wakeWait = resolve;
      this.waitTimer = this.clock.setTimer(ms, () => {
        this.waitTimer = undefined;
        this.wakeWait = undefined;
        resolve();
      });
    });
  }

  /**
   * Abandon a wait in progress, and refuse to start another.
   *
   * The same reason FallbackWatchdog has stop(): a poll loop that outlives
   * the daemon it belongs to is a timer still asking NetworkManager questions
   * on behalf of a process that has closed its socket, and — if it were ever
   * to reach a render — reconfiguring a radio nobody is managing any more.
   * Idempotent, and safe to call when no wait is running.
   */
  cancelRadioWait(): void {
    this.waitCancelled = true;
    if (this.waitTimer !== undefined) {
      this.clock.clearTimer(this.waitTimer);
      this.waitTimer = undefined;
    }
    // Let a loop parked on sleep() run one more step and see the flag, rather
    // than leaving its promise pending for ever.
    const wake = this.wakeWait;
    this.wakeWait = undefined;
    wake?.();
  }

  /**
   * Wait for a Wi-Fi radio NetworkManager has not finished bringing up, and
   * say whether anything has changed enough to be worth rendering again.
   *
   * Returns **true** only when this call actually waited and a usable radio
   * then appeared — i.e. the caller's last render ran against a device list
   * that has since improved, so rendering again will do something the earlier
   * render could not. Returns **false** when there was nothing to wait for,
   * or when the bound ran out with no usable radio.
   *
   * Three ways to have no usable radio, told apart in the log because they
   * mean different things to whoever reads it, but all three waited on:
   *
   * - **A Wi-Fi device present but not usable** — `wlan0:wifi:unavailable:`,
   *   which is exactly what a real cold boot printed. NetworkManager knows
   *   about the radio and has not finished with it.
   * - **No Wi-Fi device at all yet.** Earlier in the same sequence:
   *   NetworkManager has not registered the device. This is the shape that
   *   costs an access-point *profile* rather than just an activation, because
   *   a render with no wifi interface writes no `yonder-ap` at all, and
   *   `up yonder-ap` is the fallback watchdog's only move.
   * - **`device status` failed outright.** The same race one layer down:
   *   NetworkManager itself not up yet. Kept waiting on rather than read as
   *   "this board has no radio", which is a conclusion drawn from a question
   *   that could not be asked.
   *
   * The bound is what makes a board with genuinely no radio legitimate rather
   * than a special case. Such a board waits once, at boot, in the background,
   * behind an already-bound socket, logs that it is running without one, and
   * never pays again. Distinguishing "absent because slow" from "absent
   * because there is none" is not possible from one reading of the list, and
   * guessing wrong in the other direction is a device nobody can reach.
   */
  async waitForRadio(): Promise<boolean> {
    const deadline = this.clock.now() + this.radioWaitMs;
    let waited = false;

    for (;;) {
      if (this.waitCancelled) return false;
      let wifi: DeviceInfo[] | undefined;
      try {
        wifi = (await this.client.devices()).filter((d) => d.type === "wifi");
      } catch (e) {
        this.log(`network: cannot read device status yet (${(e as Error).message})`);
      }

      if (wifi !== undefined && wifi.some((d) => deviceIsUsable(d.state))) {
        if (waited) this.log(`network: wifi radio is usable now (${describe(wifi)})`);
        return waited;
      }

      const why = wifi === undefined ? "NetworkManager is not answering"
        : wifi.length === 0 ? "no wifi device is present"
        : describe(wifi);

      if (this.clock.now() >= deadline) {
        this.log(
          `network: no usable wifi radio after ${Math.round(this.radioWaitMs / 1000)} s (${why}); `
          + "carrying on without one",
        );
        return false;
      }

      if (!waited) {
        this.log(`network: no usable wifi radio yet (${why}); waiting for NetworkManager`);
        waited = true;
      }
      await this.sleep(this.radioPollMs);
    }
  }

  async render(config: Config): Promise<void> {
    // Before the device list is read, not after it.
    //
    // A Raspberry Pi ships its Wi-Fi radio behind two independent locks — the
    // kernel's rfkill soft block and NetworkManager's own persistent
    // `WirelessEnabled` flag — and a board carrying either of them reports
    // `wlan0:wifi:unavailable:`, which is the same shape as the cold-boot
    // race waitForRadio exists for and is not the same problem at all: a
    // block does not clear on its own, so waiting out the full RADIO_WAIT_MS
    // achieves nothing and the access point never comes up. On a freshly
    // flashed board that is R-CFG-08 broken outright (see radio.ts).
    //
    // Reading the device list first and clearing the locks only for a board
    // that listed a radio would look tidier and is a trap: whether a device
    // NetworkManager has been told to keep the radio off for appears in
    // `device status` at all is NetworkManager's business, not ours, and a
    // gate that depends on it deadlocks the moment it does not — no radio
    // listed, so no unblock, so no radio listed. Two commands that are
    // no-ops on hardware that does not need them are the cheaper side of
    // that trade, and neither can fail a render (enableWifiRadio never
    // throws).
    //
    // Every render, not once at install: a block is persistent state that a
    // board can acquire at any time, and the installer's own run happens in a
    // chroot during an image build, where `rfkill` would act on the build
    // host and `nmcli` has no NetworkManager to talk to. Gated on the
    // configuration wanting a radio at all, so an operator who has turned
    // Wi-Fi off is not overruled on every apply — see radioWanted.
    if (radioWanted(config)) {
      await enableWifiRadio(this.client.runner, this.log);
    }

    const devices = await this.client.devices();
    const ifaces: Interfaces = {
      wifi: devices.find((d) => d.type === "wifi")?.device ?? null,
      ethernet: devices.find((d) => d.type === "ethernet")?.device ?? null,
    };
    this.log(`network: wifi=${ifaces.wifi ?? "none"} ethernet=${ifaces.ethernet ?? "none"}`);

    const desired = desiredProfiles(config, this.secrets, ifaces);
    const wanted = new Set(desired.map((p) => p.name));

    // Remove only what we own and no longer want. A connection created by
    // someone else is never touched.
    for (const existing of await this.client.connections()) {
      if (OWNED.has(existing.name) && !wanted.has(existing.name)) {
        this.log(`network: removing ${existing.name}`);
        await this.client.remove(existing.name);
      }
    }

    for (const profile of desired) {
      await this.client.addOrModify(profile.name, profile);
    }

    if (ifaces.wifi !== null) {
      writeDnsmasqConf(this.dnsmasqPath, config);
    }

    // The access point is brought up or taken down deliberately; everything
    // else autoconnects.
    if (ifaces.wifi !== null) {
      const apActive = devices.some((d) => d.connection === AP_CONNECTION);
      if (config.network.ap.enabled && !apActive) {
        this.log("network: bringing the access point up");
        await this.client.up(AP_CONNECTION);
      } else if (!config.network.ap.enabled && apActive) {
        this.log("network: taking the access point down");
        await this.client.down(AP_CONNECTION);
      }
    }
  }
}
