<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
  <section class="y-maint" aria-label="Network diagnostics">
    <div class="y-maint__heading"><h3>Network diagnostics</h3><span>Run from this device</span></div>
    <form @submit.prevent="run">
      <div class="y-maint__fields">
        <label>Tool<select v-model="tool" :disabled="busy"><option value="ping">Ping</option><option value="traceroute">Traceroute</option><option value="route">Route lookup</option><option value="bandwidth">Bandwidth · iperf3</option></select></label>
        <label>{{ tool === 'bandwidth' ? 'iperf3 server hostname or IP' : 'Hostname or IP address' }}<input v-model.trim="host" required maxlength="253" :disabled="busy" placeholder="1.1.1.1 or example.com" autocapitalize="none" spellcheck="false"></label>
        <label>Interface<select v-model="device" :disabled="busy"><option value="">Automatic route</option><option v-for="link in interfaces" :key="link.device" :value="link.device">{{ link.device }} · {{ link.kind }}</option></select></label>
        <label>IP family<select v-model.number="family" :disabled="busy"><option :value="4">IPv4</option><option :value="6">IPv6</option></select></label>
      </div>
      <p v-if="interfaceError" class="y-maint__error">{{ interfaceError }}</p>
      <div v-if="tool === 'ping'" class="y-maint__fields"><label>Packets<input v-model.number="count" type="number" min="1" max="10" :disabled="busy"></label></div>
      <template v-if="tool === 'bandwidth'">
        <p class="y-maint__muted">The target must run <code>iperf3 -s</code>. This test uses real data and shares the link with video and telemetry. Results are limited by the selected rate ceiling.</p>
        <div class="y-maint__fields">
          <label>Direction<select v-model="direction" :disabled="busy"><option value="upload">Upload from Yonder</option><option value="download">Download to Yonder</option></select></label>
          <label>Seconds<input v-model.number="seconds" type="number" min="2" max="10" :disabled="busy"></label>
          <label>Rate ceiling · Mb/s<input v-model.number="mbps" type="number" min="1" max="100" :disabled="busy"></label>
          <label>Server port<input v-model.number="port" type="number" min="1" max="65535" :disabled="busy"></label>
        </div>
        <p class="y-maint__muted">Up to {{ (seconds * mbps / 8).toFixed(1) }} MB of test payload, plus protocol overhead.</p>
      </template>
      <p v-if="tool === 'traceroute'" class="y-maint__muted">One probe per hop, up to 20 hops. An asterisk means the hop did not reply; it does not by itself identify a broken link.</p>
      <p v-if="tool === 'route'" class="y-maint__muted">Shows the kernel route, source address and outgoing interface for this target. A ZeroTier address selects the virtual interface; use a peer's physical address to inspect its underlying route.</p>
      <div class="y-maint__actions"><button type="submit" class="y-maint__primary" :disabled="busy || !host">{{ busy ? 'Running…' : 'Run test' }}</button><button type="button" :disabled="!job || job.status !== 'running' || submitting" @click="cancel">Cancel</button><button type="button" :disabled="busy || !job" @click="clear">Clear</button><button type="button" :disabled="!job" @click="download">Save output</button></div>
    </form>
    <p v-if="error" class="y-maint__error" role="alert">{{ error }}</p>
    <div class="y-diag__terminal">
      <div class="y-diag__state" role="status">{{ job ? job.status + ' · ' + elapsed + 's' + (job.exitCode !== null ? ' · exit ' + job.exitCode : '') : 'Ready' }}</div>
      <pre tabindex="0" aria-label="Diagnostic terminal output">{{ job ? (job.command ? '$ ' + job.command + '\n\n' : '') + (job.output || 'Waiting for command output…') : 'Choose a tool, target and interface, then run a test.' }}{{ job?.truncated ? '\n[Output limit reached]' : '' }}</pre>
    </div>
    <section class="y-diag__system">
      <h4>System reboot</h4>
      <p class="y-maint__muted">Restart Yonder in one minute. Video, telemetry and the console will disconnect. Reboot only while the aircraft is on the ground.</p>
      <button v-if="!confirmReboot" type="button" class="y-maint__danger" :disabled="busy || rebooting" @click="confirmReboot = true">Reboot system…</button>
      <div v-else class="y-maint__actions">
        <button type="button" class="y-maint__danger" :disabled="rebooting" @click="reboot">Confirm reboot in one minute</button>
        <button type="button" :disabled="rebooting" @click="confirmReboot = false">Keep running</button>
      </div>
      <p v-if="rebootMessage" role="status">{{ rebootMessage }}</p>
    </section>
  </section>
