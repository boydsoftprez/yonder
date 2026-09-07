// SPDX-License-Identifier: GPL-3.0-or-later
import {unpackFlight} from 'yonder-core/cockpit-wire';
import {createOwnTrailClient} from './own-trail.mjs';

/** Flight reads never wait for mission/history downloads or retransmit commands. */
export function createCockpitApi(fetchFn=(...args)=>fetch(...args)){
  let details=null,mission=null,missionKey=null,latest=null,detailsTask=null,missionTask=null;
  let detailsRetry=0,missionRetry=0,detailsError='',missionError='',closed=false;
  let receivedBytes=0,flightBytes=0,detailsTransfers=0,missionTransfers=0;
  const controllers=new Set(),samples=[];
  const trail=createOwnTrailClient(request);
  async function request(url,init={}){
    const controller=new AbortController();controllers.add(controller);
    const timer=setTimeout(()=>controller.abort(),5000);
    try{
      const response=await fetchFn(url,{...init,credentials:'same-origin',cache:'no-store',signal:controller.signal});
      let body;
      try{body=await response.json();}catch(error){
        if(error.name==='AbortError')throw error;
        if(response.ok)throw new Error('Flight service returned an invalid response');
        body={};
      }
      const bytes=new TextEncoder().encode(JSON.stringify(body)).length,now=Date.now();
      receivedBytes+=bytes;samples.push({at:now,bytes});while(samples.length>256||samples[0]?.at<now-10000)samples.shift();
      if(url.endsWith('/flight'))flightBytes=bytes;
      if(!response.ok){const error=new Error(body?.error||body?.message||(response.status>=500?`Flight service unavailable (HTTP ${response.status}) · check the local simulator or aircraft connection`:`Console request failed (${response.status})`));error.admissionRejected=response.status>=400&&response.status<500;throw error;}
      return body;
    }finally{clearTimeout(timer);controllers.delete(controller);}
  }
  function refreshDetails(wire){
    if(detailsTask||details?.detailKey===wire.d||Date.now()<detailsRetry||closed)return;
    detailsTransfers++;
    detailsTask=request('/cockpit/api/details').then(value=>{
      if(closed||(value.identity?.generation??null)!==latest?.g)return;
      details=value;detailsError='';
    }).catch(error=>{if(!closed){detailsError=error.message;detailsRetry=Date.now()+2000;}}).finally(()=>{detailsTask=null;});
  }
  function refreshMission(wire){
    const key=JSON.stringify([wire.g,wire.m.revision]);
    if(missionTask||missionKey===key||Date.now()<missionRetry||closed)return;
    missionTransfers++;
    missionTask=request('/cockpit/api/mission').then(value=>{
      if(!value.mission||!Array.isArray(value.mission.items))throw new Error('Incomplete aircraft mission details');
      if(closed||value.generation!==latest?.g||value.mission.revision!==latest?.m.revision)return;
      mission=value.mission;missionKey=JSON.stringify([value.generation,value.mission.revision]);missionError='';
    }).catch(error=>{if(!closed){missionError=error.message;missionRetry=Date.now()+2000;}}).finally(()=>{missionTask=null;});
  }
  return {
    async state(){
      if(closed)throw new Error('Cockpit connection is closed');
      const wire=await request('/cockpit/api/flight');
      // Decode/version-check before using indexes or starting any dependent reads.
      unpackFlight(wire,{});
      if(latest&&latest.g!==wire.g){details=null;mission=null;missionKey=null;detailsRetry=0;missionRetry=0;}
      latest=wire;refreshDetails(wire);refreshMission(wire);
      trail.observe(wire.r);
      const cached={...(details||{}),mission:missionKey===JSON.stringify([wire.g,wire.m.revision])?mission:undefined};
      const snapshot=unpackFlight(wire,cached);
      return {...details,...snapshot,ownTrail:trail.view(),_detailsReady:details?.detailKey===wire.d,_missionReady:!!cached.mission,
        detailError:detailsError||missionError};
    },
    dataOptions:options=>request('/cockpit/api/data-options',{method:'POST',headers:{'content-type':'application/json','x-yonder-cockpit':'1'},body:JSON.stringify(options)}),
    setTrailOptions:options=>trail.configure(options),
    command:body=>request('/cockpit/api/command',{method:'POST',headers:{'content-type':'application/json','x-yonder-cockpit':'1'},body:JSON.stringify(body)}),
    stats(){const now=Date.now(),recent=samples.filter(s=>s.at>=now-10000);const span=recent.length?Math.max(1,(now-recent[0].at)/1000):1;return {transport:'compact-v1',flightBytes,receivedBytes,bytesPerSecond:recent.reduce((sum,s)=>sum+s.bytes,0)/span,detailsTransfers,missionTransfers};},
    close(){closed=true;trail.close();for(const controller of controllers)controller.abort();controllers.clear();}
  };
}
