// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { fanOut, messageFor, unreadableRows } from "./state.js";
import type { ModemState, PathEvidence, ReachState } from "yonder-core";

const MODEM: ModemState = {
  mode: "connected", summary: "Connected to Dark Star",
  operator: "Dark Star", technology: "lte", registration: "home",
  apn: "ereseller", address: "10.16.166.223", mtu: 1430,
  signal: { rssi: -71, rsrq: -12, rsrp: -99, snr: 16 },
  ports: ["cdc-wdm0 (mbim)", "wwan0 (net)"], reportsSignal: true,
};

const REACH: ReachState = {
  inUse: "ethernet", carrying: true,
  paths: [
    { path: "ethernet", device: "eth0", standing: "in-use", since: null, evidence: "reaching", detail: "Carrying traffic" },
    { path: "modem", device: "wwan0", standing: "standing-by", since: null, evidence: "reaching", detail: "Ready — traffic is not going out over cellular" },
  ],
};

/** One standing-by path, with whatever the daemon knows about it. */
const withModem = (evidence: PathEvidence): ReachState => ({
  ...REACH,
  paths: [
    { path: "modem", device: "wwan0", standing: "standing-by", since: null, evidence,
      detail: "whatever the sentence happens to say" },
  ],
});

describe("messageFor", () => {
  it("carries the four signal numbers with their units", () => {
    const p = messageFor(MODEM, REACH).payload;
    expect(p.signal.strength).toBe("-99 dBm");
    expect(p.signal.quality).toBe("16 dB");
    expect(p.signal.rssi).toBe("-71 dBm");
    expect(p.signal.rsrq).toBe("-12 dB");
  });

  it("reports the raw numbers too, because a gauge needs a number", () => {
    const p = messageFor(MODEM, REACH).payload;
    expect(p.gauges.strength).toBe(-99);
    expect(p.gauges.quality).toBe(16);
  });

  it("says an appliance modem cannot report signal, rather than showing none", () => {
    // R-CEL-11. Four dashes read as a fault; "this kind of modem does not
    // report it" does not.
    const p = messageFor({ ...MODEM, reportsSignal: false }, REACH).payload;
    expect(p.reportsSignal).toBe(false);
    expect(p.showsSignal, "an appliance has no gauge to draw").toBe(false);
  });

  /**
   * The defect this field exists to stop, pinned as the two cases that
   * differ.
   *
   * `reportsSignal` is a property of the *kind* of modem and is true whenever
   * one is not an appliance — including on a board with no modem in it at
   * all, which has no kind. A Status panel hiding its gauges on that field
   * alone would draw two empty gauges on exactly the board §5 says must have
   * none, and a gauge with no needle reads as a fault.
   */
  it("has no signal to show on a board with no modem, though the field says otherwise", () => {
    const none = messageFor({ ...MODEM, mode: "absent", summary: "No modem found" }, REACH).payload;
    expect(none.reportsSignal, "the field the panel must not bind to").toBe(true);
    expect(none.showsSignal, "the one it does").toBe(false);
  });

  it("still draws the gauges for a modem that is present and not yet connected", () => {
    // A radio that has not registered yet is reporting a signal it cannot use.
    // That is a reading, and hiding it would hide the one number that says why.
    for (const mode of ["unconfigured", "joining", "waiting", "connected", "failed"] as const) {
      expect(messageFor({ ...MODEM, mode }, REACH).payload.showsSignal, mode).toBe(true);
    }
  });

  it("names every path in the operator's order for the Way out panel", () => {
    const p = messageFor(MODEM, REACH).payload;
    expect(p.paths.map((x) => x.name)).toEqual(["Ethernet", "Cellular"]);
    expect(p.paths[1].detail).toBe("Ready — traffic is not going out over cellular");
  });

  it("gives Status one word for how the device is reachable", () => {
    expect(messageFor(MODEM, REACH).payload.reachableBy).toBe("ETHERNET");
    expect(messageFor(MODEM, { ...REACH, inUse: "modem" }).payload.reachableBy).toBe("CELLULAR");
  });

  it("draws a path that is reaching differently from one nobody has tested", () => {
    // The regression. `standing-by` covers both, so a row coloured off
    // `standing` alone gives a working path and an untested one the same lamp
    // — in the one panel whose entire job is telling those apart (R-UI-11).
    const reaching = messageFor(MODEM, withModem("reaching")).payload.paths[0];
    const untested = messageFor(MODEM, withModem("untested")).payload.paths[0];
    const failing = messageFor(MODEM, withModem("not-reaching")).payload.paths[0];

    expect(reaching.tone).toBe("good");
    expect(untested.tone).toBe("neutral");
    expect(failing.tone).toBe("bad");
    expect(new Set([reaching.tone, untested.tone, failing.tone]).size).toBe(3);
  });

  it("carries the evidence itself, not only the lamp it lit", () => {
    expect(messageFor(MODEM, withModem("untested")).payload.paths[0].evidence).toBe("untested");
  });

  it("colours a row off evidence and never off the sentence beside it", () => {
    // `detail` is prose for an operator and has been reworded once already.
    // Nothing may parse it.
    const p = messageFor(MODEM, withModem("reaching")).payload.paths[0];
    expect(p.detail).toBe("whatever the sentence happens to say");
    expect(p.tone).toBe("good");
  });

  it("shows the radio technology as an initialism", () => {
    expect(messageFor(MODEM, REACH).payload.technology).toBe("LTE");
  });

  it("says so when nothing is carrying traffic at all", () => {
    const p = messageFor(MODEM, { ...REACH, inUse: null, carrying: false }).payload;
    expect(p.reachableBy).toBe("NOTHING");
  });
});

