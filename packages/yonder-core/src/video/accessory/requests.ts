// SPDX-License-Identifier: GPL-3.0-or-later
import { HG211_MAX_RATE_DEG_S } from './guard.js';
/** Narrow authenticated transport grammar; Intent remains authoritative on grant admission. */
export function validAimRequest(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const b = value as Record<string, unknown>;
  const id = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(v);
  const exact = (...keys: string[]) => Object.keys(b).length === keys.length && keys.every(k => Object.hasOwn(b, k));
  switch (b.op) {
    case 'issue': return exact('op', 'clientGesture') && id(b.clientGesture);
    case 'stop': return exact('op', 'gesture') && id(b.gesture);
    case 'recentre': return exact('op');
    case 'mode': return exact('op', 'mode') && [0,1,2].includes(b.mode as number);
    case 'issue-recall': return exact('op','clientGesture','slot','maxRate','revision') && id(b.clientGesture)
      && Number.isInteger(b.slot) && (b.slot as number)>=1 && (b.slot as number)<=6
      && Number.isSafeInteger(b.revision) && (b.revision as number)>=0
      && typeof b.maxRate==='number' && Number.isFinite(b.maxRate) && b.maxRate>=1 && b.maxRate<=60;
    case 'recall': return exact('op','gesture','credential','deadline','seq') && id(b.gesture) && id(b.credential)
      && typeof b.deadline==='number' && Number.isFinite(b.deadline) && Number.isSafeInteger(b.seq) && (b.seq as number)>=0;
    case 'slew': return exact('op','gesture','credential','deadline','seq','pan','tilt') && id(b.gesture) && id(b.credential)
      && typeof b.deadline === 'number' && Number.isFinite(b.deadline)
      && Number.isSafeInteger(b.seq) && (b.seq as number) >= 0
      && [b.pan, b.tilt].every(v => typeof v === 'number' && Number.isFinite(v))
      && Math.hypot(b.pan as number, b.tilt as number) <= HG211_MAX_RATE_DEG_S;
    default: return false;
  }
}
