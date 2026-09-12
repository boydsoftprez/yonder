// SPDX-License-Identifier: GPL-3.0-or-later
// Explicit synthetic state. The component harness never invokes a vehicle API.
import {bearing,distance,destination} from '../src/ui/cockpit/cockpit-state.mjs';
import {isPositionItem} from '../src/ui/cockpit/mission-import.mjs';
import {instrumentFixture} from './instrument-fixture.mjs';
import cove from '../src/ui/cockpit/data/cove-demo.json' with {type:'json'};
export function fixture() {
 const now=Date.now(),home={seq:0,command:16,frame:0,params:[0,0,0,0],x:cove.home.lat,y:cove.home.lon,z:cove.home.alt,current:true,autocontinue:true};
 const items=[home,...cove.items.map(({lat,lon,alt,...item})=>({...item,x:lat,y:lon,z:alt}))];
 const trailPoints=Array.from({length:121},(_,i)=>{const a=i/120*Math.PI*2;return [i+1,480000+i*1000,home.x+Math.sin(a)*.0015,home.y+(Math.cos(a)-1)*.002, i*10,1]});
 const ownTrail={epoch:'fixture-trail',revision:0,latest:121,bootMs:600000,clockAt:now,startBootMs:480000,gaps:0,simplified:false,truncated:false,tail:trailPoints.at(-1),points:trailPoints};
 const snapshot={ at:now,ownTrail,sequence:1,identity:{system:1,component:1,autopilot:3,vehicleType:1,generation:'fixture-only'},connected:true,ready:true,busy:false,operations:[],mission:{revision:'fixture-mission-1',items,currentSeq:2,currentFresh:true,synchronization:'verified',message:'Fixture mission · no aircraft connected'},capabilities:{modes:[{name:'AUTO',customMode:10},{name:'GUIDED',customMode:15},{name:'LOITER',customMode:12},{name:'RTL',customMode:11},{name:'MANUAL',customMode:0}],commands:[{command:178},{command:183}],terrainTargets:false,flightControl:['heading','altitude','speed','loiter'].map((kind,index)=>({kind,command:[43002,43001,43000,192][index],available:true,source:'fixture-only',reason:null,requiredMode:15,entersGuided:true,confirmation:'acknowledgement'}))},telemetry:{turnRate:{degS:1.5,ageMs:0,source:'ATTITUDE'},estimatedTrueAirspeed:{knots:55,velocityAgeMs:0,windAgeMs:0,source:'GLOBAL_POSITION_INT/WIND'},slipSkid:{lateralG:0,normalG:1.1,ageMs:0,source:'RAW_IMU'},wind:{directionFromDeg:225,speedKt:14.1421356,ageMs:0,source:'WIND'},source:'SYNTHETIC FIXTURE',ready:true,ageMs:0,rollDeg:8,pitchDeg:3,yawRateDegS:1.4,airspeedKt:43,groundspeedKt:44,headingDeg:180,trackDeg:181,altitudeFt:1336,verticalSpeedFpm:500,latitude:cove.home.lat,longitude:cove.home.lon,altitudeDatum:'EGM96',globalAltitudeM:407.2,gpsAltitudeM:409,relativeAltitudeM:91.56,fixType:3,satellites:14,batteryV:15.6,currentA:8.4,batteryPercent:78,throttlePercent:58,mode:'AUTO',customMode:10,armed:true,fdReady:true,navRollDeg:12,navPitchDeg:5,homePosition:{lat:home.x,lon:home.y,alt:home.z},fields:{},navController:{crossTrackM:34,navBearingDeg:164,targetBearingDeg:165,waypointDistanceM:850,missionSeq:2,mode:'AUTO',autopilotId:3,vehicleType:1,ageMs:0,positionTarget:null}} };
 snapshot.instruments=instrumentFixture(now);
 return fixtureLeg(snapshot,2);
}

// R-FLT-29: a configured, detected camera with a stills frame, shaped like
// `yonder-core`'s own cockpit camera record (`cockpit/camera.ts`'s
// `CockpitCamera`) plus the `stillsUrl` field `YonderCockpit.vue`'s own
// `cameraProps` reads off `snapshot.camera` and hands to `YonderPicture` —
// never a shape invented fresh here. The stills frame is a small inline
// SVG: this harness never contacts a device, so there is no lens to
// photograph.
const syntheticCamera = {
 id: 'seekerhd', name: 'SeekerHD', path: 'seekerhd-preview', detected: true, run: null,
 profileId: 'fixture-only', calibration: null, frameCaptureMs: null, poseTimeMs: null, timeErrorMs: null,
 registration: { ready: false, reason: 'Camera lens/mount calibration and capture-time alignment have not been verified' },
 stillsUrl: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#1c2a33"/><text x="320" y="184" fill="#7f8a95" font-family="sans-serif" font-size="22" text-anchor="middle">SYNTHETIC STILLS FRAME</text></svg>')
};

// A report with the synthetic camera attached — additive only. `fixture()`
// itself keeps reporting no camera at all, so every existing check against
// the camera-unavailable fallback (`guide.mjs`'s own "Data setup" group,
// `flight-host.component.test.ts`'s own "offers camera fallback" test)
// still sees exactly what it saw before this camera existed; the default
// background stays synthetic terrain, so no committed capture moves.
export function fixtureCamera(report = fixture()) {
 return { ...report, camera: syntheticCamera, cameras: [syntheticCamera] };
}

// Consistent synthetic observations for exercising actual leg handoffs in the UI.
export function fixtureLeg(snapshot,seq,rightOfPathM=20) {
 const list=snapshot.mission.items,index=list.findIndex(i=>i.seq===seq),target=list[index];
 const previous=list.slice(0,index).reverse().find(i=>isPositionItem({...i,lat:i.x,lon:i.y}));
 const from={lat:previous.x,lon:previous.y},to={lat:target.x,lon:target.y};
 const course=bearing(from,to),p=destination(destination(from,course,distance(from,to)*.5),course+90,rightOfPathM);
 const next={...snapshot,mission:{...snapshot.mission,currentSeq:seq},telemetry:{...snapshot.telemetry}};
 Object.assign(next.telemetry,{latitude:p.lat,longitude:p.lon,navController:{...snapshot.telemetry.navController,
   crossTrackM:-rightOfPathM,navBearingDeg:(course-10+360)%360,targetBearingDeg:bearing(p,to),
   waypointDistanceM:distance(p,to),missionSeq:seq,position:{latitude:p.lat,longitude:p.lon},positionTarget:to,ageMs:0}});
 return next;
}