/**
 * The four outputs, which is the whole reason this is one node: every surface
 * that shows the modem is describing the same tick.
 */
describe("fanOut", () => {
  const outs = (reach: ReachState = REACH) => fanOut(messageFor(MODEM, reach).payload, 4242);

  it("gives the Cellular tab what the modem is and what it is doing", () => {
    const p = outs()[0].payload as Record<string, unknown>;
    expect(p.operator).toBe("Dark Star");
    expect(p.technology).toBe("LTE");
    expect(p.apn).toBe("ereseller");
    expect(p.portSummary).toBe("cdc-wdm0 (mbim) · wwan0 (net)");
  });

  /**
   * `ui-yonder-annunciator` renders a `CommandStatus` from `msg.yonder` and
   * nothing else, so the verdict has to arrive in that shape. Without this the
   * lamp on the Cellular tab reads "Ready" for ever, whatever the link is
   * doing — and a flow mapping one shape to the other would be logic in
   * `flows.json` (CLAUDE.md rule 2).
   */
  it("puts the verdict on the shared channel, in the shape the lamp reads", () => {
    expect(outs()[0].yonder).toEqual({
      state: "confirmed", message: "READY", at: 4242,
    });
  });

  it("says nothing is getting through when nothing is", () => {
    const dark: ReachState = {
      inUse: null, carrying: false,
      paths: [{ path: "modem", device: "wwan0", standing: "no-route-out", since: null,
        evidence: "not-reaching", detail: "Reached nothing" }],
    };
    expect((outs(dark)[0].yonder as { state: string }).state).toBe("rejected");
  });

  /**
   * The databar names keys in the object it is given, so the signal strings
   * sit at the top level of output 2 rather than one level down — and the
   * gauges' bare numbers travel beside them, because a gauge places a pointer
   * and a databar prints a fact.
   */
  it("flattens the signal strings for the databar and keeps the numbers for the gauges", () => {
    const p = outs()[1].payload as Record<string, unknown>;
    expect(p.rssi).toBe("-71 dBm");
    expect(p.rsrq).toBe("-12 dB");
    expect(p.gauges).toEqual({ strength: -99, quality: 16 });
  });

  it("gives the Way out panel one row per path and Status one word", () => {
    expect((outs()[2].payload as unknown[]).length).toBe(2);
    expect((outs()[3].payload as { reachableBy: string }).reachableBy).toBe("ETHERNET");
  });

  /**
   * Each row arrives with its lamp already lit (R-UI-11).
   *
   * The panel draws one `ui-yonder-annunciator` per path, and that widget
   * renders a `CommandStatus` and nothing else. A `change` node turning a
   * tone into a state would be a decision serialised beside wire coordinates
   * (CLAUDE.md rule 2), so the shape is built here and a flow only picks a
   * row out of the list.
   */
  it("lights each Way out row, so no flow has to turn a tone into a state", () => {
    const rows = outs()[2].payload as { name: string; status: unknown }[];
    expect(rows.map((r) => r.name)).toEqual(["Ethernet", "Cellular"]);
    expect(rows[0].status).toEqual({ state: "confirmed", message: "CARRYING TRAFFIC", at: 4242 });
    expect(rows[1].status).toEqual({ state: "confirmed", message: "READY", at: 4242 });
  });

  /**
   * The three states the panel exists to draw, on the row rather than only in
   * the sentence — the distinction `evidence` was added for.
   */
  it("draws an untested path neutral and a failing one bad", () => {
    const untested = outs(withModem("untested"))[2].payload as { status: { state: string } }[];
    expect(untested[0].status).toEqual({ state: "idle", message: "NOT YET TESTED", at: 4242 });
    const failing = outs(withModem("not-reaching"))[2].payload as { status: { state: string } }[];
    expect(failing[0].status).toEqual({ state: "rejected", message: "NOT REACHING", at: 4242 });
  });

  /**
   * The `Reachable by` panel on Status is built in the idiom of `This board` —
   * gauges over a labelled strip — so output 4 carries what a strip prints
   * and what a gauge places, taken from the same reading the Cellular tab
   * draws rather than read a second time.
   */
  it("gives Status the facts its strip prints and the numbers its gauges place", () => {
    const p = outs()[3].payload as Record<string, unknown>;
    expect(p.operator).toBe("Dark Star");
    expect(p.technology).toBe("LTE");
    expect(p.address).toBe("10.16.166.223");
    expect(p.gauges).toEqual({ strength: -99, quality: 16 });
    expect((p.bounds as { strength: { caution: number } }).strength.caution).toBe(-90);
    expect(p.showsSignal).toBe(true);
  });

  /**
   * The one-word answer is a lit lamp and not coloured text (R-UI-11), so it
   * has to arrive as a `CommandStatus` — the same reason the Cellular tab's
   * verdict does.
   */
  it("lights the one-word answer, and calls nothing at all a fault", () => {
    expect(outs()[3].yonder).toEqual({ state: "confirmed", message: "ETHERNET", at: 4242 });

    const dark: ReachState = { inUse: null, carrying: false, paths: [] };
    expect(outs(dark)[3].yonder).toEqual({ state: "rejected", message: "NOTHING", at: 4242 });
  });

  /**
   * The defect a capture found: a **green** lamp on the word `NOTHING`.
   *
   * `ReachState.carrying` is deliberately optimistic — it answers true when
   * nothing holds an address at all, because an address on an interface the
   * monitor has no path for is not its to condemn. The lamp was lit from it
   * while the word was chosen from `carrying && inUse !== null`, so the two
   * disagreed in exactly the state this harness is in.
   */
  it("never lights a green lamp on the word NOTHING", () => {
    const nobodyHolding: ReachState = { ...REACH, inUse: null, carrying: true };
    const out = outs(nobodyHolding)[3];
    expect((out.payload as { reachableBy: string }).reachableBy).toBe("NOTHING");
    expect(out.yonder).toEqual({ state: "rejected", message: "NOTHING", at: 4242 });
  });

  /**
   * The line under the word. The modem's own `summary` is about the radio and
   * said "Connected to Dark Star" under a lamp reading NOTHING; this says
   * which path stood down and when, which is what the lamp cannot carry.
   */
  it("says what changed and when, under the word", () => {
    expect((outs()[3].payload as { why: string }).why)
      .toBe("Ethernet is carrying traffic, and nothing has stood down");
    // And the modem's sentence still travels, for anything that wants it.
    expect((outs()[3].payload as { summary: string }).summary).toBe("Connected to Dark Star");
  });
});

