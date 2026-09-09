// SPDX-License-Identifier: GPL-3.0-or-later
import type { RED, RedNode } from './red.js';
import { CameraResponse } from './response-model.js';

export = function register(RED: RED): void {
  RED.nodes.registerType('yonder-camera-response', function (this: RedNode, config) {
    RED.nodes.createNode(this, config);
    const model = new CameraResponse();
    this.on('input', (message, send, done) => {
      const response = model.receive(message);
      if (response) send(response);
      done();
    });
  });
};
