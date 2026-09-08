// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { Intent, type IntentClock, type IntentGrant } from "./intent.js";

class ManualClock implements IntentClock {
  time = 1_000;
  timers = new Map<number, { at: number; callback: () => void }>();
  serial = 0;
  now = (): number => this.time;
  setTimer = (ms: number, callback: () => void): number => {
    const id = ++this.serial;
    this.timers.set(id, { at: this.time + ms, callback });
    return id;
  };
  clearTimer = (id: unknown): void => { this.timers.delete(id as number); };
  advance(ms: number, dispatch = true): void {
    this.time += ms;
    if (dispatch) for (const [id, timer] of [...this.timers]) {
      if (timer.at <= this.time) {
        this.timers.delete(id);
        timer.callback();
      }
    }
  }
}
let token = 0;
function setup(leaseMs = 500) {
  const clock = new ManualClock();
  const intent = new Intent({ clock, leaseMs, tokenFactory: () => `token-${++token}` });
  return { clock, intent };
}
function issue(intent: Intent, owner = "alice", clientGesture?: string): IntentGrant {
  const result = intent.issue(owner, clientGesture);
  if (!result.accepted) throw new Error(result.reason);
  return result.grant;
}
function admit(intent: Intent, grant: IntentGrant, seq = 0, owner = "alice") {
  return intent.admit(owner, { ...grant, seq, rate: { pan: 12, tilt: -3 } });
}
function next(intent: Intent, grant: IntentGrant, seq = 0): IntentGrant {
  const result = admit(intent, grant, seq);
  if (!result.accepted || !result.next) throw new Error("admission failed");
  return result.next;
}

