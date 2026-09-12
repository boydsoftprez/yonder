<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
  <section class="y-storage" aria-label="Storage protection and maintenance">
    <h3>Storage protection and maintenance</h3>
    <p>Use writable maintenance only for Linux package or system maintenance. Run <code>apt</code> through your Linux login while maintenance is active.</p>
    <p class="y-maint__muted">Download a backup in the <a href="#yonder-recovery-tools">Recovery backup and restore</a> section first. Leaving maintenance reboots the device and returns the next normal boot to protected storage.</p>
    <p class="y-storage__warning"><strong>Power loss during package maintenance can leave the card unusable and require a reflash.</strong></p>

    <dl v-if="storage" class="y-storage__facts" aria-label="Observed storage status">
      <div><dt>Observed mode</dt><dd>{{ modeLabel }}</dd></div>
      <div><dt>Linux owner</dt><dd>{{ storage.ownerConfigured ? 'Configured' : 'Not configured' }}</dd></div>
      <div><dt>Operation</dt><dd>{{ operationLabel }}</dd></div>
    </dl>
    <p v-else-if="loading" role="status">Reading storage status…</p>

    <p v-if="guidance" class="y-maint__muted">{{ guidance }}</p>
    <p v-if="operationStatus" role="status">{{ operationStatus }}</p>

    <div v-if="storage && action === 'idle'" class="y-maint__actions">
      <button v-if="canEnter" data-action="enter" type="button" :disabled="busy" @click="choose('enter')">
        {{ awaitingMaintenance ? 'Retry maintenance reboot' : 'Enter maintenance' }}
      </button>
      <button v-if="canExit" data-action="exit" type="button" :disabled="busy" @click="choose('exit')">Return to protection</button>
      <button type="button" :disabled="busy" @click="refreshStatus">Refresh status</button>
    </div>

    <form v-if="action !== 'idle'" :aria-label="action === 'enter' ? 'Confirm writable maintenance' : 'Confirm protected reboot'" @submit.prevent="submitAction">
      <p>{{ action === 'enter'
        ? 'The device will reboot into writable maintenance. Console and network sessions will be interrupted.'
        : 'The device will reboot and restore protected storage.' }}</p>
      <label class="y-storage__check">
        <input v-model="confirmed" type="checkbox" :disabled="busy">
        {{ action === 'enter'
          ? 'I understand this reboots into writable maintenance and package changes can damage the card if power is lost.'
          : 'I understand this reboots the device and returns storage protection.' }}
      </label>
      <label>Current console password<input v-model="currentPassword" type="password" autocomplete="current-password" required maxlength="1024" :disabled="busy"></label>
      <div class="y-maint__actions">
        <button class="y-maint__danger" type="submit" :disabled="busy || !confirmed">
          {{ busy ? 'Scheduling reboot…' : action === 'enter' ? 'Reboot into maintenance' : 'Reboot and protect storage' }}
        </button>
        <button type="button" :disabled="busy" @click="cancelAction">Cancel</button>
      </div>
    </form>

    <p v-if="error" class="y-maint__error" role="alert">{{ error }}</p>
    <p v-if="message" role="status">{{ message }}</p>
  </section>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { MaintenanceError, maintenanceRequest } from './maintenance-api.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KINDS = ['bootstrap', 'config-apply', 'owner-access', 'restore', 'maintenance'] as const;
const PHASES = ['staging', 'activating', 'awaiting-confirmation', 'committing', 'rolling-back', 'recovering',
  'awaiting-maintenance-reboot', 'entered-maintenance', 'committed-awaiting-runtime-handoff'] as const;
type StorageMode = 'protected' | 'maintenance' | 'writable';
type OperationKind = typeof KINDS[number];
type OperationPhase = typeof PHASES[number];
interface StorageState {
  managed: boolean; mode: StorageMode; ownerConfigured: boolean;
  operation: null | { id: string; kind: OperationKind; phase: OperationPhase };
}

