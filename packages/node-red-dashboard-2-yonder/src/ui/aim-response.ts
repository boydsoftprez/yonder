// SPDX-License-Identifier: GPL-3.0-or-later
export const EXPO_KEY = 'yonder:aim:expo';
export const SPEED_KEY = 'yonder:aim:speed';
export const AIM_RESPONSE_CHANGED = 'yonder-aim-response-changed';

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
