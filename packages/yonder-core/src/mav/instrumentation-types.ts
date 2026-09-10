// SPDX-License-Identifier: GPL-3.0-or-later
/** Slow instrumentation is separate from the fast flight packet. R-FLT-23/26. */
export interface InstrumentReading {
  value: number | string | boolean | null;
  unit: string;
  source: string;
  ageMs: number | null;
  ttlMs: number;
  quality: 'reported' | 'calculated' | 'partial' | 'unavailable';
  reason?: string;
}
export interface InstrumentationSnapshot {
  at: number;
  generation: string | null;
  connected: boolean;
  fields: Record<string, InstrumentReading>;
}