const KIND_LABELS: Record<OperationKind, string> = {
  bootstrap: 'Initial setup', 'config-apply': 'Configuration update', 'owner-access': 'Linux owner update',
  restore: 'Recovery restore', maintenance: 'Storage maintenance',
};
const PHASE_LABELS: Record<OperationPhase, string> = {
  staging: 'preparing changes', activating: 'activating changes', 'awaiting-confirmation': 'awaiting confirmation',
  committing: 'committing changes', 'rolling-back': 'rolling back', recovering: 'recovering',
  'awaiting-maintenance-reboot': 'waiting for the maintenance reboot', 'entered-maintenance': 'writable maintenance is active',
  'committed-awaiting-runtime-handoff': 'waiting for the restarted service',
};

function checkedStorage(value: unknown): StorageState {
  const candidate = value as Partial<StorageState> | null;
  if (!candidate || typeof candidate.managed !== 'boolean' || typeof candidate.ownerConfigured !== 'boolean'
    || !['protected', 'maintenance', 'writable'].includes(candidate.mode as string)
    || (candidate.managed && candidate.mode === 'writable') || (!candidate.managed && candidate.mode !== 'writable')) {
    throw new Error('The device returned an invalid storage status.');
  }
  let operation: StorageState['operation'] = null;
  if (candidate.operation !== null) {
    const input = candidate.operation as StorageState['operation'];
    if (!input || !UUID.test(input.id) || !KINDS.includes(input.kind) || !PHASES.includes(input.phase)
      || (input.kind === 'maintenance' && !['awaiting-maintenance-reboot', 'entered-maintenance'].includes(input.phase))) {
      throw new Error('The device returned an invalid storage status.');
    }
    operation = { id: input.id, kind: input.kind, phase: input.phase };
  }
  return { managed: candidate.managed, mode: candidate.mode as StorageMode,
    ownerConfigured: candidate.ownerConfigured, operation };
}

function checkedMutation(value: unknown): { operationId: string } {
  const candidate = value as { ok?: unknown; operationId?: unknown; message?: unknown } | null;
  if (!candidate || candidate.ok !== true || typeof candidate.operationId !== 'string' || !UUID.test(candidate.operationId)
    || typeof candidate.message !== 'string' || candidate.message.length < 1 || candidate.message.length > 512) {
    throw new Error('The device did not confirm the maintenance request.');
  }
  return { operationId: candidate.operationId };
}

function safeMutationError(error: unknown): string {
  if (!(error instanceof MaintenanceError)) {
    return 'The device reply was lost or not confirmed. The current storage status is shown above. Do not repeat the action automatically.';
  }
  if (error.status === 401) return 'The current console password was not accepted.';
  if (error.status === 403) return 'Storage maintenance is not available for this account.';
  if (error.status === 409) return 'Another device operation blocks storage maintenance. Refresh the status and try later.';
  return 'The device rejected the maintenance request. Refresh the status before trying again.';
}

