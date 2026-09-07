// SPDX-License-Identifier: GPL-3.0-or-later
// R-FLT-15: aircraft observations, independent of public traffic and commands.
const bounded=(n,lo,hi,fallback)=>typeof n==='number'&&Number.isFinite(n)&&n>=lo&&n<=hi?n:fallback;
export function trailPreferences(value={}){
  return {enabled:value.enabled!==false,mode:['time','distance','power'].includes(value.mode)?value.mode:'time',
    minutes:bounded(value.minutes,1,1440,10),distance:bounded(value.distance,.1,1000,5),unit:value.unit==='mi'?'mi':'nm'};
}
const validPoint=p=>Array.isArray(p)&&p.length===6&&p.every(Number.isFinite)&&Number.isSafeInteger(p[0])&&p[0]>0&&p[1]>=0&&Math.abs(p[2])<=90&&Math.abs(p[3])<=180&&p[4]>=0&&Number.isSafeInteger(p[5]);
export function selectOwnTrail(trail,rawOptions={},cleared=null,serverNow=null){
  const options=trailPreferences(rawOptions),segments=[];
  if(!trail)return {segments,label:'Aircraft trail unavailable',message:'Trail recording requires the updated flight service.'};
  const notes=[];
  if(trail.startBootMs!==null&&trail.startBootMs!==undefined)notes.push(`Recorded from ${(trail.startBootMs/60000).toFixed(1)} min after autopilot power-on`);
  else notes.push('Waiting for a valid aircraft position');
  if(trail.gaps)notes.push(`${trail.gaps} telemetry gap${trail.gaps===1?'':'s'}`);
  if(trail.simplified)notes.push('Older path simplified');
  if(trail.truncated)notes.push('Oldest history unavailable');
  if(trail.loading)notes.push('Recovering recorded path');
  if(trail.error)notes.push(trail.error);
  const after=cleared?.epoch===trail.epoch&&Number.isSafeInteger(cleared.after)&&cleared.after>=0?cleared.after:0;
  if(after)notes.push('Display cleared in this browser');
  const label=options.mode==='power'?'Since power-on':options.mode==='time'?`Last ${options.minutes} min`:`Last ${options.distance} ${options.unit==='nm'?'NM':'mi'}`;
  if(!options.enabled)return {segments,label:'Aircraft trail off',message:notes.join(' · ')};
  const clockAge=Number.isFinite(serverNow)&&Number.isFinite(trail.clockAt)?Math.max(0,serverNow-trail.clockAt):0;
  const cutoff=options.mode==='time'?(trail.bootMs??0)+clockAge-options.minutes*60000:-Infinity;
  const distanceCut=options.mode==='distance'?(trail.tail?.[4]??0)-options.distance*(options.unit==='mi'?1609.344:1852):-Infinity;
  let previous=null,line=[];
  for(const p of trail.points||[]){
    if(!validPoint(p)||p[0]<=after||p[1]<cutoff||p[4]<distanceCut){previous=null;line=[];continue;}
    if(!previous||p[5]!==previous[5]||Math.abs(p[3]-previous[3])>180){line=[];segments.push(line);}
    line.push([p[2],p[3]]);previous=p;
  }
  const key=JSON.stringify([trail.epoch,trail.revision,trail.latest,trail.points?.length??0,trail.points?.[0]?.[0],
    trail.points?.at(-1)?.[0],options,after,Math.floor(cutoff/1000)]);
  return {segments,label,message:notes.join(' · '),key};
}

/** History reads run in the background. Steady flight adds the one compact tail. */
export function createOwnTrailClient(request){
  let summary=null,points=[],cursor=0,pending=false,closed=false,retryAt=0,error='',version=0;
  let options=trailPreferences();
  function limits(){return [options.mode==='time'?Math.max(0,Math.floor((summary?.bootMs??0)-options.minutes*60000)):0,
    options.mode==='distance'?Math.max(0,Math.floor((summary?.tail?.[4]??0)-options.distance*(options.unit==='mi'?1609.344:1852))):0];}
  async function recover(){
    if(pending||closed||!options.enabled||!summary||cursor>=summary.latest||Date.now()<retryAt)return;
    pending=true;const token=version,epoch=summary.epoch,revision=summary.revision;
    try{
      const [boot,distance]=limits();
      const page=await request(`/cockpit/api/trail/${epoch}/${cursor}/${boot}/${distance}`);
      if(closed||token!==version)return;
      if(page.epoch!==epoch||page.revision!==revision)return;
      if(!Array.isArray(page.points)||page.points.length>1024||page.points.some(p=>!validPoint(p)))throw new Error('Invalid aircraft trail history');
      let last=cursor;
      for(const p of page.points){if(p[0]<=last||p[0]>summary.latest&&p[0]>page.latest)throw new Error('Out-of-order aircraft trail history');last=p[0];}
      if((page.next!==last&&!(page.points.length===0&&!page.more&&page.next===page.latest))||(!page.points.length&&page.more))throw new Error('Incomplete aircraft trail history');
      if(points.length+page.points.length>20000)throw new Error('Aircraft trail exceeds history limit');
      points=[...points,...page.points];cursor=page.next;error='';
    }catch(e){if(!closed&&token===version){error=e.message;retryAt=Date.now()+2000;}}
    finally{pending=false;}
  }
  return {
    configure(value){
      const next=trailPreferences(value),windowChanged=['mode','minutes','distance','unit'].some(k=>next[k]!==options[k]);
      if(windowChanged){version++;points=[];cursor=0;retryAt=0;error='';}
      options=next;
    },
    observe(next){
      if(closed)return;
      if(!next){if(summary){version++;summary=null;points=[];cursor=0;}return;}
      if(!/^[a-zA-Z0-9-]{1,64}$/.test(next.epoch)||!Number.isSafeInteger(next.latest)||next.latest<0||!Number.isSafeInteger(next.revision))return;
      if(summary?.epoch!==next.epoch||summary?.revision!==next.revision){version++;points=[];cursor=0;retryAt=0;error='';}
      summary=next;
      if(!pending&&next.tail&&validPoint(next.tail)&&next.tail[0]===cursor+1&&next.tail[0]===next.latest){points=[...points,next.tail];cursor=next.latest;}
      // A replacement epoch's first live point need not wait for retired history.
      else if(cursor===0&&next.latest===1&&validPoint(next.tail)){points=[next.tail];cursor=1;}
      const [boot,distance]=limits();points=points.filter(p=>p[1]>=boot&&p[4]>=distance);
      if(points.length>20000)points=points.slice(-20000);
      void recover();
    },
    view(){return summary?{...summary,points,loading:cursor<summary.latest,error}:null;},
    close(){closed=true;version++;points=[];summary=null;}
  };
}
