// SPDX-License-Identifier: GPL-3.0-or-later
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import StorageMaintenance from './StorageMaintenance.vue';

const OPERATION = '11111111-1111-4111-8111-111111111111';
const wrappers: ReturnType<typeof mount>[] = [];
afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount());
  vi.unstubAllGlobals();
});
function response(value: unknown, status = 200) {
  return Promise.resolve({ ok: status < 400, status, json: async () => value });
}

const protectedState = { managed: true, mode: 'protected', ownerConfigured: true, operation: null };
const awaitingState = { ...protectedState,
  operation: { id: OPERATION, kind: 'maintenance', phase: 'awaiting-maintenance-reboot' } };
const maintenanceState = { managed: true, mode: 'maintenance', ownerConfigured: true,
  operation: { id: OPERATION, kind: 'maintenance', phase: 'entered-maintenance' } };

it('shows observed protection and schedules maintenance only after explicit reauthentication', async () => {
  const fetcher = vi.fn()
    .mockImplementationOnce(() => response({ ...protectedState, ignoredPrivate: 'do-not-retain' }))
    .mockImplementationOnce(() => response({ ok: true, operationId: OPERATION, message: 'server wording ignored' }))
    .mockImplementationOnce(() => response(awaitingState));
  vi.stubGlobal('fetch', fetcher);
  const wrapper = mount(StorageMaintenance); wrappers.push(wrapper); await flushPromises();

  expect(wrapper.text()).toContain('Observed modeProtected');
  expect(wrapper.text()).toContain('Storage is protected');
  expect(wrapper.text()).toContain('Recovery backup and restore');
  expect(wrapper.text()).toContain('Power loss during package maintenance');
  expect(wrapper.find('input[type="password"]').exists()).toBe(false);
  expect(JSON.stringify(wrapper.vm.storage)).not.toContain('do-not-retain');

  await wrapper.get('button[data-action="enter"]').trigger('click');
  const form = wrapper.get('form[aria-label="Confirm writable maintenance"]');
  expect(form.get('button[type="submit"]').attributes('disabled')).toBeDefined();
  await form.get('input[type="checkbox"]').setValue(true);
  await form.get('input[type="password"]').setValue('private-console-password');
  await form.trigger('submit'); await flushPromises();

  const mutation = fetcher.mock.calls[1]!;
  expect(mutation[0]).toBe('/maintenance/api/storage/enter');
  expect(JSON.parse(mutation[1].body)).toEqual({ currentPassword: 'private-console-password', confirm: 'MAINTENANCE' });
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(wrapper.vm.currentPassword).toBe(''); expect(wrapper.vm.confirmed).toBe(false);
  expect(wrapper.text()).not.toContain('private-console-password');
  expect(wrapper.text()).not.toContain('server wording ignored');
  expect(wrapper.text()).toContain('Maintenance reboot scheduled');
  expect(wrapper.text()).toContain('waiting for the maintenance reboot');
  expect(wrapper.get('button[data-action="enter"]').text()).toBe('Retry maintenance reboot');
});

it('uses the same confirmed enter request to retry an awaiting maintenance reboot', async () => {
  const fetcher = vi.fn()
    .mockImplementationOnce(() => response(awaitingState))
    .mockImplementationOnce(() => response({ ok: true, operationId: OPERATION, message: 'scheduled' }))
    .mockImplementationOnce(() => response(awaitingState));
  vi.stubGlobal('fetch', fetcher);
  const wrapper = mount(StorageMaintenance); wrappers.push(wrapper); await flushPromises();

  expect(wrapper.text()).toContain('Retry the reboot only if');
  await wrapper.get('button[data-action="enter"]').trigger('click');
  const form = wrapper.get('form');
  await form.get('input[type="checkbox"]').setValue(true);
  await form.get('input[type="password"]').setValue('password');
  await form.trigger('submit'); await flushPromises();
  expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual({ currentPassword: 'password', confirm: 'MAINTENANCE' });
  expect(fetcher.mock.calls.filter(call => call[0].endsWith('/enter'))).toHaveLength(1);
});

