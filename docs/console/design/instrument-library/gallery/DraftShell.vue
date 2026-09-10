<!-- The console's shell. The carbon, the app bar and the drawer are the real
     theme.css rules, reached by wearing the class names Dashboard wears —
     .v-application__wrap, .v-app-bar, .v-navigation-drawer — so this is the
     generated stylesheet doing the work, not a second copy of it. -->
<template>
  <div class="v-application__wrap d-shell">
    <header class="v-app-bar d-bar">
      <span class="v-app-bar-title">{{ title }}</span>
    </header>
    <div class="d-body">
      <nav class="v-navigation-drawer d-nav">
        <template v-for="p in pages" :key="p.id">
          <div v-if="p.section" class="d-nav__sect">{{ p.section }}</div>
          <button type="button" class="v-list-item d-nav__i" :class="{ 'v-list-item--active': p.id === page, sub: p.sub }"
                  @click="$emit('go', p.id)">
            <span class="d-nav__ico" v-html="p.icon" />
            <span class="v-list-item-title">{{ p.label }}</span>
          </button>
        </template>
      </nav>
      <main class="d-main"><slot /></main>
    </div>
  </div>
</template>
<script>
const I = {
  status: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12h4l3 8 4-16 3 8h4"/></svg>',
  network: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12.5a10 10 0 0114 0M8.5 16a5.5 5.5 0 017 0"/><circle cx="12" cy="19.5" r="1.2" fill="currentColor"/></svg>',
  cameras: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="7" width="18" height="13" rx="2"/><circle cx="12" cy="13.5" r="3.5"/><path d="M9 7l1.5-3h3L15 7"/></svg>',
  camera: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="6" width="14" height="12" rx="2"/><path d="M16 10l6-3v10l-6-3z"/></svg>',
  log: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
  diag: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 3v6a5 5 0 0010 0V3"/><path d="M11 14v3a4 4 0 008 0v-1"/><circle cx="19" cy="11" r="2"/></svg>',
};
export default {
  name: 'DraftShell',
  props: { page: { type: String, default: 'camera-live' }, title: { type: String, default: '' },
           cameras: { type: Array, default: () => [] } },
  emits: ['go'],
  computed: {
    // Navigation is built from detected hardware: one entry per camera the
    // probe found, under the index. Unplug one and its entry is gone (R-UI-03).
    pages () {
      return [
        { id: 'status', label: 'Status', icon: I.status },
        { id: 'network', label: 'Network', icon: I.network },
        { id: 'cameras', label: 'Cameras', icon: I.cameras, section: 'Cameras' },
        ...this.cameras.map((c) => ({ id: 'camera:' + c.id, label: c.name, icon: I.camera, sub: true })),
        { id: 'log', label: 'Log', icon: I.log, section: 'System' },
        { id: 'diagnostics', label: 'Diagnostics', icon: I.diag },
      ]
    }
  }
}
</script>
<style scoped>
.d-shell { min-height: 640px; display:flex; flex-direction:column; }
.d-bar { display:flex; align-items:center; padding:11px 16px; }
.d-body { display:flex; flex:1; min-height:0; }
.d-nav { width:248px; flex:0 0 248px; padding:14px 0; }
.d-nav__i { display:flex; align-items:center; gap:14px; width:100%; padding:13px 18px 13px 22px;
  background:transparent; border:0; cursor:pointer; text-align:left;
  color: var(--yonder-label,#7f8a95); }
.d-nav__i:hover { color: var(--yonder-value,#fff); }
.d-nav__ico { display:flex; opacity:.85; }
.d-nav__sect { font-size:9.5px; letter-spacing:.2em; text-transform:uppercase; color: var(--yonder-label,#7f8a95);
  opacity:.7; padding:16px 22px 6px; }
.d-nav__i.sub { padding-left:34px; }
/* Vertical padding trimmed from 16px (kept on the sides): the viewport
   contract (§5) measures the picture, Aim and Capture against 900px of real
   estate, and Capture's readouts landed 18px past it before this. Measured,
   not eyeballed — docs/console/design/instrument-library/gallery/shot6.mjs
   prints the fold numbers this and the .d-col trims in gallery.css answer. */
.d-main { flex:1; min-width:0; padding:10px 16px; }
</style>