describe("daemon-owned camera intent", () => {
  it("issue creates no motion; admission carries owner and per-command validity", () => {
    const { intent } = setup();
    const grant = issue(intent);
    expect(grant.deadline).toBe(1_500);
    expect(intent.live()).toBeNull();
    expect(admit(intent, grant)).toMatchObject({ accepted: true });
    expect(intent.live()).toMatchObject({ owner: "alice", gesture: grant.gesture, rate: { pan: 12, tilt: -3 }, deadline: 1_500 });
    expect(intent.live()?.isValid()).toBe(true);
  });

  it("successful renewal consumes its credential and aborts the superseded queued rate", () => {
    const { intent, clock } = setup();
    const grant = issue(intent);
    const renewal = next(intent, grant);
    const old = intent.live()!;
    clock.advance(100);
    const result = admit(intent, renewal, 1);
    expect(result).toMatchObject({ accepted: true, next: { deadline: 1_600 } });
    expect(old.signal.aborted).toBe(true);
    expect(old.isValid()).toBe(false);
    expect(intent.live()?.signal.aborted).toBe(false);
  });

  it.each([
    ["wrong owner", "owner", "mallory"],
    ["previous gesture", "gesture", "previous"],
    ["forged credential", "credential", "forged"],
    ["future forged deadline", "deadline", 999_999],
    ["altered earlier deadline", "deadline", 1_499],
    ["nonfinite deadline", "deadline", NaN],
    ["negative sequence", "seq", -1],
    ["fractional sequence", "seq", 0.5],
    ["nonfinite sequence", "seq", Infinity],
    ["unsafe sequence", "seq", Number.MAX_SAFE_INTEGER + 1],
    ["nonfinite pan", "rate", { pan: NaN, tilt: 0 }],
    ["nonfinite tilt", "rate", { pan: 0, tilt: Infinity }],
    ["string rate", "rate", { pan: "1", tilt: 0 }],
    ["missing rate", "rate", null],
  ])("rejects %s without changing rate or consuming the next grant", (_name, key, value) => {
    const { intent, clock } = setup();
    const renewal = next(intent, issue(intent));
    const live = intent.live()!;
    clock.advance(100);
    const request = { ...renewal, seq: 1, rate: { pan: 90, tilt: 0 }, [key]: value };
    expect(intent.admit(key === "owner" ? value as string : "alice", request)).toMatchObject({ accepted: false });
    expect(intent.live()).toBe(live);
    expect(live.signal.aborted).toBe(false);
    expect(admit(intent, renewal, 1)).toMatchObject({ accepted: true });
  });

  it("only fresh admitted renewals sustain a held gesture beyond its first deadline", () => {
    const { intent, clock } = setup();
    let grant = issue(intent);
    for (let seq = 0; seq < 12; seq++) {
      clock.advance(100);
      grant = next(intent, grant, seq);
      expect(intent.live()?.isValid()).toBe(true);
    }
    const command = intent.live()!;
    clock.advance(399);
    expect(command.isValid()).toBe(true);
    clock.advance(1);
    expect(command.signal.aborted).toBe(true);
    expect(intent.live()).toBeNull();
    expect(admit(intent, grant, 12)).toMatchObject({ accepted: false });
  });

  it("rejects a reused credential even with an increasing sequence", () => {
    const { intent } = setup();
    const grant = issue(intent);
    const renewal = next(intent, grant);
    expect(admit(intent, grant, 1)).toMatchObject({ accepted: false, reason: "credential" });
    expect(admit(intent, renewal, 1)).toMatchObject({ accepted: true });
  });

  it.each([4, 5])("rejects old or duplicate sequence %s with a fresh credential", seq => {
    const { intent } = setup();
    const renewal = next(intent, issue(intent), 5);
    expect(admit(intent, renewal, seq)).toMatchObject({ accepted: false, reason: "sequence" });
    expect(admit(intent, renewal, 6)).toMatchObject({ accepted: true });
  });

  it("rejects an issued grant at its deadline without a timer callback", () => {
    const { intent, clock } = setup();
    const grant = issue(intent);
    clock.advance(500, false);
    expect(admit(intent, grant)).toMatchObject({ accepted: false });
    expect(intent.live()).toBeNull();
  });

  it("lost browser expires and aborts without any stop or live read", () => {
    const { intent, clock } = setup();
    const grant = issue(intent);
    admit(intent, grant);
    const command = intent.live()!;
    clock.advance(499);
    expect(command.signal.aborted).toBe(false);
    clock.advance(1);
    expect(command.signal.aborted).toBe(true);
    expect(intent.live()).toBeNull();
  });

  it.each(["live", "dispatch"])("%s rejects an expired command when the timer has not run", check => {
    const { intent, clock } = setup();
    const grant = issue(intent);
    clock.advance(490);
    const renewal = next(intent, grant);
    const command = intent.live()!;
    expect(renewal.deadline).toBe(1_990);
    expect(command.expiresAt).toBe(1_500);
    clock.advance(10, false);
    if (check === "live") expect(intent.live()).toBeNull();
    else expect(command.isValid()).toBe(false);
    expect(command.signal.aborted).toBe(true);
    expect(admit(intent, renewal, 1)).toMatchObject({ accepted: false });
  });

  it("grant freshness and a shorter forwarding lease have independent deadlines", () => {
    const { intent, clock } = setup(120);
    const grant = issue(intent);
    expect(grant.deadline).toBe(1_500);
    clock.advance(100);
    const renewal = next(intent, grant);
    expect(renewal.deadline).toBe(1_600);
    const command = intent.live()!;
    expect(command.deadline).toBe(1_500);
    expect(command.expiresAt).toBe(1_220);
    clock.advance(120, false);
    expect(command.isValid()).toBe(false);
    expect(command.signal.aborted).toBe(true);
  });

  it("a shorter forwarding budget is enforced independently of browser timing", () => {
    const { intent, clock } = setup(120);
    admit(intent, issue(intent));
    const command = intent.live()!;
    clock.advance(120, false);
    expect(command.isValid()).toBe(false);
    expect(command.signal.aborted).toBe(true);
  });

  it("late end and frames cannot affect a newer gesture", () => {
    const { intent } = setup();
    const old = issue(intent);
    const oldRenewal = next(intent, old);
    const oldCommand = intent.live()!;
    const fresh = issue(intent);
    expect(oldCommand.signal.aborted).toBe(true);
    admit(intent, fresh);
    const current = intent.live();
    intent.end("alice", old.gesture);
    intent.end("mallory", fresh.gesture);
    expect(admit(intent, oldRenewal, 1)).toMatchObject({ accepted: false });
    expect(intent.live()).toBe(current);
    intent.end("alice", fresh.gesture);
    expect(current?.signal.aborted).toBe(true);
    expect(intent.live()).toBeNull();
    expect(admit(intent, fresh, 2)).toMatchObject({ accepted: false });
  });

  it("end needs no unexpired credential", () => {
    const { intent, clock } = setup();
    const grant = issue(intent);
    admit(intent, grant);
    const command = intent.live()!;
    clock.advance(500, false);
    intent.end("alice", grant.gesture);
    expect(command.signal.aborted).toBe(true);
    expect(intent.live()).toBeNull();
  });

  it("zero cancels the generation; a later rate needs a new gesture", () => {
    const { intent } = setup();
    const renewal = next(intent, issue(intent));
    const command = intent.live()!;
    expect(intent.admit("alice", { ...renewal, seq: 1, rate: { pan: 0, tilt: 0 } })).toEqual({ accepted: true, next: null });
    expect(command.signal.aborted).toBe(true);
    expect(intent.live()).toBeNull();
    expect(admit(intent, renewal, 2)).toMatchObject({ accepted: false });
    expect(admit(intent, issue(intent))).toMatchObject({ accepted: true });
  });

  it.each(["disconnect", "reset"] as const)("%s discards all motion; reconnect requires new issue", method => {
    const { intent } = setup();
    const renewal = next(intent, issue(intent));
    const command = intent.live()!;
    intent[method]();
    expect(command.signal.aborted).toBe(true);
    expect(intent.live()).toBeNull();
    expect(admit(intent, renewal, 1)).toMatchObject({ accepted: false });
    expect(admit(intent, issue(intent))).toMatchObject({ accepted: true });
  });

  it("another owner cannot take over an unexpired gesture, even before motion", () => {
    const { intent, clock } = setup();
    const grant = issue(intent);
    expect(intent.issue("bob")).toEqual({ accepted: false, reason: "busy" });
    expect(admit(intent, grant)).toMatchObject({ accepted: true });
    clock.advance(500, false);
    expect(intent.issue("bob")).toMatchObject({ accepted: true });
  });

  it("replayed issue for the same active client gesture cannot replace it", () => {
    const { intent } = setup();
    const grant = issue(intent, "alice", "drag-1");
    admit(intent, grant);
    const command = intent.live();
    expect(intent.issue("alice", "drag-1")).toEqual({ accepted: false, reason: "gesture" });
    expect(intent.live()).toBe(command);
    issue(intent, "alice", "drag-2");
    expect(command?.signal.aborted).toBe(true);
  });

  it.each(["", "white space", "a\n", "x".repeat(129), null, 12])("rejects malformed owner and client id %j", value => {
    const { intent } = setup();
    expect(intent.issue(value as string)).toMatchObject({ accepted: false });
    expect(intent.issue("alice", value as string)).toMatchObject({ accepted: false });
    const grant = issue(intent);
    expect(admit(intent, grant, 0, value as string)).toMatchObject({ accepted: false, reason: "malformed" });
    expect(intent.live()).toBeNull();
  });

  it.each([null, [], {}, { rate: [] }, { rate: null }])("rejects malformed request %j", request => {
    const { intent } = setup();
    const grant = issue(intent);
    expect(intent.admit("alice", request)).toMatchObject({ accepted: false, reason: "malformed" });
    expect(admit(intent, grant)).toMatchObject({ accepted: true });
  });

  it("rejects arrays carrying otherwise valid request or rate fields", () => {
    const { intent } = setup();
    const grant = issue(intent);
    const request = { ...grant, seq: 0, rate: { pan: 12, tilt: -3 } };
    expect(intent.admit("alice", Object.assign([], request))).toMatchObject({ accepted: false, reason: "malformed" });
    expect(intent.admit("alice", { ...request, rate: Object.assign([], request.rate) })).toMatchObject({ accepted: false, reason: "malformed" });
    expect(admit(intent, grant)).toMatchObject({ accepted: true });
  });

  it("stale timer callbacks cannot leave an orphan expiry timer", () => {
    const { intent, clock } = setup();
    const grant = issue(intent);
    const staleCallback = [...clock.timers.values()][0].callback;
    admit(intent, grant);
    staleCallback();
    expect(clock.timers.size).toBe(1);
    intent.reset();
    expect(clock.timers.size).toBe(0);
  });

  it("an early timer callback preserves expiry and a bounded timer count", () => {
    const { intent, clock } = setup();
    admit(intent, issue(intent));
    const command = intent.live()!;
    const [id, timer] = [...clock.timers][0];
    clock.timers.delete(id);
    clock.advance(499, false);
    timer.callback();
    expect(command.signal.aborted).toBe(false);
    expect(clock.timers.size).toBe(1);
    clock.advance(1);
    expect(command.signal.aborted).toBe(true);
  });

  it("camera instances do not accept each other's grants", () => {
    const first = setup().intent;
    const second = setup().intent;
    const grant = issue(first);
    issue(second);
    expect(admit(second, grant)).toMatchObject({ accepted: false });
    expect(second.live()).toBeNull();
  });

  it("external mutation cannot change admitted motion or daemon grants", () => {
    const { intent } = setup();
    const grant = issue(intent);
    const request = { ...grant, seq: 0, rate: { pan: 10, tilt: 2 } };
    const result = intent.admit("alice", request);
    expect(result.accepted).toBe(true);
    request.rate.pan = 300;
    expect(intent.live()?.rate.pan).toBe(10);
    expect(() => { intent.live()!.rate.pan = 400; }).toThrow();
    expect(() => { grant.deadline = 999_999; }).toThrow();
  });

  it("retains only one timer across many replacements, renewals and endings", () => {
    const { intent, clock } = setup();
    for (let i = 0; i < 1_000; i++) {
      const grant = issue(intent);
      next(intent, grant);
      expect(clock.timers.size).toBe(1);
    }
    intent.reset();
    expect(clock.timers.size).toBe(0);
  });

  it.each([0, -1, 501, Infinity, NaN])("refuses an invalid forwarding lease %s", leaseMs => {
    expect(() => setup(leaseMs)).toThrow();
  });

  it("production clock uses monotonic time despite a backward wall-clock change", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const monotonic = vi.spyOn(process.hrtime, "bigint");
    try {
      monotonic.mockReturnValue(1_000_000_000n);
      const intent = new Intent();
      const grant = issue(intent);
      expect(grant.deadline).toBe(1_500);
      admit(intent, grant);
      const command = intent.live()!;
      vi.setSystemTime(-1_000_000);
      monotonic.mockReturnValue(1_500_000_000n);
      expect(command.isValid()).toBe(false);
      expect(command.signal.aborted).toBe(true);
      intent.reset();
    } finally {
      monotonic.mockRestore();
      vi.useRealTimers();
    }
  });
});