</template>
<script lang="ts">
import { defineComponent } from 'vue';
import type { DiagnosticJob } from '../../../yonder-core/src/diag/jobs.js';
import type { InterfaceSnapshot, InterfaceState } from '../../../yonder-core/src/net/interfaces.js';
import { maintenanceRequest, MaintenanceError } from './maintenance-api.js';
export default defineComponent({
  name: 'YonderDiagnostics', props: { id: String, props: Object, msg: Object },
  data() { return {
    tool: 'ping', host: '', device: '', family: 4, count: 4, seconds: 5, mbps: 10, port: 5201, direction: 'upload',
    interfaces: [] as InterfaceState[], interfaceError: '', job: null as DiagnosticJob | null, error: '',
    submitting: false, alive: false, now: Date.now(), timer: undefined as ReturnType<typeof setTimeout> | undefined,
    ageTimer: undefined as ReturnType<typeof setInterval> | undefined,
    confirmReboot: false, rebooting: false, rebootMessage: '',
  }; },
  computed: {
    busy(): boolean { return this.submitting || this.job?.status === 'running'; },
    elapsed(): number { return this.job ? Math.max(0, Math.floor(((this.job.finishedAt ?? this.now) - this.job.startedAt) / 1000)) : 0; },
  },
  mounted() {
    this.alive = true;
    if (this.props?.preview === true) { this.job = this.props.job as DiagnosticJob; return; }
    void this.loadInterfaces();
    this.ageTimer = setInterval(() => { this.now = Date.now(); }, 1000);
    try { const id = sessionStorage.getItem('yonder-diagnostic-job'); if (id) void this.poll(id); } catch { /* Storage is optional. */ }
  },
  beforeUnmount() { this.alive = false; clearTimeout(this.timer); clearInterval(this.ageTimer); },
  methods: {
    async loadInterfaces() {
      try { const value = await maintenanceRequest<InterfaceSnapshot>('interfaces'); if (this.alive) { this.interfaces = value.interfaces; this.interfaceError = ''; } }
      catch { if (this.alive) { this.interfaces = []; this.interfaceError = 'Interface list unavailable. Refresh the page to select a physical interface.'; } }
    },
    async run() {
      if (this.props?.preview === true) { this.error = 'Gallery preview. Open Diagnostics on a device to run a test.'; return; }
      if (this.busy) return;
      this.submitting = true; this.error = '';
      try {
        const job = await maintenanceRequest<DiagnosticJob>('diagnostics', {
          tool: this.tool, host: this.host, ...(this.device ? { device: this.device } : {}),
          family: this.family, count: this.count, seconds: this.seconds, mbps: this.mbps, port: this.port, direction: this.direction,
        });
        if (!this.alive) return;
        this.job = job;
        try { sessionStorage.setItem('yonder-diagnostic-job', job.id); } catch { /* optional */ }
        void this.poll(job.id);
      } catch (error) { this.error = error instanceof Error ? error.message : 'Could not start the diagnostic.'; }
      finally { this.submitting = false; }
    },
    async poll(id: string) {
      clearTimeout(this.timer);
      try {
        const job = await maintenanceRequest<DiagnosticJob>('diagnostics/' + id);
        if (!this.alive || (this.job && this.job.id !== id)) return;
        this.job = job; this.error = '';
        if (job.status === 'running') this.timer = setTimeout(() => { void this.poll(id); }, 1000);
      } catch (error) {
        if (!this.alive) return;
        this.error = error instanceof Error ? error.message : 'Output could not be refreshed.';
        if (error instanceof MaintenanceError && [401, 404].includes(error.status)) {
          if (this.job) this.job = { ...this.job, status: 'failed', finishedAt: Date.now() };
          try { sessionStorage.removeItem('yonder-diagnostic-job'); } catch { /* optional */ }
          return;
        }
        if (this.job?.status === 'running') this.timer = setTimeout(() => { void this.poll(id); }, 2000);
      }
    },
    async cancel() {
      if (!this.job || this.submitting) return;
      this.submitting = true;
      try { this.job = await maintenanceRequest<DiagnosticJob>('diagnostics/' + this.job.id + '/cancel', {}); }
      catch (error) { this.error = error instanceof Error ? error.message : 'Cancellation was not confirmed.'; }
      finally { this.submitting = false; }
    },
    clear() { if (this.busy) return; this.job = null; this.error = ''; try { sessionStorage.removeItem('yonder-diagnostic-job'); } catch { /* optional */ } },
    download() {
      if (!this.job) return;
      const url = URL.createObjectURL(new Blob([this.job.command + '\n' + this.job.output + '\nStatus: ' + this.job.status], { type: 'text/plain' }));
      const link = document.createElement('a'); link.href = url; link.download = 'yonder-' + this.job.tool + '-' + this.job.id + '.txt'; link.click(); URL.revokeObjectURL(url);
    },
    async reboot() {
      if (this.props?.preview === true) return;
      if (this.rebooting) return;
      this.rebooting = true; this.error = '';
      try { const result = await maintenanceRequest<{ message: string }>('reboot', { confirm: 'REBOOT' }); this.rebootMessage = result.message; this.confirmReboot = false; }
      catch (error) { this.error = error instanceof Error ? error.message : 'Reboot was not confirmed.'; this.rebooting = false; }
    },
  },
});
</script>
<style src="./maintenance.css"></style>
<style scoped>
.y-diag__terminal { margin-top: 20px; border: 1px solid var(--yonder-divider, #2b333c); background: var(--yonder-pane, #090d12); border-radius: 4px; }
.y-diag__state { padding: 10px 14px; border-bottom: 1px solid var(--yonder-divider, #2b333c); color: var(--yonder-select, #2ad4f0); }
pre { padding: 16px; margin: 0; min-height: 260px; max-height: 440px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; line-height: 1.6; }
.y-diag__system { border-top: 1px solid var(--yonder-divider, #2b333c); margin-top: 24px; padding-top: 20px; }
</style>
