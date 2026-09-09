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

export function saveResponse(key: string, value: number): void {
  try { localStorage.setItem(key, String(value)); } catch { /* Current pad still uses its chosen value. */ }
  // Retire any image drag as well as the pad gesture when its response changes.
  window.dispatchEvent(new CustomEvent(AIM_RESPONSE_CHANGED, { detail: { key, value } }));
}
