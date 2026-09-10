// SPDX-License-Identifier: GPL-3.0-or-later
// R-FLT-04: planning metadata and explicit controller-home requests are separate.
export function planningHome(value) {
  const home={};
  for(const [key,min,max] of [['lat',-90,90],['lon',-180,180],['alt',-1000,30000]]){
    const raw=value?.[key];
    if(!['number','string'].includes(typeof raw)||String(raw).trim()===''||!Number.isFinite(Number(raw))||Number(raw)<min||Number(raw)>max)
      throw new Error(key==='alt'?'Enter home elevation in MSL (-1000 to 30000 m).':`Enter a valid home ${key==='lat'?'latitude':'longitude'}.`);
    home[key]=Number(raw);
  }
  return home;
}
export function sameHome(a,b) {
  if(a===null||b===null)return a===b;
  return !!a&&!!b&&Math.abs(a.lat-b.lat)<=2e-7&&Math.abs(a.lon-b.lon)<=2e-7&&Math.abs(a.alt-b.alt)<=.1;
}
export function controllerHomeRequest(value, reportedHome) {
  const home=planningHome(value);
  if(Math.round(home.lat*1e7)===0&&Math.round(home.lon*1e7)===0)throw new Error('ArduPlane treats 0°, 0° as “use current location”. Enter the intended home coordinates.');
  return {kind:'set-home',home,expectedHome:reportedHome?planningHome(reportedHome):null};
}
export function homeDifference(planned,reported) {
  if(!planned||!reported)return null;
  const radians=Math.PI/180,dy=(reported.lat-planned.lat)*radians,dx=(reported.lon-planned.lon)*radians;
  const q=Math.sin(dy/2)**2+Math.cos(planned.lat*radians)*Math.cos(reported.lat*radians)*Math.sin(dx/2)**2;
  return {distanceM:6371000*2*Math.atan2(Math.sqrt(q),Math.sqrt(Math.max(0,1-q))),altitudeM:reported.alt-planned.alt};
}
