// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NetworkRenderer, deviceIsUsable } from "./renderer.js";
import { NmcliClient } from "./nmcli/client.js";
import { SecretStore } from "../secrets/store.js";
import {
  AP_CONNECTION, CLIENT_CONNECTION, ETHERNET_CONNECTION, MODEM_CONNECTION, DEFAULT_AP_PASSPHRASE,
} from "./profiles.js";
import { RFKILL_UNBLOCK_WIFI, NMCLI_RADIO_WIFI_ON } from "./radio.js";
import { DEFAULT_CONFIG } from "../schema/config.js";
import type { Clock } from "../apply/types.js";
import type { Config } from "../schema/config.js";
import type { CommandRunner, CommandResult } from "./runner.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "yonder-rend-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });

const DEVICES = "eth0:ethernet:connected:yonder-eth\nwlan0:wifi:disconnected:\nlo:loopback:unmanaged:\n";

/** Deliberately not the published default, so the two can be told apart. */
const OPERATOR_PSK = "an-operator-chose-this";

/**
 * The real cold boot, captured from a Raspberry Pi 4 moments before
 * `yonder-core` would have rendered: both interfaces present, neither usable
 * yet, and a loopback state with a space in it.
 * See `packages/yonder-core/src/net/nmcli/fixtures/device-status.txt`.
 */
const COLD_BOOT = "lo:loopback:connected (externally):lo\neth0:ethernet:unavailable:\nwlan0:wifi:unavailable:\n";

/** The same board a few seconds later, with the radio ready to be configured. */
const RADIO_READY = "lo:loopback:connected (externally):lo\neth0:ethernet:unavailable:\nwlan0:wifi:disconnected:\n";

/** Earlier still: NetworkManager has not registered the radio at all. */
const NO_RADIO_YET = "lo:loopback:connected (externally):lo\neth0:ethernet:unavailable:\n";

/**
 * A clock that fast-forwards instead of waiting: `setTimer` moves `now()` on
 * by the interval asked for and runs the callback off the microtask queue.
 * A bounded poll finishes in microseconds however long its bound is, and no
 * test ever waits on the wall clock — the same rule as `advance()` in
 * watchdog.test.ts, arranged for a loop that sleeps rather than a one-shot
 * deadline the test drives by hand.
 */
function fastClock(): Clock {
  let t = 0;
  return {
    now: () => t,
    setTimer: (ms, fn) => { t += ms; queueMicrotask(fn); return 0; },
    clearTimer: () => {},
  };
}

/** The state nmcli reports for the wifi device in a `device status` block. */
function wifiState(deviceStatus: string): string | undefined {
  return deviceStatus.split("\n").map((l) => l.split(":")).find((f) => f[1] === "wifi")?.[2];
}

/**
 * The same block as nmcli reports it once `up yonder-ap` has been accepted:
 * the wifi device moves to `connected` and the CONNECTION column names the
 * profile that is on it.
 *
 * The fake did not model this, so `apActive` was false on every render and
 * `&& !apActive` in the renderer could be deleted with the suite green. That
 * is not a cosmetic gate: re-issuing `up` on an access point already on the
 * air drops every joined station and brings it back, on every render — which
 * includes the operator waiting to confirm the apply that is rendering.
 */
function withApActive(deviceStatus: string): string {
  return deviceStatus
    .split("\n")
    .map((line) => {
      const f = line.split(":");
      return f[1] === "wifi" ? `${f[0]}:wifi:connected:${AP_CONNECTION}` : line;
    })
    .join("\n");
}

interface HarnessOptions {
  /** `nmcli device status` output. */
  devices?: string;
  /**
   * Successive `nmcli device status` outputs, one consumed per call, the last
   * repeating. This is how a radio that becomes usable partway through is
   * expressed — a single fixed string cannot say "and then it changed".
   */
  deviceSequence?: string[];
  /** Connection names NetworkManager already holds when the render starts. */
  connections?: string[];
  /** Replaces the result of `device status`, to make it fail. */
  deviceStatus?: CommandResult;
  /** Drives waitForRadio's bounded wait. */
  clock?: Clock;
  /** Overrides the wait's bound, in milliseconds. */
  radioWaitMs?: number;
  /**
   * Commands, keyed on their joined argv, that must come back failed. This is
   * how a board with no `rfkill` binary is expressed: `systemRunner` reports a
   * missing executable as exit 127, so that is what the fake returns.
   */
  fails?: Record<string, CommandResult>;
}

/**
 * A fake nmcli that **remembers what it was told**.
 *
 * A stateless fake replays the same `connection show` output however many
 * times the renderer asks, so a delete has no consequence and a second render
 * cannot tell that the first one happened. That is what let the ownership
 * rule be half-gated: `OWNED.has(name) && !wanted.has(name)` could be reduced
 * to `OWNED.has(name)` — delete everything we own, on every render, and
 * immediately recreate it — with every test still green. Here an add adds and
 * a delete deletes, so a second identical render is a real assertion.
 */
