// SPDX-License-Identifier: GPL-3.0-or-later
// R-FLT-21: conversions are presentation only. Stored mission/command data stays SI.
export const unitChoices={altitudeUnit:['ft','m'],speedUnit:['kt','mph','mps'],verticalSpeedUnit:['fpm','mps']};
export const unitLabels={ft:'FT',m:'M',kt:'KT',mph:'MPH',mps:'m/s',fpm:'FT/MIN'};
const factors={ft:1/.3048,m:1,kt:3600/1852,mph:1/.44704,mps:1,fpm:60/.3048};
export function units(input={}){return Object.fromEntries(Object.entries(unitChoices).map(([k,v])=>[k,v.includes(input[k])?input[k]:v[0]]))}
export const toDisplay=(value,unit)=>Number.isFinite(value)&&factors[unit]?value*factors[unit]:null;
export const fromDisplay=(value,unit)=>value!==null&&value!==undefined&&String(value).trim()!==''&&Number.isFinite(Number(value))&&factors[unit]?Number(value)/factors[unit]:null;
export const unitFor=(key,options={})=>{const u=units(options);return {airspeed:u.speedUnit,altitude:u.altitudeUnit,vsi:u.verticalSpeedUnit}[key]};
const canonicalSI={airspeed:1852/3600,altitude:.3048,vsi:.3048/60};
export const flightValue=(key,value,options)=>canonicalSI[key]?toDisplay(Number.isFinite(value)?value*canonicalSI[key]:null,unitFor(key,options)):value;
export const canonicalValue=(key,value,options)=>canonicalSI[key]?((fromDisplay(value,unitFor(key,options))??NaN)/canonicalSI[key]):Number(value);
export const unitText=(value,unit,digits=0)=>Number.isFinite(value)?toDisplay(value,unit).toLocaleString('en-US',{maximumFractionDigits:digits})+' '+unitLabels[unit]:'— '+unitLabels[unit];
