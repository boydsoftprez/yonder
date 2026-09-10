<!-- DRAFT — the captures panel (§8.3, R-CAM-18). Board-saved stills only:
     a camera-card photo is identified as such and carries none of these
     three keys, because Yonder never sees that file and a View that cannot
     view anything is worse than no button (camera-view/stills-and-
     snapshot.html: "no listing, no download, no delete... worth saying on
     the page rather than letting someone hunt for a file browser that
     cannot exist"). Reachable beside Capture on Live and Setup, not a
     separate page — a photo and the place to find it belong together. -->
<template>
  <div class="d-caps">
    <div class="d-h"><span>Captures &middot; this board</span><em class="q-label">{{ items.length }} saved</em></div>
    <div v-if="!items.length" class="d-caps__empty">Nothing saved to this board yet.</div>
    <ul v-else class="d-caps__list">
      <li v-for="it in items" :key="it.id" class="d-caps__row">
        <span class="d-caps__thumb" />
        <span class="d-caps__meta">
          <b>{{ it.when }}</b>
          <em>{{ it.size }}</em>
        </span>
        <span class="d-caps__keys">
          <button type="button" @click="$emit('view', it.id)">View</button>
          <button type="button" @click="$emit('download', it.id)">Download</button>
          <button type="button" class="warn" @click="remove(it.id)">Delete</button>
        </span>
      </li>
    </ul>
    <div class="d-fine">free space stated the same way the shutter key states it &middot; deleting is explicit and immediate</div>
  </div>
</template>
<script>
export default {
  name: 'DraftCaptures',
  props: {
    items: { type: Array, default: () => [] }
  },
  emits: ['view', 'download', 'delete'],
  methods: {
    remove (id) { this.$emit('delete', id) }
  }
}
</script>
<style scoped>
/* A popover, not an inline block: the deck's own columns are a fixed
   252px (gallery.css), nowhere near wide enough for a thumbnail, two dates'
   worth of metadata and three keys side by side — squeezed into that width
   the row wrapped its text under its own buttons. Floating it beside the
   toggle escapes that constraint instead of fighting it, and reads as what
   the spec calls it, "a captures panel", rather than another field in the
   column. */
.d-caps { position:absolute; z-index:20; top:calc(100% + 8px); left:0;
  width:360px; max-width:min(360px, 90vw);
  background: var(--yonder-pane,#090d12); border:1px solid var(--yonder-divider,#2b333c);
  border-radius:4px; padding:14px 16px; box-shadow:0 14px 32px rgba(0,0,0,.55); }
.d-h { display:flex; align-items:baseline; justify-content:space-between; gap:10px;
  font-size:10.5px; letter-spacing:.16em; text-transform:uppercase;
  color: var(--yonder-label,#7f8a95); margin-bottom:12px; }
.d-h em { font-style:normal; letter-spacing:.1em; }
.q-label { color: var(--yonder-label,#7f8a95); }
.d-caps__empty { font-size:12px; color: var(--yonder-label,#7f8a95); padding:8px 0 14px; }
.d-caps__list { list-style:none; margin:0 0 12px; padding:0; }
.d-caps__row { display:flex; align-items:center; gap:11px; padding:8px 0;
  border-top:1px solid color-mix(in srgb, var(--yonder-divider,#2b333c) 55%, transparent); }
.d-caps__row:first-child { border-top:0; }
.d-caps__thumb { flex:0 0 auto; display:block; width:56px; height:32px; border-radius:2px;
  background:linear-gradient(#8fb4d0 0 38%, #7d8a4e 38% 100%); }
.d-caps__meta { flex:1; min-width:0; display:flex; flex-direction:column; gap:2px; }
.d-caps__meta b { font-size:12.5px; font-weight:600; color: var(--yonder-value,#fff);
  font-variant-numeric:tabular-nums; }
.d-caps__meta em { font-style:normal; font-size:10.5px; color: var(--yonder-label,#7f8a95); }
.d-caps__keys { flex:0 0 auto; display:flex; gap:6px; }
.d-caps__keys button { font:inherit; font-size:10px; font-weight:600; letter-spacing:.08em;
  text-transform:uppercase; padding:6px 9px; border-radius:2px; cursor:pointer;
  background:transparent; border:1px solid var(--yonder-divider,#2b333c); color: var(--yonder-value,#fff); }
.d-caps__keys button:hover { border-color: var(--yonder-select,#2ad4f0); color: var(--yonder-select,#2ad4f0); }
.d-caps__keys button.warn:hover { border-color: var(--yonder-irreversible,#f03fce); color: var(--yonder-irreversible,#f03fce); }
.d-fine { font-size:10px; letter-spacing:.04em; line-height:1.5; color: var(--yonder-label,#7f8a95); }
</style>