/**
 * A tick the daemon could not answer (R-UI-05).
 *
 * Without these rows a `Way out` lamp falls back to `presentation("idle")`,
 * whose shared label is `Ready` — grey, claiming nothing, and wrong. The fix
 * is in the package rather than as a conditional in a `change` node, because
 * "if the daemon did not answer, say this instead" is a decision (CLAUDE.md
 * rule 2).
 */
describe("unreadableRows", () => {
  it("names every path and says nothing can be told about any of them", () => {
    const rows = unreadableRows("the daemon is not answering", 4242);
    expect(rows.map((r) => r.path)).toEqual(["ethernet", "modem", "wifi_client"]);
    expect(rows.map((r) => r.name)).toEqual(["Ethernet", "Cellular", "Wi-Fi"]);
    for (const row of rows) {
      expect(row.status).toEqual({ state: "rejected", message: "CANNOT TELL", at: 4242 });
      expect(row.detail).toBe("the daemon is not answering");
    }
  });

  /**
   * The word is the whole point of this. `Ready` is what the shared idle label
   * says, and it is the one thing a console must not say about a link it
   * cannot see.
   */
  it("never says Ready about a link it cannot see", () => {
    for (const row of unreadableRows("gone", 1)) {
      expect(row.status.message).not.toBe("Ready");
      expect(row.status.state, "and it is not the neutral lamp either").toBe("rejected");
    }
  });

  /**
   * Picked by name in the flow, so a row that does not answer to
   * `payload[path='wifi_client']` is a row that stays blank.
   */
  it("answers to the keys the panel picks rows by", () => {
    const rows = unreadableRows("gone", 1);
    for (const key of ["ethernet", "modem", "wifi_client"]) {
      expect(rows.find((r) => r.path === key), key).toBeDefined();
    }
  });
});