function harness(opts: HarnessOptions = {}) {
  const calls: string[][] = [];
  const names = new Set(opts.connections ?? []);
  const sequence = opts.deviceSequence ?? [opts.devices ?? DEVICES];
  let step = 0;
  let raised = 0;
  let apActive = false;

  /**
   * The device list as it stands at reading `n`. The last entry of the
   * sequence repeats — a board does not un-finish booting — and an accepted
   * `up yonder-ap` is reflected in it, because a fake that forgets what it
   * was told cannot tell a first render from a second.
   */
  const listedAt = (n: number): string => {
    const text = sequence[Math.min(n, sequence.length - 1)] ?? "";
    return apActive ? withApActive(text) : text;
  };

  const run: CommandRunner = async (argv) => {
    calls.push(argv);
    const key = argv.join(" ");
    const canned = opts.fails?.[key];
    if (canned !== undefined) return canned;
    if (key === "nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device status") {
      if (opts.deviceStatus !== undefined) return opts.deviceStatus;
      const text = listedAt(step);
      step++;
      return ok(text);
    }
    if (key === "nmcli -t -f NAME,UUID,TYPE,DEVICE connection show") {
      return ok([...names].map((n) => `${n}:u-${n}:802-11-wireless:\n`).join(""));
    }
    if (argv[1] === "connection") {
      // add is ["nmcli","connection","add","con-name",<name>,…]; the rest put
      // the name at argv[3].
      if (argv[2] === "add") names.add(argv[4]);
      if (argv[2] === "delete") names.delete(argv[3]);
      // A profile can be written against a radio NetworkManager has not
      // finished with — the keyfile does not care — but it cannot be
      // *activated* on one. Modelling that is what makes a cold boot a real
      // test rather than a fake that says yes to everything: without it the
      // renderer appears to bring an access point up on a radio that is not
      // there, which is precisely the illusion a hardware boot dispelled.
      const state = wifiState(listedAt(step - 1));
      const wifiConnection = argv[3] === AP_CONNECTION || argv[3] === CLIENT_CONNECTION;
      if (argv[2] === "up" && wifiConnection && (state === "unavailable" || state === "unknown")) {
        return { code: 4, stdout: "", stderr: `Error: Connection activation failed: device is not ready (${state})` };
      }
      // A refused activation never gets here, so a radio that was not ready
      // leaves the access point down — which is what the board did.
      if (argv[2] === "up" && argv[3] === AP_CONNECTION) { raised++; apActive = true; }
      if (argv[2] === "down" && argv[3] === AP_CONNECTION) apActive = false;
    }
    return ok();
  };

  const secrets = new SecretStore(join(dir, "secrets.yaml"));
  secrets.ensureValue("ap_psk", OPERATOR_PSK);
  const renderer = new NetworkRenderer({
    client: new NmcliClient(run),
    secrets,
    clock: opts.clock,
    radioWaitMs: opts.radioWaitMs,
  });
  return { renderer, calls, secrets, names, raised: () => raised };
}

const argvOf = (calls: string[][], verb: string, name: string) =>
  calls.find((c) => c[1] === "connection" && c[2] === verb && c[3] === name);

