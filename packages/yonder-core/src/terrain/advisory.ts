// SPDX-License-Identifier: GPL-3.0-or-later
// R-FLT-08/09: bounded terrain data and calibrated advisory presentation.
import type { HeightDatum } from './types.js';
export interface ClearanceInput {
  aircraftHeightM:number|null; surfaceHeightM:number|null; aircraftDatum:HeightDatum;terrainDatum:HeightDatum;
  transformVerified:boolean;telemetryFresh:boolean;coverageComplete:boolean;cautionClearanceM:number;warningClearanceM:number;
}
export interface ClearanceAdvisory { level:'unavailable'|'clear'|'caution'|'warning';clearanceM:number|null;color:string;reason:string }
/** Advisory display only. This module has no command or transport capability. */
export function clearanceAdvisory(input:ClearanceInput):ClearanceAdvisory {
  const no=(reason:string):ClearanceAdvisory=>({level:'unavailable',clearanceM:null,color:'#7c8996',reason});
  if(!input.telemetryFresh)return no('Telemetry stale');
  if(!input.coverageComplete || input.surfaceHeightM===null)return no('Mapped surface unavailable');
  if(input.aircraftDatum==='UNKNOWN' || input.aircraftDatum!==input.terrainDatum || !input.transformVerified)return no('Height reference unverified');
  if(input.aircraftHeightM===null || ![input.aircraftHeightM,input.surfaceHeightM,input.cautionClearanceM,input.warningClearanceM].every(Number.isFinite) || input.warningClearanceM<0 || input.cautionClearanceM<input.warningClearanceM)return no('Clearance input invalid');
  const clearanceM=input.aircraftHeightM-input.surfaceHeightM;
  if(clearanceM<=input.warningClearanceM)return {level:'warning',clearanceM,color:'#ff3b30',reason:'Mapped surface clearance'};
  if(clearanceM<=input.cautionClearanceM)return {level:'caution',clearanceM,color:'#ffbf3b',reason:'Mapped surface clearance'};
  return {level:'clear',clearanceM,color:'#62a87c',reason:'Mapped surface clearance'};
}
