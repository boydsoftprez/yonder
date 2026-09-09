// SPDX-License-Identifier: GPL-3.0-or-later
import { it, expect } from "vitest";
import { viewportProjection } from "../terrain-viewport.mjs";
it("aligns wide/tall terrain optics with the explicit PFD viewport", () => {
  const viewport = {
    centerX: 0.5,
    centerY: 225 / 650,
    pixelsPerDegree: 5 / 650,
  };
  const normal = viewportProjection(640, 650, viewport),
    fallback = viewportProjection(640, 650);
  expect(normal.matrix[9]).toBeCloseTo(fallback.matrix[9]);
  expect(normal.matrix[5]).toBeCloseTo(fallback.matrix[5], 1);
  const wide = viewportProjection(1200, 650, viewport);
  expect(wide.matrix[5]).toBe(normal.matrix[5]);
  expect(wide.matrix[0] * 1200).toBeCloseTo(normal.matrix[0] * 640, 4);
});
