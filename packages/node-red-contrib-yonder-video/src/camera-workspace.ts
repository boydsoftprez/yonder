// SPDX-License-Identifier: GPL-3.0-or-later
import type { RED, RedNode } from './red.js';
import { CameraWorkspace } from './workspace-model.js';

export = function register(RED: RED): void {
  RED.nodes.registerType('yonder-camera-workspace', function (this: RedNode, config) {
    RED.nodes.createNode(this, config);
    const model = new CameraWorkspace();
    this.on('input', (message, send, done) => {
      const payload = model.receive(message);
      if (payload) send({ payload });
      done();
    });
  });
};
