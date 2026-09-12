// SPDX-License-Identifier: GPL-3.0-or-later
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import RecoveryTools from './RecoveryTools.vue';
import YonderSettings from './YonderSettings.vue';

const wrappers: ReturnType<typeof mount>[] = [];
afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function response(value: unknown, status = 200) {
  return Promise.resolve({ ok: status < 400, status, json: async () => value });
}

const preview = {
  restoreId: '11111111-1111-4111-8111-111111111111',
  destinationGeneration: '22222222-2222-4222-8222-222222222222',
  expiresAt: Date.now() + 600_000,
  summary: {
    replacesLinuxOwner: true,
    replacesDeviceCredentials: true,
    replacesMeshIdentity: true,
    membershipCount: 2,
    networkInterruption: true,
    warnings: [
      'Restoring may disconnect current network and administrator sessions.',
      'Setup AP and fallback remain enabled; unavailable hardware will not start automatically.',
    ],
    excluded: ['recordings', 'browser Flight state', 'custom Node-RED flows and extensions', 'operating-system files'],
    compatibility: { adjusted: true, crossBoard: true, unavailableCameras: 1,
      unavailableUarts: 1, unavailableNetworkInterfaces: 1, apFallbackReachable: true },
  },
};

async function selectArchive(wrapper: ReturnType<typeof mount>, text = '{"private":"fixture"}') {
  const input = wrapper.get('input[type="file"]');
  const bytes = new TextEncoder().encode(text);
  Object.defineProperty(input.element, 'files', { configurable: true, value: [{
    name: 'yonder-recovery.json', size: bytes.byteLength, arrayBuffer: async () => bytes.buffer,
  }] });
  await input.trigger('change');
}

it('captures the selected File before clearing the native file input', async () => {
  vi.stubGlobal('fetch', vi.fn());
  const wrapper = mount(RecoveryTools); wrappers.push(wrapper);
  await wrapper.get('button[data-action="restore"]').trigger('click');
  const input = wrapper.get('input[type="file"]');
  const bytes = new TextEncoder().encode('{"selected":true}');
  const file = { name: 'selected.json', size: bytes.byteLength, arrayBuffer: async () => bytes.buffer };
  let selected = true;
  Object.defineProperty(input.element, 'files', { configurable: true, get: () => selected ? [file] : [] });
  Object.defineProperty(input.element, 'value', { configurable: true, get: () => selected ? 'selected.json' : '',
    set: value => { if (value === '') selected = false; } });
  await input.trigger('change'); await flushPromises();
  expect(wrapper.vm.selectedName).toBe('selected.json');
  expect(atob(wrapper.vm.archiveBase64)).toBe('{"selected":true}');
});

it('keeps the newest archive when two file reads complete out of order', async () => {
  vi.stubGlobal('fetch', vi.fn());
  const wrapper = mount(RecoveryTools); wrappers.push(wrapper);
  await wrapper.get('button[data-action="restore"]').trigger('click');
  const input = wrapper.get('input[type="file"]');
  const firstBytes = new TextEncoder().encode('{"first":true}');
  const secondBytes = new TextEncoder().encode('{"second":true}');
  let resolveFirst!: (value: ArrayBuffer) => void;
  const first = { name: 'first.json', size: firstBytes.byteLength,
    arrayBuffer: () => new Promise<ArrayBuffer>(resolve => { resolveFirst = resolve; }) };
  const second = { name: 'second.json', size: secondBytes.byteLength, arrayBuffer: async () => secondBytes.buffer };
  Object.defineProperty(input.element, 'files', { configurable: true, value: [first] });
  await input.trigger('change');
  Object.defineProperty(input.element, 'files', { configurable: true, value: [second] });
  await input.trigger('change'); await flushPromises();
  expect(wrapper.vm.selectedName).toBe('second.json');
  resolveFirst(firstBytes.buffer); await flushPromises();
  expect(wrapper.vm.selectedName).toBe('second.json');
  expect(atob(wrapper.vm.archiveBase64)).toBe('{"second":true}');
});

