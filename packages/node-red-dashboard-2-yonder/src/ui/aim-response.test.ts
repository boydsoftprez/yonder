// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, it } from 'vitest';
import { screenToCamera } from './aim-response.js';
it.each([
  ['identity', 3, 4], ['horiz', -3, 4], ['vert', 3, -4], ['180', -3, -4],
  ['90r', -4, 3], ['90l', 4, -3], ['ul-lr', -4, -3], ['ur-ll', 4, 3],
])('maps screen direction through %s without changing speed', (direction, pan, tilt) => {
  const result = screenToCamera({ pan:3, tilt:4 }, String(direction));
  expect(result).toEqual({pan,tilt});
  expect(Math.hypot(result!.pan,result!.tilt)).toBe(5);
});
it('refuses an unknown image transform', () => {
  expect(screenToCamera({pan:3,tilt:4},'unknown')).toBeNull();
});
