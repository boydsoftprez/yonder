<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
  <section class="y-presets" aria-label="Gimbal presets">
    <header><strong>Saved positions</strong><button v-if="activeSlot !== null" class="y-presets__stop" type="button" @click="$emit('stop')">Stop movement</button></header>
    <div class="y-presets__grid">
      <div v-for="slot in slots" :key="slot.number" class="y-presets__slot" :class="{'is-moving':activeSlot === slot.number}">
        <button type="button" class="y-presets__go" :title="slot.saved?.name" :aria-label="slot.saved ? `Go to ${slot.saved.name}` : `Save preset ${slot.number}`"
          :disabled="pending || !canMove || (!slot.saved && activeSlot !== null)" @click="slot.saved ? recall(slot) : edit(slot)">
          <span class="y-presets__number">{{ slot.number }}</span><span><b>{{ slot.saved?.name || `Preset ${slot.number}` }}</b><small>{{ slot.saved ? `${slot.saved.pan.toFixed(1)}° / ${slot.saved.tilt.toFixed(1)}°` : 'Empty · save current' }}</small></span>
        </button>
        <button v-if="slot.saved" type="button" class="y-presets__edit" :aria-label="`Edit preset ${slot.number}`" :disabled="pending || activeSlot !== null" @click="edit(slot)">⋯</button>
      </div>
    </div>
    <form v-if="editor !== null" class="y-presets__editor" @submit.prevent="submit('save')">
      <label>Preset {{ editor }} name<input v-model="name" aria-label="Preset name" maxlength="32" :disabled="pending" /></label>
      <div class="y-presets__buttons">
        <button type="submit" :disabled="pending || !canMove || activeSlot !== null || !name.trim()">Save current position</button>
        <button v-if="editingSaved" type="button" :disabled="pending || !name.trim()" @click="submit('rename')">Rename</button>
        <button v-if="editingSaved" type="button" :disabled="pending" @click="submit('delete')">Clear preset</button>
        <button type="button" :disabled="pending" @click="editor=null">Cancel</button>
      </div>
    </form>
    <p v-if="pending || error || message || movementMessage" class="y-presets__message" :class="{'is-error':!!error}" role="status">{{ pending ? 'Saving…' : error || message || movementMessage }}</p>
    <p class="y-presets__help">{{ !canMove ? moveReason : 'Relative to the handle · FPV mode. Preset moves use your speed setting, up to 60°/s.' }}</p>
  </section>
