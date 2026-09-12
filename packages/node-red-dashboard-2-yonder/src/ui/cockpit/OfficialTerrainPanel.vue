<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
<section class="official-terrain" aria-label="Official controller terrain">
  <header class="official-terrain__header"><div><small>OFFICIAL CONTROLLER TERRAIN</small><h3>Prepare terrain service coverage</h3></div><button type="button" :disabled="busy" @click="refresh">Refresh status</button></header>
  <div class="official-terrain__facts" aria-label="Terrain status">
    <article :data-tone="view.coverage.tone"><small>YONDER COVERAGE</small><strong>{{view.coverage.label}}</strong></article>
    <article :data-tone="view.service.tone"><small>SERVICE</small><strong>{{view.service.label}}</strong></article>
    <article :data-tone="view.controller.tone"><small>CONTROLLER</small><strong>{{view.controller.label}}</strong></article>
  </div>
  <p v-if="error" class="official-terrain__error" role="alert">{{error}}</p>
  <p v-if="statusError&&!status" class="official-terrain__error" role="status">Terrain service status unavailable: {{statusError}}</p>
  <fieldset v-if="status&&!policy.enabled" class="official-terrain__disabled">
    <legend>Service disabled</legend>
    <p>Official terrain serving is disabled by default. Review the service enable setting and storage quota below before applying the terrain-only configuration change.</p>
  </fieldset>
  <fieldset class="official-terrain__policy">
    <legend>Service policy</legend>
    <label><span>Enable official terrain service<small>Default is disabled. Serving continues on Yonder after this browser closes.</small></span><input v-model="policyDraft.enabled" type="checkbox" aria-label="Enable official terrain service"></label>
    <label>Persistent storage quota <span><input v-model.number="policyDraft.quotaMiB" type="number" min="128" max="32768" step="128" aria-label="Official terrain quota MiB"> MiB</span></label>
    <button type="button" :disabled="busy||!policyRecord" @click="reviewPolicy">Review policy change</button>
    <article v-if="policyReview" class="official-terrain__policy-review" aria-label="Review terrain policy change">
      <strong>Review before apply</strong>
      <p>Service: {{policyRecord.policy.enabled?'enabled':'disabled'}} → {{policyReview.enabled?'enabled':'disabled'}}<br>Quota: {{policyRecord.policy.quotaMiB}} MiB → {{policyReview.quotaMiB}} MiB<br>Provider: Official ArduPilot ALOS-derived SRTM1</p>
      <div class="cockpit-actions"><button type="button" @click="policyReview=null">Cancel review</button><button type="button" class="official-terrain__primary" :disabled="busy" @click="applyPolicy">Apply reviewed policy</button></div>
    </article>
    <article v-if="pendingPolicyId" class="official-terrain__policy-review" aria-label="Confirm terrain policy change">
      <strong>Policy change awaiting confirmation</strong><p>The previous configuration returns unless this reviewed change is confirmed<span v-if="pendingPolicyExpiry"> by {{new Date(pendingPolicyExpiry).toLocaleTimeString()}}</span>.</p>
      <div class="cockpit-actions"><button type="button" :disabled="busy" @click="revertPolicy">Revert now</button><button type="button" class="official-terrain__primary" :disabled="busy" @click="confirmPolicy">Confirm and keep</button></div>
    </article>
  </fieldset>
  <dl v-if="status" class="official-terrain__source">
    <div><dt>Source</dt><dd>{{status.source?.dataset||'Official terrain source unavailable'}} · {{status.source?.spacingM??'—'}} m · {{status.source?.datum||'unknown datum'}}</dd></div>
    <div><dt>Storage</dt><dd>{{storage.label}}<small>{{storage.detail}}</small></dd></div>
    <div><dt>Responder ownership</dt><dd>{{ownership}}</dd></div>
  </dl>
  <p>Preparation and serving run on Yonder. Closing this browser does not stop the terrain service.</p>

  <fieldset class="official-terrain__prepare">
    <legend>Area preview</legend>
    <div class="official-terrain__choice" role="group" aria-label="Coverage kind"><button type="button" :aria-pressed="kind==='manual'" @click="kind='manual'">Current map area</button><button type="button" :aria-pressed="kind==='mission'" :disabled="!missionAvailable" @click="kind='mission'">Current aircraft mission</button></div>
    <label>Area name<input v-model.trim="name" maxlength="80" aria-label="Official terrain area name"></label>
    <label>Buffer <span><input v-model.number="bufferM" type="number" :min="limits.bufferMinM" :max="limits.bufferMaxM" step="50" aria-label="Official terrain buffer metres"> m</span></label>
    <label class="official-terrain__refresh"><span>Refresh source tiles<small>Explicitly downloads the source again using the onboard internet connection.</small></span><input v-model="refreshSource" type="checkbox" aria-label="Refresh source tiles"></label>
    <template v-if="kind==='manual'">
      <button type="button" @click="$emit('request-map-bounds')">Use current map view</button>
      <div class="official-terrain__bounds">
        <label v-for="side in ['north','south','west','east']" :key="side">{{side}}<input v-model.number="bounds[side]" type="number" min="-180" max="180" step="0.00001" :aria-label="`Manual terrain ${side} bound`"></label>
      </div>
      <p>Bounds remain editable after copying the map viewport. A west value above east selects across the antimeridian.</p>
    </template>
    <p v-else>Yonder derives route, home and rally coverage from aircraft mission revision <b>{{missionRevision||'unknown'}}</b>. The browser does not submit mission geometry.</p>
    <div class="cockpit-actions"><button type="button" :disabled="busy||!policy.enabled" @click="createPreview">Preview area</button><button type="button" class="official-terrain__primary" :disabled="busy||!previewIsCurrent||!status?.preparationAllowed" @click="prepare">Prepare {{previewIsCurrent?preview?.coverage?.tiles?.length||0:0}} tiles</button><button v-if="activeJob&&['preparing','paused'].includes(activeJob.state)" type="button" :disabled="busy" @click="cancel">Cancel preparation</button></div>
    <p v-if="status&&policy.enabled&&!status.preparationAllowed" role="status">Preparation is unavailable while the aircraft is armed, its context is stale, or service prerequisites are missing.</p>
  </fieldset>

  <article v-if="displayCoverage" class="official-terrain__preview" aria-label="Official terrain coverage preview">
    <header><strong>{{displayCoverageName}}</strong><span>{{displayTileCount}} tiles<span v-if="Number.isFinite(displayCoverage.estimatedBytes)"> · {{formatBytes(displayCoverage.estimatedBytes)}}</span></span></header>
    <svg viewBox="0 0 360 150" role="img" aria-label="Server calculated terrain coverage geometry">
      <rect x="1" y="1" width="358" height="148" class="preview-frame"/>
      <rect v-for="(rect,index) in svg.rectangles" :key="'r'+index" v-bind="rect" class="preview-area"/>
      <polyline v-for="(line,index) in svg.polylines" :key="'p'+index" :points="line.points" :class="['preview-route',line.kind]"/>
    </svg>
    <p :data-tone="displayCoverageComplete?'good':'warning'">{{displayCoverageComplete?'Coverage geometry is complete.':'Coverage geometry is partial.'}} <span v-if="displayCoverageReasons.length">{{displayCoverageReasons.join(' · ')}}</span></p>
    <p>Revision {{displayCoverageRevision}}<template v-if="preview"> · expires {{new Date(preview.expiresAt).toLocaleTimeString()}}</template><template v-else> · saved on Yonder</template></p>
  </article>

  <section class="official-terrain__areas" aria-label="Prepared terrain areas"><h4>Prepared areas</h4>
    <p v-if="!areas.length">No prepared areas.</p>
    <article v-for="area in areas" :key="area.id" :data-stale="area.stale||undefined">
      <div><strong>{{area.name}}</strong><small>{{area.complete?'Complete':'Partial'}}{{area.stale?' · stale revision':''}} · {{area.objects?.length??area.objects??0}} tiles<span v-if="area.reasons?.length"> · {{area.reasons.join(' · ')}}</span></small></div>
      <div class="cockpit-actions"><button v-if="area.coverage?.geometry" type="button" @click="selectedArea=area">Show coverage</button><button type="button" :disabled="busy" @click="pin(area)">{{area.pinned?'Unpin':'Pin'}}</button><button type="button" :disabled="busy" @click="remove(area)">Delete</button></div>
    </article>
  </section>
  <section class="official-terrain__controller"><h4>Controller cache report</h4>
    <p>{{controllerDetail}}</p><p>Blocks sent by Yonder are requests answered, not proof that the controller loaded them. Pending zero does not mean a whole mission is resident.</p>
    <button type="button" :disabled="busy||!vehicleGeneration" @click="refreshController">Refresh controller terrain</button>
    <p v-if="status?.controllerRefresh?.state&&status.controllerRefresh.state!=='idle'">Refresh {{status.controllerRefresh.state}}{{status.controllerRefresh.reason?' · '+status.controllerRefresh.reason:''}}</p>
  </section>
  <p class="official-terrain__ownership">{{ownership}} Direct routing bypass visibility is {{status?.service?.providerOwnership?.directRouteVisibility||'unverified'}}.</p>
