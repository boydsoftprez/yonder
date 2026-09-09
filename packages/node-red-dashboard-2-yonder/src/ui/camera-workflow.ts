// SPDX-License-Identifier: GPL-3.0-or-later
/** Shared user-facing camera lifecycle. A missing preview is not proof of Stop. */
export function videoAction(state?: string | null, running?: boolean | null, blocked?: string | null) {
  const unavailable = blocked ? { action: null, label: 'Start video', message: blocked } : null;
  const actual = state || (running === true ? 'running' : running === false ? 'stopped' : 'unknown');
  switch (actual) {
    case 'running': return { action: 'stop', label: 'Stop video', message: '' };
    case 'stopped': if (unavailable) return unavailable; return { action: 'start', label: 'Start video', message: 'Video is stopped.' };
    case 'failed': if (unavailable) return { ...unavailable, label: 'Retry video' }; return { action: 'start', label: 'Retry video', message: 'Video could not start.' };
    case 'starting': return { action: null, label: 'Starting video…', message: 'Starting video. The preview will connect automatically.' };
    default: return { action: null, label: 'Checking camera…', message: 'Waiting for camera status.' };
  }
}
export function previewFailure(status: number) {
  if (status === 401) return { signIn: true, retry: false, message: 'Your session expired. Sign in to restore the preview and camera controls.' };
  if (status === 403) return { signIn: false, retry: false, message: 'This session does not have permission to view the camera.' };
  if (status === 404) return { signIn: false, retry: true, message: 'The preview is not available yet. Reconnecting automatically.' };
  return { signIn: false, retry: true, message: 'The video service is unavailable. Reconnecting automatically.' };
}
