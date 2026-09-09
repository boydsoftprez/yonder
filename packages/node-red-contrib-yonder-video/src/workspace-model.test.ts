// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { CameraWorkspace } from './workspace-model.js';

const report = { camera: { id: 'cam0', name: 'Camera' }, controls: { untouched: true } };
describe('camera workspace snapshot', () => {
  it('retires camera A controls on a failed read of B, preserves pending, and hydrates B on recovery', () => {
    const model = new CameraWorkspace();
    model.receive({ workspaceKind: 'report', payload: report });
    model.receive({ workspaceKind: 'pending', payload: { pending: true, id: 'apply-1', keys: [{ action: 'revert' }] }, yonder: { state: 'pending', expiresAt: 1500 } });
    model.receive({ workspaceKind: 'result', camera: 'cam0', problems: [{ path: 'width', message: 'A refused' }], yonder: { state: 'rejected', message: 'Draft refused' } });
    const failed = model.receive({ workspaceKind: 'report', camera: 'cam1', payload: 'Read failed', yonder: { state: 'rejected', message: 'B unavailable' } });
    expect(failed).not.toHaveProperty('camera');
    expect(failed).not.toHaveProperty('controls');
    expect(failed).toMatchObject({ problems: [], workspace: { pending: { id: 'apply-1', expiresAt: 1500 }, result: { message: 'B unavailable' } } });
    expect(model.receive({ workspaceKind: 'pending', payload: { pending: false }, yonder: { state: 'idle' } })).not.toHaveProperty('controls');
    const recovered = model.receive({ workspaceKind: 'report', camera: 'cam1', payload: { camera: { id: 'cam1' }, controls: { cameraB: true } } });
    expect(recovered).toMatchObject({ camera: { id: 'cam1' }, controls: { cameraB: true }, workspace: { pending: { pending: false }, result: null } });
    expect(recovered?.controls).not.toHaveProperty('untouched');
  });
  it('retains its own camera report during a same-camera read failure', () => {
    const model = new CameraWorkspace(); model.receive({ workspaceKind: 'report', payload: report });
    expect(model.receive({ workspaceKind: 'report', camera: 'cam0', yonder: { state: 'rejected', message: 'Temporarily unavailable' } })).toMatchObject({ ...report, workspace: { result: { message: 'Temporarily unavailable' } } });
    expect(model.receive({ workspaceKind: 'report', payload: report })).toMatchObject({ ...report, workspace: { result: null } });
  });
  it('retains the camera while authoritative pending updates arrive and carries exact deadlines/keys', () => {
    const model = new CameraWorkspace(); model.receive({ workspaceKind: 'report', payload: report });
    const snapshot = model.receive({ workspaceKind: 'pending', payload: { pending: true, id: 'apply-1', keys: [{ action: 'revert' }], what: 'Configuration pending', why: 'Device confirms' }, yonder: { state: 'pending', expiresAt: 1500, at: 1000, movesRadio: true, message: 'Device is checking' } });
    expect(snapshot).toMatchObject({ ...report, workspace: { pending: { pending: true, id: 'apply-1', keys: [{ action: 'revert' }], expiresAt: 1500, movesRadio: true } } });
    expect(model.receive({ workspaceKind: 'report', payload: { ...report, controls: { untouched: false } } })).toMatchObject({ workspace: { pending: { id: 'apply-1', expiresAt: 1500 } } });
  });
  it('keeps operation errors inline across polls, ignores idle polling noise and never retains another camera result', () => {
    const model = new CameraWorkspace(); model.receive({ workspaceKind: 'report', payload: report });
    model.receive({ workspaceKind: 'result', camera: 'cam0', yonder: { state: 'rejected', message: 'Setting refused', at: 1000 } });
    expect(model.receive({ workspaceKind: 'pending', payload: { pending: false }, yonder: { state: 'idle', message: 'Ready' } })).toMatchObject({ workspace: { result: { message: 'Setting refused' } } });
    expect(model.receive({ workspaceKind: 'result', camera: 'cam1', yonder: { state: 'confirmed', message: 'Other camera' } })).toBeNull();
    expect(model.receive({ workspaceKind: 'report', payload: { camera: { id: 'cam1' } } })).toMatchObject({ workspace: { result: null } });
  });
  it('owns copies so flow mutation cannot alter a hydrated transaction or camera report', () => {
    const model = new CameraWorkspace(); const input = structuredClone(report); model.receive({ workspaceKind: 'report', payload: input }); input.camera.id = 'changed';
    expect(model.receive({ workspaceKind: 'pending', payload: { pending: false }, yonder: { state: 'idle' } })).toMatchObject({ camera: { id: 'cam0' } });
  });
});

it('keeps refused draft problems across camera polls until a successful operation or camera change', () => {
  const model = new CameraWorkspace(); model.receive({ workspaceKind: 'report', payload: report });
  model.receive({ workspaceKind: 'result', camera: 'cam0', problems: [{ path:'width',message:'Not offered' }], yonder: { state:'rejected',message:'Draft refused',at:1000 } });
  expect(model.receive({ workspaceKind:'report',payload:report })).toMatchObject({ problems: [{path:'width',message:'Not offered'}],problemsFor:'cam0' });
  expect(model.receive({ workspaceKind:'result', camera:'cam0',yonder:{state:'confirmed',message:'Applied',at:1100} })).toMatchObject({ problems:[] });
});
