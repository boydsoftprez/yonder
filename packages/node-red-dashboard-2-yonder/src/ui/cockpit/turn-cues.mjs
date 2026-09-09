// SPDX-License-Identifier: GPL-3.0-or-later
// Yonder geometry and physics; behavior references are recorded in PROVENANCE.md.
const finite=Number.isFinite, RAD=Math.PI/180;
const fresh=(age,ttl)=>finite(age)&&age>=0&&age<ttl;
export function turnCueState(telemetry={}) {
  const t=telemetry.turnRate, a=telemetry.estimatedTrueAirspeed;
  const live=telemetry.ready===true;
  const degS=live&&t?.source==='ATTITUDE'&&finite(t.degS)&&Math.abs(t.degS)<=360&&fresh(t.ageMs,2000)?t.degS:null;
  const tas=live&&a?.source==='GLOBAL_POSITION_INT/WIND'&&finite(a.knots)&&a.knots>=0&&a.knots<=1943.8444924406
    &&fresh(a.velocityAgeMs,2000)&&fresh(a.windAgeMs,5000)?a.knots:null;
  const bankDeg=tas!==null&&tas>=50?Math.atan((tas*1852/3600)*(3*RAD)/9.80665)/RAD:null;
  return {degS,tas,bankDeg,vectorDeg:degS===null?null:Math.max(-24,Math.min(24,degS*6)),overrange:degS!==null&&Math.abs(degS)>4,
    bankReason:!live?'Flight telemetry unavailable':tas===null?'Fresh ground velocity and wind required for estimated TAS':tas<50?'Hidden below 50 KT estimated TAS':null,
    rateReason:degS===null?'Fresh heading-rate data required (attitude and body rates)':'Measured heading change'};
}
export function turnArcPath(angleDeg,radius=125) {
  if(!finite(angleDeg)||angleDeg===0)return '';
  const a=angleDeg*RAD;
  return `M0 ${-radius} A${radius} ${radius} 0 0 ${angleDeg>0?1:0} ${radius*Math.sin(a)} ${-radius*Math.cos(a)}`;
}
