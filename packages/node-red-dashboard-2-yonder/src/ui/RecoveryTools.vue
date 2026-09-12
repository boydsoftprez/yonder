<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
  <section id="yonder-recovery-tools" class="y-recovery" aria-label="Recovery backup and restore">
    <h3>Recovery backup and restore</h3>
    <p>Download or restore the supported device settings, credentials, Linux owner access, and mesh identity.</p>
    <p class="y-recovery__warning"><strong>Contains passwords and keys. Store securely.</strong></p>
    <p class="y-maint__muted">Backups exclude recordings, browser Flight state, custom Node-RED flows and extensions, and operating-system files.</p>

    <div v-if="mode === 'idle'" class="y-maint__actions">
      <button data-action="backup" type="button" :disabled="busy" @click="choose('backup')">Download backup</button>
      <button data-action="restore" type="button" :disabled="busy" @click="choose('restore')">Restore backup</button>
    </div>

    <form v-else-if="mode === 'backup'" aria-label="Download recovery backup" @submit.prevent="downloadBackup">
      <label>Current console password<input v-model="currentPassword" type="password" autocomplete="current-password" required maxlength="1024" :disabled="busy"></label>
      <div class="y-maint__actions">
        <button class="y-maint__primary" type="submit" :disabled="busy">{{ busy ? 'Preparing backup…' : 'Download backup' }}</button>
        <button type="button" :disabled="busy" @click="reset">Cancel</button>
      </div>
    </form>

    <form v-else-if="mode === 'restore'" aria-label="Preview recovery backup" @submit.prevent="previewBackup">
      <label>Recovery backup file<input ref="archiveInput" type="file" accept="application/json,.json" :disabled="busy" @change="readArchive"></label>
      <p v-if="selectedName" class="y-maint__muted">Selected: {{ selectedName }}</p>
      <label>Current console password<input v-model="currentPassword" type="password" autocomplete="current-password" required maxlength="1024" :disabled="busy"></label>
      <div class="y-maint__actions">
        <button class="y-maint__primary" type="submit" :disabled="busy || !archiveBase64">{{ busy ? 'Checking backup…' : 'Preview restore' }}</button>
        <button type="button" :disabled="busy" @click="reset">Cancel</button>
      </div>
    </form>

    <div v-else-if="mode === 'preview' && restorePreview" class="y-recovery__preview">
      <h4>Review this restore</h4>
      <p>Preview expires <time :datetime="new Date(restorePreview.expiresAt).toISOString()">{{ formatExpiry(restorePreview.expiresAt) }}</time>.</p>
      <ul aria-label="Restore consequences">
        <li>{{ restorePreview.summary.replacesLinuxOwner ? 'Linux owner login and credentials will be replaced.' : 'Linux owner login will stay the same.' }}</li>
        <li>{{ restorePreview.summary.replacesDeviceCredentials ? 'Saved device passwords and keys will be replaced.' : 'Saved device credentials will stay the same.' }}</li>
        <li>{{ restorePreview.summary.replacesMeshIdentity ? 'The mesh identity will be replaced.' : 'The mesh identity will stay the same.' }}</li>
        <li>{{ restorePreview.summary.membershipCount }} mesh memberships will be restored.</li>
        <li>{{ restorePreview.summary.networkInterruption ? 'Network service will be interrupted.' : 'No mesh interruption is expected.' }}</li>
      </ul>
      <dl aria-label="Hardware compatibility adjustments" class="y-recovery__facts">
        <div><dt>Unavailable cameras</dt><dd>{{ restorePreview.summary.compatibility.unavailableCameras }}</dd></div>
        <div><dt>Unavailable UARTs</dt><dd>{{ restorePreview.summary.compatibility.unavailableUarts }}</dd></div>
        <div><dt>Unavailable network interfaces</dt><dd>{{ restorePreview.summary.compatibility.unavailableNetworkInterfaces }}</dd></div>
      </dl>
      <h4>Warnings</h4>
      <ul><li v-for="warning in restorePreview.summary.warnings" :key="warning">{{ warning }}</li></ul>
      <h4>Not included</h4>
      <ul><li v-for="item in exclusionLabels" :key="item">{{ item }}</li></ul>
      <form aria-label="Confirm recovery restore" @submit.prevent="commitRestore">
        <label class="y-recovery__check"><input v-model="confirmed" type="checkbox" :disabled="busy">I understand this replaces the listed settings and credentials.</label>
        <label>Current console password<input v-model="currentPassword" type="password" autocomplete="current-password" required maxlength="1024" :disabled="busy"></label>
        <div class="y-maint__actions">
          <button class="y-maint__danger" type="submit" :disabled="busy || !confirmed">{{ busy ? 'Starting restore…' : 'Restore and restart' }}</button>
          <button data-action="cancel-preview" type="button" :disabled="busy" @click="cancelPreview">Cancel restore</button>
        </div>
      </form>
    </div>

    <p v-if="error" class="y-maint__error" role="alert">{{ error }}</p>
    <p v-if="message" role="status">{{ message }}</p>
  </section>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { MaintenanceError, maintenanceRequest } from './maintenance-api.js';

