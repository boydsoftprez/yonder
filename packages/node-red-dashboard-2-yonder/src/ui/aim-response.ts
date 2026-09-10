// SPDX-License-Identifier: GPL-3.0-or-later
export const EXPO_KEY = 'yonder:aim:expo';
export const SPEED_KEY = 'yonder:aim:speed';
export const AIM_RESPONSE_CHANGED = 'yonder-aim-response-changed';

/** Inverse displayed-image transform, with pan right and tilt up positive. */
export function screenToCamera(rate: { pan: number; tilt: number }, direction = 'identity'): { pan: number; tilt: number } | null {
  const { pan: x, tilt: y } = rate;
  switch (direction) {
    case 'identity': return { pan: x, tilt: y };
    case 'horiz': return { pan: -x, tilt: y };
    case 'vert': return { pan: x, tilt: -y };
    case '180': return { pan: -x, tilt: -y };
    case '90r': return { pan: -y, tilt: x };
    case '90l': return { pan: y, tilt: -x };
    case 'ul-lr': return { pan: -y, tilt: -x };
    case 'ur-ll': return { pan: y, tilt: x };
    default: return null;
  }
}

export function savedNumber(key: string, fallback: number, minimum: number, maximum: number): number {
  try {
    const saved = localStorage.getItem(key);
    if (saved !== null && saved.trim() !== '') {
      const value = Number(saved);
      if (Number.isFinite(value) && value >= minimum && value <= maximum) return value;
    }
  } catch { /* A browser preference is optional. */ }
  return fallback;
}

export function rateLimit(maxRate: number): number {
  return Number.isFinite(maxRate) && maxRate > 0 ? Math.min(maxRate, 120) : 0;
}

export function responseMagnitude(throwFraction: number, expo: number, speed: number): number {
  const k = Math.max(0, Math.min(1, throwFraction));
  const e = Math.max(0, Math.min(100, expo)) / 100;
  return ((1 - e) * k + e * k * k * k) * speed;
}

/** A rate below the camera's 0.1 degree/s wire resolution is rest, not a gesture. */
export function hasWireMotion(pan: number, tilt: number): boolean {
  return Math.trunc(pan * 10) !== 0 || Math.trunc(tilt * 10) !== 0;
}

export function aimFailure(reason: string): string {
  const messages: Record<string, string> = {
    inactive: 'The control signal expired. Release and press again.',
    deadline: 'The control signal arrived too late. Release and press again.',
    busy: 'Another camera control is active. Release it before moving here.',
    unavailable: 'The camera control connection is unavailable.',
    'attitude-stale': 'Camera position feedback is delayed. Release and try again.',
    'limit-direction-unknown': 'The gimbal reached a travel limit. Release the control.',
    revoked: 'Movement stopped because the camera control state changed. Release and try again.',
    'preset-mode': 'Choose FPV mode before recalling a saved position.',
    'preset-position': 'Fresh position relative to the handle is unavailable.',
    'preset-timeout': 'The preset move timed out and stopped.',
    'preset-stalled': 'The saved position could not be reached. Movement stopped.',
  };
  return messages[reason] ?? reason;
}

export function saveResponse(key: string, value: number): void {
  try { localStorage.setItem(key, String(value)); } catch { /* Current pad still uses its chosen value. */ }
  // Retire any image drag as well as the pad gesture when its response changes.
  window.dispatchEvent(new CustomEvent(AIM_RESPONSE_CHANGED, { detail: { key, value } }));
}