describe("NetworkRenderer", () => {
  it("creates the access point and the ethernet profile", async () => {
    const { renderer, calls } = harness();
    await renderer.render(DEFAULT_CONFIG);
    // The original brief assertion here (`argvOf(calls, "add", undefined as never)`)
    // relies on a connection name landing at argv[3] for the "add" verb. It
    // never does: NmcliClient.addOrModify's add path is
    // ["nmcli", "connection", "add", "con-name", name, ...flat], so argv[3]
    // is always the literal "con-name" and argvOf(..., "add", anything)
    // always misses, making that half of the `??` dead code. Simplified to
    // what it clearly intends: both connection names were issued to nmcli.
    expect(calls.some((c) => c.includes(AP_CONNECTION)) && calls.some((c) => c.includes(ETHERNET_CONNECTION))).toBe(true);
    expect(calls.some((c) => c.includes(AP_CONNECTION))).toBe(true);
    expect(calls.some((c) => c.includes(ETHERNET_CONNECTION))).toBe(true);
  });

  it("does not create a client profile when no ssid is configured", async () => {
    const { renderer, calls } = harness();
    await renderer.render(DEFAULT_CONFIG);
    expect(calls.some((c) => c.includes(CLIENT_CONNECTION))).toBe(false);
  });

  it("creates a client profile when an ssid is configured", async () => {
    const { renderer, calls, secrets } = harness();
    secrets.ensure("wifi_psk", "psk");
    const c: Config = structuredClone(DEFAULT_CONFIG);
    c.network.client.ssid = "HomeNetwork";
    c.network.client.psk = { secret: "wifi_psk" };
    await renderer.render(c);
    expect(calls.some((c2) => c2.includes(CLIENT_CONNECTION))).toBe(true);
  });

  it("removes a client profile that config no longer asks for", async () => {
    const { renderer, calls } = harness({ connections: [CLIENT_CONNECTION] });
    await renderer.render(DEFAULT_CONFIG);
    expect(argvOf(calls, "delete", CLIENT_CONNECTION)).toBeDefined();
  });

  it("never deletes a connection it does not own", async () => {
    const { renderer, calls } = harness({ connections: ["Wired connection 1"] });
    await renderer.render(DEFAULT_CONFIG);
    expect(calls.some((c) => c[2] === "delete")).toBe(false);
  });

  /**
   * The other half of the ownership rule. "Only what we own" was already a
   * gate; "only what we no longer want" was not, because a stateless fake
   * could not tell one render from the next. A second identical render must
   * be a no-op — anything else is the renderer tearing down the access point
   * it just built, on every apply, every confirm and every boot.
   */
  it("deletes nothing it still wants, however many times it renders", async () => {
    const { renderer, calls, names } = harness({ connections: [AP_CONNECTION, ETHERNET_CONNECTION] });
    await renderer.render(DEFAULT_CONFIG);
    await renderer.render(DEFAULT_CONFIG);
    expect(calls.filter((c) => c[2] === "delete")).toEqual([]);
    expect([...names].sort()).toEqual([AP_CONNECTION, ETHERNET_CONNECTION].sort());
  });

  it("removes an unwanted connection once, and does not look for it again", async () => {
    const { renderer, calls, names } = harness({
      connections: [AP_CONNECTION, CLIENT_CONNECTION, ETHERNET_CONNECTION],
    });
    await renderer.render(DEFAULT_CONFIG);
    await renderer.render(DEFAULT_CONFIG);
    expect(calls.filter((c) => c[2] === "delete" && c[3] === CLIENT_CONNECTION)).toHaveLength(1);
    expect(names.has(CLIENT_CONNECTION)).toBe(false);
  });

  it("brings the access point up when it is enabled", async () => {
    const { renderer, calls } = harness();
    await renderer.render(DEFAULT_CONFIG);
    expect(argvOf(calls, "up", AP_CONNECTION)).toBeDefined();
  });

  /**
   * The case Step 6 of the hardware procedure depends on: a configuration
   * with the access point disabled, on a board where it is not currently up,
   * must leave it down — otherwise the start-up render raises it and the
   * fallback watchdog is never the thing that brought it back.
   */
  it("does not raise a disabled access point that is not already up", async () => {
    const { renderer, calls } = harness();
    const c: Config = structuredClone(DEFAULT_CONFIG);
    c.network.ap.enabled = false;
    await renderer.render(c);
    expect(argvOf(calls, "up", AP_CONNECTION)).toBeUndefined();
    expect(argvOf(calls, "down", AP_CONNECTION)).toBeUndefined();
  });

  /**
   * `up yonder-ap` is not free to re-issue. NetworkManager tears the access
   * point down and brings it back, so every joined station is dropped —
   * including the operator's, whose confirmation is what an apply is waiting
   * for. A render happens on every apply, every confirm, every rollback and
   * every start-up, so a renderer that raises an access point already on the
   * air makes the confirmation window unusable over the very link it is
   * confirming on.
   *
   * `&& !apActive` is what stops it, and it survived deletion: the fake never
   * reflected an activation in the CONNECTION column, so `apActive` was false
   * on every render and both branches of the mutant agreed.
   */
  it("does not re-raise an access point that is already up", async () => {
    const { renderer, raised } = harness();
    await renderer.render(DEFAULT_CONFIG);
    expect(raised()).toBe(1);
    // Twice more, against a board that now reports `wlan0` connected on
    // yonder-ap — the state the first render left it in.
    await renderer.render(DEFAULT_CONFIG);
    await renderer.render(DEFAULT_CONFIG);
    expect(raised()).toBe(1);
  });

  /**
   * The passphrase reaching nmcli is the one in the secret store, which is
   * where an operator's changed value lives. A built-in default hardcoded
   * here would lock that operator out of their own device on the next render.
   */
  it("sends the passphrase from the secret store, not a value of its own", async () => {
    const { renderer, calls } = harness();
    await renderer.render(DEFAULT_CONFIG);
    const ap = calls.find((c) => c[2] === "add" && c[4] === AP_CONNECTION);
    expect(ap).toBeDefined();
    expect(ap).toContain(OPERATOR_PSK);
    expect(ap).not.toContain(DEFAULT_AP_PASSPHRASE);
  });

  it("takes the access point down when config disables it", async () => {
    const { renderer, calls } = harness({
      devices: `eth0:ethernet:connected:yonder-eth\nwlan0:wifi:connected:${AP_CONNECTION}\n`,
      connections: [AP_CONNECTION, ETHERNET_CONNECTION],
    });
    const c: Config = structuredClone(DEFAULT_CONFIG);
    c.network.ap.enabled = false;
    await renderer.render(c);
    expect(argvOf(calls, "down", AP_CONNECTION)).toBeDefined();
  });

  it("skips wifi entirely on a board with no wifi device", async () => {
    const { renderer, calls } = harness({
      devices: "eth0:ethernet:connected:yonder-eth\nlo:loopback:unmanaged:\n",
    });
    await renderer.render(DEFAULT_CONFIG);
    expect(calls.some((c) => c.includes(AP_CONNECTION))).toBe(false);
    expect(calls.some((c) => c.includes(ETHERNET_CONNECTION))).toBe(true);
  });

  it("rejects when nmcli fails, so the apply engine rolls back", async () => {
    const { renderer } = harness({
      deviceStatus: { code: 1, stdout: "", stderr: "NetworkManager is not running" },
    });
    await expect(renderer.render(DEFAULT_CONFIG)).rejects.toThrow(/not running/);
  });

  it("is idempotent: a second render of the same config adds nothing", async () => {
    const { renderer, calls } = harness({ connections: [AP_CONNECTION, ETHERNET_CONNECTION] });
    await renderer.render(DEFAULT_CONFIG);
    expect(calls.some((c) => c[2] === "add")).toBe(false);
    expect(calls.some((c) => c[2] === "modify")).toBe(true);
  });

  it("keeps the pre-shared key out of its log", async () => {
    const lines: string[] = [];
    const calls: string[][] = [];
    const run: CommandRunner = async (argv) => {
      calls.push(argv);
      if (argv.join(" ") === "nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device status") return ok(DEVICES);
      return ok();
    };
    const secrets = new SecretStore(join(dir, "s.yaml"));
    const psk = secrets.ensure("ap_psk", "psk").value;
    const renderer = new NetworkRenderer({
      client: new NmcliClient(run, (l) => lines.push(l)),
      secrets,
      log: (l) => lines.push(l),
    });
    await renderer.render(DEFAULT_CONFIG);
    expect(lines.join("\n")).not.toContain(psk);
  });
});