</section>
</template>

<script setup>
import {computed,onBeforeUnmount,onMounted,reactive,ref,watch} from 'vue';
import {defaultOfficialTerrainBounds,formatTerrainBytes,previewSvgGeometry,terrainStatusView,terrainStorageView,validateManualBounds} from './official-terrain-state.mjs';
const props=defineProps({status:Object,statusError:String,preview:Object,client:{type:Object,required:true},mapBounds:Object,missionAvailable:Boolean,missionRevision:String,vehicleGeneration:String});
const emit=defineEmits(['status','preview','request-map-bounds']);
const kind=ref('manual'),name=ref('Flight area'),bufferM=ref(1000),refreshSource=ref(false),busy=ref(false),error=ref('');
const bounds=reactive({...defaultOfficialTerrainBounds});
const policyRecord=ref(null),policyReview=ref(null),policyResult=ref(null),policyDraft=reactive({enabled:false,quotaMiB:2048});
let policyExpiryTimer=null;
watch(()=>props.mapBounds,value=>{if(value)Object.assign(bounds,value)},{deep:true,immediate:true});
const previewInputVersion=ref(0),previewAcceptedVersion=ref(0);
const previewIsCurrent=computed(()=>!!props.preview&&previewAcceptedVersion.value===previewInputVersion.value);
watch([kind,name,bufferM,refreshSource,()=>bounds.north,()=>bounds.south,()=>bounds.west,()=>bounds.east],()=>{previewInputVersion.value++;selectedArea.value=null;emit('preview',null)});
const selectedArea=ref(null);watch(()=>props.preview,value=>{if(value)selectedArea.value=null});
const policy=computed(()=>props.status?.policy||props.status?.sourcePolicy||{enabled:false});
const limits=computed(()=>props.status?.limits||{bufferMinM:50,bufferMaxM:10000});
const view=computed(()=>terrainStatusView(props.status));
const storage=computed(()=>terrainStorageView(props.status));
const areas=computed(()=>props.status?.coverage?.areas||props.status?.storage?.areas||[]);
const activeJob=computed(()=>props.status?.coverage?.job||null);
const displayCoverage=computed(()=>props.preview?.coverage||selectedArea.value?.coverage||null);
const displayCoverageName=computed(()=>props.preview?.coverage?.name||selectedArea.value?.name||'Prepared area');
const displayTileCount=computed(()=>props.preview?.coverage?.tiles?.length??selectedArea.value?.objects?.length??selectedArea.value?.objects??0);
const displayCoverageComplete=computed(()=>props.preview?.coverage?.complete??selectedArea.value?.complete??false);
const displayCoverageReasons=computed(()=>props.preview?.coverage?.reasons||selectedArea.value?.reasons||[]);
const displayCoverageRevision=computed(()=>String(props.preview?.coverage?.revision||selectedArea.value?.revision||'unknown').slice(0,12));
const svg=computed(()=>previewSvgGeometry(displayCoverage.value?.geometry));
const ownership=computed(()=>props.status?.service?.providerOwnership?.exclusivityEnforced===true?'Yonder responder exclusivity is enforced.':'Operator-managed single responder; exclusivity is not enforced.');
const pendingPolicyId=computed(()=>policyResult.value?.expiresAt!=null?policyResult.value.id:policyRecord.value?.pendingId||null);
const pendingPolicyExpiry=computed(()=>policyResult.value?.expiresAt??policyRecord.value?.apply?.expiresAt??null);
const controllerDetail=computed(()=>{const s=props.status?.service,c=s?.controller?.report;if(!c)return 'Waiting for a controller terrain report.';return `${s.controller.fresh?'Fresh':'Stale'} report · ${c.pending??'—'} pending · ${c.loaded??'—'} loaded · ${c.spacing??'—'} m spacing · ${s.sent??0} blocks sent by Yonder`;});
const formatBytes=formatTerrainBytes;
async function run(action,refreshAfter=true){if(busy.value)return;busy.value=true;error.value='';try{const value=await action();if(refreshAfter)try{emit('status',await props.client.status())}catch{}return value}catch(cause){error.value=cause?.message||'Terrain service action failed'}finally{busy.value=false}}
async function loadPolicy(){const value=await props.client.policy();policyRecord.value=value;if(policyResult.value&&value.pendingId!==policyResult.value.id)policyResult.value=null;policyDraft.enabled=value.policy.enabled;policyDraft.quotaMiB=value.policy.quotaMiB;return value}
async function refresh(){const value=await run(async()=>{const status=await props.client.status();await loadPolicy();return status},false);if(value)emit('status',value)}
function reviewPolicy(){error.value='';const quotaMiB=Number(policyDraft.quotaMiB);if(!Number.isInteger(quotaMiB)||quotaMiB<128||quotaMiB>32768){error.value='Storage quota must be a whole number from 128 to 32,768 MiB';return}policyReview.value={enabled:policyDraft.enabled===true,provider:'ardupilot-srtm1',quotaMiB}}
function schedulePolicyExpiry(result){clearTimeout(policyExpiryTimer);if(Number.isFinite(result?.expiresAt))policyExpiryTimer=setTimeout(()=>loadPolicy().catch(()=>{}),Math.max(0,result.expiresAt-Date.now()+250))}
async function applyPolicy(){const reviewed=policyReview.value;if(!reviewed||!policyRecord.value)return;const result=await run(()=>props.client.applyPolicy(reviewed,policyRecord.value.revision));if(result){policyResult.value=result;policyReview.value=null;schedulePolicyExpiry(result)}try{await loadPolicy()}catch{}}
async function confirmPolicy(){const id=pendingPolicyId.value;if(!id)return;const result=await run(()=>props.client.confirmPolicy(id));if(result){policyResult.value=null;await loadPolicy()}}
async function revertPolicy(){const id=pendingPolicyId.value;if(!id)return;const result=await run(()=>props.client.revertPolicy(id));if(result){policyResult.value=null;policyReview.value=null;await loadPolicy()}}
async function createPreview(){const version=previewInputVersion.value;previewAcceptedVersion.value=-1;emit('preview',null);await run(async()=>{const common={kind:kind.value,name:name.value||'Flight area',bufferM:Number(bufferM.value),refreshSource:refreshSource.value};const input=kind.value==='manual'?{...common,bounds:validateManualBounds(bounds)}:common;const value=await props.client.preview(input);if(version===previewInputVersion.value){previewAcceptedVersion.value=version;emit('preview',value)}return value})}
async function prepare(){if(!previewIsCurrent.value)return;await run(()=>props.client.prepare(props.preview.id))}
async function cancel(){await run(()=>props.client.cancel(activeJob.value.id))}
async function pin(area){await run(()=>props.client.pin(area.id,!area.pinned))}
async function remove(area){await run(()=>props.client.remove(area.id))}
async function refreshController(){await run(()=>props.client.refreshController(props.vehicleGeneration))}
onMounted(()=>{loadPolicy().catch(cause=>{error.value=cause?.message||'Terrain policy is unavailable'})});
onBeforeUnmount(()=>clearTimeout(policyExpiryTimer));
</script>