it('leaves writable maintenance through the protected reboot action', async () => {
  const fetcher = vi.fn()
    .mockImplementationOnce(() => response(maintenanceState))
    .mockImplementationOnce(() => response({ ok: true, operationId: OPERATION, message: 'rebooting' }))
    .mockImplementationOnce(() => response(protectedState));
  vi.stubGlobal('fetch', fetcher);
  const wrapper = mount(StorageMaintenance); wrappers.push(wrapper); await flushPromises();

  expect(wrapper.text()).toContain('Writable maintenance is active');
  await wrapper.get('button[data-action="exit"]').trigger('click');
  const form = wrapper.get('form[aria-label="Confirm protected reboot"]');
  await form.get('input[type="checkbox"]').setValue(true);
  await form.get('input[type="password"]').setValue('password');
  await form.trigger('submit'); await flushPromises();

  expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual({ currentPassword: 'password', confirm: 'PROTECT' });
  expect(wrapper.text()).toContain('Protected reboot scheduled');
  expect(wrapper.text()).toContain('Observed modeProtected');
});

it('makes actions unavailable for conventional installs, missing owners, and another operation', async () => {
  const states = [
    { managed: false, mode: 'writable', ownerConfigured: true, operation: null },
    { ...protectedState, ownerConfigured: false },
    { ...protectedState, operation: { id: OPERATION, kind: 'restore', phase: 'staging' } },
  ];
  const expected = [
    'Protected-storage maintenance actions are not available',
    'Create the Linux owner account above',
    'Another device operation must finish',
  ];
  for (let index = 0; index < states.length; index += 1) {
    const fetcher = vi.fn(() => response(states[index])); vi.stubGlobal('fetch', fetcher);
    const wrapper = mount(StorageMaintenance); wrappers.push(wrapper); await flushPromises();
    expect(wrapper.text()).toContain(expected[index]);
    expect(wrapper.find('button[data-action="enter"]').exists()).toBe(false);
    expect(wrapper.find('button[data-action="exit"]').exists()).toBe(false);
  }
});

it('never retries a mutation after a lost reply, clears the password, and refreshes observed status once', async () => {
  const fetcher = vi.fn()
    .mockImplementationOnce(() => response(protectedState))
    .mockImplementationOnce(() => Promise.reject(new Error('private transport detail')))
    .mockImplementationOnce(() => response(awaitingState));
  vi.stubGlobal('fetch', fetcher);
  const wrapper = mount(StorageMaintenance); wrappers.push(wrapper); await flushPromises();
  await wrapper.get('button[data-action="enter"]').trigger('click');
  const form = wrapper.get('form');
  await form.get('input[type="checkbox"]').setValue(true);
  await form.get('input[type="password"]').setValue('private-console-password');
  await form.trigger('submit'); await flushPromises();

  expect(fetcher.mock.calls.filter(call => call[0].endsWith('/enter'))).toHaveLength(1);
  expect(fetcher.mock.calls.filter(call => call[0] === '/maintenance/api/storage')).toHaveLength(2);
  expect(wrapper.text()).toContain('reply was lost or not confirmed');
  expect(wrapper.text()).toContain('Do not repeat the action automatically');
  expect(wrapper.text()).toContain('waiting for the maintenance reboot');
  expect(wrapper.text()).not.toContain('private transport detail');
  expect(wrapper.vm.currentPassword).toBe('');
});

it('renders a safe gallery state without making a request or exposing an action form', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  const wrapper = mount(StorageMaintenance, { props: { preview: true } }); wrappers.push(wrapper); await flushPromises();
  expect(wrapper.text()).toContain('Observed modeProtected');
  expect(wrapper.find('input[type="password"]').exists()).toBe(false);
  await wrapper.get('button[data-action="enter"]').trigger('click');
  expect(wrapper.text()).toContain('Gallery preview');
  expect(fetcher).not.toHaveBeenCalled();
});