/**
 * The cold boot a real board exposed, and the guarantee it broke.
 *
 * `yonder-core` starts before NetworkManager has finished with the radio. The
 * start-up render is the only thing that ever writes the `yonder-ap` profile,
 * and the fallback watchdog's only action is `nmcli connection up yonder-ap`.
 * So a render that reads a not-yet-ready radio as "nothing to do here", and
 * never looks again, is a device with no access point and no way to recover
 * one — the exact failure R-NET-07 exists to prevent, on the boot it matters
 * most.
 *
 * Both shapes of "not ready" are here, because they cost different things.
 * A radio present but `unavailable` gets a profile that cannot be activated;
 * a radio not yet listed at all gets no profile written, which is the worse
 * of the two — the watchdog then tries to raise something that does not
 * exist.
 */
describe("NetworkRenderer, when the radio is not ready yet", () => {
  it("treats a state with a space and parentheses as usable", () => {
    // `connected (externally)` is what the board printed for loopback. A
    // reader that matched whole strings against a list of bare words, or that
    // split on whitespace, would have got this wrong in the unsafe direction.
    expect(deviceIsUsable("connected (externally)")).toBe(true);
    expect(deviceIsUsable("disconnected")).toBe(true);
    expect(deviceIsUsable("unmanaged")).toBe(true);
    expect(deviceIsUsable("unavailable")).toBe(false);
    expect(deviceIsUsable("unknown")).toBe(false);
    // A parenthesised reason must not turn "unavailable" into a state this
    // reads as ready.
    expect(deviceIsUsable("unavailable (initializing)")).toBe(false);
  });

  it("cannot raise the access point on a radio that is unavailable", async () => {
    // The mechanism, stated once: nmcli refuses to activate a profile on a
    // radio it has not finished bringing up, so the start-up render fails and
    // the access point is not on the air.
    const { renderer, raised } = harness({ devices: COLD_BOOT });
    await expect(renderer.render(DEFAULT_CONFIG)).rejects.toThrow(/not ready/);
    expect(raised()).toBe(0);
  });

  it("writes no access-point profile at all when the radio is not listed yet", async () => {
    // The worse half. `up yonder-ap` is the fallback's only move, and after a
    // render like this there is no yonder-ap for it to raise.
    const { renderer, names } = harness({ devices: NO_RADIO_YET });
    await renderer.render(DEFAULT_CONFIG);
    expect(names.has(AP_CONNECTION)).toBe(false);
  });

  it("ends with the access point created and raised once an unavailable radio becomes usable", async () => {
    const { renderer, names, raised } = harness({
      deviceSequence: [COLD_BOOT, COLD_BOOT, RADIO_READY],
      clock: fastClock(),
    });
    // The start-up render, against the board as it actually was.
    await expect(renderer.render(DEFAULT_CONFIG)).rejects.toThrow(/not ready/);
    expect(raised()).toBe(0);

    expect(await renderer.waitForRadio()).toBe(true);
    await renderer.render(DEFAULT_CONFIG);

    expect(names.has(AP_CONNECTION)).toBe(true);
    expect(raised()).toBe(1);
  });

  it("ends with the access point created and raised once a radio appears at all", async () => {
    const { renderer, names, raised } = harness({
      deviceSequence: [NO_RADIO_YET, NO_RADIO_YET, RADIO_READY],
      clock: fastClock(),
    });
    await renderer.render(DEFAULT_CONFIG);
    expect(names.has(AP_CONNECTION)).toBe(false);

    expect(await renderer.waitForRadio()).toBe(true);
    await renderer.render(DEFAULT_CONFIG);

    expect(names.has(AP_CONNECTION)).toBe(true);
    expect(raised()).toBe(1);
  });

  it("does not wait at all when the radio is already usable", async () => {
    const { renderer, calls } = harness({ clock: fastClock() });
    // Nothing to wait for, so nothing is waited for: one look at the device
    // list, no polling, and no second render asked of the caller.
    expect(await renderer.waitForRadio()).toBe(false);
    expect(calls.filter((c) => c.join(" ").endsWith("device status"))).toHaveLength(1);
  });

  it("gives up at the bound rather than waiting for ever", async () => {
    const { renderer } = harness({ devices: COLD_BOOT, clock: fastClock(), radioWaitMs: 5_000 });
    // A radio that never becomes usable must not hold the daemon open. The
    // bound is what makes "wait for it" safe to say at all.
    expect(await renderer.waitForRadio()).toBe(false);
  });

  it("gives up at the bound on a board that genuinely has no radio", async () => {
    // Ethernet-only hardware is a legitimate board, not a broken one. It pays
    // the bound once, in the background, behind an already-bound socket, and
    // then carries on.
    const { renderer } = harness({ devices: NO_RADIO_YET, clock: fastClock(), radioWaitMs: 5_000 });
    expect(await renderer.waitForRadio()).toBe(false);
  });

  it("keeps waiting when nmcli itself is not answering yet", async () => {
    // NetworkManager not being up is the same cold-boot race one layer down.
    // Reading a question that could not be asked as "this board has no radio"
    // is how the daemon would talk itself out of the access point again.
    let asked = 0;
    const run: CommandRunner = async (argv) => {
      if (argv.join(" ").endsWith("device status")) {
        asked++;
        if (asked < 3) return { code: 8, stdout: "", stderr: "Error: NetworkManager is not running." };
        return ok(RADIO_READY);
      }
      return ok();
    };
    const secrets = new SecretStore(join(dir, "s.yaml"));
    secrets.ensureValue("ap_psk", OPERATOR_PSK);
    const renderer = new NetworkRenderer({
      client: new NmcliClient(run), secrets, clock: fastClock(),
    });
    expect(await renderer.waitForRadio()).toBe(true);
  });
});