const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024;
const MAX_BASE64_BYTES = Math.ceil(MAX_ARCHIVE_BYTES / 3) * 4;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EXCLUSIONS: Record<string, string> = {
  recordings: 'Recordings',
  'browser Flight state': 'Browser Flight state',
  'custom Node-RED flows and extensions': 'Custom Node-RED flows and extensions',
  'operating-system files': 'Operating-system files',
};
const WARNINGS = new Set([
  'Restoring may disconnect current network and administrator sessions.',
  'Setup AP and fallback remain enabled; unavailable hardware will not start automatically.',
  'The original device must not run the restored mesh identity at the same time.',
  'Hardware-dependent settings were reconciled for this device.',
  'Some saved cameras are unavailable on this device.',
  'Some saved UART settings are unavailable on this device.',
  'Some saved network interfaces are unavailable on this device.',
]);

interface CompatibilitySummary {
  adjusted: boolean; crossBoard: boolean; unavailableCameras: number; unavailableUarts: number;
  unavailableNetworkInterfaces: number; apFallbackReachable: true;
}
interface RestorePreview {
  restoreId: string; destinationGeneration: string; expiresAt: number;
  summary: {
    replacesLinuxOwner: boolean; replacesDeviceCredentials: boolean; replacesMeshIdentity: boolean;
    membershipCount: number; networkInterruption: boolean; warnings: string[]; excluded: string[];
    compatibility: CompatibilitySummary;
  };
}

function archiveBytes(base64: unknown): Uint8Array {
  if (typeof base64 !== 'string' || base64.length < 4 || base64.length > MAX_BASE64_BYTES
    || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error('The device returned an invalid recovery backup.');
  const binary = atob(base64);
  if (binary.length > MAX_ARCHIVE_BYTES || btoa(binary) !== base64) throw new Error('The device returned an invalid recovery backup.');
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32 * 1024) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 32 * 1024)));
  }
  return btoa(binary);
}

function checkedPreview(value: unknown): RestorePreview {
  const preview = value as RestorePreview | null;
  const summary = preview?.summary, compatibility = summary?.compatibility;
  const counts = [summary?.membershipCount, compatibility?.unavailableCameras, compatibility?.unavailableUarts,
    compatibility?.unavailableNetworkInterfaces];
  if (!preview || !UUID.test(preview.restoreId) || !UUID.test(preview.destinationGeneration)
    || !Number.isFinite(preview.expiresAt) || preview.expiresAt <= Date.now()
    || !summary || typeof summary.replacesLinuxOwner !== 'boolean' || typeof summary.replacesDeviceCredentials !== 'boolean'
    || typeof summary.replacesMeshIdentity !== 'boolean' || typeof summary.networkInterruption !== 'boolean'
    || counts.some(count => !Number.isSafeInteger(count) || (count as number) < 0 || (count as number) > 1024)
    || !compatibility || typeof compatibility.adjusted !== 'boolean' || typeof compatibility.crossBoard !== 'boolean'
    || compatibility.apFallbackReachable !== true
    || !Array.isArray(summary.warnings) || summary.warnings.length > 32
    || !summary.warnings.every(item => typeof item === 'string' && WARNINGS.has(item))
    || !Array.isArray(summary.excluded) || summary.excluded.length !== Object.keys(EXCLUSIONS).length
    || !summary.excluded.every(item => typeof item === 'string' && Object.hasOwn(EXCLUSIONS, item))
    || new Set(summary.excluded).size !== Object.keys(EXCLUSIONS).length) {
    throw new Error('The restore preview was invalid. No settings were changed.');
  }
  // Retain only the public allowlisted projection. Unknown response fields
  // never enter Vue state even if an upstream regression adds them.
  return {
    restoreId: preview.restoreId,
    destinationGeneration: preview.destinationGeneration,
    expiresAt: preview.expiresAt,
    summary: {
      replacesLinuxOwner: summary.replacesLinuxOwner,
      replacesDeviceCredentials: summary.replacesDeviceCredentials,
      replacesMeshIdentity: summary.replacesMeshIdentity,
      membershipCount: summary.membershipCount,
      networkInterruption: summary.networkInterruption,
      warnings: [...summary.warnings],
      excluded: [...summary.excluded],
      compatibility: {
        adjusted: compatibility.adjusted,
        crossBoard: compatibility.crossBoard,
        unavailableCameras: compatibility.unavailableCameras,
        unavailableUarts: compatibility.unavailableUarts,
        unavailableNetworkInterfaces: compatibility.unavailableNetworkInterfaces,
        apFallbackReachable: true,
      },
    },
  };
}

