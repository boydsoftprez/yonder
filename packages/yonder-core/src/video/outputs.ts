// SPDX-License-Identifier: GPL-3.0-or-later
import type { CameraOutput } from "../schema/config.js";

/**
 * Whether a peer can actually reach one configured output, and by which of
 * the device's paths (R-VID-16, R-UI-24).
 *
 * **States, and never acts (R-CMD-04).** `outputReach` does not disable an
 * output, does not warn that it will be, and does not recommend a path — it
 * answers one question, *can something reach this output right now*, and
 * leaves what to do with that answer entirely to the operator reading the
 * console. It is not wired to `CameraOutput.enabled` in `schema/config.ts`:
 * that is a separate, operator-made choice, and an output can be enabled and
 * unreachable at once — that is exactly the sentence this function exists to
 * make sayable.
 *
 * **The split is `rtp` against `rtsp` and `srt`, because that is the whole
 * substance of the question.** An RTP output is this device dialling *out*
 * to a ground station's address — an outbound push, the same direction as
 * every other connection a board behind carrier-grade NAT already makes —
 * so whichever path is up carries it, cellular included. `rtsp` and `srt`
 * are listeners: this device opens a socket and waits, and a listener needs
 * a peer to dial *in*. Nothing dials in to a device behind carrier-grade
 * NAT, which is the carrier's NAT doing exactly what it is for, so on
 * cellular alone a listener is unreachable — not broken, not misconfigured,
 * just unreachable by that one path — and it is reachable exactly where a
 * peer can address this device directly: the ZeroTier mesh, or a LAN.
 */
export interface ReachPaths {
  /** A local network this device shares with a peer — Ethernet or Wi-Fi client. */
  readonly lan: boolean;
  /** The ZeroTier mesh (M2a), joined and up. */
  readonly mesh: boolean;
  /** The cellular modem, registered and carrying traffic. */
  readonly cellular: boolean;
}

/** Which way traffic has to move to make one output work at all. */
export type OutputDirection = "outbound" | "listener";

/**
 * What is true about one output — the three fields the console draws, and
 * nothing else. A suggested action, a severity or a colour is the console
 * deciding something, and belongs to whoever draws this, not to this
 * function (Coordinator's resolution 6).
 */
export interface OutputReach {
  readonly direction: OutputDirection;
  readonly reachable: boolean;
  /** One sentence, for an operator. States a fact; recommends nothing. */
  readonly note: string;
}

/** The three kinds an output comes in — `schema/config.ts`'s own union. */
export type OutputKind = CameraOutput["kind"];

export function outputReach(kind: OutputKind, paths: ReachPaths): OutputReach {
  switch (kind) {
    case "rtp": {
      // Outbound: whichever path is up carries it. A push started on a
      // device with no path up at all reaches nothing, same as any output.
      const reachable = paths.lan || paths.mesh || paths.cellular;
      return {
        direction: "outbound",
        reachable,
        note: reachable
          ? "an outbound push to the configured ground station; it leaves over whichever path is active, cellular included"
          : "an outbound push, and no path is active for it to leave over",
      };
    }
    case "rtsp":
    case "srt": {
      // Listener: a peer has to dial in, and nothing can dial in to this
      // device from behind the cellular carrier's NAT. Only the mesh or a
      // local network give a peer an address that reaches it.
      const proto = kind === "rtsp" ? "RTSP" : "SRT";
      const reachable = paths.lan || paths.mesh;
      return {
        direction: "listener",
        reachable,
        note: reachable
          ? `a listener; a peer on the mesh or a LAN has an address that reaches this ${proto} output`
          : `nothing can dial in to this ${proto} listener over cellular; it is reachable on the mesh or a LAN`,
      };
    }
  }
}