describe("NetworkRenderer.cancelRadioWait", () => {
  it("abandons a wait in progress instead of leaving it pending", async () => {
    // A daemon that has closed its socket must not leave a loop questioning
    // NetworkManager on its behalf — the same rule FallbackWatchdog.stop()
    // exists for. A fake clock whose timer never fires stands in for a wait
    // that would otherwise run to its full bound.
    const stalled: Clock = { now: () => 0, setTimer: () => 1, clearTimer: () => {} };
    const { renderer } = harness({ devices: COLD_BOOT, clock: stalled });
    const waiting = renderer.waitForRadio();
    // Cancelled mid-poll, which is when a shutdown actually arrives: the loop
    // must notice without waiting for a timer that is never going to fire.
    await Promise.resolve();
    renderer.cancelRadioWait();
    expect(await waiting).toBe(false);
  });

  it("refuses to start another wait once cancelled", async () => {
    const { renderer, calls } = harness({ devices: COLD_BOOT, clock: fastClock() });
    renderer.cancelRadioWait();
    expect(await renderer.waitForRadio()).toBe(false);
    // Not even one look: the daemon this belongs to is gone.
    expect(calls).toEqual([]);
  });
});

/**
 * The two locks a Raspberry Pi ships its Wi-Fi radio behind, and why the
 * renderer clears them.
 *
 * Raspberry Pi OS arrives with the radio soft-blocked in the kernel *and*
 * disabled in NetworkManager's own state file. Both were observed on a
 * Raspberry Pi 4 running Debian 13 with NetworkManager 1.52.1:
 *
 *     rfkill list        1: phy0: Wireless LAN  Soft blocked: yes
 *     nmcli radio all    WIFI-HW enabled  WIFI disabled
 *     NetworkManager[…]  rfkill: Wi-Fi enabled by radio killswitch;
 *                        disabled by state file
 *
 * The board reports `wlan0:wifi:unavailable:` for either one, which looks
 * exactly like the cold-boot race above and is nothing like it: a block does
 * not clear on its own, so a freshly flashed device waits out the whole of
 * RADIO_WAIT_MS and still never raises its access point. That is R-CFG-08
 * broken on every Raspberry Pi, and it is a render's job to fix because a
 * block is persistent state a board can acquire at any time, not a one-off
 * condition an installer could clear once.
 */
