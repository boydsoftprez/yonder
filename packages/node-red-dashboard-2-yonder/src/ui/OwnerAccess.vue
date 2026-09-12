<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
  <section class="y-owner" aria-label="Linux account and SSH">
    <h3>Linux account and SSH</h3>
    <p class="y-maint__muted">Use this account with a keyboard and monitor or over SSH. Its password is separate from the console password. Sudo requires the Linux password.</p>
    <p v-if="loading" role="status">Reading Linux access…</p>
    <template v-if="state">
      <p v-if="state.configured">Linux account: <strong>{{ state.username }}</strong>. SSH is <strong>{{ state.sshEnabled ? 'on' : 'off' }}</strong>.</p>
      <form v-if="!state.configured" aria-label="Create Linux account" @submit.prevent="saveAccount">
        <div class="y-owner__fields">
          <label>Linux username<input v-model="username" autocomplete="username" required maxlength="31" :disabled="busy"></label>
          <label>Current console password<input v-model="currentPassword" type="password" autocomplete="current-password" required maxlength="1024" :disabled="busy"></label>
          <label>Linux password<input v-model="newPassword" type="password" autocomplete="new-password" required minlength="8" maxlength="1024" :disabled="busy"></label>
          <label>Confirm Linux password<input v-model="confirmPassword" type="password" autocomplete="new-password" required minlength="8" maxlength="1024" :disabled="busy"></label>
        </div>
        <div class="y-maint__actions"><button class="y-maint__primary" :disabled="busy" type="submit">{{ busy ? 'Saving…' : 'Create Linux account' }}</button></div>
      </form>
      <template v-else>
        <details>
          <summary>Change Linux password</summary>
          <form aria-label="Change Linux password" @submit.prevent="saveAccount">
            <div class="y-owner__fields">
              <label>Current console password<input v-model="currentPassword" type="password" autocomplete="current-password" required maxlength="1024" :disabled="busy"></label>
              <label>New Linux password<input v-model="newPassword" type="password" autocomplete="new-password" required minlength="8" maxlength="1024" :disabled="busy"></label>
              <label>Confirm Linux password<input v-model="confirmPassword" type="password" autocomplete="new-password" required minlength="8" maxlength="1024" :disabled="busy"></label>
            </div>
            <div class="y-maint__actions"><button :disabled="busy" type="submit">Change Linux password</button></div>
          </form>
        </details>
        <form aria-label="SSH access" @submit.prevent="saveSsh">
          <div class="y-owner__fields">
            <label class="y-owner__check"><input v-model="sshEnabled" type="checkbox" :disabled="busy">Enable SSH</label>
            <label class="y-owner__check"><input v-model="passwordAuthentication" type="checkbox" :disabled="busy">Allow the Linux password over SSH</label>
          </div>
          <p class="y-maint__muted">Root login is disabled. Public keys already saved: {{ state.authorizedKeyFingerprints.length }}.</p>
          <ul v-if="state.authorizedKeyFingerprints.length" aria-label="Saved SSH key fingerprints"><li v-for="key in state.authorizedKeyFingerprints" :key="key"><code>{{ key }}</code></li></ul>
          <label class="y-owner__check"><input v-model="replaceKeys" type="checkbox" :disabled="busy">Replace the saved public keys</label>
          <label v-if="replaceKeys" class="y-owner__keyfield">SSH public keys, one per line<textarea v-model="publicKeys" rows="4" autocomplete="off" spellcheck="false" :disabled="busy" maxlength="7000" /></label>
          <p v-if="replaceKeys" class="y-maint__muted">Only the keys entered here will remain. Leave the field empty to remove all saved keys.</p>
          <label class="y-owner__reauth">Current console password<input v-model="sshConsolePassword" type="password" autocomplete="current-password" required maxlength="1024" :disabled="busy"></label>
          <div class="y-maint__actions"><button :disabled="busy" type="submit">Save SSH access</button></div>
        </form>
      </template>
    </template>
    <p v-if="error" class="y-maint__error" role="alert">{{ error }}</p>
    <p v-if="message" role="status">{{ message }}</p>
    <div class="y-maint__actions"><button :disabled="busy || loading" type="button" @click="refresh">Refresh Linux access</button></div>
  </section>
