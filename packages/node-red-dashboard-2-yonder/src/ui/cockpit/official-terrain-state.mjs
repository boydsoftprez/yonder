// SPDX-License-Identifier: GPL-3.0-or-later

export const defaultOfficialTerrainBounds = Object.freeze({south:35,north:35.1,west:-84.1,east:-84});

export function terrainStatusView(status) {
  if (!status) return {
    available:false, coverage:{tone:'muted',label:'Waiting for Yonder'},
    service:{tone:'muted',label:'Waiting for service status'},
    controller:{tone:'muted',label:'Controller status unknown'}
  };
  const job=status.coverage?.job;
  const areas=status.coverage?.areas||status.storage?.areas||[];
  const failed=status.failure;
  const coverage=failed
    ? {tone:'danger',label:failed.message||failed.reason||'Terrain storage failed'}
    : job?.state==='preparing'||job?.state==='paused'
      ? {tone:job.state==='paused'?'warning':'active',label:`${job.state==='paused'?'Paused':'Preparing'} · ${job.completed||0} of ${job.total||0} tiles`}
      : job?.state==='partial'
        ? {tone:'warning',label:`Partial coverage · ${job.reason||'official source contains missing samples'}`}
      : job?.state==='cancelled'||job?.state==='interrupted'
        ? {tone:'warning',label:`Preparation ${job.state}${job.reason?' · '+job.reason:''}`}
      : job?.state==='failed'
        ? {tone:'danger',label:job.reason||'Preparation failed'}
        : areas.some(area=>area.stale)
          ? {tone:'warning',label:'Prepared coverage has a stale mission or source revision'}
          : areas.some(area=>area.complete)
            ? {tone:'good',label:`${areas.filter(area=>area.complete).length} prepared ${areas.filter(area=>area.complete).length===1?'area':'areas'}`}
            : areas.some(area=>area.reasons?.length)
              ? {tone:'warning',label:`Partial coverage · ${areas.find(area=>area.reasons?.length).reasons.join(' · ')}`}
            : {tone:'muted',label:'No complete prepared area'};
  const serviceData=status.service||{};
  let service;
  if (!status.policy?.enabled) service={tone:'muted',label:'Disabled by Yonder configuration'};
  else if (serviceData.enabled===false) service={tone:'muted',label:'Service disabled'};
  else if (serviceData.compatible===false) {
    const reasons=serviceData.compatibility?.reasons||[];
    const unobserved=reasons.some(reason=>['fresh-controller-required','refresh-terrain-capability','refresh-terrain-parameters'].includes(reason));
    service=unobserved
      ? {tone:'warning',label:'Controller terrain compatibility not yet observed · refresh required'}
      : {tone:'danger',label:`Controller terrain configuration incompatible${reasons.length?' · '+reasons.join(' · '):''}`};
  }
  else if (serviceData.missing>0) service={tone:'warning',label:`Serving with ${serviceData.missing} missing ${serviceData.missing===1?'request':'requests'}`};
  else if (serviceData.sent>0) service={tone:'good',label:`Serving · ${serviceData.sent} blocks sent`};
  else service={tone:'active',label:'Waiting for controller terrain requests'};
  const report=serviceData.controller?.report;
  let controller;
  if (!report) controller={tone:'muted',label:'No controller terrain report'};
  else if (!serviceData.controller?.fresh) controller={tone:'warning',label:`Controller report stale · ${report.pending??'—'} pending · ${report.loaded??'—'} loaded`};
  else controller={tone:report.pending>0?'active':'good',label:`Controller · ${report.pending??'—'} pending · ${report.loaded??'—'} loaded · ${report.spacing??'—'} m`};
  return {available:true,coverage,service,controller};
}

export function formatTerrainBytes(bytes) {
  if (!Number.isFinite(bytes)||bytes<0) return 'Unknown';
  const units=['B','KiB','MiB','GiB','TiB'];let value=bytes,index=0;
  while(value>=1024&&index<units.length-1){value/=1024;index++}
  return `${value.toLocaleString('en-US',{maximumFractionDigits:index?1:0})} ${units[index]}`;
}

export function terrainStorageView(status) {
  const storage=status?.storage;
  if (!storage) return {label:'Storage unavailable',detail:status?.failure?.message||status?.failure?.reason||'Waiting for persistent storage status'};
  const used=storage.usedBytes||0,quota=storage.quotaBytes||0,free=storage.storage?.freeBytes;
  return {
    label:`${formatTerrainBytes(used)} used of ${formatTerrainBytes(quota)} quota`,
    detail:`${formatTerrainBytes(free)} filesystem free · ${storage.storage?.persistent?'persistent':'persistence unverified'}`
  };
}

export function validateManualBounds(bounds) {
  const value=Object.fromEntries(['south','north','west','east'].map(key=>[key,Number(bounds?.[key])]));
  if(!Object.values(value).every(Number.isFinite))throw new Error('Enter numeric south, north, west and east bounds');
  if(value.south < -90||value.north>90||value.south>=value.north)throw new Error('South must be below north, within −90° to 90°');
  if(value.west < -180||value.west>180||value.east < -180||value.east>180||value.west===value.east)throw new Error('West and east must be distinct longitudes within −180° to 180°');
  return value;
}

export function previewSvgGeometry(geometry,width=360,height=150) {
  const rectangles=geometry?.rectangles||[],polylines=geometry?.polylines||[];
  const points=[];
  for(const r of rectangles)points.push({lat:r.south,lon:r.west},{lat:r.north,lon:r.east});
  for(const line of polylines)for(const point of line.points||[])points.push(point);
  if(!points.length)return {rectangles:[],polylines:[]};
  const reference=points[0].lon;
  const unwrap=lon=>{let v=lon;while(v-reference>180)v-=360;while(v-reference< -180)v+=360;return v};
  const lats=points.map(p=>p.lat),lons=points.map(p=>unwrap(p.lon));
  let south=Math.min(...lats),north=Math.max(...lats),west=Math.min(...lons),east=Math.max(...lons);
  if(north===south){north+=.01;south-=.01}if(east===west){east+=.01;west-=.01}
  const pad=8,project=p=>({x:pad+(unwrap(p.lon)-west)/(east-west)*(width-pad*2),y:pad+(north-p.lat)/(north-south)*(height-pad*2)});
  return {
    rectangles:rectangles.map(r=>{const a=project({lat:r.north,lon:r.west}),b=project({lat:r.south,lon:r.east});return{x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),width:Math.abs(b.x-a.x),height:Math.abs(b.y-a.y)}}),
    polylines:polylines.map(line=>({kind:line.kind,points:(line.points||[]).map(project).map(p=>`${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}))
  };
}
