<!-- The picture, with the drag-to-slew layer from aim-and-bitrate.html
     option A. Drag sets a rate; release stops. The green rectangle stands in
     for video until this is wired to a real one. -->
<template>
  <div class="d-vid" :class="{ aimable }"
       @pointerdown="down" @pointermove="move"
       @pointerup="up" @pointercancel="up" @pointerleave="up">
    <div class="d-sky" /><div class="d-gnd" />
    <div v-if="recording" class="d-rec"><i />REC 00:13:47</div>
    <div v-if="flashing" class="d-flash" />
    <div v-if="flashing" class="d-saved"><i />Saved &middot; to {{ savedTo }}</div>
    <!-- what this picture is, right now. On the picture and not in the strip,
         because in Cockpit the picture is there and the deck is not. -->
    <div v-if="preview" class="d-state" :class="'tone-' + preview.tone" :style="{ top: recording ? '48px' : '10px' }">
      <b>{{ preview.head }}</b>
      <span>{{ preview.size }}<template v-if="preview.rate"> · {{ preview.rate }} fps</template> · {{ preview.mbps.toFixed(preview.mbps < 0.1 ? 3 : 1) }} Mb/s</span>
      <em v-if="preview.detail">{{ preview.detail }}</em>
    </div>
    <div v-if="preview && preview.step" class="d-step">{{ preview.step }}</div>

    <svg v-if="aimable" class="d-hud" viewBox="0 0 940 300" preserveAspectRatio="none">
      <!-- the orb, and only the orb: where you are pushing, how hard -->
      <template v-if="pushing">
        <circle :cx="hx" :cy="hy" :r="14 + 10 * k" fill="#2ad4f0" fill-opacity=".18" stroke="#2ad4f0" stroke-width="2"/>
        <circle :cx="hx" :cy="hy" r="4.5" fill="#2ad4f0"/>
      </template>
    </svg>

    <div v-if="aimable && pushing" class="d-osd tr">
      <span class="k">SLEW</span>{{ fmt(slewPan) }} &deg;/s<br>
      <span class="k">TILT</span>{{ fmt(slewTilt) }} &deg;/s
    </div>
    <div v-else class="d-osd tr">
      <span class="k">LINK</span>3.10 Mb/s<br><span class="k">DROP</span>0.0 %
    </div>

    <div class="d-osd bl">
      <template v-if="aimable">
        <span class="k">PAN</span>{{ fmt(pan, 1) }}&deg;<span class="k sp">TILT</span>{{ fmt(tilt, 1) }}&deg;
      </template>
      <span class="k" :class="{ sp: aimable }">ZOOM</span>{{ zoomText }}
      <span v-if="expLabel" class="k sp">{{ expLabel }}</span>{{ expValue }}
    </div>

    <div v-if="aimable" class="d-hint">Drag to slew &middot; release to stop</div>
    <div v-else class="d-note">live picture</div>
  </div>
