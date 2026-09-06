// SPDX-License-Identifier: GPL-3.0-or-later
//
// The daemon `scripts/verify-pages.sh` puts the console in front of, with a
// stand-in for the one thing this repository cannot supply yet: a serial port
// with an autopilot on the other end of it.
//
// **Why this file exists.** `MavlinkRenderer` is assembled only when a caller
// hands `startServer` a way to open a serial port, and nothing here implements
// one — `detect()` needs `TIOCGICOUNT`, which is an ioctl node cannot make
// without help, and writing that opener is a task with a bench session behind
// it. So the shipped `main()` supplies none, `buildRenderers` says so in the
// journal, and every `/mav/*` route answers 503. That is the honest state of
// every device built to date and it is also a Telemetry page with nothing on
// it — which is the failure R-UI-12 exists to prevent, and exactly why the
// gate already writes stand-ins for `nmcli`, `mmcli`, `curl` and `ping`.
//
// This is the same move for the two things telemetry talks to. It is a
// harness, never a product: nothing installs it, no role copies it, and the
// production entry point it stands in for is still started by
// `scripts/verify-console.sh`, where `main()`'s own environment wiring stays
// under test.
//
// Two halves, kept apart on purpose:
//
//   1. **The daemon under test** — `startServer`, with exactly the options
//      `main()` builds from the same environment variables, plus the serial
//      opener it cannot build.
//   2. **The stand-ins** — a serial port whose behaviour is read from a file
//      on every open, and a `mavlink-router` that follows the same file the
//      gate's `systemctl` stand-in writes. Neither decides anything; each
//      replays what a board was measured doing.
//
// Environment, beyond the ones `main()` already reads:
//
//   YONDER_PAGES_MAV_MODE     file holding `linked`, `silent` or `noise`
//   YONDER_PAGES_MAV_CONF     where the generated router configuration goes
//   YONDER_PAGES_MAV_HINT     where the remembered port and speed go
//   YONDER_PAGES_ROUTER_STATE file the systemctl stand-in writes: `active`/`inactive`
//   YONDER_PAGES_ROUTER_STATS file the journalctl stand-in prints

import { readFileSync, writeFileSync } from "node:fs";
import { createSocket } from "node:dgram";
import { startServer, consolePathsFromEnv } from "../packages/yonder-core/dist/daemon/server.js";
import { heartbeatV2 } from "../packages/yonder-core/dist/mav/testing.js";
import { LOOPBACK_PORT } from "../packages/yonder-core/dist/mav/router/config.js";

const env = (name) => {
  const value = process.env[name];
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
};

const MODE_FILE = env("YONDER_PAGES_MAV_MODE");
const ROUTER_STATE = env("YONDER_PAGES_ROUTER_STATE");
const ROUTER_STATS = env("YONDER_PAGES_ROUTER_STATS");
const ROUTER_CONF = env("YONDER_PAGES_MAV_CONF");

/** Read on every use, never captured — the same rule the gate's own stand-ins follow. */
const readMode = () => {
  try {
    return readFileSync(MODE_FILE, "utf8").trim();
  } catch {
    return "linked";
  }
};
const routerActive = () => {
  try {
    return readFileSync(ROUTER_STATE, "utf8").trim() === "active";
  } catch {
    return false;
  }
};

/**
 * The endpoints the router is actually carrying, read out of the file it was
 * started with.
 *
 * **This is what makes a stop look like a stop** (R-MAV-09). Stopping
 * telemetry does not stop `mavlink-router`; it rewrites the generated file
 * without the ground stations and restarts onto it. A stand-in that went on
 * printing counters for endpoints no longer in that file would have the
 * console reporting ground stations answering while nothing was being sent
 * to them — the page's stopped state photographed as its running one.
 */
const carrying = () => {
  try {
    return [...readFileSync(ROUTER_CONF, "utf8").matchAll(/^\[\w+Endpoint (\S+)\]$/gm)]
      .map((m) => m[1]);
  } catch {
    return [];
  }
};

/**
 * The autopilot: ArduPilot on a fixed wing, system 1 — the vehicle the
 * hardware note recorded and the one the page's mockups were drawn against.
 */
const HEARTBEAT = heartbeatV2(1, 1, 3);

/**
 * The speed the stand-in answers at.
 *
 * First in `MAVLINK_BAUDS`, so a sweep in the `linked` mode finds it on its
 * first read rather than spending a deadline per rate to get there.
 */