<style scoped>
.official-terrain{display:grid;gap:14px;margin:18px 0;padding:14px;border:1px solid var(--cockpit-line);background:color-mix(in srgb,var(--cockpit-pane) 80%,transparent)}
.official-terrain__header,.official-terrain__preview header,.official-terrain__areas article{display:flex;align-items:center;justify-content:space-between;gap:12px}.official-terrain h3,.official-terrain h4{margin:2px 0}.official-terrain__header small,.official-terrain article small,.official-terrain dd small{display:block;color:var(--cockpit-muted)}.official-terrain__policy label small{display:block;margin-top:4px;color:var(--cockpit-muted)}
.official-terrain__facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.official-terrain__facts article{min-height:76px;padding:10px;border:1px solid var(--cockpit-line);border-left:4px solid #77909b}.official-terrain [data-tone=good]{border-color:#58c98b}.official-terrain [data-tone=warning]{border-color:#e5b450}.official-terrain [data-tone=danger]{border-color:#ed776c}.official-terrain [data-tone=active]{border-color:#41c5e5}
.official-terrain__policy-review{margin-top:12px;padding:12px;border:1px solid #e5b450;background:var(--cockpit-pane)}
.official-terrain__source>div{display:grid;grid-template-columns:140px 1fr}.official-terrain .official-terrain__source dt{color:var(--cockpit-muted)}.official-terrain__source dd{text-align:right}.official-terrain fieldset{border:1px solid var(--cockpit-line);padding:12px}.official-terrain legend{padding:0 6px;font-weight:700}.official-terrain input:not([type=checkbox]){max-width:240px;background:var(--cockpit-pane);color:inherit;border:1px solid var(--cockpit-line);border-radius:3px;padding:10px}.official-terrain__choice{display:grid;grid-template-columns:1fr 1fr;gap:8px}.official-terrain__choice button[aria-pressed=true]{border-color:#6adeff;box-shadow:inset 0 -3px #168aa3}.official-terrain__bounds{display:grid;grid-template-columns:1fr 1fr;gap:0 12px}.official-terrain__bounds label{display:grid!important;grid-template-columns:55px 1fr}.official-terrain__refresh span small{display:block;color:var(--cockpit-muted);max-width:420px}.official-terrain__primary{border-color:#6adeff!important}.official-terrain__preview{padding:12px;border:1px solid var(--cockpit-line)}.official-terrain__preview svg{width:100%;height:auto;max-height:210px;background:var(--cockpit-pane)}.preview-frame{fill:none;stroke:var(--cockpit-line)}.preview-area{fill:#41c5e522;stroke:#168aa3;stroke-width:1}.preview-route{fill:none;stroke:#b734a3;stroke-width:2}.return-corridor{stroke-dasharray:5 4}.loiter-extent{stroke:#a66b00;stroke-width:4}.official-terrain__areas article{padding:10px 0;border-top:1px solid #52677066}.official-terrain__areas article[data-stale]{border-left:3px solid #e5b450;padding-left:9px}.official-terrain__error{padding:10px;border-left:4px solid #ed776c;background:#6b211f55}.official-terrain__ownership{padding:10px;border:1px solid #e5b450;color:inherit!important}
@media(max-width:720px){.official-terrain__facts{grid-template-columns:1fr}.official-terrain__bounds{grid-template-columns:1fr}.official-terrain__header,.official-terrain__preview header,.official-terrain__areas article{align-items:stretch;flex-direction:column}.official-terrain__source>div{grid-template-columns:1fr}.official-terrain__source dd{text-align:left}}
</style>
