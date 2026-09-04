// SPDX-License-Identifier: GPL-3.0-or-later
import { cameraId, registerAdapter, NO_CAMERA } from "./adapter.js";
import type { RED } from "./red.js";

/**
 * `yonder-receive-line` — the exact receive-side command, ready to copy
 * (R-VID-15).
 *
 * **This node never reads `secrets.yaml`.** The daemon owns that file at
 * `0600` and hands back finished text, which is the whole reason the rendering
 * lives in `yonder-core` rather than here: Node-RED runs as the console's
 * account, the credential is not readable by it, and a node that tried would
 * be a second place a secret could escape from (R-SEC-10). There is no
 * filesystem import in this package at all, and a test asserts it.
 *
 * `msg.address` names the address this console session arrived on, when the
 * page knows it. The daemon honours it only if the device actually answers on
 * it, so this node passes it along rather than judging it — a command printed
 * against an address nobody can reach is worse than one that says nothing.
 */
export = function register(RED: RED): void {
  registerAdapter(
    RED,
    "yonder-receive-line",
    (msg, config) => {
      const id = cameraId(msg, config);
      if (id === null) return { refuse: NO_CAMERA };
      const address = typeof msg.address === "string" && msg.address !== "" ? msg.address : null;
      return {
        method: "GET",
        path: address === null
          ? `/cameras/${id}/receive-line`
          : `/cameras/${id}/receive-line?address=${encodeURIComponent(address)}`,
      };
    },
    (value) => {
      const renderings = (value as { renderings?: unknown } | undefined)?.renderings;
      return `${Array.isArray(renderings) ? renderings.length : 0} ways to receive`;
    },
  );
};
