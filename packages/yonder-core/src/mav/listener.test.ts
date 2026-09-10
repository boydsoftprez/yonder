// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { createSocket } from "node:dgram";
import type { Clock } from "../apply/types.js";
import { LinkTracker } from "./link.js";
import { LOOPBACK_ADDRESS, LoopbackListener } from "./listener.js";
import { LOOPBACK_PORT } from "./router/config.js";
import { heartbeatV2, validSysStatusBytes } from "./testing.js";

/**
 * The control plane's own copy of the traffic, off `127.0.0.1:14559`
 * (R-MAV-05).
 *
 * Two properties carry this file. **The socket binds loopback and nothing
 * else** — R-MAV-07 exists because MAVLink is bidirectional and an open
 * MAVLink port on a routable address is an unauthenticated command path to
 * the aircraft — and **a datagram is a message, not a slice of a stream**, so
 * two of them are never joined end to end to make a frame neither of them
 * carried.
 */

/** Never the wall clock. Advanced by hand, like `link.test.ts`'s own. */
function fakeClock(): Clock & { advance(ms: number): void } {
  let now = 1_000_000;
  return {
    now: () => now,
    setTimer: () => 0,
    clearTimer: () => {},
    advance(ms) { now += ms; },
  };
}

/**
 * Wait for a datagram to have been delivered, **without consulting the wall
 * clock**.
 *
 * `setImmediate` yields one turn of the event loop, and the poll phase — the
 * turn a loopback datagram arrives on — is part of that turn. So this spends
 * turns rather than milliseconds: it cannot be made to pass or fail by how
 * fast the machine running it is, and it gives up by exhausting a generous
 * count rather than by a timeout a loaded runner could trip.
 */