function safeRequestError(error: unknown, fallback: string): string {
  return error instanceof MaintenanceError ? error.message : fallback;
}

export default defineComponent({
  name: 'RecoveryTools', props: { preview: Boolean },
  data() { return { mode: 'idle' as 'idle' | 'backup' | 'restore' | 'preview', busy: false, currentPassword: '',
    archiveBase64: '', selectedName: '', restorePreview: null as RestorePreview | null, confirmed: false,
    error: '', message: '', archiveSelection: 0, expiryTimer: undefined as ReturnType<typeof setTimeout> | undefined }; },
  computed: {
    exclusionLabels(): string[] { return this.restorePreview?.summary.excluded.map(item => EXCLUSIONS[item]!) ?? []; },
  },
  beforeUnmount() {
    if (this.restorePreview && !this.preview) void maintenanceRequest('recovery/cancel', { restoreId: this.restorePreview.restoreId }).catch(() => {});
    this.clearLocal();
  },
  methods: {
    choose(mode: 'backup' | 'restore') {
      if (this.preview) { this.error = 'Gallery preview. Recovery tools are available only on a device.'; return; }
      this.reset(); this.mode = mode;
    },
    clearFile(invalidatePending = true) {
      if (invalidatePending) this.archiveSelection += 1;
      this.archiveBase64 = ''; this.selectedName = '';
      const input = this.$refs.archiveInput as HTMLInputElement | undefined;
      if (input) input.value = '';
    },
    clearLocal() {
      if (this.expiryTimer) clearTimeout(this.expiryTimer);
      this.expiryTimer = undefined; this.currentPassword = ''; this.clearFile();
      this.restorePreview = null; this.confirmed = false;
    },
    reset() { this.clearLocal(); this.mode = 'idle'; this.error = ''; },
    async readArchive(event: Event) {
      const file = (event.target as HTMLInputElement).files?.[0];
      const selection = ++this.archiveSelection;
      this.error = ''; this.clearFile(false);
      if (!file) return;
      if (file.size < 1 || file.size > MAX_ARCHIVE_BYTES) { this.error = 'Recovery backups must be no larger than 4 MiB.'; return; }
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        try {
          if (selection !== this.archiveSelection) return;
          if (bytes.byteLength !== file.size) throw new Error();
          this.archiveBase64 = toBase64(bytes); this.selectedName = file.name;
        } finally { bytes.fill(0); }
      } catch {
        if (selection === this.archiveSelection) {
          this.clearFile(); this.error = 'The recovery backup could not be read.';
        }
      }
    },
    async downloadBackup() {
      if (this.busy || this.preview) return;
      this.busy = true; this.error = ''; this.message = '';
      try {
        const result = await maintenanceRequest<{ archiveBase64: unknown }>('recovery/export', { currentPassword: this.currentPassword });
        const bytes = archiveBytes(result?.archiveBase64);
        const url = URL.createObjectURL(new Blob([bytes], { type: 'application/json' }));
        try {
          const link = document.createElement('a'); link.href = url;
          link.download = `yonder-recovery-${new Date().toISOString().slice(0, 10)}.json`; link.click();
        } finally { URL.revokeObjectURL(url); bytes.fill(0); }
        this.message = 'Recovery backup downloaded. Store it securely.'; this.mode = 'idle';
      } catch (error) { this.error = safeRequestError(error, 'The recovery backup could not be downloaded.'); }
      finally { this.currentPassword = ''; this.archiveBase64 = ''; this.busy = false; }
    },
    async previewBackup() {
      if (this.busy || this.preview || !this.archiveBase64) return;
      this.busy = true; this.error = ''; this.message = '';
      try {
        const value = await maintenanceRequest('recovery/preview', {
          currentPassword: this.currentPassword, archiveBase64: this.archiveBase64,
        });
        this.restorePreview = checkedPreview(value); this.mode = 'preview';
        const delay = Math.min(0x7fffffff, Math.max(1, this.restorePreview.expiresAt - Date.now()));
        this.expiryTimer = setTimeout(() => { void this.expirePreview(); }, delay);
      } catch (error) { this.error = safeRequestError(error, 'The recovery backup could not be previewed.'); }
      finally { this.currentPassword = ''; this.clearFile(); this.busy = false; }
    },
    async expirePreview() {
      const restoreId = this.restorePreview?.restoreId;
      this.clearLocal(); this.mode = 'idle'; this.message = 'The restore preview expired. Select the backup and preview it again.';
      if (restoreId && !this.preview) await maintenanceRequest('recovery/cancel', { restoreId }).catch(() => {});
    },
    async cancelPreview() {
      if (this.busy) return;
      const restoreId = this.restorePreview?.restoreId;
      this.clearLocal(); this.mode = 'idle'; this.error = ''; this.message = 'Restore cancelled.';
      if (restoreId && !this.preview) {
        try { await maintenanceRequest('recovery/cancel', { restoreId }); }
        catch { this.message = 'Restore preview cleared on this page. It will expire on the device.'; }
      }
    },
    async commitRestore() {
      if (this.busy || !this.restorePreview || !this.confirmed || this.preview) return;
      if (Date.now() >= this.restorePreview.expiresAt) { await this.expirePreview(); return; }
      const request = { currentPassword: this.currentPassword, restoreId: this.restorePreview.restoreId,
        destinationGeneration: this.restorePreview.destinationGeneration, confirm: true };
      this.busy = true; this.error = ''; this.message = '';
      try {
        const result = await maintenanceRequest<{ signInAgain?: unknown }>('recovery/commit', request);
        if (result?.signInAgain !== true) throw new Error('The restore result was not confirmed. Reconnect and check device state.');
        this.clearLocal(); this.mode = 'idle';
        this.message = 'Restore committed. The device is restarting. Reconnect and sign in again.';
      } catch {
        // The request can commit and then lose its reply while services
        // restart. Clear the one-use preview and never replay automatically.
        this.clearLocal(); this.mode = 'idle';
        this.error = 'The restore reply was lost or not confirmed. Do not restore again. Reconnect and check device state before retrying.';
      } finally { this.currentPassword = ''; this.busy = false; }
    },
    formatExpiry(value: number): string { return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); },
  },
});
</script>

<style scoped>
.y-recovery__warning { color: var(--yonder-caution, #ffb020); }
.y-recovery form { display: grid; gap: 14px; max-width: 680px; margin-top: 16px; }
.y-recovery__preview { margin-top: 18px; }
.y-recovery__preview ul { padding-left: 22px; line-height: 1.6; }
.y-recovery__facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; max-width: 760px; }
.y-recovery__facts div { border: 1px solid var(--yonder-divider, #2b333c); border-radius: 4px; padding: 10px; }
.y-recovery__facts dt { color: var(--yonder-label, #7f8a95); font-size: 12px; }
.y-recovery__facts dd { margin: 4px 0 0; font: 600 16px var(--yonder-font-mono, monospace); }
.y-recovery .y-recovery__check { flex-direction: row; align-items: center; font-size: 14px; }
.y-recovery__check input { width: 20px; min-height: 20px; margin: 0; }
</style>
