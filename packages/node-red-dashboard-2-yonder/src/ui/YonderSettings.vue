<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
  <section class="y-maint y-settings" aria-label="Settings">
    <section>
      <h3>Appearance</h3>
      <p class="y-maint__muted">Choose the console's day or night palette. The choice is saved on this device.</p>
      <div class="y-maint__actions">
        <button v-for="choice in ['day', 'night']" :key="choice" type="button" :aria-pressed="theme === choice" :disabled="themeBusy" @click="setTheme(choice)">{{ choice === 'day' ? 'Day' : 'Night' }}</button>
      </div>
      <p v-if="themeMessage" role="status">{{ themeMessage }}</p>
    </section>
    <section>
      <h3>Console password</h3>
      <p class="y-maint__muted">Change the Yonder console and flow editor password. Use at least 8 characters. All console and editor sessions will be signed out.</p>
      <form v-if="!changed" @submit.prevent="changePassword">
        <div class="y-settings__passwords">
          <label>Current password<input v-model="currentPassword" type="password" autocomplete="current-password" required maxlength="1024" :disabled="passwordBusy"></label>
          <label>New password<input v-model="newPassword" type="password" autocomplete="new-password" required minlength="8" maxlength="1024" :disabled="passwordBusy"></label>
          <label>Confirm new password<input v-model="confirmPassword" type="password" autocomplete="new-password" required minlength="8" maxlength="1024" :disabled="passwordBusy"></label>
        </div>
        <div class="y-maint__actions"><button class="y-maint__primary" type="submit" :disabled="passwordBusy">{{ passwordBusy ? 'Changing password…' : 'Change password' }}</button></div>
      </form>
      <p v-if="error" class="y-maint__error" role="alert">{{ error }}</p>
      <p v-if="changed" role="status">Password changed. The console is restarting to sign out all sessions. <a href="/login">Sign in with your new password</a>.</p>
    </section>
    <OwnerAccess class="y-settings__wide" :preview="props?.preview === true" />
    <RecoveryTools class="y-settings__wide" :preview="props?.preview === true" />
    <StorageMaintenance class="y-settings__wide" :preview="props?.preview === true" />
  </section>
</template>
<script lang="ts">
import OwnerAccess from './OwnerAccess.vue';
import RecoveryTools from './RecoveryTools.vue';
import StorageMaintenance from './StorageMaintenance.vue';
import { defineComponent } from 'vue';
import { maintenanceRequest } from './maintenance-api.js';
export default defineComponent({
  name: 'YonderSettings', components: { OwnerAccess, RecoveryTools, StorageMaintenance }, props: { id: String, props: Object, msg: Object },
  data() { return { theme: '', themeBusy: false, themeMessage: '', currentPassword: '', newPassword: '', confirmPassword: '', passwordBusy: false, error: '', changed: false }; },
  mounted() {
    if (this.props?.preview === true) { this.theme = this.props.theme as string; return; }
    void maintenanceRequest<{ theme: string }>('preferences').then(v => { this.theme = v.theme; }).catch(() => { this.themeMessage = 'Could not read the saved palette.'; });
  },
  beforeUnmount() { this.clearPasswords(); },
  methods: {
    clearPasswords() { this.currentPassword = ''; this.newPassword = ''; this.confirmPassword = ''; },
    async setTheme(theme: string) {
      if (this.props?.preview === true) { this.theme = theme; return; }
      if (this.themeBusy) return; this.themeBusy = true; this.themeMessage = '';
      try {
        const result = await maintenanceRequest<{ state?: string; reason?: string }>('theme', { theme });
        if (result.state === 'rejected' || result.state === 'failed') throw new Error(result.reason || 'The palette could not be saved.');
        const observed = await maintenanceRequest<{ theme: string }>('preferences');
        if (observed.theme !== theme) throw new Error('The selected palette was not saved.');
        this.theme = theme; this.themeMessage = 'Palette saved.';
        // Refresh the generated stylesheet without signing out or reloading the page.
        for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
          const url = new URL(link.href, location.href);
          if (url.origin === location.origin && url.pathname.endsWith('/theme.css')) { url.searchParams.set('v', String(Date.now())); link.href = url.href; }
        }
      } catch (error) { this.themeMessage = error instanceof Error ? error.message : 'Could not change the palette.'; }
      finally { this.themeBusy = false; }
    },
    async changePassword() {
      if (this.props?.preview === true) { this.error = 'Gallery preview. Passwords can only be changed on a device.'; this.clearPasswords(); return; }
      if (this.passwordBusy || this.changed) return;
      this.error = '';
      if (this.newPassword !== this.confirmPassword) { this.error = 'The new passwords do not match.'; return; }
      this.passwordBusy = true;
      try {
        await maintenanceRequest('password', { currentPassword: this.currentPassword, newPassword: this.newPassword, confirmPassword: this.confirmPassword });
        this.changed = true;
      } catch (error) { this.error = error instanceof Error ? error.message : 'The password change was not confirmed.'; }
      finally { this.clearPasswords(); this.passwordBusy = false; }
    },
  },
});
</script>
<style src="./maintenance.css"></style>
<style scoped>
.y-settings { display: grid; grid-template-columns: minmax(220px, 1fr) minmax(280px, 2fr); gap: 28px; }
.y-settings > section + section { border-left: 1px solid var(--yonder-divider, #2b333c); padding-left: 28px; }
.y-settings__passwords { display: grid; gap: 14px; max-width: 560px; }
.y-settings > .y-settings__wide { grid-column: 1 / -1; border-left: 0; border-top: 1px solid var(--yonder-divider, #2b333c); padding: 24px 0 0; }
a { color: var(--yonder-select, #2ad4f0); }
@media(max-width: 700px) { .y-settings { grid-template-columns: minmax(0, 1fr); } .y-settings > section + section { border-left: 0; border-top: 1px solid var(--yonder-divider, #2b333c); padding: 24px 0 0; } }
</style>
