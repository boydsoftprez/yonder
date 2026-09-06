// SPDX-License-Identifier: GPL-3.0-or-later
import type { Config } from "../../schema/config.js";

/**
 * `mavlink-router`'s configuration (`/etc/mavlink-router/main.conf`),
 * generated from `config.yaml` and rewritten from scratch on every apply
 * (§4 of the telemetry-plumbing design). Editing the file on the device
 * survives until the next apply and then disappears; that single-writer
 * rule is what makes rollback possible and it is not relaxed for this
 * service.
 *
 * **This function is pure.** Text in, text out. It writes no file, starts no
 * process and reads nothing but its two arguments — the write, the diff
 * against whatever is already on disk, and the decision whether to restart
 * the service all belong to the renderer that calls it, not here.
 *
 * `link` is what a *successful* detection settled on — the `found` variant
 * of `DetectOutcome` (`../detect.ts`), stripped to the two fields this file
 * needs. There is deliberately no branch for "nothing was found": that
 * outcome carries no device or baud, so there is nothing for this function
 * to render, and by §4's boot order the renderer resolves detection before
 * it calls this at all — on `silent` or `noise` the router is never started
 * and this function is never reached. Calling it without a genuine found
 * link is a caller error, not a case for this function to degrade into.
 */

/**
 * Where the control plane's own copy of the traffic listens.
 *
 * Not a setting, and not touched by anything in `mavlink` below: R-MAV-05
 * requires this feed to exist and R-MAV-06 requires it to be a *copy* raw
 * MAVLink reaches ground stations without passing through, so a Node-RED
 * restart is invisible to Mission Planner. Neither promise survives an
 * operator being able to move or close this address, so it is not exposed
 * as one. Exported because Task 11's loopback listener binds this same
 * number rather than a second copy of it.
 */
export const LOOPBACK_PORT = 14559;

/**
 * Where an off-device sender lands once `ingest.loopback_only` is turned
 * off. This is the UDP counterpart to the TCP server below: a socket bound
 * to every interface rather than a single configured peer, which is what
 * makes it, and not the three named ground-station endpoints, the path
 * R-MAV-07 is guarding. Not yet exercised on hardware — Task 2's bench ran
 * with a client on loopback only — so this is a considered choice, not a
 * measured one; a future bench session naming a different port supersedes
 * it here, in this one place.
 */
const INGEST_PORT = 14540;

/** The UART endpoint's name — the flight controller's own link. */
const AUTOPILOT_ENDPOINT_NAME = "autopilot";
/** The unconditional loopback endpoint's name — see `LOOPBACK_PORT` above. */
const LOOPBACK_ENDPOINT_NAME = "yonder";
/** The ingest endpoint's name — see `INGEST_PORT` above. */
const INGEST_ENDPOINT_NAME = "inbound";

/**
 * The three names this file hardcodes for its own sections, gathered in one
 * place so `schema/config.ts` can import them rather than repeat them
 * (R-MAV-15). A ground station sharing one of these produces two
 * identically-headed sections in the generated file, and the router keeps
 * one and silently drops the other — for `yonder` and `inbound` that is a
 * byte-for-byte collision, since a configured ground station is always a
 * `UdpEndpoint` too (R-MAV-03); `autopilot` heads a `UartEndpoint` section
 * instead, so whether it collides depends on how mavlink-router's own parser
 * treats two differently-typed sections sharing a name, which nothing in
 * this repository has measured. Reserved regardless, rather than only where
 * the collision is proven: the risk of confusing an operator with an
 * endpoint named after their own flight controller costs nothing to avoid.
 */
export const RESERVED_ENDPOINT_NAMES = [
  AUTOPILOT_ENDPOINT_NAME,
  LOOPBACK_ENDPOINT_NAME,
  INGEST_ENDPOINT_NAME,
] as const;

export function routerConfig(mavlink: Config["mavlink"], link: { device: string; baud: number }): string {
  // R-MAV-07 gates two independent listening sockets the same way: the TCP
  // server below (its own switch too — see tcpPort) and this UDP one, which
  // has no switch of its own in the schema, so loopback_only is the whole of
  // it. Both bind every interface once opened, and MAVLink is bidirectional,
  // so both are an unauthenticated command path to the vehicle the moment
  // they are on — never the default, and on only when this is false.
  const ingestOpen = !mavlink.ingest.loopback_only;

  // R-MAV-04. "Off" is written as `TcpServerPort = 0`, never omitted:
  // mavlink-router starts its TCP server on its own default the moment the
  // key is silent, so leaving it out ships the very listener an operator
  // turned off. The TCP server keeps its own enabled switch in addition to
  // the ingest gate — turning ingest on does not turn a deliberately
  // disabled TCP server back on.
  const tcpPort = mavlink.tcp_server.enabled && ingestOpen ? mavlink.tcp_server.port : 0;

  const sections: string[] = [];

  sections.push(["[General]", "ReportStats = true", `TcpServerPort = ${tcpPort}`].join("\n"));

  sections.push(
    [`[UartEndpoint ${AUTOPILOT_ENDPOINT_NAME}]`, `Device = ${link.device}`, `Baud = ${link.baud}`].join("\n"),
  );

  // Not optional, not configurable — see the module docstring. Emitted
  // before the ground stations so the control plane's own feed is never the
  // block a truncated file (or a truncated read of one) would lose.
  sections.push(
    [`[UdpEndpoint ${LOOPBACK_ENDPOINT_NAME}]`, "Mode = Normal", "Address = 127.0.0.1", `Port = ${LOOPBACK_PORT}`]
      .join("\n"),
  );

  // R-MAV-03: up to three, each named for it. The name is what makes
  // per-endpoint attribution in the router's own statistics possible
  // (router/stats.ts) — load-bearing, not cosmetic.
  //
  // R-CFG-13: this loop is the *entire* ground-station output, built fresh
  // from `mavlink.endpoints` on every call. An endpoint the configuration no
  // longer names has no iteration that could emit it, which is what makes
  // "generated from scratch" satisfy "matches what the configuration no
  // longer says" by construction rather than by a diff this function would
  // have to compute against a previous file it never sees.
  for (const endpoint of mavlink.endpoints) {
    sections.push(
      [`[UdpEndpoint ${endpoint.name}]`, "Mode = Normal", `Address = ${endpoint.host}`, `Port = ${endpoint.port}`]
        .join("\n"),
    );
  }

  // R-MAV-07. See INGEST_PORT above. Gated on nothing but the same switch
  // the TCP server answers to — the schema gives this path no on/off of its
  // own, so closed-by-default and opened-only-here is the whole enforcement,
  // and it is asserted in config.test.ts rather than merely assumed.
  if (ingestOpen) {
    sections.push(
      [`[UdpEndpoint ${INGEST_ENDPOINT_NAME}]`, "Mode = Server", "Address = 0.0.0.0", `Port = ${INGEST_PORT}`]
        .join("\n"),
    );
  }

  return `${sections.join("\n\n")}\n`;
}
