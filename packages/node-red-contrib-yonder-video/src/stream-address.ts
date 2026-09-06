// SPDX-License-Identifier: GPL-3.0-or-later
import { cameraId, registerAdapter, NO_CAMERA } from "./adapter.js";
import type { RED } from "./red.js";

/**
 * `yonder-stream-address` — the exact receive-side command, ready to copy
 * (R-VID-15), and whether it can be used right now (R-UI-24).
 *
 * **Named for what the operator is being handed, not for the file it used to
 * live in.** It was `yonder-receive-line`; spec §3 renames the surface to
 * *Stream address*, because *receive line* names the console's own internal
 * idea of the thing and *the address of the stream* names what a person
 * standing at a ground station is looking for.
 *
 * **This node never reads `secrets.yaml`.** The daemon owns that file at
 * `0600` and hands back finished text, which is the whole reason the rendering
 * lives in `yonder-core` rather than here: Node-RED runs as the console's
 * account, the credential is not readable by it, and a node that tried would
 * be a second place a secret could escape from (R-SEC-10). There is no
 * filesystem import in this package at all, and a test asserts it.
 *
 * **It judges nothing about reachability either.** `outputReach()` in
 * `yonder-core` decides whether a line can be used and says why; the daemon
 * answers `usable` and `note` per rendering and this passes them along. A
 * node that worked out for itself that a listener is unreachable would be a
 * second copy of that rule, in the one place — a `flows.json` diff — where
 * nobody could review it.
 *
 * `msg.address` names the address this console session arrived on, when the
 * page knows it. The daemon honours it only if the device actually answers on
 * it, so this node passes it along rather than judging it — a command printed
 * against an address nobody can reach is worse than one that says nothing.
 */
export = function register(RED: RED): void {
  registerAdapter(
    RED,
    "yonder-stream-address",
    (msg, config) => {
      const id = cameraId(msg, config);
      if (id === null) return { refuse: NO_CAMERA };
      const address = typeof msg.address === "string" && msg.address !== "" ? msg.address : null;
      return {
        method: "GET",
        path: address === null
          ? `/cameras/${id}/stream-address`
          : `/cameras/${id}/stream-address?address=${encodeURIComponent(address)}`,
        camera: id,
      };
    },
    (value) => {
      const renderings = (value as { renderings?: unknown } | undefined)?.renderings;
      if (!Array.isArray(renderings)) return "0 ways to receive";
      // **What can be used, out of what was offered** (R-UI-24). "4 ways to
      // receive" on a board reachable only over cellular is a badge saying
      // four things work when one does, which is the class of statement this
      // whole surface exists to stop the console making.
      const usable = renderings.filter((r) => (r as { usable?: unknown }).usable === true).length;
      return usable === renderings.length
        ? `${renderings.length} ways to receive`
        : `${usable} of ${renderings.length} ways to receive`;
    },
  );
};