const ANSWERING_BAUD = 57_600;

/** Bytes that are not MAVLink, with the framing errors a wrong rate throws. */
const GARBAGE = Uint8Array.from(Array.from({ length: 64 }, (_, i) => (i * 37 + 11) & 0xff));

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * A serial port with whatever the mode file says on the other end of it.
 *
 * `read` waits its slice rather than answering instantly: `detect()` polls
 * until a deadline, so a port that returns nothing in no time turns a 1.3 s
 * wait into a hot loop.
 */
const open = async (device, baud) => {
  const mode = readMode();
  return {
    async settleAndFlush() {},
    async read(ms) {
      await sleep(ms);
      if (mode === "noise") return { bytes: GARBAGE, framingErrors: 3 };
      if (mode === "linked" && device === "/dev/ttyAMA0" && baud === ANSWERING_BAUD) {
        return { bytes: HEARTBEAT, framingErrors: 0 };
      }
      return { bytes: new Uint8Array(0), framingErrors: 0 };
    },
    async close() {},
  };
};

/**
 * `mavlink-router`, as far as anything on this device can tell.
 *
 * While the unit is active it does the two things the console measures it by:
 * it forwards the autopilot's heartbeat to the loopback copy the daemon
 * listens on (R-MAV-05, R-MAV-07), and it prints a statistics block per
 * endpoint (`ReportStats = true`) for the journal to keep.
 *
 * The numbers are the ones a board actually produced — see
 * `mav/router/stats.test.ts`, whose fixture is verbatim from mavlink-router
 * 2362c62 on a Pi 4. `gcs0` answers, so its `Handled` count climbs; `gcs1`
 * is configured and silent, so its count was seen once and never moves
 * again. That is the pair §6 was reversed by, and it is what puts one
 * answering and one silent mark on the page.
 */
const feed = createSocket("udp4");
let ticks = 0;

const statsBlock = (kind, index, name, received, receivedKb, transmitted, transmittedKb) =>
  `${kind} Endpoint [${index}]${name} {\n`
  + "\tReceived messages {\n"
  + "\t\tCRC error: 0 0% 0KB\n"
  + "\t\tSequence lost: 0 0%\n"
  + `\t\tHandled: ${received} ${receivedKb}KB\n`
  + `\t\tTotal: ${received}\n`
  + "\t}\n"
  + "\tTransmitted messages {\n"
  + `\t\tTotal: ${transmitted} ${transmittedKb}KB\n`
  + "\t}\n"
  + "}\n";

const router = setInterval(() => {
  if (!routerActive() || readMode() !== "linked") return;
  ticks += 1;
  feed.send(Buffer.from(HEARTBEAT), LOOPBACK_PORT, "127.0.0.1", () => {});
  const sent = 954 + ticks * 40;
  // `gcs0` keeps answering, so its `Handled` count keeps climbing and the
  // tracker keeps moving its last-answered mark forward. `gcs1` answers for
  // the first few seconds and then stops: a station that was heard from and
  // has gone quiet is a different reading from one that never replied, and
  // the page draws all three — answering, silent, not set — only if the
  // counters actually behave that way.
  const quietAfter = Math.min(ticks, 3);
  const on = carrying();
  const blocks = [statsBlock("UART", 6, "autopilot", 955 + ticks * 40, 34 + ticks, 0, 0)];
  if (on.includes("gcs0")) {
    blocks.unshift(statsBlock("UDP", 7, "gcs0", 21 + ticks * 4, 1 + Math.floor(ticks / 3), sent, 34 + ticks));
  }
  if (on.includes("gcs1")) {
    blocks.unshift(statsBlock("UDP", 8, "gcs1", 2 + quietAfter * 2, 1, sent, 34 + ticks));
  }
  writeFileSync(ROUTER_STATS, blocks.join(""));
}, 1_000);
router.unref?.();

await startServer({
  socketPath: env("YONDER_SOCKET"),
  configPath: env("YONDER_CONFIG"),
  journalPath: env("YONDER_JOURNAL"),
  secretsPath: env("YONDER_SECRETS"),
  renderers: [],
  console: consolePathsFromEnv(),
  mavlink: {
    open,
    confPath: env("YONDER_PAGES_MAV_CONF"),
    hintPath: env("YONDER_PAGES_MAV_HINT"),
  },
});
process.stdout.write("yonder-core listening (pages harness, with a serial stand-in)\n");
