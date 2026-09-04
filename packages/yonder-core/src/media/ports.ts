// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Where mediamtx listens. Four integers, and nothing else in this file.
 *
 * **No imports, and that is the whole point of it.** These constants are read
 * from two directions that must not meet: `media/config.ts`, which generates
 * the server's configuration and pulls in a YAML writer to do it, and
 * `console/whep.ts`, which is reached from `wiring.ts` — the module a
 * generated `settings.js` requires at Node-RED start-up. Written into
 * `config.ts`, three integers would have dragged seventy-odd `yaml` module
 * files into that start-up path to no purpose. `wiring.ts` states what that
 * graph carries; this file is what keeps the statement true.
 *
 * Restating the numbers on the console's side instead would have been the
 * other way to keep it, and a worse one: a proxy dialling a port the server
 * has since moved off answers nothing, and a blank picture is the symptom.
 */

export const RTSP_PORT = 8554;
export const WEBRTC_PORT = 8889;
export const SRT_PORT = 8890;

/**
 * Where WebRTC's *media* arrives, which is not where its handshake does.
 *
 * The handshake is loopback because the console proxies it; the media is UDP
 * straight to the browser, so this port is on every interface and is protected
 * by the ICE credentials that handshake carried rather than by an address.
 *
 * **A separate constant rather than `WEBRTC_PORT + 1`, and a board proved why.**
 * That arithmetic lands on 8890, which is SRT's, and both are UDP. mediamtx
 * does not degrade when two of its servers want one port — it exits:
 *
 *     INF [WebRTC] started with listeners on 127.0.0.1:8889 (TCP/HTTP), :8890 (UDP/ICE)
 *     ERR listen: listen udp :8890: bind: address already in use
 *     INF [WebRTC] closing
 *
 * so the first apply that added an `srt` output would have taken every camera
 * off the air, including the browser's. 8189 is mediamtx's own default for
 * this and collides with nothing here.
 *
 * This note travels with the constants rather than with the file that spends
 * them: it is the reason there are four of these and not an expression.
 */
export const WEBRTC_LOCAL_UDP_PORT = 8189;
