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
  metricFor,
} from "./profiles.js";
import { STOOD_DOWN_METRIC } from "./modem/profiles.js";
import type { PathName, StandingView } from "./reach/standing.js";
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
  /**
   * What nmcli reports in the TYPE column for a connection this board already
   * holds, overriding the kind its name implies.
   *
   * The one way to express an operator changing what kind of modem they have:
   * `yonder-modem` exists, it is a `gsm` connection, and `config.yaml` now
   * asks for an ethernet one on a named adapter.
   */
  connectionTypes?: Record<string, string>;
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
  /** Which paths have stopped reaching anything (R-NET-13). */
  standing?: StandingView;
  /** Where the renderer's log lines go, for a test that asserts wording. */
  log?: (line: string) => void;
  /**
   * Where the nmcli client's own lines go — every command it runs, redacted.
   *
   * A second sink rather than `log`, because that is what the daemon does:
   * `note` for what the device did and `trace` for the commands it ran, so
   * the activity pane does not fill with `device status` twice a tick. The
   * fake used to pass neither, which meant no test could see the argv the
   * renderer actually sent.
   */
  trace?: (line: string) => void;
  /**
   * What the modem connection is *already dialled on*, as nmcli would report
   * it before this render writes anything.
   *
   * This is the state a fake cannot invent and a real board has: a bearer
   * that came up on one APN and a `config.yaml` that now says another. It
   * seeds the fake's memory of the connection, so a render that writes the
   * same values back finds no difference and one that writes a new APN does.
   */
  dialled?: Record<string, string>;
  /** Told when a path has actually been re-dialled (R-CEL-09). */
  onRedial?: (path: PathName) => void;
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
/**
 * What `nmcli connection show` reports in its TYPE column, per profile.
 *
 * The fake used to answer `802-11-wireless` for everything, and that single
 * untruth is why nothing noticed that a connection's type was never compared
 * against the one now wanted: with every profile reported as the same kind,
 * both the old code that ignored the question and the new code that asks it
 * behave identically. A fake that answers one thing about every subject
 * cannot test a decision made about the difference between subjects.
 *
 * The values are the setting names nmcli actually prints — `802-3-ethernet`,
 * not `ethernet` — which is the whole reason `typeDiffers` needs a map.
 */
const REPORTED_TYPE: Record<string, string> = {
  [AP_CONNECTION]: "802-11-wireless",
  [CLIENT_CONNECTION]: "802-11-wireless",
  [ETHERNET_CONNECTION]: "802-3-ethernet",
  [MODEM_CONNECTION]: "gsm",
};

/** The same map from the other side: what `connection add` was given. */
const REPORTED_FOR_ADDED: Record<string, string> = {
  wifi: "802-11-wireless",
  ethernet: "802-3-ethernet",
  gsm: "gsm",
};

