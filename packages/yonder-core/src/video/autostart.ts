// SPDX-License-Identifier: GPL-3.0-or-later
import { systemClock, type Clock, type Renderer } from "../apply/types.js";
import { RTSP_BASE } from "../media/ports.js";
import type { Camera, Config } from "../schema/config.js";
import { compose, refuse } from "./pipeline.js";
import type { DetectResult } from "./probe/camera.js";
import type { Encoder } from "./probe/encoder.js";
import type { CameraRun, Supervisor } from "./supervisor.js";

/** Restore the boot-time choice once; later applies only update or cancel
 * waiting cameras. Hardware discovery is background work so a missing camera
 * cannot hold up the console, the network, or a configuration confirmation.
 * R-CAM-22, R-CAM-05, R-CTL-01. */
export class CameraAutostart implements Renderer {
  readonly name = "camera-autostart";
  private readonly clock: Clock;
  private readonly pending = new Map<string, Camera>();
  private readonly eligible = new Set<string>();
  // Null means automatic startup handed this camera to the supervisor.
  // A stopped-state reference identifies a suspension by configuration; a
  // later operator action changes the reference and overrides resumption.
  private readonly owned = new Map<string, CameraRun | null>();
  private readonly reasons = new Map<string, string>();
  private initialized = false;
  private closed = false;
  private busy = false;
  private timer: unknown;

  constructor(private readonly opts: {
    supervisor: Supervisor;
    detect: () => Promise<DetectResult>;
    encoder: () => Promise<Encoder>;
    clock?: Clock;
    log: (line: string) => void;
  }) { this.clock = opts.clock ?? systemClock; }

  async render(config: Config): Promise<void> {
    if (this.closed) return;
    const configured = new Map(config.cameras.map((c) => [c.id, c]));
    if (!this.initialized) {
      this.initialized = true;
      for (const camera of config.cameras) {
        if (camera.enabled && camera.autostart) this.eligible.add(camera.id);
      }
    }
    this.pending.clear();
    for (const [id, suspended] of this.owned) {
      const run = this.opts.supervisor.state(id);
      if ((suspended !== null && run !== suspended) || (suspended === null && run.state === "stopped")) {
        this.owned.delete(id); // The operator has taken over.
        continue;
      }
      const camera = configured.get(id);
      if (!camera?.enabled) {
        if (suspended === null) {
          this.opts.supervisor.stop(id);
          this.owned.set(id, this.opts.supervisor.state(id));
        }
      } else if (suspended !== null) {
        this.pending.set(id, camera);
      }
    }
    for (const id of this.eligible) {
      if (!this.untouched(id)) { this.eligible.delete(id); continue; }
      const camera = configured.get(id);
      if (camera?.enabled && camera.autostart) this.pending.set(id, camera);
    }
    this.schedule(0);
  }

  close(): void {
    this.closed = true;
    this.pending.clear();
    this.clock.clearTimer(this.timer);
    this.timer = undefined;
  }

  private schedule(delay: number): void {
    if (this.closed || this.busy || this.timer !== undefined || this.pending.size === 0) return;
    this.timer = this.clock.setTimer(delay, () => {
      this.timer = undefined;
      void this.attempt();
    });
  }

  private untouched(id: string): boolean {
    // Both Start and Stop create a supervisor entry; a status read does not.
    // This also detects a Stop pressed while the hardware probe was awaiting.
    const suspension = this.owned.get(id);
    if (suspension) return this.opts.supervisor.state(id) === suspension;
    return !this.opts.supervisor.all().some((run) => run.id === id);
  }

  private waiting(id: string, reason: string): void {
    if (this.reasons.get(id) === reason) return;
    this.reasons.set(id, reason);
    this.opts.log(`camera autostart: ${id}: ${reason}; retrying in 5 s`);
  }

  private async attempt(): Promise<void> {
    this.busy = true;
    try {
      for (const id of this.pending.keys()) {
        if (!this.untouched(id)) { this.pending.delete(id); this.eligible.delete(id); }
      }
      if (this.closed || this.pending.size === 0) return;
      const detection = await this.opts.detect();
      if (this.closed || this.pending.size === 0) return;
      const encoder = await this.opts.encoder();
      if (this.closed) return;
      // Read pending after both awaits: a configuration apply may have
      // changed or disabled a waiting camera while the devices were queried.
      for (const [id, camera] of this.pending) {
        if (!this.untouched(id)) { this.pending.delete(id); continue; }
        const found = detection.found.find((d) => d.byPath === camera.device);
        if (!found) { this.waiting(id, `waiting for ${camera.device}`); continue; }
        const options = { camera, capabilities: found.capabilities, encoder,
          rtspBase: RTSP_BASE, knownDevices: new Set(detection.found.map((d) => d.byPath)) };
        const reason = refuse(options);
        if (reason) { this.waiting(id, reason); continue; }
        try {
          this.opts.supervisor.start(id, compose(options), { retryForever: true });
          this.owned.set(id, null);
          this.eligible.delete(id);
          this.pending.delete(id);
          this.reasons.delete(id);
          this.opts.log(`camera autostart: starting ${id} from its saved configuration`);
        } catch (e) { this.waiting(id, (e as Error).message); }
      }
    } catch (e) {
      for (const id of this.pending.keys()) this.waiting(id, (e as Error).message);
    } finally {
      this.busy = false;
      this.schedule(5_000);
    }
  }
}