describe("NetworkRenderer, and the radio a Raspberry Pi ships disabled", () => {
  const at = (calls: string[][], argv: string[]) =>
    calls.findIndex((c) => c.join(" ") === argv.join(" "));

  it("clears both locks, before it reads the device list", async () => {
    const { renderer, calls } = harness();
    await renderer.render(DEFAULT_CONFIG);

    const rfkill = at(calls, RFKILL_UNBLOCK_WIFI);
    const radioOn = at(calls, NMCLI_RADIO_WIFI_ON);
    const status = calls.findIndex((c) => c.join(" ").endsWith("device status"));

    expect(rfkill).toBeGreaterThanOrEqual(0);
    expect(radioOn).toBeGreaterThanOrEqual(0);
    // The kernel block first: NetworkManager re-reads the killswitch when its
    // own flag is turned on, and clearing them the other way round leaves the
    // radio down behind a flag that says it is up.
    expect(rfkill).toBeLessThan(radioOn);
    // And both before the device list, which is the whole point: a blocked
    // radio reads as `unavailable`, and every decision this renderer makes
    // comes out of that list.
    expect(radioOn).toBeLessThan(status);
  });

  it("clears them on every render, not only the first", async () => {
    // A block is not a first-boot condition. `nmcli radio wifi off` at any
    // time, by anyone, persists in NetworkManager's state file across
    // reboots — so the fix has to be something that runs again.
    const { renderer, calls } = harness({ connections: [AP_CONNECTION, ETHERNET_CONNECTION] });
    await renderer.render(DEFAULT_CONFIG);
    await renderer.render(DEFAULT_CONFIG);
    expect(calls.filter((c) => c.join(" ") === RFKILL_UNBLOCK_WIFI.join(" "))).toHaveLength(2);
    expect(calls.filter((c) => c.join(" ") === NMCLI_RADIO_WIFI_ON.join(" "))).toHaveLength(2);
  });

  /**
   * The other half of the gate. R-NET-08 is an operator saying "no Wi-Fi, I
   * am flying", and a renderer that turned the radio back on at every apply
   * would overrule them on their own device.
   */
  it("does not touch the radio when nothing in the configuration wants one", async () => {
    const c: Config = structuredClone(DEFAULT_CONFIG);
    c.network.ap.enabled = false;
    c.network.ap.fallback.enabled = false;
    c.network.client.ssid = null;
    const { renderer, calls } = harness({ connections: [AP_CONNECTION, ETHERNET_CONNECTION] });
    await renderer.render(c);
    expect(at(calls, RFKILL_UNBLOCK_WIFI)).toBe(-1);
    expect(at(calls, NMCLI_RADIO_WIFI_ON)).toBe(-1);
  });

  it("still clears them when the access point is off but its fallback is not", async () => {
    // R-NET-07 raises the access point regardless of configuration, and `up
    // yonder-ap` cannot do that on a blocked radio. A configuration that
    // keeps the fallback has not disabled Wi-Fi.
    const c: Config = structuredClone(DEFAULT_CONFIG);
    c.network.ap.enabled = false;
    const { renderer, calls } = harness({ connections: [AP_CONNECTION, ETHERNET_CONNECTION] });
    await renderer.render(c);
    expect(at(calls, RFKILL_UNBLOCK_WIFI)).toBeGreaterThanOrEqual(0);
    expect(at(calls, NMCLI_RADIO_WIFI_ON)).toBeGreaterThanOrEqual(0);
  });

  it("clears them for a client-only configuration", async () => {
    const c: Config = structuredClone(DEFAULT_CONFIG);
    c.network.ap.enabled = false;
    c.network.ap.fallback.enabled = false;
    c.network.client.ssid = "HomeNetwork";
    const { renderer, calls } = harness({ connections: [AP_CONNECTION, ETHERNET_CONNECTION] });
    await renderer.render(c);
    expect(at(calls, RFKILL_UNBLOCK_WIFI)).toBeGreaterThanOrEqual(0);
  });

  it("renders on when rfkill is not installed", async () => {
    // `rfkill` is a separate binary and some boards do not carry it;
    // systemRunner reports a missing executable as exit 127. Neither the
    // access point nor anything else may be lost over it — and NetworkManager's
    // own flag, the lock a Raspberry Pi's state file holds, is still cleared.
    const { renderer, calls, raised } = harness({
      fails: { [RFKILL_UNBLOCK_WIFI.join(" ")]: { code: 127, stdout: "", stderr: "rfkill: not found" } },
    });
    await renderer.render(DEFAULT_CONFIG);
    expect(at(calls, NMCLI_RADIO_WIFI_ON)).toBeGreaterThanOrEqual(0);
    expect(calls.some((c) => c[2] === "add" && c[4] === AP_CONNECTION)).toBe(true);
    expect(raised()).toBe(1);
  });

  it("renders on when NetworkManager refuses to enable the radio", async () => {
    const { renderer, raised } = harness({
      fails: {
        [NMCLI_RADIO_WIFI_ON.join(" ")]: { code: 8, stdout: "", stderr: "Error: NetworkManager is not running." },
      },
    });
    await renderer.render(DEFAULT_CONFIG);
    // The real diagnosis belongs to `device status`, one step later, which
    // throws properly when NetworkManager genuinely is not there. Failing the
    // render here would only replace that message with a worse one.
    expect(raised()).toBe(1);
  });

  it("skips nothing on a board with no wifi device at all", async () => {
    // Ethernet-only hardware is legitimate. Both commands are no-ops there,
    // and running them anyway is deliberate: whether a device NetworkManager
    // has been told to keep the radio off for appears in `device status` is
    // NetworkManager's business, and a gate that waited to see one first
    // could never clear the block that hid it.
    const { renderer, calls } = harness({
      devices: "eth0:ethernet:connected:yonder-eth\nlo:loopback:unmanaged:\n",
    });
    await renderer.render(DEFAULT_CONFIG);
    expect(at(calls, RFKILL_UNBLOCK_WIFI)).toBeGreaterThanOrEqual(0);
    expect(calls.some((c) => c.includes(ETHERNET_CONNECTION))).toBe(true);
  });
});