it('downloads the plain archive with a credential warning and clears the password and bytes', async () => {
  const secret = '{"passwordHash":"private-hash"}';
  const archiveBase64 = btoa(secret);
  const fetcher = vi.fn(() => response({ archiveBase64 }));
  vi.stubGlobal('fetch', fetcher);
  const createUrl = vi.fn(() => 'blob:yonder-recovery');
  const revokeUrl = vi.fn();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createUrl });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeUrl });
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const wrapper = mount(RecoveryTools); wrappers.push(wrapper);
  expect(wrapper.text()).toContain('Contains passwords and keys. Store securely.');
  await wrapper.get('button[data-action="backup"]').trigger('click');
  await wrapper.get('form[aria-label="Download recovery backup"] input[type="password"]').setValue('console-private');
  await wrapper.get('form[aria-label="Download recovery backup"]').trigger('submit');
  await flushPromises();
  expect(JSON.parse(fetcher.mock.calls[0]![1]!.body)).toEqual({ currentPassword: 'console-private' });
  expect(createUrl).toHaveBeenCalledOnce(); expect(click).toHaveBeenCalledOnce(); expect(revokeUrl).toHaveBeenCalledOnce();
  expect(wrapper.vm.currentPassword).toBe(''); expect(wrapper.vm.archiveBase64).toBe('');
  expect(wrapper.text()).not.toContain('console-private'); expect(wrapper.text()).not.toContain('private-hash');
  click.mockRestore();
});

it('previews bounded file content, renders fixed consequences, and commits only after explicit confirmation', async () => {
  const fetcher = vi.fn((url: string) => url.endsWith('/preview') ? response(preview)
    : url.endsWith('/commit') ? response({ operationId: '33333333-3333-4333-8333-333333333333',
      generation: '44444444-4444-4444-8444-444444444444', signInAgain: true }) : response({ ok: true }));
  vi.stubGlobal('fetch', fetcher);
  const wrapper = mount(RecoveryTools); wrappers.push(wrapper);
  await wrapper.get('button[data-action="restore"]').trigger('click');
  await selectArchive(wrapper);
  await wrapper.get('form[aria-label="Preview recovery backup"] input[type="password"]').setValue('console-private');
  await wrapper.get('form[aria-label="Preview recovery backup"]').trigger('submit'); await flushPromises();
  const previewCall = fetcher.mock.calls.find(call => call[0].endsWith('/preview'))!;
  const previewBody = JSON.parse(previewCall[1]!.body);
  expect(previewBody.currentPassword).toBe('console-private'); expect(atob(previewBody.archiveBase64)).toContain('private');
  expect(wrapper.vm.currentPassword).toBe(''); expect(wrapper.vm.archiveBase64).toBe('');
  expect(wrapper.text()).toContain('2 mesh memberships');
  expect(wrapper.text()).toContain('Linux owner login and credentials will be replaced');
  expect(wrapper.text()).toContain('Setup AP and fallback remain enabled');
  expect(wrapper.text()).toContain('Recordings'); expect(wrapper.text()).toContain('Browser Flight state');
  const commit = wrapper.get('form[aria-label="Confirm recovery restore"]');
  expect(commit.get('button[type="submit"]').attributes('disabled')).toBeDefined();
  await commit.get('input[type="checkbox"]').setValue(true);
  await commit.get('input[type="password"]').setValue('console-again');
  await commit.trigger('submit'); await flushPromises();
  const commitCalls = fetcher.mock.calls.filter(call => call[0].endsWith('/commit'));
  expect(commitCalls).toHaveLength(1);
  expect(JSON.parse(commitCalls[0]![1]!.body)).toEqual({ currentPassword: 'console-again',
    restoreId: preview.restoreId, destinationGeneration: preview.destinationGeneration, confirm: true });
  expect(wrapper.text()).toContain('Reconnect and sign in again');
  expect(wrapper.vm.restorePreview).toBeNull(); expect(wrapper.vm.currentPassword).toBe('');
});

it('never replays a lost commit reply and clears the preview before telling the owner to reconnect', async () => {
  const fetcher = vi.fn((url: string) => url.endsWith('/preview') ? response(preview)
    : url.endsWith('/commit') ? Promise.reject(new Error('connection lost private detail')) : response({ ok: true }));
  vi.stubGlobal('fetch', fetcher);
  const wrapper = mount(RecoveryTools); wrappers.push(wrapper);
  await wrapper.get('button[data-action="restore"]').trigger('click'); await selectArchive(wrapper);
  await wrapper.get('form[aria-label="Preview recovery backup"] input[type="password"]').setValue('password-one');
  await wrapper.get('form[aria-label="Preview recovery backup"]').trigger('submit'); await flushPromises();
  const commit = wrapper.get('form[aria-label="Confirm recovery restore"]');
  await commit.get('input[type="checkbox"]').setValue(true); await commit.get('input[type="password"]').setValue('password-two');
  await commit.trigger('submit'); await flushPromises();
  expect(fetcher.mock.calls.filter(call => call[0].endsWith('/commit'))).toHaveLength(1);
  expect(wrapper.text()).toContain('Do not restore again'); expect(wrapper.text()).toContain('Reconnect and check device state');
  expect(wrapper.text()).not.toContain('private detail'); expect(wrapper.vm.restorePreview).toBeNull();
});

