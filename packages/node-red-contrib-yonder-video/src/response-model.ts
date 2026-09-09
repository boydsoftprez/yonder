// SPDX-License-Identifier: GPL-3.0-or-later
import type { NodeMessage } from './red.js';

/** One selection gate before all camera DTO projections, including refreshes. */
export class CameraResponse {
  private selected: string | null | undefined;
  receive(message: NodeMessage): NodeMessage | null {
    if (message.workspaceKind === 'selection') {
      const selected = typeof message.camera === 'string' && message.camera ? message.camera : null;
      if (selected === this.selected) return null;
      this.selected = selected;
      const reason = 'Waiting for the selected camera report.';
      return { camera: selected, payload: {
        picture: { path: '', cost: '', state: null, running: null, recording: null, cameras: [], downlink: null,
          aim: null, zoom: null, exposure: null, stats: null, saved: null },
        aim: { state: 'gated', reason, inhibited: reason, url: null, generation: null,
          pan: null, tilt: null, bounds: null, mode: null, modes: [] },
        captures: { camera: selected, listing: 'unavailable', reason, captures: [] },
      } };
    }
    if (this.selected !== undefined && message.camera !== this.selected) return null;
    return message;
  }
}