/**
 * The radio, arbitrated (K-13, Task 5 of M1b-2).
 *
 * One radio can be an access point or a client, not both. What is under test
 * here is not *which* — `radioPlan` decides that and profiles.test.ts covers
 * it — but that the renderer carries the decision out in an order that keeps
 * the operator connected, and that a failed move never ends with nothing on
 * the air.
 */
describe("moving the radio", () => {
  /** A configuration that joins a network, with the access point as given. */
  function joining(apEnabled = true): Config {
    const config = structuredClone(DEFAULT_CONFIG);
    config.network.client.ssid = "HomeNetwork";
    config.network.client.psk = { secret: "wifi_psk" };
    config.network.ap.enabled = apEnabled;
    return config;
  }

  const ASSOCIATION_FAILED: CommandResult = {
    code: 4,
    stdout: "",
    stderr: "Error: Connection activation failed: Secrets were required, but not provided",
  };

  function order(calls: string[][]): string[] {
    return calls
      .filter((c) => c[1] === "connection" && (c[2] === "up" || c[2] === "down"))
      .map((c) => `${c[2]} ${c[3]}`);
  }

  /**
   * The operator is talking to this device over the access point, and the
   * access point is on the radio being retuned. Raise first, lower second.
   */
  it("takes the access point down before it raises the client", async () => {
    // One radio cannot associate while it is serving an access point. The
    // board answers `The Wi-Fi network could not be found` if you try.
    const { renderer, calls, secrets } = harness({ devices: withApActive(DEVICES) });
    secrets.ensure("wifi_psk", "psk");
    await renderer.render(joining());
    expect(order(calls)).toEqual([`down ${AP_CONNECTION}`, `up ${CLIENT_CONNECTION}`]);
  });

  /**
   * The board is now at its most exposed: the access point is down, the radio
   * is free, and the client did not associate. Nothing is on the air, and
   * putting the access point back is the only thing between the operator and
   * a device they cannot reach.
   */
  it("puts the access point back when the client does not associate", async () => {
    const { renderer, calls, secrets } = harness({
      devices: withApActive(DEVICES),
      fails: { [`nmcli connection up ${CLIENT_CONNECTION}`]: ASSOCIATION_FAILED },
    });
    secrets.ensure("wifi_psk", "psk");
    await expect(renderer.render(joining())).rejects.toThrow(/nmcli exited 4/);
    expect(order(calls)).toEqual([
      `down ${AP_CONNECTION}`,
      `up ${CLIENT_CONNECTION}`,
      `up ${AP_CONNECTION}`,
    ]);
  });

  /**
   * **The nasty one, and the reason this test exists at all.**
   *
   * An operator disables the access point and joins a network in one apply,
   * and the password is wrong. The access point is not up — `ap.enabled` is
   * false and nothing has raised it — and the client will not come up either.
   * Left alone that is a device with nothing on the air.
   *
   * Three things stand behind it and this is the first: the renderer raises
   * the access point itself, *regardless of what the configuration says*,
   * because R-NET-07 is about reachability and not about preference. Behind
   * that, the confirmation timer reverts the whole configuration; behind
   * that, the fallback watchdog. Doing it here as well is deliberate — the
   * watchdog fires once per daemon start and may have spent its one shot
   * hours ago (K-11), so a device that had been up a while would otherwise
   * have nothing left.
   */
  it("raises the access point anyway when a failed join would leave nothing up", async () => {
    const { renderer, calls, secrets } = harness({
      devices: DEVICES, // the access point is not on the air
      fails: { [`nmcli connection up ${CLIENT_CONNECTION}`]: ASSOCIATION_FAILED },
    });
    secrets.ensure("wifi_psk", "psk");

    await expect(renderer.render(joining(false))).rejects.toThrow(/nmcli exited 4/);

    // The access point came up, after the client's failure, and was never
    // taken down.
    expect(order(calls)).toEqual([`up ${CLIENT_CONNECTION}`, `up ${AP_CONNECTION}`]);
  });

  /**
   * And the profile it raises has to exist. Deleting `yonder-ap` when a
   * client is configured is the tidier-looking change that would make the
   * line above raise a connection nothing had created — K-16's failure, which
   * is a device unreachable until a power cycle.
   */
  it("still writes the access point's profile while in client mode", async () => {
    const { renderer, names, secrets } = harness({ devices: withApActive(DEVICES) });
    secrets.ensure("wifi_psk", "psk");
    await renderer.render(joining(false));
    expect(names.has(AP_CONNECTION)).toBe(true);
    expect(names.has(CLIENT_CONNECTION)).toBe(true);
  });

  /**
   * Re-issuing `up` on a live access point drops every joined station and
   * brings it back — including the operator watching the apply. So the rescue
   * is conditional, and when there was nothing to rescue it does nothing.
   */
  /**
   * Raised once, not twice.
   *
   * The guard behind this used to be about not re-raising an access point
   * that was still on the air — a real hazard, because `up` on a live access
   * point drops every joined station and brings it back, including the
   * operator watching the apply. With the ordering inverted that state can no
   * longer occur in client mode: the access point is always taken down first,
   * so it is never up when the client fails.
   *
   * What is still worth pinning is the property that survives: the recovery
   * issues exactly one `up`, so a failure cannot turn into a flapping radio.
   */
  it("raises the access point exactly once when the client fails", async () => {
    const { renderer, calls, secrets } = harness({
      devices: withApActive(DEVICES),
      fails: { [`nmcli connection up ${CLIENT_CONNECTION}`]: ASSOCIATION_FAILED },
    });
    secrets.ensure("wifi_psk", "psk");
    await expect(renderer.render(joining())).rejects.toThrow();
    expect(order(calls).filter((o) => o === `up ${AP_CONNECTION}`)).toHaveLength(1);
  });

  it("still says what it is doing in the words the hardware procedure quotes", async () => {
    const lines: string[] = [];
    const { renderer } = harness();
    // The renderer built by the harness has no log; build one that does,
    // sharing nothing else, so this asserts the wording and not the plumbing.
    const logging = new NetworkRenderer({
      client: (renderer as unknown as { client: NmcliClient }).client,
      secrets: new SecretStore(join(dir, "secrets2.yaml")),
      log: (l) => lines.push(l),
    });
    (logging as unknown as { secrets: SecretStore }).secrets.ensureValue("ap_psk", OPERATOR_PSK);
    await logging.render(DEFAULT_CONFIG);
    expect(lines).toContain("network: bringing the access point up");
  });
});

describe("NetworkRenderer and a modem", () => {
  it("creates the modem connection and never deletes a connection it does not own", async () => {
    // OWNED is the list of connections this renderer will delete. A modem
    // connection missing from it would be created and then removed on the
    // very next render as a stray.
    const config = {
      ...DEFAULT_CONFIG,
      network: {
        ...DEFAULT_CONFIG.network,
        modem: { ...DEFAULT_CONFIG.network.modem, enabled: true, apn: "ereseller" },
      },
    };
    const { renderer, calls } = harness({
      devices: "wlan0:wifi:disconnected:\ncdc-wdm0:gsm:disconnected:\n",
    });
    await renderer.render(config);
    const added = calls.filter((c) => c.includes("add")).map((c) => c.join(" "));
    expect(added.some((c) => c.includes(MODEM_CONNECTION) && c.includes("gsm"))).toBe(true);
    expect(calls.some((c) => c.includes("delete") && c.includes(MODEM_CONNECTION))).toBe(false);
  });
});
