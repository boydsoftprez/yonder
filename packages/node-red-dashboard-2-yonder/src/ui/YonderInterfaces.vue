<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
  <section class="y-maint y-interfaces" aria-label="Current network interfaces">
    <div class="y-maint__heading">
      <h3>Interfaces</h3>
      <span role="status">{{ freshness }}</span>
      <button type="button" :disabled="loading" @click="refresh">Refresh</button>
    </div>
    <p v-if="error" class="y-maint__error" role="alert">{{ error }}</p>
    <template v-if="snapshot">
      <div class="y-interfaces__routes">
        <span v-for="family in [4, 6]" :key="family">
          Default IPv{{ family }}:
          <strong>{{ defaults(family) }}</strong>
        </span>
      </div>
      <div class="y-maint__scroll">
        <table>
          <thead><tr><th>Link</th><th>Interface / state</th><th>Current addresses</th><th>Gateway / metric</th></tr></thead>
          <tbody>
            <tr v-for="link in snapshot.interfaces" :key="link.device">
              <th>{{ names[link.kind] || link.kind }}</th>
              <td data-label="Interface / state"><code>{{ link.device }}</code><br><span>{{ link.carrier === false ? 'No carrier' : link.state }}</span></td>
              <td data-label="Current addresses">
                <span v-if="!link.addresses.length" class="y-maint__muted">No address</span>
                <div v-for="address in link.addresses" :key="address.address">
                  <code>{{ address.address }}/{{ address.prefix }}</code>
                  <small>IPv{{ address.family }}{{ address.scope === 'link' ? ' · link local' : '' }}</small>
                </div>
              </td>
              <td data-label="Gateway / metric"><span v-if="!link.defaultRoutes.length" class="y-maint__muted">No default route</span>
                <div v-for="route in link.defaultRoutes" :key="route.family + ':' + route.gateway">
                  <code>{{ route.gateway || 'On link' }}</code><small>IPv{{ route.family }} · metric {{ route.metric }}</small>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="y-maint__muted">Addresses and default routes are read from the device. ZeroTier can use a separate physical path for each peer; a default route alone does not identify its active socket.</p>
    </template>
    <p v-else-if="!error">Reading current interfaces…</p>
  </section>
</template>
<script lang="ts">
import { defineComponent } from 'vue';
import type { InterfaceSnapshot } from '../../../yonder-core/src/net/interfaces.js';
import { maintenanceRequest } from './maintenance-api.js';
export default defineComponent({
  name: 'YonderInterfaces',
  props: { id: String, props: Object, msg: Object },
  data() { return {
    snapshot: null as InterfaceSnapshot | null, error: '', loading: false, alive: false,
    receivedAt: 0, now: Date.now(), timer: undefined as ReturnType<typeof setTimeout> | undefined,
    ageTimer: undefined as ReturnType<typeof setInterval> | undefined,
    names: { ethernet: 'Ethernet', wifi: 'Wi-Fi', modem: 'LTE / cellular', zerotier: 'ZeroTier', other: 'Other' } as Record<string, string>,
  }; },
  computed: {
    freshness(): string { return this.receivedAt ? `Updated ${Math.max(0, Math.floor((this.now - this.receivedAt) / 1000))}s ago` : 'Waiting for observation'; },
  },
  mounted() {
    this.alive = true;
    if (this.props?.preview === true) {
      this.snapshot = this.props.snapshot as InterfaceSnapshot; this.receivedAt = Date.now(); return;
    }
    void this.refresh();
    this.ageTimer = setInterval(() => {
      this.now = Date.now();
      if (this.receivedAt && this.now - this.receivedAt > 15_000) {
        this.snapshot = null; this.error = 'Interface readings are stale. Waiting for a new device observation.';
      }
    }, 1000);
  },
  beforeUnmount() { this.alive = false; clearTimeout(this.timer); clearInterval(this.ageTimer); },
  methods: {
    defaults(family: number): string {
      return this.snapshot?.defaultRoutes.filter(r => r.family === family)
        .map(r => `${r.device}${r.gateway ? ' via ' + r.gateway : ''}`).join(', ') || 'No default route';
    },
    async refresh() {
      if (this.props?.preview === true) return;
      if (this.loading) return;
      clearTimeout(this.timer); this.loading = true;
      try {
        const value = await maintenanceRequest<InterfaceSnapshot>('interfaces');
        if (!this.alive) return;
        if (!Array.isArray(value.interfaces) || !Array.isArray(value.defaultRoutes)) throw new Error('Invalid interface observation.');
        this.snapshot = value; this.receivedAt = Date.now(); this.now = this.receivedAt; this.error = '';
      } catch (error) {
        if (this.alive) { this.snapshot = null; this.error = error instanceof Error ? error.message : 'Could not read current interfaces.'; }
      } finally {
        this.loading = false;
        if (this.alive) this.timer = setTimeout(() => { void this.refresh(); }, 5000);
      }
    },
  },
});
</script>
<style src="./maintenance.css"></style>
<style scoped>
.y-interfaces__routes { display: flex; flex-wrap: wrap; gap: 8px 24px; padding: 12px 0; }
table { width: 100%; border-collapse: collapse; text-align: left; }
th, td { padding: 12px 10px; border-bottom: 1px solid var(--yonder-divider, #2b333c); vertical-align: top; }
thead { color: var(--yonder-label, #7f8a95); font-size: 12px; }
tbody th { min-width: 100px; }
td { overflow-wrap: anywhere; }
small { display: block; font-size: 11px; color: var(--yonder-label, #7f8a95); margin: 3px 0 6px; }
@media(max-width: 600px) {
  table, tbody, tr, th, td { display: block; width: 100%; }
  thead { display: none; }
  tr { padding: 14px 0; border-bottom: 1px solid var(--yonder-divider, #2b333c); }
  th, td { border: 0; padding: 5px 0; }
  td::before { content: attr(data-label); display: block; font-size: 11px; color: var(--yonder-label, #7f8a95); margin-bottom: 4px; }
}
</style>