</template>
<script lang="ts">
import { defineComponent } from 'vue';
import { maintenanceRequest } from './maintenance-api.js';
interface OwnerState { configured: boolean; username: string | null; sshEnabled: boolean; sshPasswordAuthentication: boolean; authorizedKeyFingerprints: string[] }
function ownerState(value: unknown): OwnerState {
  const v = value as OwnerState | null;
  if (!v || typeof v.configured !== 'boolean' || !(v.username === null || typeof v.username === 'string')
    || typeof v.sshEnabled !== 'boolean' || typeof v.sshPasswordAuthentication !== 'boolean'
    || !Array.isArray(v.authorizedKeyFingerprints) || !v.authorizedKeyFingerprints.every(key => typeof key === 'string')) throw new Error('Linux access status is unavailable.');
  return v;
}
export default defineComponent({
  name: 'OwnerAccess', props: { preview: Boolean },
  data() { return { state: null as OwnerState | null, loading: false, busy: false, error: '', message: '', username: '',
    currentPassword: '', newPassword: '', confirmPassword: '', sshConsolePassword: '', sshEnabled: false,
    passwordAuthentication: false, replaceKeys: false, publicKeys: '' }; },
  mounted() { void this.refresh(); },
  beforeUnmount() { this.clearSensitive(); },
  methods: {
    clearSensitive() { this.currentPassword = ''; this.newPassword = ''; this.confirmPassword = ''; this.sshConsolePassword = ''; this.publicKeys = ''; this.replaceKeys = false; },
    accept(value: unknown) { this.state = ownerState(value); this.sshEnabled = this.state.sshEnabled; this.passwordAuthentication = this.state.sshPasswordAuthentication; },
    async refresh() {
      this.loading = true; this.error = '';
      try {
        if (this.preview) this.accept({ configured: false, username: null, sshEnabled: false, sshPasswordAuthentication: false, authorizedKeyFingerprints: [] });
        else this.accept(await maintenanceRequest('owner'));
      } catch (error) { this.state = null; this.error = error instanceof Error ? error.message : 'Linux access status is unavailable.'; }
      finally { this.loading = false; }
    },
    async submit(path: string, input: object, success: string) {
      if (this.busy) return;
      if (this.preview) { this.error = 'Gallery preview. Linux access can only be changed on a device.'; this.clearSensitive(); return; }
      this.busy = true; this.error = ''; this.message = '';
      try { this.accept(await maintenanceRequest(path, input)); this.message = success; }
      catch (error) {
        const detail = error instanceof Error ? error.message : 'The change was not confirmed.';
        await this.refresh();
        this.error = detail + (this.state ? ' Current access is shown above. Check it before retrying.' : ' Current access could not be read. Refresh before retrying.');
      } finally { this.clearSensitive(); this.busy = false; }
    },
    async saveAccount() {
      if (this.busy || !this.state) return;
      if (this.newPassword !== this.confirmPassword) { this.error = 'The Linux passwords do not match.'; this.clearSensitive(); return; }
      const input = { currentPassword: this.currentPassword, newPassword: this.newPassword, confirmPassword: this.confirmPassword };
      if (this.state.configured) await this.submit('owner/password', input, 'Linux password changed.');
      else await this.submit('owner/create', { ...input, username: this.username }, 'Linux account created. SSH is off.');
    },
    async saveSsh() {
      if (this.busy || !this.state?.configured) return;
      const keys = this.publicKeys.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      if (this.sshEnabled && !this.passwordAuthentication && (this.replaceKeys ? keys.length === 0 : this.state.authorizedKeyFingerprints.length === 0)) {
        this.error = 'Add a public key or allow password login before enabling SSH.'; this.sshConsolePassword = ''; return;
      }
      await this.submit('owner/ssh', { currentPassword: this.sshConsolePassword, enabled: this.sshEnabled,
        passwordAuthentication: this.passwordAuthentication, ...(this.replaceKeys ? { authorizedKeys: keys } : {}) }, 'SSH access saved.');
    },
  },
});
</script>
<style scoped>
.y-owner__fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 14px; max-width: 900px; margin-top: 16px; }
.y-owner .y-owner__check { flex-direction: row; align-items: center; font-size: 14px; }
.y-owner .y-owner__check input { width: 20px; min-height: 20px; margin: 0; }
.y-owner__reauth { max-width: 440px; margin-top: 16px; }
.y-owner__keyfield { margin-top: 16px; }
.y-owner textarea { padding: 12px; border: 1px solid var(--yonder-divider, #2b333c); background: var(--yonder-pane, #090d12); color: var(--yonder-value, #fff); border-radius: 4px; font: 14px var(--yonder-font-mono, monospace); width: 100%; resize: vertical; }
.y-owner textarea:focus-visible, .y-owner summary:focus-visible { outline: 2px solid var(--yonder-select, #2ad4f0); outline-offset: 3px; }
.y-owner summary { min-height: 44px; padding: 12px 0; cursor: pointer; }
.y-owner li { overflow-wrap: anywhere; margin: 6px 0; }
.y-owner form + form, .y-owner details + form { border-top: 1px solid var(--yonder-divider, #2b333c); margin-top: 20px; padding-top: 8px; }
@media(max-width: 480px) { .y-owner__fields { grid-template-columns: minmax(0, 1fr); } }
</style>
