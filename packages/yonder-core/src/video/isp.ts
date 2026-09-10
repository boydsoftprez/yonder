// SPDX-License-Identifier: GPL-3.0-or-later
import { createConnection } from 'node:net';
import { z } from 'zod';
import type { Detection } from './probe/camera.js';

/** R-CTL-04/10/16: native ISP commands, separate from stream configuration. */
export const ISP_PROFILES = [
  { value: 'normal-light', label: 'Normal Light' },
  { value: 'low-light', label: 'Low Light' },
  { value: 'legacy-low-light', label: 'Original low-light tuning' },
] as const;
const level = z.number().int().min(0).max(255);
const values = z.object({ brightness: level, contrast: level, saturation: level, hue: level });
const profile = z.enum(['normal-light', 'low-light', 'legacy-low-light']);
const command = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('isp-profile'), value: profile }).strict(),
  z.object({ kind: z.literal('isp-control'), control: z.enum(['brightness', 'contrast', 'saturation', 'hue']), value: level }).strict(),
]);
const reply = z.object({
  ok: z.literal(true), profile: profile.nullable(), running: z.boolean(),
  device: z.string(), sensor: z.string(), values,
});
export type IspCommand = z.infer<typeof command>;
export type IspReply = z.infer<typeof reply>;
export interface IspView {
  available: boolean;
  running: boolean;
  profile: IspReply['profile'];
  profiles: typeof ISP_PROFILES;
  values: IspReply['values'] | null;
  reason?: string;
}
export interface IspControls {
  status(): Promise<IspReply>;
  apply(command: IspCommand): Promise<IspReply>;
}
export function parseIspCommand(body: unknown): IspCommand | null {
  const parsed = command.safeParse(body);
  return parsed.success ? parsed.data : null;
}
export function isSeekerHd(found: Detection | undefined): found is Detection {
  return found?.source === 'csi' && /(?:^|_)imx462(?:\s|$)/i.test(found.card);
}
export function matchingIsp(state: IspReply, device: string): boolean {
  return state.device === device && /(?:^|_)imx462(?:\s|$)/i.test(state.sensor);
}
export async function ispView(client: IspControls | undefined, device: string): Promise<IspView> {
  try {
    if (!client) throw new Error('Live ISP controls are not installed.');
    const state = await client.status();
    if (!matchingIsp(state, device)) throw new Error('The ISP service belongs to a different camera.');
    return { available: true, running: state.running, profile: state.profile,
      profiles: ISP_PROFILES, values: state.values,
      ...(!state.running ? { reason: 'Start video to adjust the camera image.' } : {}) };
  } catch (error) {
    return { available: false, running: false, profile: null, profiles: ISP_PROFILES,
      values: null, reason: error instanceof Error ? error.message : 'ISP controls unavailable.' };
  }
}

/** One bounded request per connection. Never retry a timed-out write: its result
 * is uncertain until the next readback. The service owns serialization with AIQ. */
export class SeekerHdIsp implements IspControls {
  constructor(private readonly socketPath = '/run/yonder-seekerhd/isp.sock', private readonly timeoutMs = 5000) {}
  status(): Promise<IspReply> { return this.request('status', Math.min(1000, this.timeoutMs)); }
  apply(input: IspCommand): Promise<IspReply> {
    const parsed = command.parse(input);
    return this.request(parsed.kind === 'isp-profile' ? `profile ${parsed.value}` : `set ${parsed.control} ${parsed.value}`, this.timeoutMs);
  }
  private request(line: string, timeoutMs: number): Promise<IspReply> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      let data = '';
      const timer = setTimeout(() => finish(new Error('ISP command timed out; check the current values before retrying.')), timeoutMs);
      const finish = (error?: Error, result?: IspReply) => {
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else resolve(result!);
      };
      socket.setEncoding('utf8');
      socket.once('connect', () => socket.write(`${line}\n`));
      socket.on('data', chunk => {
        data += chunk;
        if (data.length > 4096) return finish(new Error('ISP reply exceeded its size limit.'));
        const end = data.indexOf('\n');
        if (end < 0) return;
        try {
          const raw = JSON.parse(data.slice(0, end));
          if (raw?.ok === false) return finish(new Error(typeof raw.error === 'string' ? raw.error : 'ISP command refused.'));
          const checked = reply.safeParse(raw);
          if (!checked.success) return finish(new Error('ISP returned an invalid readback.'));
          finish(undefined, checked.data);
        } catch { finish(new Error('ISP returned an invalid reply.')); }
      });
      socket.once('error', () => finish(new Error('The camera ISP control service is unavailable.')));
      socket.once('end', () => { if (!data.includes('\n')) finish(new Error('ISP closed before returning a readback.')); });
    });
  }
}
