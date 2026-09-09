// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, it } from 'vitest';
import { CameraResponse } from './response-model.js';

it('clears every camera surface on selection and rejects stale read or refresh DTOs before projection', () => {
  const gate = new CameraResponse();
  gate.receive({ workspaceKind: 'selection', camera: 'cam0' });
  const clear = gate.receive({ workspaceKind: 'selection', camera: 'cam1' });
  expect(clear?.payload).toMatchObject({ picture: { path: '', aim: null, cameras: [] }, aim: { state: 'gated', url: null, pan: null, tilt: null } });
  const b = { camera: 'cam1', payload: { deck: { camera: { id: 'cam1' } }, picture: { path: 'cam1' }, aim: { url: '/video/cam1/aim' } } };
  expect(gate.receive(b)).toEqual(b);
  expect(gate.receive({ camera: 'cam0', payload: { picture: { path: 'cam0' } } })).toBeNull();
  expect(gate.receive({ camera: 'cam0', yonder: { state: 'rejected' } })).toBeNull();
  expect(gate.receive({ workspaceKind: 'selection', camera: 'cam1' })).toBeNull();
});
