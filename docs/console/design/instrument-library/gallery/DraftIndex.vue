<!-- The Cameras page. Not a table: a table gives every column equal weight,
     and here one column is a camera and one is why a device was refused. -->
<template>
  <div class="d-panel">
    <div class="d-placard">
      <span><b>Cameras</b></span>
      <span>{{ cameras.length }} found &middot; {{ rejected.length }} rejected &middot; detected 14:22:06</span>
    </div>
    <div class="d-display">
      <div class="d-grp"><span>Flying</span></div>

      <button v-for="c in cameras" :key="c.id" type="button" class="d-cam"
              @click="$emit('open', c.id)">
        <span class="th" :class="c.thumb" />
        <span class="nm"><b>{{ c.name }}</b><span>{{ c.bus }}</span></span>
        <span class="sp">
          <span class="a">{{ c.spec }} <em>{{ c.encoder }}</em></span>
          <span class="b">{{ c.probe }}</span>
        </span>
        <span class="st">
          <span class="ann" :class="c.tone"><i />{{ c.state }}</span>
          <span v-if="c.rate" class="rate">{{ c.rate }}<em>Mb/s</em></span>
        </span>
        <span class="go">&rsaquo;</span>
      </button>

      <div class="d-grp"><span>Seen, and not usable</span><em>why</em></div>
      <div v-for="r in rejected" :key="r.device" class="d-rej">
        <span class="dev">{{ r.device }}</span>
        <span class="why">{{ r.why }}<em v-if="r.note">{{ r.note }}</em></span>
      </div>
    </div>
  </div>
</template>
<script>
export default {
  name: 'DraftIndex',
  props: { cameras: { type: Array, default: () => [] }, rejected: { type: Array, default: () => [] } },
  emits: ['open']
}
</script>
<style scoped>
.d-grp { display:flex; justify-content:space-between; padding:13px 15px 9px;
  font-size:9.5px; letter-spacing:.16em; text-transform:uppercase;
  color: var(--yonder-label,#7f8a95); border-top:1px solid var(--yonder-divider,#2b333c); }
.d-grp:first-child { border-top:0; }
.d-grp em { font-style:normal; }
.d-cam { display:grid; grid-template-columns: 74px 150px 1fr 168px 22px; gap:16px; align-items:center;
  width:100%; padding:11px 15px; background:transparent; border:0; text-align:left; cursor:pointer;
  border-top:1px solid color-mix(in srgb, var(--yonder-divider,#2b333c) 55%, transparent);
  color: var(--yonder-value,#fff); font: inherit; }
.d-cam:hover { background: color-mix(in srgb, var(--yonder-value,#fff) 3%, transparent); }
.th { height:42px; border-radius:2px; background:linear-gradient(#8fb4d0 0 38%, #7d8a4e 38% 100%); }
.th.down { background:linear-gradient(#6f7c46, #58643a); }
.th.tele { background:linear-gradient(#9dbdd6 0 30%, #8b9a5e 30% 100%); }
.nm { display:flex; flex-direction:column; gap:3px; }
.nm b { font-size:13.5px; font-weight:600; }
.nm span { font-size:9.5px; letter-spacing:.11em; text-transform:uppercase;
  color: var(--yonder-label,#7f8a95); }
.sp { display:flex; flex-direction:column; gap:4px; min-width:0; }
.sp .a { font-size:12px; }
.sp .a em { font-style:normal; color: var(--yonder-label,#7f8a95); }
.sp .b { font-size:10.5px; font-family: var(--yonder-font-mono, ui-monospace, monospace);
  color: var(--yonder-label,#7f8a95); }
.st { display:flex; flex-direction:column; gap:5px; align-items:flex-start; }
.ann { display:inline-flex; align-items:center; gap:6px; font-size:9.5px; letter-spacing:.13em;
  text-transform:uppercase; padding:3px 8px; border-radius:2px;
  border:1px solid var(--yonder-good,#35d06a); color: var(--yonder-good,#35d06a); }
.ann i { width:5px; height:5px; border-radius:50%; background:currentColor; }
.ann.idle { border-color: var(--yonder-label,#7f8a95); color: var(--yonder-label,#7f8a95); }
.rate { font-size:12.5px; font-weight:600; font-variant-numeric:tabular-nums; }
/* A token carrying a unit is never uppercased. */
.rate em { font-style:normal; font-weight:400; font-size:10px; text-transform:none;
  margin-left:4px; color: var(--yonder-label,#7f8a95); }
.go { font-size:19px; color: var(--yonder-label,#7f8a95); text-align:right; }
.d-rej { display:grid; grid-template-columns: 152px 1fr; gap:16px; padding:10px 15px;
  border-top:1px solid color-mix(in srgb, var(--yonder-divider,#2b333c) 55%, transparent); }
.d-rej .dev { font-size:11.5px; font-family: var(--yonder-font-mono, ui-monospace, monospace);
  color: var(--yonder-value,#fff); }
.d-rej .why { font-size:12px; color: var(--yonder-label,#7f8a95); line-height:1.5; }
.d-rej .why em { display:block; font-style:italic; font-size:11px; margin-top:2px; opacity:.82; }
</style>