export default defineComponent({
  name: 'StorageMaintenance', props: { preview: Boolean },
  data() {
    return { storage: null as StorageState | null, loading: true, busy: false, action: 'idle' as 'idle' | 'enter' | 'exit',
      currentPassword: '', confirmed: false, error: '', message: '' };
  },
  computed: {
    modeLabel(): string {
      if (!this.storage) return '';
      if (!this.storage.managed) return 'Writable conventional installation';
      return this.storage.mode === 'protected' ? 'Protected' : 'Writable maintenance';
    },
    awaitingMaintenance(): boolean {
      return this.storage?.operation?.kind === 'maintenance'
        && this.storage.operation.phase === 'awaiting-maintenance-reboot';
    },
    enteredMaintenance(): boolean {
      return this.storage?.operation?.kind === 'maintenance' && this.storage.operation.phase === 'entered-maintenance';
    },
    operationLabel(): string { return this.storage?.operation ? KIND_LABELS[this.storage.operation.kind] : 'None'; },
    operationStatus(): string {
      const operation = this.storage?.operation;
      return operation ? `${KIND_LABELS[operation.kind]}: ${PHASE_LABELS[operation.phase]}.` : '';
    },
    canEnter(): boolean {
      return this.storage?.managed === true && this.storage.mode === 'protected' && this.storage.ownerConfigured
        && (this.storage.operation === null || this.awaitingMaintenance);
    },
    canExit(): boolean {
      return this.storage?.managed === true && this.storage.mode === 'maintenance' && this.storage.ownerConfigured
        && this.enteredMaintenance;
    },
    guidance(): string {
      if (!this.storage) return '';
      if (!this.storage.managed) return 'This installation uses writable storage. Protected-storage maintenance actions are not available.';
      if (!this.storage.ownerConfigured) return 'Create the Linux owner account above before entering or leaving maintenance.';
      if (this.storage.operation && this.storage.operation.kind !== 'maintenance') return 'Another device operation must finish before storage maintenance can change.';
      if (this.awaitingMaintenance) return 'Maintenance is scheduled. Retry the reboot only if the device returned without entering writable maintenance.';
      if (this.enteredMaintenance) return 'Writable maintenance is active. Finish package work, then return the device to protected storage.';
      if (this.storage.mode === 'maintenance') return 'Maintenance state could not be confirmed. Refresh status before taking action.';
      return 'Storage is protected. Enter maintenance only when Linux package or system changes are required.';
    },
  },
  mounted() {
    if (this.preview) {
      this.storage = { managed: true, mode: 'protected', ownerConfigured: true, operation: null };
      this.loading = false;
      return;
    }
    void this.refreshStatus();
  },
  beforeUnmount() { this.clearCredentials(); },
  methods: {
    clearCredentials() { this.currentPassword = ''; this.confirmed = false; },
    choose(action: 'enter' | 'exit') {
      if (this.preview) { this.error = 'Gallery preview. Storage maintenance is available only on a device.'; return; }
      if ((action === 'enter' && !this.canEnter) || (action === 'exit' && !this.canExit)) return;
      this.clearCredentials(); this.error = ''; this.message = ''; this.action = action;
    },
    cancelAction() { this.clearCredentials(); this.action = 'idle'; this.error = ''; },
    async refreshStatus(options?: { quiet?: boolean }) {
      if (this.preview) return;
      this.loading = true;
      if (!options?.quiet) { this.error = ''; this.message = ''; }
      try { this.storage = checkedStorage(await maintenanceRequest('storage')); }
      catch {
        this.storage = null;
        if (!options?.quiet) this.error = 'The storage status could not be read.';
      } finally { this.loading = false; }
    },
    async submitAction() {
      if (this.busy || this.preview || !this.confirmed || this.action === 'idle') return;
      const selected = this.action;
      this.busy = true; this.error = ''; this.message = '';
      try {
        checkedMutation(await maintenanceRequest(`storage/${selected}`, {
          currentPassword: this.currentPassword, confirm: selected === 'enter' ? 'MAINTENANCE' : 'PROTECT',
        }));
        this.message = selected === 'enter'
          ? 'Maintenance reboot scheduled. Reconnect after the device restarts and check the observed mode.'
          : 'Protected reboot scheduled. Reconnect after the device restarts and confirm storage is protected.';
      } catch (error) { this.error = safeMutationError(error); }
      finally {
        this.clearCredentials(); this.action = 'idle'; this.busy = false;
        await this.refreshStatus({ quiet: true });
      }
    },
  },
});
</script>

<style scoped>
.y-storage a { color: var(--yonder-select, #2ad4f0); }
.y-storage__warning { color: var(--yonder-caution, #ffb020); }
.y-storage__facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; max-width: 760px; }
.y-storage__facts div { border: 1px solid var(--yonder-divider, #2b333c); border-radius: 4px; padding: 10px; }
.y-storage__facts dt { color: var(--yonder-label, #7f8a95); font-size: 12px; }
.y-storage__facts dd { margin: 4px 0 0; font: 600 14px var(--yonder-font-mono, monospace); }
.y-storage form { display: grid; gap: 14px; max-width: 680px; margin-top: 16px; }
.y-storage .y-storage__check { flex-direction: row; align-items: center; font-size: 14px; }
.y-storage__check input { width: 20px; min-height: 20px; margin: 0; }
</style>
