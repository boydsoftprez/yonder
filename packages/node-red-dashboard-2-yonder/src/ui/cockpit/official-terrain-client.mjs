// SPDX-License-Identifier: GPL-3.0-or-later

export class TerrainServiceError extends Error {
  constructor(message,status=0,details=null){super(message);this.name='TerrainServiceError';this.status=status;this.details=details}
}

export function createOfficialTerrainClient(options={}) {
  const fetchFn=options.fetchFn||globalThis.fetch?.bind(globalThis);
  if(typeof fetchFn!=='function')throw new Error('Fetch is unavailable');
  const base='/cockpit/api/terrain-service',pollMs=options.pollMs??2000;
  const setTimer=options.setTimer||setTimeout,clearTimer=options.clearTimer||clearTimeout;
  let timer=null,listener=null,running=false,generation=0,pollController=null;
  async function request(path='',body,signal) {
    const init={method:body===undefined?'GET':'POST',headers:{'x-yonder-cockpit':'1'},signal};
    if(body!==undefined){init.headers['content-type']='application/json';init.body=JSON.stringify(body)}
    let response;
    try{response=await fetchFn(base+path,init)}catch(error){throw new TerrainServiceError(error?.message||'Terrain service request failed')}
    let payload=null;try{payload=await response.json()}catch{}
    if(!response.ok)throw new TerrainServiceError(payload?.error||payload?.message||`Terrain service request failed (${response.status})`,response.status,payload);
    return payload;
  }
  const api={
    status:signal=>request('',undefined,signal),
    policy:()=>request('/policy'),
    applyPolicy:(policy,expectedRevision)=>request('/policy/apply',{policy:{enabled:policy.enabled===true,provider:'ardupilot-srtm1',quotaMiB:policy.quotaMiB},expectedRevision}),
    confirmPolicy:id=>request('/policy/confirm',{id}),
    revertPolicy:id=>request('/policy/revert',{id}),
    preview:input=>request('/preview',input?.kind==='manual'
      ? {kind:'manual',name:input.name,bufferM:input.bufferM,bounds:input.bounds,refreshSource:input.refreshSource===true}
      : {kind:'mission',name:input?.name,bufferM:input?.bufferM,refreshSource:input?.refreshSource===true}),
    prepare:previewId=>request('/prepare',{previewId}),
    cancel:jobId=>request('/cancel',{jobId}),
    pin:(areaId,pinned)=>request('/pin',{areaId,pinned}),
    remove:areaId=>request('/remove',{areaId}),
    refreshController:vehicleGeneration=>request('/refresh-controller',{vehicleGeneration}),
    samples:(points,signal)=>request('/samples',{points:(points||[]).map(point=>({lat:point.lat,lon:point.lon}))},signal),
    async refresh(signal){
      try{const status=await api.status(signal);listener?.({status,error:null});return status}
      catch(error){listener?.({status:null,error});throw error}
    },
    start(next){
      api.stop();listener=next;running=true;const mine=++generation;
      const poll=async()=>{pollController=new AbortController();try{await api.refresh(pollController.signal)}catch{}finally{pollController=null;if(running&&mine===generation)timer=setTimer(poll,pollMs)}};
      void poll();return api;
    },
    stop(){running=false;generation++;pollController?.abort();pollController=null;if(timer!==null)clearTimer(timer);timer=null;listener=null},
    close(){api.stop()}
  };
  return api;
}
