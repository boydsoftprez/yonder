<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
  <div class="cockpit-course-strip">
    <div class="cockpit-course-bearing"><small>{{guidance.radialValid?'LOITER CENTER':'NAV BEARING'}}</small><b>{{angle}}</b></div>
    <div class="cockpit-deviation">
      <svg class="lateral-deviation-display" viewBox="0 0 200 46" role="img" :aria-label="guidance.radialValid?'Loiter radial deviation':'Lateral course deviation'">
        <g fill="none" stroke="currentColor" stroke-width="1.5"><circle v-for="x in [14,57,143,186]" :key="x" :cx="x" cy="25" r="2.7" /></g>
        <path class="cdi-center-reference" d="M94 2 H106 L100 12 Z" fill="currentColor" />
        <g v-if="guidance.radialValid" fill="#efb9ed" font-size="9"><text x="14" y="11">OUT</text><text x="186" y="11" text-anchor="end">IN</text></g>
        <path v-if="deflection!==null" class="cdi-moving-bar" :transform="'translate('+needle+' 0)'" d="M-1.8 14 H1.8 V36 H-1.8 Z" fill="#f477ee" />
      </svg>
      <small>{{deflection!==null?(guidance.radialValid?'LOITER RADIAL':'LATERAL DEVIATION')+' · '+scale+' m FULL SCALE':guidance.reason||'Guidance unavailable'}}</small>
    </div>
  </div>
</template>
<script>
import {cdiDeflection} from './navigation-view.mjs';
export default {
  props: {guidance: {type:Object,required:true},scale:{type:Number,required:true}},
  computed: {
    deflection(){return cdiDeflection(this.guidance,this.scale)},
    needle(){return 100+(this.deflection??0)*86},
    angle(){const n=this.guidance.radialValid?this.guidance.pathBearingDeg:this.guidance.desiredTrackDeg;return this.guidance.valid&&Number.isFinite(n)?Math.round(n).toString().padStart(3,'0')+'°':'—'}
  }
};
</script>
