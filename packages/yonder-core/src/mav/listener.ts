// SPDX-License-Identifier: GPL-3.0-or-later
import { createSocket, type Socket } from "node:dgram";
import { HeartbeatScanner } from "./frame.js";
import type { LinkTracker } from "./link.js";
import { LOOPBACK_PORT } from "./router/config.js";

/**
 * The control plane's own copy of the traffic (R-MAV-05).
 *
 * `mavlink-router` owns the serial port and fans MAVLink out to the ground
 * stations directly; one merged copy of everything it handles is also sent to
 * `127.0.0.1:14559`, and this is the socket at the other end of it. Reading
 * that copy is how `LinkState.heartbeatHz`, `.lastHeardMs` and — through
 * `describeVehicle` — the vehicle's own identity become measurements rather
 * than settings.
 *
 * **This is a consumer and nothing else.** The socket is never sent on. Yonder
 * relays commands and never originates them (`R-CMD-04`, `R-CMD-05`), and a
 * class whose only job is to read a feed has no business holding a way to
 * write to the vehicle.
 *
 * **It is not in the ground stations' path.** R-MAV-06: raw MAVLink reaches
 * Mission Planner without passing through `yonder-core`, so this listener
 * failing, restarting or never binding at all costs a Telemetry page its
 * heartbeat and costs telemetry itself nothing.
 */

/**
 * The only address this listener will ever bind.
 *
 * **Not an option, deliberately.** R-MAV-07 exists because MAVLink is
 * bidirectional and carries no credential: a MAVLink socket on a routable
 * address is a way for anything that can reach this device to arm the
 * aircraft, change its flight mode and write its parameters. The generated
 * router configuration already gates its own listening sockets behind
 * `ingest.loopback_only` (`router/config.ts`); this one has no gate because it
 * has no reason to be anywhere else, and the way to keep it that way is to
 * give a caller no argument to pass.
 *
 * Exported so a test can state the address it expects rather than repeat the
 * literal.
 */
export const LOOPBACK_ADDRESS = "127.0.0.1";

export interface LoopbackListenerOptions {
  /**
   * The one `LinkTracker` for this device — the same instance
   * `MavlinkRenderer` was given.
   *
   * This class writes `heard()`; the renderer writes `observed()` and
   * `sampled()`; `state()` reads. Two writers, one state, and neither has to
   * know the other exists — which is what makes `GET /mav/state` one answer
   * rather than two halves stitched together at the route.
   */
  tracker: LinkTracker;
  /**
   * Overrides `LOOPBACK_PORT`. **Test-only**, the same way the renderer's
   * `retryMs` and `statsIntervalMs` are: a test binds an ephemeral port (`0`)
   * rather than the real one, so the suite neither collides with a running
   * daemon nor depends on a fixed port being free on whatever machine it runs
   * on. There is no matching override for the address — see LOOPBACK_ADDRESS.
   */
  port?: number;
  log?: (line: string) => void;
}

export class LoopbackListener {
  private readonly tracker: LinkTracker;
  private readonly log: (line: string) => void;
  private socket: Socket | undefined;
  private boundTo: { address: string; port: number } | null = null;

  /** The port this listener asks for. `LOOPBACK_PORT` unless a test says otherwise. */
  readonly port: number;

  constructor(opts: LoopbackListenerOptions) {
    this.tracker = opts.tracker;
    this.port = opts.port ?? LOOPBACK_PORT;
    this.log = opts.log ?? (() => {});
  }

  /**
   * Where the socket actually landed, or `null` when there is no socket.
   *
   * The address is read back off the socket rather than repeated from the
   * constant, so a test asserting R-MAV-07 is asserting what was bound and
   * not what was asked for.
   */
  get bound(): { address: string; port: number } | null {
    return this.boundTo;
  }

  /**
   * Open the socket. Idempotent, and **it never rejects.**
   *
   * K-19's rule, applied one step outside the renderer chain: nothing added to
   * this daemon's start-up path may be able to take the daemon down. The
   * ordinary way this fails is a port already in use — a second `yonder-core`,
   * or anything else that got there first — and the cost of that is a page
   * that reports no heartbeat, never a device with no console and no access
   * point on it (rule 6). So a bind failure is said once, in the operator's
   * log, and the daemon carries on.
   */
  async start(): Promise<void> {
    if (this.socket !== undefined) return;
    const socket = createSocket({ type: "udp4" });
    this.socket = socket;

    await new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };

      // Registered before the bind, and never omitted: an unhandled 'error'
      // on a dgram socket is thrown, which under Node's default takes the
      // process with it.
      socket.on("error", (error: Error) => {
        this.boundTo = null;
        this.socket = undefined;
        // A socket whose bind failed was never running, and close() on one
        // throws ERR_SOCKET_DGRAM_NOT_RUNNING. Nothing here may throw.
        try {
          socket.close();
        } catch {
          // Already gone.
        }
        this.log(
          `mavlink: the loopback feed could not be listened for on ${LOOPBACK_ADDRESS}:${this.port} `
            + `(${error.message}); the Telemetry page will report no heartbeat, `
            + "and telemetry to the ground stations is unaffected (R-MAV-05, R-MAV-06)",
        );
        done();
      });

      socket.on("message", (datagram) => { this.receive(datagram); });

      socket.on("listening", () => {
        const where = socket.address();
        this.boundTo = { address: where.address, port: where.port };
        done();
      });

      socket.bind({ address: LOOPBACK_ADDRESS, port: this.port });
    });
  }

  /**
   * One datagram off the feed.
   *
   * **A scanner of its own, per datagram.** `HeartbeatScanner` keeps what it
   * could not yet parse so that the next chunk completes it, which is exactly
   * right for a serial port and exactly wrong here: UDP preserves message
   * boundaries and `mavlink-router` writes whole MAVLink frames (the format's
   * maximum is 280 bytes, so one never needs two datagrams), which means two
   * datagrams' bytes were never adjacent on the wire, so carrying a buffer
   * across them can manufacture a frame neither of them contained — a
   * heartbeat spanning a boundary that never existed. That is the whole of the
   * reason, and it is sufficient on its own.
   *
   * It is **not** an unbounded-memory argument, though it looks like one: the
   * scanner resyncs forward one byte on any checksum mismatch, and only waits
   * for more bytes while a candidate frame is within MAVLink's own 280-byte
   * maximum, so the retained tail is bounded by that maximum however much junk
   * arrives. What a carried buffer holds is bounded and pointless; what it can
   * produce is a frame nobody sent.
   *
   * Public because that decision deserves a test that does not need a socket
   * to make it; the socket handler above is its only production caller.
   */
  receive(datagram: Uint8Array): void {
    for (const heartbeat of new HeartbeatScanner().push(datagram)) {
      // `heard` keeps only the vehicle's own beats: the loopback copy is
      // merged traffic, so a ground station's heartbeat arrives here too and
      // would otherwise corrupt the autopilot's rate with an arrival that
      // says nothing about it (§6, and frame.ts's `fromVehicle`).
      this.tracker.heard(heartbeat);
    }
  }

  /** Close the socket. Safe before `start()`, and safe twice. */
  close(): void {
    const socket = this.socket;
    this.socket = undefined;
    this.boundTo = null;
    if (socket === undefined) return;
    try {
      socket.close();
    } catch {
      // Never opened, or already closed. Either way there is nothing to shut.
    }
  }
}
