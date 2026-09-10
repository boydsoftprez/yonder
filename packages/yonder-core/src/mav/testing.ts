// SPDX-License-Identifier: GPL-3.0-or-later
import type { Clock } from "../apply/types.js";

/**
 * Fixtures shared by this directory's tests: byte builders and a clock that
 * never touches the wall clock. Not part of the package's public surface —
 * not exported from `index.ts` — because a hand-built MAVLink frame is a test
 * input, never something a consumer of this package should be handed. The
 * daemon's own wiring test reads `heartbeatV2` from here too: the datagram it
 * sends at `127.0.0.1` is the one thing that proves the loopback listener,
 * the shared `LinkTracker` and `GET /mav/state` are joined rather than merely
 * present, and a second copy of these bytes over there would be two builders
 * that must agree.
 */

/** X25 / CRC-16-MCRF4XX, one byte at a time — MAVLink's own accumulator. */
function accumulate(byte: number, crc: number): number {
  let tmp = (byte ^ (crc & 0xff)) & 0xff;
  tmp = (tmp ^ (tmp << 4)) & 0xff;
  return ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xffff;
}

/** Build a MAVLink v2 HEARTBEAT so a test states its own input exactly. */
export function heartbeatV2(system: number, vehicleType: number, autopilot: number): Uint8Array {
  const payload = new Uint8Array(9);
  new DataView(payload.buffer).setUint32(0, 0, true); // custom_mode
  payload[4] = vehicleType;
  payload[5] = autopilot;
  payload[6] = 0;  // base_mode
  payload[7] = 4;  // system_status
  payload[8] = 3;  // mavlink_version
  const head = Uint8Array.from([payload.length, 0, 0, 0, system, 1, 0, 0, 0]);
  let crc = 0xffff;
  const acc = (b: number) => {
    let t = (b ^ (crc & 0xff)) & 0xff;
    t = (t ^ (t << 4)) & 0xff;
    crc = ((crc >> 8) ^ (t << 8) ^ (t << 3) ^ (t >> 4)) & 0xffff;
  };
  for (const b of head) acc(b);
  for (const b of payload) acc(b);
  acc(50); // CRC_EXTRA for HEARTBEAT
  return Uint8Array.from([0xfd, ...head, ...payload, crc & 0xff, crc >> 8]);
}

/**
 * A well-formed MAVLink v2 SYS_STATUS frame (message id 1) with a correct
 * CRC. `HeartbeatScanner` looks only for message id 0, so this is what the
 * *ordinary* traffic on a right-baud port looks like: genuinely valid
 * MAVLink that is not a heartbeat, which the scanner must pass over quietly
 * — not count as noise, not stall on — while the sweep keeps reading toward
 * the frame it is actually waiting for.
 */
export function validSysStatusBytes(): Uint8Array {
  const SYS_STATUS = 1;
  const SYS_STATUS_CRC_EXTRA = 124;
  const system = 1;
  const component = 1;

  // Field order groups same-size fields together, largest first — the wire
  // order MAVLink's own generators use, not XML declaration order. A v2
  // sender trims trailing zero bytes, which is why this is 31 bytes rather
  // than the message's full width; a scanner has to accept that shorter
  // form because it is what a real autopilot actually sends.
  const payload = new Uint8Array(31);
  const view = new DataView(payload.buffer);
  view.setUint32(0, 0x3f, true);      // onboard_control_sensors_present
  view.setUint32(4, 0x3f, true);      // onboard_control_sensors_enabled
  view.setUint32(8, 0x3f, true);      // onboard_control_sensors_health
  view.setUint16(12, 300, true);      // load (permille)
  view.setUint16(14, 12600, true);    // voltage_battery (mV)
  view.setInt16(16, 2500, true);      // current_battery (cA)
  view.setUint16(18, 0, true);        // drop_rate_comm
  view.setUint16(20, 0, true);        // errors_comm
  view.setUint16(22, 0, true);        // errors_count1
  view.setUint16(24, 0, true);        // errors_count2
  view.setUint16(26, 0, true);        // errors_count3
  view.setUint16(28, 0, true);        // errors_count4
  payload[30] = 87;                   // battery_remaining (%)

  const head = Uint8Array.from([
    payload.length, 0, 0, 0, system, component,
    SYS_STATUS & 0xff, (SYS_STATUS >> 8) & 0xff, (SYS_STATUS >> 16) & 0xff,
  ]);
  let crc = 0xffff;
  for (const b of head) crc = accumulate(b, crc);
  for (const b of payload) crc = accumulate(b, crc);
  crc = accumulate(SYS_STATUS_CRC_EXTRA, crc);
  return Uint8Array.from([0xfd, ...head, ...payload, crc & 0xff, crc >> 8]);
}

/** The shape `Clock` needs, plus a hand-crank so a test can move it itself. */
export type FakeClock = Clock & { advance(ms: number): void };

/**
 * A clock a test drives itself — never the wall clock, exactly because
 * `detect()` takes an injected `Clock` so nothing here has to wait on real
 * time. `now()` steps forward on every call, unlike the manually-advanced
 * fake clocks elsewhere in this package: `detect()`'s loop *polls* the clock
 * to learn whether its deadline has passed, and no test in this file drives
 * it by hand, so a clock that only moves when told to would leave that poll
 * spinning forever against a rate that never errors and never falls silent.
 * `setTimer`/`clearTimer` are unaffected by that stepping and behave the
 * ordinary, manually-advanced way, for whatever schedules on a cadence
 * rather than polls — R-MAV-13's "looks again in 30 seconds", in `link.ts`.
 */
export function fakeClock(stepMs = 50): FakeClock {
  let t = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextHandle = 1;
  const clock: Clock = {
    now: () => {
      const now = t;
      t += stepMs;
      return now;
    },
    setTimer: (ms, fn) => {
      const handle = nextHandle++;
      timers.set(handle, { at: t + ms, fn });
      return handle;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
  };
  return Object.assign(clock, {
    advance(ms: number) {
      t += ms;
      for (const [handle, timer] of [...timers]) {
        if (timer.at <= t) {
          timers.delete(handle);
          timer.fn();
        }
      }
    },
  });
}
