// SPDX-License-Identifier: GPL-3.0-or-later
import { registerWidget } from './widget.js';
import type { RED } from './red.js';
export = function register(RED: RED): void {
  registerWidget(RED, { type: 'ui-yonder-settings', props: () => ({}) });
};
