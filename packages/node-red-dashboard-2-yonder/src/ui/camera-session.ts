// SPDX-License-Identifier: GPL-3.0-or-later
const EVENT = 'yonder-camera-session-expired';
const ATTRIBUTE = 'data-yonder-camera-auth';
export const cameraNeedsSignIn = () => typeof document !== 'undefined' && document.documentElement.getAttribute(ATTRIBUTE) === 'expired';
/** The DOM/event boundary works across independently bundled Dashboard widgets. */
export function expireCameraSession(): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute(ATTRIBUTE, 'expired');
  window.dispatchEvent(new Event(EVENT));
}
export async function checkCameraSession(): Promise<void> {
  if (typeof document === 'undefined' || document.documentElement.hasAttribute('data-yonder-auth-check')) return;
  document.documentElement.setAttribute('data-yonder-auth-check', 'pending');
  const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 3000);
  try { const response = await fetch('/session', { credentials: 'same-origin', cache: 'no-store', signal: abort.signal }); if (response.status === 401) expireCameraSession(); }
  catch { /* A network failure is not proof that a login expired. */ }
  finally { clearTimeout(timer); document.documentElement.removeAttribute('data-yonder-auth-check'); }
}
export const cameraSessionMixin = {
  data: () => ({ signInRequired: cameraNeedsSignIn(), cameraSessionListener: null as null | (() => void) }),
  computed: {
    signInHref: () => typeof window === 'undefined' ? '/dashboard/camera' : '/login?returnTo=' + encodeURIComponent(window.location.pathname),
  },
  mounted(this: any) {
    this.cameraSessionListener = () => { this.signInRequired = true; this.onCameraSessionExpired?.(); };
    window.addEventListener(EVENT, this.cameraSessionListener);
    if (this.signInRequired) this.onCameraSessionExpired?.();
    this.$socket?.on?.('connect', checkCameraSession);
    void checkCameraSession();
  },
  beforeUnmount(this: any) { this.$socket?.off?.('connect', checkCameraSession); if (this.cameraSessionListener) window.removeEventListener(EVENT, this.cameraSessionListener); },
};
