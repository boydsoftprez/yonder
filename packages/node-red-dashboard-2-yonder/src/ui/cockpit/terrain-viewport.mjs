// SPDX-License-Identifier: GPL-3.0-or-later
import { projectionMatrix } from "./terrain-state.mjs";
/** Widen the visible scene without changing the authored instrument geometry. */
export function viewportProjection(width, height, viewport) {
  if (
    viewport &&
    [
      width,
      height,
      viewport.centerX,
      viewport.centerY,
      viewport.pixelsPerDegree,
    ].every(Number.isFinite) &&
    width > 0 &&
    height > 0 &&
    viewport.pixelsPerDegree > 0
  ) {
    const matrix = projectionMatrix(),
      radians = Math.PI / 180;
    matrix[0] = (2 * viewport.pixelsPerDegree * height) / radians / width;
    matrix[5] = (2 * viewport.pixelsPerDegree) / radians;
    matrix[8] = 1 - 2 * viewport.centerX;
    matrix[9] = 2 * viewport.centerY - 1;
    return {
      matrix,
      scale: [
        matrix[0] / projectionMatrix()[0],
        matrix[5] / projectionMatrix()[5],
      ],
    };
  }
  const fit = Math.min(width / 640, height / 650),
    x = (640 * fit) / width,
    y = (650 * fit) / height,
    matrix = projectionMatrix();
  matrix[0] *= x;
  matrix[5] *= y;
  matrix[9] *= y;
  return {
    matrix,
    scale: [x, y],
  };
}
