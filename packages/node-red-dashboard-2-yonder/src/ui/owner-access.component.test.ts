// SPDX-License-Identifier: GPL-3.0-or-later
import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import OwnerAccess from './OwnerAccess.vue';
const wrappers: ReturnType<typeof mount>[] = [];
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); vi.unstubAllGlobals(); });
const empty = { configured: false, username: null, sshEnabled: false, sshPasswordAuthentication: false, authorizedKeyFingerprints: [] };
const configured = { ...empty, configured: true, username: 'pilot', authorizedKeyFingerprints: ['SHA256:saved-public-key'] };
function response(value: unknown, status = 200) { return Promise.resolve({ ok: status < 400, status, json: async () => value }); }
async function setup(state = empty) {
  const fetcher = vi.fn((url: string) => response(url.endsWith('/owner') ? state : configured));
  vi.stubGlobal('fetch', fetcher);
  const wrapper = mount(OwnerAccess); wrappers.push(wrapper); await flushPromises();
  return { wrapper, fetcher };
}
it('creates an owner using hidden passwords and clears every sensitive field after submission', async () => {
  const { wrapper, fetcher } = await setup();
  const form = wrapper.get('form[aria-label="Create Linux account"]');
  await form.get('input[autocomplete="username"]').setValue('pilot');
  const passwords = form.findAll('input[type="password"]');
  await passwords[0]!.setValue('console-fixture'); await passwords[1]!.setValue('linux-fixture'); await passwords[2]!.setValue('linux-fixture');
  await form.trigger('submit'); await flushPromises();
  const request = fetcher.mock.calls.find(call => call[0].endsWith('/owner/create'))!;
  expect(JSON.parse((request as unknown as [string, RequestInit])[1].body as string)).toEqual({ username: 'pilot', currentPassword: 'console-fixture', newPassword: 'linux-fixture', confirmPassword: 'linux-fixture' });
  expect(wrapper.text()).toContain('Linux account created');
  expect(wrapper.vm.currentPassword).toBe(''); expect(wrapper.vm.newPassword).toBe(''); expect(wrapper.vm.confirmPassword).toBe('');
  expect(wrapper.text()).not.toContain('linux-fixture');
});
it('keeps saved keys when changing SSH policy and requires explicit replacement to clear them', async () => {
  const { wrapper, fetcher } = await setup(configured);
  const form = wrapper.get('form[aria-label="SSH access"]');
  await form.findAll('input[type="checkbox"]')[0]!.setValue(true);
  await form.get('input[type="password"]').setValue('console-fixture');
  await form.trigger('submit'); await flushPromises();
  const request = fetcher.mock.calls.find(call => call[0].endsWith('/owner/ssh'))!;
  const body = JSON.parse((request as unknown as [string, RequestInit])[1].body as string);
  expect(body).toMatchObject({ enabled: true, passwordAuthentication: false });
  expect(body).not.toHaveProperty('authorizedKeys');
  expect(wrapper.vm.sshConsolePassword).toBe('');
});
it('checks state after a lost reply without repeating the mutation', async () => {
  const { wrapper, fetcher } = await setup();
  fetcher.mockImplementation((url: string) => url.endsWith('/owner/create') ? Promise.reject(Error('Connection lost')) : response(configured));
  const form = wrapper.get('form');
  await form.get('input[autocomplete="username"]').setValue('pilot');
  for (const input of form.findAll('input[type="password"]')) await input.setValue('fixture-password');
  await form.trigger('submit'); await flushPromises();
  expect(fetcher.mock.calls.filter(call => call[0].endsWith('/owner/create'))).toHaveLength(1);
  expect(wrapper.text()).toContain('Current access is shown above');
  expect(wrapper.text()).toContain('pilot');
  expect(wrapper.vm.newPassword).toBe('');
});
it('fails closed on unreadable status and makes no mutation from the gallery', async () => {
  vi.stubGlobal('fetch', vi.fn(() => response({ error: 'Unavailable' }, 503)));
  const failed = mount(OwnerAccess); wrappers.push(failed); await flushPromises();
  expect(failed.find('form').exists()).toBe(false);
  const preview = mount(OwnerAccess, { props: { preview: true } }); wrappers.push(preview); await flushPromises();
  const before = vi.mocked(fetch).mock.calls.length;
  for (const input of preview.findAll('input[type="password"]')) await input.setValue('fixture-password');
  await preview.get('form').trigger('submit'); await flushPromises();
  expect(vi.mocked(fetch).mock.calls.length).toBe(before);
  expect(preview.vm.newPassword).toBe('');
});
