// SPDX-License-Identifier: GPL-3.0-or-later
import {
  projectionMatrix
} from './terrain-state.mjs';
/** Widen the visible scene without changing the authored instrument geometry. */
export function viewportProjection(width, height) {
  const fit = Math.min(width / 640, height / 650),
    x = 640 * fit / width,
    y = 650 * fit / height,
    matrix = projectionMatrix();
  matrix[0] *= x;
  matrix[5] *= y;
  matrix[9] *= y;
  return {
    matrix,
    scale: [x, y]
  };
}
