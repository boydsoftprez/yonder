// SPDX-License-Identifier: GPL-3.0-or-later
import {aircraftMission,validPosition,bearing,distance} from './cockpit-state.mjs';
import {isPositionItem} from './mission-import.mjs';
const jumps=new Set([177,601]);
export const waypointName=seq=>`WP${String(seq).padStart(2,'0')}`;
/** Planned order, not a prediction of the autopilot's jump counters or decisions. */
export function missionSequence(snapshot={}) {
  const m=snapshot.mission, t=snapshot.telemetry, mission=aircraftMission(snapshot);
  const empty={activeSeq:null,activeName:null,fromSeq:null,from:null,fromName:null,nextSeq:null,nextName:null,nextReason:null,courseDeg:null};
  if(!snapshot.connected||t?.ready!==true||t.mode!=='AUTO'||!m?.currentFresh||m.synchronization!=='verified')return empty;
  const index=mission.items.findIndex(i=>i.seq===m.currentSeq),active=mission.items[index];
  if(!active)return empty;
  let from=null,fromSeq=null,fromName=null,nextSeq=null,nextName=null,nextReason='End of plan';
  for(let i=index-1;i>=0;i--){
    const item=mission.items[i];if(jumps.has(item.command))break;
    if(isPositionItem(item)){from=item;fromSeq=item.seq;fromName=waypointName(item.seq);break;}
    if(i===0&&[22,84].includes(item.command)&&item.lat===0&&item.lon===0&&validPosition(mission.home)){
      from=mission.home;fromSeq=item.seq;fromName='TAKEOFF';break;
    }
  }
  if(index===0&&validPosition(mission.home)){from=mission.home;fromName='HOME';}
  for(const item of mission.items.slice(index+1)){
    if(jumps.has(item.command)){nextReason='Mission jump determines the next waypoint';break;}
    if(item.command===20){nextReason='Return to launch follows';break;}
    if(isPositionItem(item)){nextSeq=item.seq;nextName=waypointName(item.seq);nextReason=null;break;}
  }
  const length=from&&isPositionItem(active)?distance(from,active):null;
  return {activeSeq:active.seq,activeName:active.command===16?waypointName(active.seq):`ITEM ${String(active.seq).padStart(2,'0')}`,fromSeq,from,fromName,nextSeq,nextName,nextReason,
    courseDeg:length!==null&&length>=1?bearing(from,active):null};
}

/** Reject a sample tagged by an older MISSION_CURRENT while its target has moved.
 * A planned course is usable only when the reported target AND path error agree.
 * The position tolerance allows message scheduling and whole-degree/metre fields.
 */
export function missionLegMatch(target,sequence,nav,groundspeedKt) {
  const p={lat:nav?.position?.latitude,lon:nav?.position?.longitude};
  if(!validPosition(p)||!Number.isFinite(sequence.courseDeg)||!Number.isFinite(nav?.crossTrackM))return false;
  const d=distance(p,target),b=bearing(p,target);
  const tolerance=10+Math.min(50,Math.max(0,Number.isFinite(groundspeedKt)?groundspeedKt:0)*1852/3600)*.5;
  if(nav.positionTarget&&(distance(nav.positionTarget,target)??Infinity)>2)return false;
  if(!Number.isFinite(nav.waypointDistanceM)||Math.abs(nav.waypointDistanceM-d)>tolerance)return false;
  if(!Number.isFinite(nav.targetBearingDeg))return false;
  const bearingError=Math.abs(((nav.targetBearingDeg-b+540)%360)-180);
  if(d>tolerance&&bearingError>2+Math.asin(Math.min(1,tolerance/d))*180/Math.PI)return false;
  const from=sequence.from,along=distance(from,p),a=(bearing(from,p)-sequence.courseDeg)*Math.PI/180;
  const rightOfPath=along*Math.sin(a);
  // ArduPlane's L1 cross product is left-positive. Our view is right-positive.
  return Math.abs(rightOfPath+nav.crossTrackM)<=tolerance;
}