async function arrives(condition: () => boolean): Promise<void> {
  for (let turn = 0; turn < 500 && !condition(); turn += 1) {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
  expect(condition()).toBe(true);
}

/** One datagram, from a socket of the test's own, to a port on loopback. */
async function sendTo(port: number, bytes: Uint8Array): Promise<void> {
  const from = createSocket({ type: "udp4" });
  await new Promise<void>((resolve, reject) => {
    from.send(Buffer.from(bytes), port, LOOPBACK_ADDRESS, (error) => {
      if (error === null) resolve(); else reject(error);
    });
  });
  from.close();
}

/** A vehicle's heartbeat: ArduPilot on a fixed wing, system 1. */
const VEHICLE = heartbeatV2(1, 1, 3);
/** A ground station's: MAV_TYPE_GCS with MAV_AUTOPILOT_INVALID. */
const STATION = heartbeatV2(255, 6, 8);

describe("LoopbackListener", () => {
  it("asks for the port the generated router configuration sends to, not a second copy of the number", () => {
    // R-MAV-05. `routerConfig` writes `[UdpEndpoint yonder]` at LOOPBACK_PORT
    // and this binds it; two literals that must agree are how they stop
    // agreeing.
    expect(new LoopbackListener({ tracker: new LinkTracker() }).port).toBe(LOOPBACK_PORT);
  });

  /**
   * R-MAV-07, and the reason this listener takes no address option at all.
   *
   * MAVLink is bidirectional and carries no credential, so a MAVLink socket
   * on a routable address is a way for anything that can reach this device to
   * command the aircraft. The bind is the whole of the enforcement, so it is
   * asserted rather than assumed — and asserted on the address the socket
   * actually reports, not on the argument that was passed to it.
   */
  it("binds the loopback address and no other (R-MAV-07)", async () => {
    const listener = new LoopbackListener({ tracker: new LinkTracker(), port: 0 });
    await listener.start();
    try {
      expect(listener.bound?.address).toBe("127.0.0.1");
      expect(listener.bound?.port).toBeGreaterThan(0);
    } finally {
      listener.close();
    }
  });

  it("carries a real datagram off loopback into the tracker", async () => {
    const clock = fakeClock();
    const tracker = new LinkTracker({ clock });
    const listener = new LoopbackListener({ tracker, port: 0 });
    await listener.start();
    try {
      await sendTo(listener.bound?.port ?? 0, VEHICLE);
      await arrives(() => tracker.state().lastHeardMs !== null);
    } finally {
      listener.close();
    }
  });

  it("reports nothing bound before it is started, and nothing once it is closed", async () => {
    const listener = new LoopbackListener({ tracker: new LinkTracker(), port: 0 });
    expect(listener.bound).toBeNull();
    await listener.start();
    expect(listener.bound).not.toBeNull();
    listener.close();
    expect(listener.bound).toBeNull();
  });

  it("is safe to close before it was ever started, and to close twice", async () => {
    const idle = new LoopbackListener({ tracker: new LinkTracker(), port: 0 });
    expect(() => { idle.close(); }).not.toThrow();

    const started = new LoopbackListener({ tracker: new LinkTracker(), port: 0 });
    await started.start();
    started.close();
    expect(() => { started.close(); }).not.toThrow();
  });

  /**
   * K-19's rule, one step outside the renderer chain: **nothing added to the
   * daemon's start-up path may be able to take the daemon down.**
   *
   * A port already in use is the ordinary way this fails — a second
   * `yonder-core`, or anything else that got there first — and the cost of it
   * is a Telemetry page reporting no heartbeat, never a device with no
   * console and no access point on it.
   */
  it("survives a port that is already taken, and says so (K-19)", async () => {
    const first = new LoopbackListener({ tracker: new LinkTracker(), port: 0 });
    await first.start();
    const taken = first.bound?.port ?? 0;

    const said: string[] = [];
    const second = new LoopbackListener({
      tracker: new LinkTracker(), port: taken, log: (line) => { said.push(line); },
    });
    try {
      await expect(second.start()).resolves.toBeUndefined();
      expect(second.bound).toBeNull();
      expect(said.join("\n")).toMatch(/loopback feed/i);
      expect(said.join("\n")).toMatch(String(taken));
    } finally {
      second.close();
      first.close();
    }
  });

  it("hands a vehicle's heartbeat to the tracker", () => {
    const clock = fakeClock();
    const tracker = new LinkTracker({ clock });
    new LoopbackListener({ tracker }).receive(VEHICLE);
    expect(tracker.state().lastHeardMs).toBe(0);
  });

  /**
   * §6. The loopback copy is *merged* traffic, so a ground station's own
   * heartbeat arrives on it too. Counting one as the aircraft's would put an
   * arrival that says nothing about the autopilot into the autopilot's rate —
   * `LinkTracker.heard` is what refuses it, and this asserts the refusal
   * survives the trip through this listener rather than only in isolation.
   */
  it("does not let a ground station's heartbeat pass as the aircraft's", () => {
    const tracker = new LinkTracker({ clock: fakeClock() });
    new LoopbackListener({ tracker }).receive(STATION);
    expect(tracker.state().lastHeardMs).toBeNull();
  });

  it("finds the heartbeat in a datagram that also carries ordinary MAVLink", () => {
    const tracker = new LinkTracker({ clock: fakeClock() });
    const other = validSysStatusBytes();
    const both = Uint8Array.from([...other, ...VEHICLE]);
    new LoopbackListener({ tracker }).receive(both);
    expect(tracker.state().lastHeardMs).toBe(0);
  });

  it("leaves the tracker untouched by a datagram that is not MAVLink at all", () => {
    const tracker = new LinkTracker({ clock: fakeClock() });
    new LoopbackListener({ tracker }).receive(Uint8Array.from([0, 1, 2, 3, 0xfd, 0xff, 0xff, 7]));
    expect(tracker.state().lastHeardMs).toBeNull();
  });

  /**
   * **A datagram is a message, not a slice of a stream.**
   *
   * `HeartbeatScanner` buffers what it could not yet parse, which is exactly
   * right for a serial port and exactly wrong here: two datagrams' bytes were
   * never adjacent on the wire, so joining them can only manufacture a frame
   * neither of them carried — and a trailing byte that looks like the start
   * of one is otherwise kept for ever, which on a flight is an unbounded
   * buffer. So each datagram gets a scanner of its own, and this is the
   * assertion that says so: the very same bytes, split in two, must not be
   * heard.
   */
  it("never joins two datagrams together to make a frame neither of them carried", () => {
    const whole = VEHICLE;
    const split = Math.floor(whole.length / 2);

    const joined = new LinkTracker({ clock: fakeClock() });
    const halves = new LoopbackListener({ tracker: joined });
    halves.receive(whole.subarray(0, split));
    halves.receive(whole.subarray(split));
    expect(joined.state().lastHeardMs).toBeNull();

    // The control: the same bytes in one datagram are a heartbeat, so the
    // assertion above is about the boundary rather than about the fixture.
    const entire = new LinkTracker({ clock: fakeClock() });
    new LoopbackListener({ tracker: entire }).receive(whole);
    expect(entire.state().lastHeardMs).toBe(0);
  });

  /**
   * The tracker is the shared one (`MavlinkRendererOptions.tracker`), so a
   * heartbeat arriving here has to reach the same `state()` the sweep's own
   * outcome does — that is the whole reason `GET /mav/state` is one answer
   * rather than two halves stitched together.
   */
  it("feeds the same tracker a detection outcome went into", () => {
    const clock = fakeClock();
    const tracker = new LinkTracker({ clock });
    tracker.observed({ kind: "found", device: "/dev/ttyAMA0", baud: 57600, vehicle: "ArduPlane", system: 1 });
    const listener = new LoopbackListener({ tracker });
    listener.receive(VEHICLE);
    clock.advance(1_000);
    listener.receive(VEHICLE);
    expect(tracker.state()).toMatchObject({ phase: "linked", device: "/dev/ttyAMA0", heartbeatHz: 1 });
  });

  it("starts only once, however many times it is asked", async () => {
    const listener = new LoopbackListener({ tracker: new LinkTracker(), port: 0 });
    await listener.start();
    const first = listener.bound;
    await listener.start();
    try {
      expect(listener.bound).toEqual(first);
    } finally {
      listener.close();
    }
  });
});

it("uses the existing loopback feed for explicit replies without sending on receipt", async () => {
  const frames: Uint8Array[] = [];
  const listener = new LoopbackListener({tracker:new LinkTracker(),port:0,onDatagram: bytes => frames.push(bytes)});
  const peer = createSocket("udp4");
  const replies: Buffer[] = [];
  peer.on("message", data => replies.push(data));
  try {
    await expect(listener.send(VEHICLE)).rejects.toThrow(/peer/i);
    await listener.start();
    await new Promise<void>(resolve => peer.bind(0, LOOPBACK_ADDRESS, resolve));
    await new Promise<void>((resolve,reject) => peer.send(VEHICLE,listener.bound!.port,LOOPBACK_ADDRESS,error => error ? reject(error) : resolve()));
    await arrives(() => frames.length === 1);
    expect(replies).toHaveLength(0);
    expect(Buffer.from(frames[0]!)).toEqual(Buffer.from(VEHICLE));
    await listener.send(STATION);
    await arrives(() => replies.length === 1);
    expect(replies[0]).toEqual(Buffer.from(STATION));
    listener.close();
    await expect(listener.send(STATION)).rejects.toThrow(/peer/i);
  } finally {listener.close();peer.close();}
});

it('pins the validated router peer and ignores other local senders until stale',async()=>{
 let now=100000;
 const frames:Uint8Array[]=[],listener=new LoopbackListener({tracker:new LinkTracker(),port:0,now:()=>now,onDatagram:b=>frames.push(b)});
 const router=createSocket('udp4'),noise=createSocket('udp4');
 const delivered:Buffer[]=[],misdirected:Buffer[]=[];
 router.on('message',d=>delivered.push(d));noise.on('message',d=>misdirected.push(d));
 const send=async(socket:ReturnType<typeof createSocket>,bytes:Uint8Array)=>new Promise<void>((resolve,reject)=>socket.send(bytes,listener.bound!.port,LOOPBACK_ADDRESS,e=>e?reject(e):resolve()));
 try {
  await listener.start();await send(router,VEHICLE);await arrives(()=>frames.length===1);
  await send(noise,Buffer.from('unrelated local packet'));await send(noise,VEHICLE);
  await new Promise<void>(r=>setImmediate(r));await listener.send(STATION);await arrives(()=>delivered.length===1);
  expect(misdirected).toHaveLength(0);expect(frames).toHaveLength(1);
  now+=11000;await expect(listener.send(STATION)).rejects.toThrow(/peer/i);
  await send(noise,VEHICLE);await arrives(()=>frames.length===2);
  await listener.send(STATION);await arrives(()=>misdirected.length===1);
 }finally{listener.close();router.close();noise.close();}
});