function harness(opts: HarnessOptions = {}) {
  const calls: string[][] = [];
  const names = new Set(opts.connections ?? []);
  /** The TYPE column, kept in step with adds and deletes. */
  const types = new Map<string, string>();
  for (const name of opts.connections ?? []) {
    types.set(name, opts.connectionTypes?.[name] ?? REPORTED_TYPE[name] ?? "802-11-wireless");
  }
  /**
   * Every `setting.property` this fake has been told, per connection.
   *
   * Without it `connection show yonder-modem` can only replay a fixture, so a
   * second identical render looks exactly like a changed APN — and the check
   * that stops a working cellular link being cycled on every render could be
   * deleted with the suite green.
   */
  const stored = new Map<string, Map<string, string>>();
  const remember = (name: string, argv: string[], from: number): void => {
    const kept = stored.get(name) ?? new Map<string, string>();
    for (let i = from; i + 1 < argv.length; i += 2) kept.set(argv[i]!, argv[i + 1]!);
    stored.set(name, kept);
  };
  if (opts.dialled !== undefined) {
    stored.set(MODEM_CONNECTION, new Map(Object.entries(opts.dialled)));
  }
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
      return ok([...names]
        .map((n) => `${n}:u-${n}:${types.get(n) ?? ""}:\n`)
        .join(""));
    }
    // `nmcli -t -f <props> connection show <name>`: one `property:value` line
    // per field asked for, in the order asked, and an empty value for a
    // property this connection has never been given.
    if (argv[1] === "-t" && argv[4] === "connection" && argv[5] === "show") {
      const kept = stored.get(argv[6]!) ?? new Map<string, string>();
      return ok((argv[3] ?? "").split(",").map((f) => `${f}:${kept.get(f) ?? ""}\n`).join(""));
    }
    if (argv[1] === "connection") {
      // add is ["nmcli","connection","add","con-name",<name>,"type",T,
      // "ifname",I,…pairs]; the rest put the name at argv[3], and modify's
      // pairs follow "connection.interface-name",I.
      if (argv[2] === "add") {
        names.add(argv[4]);
        types.set(argv[4]!, REPORTED_FOR_ADDED[argv[6]!] ?? argv[6]!);
        remember(argv[4]!, argv, 9);
      }
      if (argv[2] === "modify") remember(argv[3]!, argv, 4);
      if (argv[2] === "delete") {
        names.delete(argv[3]);
        types.delete(argv[3]!);
        stored.delete(argv[3]!);
      }
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
    client: new NmcliClient(run, opts.trace),
    secrets,
    log: opts.log,
    clock: opts.clock,
    radioWaitMs: opts.radioWaitMs,
    standing: opts.standing,
    onRedial: opts.onRedial,
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
   * a device they cannot reach. Once it is back, the device is reachable, so
   * the render resolves rather than rolling the operator's change back over
   * a network that simply was not there (R-NET-15, K-37).
   */
  it("puts the access point back when the client does not associate, and resolves", async () => {
    const { renderer, calls, secrets } = harness({
      devices: withApActive(DEVICES),
      fails: { [`nmcli connection up ${CLIENT_CONNECTION}`]: ASSOCIATION_FAILED },
    });
    secrets.ensure("wifi_psk", "psk");
    await renderer.render(joining());
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

    // And the render resolves: the rescue put the device back on the air, so
    // there is nothing left for a rollback to protect (R-NET-15).
    await renderer.render(joining(false));

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
    await renderer.render(joining());
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

/**
 * The boot race measured on a Raspberry Pi 4: `yonder-modem` already existed
 * from an earlier, working boot, and this render's `device status` read came
 * back one second before ModemManager finished probing the modem — no `gsm`
 * device in the list. The old code read "wanted" off `desiredProfiles`'s own
 * hardware-gated output, so that one reading looked exactly like an operator
 * who had turned cellular off, and the render deleted the profile.
 * `connection.autoconnect yes` with unlimited `connection.autoconnect-retries`
 * — set by `modemProfile` for R-CEL-06 — would otherwise have dialled the
 * modem the instant it appeared; instead cellular stayed down until the
 * operator re-entered the settings by hand, because nothing in this daemon
 * re-renders on its own (K-44).
 *
 * The same conflation reached every profile this renderer owns, not only the
 * modem — the modem is only where it was measured, being the one interface
 * that shows up seconds after the others — so this covers the others too.
 */
describe("NetworkRenderer and a connection whose device has not appeared yet (R-NET-16)", () => {
  it("leaves the modem profile untouched when cellular is enabled but no modem is visible", async () => {
    const config: Config = structuredClone(DEFAULT_CONFIG);
    config.network.modem.enabled = true;
    config.network.modem.apn = "ereseller";
    // The harness default device list, DEVICES, lists no gsm device — the
    // exact reading measured on the board, one second before ModemManager
    // finished probing the modem.
    const { renderer, calls } = harness({
      connections: [AP_CONNECTION, ETHERNET_CONNECTION, MODEM_CONNECTION],
    });
    await renderer.render(config);
    expect(argvOf(calls, "delete", MODEM_CONNECTION)).toBeUndefined();
    expect(argvOf(calls, "modify", MODEM_CONNECTION)).toBeUndefined();
    expect(calls.some((c) => c[1] === "connection" && c[2] === "add" && c[4] === MODEM_CONNECTION)).toBe(false);
  });

  it("still removes the modem profile when cellular is disabled, exactly as before", async () => {
    const { renderer, calls } = harness({
      connections: [AP_CONNECTION, ETHERNET_CONNECTION, MODEM_CONNECTION],
    });
    // DEFAULT_CONFIG.network.modem.enabled is false, and the harness default
    // device list has no gsm device either — the profile is unwanted twice
    // over, and removed exactly as it was before this change.
    await renderer.render(DEFAULT_CONFIG);
    expect(argvOf(calls, "delete", MODEM_CONNECTION)).toBeDefined();
  });

  it("still writes the modem profile normally when the modem is visible", async () => {
    const config: Config = structuredClone(DEFAULT_CONFIG);
    config.network.modem.enabled = true;
    config.network.modem.apn = "ereseller";
    const { renderer, calls } = harness({
      devices: "eth0:ethernet:connected:yonder-eth\nwlan0:wifi:disconnected:\ncdc-wdm0:gsm:disconnected:\n",
    });
    await renderer.render(config);
    expect(calls.some((c) => c[1] === "connection" && c[2] === "add" && c[4] === MODEM_CONNECTION)).toBe(true);
    expect(argvOf(calls, "delete", MODEM_CONNECTION)).toBeUndefined();
  });

  /**
   * The same protection, for a profile with nothing modem-specific about it.
   * A cable pulled — or a USB Ethernet adapter a few seconds slower to
   * enumerate than the interfaces `harness()` lists by default — must not
   * cost the operator a working wired profile either.
   */
  it("leaves the ethernet profile untouched when its device is missing but the connection exists", async () => {
    const { renderer, calls } = harness({
      devices: "wlan0:wifi:disconnected:\nlo:loopback:unmanaged:\n",
      connections: [AP_CONNECTION, ETHERNET_CONNECTION],
    });
    await renderer.render(DEFAULT_CONFIG);
    expect(argvOf(calls, "delete", ETHERNET_CONNECTION)).toBeUndefined();
  });

  it("leaves the access point and wifi client profiles untouched when no wifi radio is listed at all", async () => {
    const config: Config = structuredClone(DEFAULT_CONFIG);
    config.network.client.ssid = "HomeNetwork";
    const { renderer, calls } = harness({
      devices: "eth0:ethernet:connected:yonder-eth\nlo:loopback:unmanaged:\n",
      connections: [AP_CONNECTION, CLIENT_CONNECTION, ETHERNET_CONNECTION],
    });
    await renderer.render(config);
    expect(argvOf(calls, "delete", AP_CONNECTION)).toBeUndefined();
    expect(argvOf(calls, "delete", CLIENT_CONNECTION)).toBeUndefined();
  });
});

/**
 * A written setting that only a dial reads is a setting that has not been
 * applied (R-CEL-09).
 *
 * Measured on the board: connected on `ereseller`, `network.modem.apn`
 * changed to `nxtgenphone`, the daemon restarted, the profile rewritten — and
 * `GET /modem/state` went on reporting `apn: ereseller` and the same address.
 * NetworkManager does not re-dial a bearer that is already up because the
 * profile behind it changed, so correcting a mistyped APN from the console —
 * the recovery action this whole milestone is built around — did nothing at
 * all.
 *
 * No fake catches this by answering questions, because a fake re-dials on
 * demand and reports whatever it is asked. What these pin is the **shape of
 * what is asked**: a changed bearer setting produces a down and an up, and an
 * unchanged one produces neither.
 */
describe("NetworkRenderer and a modem whose settings changed", () => {
  const MODEM_DEVICES =
    "wlan0:wifi:disconnected:\ncdc-wdm0:gsm:connected:yonder-modem\nlo:loopback:unmanaged:\n";
  /** The same board with the bearer not up: nothing to cycle. */
  const MODEM_DOWN =
    "wlan0:wifi:disconnected:\ncdc-wdm0:gsm:disconnected:\nlo:loopback:unmanaged:\n";

  function onApn(apn: string): Config {
    const c: Config = structuredClone(DEFAULT_CONFIG);
    c.network.modem.enabled = true;
    c.network.modem.apn = apn;
    return c;
  }

  /** The verbs issued against the modem connection, in order. */
  const verbs = (calls: string[][]): string[] =>
    calls.filter((c) => c[1] === "connection" && c[3] === MODEM_CONNECTION).map((c) => c[2]!);

  it("brings a changed APN down and up so the new setting is dialled", async () => {
    const { renderer, calls } = harness({
      devices: MODEM_DEVICES,
      connections: [AP_CONNECTION, ETHERNET_CONNECTION, MODEM_CONNECTION],
      dialled: { "gsm.apn": "ereseller" },
    });
    await renderer.render(onApn("nxtgenphone"));

    // The profile is rewritten, and then — because that alone changes
    // nothing on a bearer that is up — the link is cycled, down before up.
    expect(verbs(calls)).toEqual(["modify", "down", "up"]);
    // And the value it is dialled with is the new one.
    const modify = argvOf(calls, "modify", MODEM_CONNECTION)!;
    expect(modify[modify.indexOf("gsm.apn") + 1]).toBe("nxtgenphone");
  });

  it("asks what the modem is dialled on before it overwrites the answer", async () => {
    // The ordering that makes the comparison possible at all: once
    // addOrModify has run the stored profile already says what was wanted,
    // and a read after it can never find a difference.
    const { renderer, calls } = harness({
      devices: MODEM_DEVICES,
      connections: [AP_CONNECTION, ETHERNET_CONNECTION, MODEM_CONNECTION],
      dialled: { "gsm.apn": "ereseller" },
    });
    await renderer.render(onApn("nxtgenphone"));

    const read = calls.findIndex((c) => c[1] === "-t" && c[5] === "show" && c[6] === MODEM_CONNECTION);
    const write = calls.findIndex((c) => c[2] === "modify" && c[3] === MODEM_CONNECTION);
    expect(read).toBeGreaterThanOrEqual(0);
    expect(read).toBeLessThan(write);
    // Only the settings a dial reads are asked about. A route metric is
    // `device reapply`'s business and must never cycle a link.
    //
    // All four of them, not only the one the configuration holds: this board
    // has no username, password or dial string, so those are being *cleared*,
    // and a bearer setting being removed is a change to the bearer exactly as
    // one being altered is. `gsm.password` is asked about and answers nothing
    // — nmcli does not print a secret without `--show-secrets` — which
    // `bearerChanges` reads as "cannot tell" rather than as a difference, so
    // the question costs nothing and reads nothing (R-SEC-10).
    const asked = (calls[read]![3] ?? "").split(",");
    expect(asked.sort()).toEqual(["gsm.apn", "gsm.number", "gsm.password", "gsm.username"]);
    expect(asked.some((f) => f.includes("route-metric"))).toBe(false);
  });

  it("leaves a working link alone when nothing about the bearer changed", async () => {
    // A render happens for many reasons. Reactivating a working cellular
    // link on every one of them is unacceptable on an aircraft.
    const { renderer, calls } = harness({
      devices: MODEM_DEVICES,
      connections: [AP_CONNECTION, ETHERNET_CONNECTION, MODEM_CONNECTION],
      dialled: { "gsm.apn": "ereseller" },
    });
    await renderer.render(onApn("ereseller"));
    expect(verbs(calls)).toEqual(["modify"]);
  });

  it("does not cancel boot dialling because nmcli masks the password (R-CEL-06)", async () => {
    const { renderer, calls } = harness({
      devices: MODEM_DEVICES.replace("gsm:connected:", "gsm:connecting (prepare):"),
      connections: [AP_CONNECTION, ETHERNET_CONNECTION, MODEM_CONNECTION],
      dialled: { "gsm.apn": "ereseller", "gsm.password": "<hidden>" },
    });
    await renderer.render(onApn("ereseller"));
    expect(verbs(calls)).toEqual(["modify"]);
    const modify = argvOf(calls, "modify", MODEM_CONNECTION)!;
    expect(modify[modify.indexOf("connection.autoconnect-retries") + 1]).toBe("0");
    expect(calls.some((c) => c.includes("--show-secrets"))).toBe(false);
  });

  it("does not cycle the link when only the route metric moved", async () => {
    // `network.priority` edited, or a path stood down: the metric changes on
    // every render that follows, and a bearer picks a metric up in place.
    const config = onApn("ereseller");
    config.network.priority = ["modem", "ethernet", "wifi_client"];
    const { renderer, calls } = harness({
      devices: MODEM_DEVICES,
      connections: [AP_CONNECTION, ETHERNET_CONNECTION, MODEM_CONNECTION],
      dialled: { "gsm.apn": "ereseller", "ipv4.route-metric": "700" },
    });
    await renderer.render(config);
    const modify = argvOf(calls, "modify", MODEM_CONNECTION)!;
    expect(Number(modify[modify.indexOf("ipv4.route-metric") + 1]))
      .toBe(metricFor(config, "modem"));
    expect(verbs(calls)).toEqual(["modify"]);
  });

  it("does not cycle the link on a second, identical render", async () => {
    // The end-to-end version of the same property, through the fake's own
    // memory of what the first render wrote.
    const { renderer, calls } = harness({
      devices: MODEM_DEVICES,
      connections: [AP_CONNECTION, ETHERNET_CONNECTION, MODEM_CONNECTION],
      dialled: { "gsm.apn": "ereseller" },
    });
    const config = onApn("ereseller");
    await renderer.render(config);
    calls.length = 0;
    await renderer.render(config);
    expect(verbs(calls)).toEqual(["modify"]);
  });

  it("does not cycle a bearer that is not up", async () => {
    // Nothing to cycle, and `connection.autoconnect` will dial it with the
    // new settings. Taking down what is already down and raising it here
    // would be this renderer deciding to dial rather than following.
    const { renderer, calls } = harness({
      devices: MODEM_DOWN,
      connections: [AP_CONNECTION, ETHERNET_CONNECTION, MODEM_CONNECTION],
      dialled: { "gsm.apn": "ereseller" },
    });
    await renderer.render(onApn("nxtgenphone"));
    expect(verbs(calls)).toEqual(["modify"]);
  });

  it("leaves the link alone when it cannot read what the modem is dialled on", async () => {
    // A question that could not be asked is not a difference. Answering
    // "changed" to it would cycle a working cellular link on the strength of
    // nothing.
    const { renderer, calls } = harness({
      devices: MODEM_DEVICES,
      connections: [AP_CONNECTION, ETHERNET_CONNECTION, MODEM_CONNECTION],
      dialled: { "gsm.apn": "ereseller" },
      fails: {
        [`nmcli -t -f gsm.apn,gsm.username,gsm.password,gsm.number `
          + `connection show ${MODEM_CONNECTION}`]:
          { code: 10, stdout: "", stderr: "Error: yonder-modem - no such connection profile." },
      },
    });
    await renderer.render(onApn("nxtgenphone"));
    expect(verbs(calls)).toEqual(["modify"]);
  });

  it("never asks about a connection it is about to create", async () => {
    // A profile that does not exist yet has nothing to compare against, and
    // a freshly created one is dialled with the settings it was created
    // with.
    const { renderer, calls } = harness({ devices: MODEM_DEVICES });
    await renderer.render(onApn("ereseller"));
    expect(calls.some((c) => c[1] === "-t" && c[6] === MODEM_CONNECTION)).toBe(false);
    expect(verbs(calls)).toEqual([]);
  });

  it("asks nothing extra of an appliance modem, which has no bearer to dial", async () => {
    const config: Config = structuredClone(DEFAULT_CONFIG);
    config.network.modem.enabled = true;
    config.network.modem.mode = "appliance";
    config.network.modem.interface = "usb0";
    const { renderer, calls } = harness({
      devices: "wlan0:wifi:disconnected:\nusb0:ethernet:connected:yonder-modem\n",
      connections: [AP_CONNECTION, MODEM_CONNECTION],
      // A board already running an appliance: `yonder-modem` is the ethernet
      // connection this mode writes, not the `gsm` one the name would suggest.
      connectionTypes: { [MODEM_CONNECTION]: "802-3-ethernet" },
      dialled: { "ipv4.route-metric": "700" },
    });
    await renderer.render(config);
    expect(calls.some((c) => c[1] === "-t" && c[6] === MODEM_CONNECTION)).toBe(false);
    expect(verbs(calls)).toEqual(["modify"]);
  });

  /**
   * **A re-dial is a link coming up, and the renderer is the only thing that
   * knows one happened** (R-CEL-09).
   *
   * Measured on the board: the APN was changed to a wrong one, the modem
   * re-dialled correctly onto a new bearer and a new address, and the link
   * carried nothing — `curl --interface wwan0` exit 28, no ping returned.
   * Nothing tested it, because a re-dial keeps the same interface name and
   * because cellular was not the path in use, so no byte counter said
   * anything either. The console went on calling the link ready.
   */
  it("says so when it has actually re-dialled a path", async () => {
    const told: PathName[] = [];
    const { renderer } = harness({
      devices: MODEM_DEVICES,
      connections: [AP_CONNECTION, ETHERNET_CONNECTION, MODEM_CONNECTION],
      dialled: { "gsm.apn": "ereseller" },
      onRedial: (path) => told.push(path),
    });
    await renderer.render(onApn("nxtgenphone"));
    expect(told).toEqual(["modem"]);
  });

  it("says nothing when the render did not re-dial anything", async () => {
    // A render happens for many reasons and almost none of them are a
    // re-dial. Announcing one on every render would put a `curl` on a
    // metered link every time an operator saved an unrelated setting.
    const told: PathName[] = [];
    const { renderer } = harness({
      devices: MODEM_DEVICES,
      connections: [AP_CONNECTION, ETHERNET_CONNECTION, MODEM_CONNECTION],
      dialled: { "gsm.apn": "ereseller" },
      onRedial: (path) => told.push(path),
    });
    await renderer.render(onApn("ereseller"));
    expect(told).toEqual([]);
  });

  it("says nothing about a bearer it did not cycle because it was down", async () => {
    // Nothing came up, so nothing came up to be tested. The link will be
    // dialled with the new settings by `connection.autoconnect`, and the
    // watch's own link-up reason covers it from there.
    const told: PathName[] = [];
    const { renderer } = harness({
      devices: MODEM_DOWN,
      connections: [AP_CONNECTION, ETHERNET_CONNECTION, MODEM_CONNECTION],
      dialled: { "gsm.apn": "ereseller" },
      onRedial: (path) => told.push(path),
    });
    await renderer.render(onApn("nxtgenphone"));
    expect(told).toEqual([]);
  });

  it("does not let a listener that throws fail a render that worked", async () => {
    // The re-dial succeeded: the operator's corrected APN is dialled and up.
    // Throwing here would fail the render, and the apply engine's
    // confirmation timer would roll that correction straight back out again
    // (R-CFG-03) on the strength of a notification nobody was waiting for.
    const lines: string[] = [];
    const { renderer, calls } = harness({
      devices: MODEM_DEVICES,
      connections: [AP_CONNECTION, ETHERNET_CONNECTION, MODEM_CONNECTION],
      dialled: { "gsm.apn": "ereseller" },
      log: (l) => lines.push(l),
      onRedial: () => { throw new Error("the watch has already stopped"); },
    });
    await expect(renderer.render(onApn("nxtgenphone"))).resolves.toBeUndefined();
    // And it still re-dialled, and said what went wrong.
    expect(verbs(calls)).toEqual(["modify", "down", "up"]);
    expect(lines.some((l) => l.includes("could not pass on that cellular was re-dialled"))).toBe(true);
  });
});

/**
 * **What is generated matches the configuration, including what the
 * configuration no longer says** (R-CFG-13).
 *
 * Two ways a profile can stop describing the document it was generated from,
 * and both were silent. A connection's *type* cannot be changed, so an
 * operator moving between the two kinds of modem wrote ethernet properties
 * onto a profile that stayed `gsm`. And `nmcli connection modify` writes only
 * what it is given, so a setting cleared in `config.yaml` was simply omitted
 * and the stored value went on being dialled — with the file saying one thing
 * and the bearer doing another, and nothing anywhere saying which was true.
 */
describe("NetworkRenderer and a profile that no longer matches the configuration", () => {
  const MODEM_DEVICES =
    "wlan0:wifi:disconnected:\ncdc-wdm0:gsm:connected:yonder-modem\nlo:loopback:unmanaged:\n";
  const APPLIANCE_DEVICES =
    "wlan0:wifi:disconnected:\nusb0:ethernet:connected:yonder-modem\nlo:loopback:unmanaged:\n";

  const verbs = (calls: string[][]): string[] =>
    calls.filter((c) => c[1] === "connection" && c[3] === MODEM_CONNECTION).map((c) => c[2]!);
  const added = (calls: string[][]): string[] | undefined =>
    calls.find((c) => c[2] === "add" && c[4] === MODEM_CONNECTION);
  const modified = (calls: string[][]): string[] | undefined =>
    calls.find((c) => c[2] === "modify" && c[3] === MODEM_CONNECTION);

  function auto(apn: string | null = "ereseller"): Config {
    const c: Config = structuredClone(DEFAULT_CONFIG);
    c.network.modem.enabled = true;
    c.network.modem.mode = "auto";
    c.network.modem.apn = apn;
    return c;
  }

  function appliance(): Config {
    const c: Config = structuredClone(DEFAULT_CONFIG);
    c.network.modem.enabled = true;
    c.network.modem.mode = "appliance";
    c.network.modem.interface = "usb0";
    return c;
  }

  it("replaces the modem's profile when the operator changes what kind of modem it is", async () => {
    // Both modes write a connection called `yonder-modem`, so this is a
    // profile that exists, keeps its name, and has to become a different kind
    // of thing. NetworkManager offers no way to do that but delete and create.
    const { renderer, calls } = harness({
      devices: APPLIANCE_DEVICES,
      connections: [AP_CONNECTION, MODEM_CONNECTION],
      connectionTypes: { [MODEM_CONNECTION]: "gsm" },
    });
    await renderer.render(appliance());

    expect(verbs(calls)).toEqual(["delete"]);
    const add = added(calls);
    expect(add, "the modem's profile was deleted and never created again").toBeDefined();
    expect(add?.[add.indexOf("type") + 1]).toBe("ethernet");
    expect(add?.[add.indexOf("ifname") + 1]).toBe("usb0");
    // And nothing was written onto the old profile on the way past.
    expect(modified(calls)).toBeUndefined();
  });

  it("replaces it the other way too, when an appliance becomes a modem the system finds", async () => {
    const { renderer, calls } = harness({
      devices: MODEM_DEVICES,
      connections: [AP_CONNECTION, MODEM_CONNECTION],
      connectionTypes: { [MODEM_CONNECTION]: "802-3-ethernet" },
    });
    await renderer.render(auto());

    expect(verbs(calls)).toEqual(["delete"]);
    const add = added(calls);
    expect(add?.[add.indexOf("type") + 1]).toBe("gsm");
    expect(add?.[add.indexOf("ifname") + 1]).toBe("cdc-wdm0");
  });

  it("says which kind it found and which kind it now wants", async () => {
    const lines: string[] = [];
    const { renderer } = harness({
      devices: APPLIANCE_DEVICES,
      connections: [AP_CONNECTION, MODEM_CONNECTION],
      connectionTypes: { [MODEM_CONNECTION]: "gsm" },
      log: (l) => lines.push(l),
    });
    await renderer.render(appliance());
    const said = lines.find((l) => l.includes("created again"));
    expect(said, "nothing an operator reads says the modem's profile was remade").toBeDefined();
    expect(said).toContain(MODEM_CONNECTION);
    expect(said).toContain("ethernet");
  });

  /**
   * **The half that must never fire.** This decision deletes a profile, and
   * one of the profiles it is asked about is the access point an operator may
   * be joined to over the one radio. A profile whose type has not changed is
   * modified in place, on every render, for ever.
   */
  it("replaces nothing whose type is what it always was", async () => {
    const { renderer, calls } = harness({
      devices: MODEM_DEVICES,
      connections: [AP_CONNECTION, ETHERNET_CONNECTION, MODEM_CONNECTION],
    });
    // All three, on every render, for ever. `yonder-eth` used to be carved
    // out of this assertion, because this board lists no ethernet device and
    // the ownership loop used to read that absence as "no longer wanted" —
    // the same defect R-NET-16 closed for the modem. Removal is decided from
    // configuration alone now, so all three belong in one assertion.
    const replaced = (): string[][] =>
      calls.filter((c) => c[2] === "delete"
        && (c[3] === AP_CONNECTION || c[3] === ETHERNET_CONNECTION || c[3] === MODEM_CONNECTION));
    await renderer.render(auto());
    expect(replaced()).toEqual([]);
    await renderer.render(auto());
    expect(replaced()).toEqual([]);
  });

  /**
   * A TYPE column this project does not recognise is a question that could not
   * be asked, and the answer to that is never "different". Being wrong the
   * other way drops every station on the radio.
   */
  it("leaves a connection alone when it cannot tell what kind it is", async () => {
    const { renderer, calls } = harness({
      devices: MODEM_DEVICES,
      connections: [AP_CONNECTION, MODEM_CONNECTION],
      connectionTypes: { [MODEM_CONNECTION]: "" },
    });
    await renderer.render(auto());
    expect(verbs(calls)).toEqual(["modify"]);
  });

  /**
   * **An emptied setting is removed from the device, not left standing.**
   *
   * The measured shape of the defect: `gsm.apn` was omitted from the desired
   * profile when the configuration held none, `nmcli connection modify` wrote
   * only what it was given, and the modem went on dialling `ereseller` while
   * `config.yaml` said there was no APN at all.
   */
  it("resets a bearer setting the configuration no longer holds", async () => {
    const { renderer, calls } = harness({
      devices: MODEM_DEVICES,
      connections: [AP_CONNECTION, MODEM_CONNECTION],
      dialled: { "gsm.apn": "ereseller" },
    });
    await renderer.render(auto(null));

    const modify = modified(calls);
    expect(modify).toBeDefined();
    const at = modify!.indexOf("gsm.apn");
    expect(at, "the profile does not mention the APN it is meant to be clearing")
      .toBeGreaterThan(0);
    expect(modify![at + 1]).toBe("");
  });

  it("re-dials, because a bearer setting being removed is a change to the bearer", async () => {
    // The comparison could not see this before: a property absent from the
    // desired profile is a property `bearerChanges` never asks nmcli about, so
    // clearing an APN wrote a reset and left the modem on the old bearer.
    const { renderer, calls } = harness({
      devices: MODEM_DEVICES,
      connections: [AP_CONNECTION, MODEM_CONNECTION],
      dialled: { "gsm.apn": "ereseller" },
    });
    await renderer.render(auto(null));
    expect(verbs(calls)).toEqual(["modify", "down", "up"]);
  });

  it("clears the credential the same way, and never writes one into a line", async () => {
    const lines: string[] = [];
    const { renderer, calls } = harness({
      devices: MODEM_DEVICES,
      connections: [AP_CONNECTION, MODEM_CONNECTION],
      dialled: { "gsm.apn": "ereseller", "gsm.username": "sim-user" },
      trace: (l) => lines.push(l),
    });
    // A configuration with no password at all: `password: null` is the file's
    // own word for "there is no credential", and it has to reach the device.
    await renderer.render(auto(null));

    const modify = modified(calls)!;
    for (const property of ["gsm.apn", "gsm.username", "gsm.password", "gsm.number"]) {
      expect(modify[modify.indexOf(property) + 1], `${property} was not reset`).toBe("");
    }
    // R-SEC-10. The line that *writes* the property shows `<redacted>` where
    // the value would be, and the redaction covers the empty one exactly as it
    // covers any other — so nothing in the journal can be read as a password,
    // and nothing says whether this device has one. The other line carrying
    // the word is the field list of the bearer read, `-f gsm.apn,…`, which has
    // no value in it at all.
    const written = lines.filter((l) => l.includes("connection modify") && l.includes("gsm.password"));
    expect(written.length).toBeGreaterThan(0);
    for (const line of written) expect(line).toContain("gsm.password <redacted>");
  });

  /**
   * **Nothing is reset on a profile being created.** There is no stored value
   * to remove, and `connection add` with no APN is the shipped path a board
   * was measured on — sending it an empty one would be a change to something
   * that works, for nothing.
   */
  it("sends no empty property when it is creating the profile", async () => {
    const { renderer, calls } = harness({ devices: MODEM_DEVICES });
    await renderer.render(auto(null));
    const add = added(calls);
    expect(add).toBeDefined();
    expect(add).not.toContain("gsm.apn");
    expect(add).not.toContain("gsm.password");
    expect(add?.includes("")).toBe(false);
  });
});


/**
 * **A radio that will not settle must not take the modem down with it.**
 *
 * Measured on a board whose configured Wi-Fi network had simply moved out of
 * range. Every render reached `settleRadio`, the client could not associate,
 * the access point was raised again — R-NET-07 doing exactly its job — and
 * the render threw. The re-dial sat after it and never ran, so a corrected
 * APN was written into the profile and the modem stayed dialled on the old
 * one: the recovery action the whole of M3a is built around, unreachable on
 * any board with an out-of-range network configured. A compound of K-37.
 *
 * The ordering itself is still right, and stays: a modem that will not dial
 * must not be able to skip the step that keeps the access point on the air.
 * What was wrong is that two independent subsystems shared one failure path.
 */
describe("NetworkRenderer when the radio will not settle and the modem must be re-dialled", () => {
  /** Both radios on one board: an access point on the air, a modem dialled. */
  const RADIO_AND_MODEM = withApActive(
    "wlan0:wifi:disconnected:\ncdc-wdm0:gsm:connected:yonder-modem\nlo:loopback:unmanaged:\n",
  );

  /** What the board says when the configured network is not in range. */
  const NOT_IN_RANGE: CommandResult = {
    code: 4,
    stdout: "",
    stderr: "Error: Connection activation failed: The Wi-Fi network could not be found",
  };

  /** What a modem says when it will not come back up. */
  const MODEM_WONT_DIAL: CommandResult = {
    code: 4,
    stdout: "",
    stderr: "Error: Connection activation failed: No suitable device found",
  };

  /**
   * What nmcli says when moving the access point itself — up or down,
   * whichever a test is about — does not go the way it was asked. The
   * message is deliberately unlike `NOT_IN_RANGE` and unlike the phrase
   * `NmcliClient.down` tolerates ("is not an active connection"): what makes
   * a test use this is *which command* it is attached to, never the words in
   * it (R-NET-15 — this is never classified by parsing nmcli's English).
   */
  const AP_WONT_MOVE: CommandResult = {
    code: 1,
    stdout: "",
    stderr: "Error: Device or resource busy",
  };

  /** Joins a network that is not in range, and corrects the modem's APN. */
  function joiningAndCorrectingApn(): Config {
    const c: Config = structuredClone(DEFAULT_CONFIG);
    c.network.client.ssid = "HomeNetwork";
    c.network.client.psk = { secret: "wifi_psk" };
    c.network.modem.enabled = true;
    c.network.modem.apn = "nxtgenphone";
    return c;
  }

  function board(fails: Record<string, CommandResult>, log?: (line: string) => void) {
    const h = harness({
      devices: RADIO_AND_MODEM,
      connections: [AP_CONNECTION, ETHERNET_CONNECTION, MODEM_CONNECTION],
      dialled: { "gsm.apn": "ereseller" },
      fails,
      log,
    });
    h.secrets.ensure("wifi_psk", "psk");
    return h;
  }

  /** The verbs issued against the modem connection, in order. */
  const verbs = (calls: string[][]): string[] =>
    calls.filter((c) => c[1] === "connection" && c[3] === MODEM_CONNECTION).map((c) => c[2]!);

  /**
   * R-NET-15. The client could not associate, but the access point came back
   * up — R-NET-07 doing exactly its job — so the device was reachable
   * throughout. That is the apply succeeding, not failing: the render
   * resolves, and the corrected APN this whole scenario exists for is still
   * re-dialled onto the modem (K-37).
   */
  it("resolves and still re-dials the modem, because the access point coming back keeps the device reachable", async () => {
    const { renderer, calls } = board({
      [`nmcli connection up ${CLIENT_CONNECTION}`]: NOT_IN_RANGE,
    });

    await renderer.render(joiningAndCorrectingApn());

    // The rescue ran...
    expect(calls.some((c) => c[2] === "up" && c[3] === AP_CONNECTION)).toBe(true);
    // ...and the profile was rewritten and then actually dialled with the new APN.
    expect(verbs(calls)).toEqual(["modify", "down", "up"]);
    const modify = argvOf(calls, "modify", MODEM_CONNECTION)!;
    expect(modify[modify.indexOf("gsm.apn") + 1]).toBe("nxtgenphone");
  });

  /**
   * The other way the access point can be up when the client fails: taking
   * it down is what did not work, so it was never down to begin with. This
   * reaches reachability the same way and skips the rescue outright — which
   * is the point of the test. Re-`up`ping a connection that is already live
   * would drop every station joined to it, including the operator watching
   * this apply, so nothing here re-issues `up` on one nmcli never actually
   * took down.
   */
  it("resolves without re-raising the access point when it was never taken down", async () => {
    const { renderer, calls } = board({
      [`nmcli connection down ${AP_CONNECTION}`]: AP_WONT_MOVE,
    });

    await renderer.render(joiningAndCorrectingApn());

    expect(calls.some((c) => c[2] === "up" && c[3] === AP_CONNECTION)).toBe(false);
  });

  /**
   * Reachability is checked, not assumed. When the rescue itself fails,
   * nothing has established that this device can still be reached, so
   * R-NET-15 does not apply — the render rejects, and with the client's
   * original failure rather than the rescue's, because that is the one that
   * explains what an operator needs to fix.
   */
  it("rejects with the radio's original failure when raising the access point also fails", async () => {
    const { renderer } = board({
      [`nmcli connection up ${CLIENT_CONNECTION}`]: NOT_IN_RANGE,
      [`nmcli connection up ${AP_CONNECTION}`]: AP_WONT_MOVE,
    });

    await expect(renderer.render(joiningAndCorrectingApn()))
      .rejects.toThrow(/The Wi-Fi network could not be found/);
  });

  /**
   * Once the radio has recovered there is no radio failure left for a modem
   * failure to be measured against — so it is not displaced and it is not
   * swallowed either. A modem that will not dial is still
   * reachability-affecting and still belongs behind the confirmation timer
   * (R-CEL-09, R-CFG-03); R-NET-15 only ever concerns the radio's own
   * failure.
   */
  it("rejects with the modem's failure once the radio has recovered", async () => {
    const { renderer } = board({
      [`nmcli connection up ${CLIENT_CONNECTION}`]: NOT_IN_RANGE,
      [`nmcli connection up ${MODEM_CONNECTION}`]: MODEM_WONT_DIAL,
    });

    await expect(renderer.render(joiningAndCorrectingApn()))
      .rejects.toThrow(/No suitable device found/);
  });

  /**
   * And when the modem alone fails, its failure is the render's — nothing
   * else has gone wrong to displace it.
   */
  it("reports the modem's failure when the radio settled", async () => {
    const { renderer } = board({
      [`nmcli connection up ${MODEM_CONNECTION}`]: MODEM_WONT_DIAL,
    });
    const c = joiningAndCorrectingApn();
    c.network.client.ssid = "";
    await expect(renderer.render(c)).rejects.toThrow(/No suitable device found/);
  });

  /**
   * The ordering the comment in `render` is about, pinned for the case where
   * both steps succeed: the radio is arbitrated first, and the modem is
   * cycled after it. A modem that will not dial must never be able to skip
   * the step that puts the access point back on the air (R-NET-07).
   */
  it("arbitrates the radio before it re-dials the modem", async () => {
    const { renderer, calls } = board({});
    await renderer.render(joiningAndCorrectingApn());

    const activations = calls
      .filter((c) => c[1] === "connection" && (c[2] === "up" || c[2] === "down"))
      .map((c) => `${c[2]} ${c[3]}`);
    expect(activations).toEqual([
      `down ${AP_CONNECTION}`,
      `up ${CLIENT_CONNECTION}`,
      `down ${MODEM_CONNECTION}`,
      `up ${MODEM_CONNECTION}`,
    ]);
  });
});

/**
 * R-NET-13's second half: **and traffic moves to the next path that works.**
 *
 * The renderer stays the only thing that writes a route metric; a change of
 * standing changes what it writes and then makes the device take it up.
 * `Standing` correctly worked out that a path had stopped reaching anything
 * long before any of this existed — and nothing acted on it, so a stood-down
 * ethernet kept its carrier, kept its winning metric and kept the default
 * route indefinitely while the log line said traffic had moved.
 */
describe("NetworkRenderer moves traffic off a path that stopped working", () => {
  const saying = (...down: PathName[]): StandingView => {
    const set = new Set<PathName>(down);
    return { isStoodDown: (path) => set.has(path) };
  };

  /** A board with all three paths configured, so every egress connection exists. */
  function threePaths(): Config {
    const c: Config = structuredClone(DEFAULT_CONFIG);
    c.network.client.ssid = "HomeNetwork";
    c.network.modem.enabled = true;
    c.network.modem.apn = "ereseller";
    return c;
  }

  const ALL_DEVICES =
    "eth0:ethernet:connected:yonder-eth\nwlan0:wifi:connected:yonder-wifi\n"
    + "cdc-wdm0:gsm:connected:yonder-modem\nlo:loopback:unmanaged:\n";

  const metricIn = (calls: string[][], name: string): number | undefined => {
    const call = calls.find((c) => c[1] === "connection" && c[2] === "modify" && c[3] === name);
    const at = call?.indexOf("ipv4.route-metric") ?? -1;
    return call === undefined || at === -1 ? undefined : Number(call[at + 1]);
  };

  it("writes the losing metric on a stood-down path and leaves the others alone", async () => {
    const config = threePaths();
    const { renderer, calls } = harness({
      devices: ALL_DEVICES,
      connections: [AP_CONNECTION, CLIENT_CONNECTION, ETHERNET_CONNECTION, MODEM_CONNECTION],
      standing: saying("ethernet"),
    });
    await renderer.remetric(config);

    expect(metricIn(calls, ETHERNET_CONNECTION))
      .toBe(metricFor(config, "ethernet") + STOOD_DOWN_METRIC);
    expect(metricIn(calls, MODEM_CONNECTION)).toBe(metricFor(config, "modem"));
    expect(metricIn(calls, CLIENT_CONNECTION)).toBe(metricFor(config, "wifi_client"));
    // The point of the number: the modem now wins.
    expect(metricIn(calls, ETHERNET_CONNECTION)!)
      .toBeGreaterThan(metricIn(calls, MODEM_CONNECTION)!);
  });

  it("gives the configured metric back when the path recovers", async () => {
    const config = threePaths();
    const { renderer, calls } = harness({
      devices: ALL_DEVICES,
      connections: [AP_CONNECTION, CLIENT_CONNECTION, ETHERNET_CONNECTION, MODEM_CONNECTION],
      standing: saying(),
    });
    await renderer.remetric(config);
    expect(metricIn(calls, ETHERNET_CONNECTION)).toBe(metricFor(config, "ethernet"));
    expect(metricIn(calls, ETHERNET_CONNECTION)!)
      .toBeLessThan(metricIn(calls, MODEM_CONNECTION)!);
  });

  it("writes the same metric on v6 as on v4", async () => {
    // A board can hold a v6 default route as well as a v4 one, and moving
    // traffic off a path that reaches nothing means moving all of it.
    const config = threePaths();
    const { renderer, calls } = harness({
      devices: ALL_DEVICES,
      connections: [ETHERNET_CONNECTION],
      standing: saying("ethernet"),
    });
    await renderer.remetric(config);
    const call = calls.find((c) => c[2] === "modify" && c[3] === ETHERNET_CONNECTION)!;
    expect(call[call.indexOf("ipv6.route-metric") + 1])
      .toBe(call[call.indexOf("ipv4.route-metric") + 1]);
  });

  it("makes the running device take the new metric up, without cycling it", async () => {
    // `device reapply` re-applies the connection in place: the link is not
    // taken down, the address is not released, and the on-link route stays —
    // which is what makes this safe against a cable an operator is sitting on.
    const config = threePaths();
    const { renderer, calls } = harness({
      devices: ALL_DEVICES,
      connections: [ETHERNET_CONNECTION],
      standing: saying("ethernet"),
    });
    await renderer.remetric(config);
    expect(calls.some((c) => c.join(" ") === "nmcli device reapply eth0")).toBe(true);
    expect(calls.some((c) => c[1] === "device" && c[2] === "disconnect")).toBe(false);
    expect(calls.some((c) => c[1] === "connection" && c[2] === "down")).toBe(false);
  });

  it("never touches the access point, the radio, or anything it does not own", async () => {
    // Rule 6. Re-issuing `up` on a live access point drops every station
    // joined to it, including the operator; deleting a profile is how K-16
    // left a board unreachable until a power cycle. A path stopping working
    // is not a reason to do either.
    // The radio is on the access point, which is how an operator reaches a
    // board that has no way out — exactly the board this runs on.
    const config = threePaths();
    config.network.client.ssid = null;
    const { renderer, calls, raised } = harness({
      devices: "eth0:ethernet:connected:yonder-eth\nwlan0:wifi:connected:yonder-ap\n"
        + "cdc-wdm0:gsm:connected:yonder-modem\nlo:loopback:unmanaged:\n",
      connections: [AP_CONNECTION, ETHERNET_CONNECTION, MODEM_CONNECTION, "operator-vpn"],
      standing: saying("ethernet"),
    });
    await renderer.remetric(config);

    expect(calls.some((c) => c.includes(AP_CONNECTION))).toBe(false);
    expect(calls.some((c) => c.includes("operator-vpn"))).toBe(false);
    expect(calls.some((c) => c[1] === "connection" && (c[2] === "add" || c[2] === "delete"))).toBe(false);
    expect(calls.some((c) => c[1] === "connection" && (c[2] === "up" || c[2] === "down"))).toBe(false);
    // The radio, serving the access point, is not reapplied by any of this.
    expect(calls.some((c) => c.join(" ") === "nmcli device reapply wlan0")).toBe(false);
    expect(calls.some((c) => c[0] === "rfkill" || c.includes("radio"))).toBe(false);
    expect(raised()).toBe(0);
  });

  it("writes nothing for a connection NetworkManager does not hold", async () => {
    // Only what a render has already created. This can never be the thing
    // that brings a profile into existence, and it can never reapply a device
    // on behalf of one.
    const config = threePaths();
    const { renderer, calls } = harness({
      devices: ALL_DEVICES, connections: [ETHERNET_CONNECTION], standing: saying("ethernet"),
    });
    await renderer.remetric(config);
    expect(calls.some((c) => c.includes(MODEM_CONNECTION))).toBe(false);
    expect(calls.some((c) => c.join(" ") === "nmcli device reapply cdc-wdm0")).toBe(false);
  });

  it("carries on when one connection will not take the metric", async () => {
    // A modem whose metric could not be rewritten must not stop the
    // ethernet's from being. There is nobody to report an error to here: the
    // caller is a probe result folding into standing, not an apply.
    const config = threePaths();
    const { renderer, calls } = harness({
      devices: ALL_DEVICES,
      connections: [CLIENT_CONNECTION, ETHERNET_CONNECTION, MODEM_CONNECTION],
      standing: saying("ethernet"),
      fails: {
        [`nmcli connection modify ${CLIENT_CONNECTION} ipv4.route-metric `
          + `${metricFor(threePaths(), "wifi_client")} ipv6.route-metric `
          + `${metricFor(threePaths(), "wifi_client")}`]:
          { code: 1, stdout: "", stderr: "Error: unknown connection" },
      },
    });
    await renderer.remetric(config);
    expect(metricIn(calls, ETHERNET_CONNECTION))
      .toBe(metricFor(config, "ethernet") + STOOD_DOWN_METRIC);
    expect(metricIn(calls, MODEM_CONNECTION)).toBe(metricFor(config, "modem"));
  });

  it("does not undo a demotion on a full render", async () => {
    // Profiles are written at render time and standing changes at runtime, so
    // this is the half that could quietly put a dead path back at the head of
    // the routing table on the next unrelated apply.
    const config = threePaths();
    const { renderer, calls } = harness({
      devices: ALL_DEVICES,
      connections: [AP_CONNECTION, CLIENT_CONNECTION, ETHERNET_CONNECTION, MODEM_CONNECTION],
      standing: saying("ethernet"),
    });
    await renderer.render(config);
    expect(metricIn(calls, ETHERNET_CONNECTION))
      .toBe(metricFor(config, "ethernet") + STOOD_DOWN_METRIC);
    expect(metricIn(calls, MODEM_CONNECTION)).toBe(metricFor(config, "modem"));
  });
});