</template>
<script>
import { expireCameraSession } from './camera-session.ts'
export default {
  name:'YonderAimPresets',
  props:{presets:{type:Object,required:true},endpoint:{type:String,required:true},canMove:{type:Boolean,default:false},moveReason:{type:String,default:'Position feedback is unavailable.'},activeSlot:{type:Number,default:null},movementMessage:{type:String,default:''}},
  emits:['recall','stop'],
  data:()=>({editor:null,editorRevision:0,name:'',pending:false,error:'',message:'',local:null,readbackTimer:null,controller:null}),
  computed:{
    current(){return this.local && this.local.revision>this.presets.revision ? this.local : this.presets},
    slots(){return Array.from({length:6},(_,i)=>({number:i+1,saved:this.current.slots.find(p=>p.slot===i+1)}))},
    editingSaved(){return this.current.slots.some(p=>p.slot===this.editor)},
  },
  watch:{
    presets:{deep:true,handler(value){if(this.local && value.revision>=this.local.revision){this.local=null;clearTimeout(this.readbackTimer)}}},
    activeSlot(value){if(value!==null){this.editor=null;this.message='';this.error=''}},
  },
  beforeUnmount(){clearTimeout(this.readbackTimer);this.controller?.abort()},
  methods:{
    edit(slot){if(this.pending || this.activeSlot!==null)return;this.editor=slot.number;this.editorRevision=this.current.revision;this.name=slot.saved?.name || `Preset ${slot.number}`;this.message='';this.error=''},
    recall(slot){if(!this.canMove || this.pending || !slot.saved)return;this.message='';this.error='';this.editor=null;this.$emit('recall',{slot:slot.number,revision:this.current.revision})},
    async submit(op){
      if(this.pending || this.editor===null || (op==='save' && (!this.canMove || this.activeSlot!==null)))return;
      const name=this.name.trim();if(op!=='delete' && !name){this.error='Enter a preset name.';return}
      this.pending=true;this.error='';this.message='';this.controller=new AbortController();const timer=setTimeout(()=>this.controller?.abort(),10_000);
      try{
        const response=await fetch(this.endpoint,{method:'POST',credentials:'same-origin',cache:'no-store',signal:this.controller.signal,
          headers:{'Content-Type':'application/json','X-Yonder-Aim':'1'},body:JSON.stringify({op,slot:this.editor,revision:this.editorRevision,...(op==='delete'?{}:{name})})});
        if(response.status===401)expireCameraSession();const reply=await response.json();
        if(!response.ok || !reply.presets)throw new Error(reply.error || 'Preset change failed');
        this.local=reply.presets;clearTimeout(this.readbackTimer);this.readbackTimer=setTimeout(()=>{this.local=null},2500);
        this.message=op==='delete'?'Preset cleared.':op==='rename'?`Renamed to ${name}.`:`Saved ${name}.`;this.editor=null;
      }catch(error){this.error=error?.name==='AbortError'?'The save response was delayed. Check the preset list before retrying.':error instanceof Error?error.message:'Preset change failed'}
      finally{clearTimeout(timer);this.pending=false;this.controller=null}
    },
  },
}
</script>
<style scoped>
.y-presets{margin-top:14px;padding-top:12px;border-top:1px solid var(--yonder-divider,#2b333c);font-family:var(--yonder-font,system-ui,sans-serif)}
.y-presets header{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px;min-height:28px}
.y-presets header strong{font-size:12px;font-weight:600;color:var(--yonder-value,#ddd)}
.y-presets__grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}
.y-presets__slot{display:flex;min-width:0;border:1px solid var(--yonder-divider,#2b333c);border-radius:4px;background:var(--yonder-pane,#10151c)}
.y-presets__slot.is-moving{border-color:var(--yonder-select,#2ad4f0);background:color-mix(in srgb,var(--yonder-select,#2ad4f0) 12%,var(--yonder-pane,#10151c))}
.y-presets button{font:inherit;color:var(--yonder-value,#ddd);cursor:pointer;background:transparent}
.y-presets button:disabled{opacity:.48;cursor:default}
.y-presets button:focus-visible,.y-presets input:focus-visible{outline:2px solid var(--yonder-select,#2ad4f0);outline-offset:2px}
.y-presets__go{display:flex;align-items:center;gap:6px;text-align:left;padding:7px 6px;min-width:0;flex:1;border:0}
.y-presets__go>span:last-child{min-width:0}.y-presets__go b{display:block;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:500}
.y-presets__go small{display:block;font-size:9px;white-space:normal;overflow-wrap:anywhere;color:var(--yonder-label,#89939e);margin-top:3px;font-variant-numeric:tabular-nums}
.y-presets__number{font-size:10px;color:var(--yonder-select,#2ad4f0)}
.y-presets__edit{border:0;border-left:1px solid var(--yonder-divider,#2b333c);padding:0 6px;font-size:18px!important}
.y-presets__stop,.y-presets__buttons button{border:1px solid var(--yonder-divider,#2b333c);border-radius:3px;padding:5px 7px;font-size:11px!important}
.y-presets__stop{border-color:var(--yonder-bad,#ff4034);color:var(--yonder-bad,#ff4034)!important}
.y-presets__editor{margin-top:10px;padding:9px;border:1px solid var(--yonder-select,#2ad4f0);border-radius:4px}
.y-presets__editor label{font-size:11px;color:var(--yonder-label,#89939e)}
.y-presets__editor input{box-sizing:border-box;display:block;margin-top:5px;padding:6px;width:100%;background:var(--yonder-display,#04060a);color:var(--yonder-value,#ddd);border:1px solid var(--yonder-divider,#2b333c);font:inherit}
.y-presets__buttons{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}.y-presets__buttons button[type=submit]{border-color:var(--yonder-select,#2ad4f0)}
.y-presets__message,.y-presets__help{font-size:10px;line-height:1.45;margin:8px 0 0;color:var(--yonder-label,#89939e)}
.y-presets__message{color:var(--yonder-value,#ddd)}.y-presets__message.is-error{color:var(--yonder-bad,#ff4034)}
</style>