</template>
<script>
const MAX_RATE = 30;
export default {
  name: 'DraftPicture',
  props: {
    /** The camera's own fact, already formatted — device steps with no
        unit, or a calibrated "2.0×" — decided once by the deck from the
        report, never a ratio this picture invents for itself (R-CTL-14). */
    zoomText: { type: String, default: '' },
    expLabel: { type: String, default: '' }, expValue: { type: String, default: '' },
    pan: { type: Number, default: 0 }, tilt: { type: Number, default: 0 },
    slewPan: { type: Number, default: 0 }, slewTilt: { type: Number, default: 0 },
    aimable: { type: Boolean, default: false },
    recording: { type: Boolean, default: false },
    /** A timestamp: a new value is a photo just taken (camera-view/stills-
        and-snapshot.html's white flash — "a deliberate confirmation that
        something happened at the moment you pressed", R-UI-05). */
    flash: { type: Number, default: 0 },
    savedTo: { type: String, default: '' },
    preview: { type: Object, default: null }
  },
  emits: ['slew', 'stop'],
  data: () => ({ pushing: false, hx: 470, hy: 150, k: 0, ox: 470, oy: 150, flashing: false }),
  watch: {
    flash (v) {
      if (!v) return
      this.flashing = true
      clearTimeout(this._flashTimer)
      this._flashTimer = setTimeout(() => { this.flashing = false }, 1200)
    }
  },
  beforeUnmount () { clearTimeout(this._flashTimer) },
  methods: {
    fmt (v, p = 0) { return (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(p) },
    at (e) {
      const r = this.$el.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * 940;
      const y = ((e.clientY - r.top) / r.height) * 300;
      // Rate is measured from where the finger went down, not from the
      // centre of the frame: a thumb starts wherever it lands.
      const dx = x - this.ox, dy = y - this.oy;
      const d = Math.hypot(dx, dy);
      if (d < 12) return { x, y, pan: 0, tilt: 0, k: 0 };
      const k = Math.min(1, (d - 12) / 160);
      return { x, y, k, pan: (dx / d) * k * MAX_RATE, tilt: -(dy / d) * k * MAX_RATE };
    },
    down (e) {
      if (!this.aimable) return;
      this.$el.setPointerCapture?.(e.pointerId);
      const r = this.$el.getBoundingClientRect();
      this.ox = ((e.clientX - r.left) / r.width) * 940;
      this.oy = ((e.clientY - r.top) / r.height) * 300;
      this.pushing = true; this.apply(e);
    },
    move (e) { if (this.pushing) this.apply(e); },
    apply (e) {
      const a = this.at(e);
      this.hx = a.x; this.hy = a.y; this.k = a.k;
      if (a.k === 0) { this.$emit('stop'); return; }
      this.$emit('slew', { pan: a.pan, tilt: a.tilt });
    },
    up () {
      if (!this.pushing) return;
      this.pushing = false; this.k = 0;
      this.$emit('stop');
    }
  }
}
</script>
<style scoped>
.d-vid { position:relative; aspect-ratio: 16 / 9; max-height: 380px; margin: 0 auto;
  overflow:hidden; background: var(--yonder-display,#04060a); }
.d-vid.aimable { cursor:crosshair; touch-action:none; }
.d-sky { position:absolute; inset:0 0 62% 0; background:linear-gradient(#8fb4d0,#a8c3d6); }
.d-gnd { position:absolute; inset:38% 0 0 0; background:linear-gradient(#8a9a55,#7d8a4e); }
.d-rec { position:absolute; z-index:6; left:10px; top:10px; display:flex; align-items:center; gap:7px;
  font-size:11px; letter-spacing:.06em; padding:5px 10px; border-radius:2px;
  background:rgba(4,6,10,.78); border:1px solid var(--yonder-bad,#ff4034);
  color: var(--yonder-bad,#ff4034); pointer-events:none; }
.d-rec i { width:7px; height:7px; border-radius:50%; background: var(--yonder-bad,#ff4034); }
.d-flash { position:absolute; inset:0; z-index:7; background:#fff; opacity:.55; pointer-events:none; }
.d-saved { position:absolute; z-index:8; left:50%; top:50%; transform:translate(-50%,-50%);
  display:flex; align-items:center; gap:7px; font-size:12px; letter-spacing:.08em; text-transform:uppercase;
  padding:7px 13px; border-radius:2px; background:rgba(4,6,10,.82); border:1px solid var(--yonder-select,#2ad4f0);
  color: var(--yonder-select,#2ad4f0); pointer-events:none; white-space:nowrap; }
.d-saved i { width:6px; height:6px; border-radius:50%; background: var(--yonder-select,#2ad4f0); }
.d-state { position:absolute; z-index:6; left:10px; display:flex; flex-direction:column; gap:2px;
  padding:7px 10px; border-radius:2px; background:rgba(4,6,10,.8); border:1px solid rgba(255,255,255,.12);
  font-size:11.5px; font-variant-numeric:tabular-nums; color:#fff; pointer-events:none; max-width:360px; }
.d-state b { font-size:10px; letter-spacing:.14em; }
.d-state em { font-style:normal; font-size:10.5px; color:rgba(255,255,255,.62); }
.d-state.tone-waiting { border-color: var(--yonder-waiting,#ffcf28); } .d-state.tone-waiting b { color: var(--yonder-waiting,#ffcf28); }
.d-state.tone-bad { border-color: var(--yonder-bad,#ff4034); } .d-state.tone-bad b { color: var(--yonder-bad,#ff4034); }
.d-state.tone-select { border-color: var(--yonder-select,#2ad4f0); } .d-state.tone-select b { color: var(--yonder-select,#2ad4f0); }
.d-state.tone-label b { color:rgba(255,255,255,.7); }
/* the brief line when it steps */
.d-step { position:absolute; z-index:6; right:10px; top:10px; padding:6px 12px;
  border-radius:2px; font-size:11.5px; color:#fff; background:rgba(4,6,10,.82);
  border:1px solid var(--yonder-waiting,#ffcf28); pointer-events:none; white-space:nowrap; }
.d-hud { position:absolute; inset:0; width:100%; height:100%; pointer-events:none; }
.d-osd { position:absolute; z-index:5; background:rgba(4,6,10,.78); border:1px solid rgba(255,255,255,.12);
  border-radius:2px; padding:7px 10px; font-size:12.5px; font-variant-numeric:tabular-nums;
  color:#fff; pointer-events:none; }
.d-osd.tr { bottom:10px; right:10px; } .d-osd.bl { left:10px; bottom:10px; }
.d-osd .k { font-size:10px; letter-spacing:.12em; color:rgba(255,255,255,.55); margin-right:6px; }
.d-osd .k.sp { margin-left:14px; }
.d-hint, .d-note { position:absolute; z-index:5; left:50%; transform:translateX(-50%);
  font-size:10px; letter-spacing:.12em; text-transform:uppercase; pointer-events:none; }
.d-hint { bottom:52px; color:#fff; background:rgba(4,6,10,.72); padding:5px 11px; border-radius:2px;
  border:1px solid rgba(255,255,255,.12); }
.d-note { top:50%; transform:translate(-50%,-50%); color:rgba(255,255,255,.6); }
</style>