it('refuses oversized files locally and cancels server previews on explicit cancel', async () => {
  const fetcher = vi.fn((url: string) => url.endsWith('/preview') ? response(preview) : response({ ok: true }));
  vi.stubGlobal('fetch', fetcher);
  const wrapper = mount(RecoveryTools); wrappers.push(wrapper);
  await wrapper.get('button[data-action="restore"]').trigger('click');
  const input = wrapper.get('input[type="file"]');
  Object.defineProperty(input.element, 'files', { configurable: true, value: [{ name: 'too-large.json', size: 4 * 1024 * 1024 + 1 }] });
  await input.trigger('change');
  expect(wrapper.text()).toContain('4 MiB'); expect(fetcher).not.toHaveBeenCalled();
  await selectArchive(wrapper); await wrapper.get('form input[type="password"]').setValue('password');
  await wrapper.get('form').trigger('submit'); await flushPromises();
  await wrapper.get('button[data-action="cancel-preview"]').trigger('click'); await flushPromises();
  expect(JSON.parse(fetcher.mock.calls.find(call => call[0].endsWith('/cancel'))![1]!.body)).toEqual({ restoreId: preview.restoreId });
  expect(wrapper.vm.restorePreview).toBeNull(); expect(wrapper.vm.archiveBase64).toBe('');
});

it('expires a preview, clears local state, and asks the device to discard it', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-11T12:00:00Z'));
  const expiring = { ...preview, expiresAt: Date.now() + 100 };
  const fetcher = vi.fn((url: string) => url.endsWith('/preview') ? response(expiring) : response({ ok: true }));
  vi.stubGlobal('fetch', fetcher);
  const wrapper = mount(RecoveryTools); wrappers.push(wrapper);
  await wrapper.get('button[data-action="restore"]').trigger('click'); await selectArchive(wrapper);
  await wrapper.get('form input[type="password"]').setValue('password'); await wrapper.get('form').trigger('submit');
  await flushPromises();
  await vi.advanceTimersByTimeAsync(101); await flushPromises();
  expect(wrapper.text()).toContain('preview expired'); expect(wrapper.vm.restorePreview).toBeNull();
  expect(fetcher.mock.calls.filter(call => call[0].endsWith('/cancel'))).toHaveLength(1);
});

it('drops unknown preview fields without retaining or displaying them', async () => {
  const unsafe = { ...preview, privatePassword: 'private-response-value' };
  const fetcher = vi.fn((url: string) => url.endsWith('/preview') ? response(unsafe) : response({ ok: true }));
  vi.stubGlobal('fetch', fetcher);
  const wrapper = mount(RecoveryTools); wrappers.push(wrapper);
  await wrapper.get('button[data-action="restore"]').trigger('click'); await selectArchive(wrapper);
  await wrapper.get('form input[type="password"]').setValue('password'); await wrapper.get('form').trigger('submit');
  await flushPromises();
  expect(wrapper.text()).toContain('Review this restore');
  expect(wrapper.text()).not.toContain('private-response-value');
  expect(JSON.stringify(wrapper.vm.restorePreview)).not.toContain('private-response-value');
});

it('composes recovery beside the existing owner controls without exposing actions in gallery preview', async () => {
  vi.stubGlobal('fetch', vi.fn(() => response({ theme: 'night' })));
  const wrapper = mount(YonderSettings, { props: { props: { preview: true, theme: 'night' } },
    global: { stubs: { OwnerAccess: { template: '<section aria-label="Linux account and SSH" />' } } } });
  wrappers.push(wrapper); await flushPromises();
  expect(wrapper.find('[aria-label="Linux account and SSH"]').exists()).toBe(true);
  expect(wrapper.find('[aria-label="Recovery backup and restore"]').exists()).toBe(true);
  await wrapper.get('button[data-action="backup"]').trigger('click');
  expect(wrapper.text()).toContain('Gallery preview'); expect(fetch).not.toHaveBeenCalled();
});
