// SPDX-License-Identifier: GPL-3.0-or-later
import { cameraId, registerAdapter, NO_CAMERA } from "./adapter.js";
import type { RED } from "./red.js";

/**
 * `yonder-stream` — start and stop one camera's pipeline (R-CTL-01).
 *
 * **Runtime, not configuration.** A stop survives no apply and no reboot: a
 * camera configured to autostart comes back streaming. That is deliberate —
 * Start and Stop are the only controls that stop the aircraft *sending*, and
 * an operator watching the uplink track go past its mark needs something that
 * acts now rather than something that takes a confirmation window to arm.
 *
 * **The supervisor is not here.** It lives in the daemon, for the process's
 * lifetime: a Node-RED redeploy destroys and recreates every node, so a
 * supervisor inside one would drop every camera's pipeline the moment somebody
 * edited a flow — including, on a flying aircraft, the feed a ground station
 * is watching. This node posts an action and reports the run state that came
 * back, which is the observed state and not the command (R-UI-05).
 */
export = function register(RED: RED): void {
  registerAdapter(
    RED,
    "yonder-stream",
    (msg, config) => {
      const id = cameraId(msg, config);
      if (id === null) return { refuse: NO_CAMERA };
      // Two words, and nothing else is guessed at. A control that sent
      // something the daemon did not recognise would spend a round trip to be
      // told so, and the operator would read the daemon's refusal about their
      // own button.
      const action = msg.payload === "start" || msg.payload === "stop" ? msg.payload : null;
      if (action === null) {
        return { refuse: 'this control must send "start" or "stop"' };
      }
      return { method: "POST", path: `/cameras/${id}/run`, body: { action } };
    },
    (value) => {
      const run = value as { state?: unknown; reason?: unknown } | undefined;
      const state = typeof run?.state === "string" ? run.state : "unknown";
      // The supervisor's own reason, when it has one — "the pipeline exited
      // with code 1" is what an operator needs after a camera that would not
      // start, and it is Yonder's wording rather than a subprocess's.
      return typeof run?.reason === "string" ? `${state}: ${run.reason}` : state;
    },
  );
};
