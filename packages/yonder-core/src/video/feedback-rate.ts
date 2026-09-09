// SPDX-License-Identifier: GPL-3.0-or-later
import { PREVIEW_RUNGS, type Camera } from '../schema/config.js';
import type { Decision, LinkReport, RateChannel, RateThresholds } from './rate.js';
import type { EncodeName, RunningEncodes } from './pipeline.js';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type State = { sample: number; changed: number; healthy: number | null; congested: number | null; refused: number | null; refusedFrom: number | null; policy: string };
/** Receiver-feedback fallback. A probe target is never reported as measured capacity. */
export class FeedbackRate {
  private readonly histories = new Map<string, Array<{ at: number; rtt: number }>>();
  private readonly states = new Map<EncodeName, State>();
  private busy = false;
  private refusedSize: string | null = null;
  constructor(private readonly channel: RateChannel, private readonly timings: RateThresholds,
    private readonly track: (work: Promise<void>) => void) {}

  get pending(): boolean { return this.busy; }

  observe(report: LinkReport): void {
    for (const [viewer, history] of this.histories) if (!history.length || report.at - history[history.length - 1].at > 60000) this.histories.delete(viewer);
    const history = (this.histories.get(report.viewer) ?? []).filter(sample => sample.at <= report.at && report.at - sample.at <= 30_000);
    history.push({ at: report.at, rtt: report.rtt });
    this.histories.set(report.viewer, history.slice(-64));
  }
  baseline(report: LinkReport, now: number): number {
    const history = (this.histories.get(report.viewer) ?? []).filter(sample => sample.at <= now && now - sample.at <= 30_000);
    return history.length ? Math.min(...history.map(sample => sample.rtt)) : report.rtt;
  }
  tick(camera: Camera, running: RunningEncodes, reports: readonly LinkReport[], now: number): Decision[] {
    const active = new Set(reports.map(report => report.viewer));
    for (const viewer of this.histories.keys()) if (!active.has(viewer)) this.histories.delete(viewer);
    const reason = 'Waiting for fresh receiver feedback. Browser bitrate estimates are not independent link-capacity measurements.';
    const decisions: Array<Mutable<Decision>> = [
      { action: 'hold-rate', camera: camera.id, encode: 'stream', kbps: running.stream, at: now, reason },
      { action: 'hold-rate', camera: camera.id, encode: 'preview', kbps: running.preview, at: now, reason },
      { action: 'hold-size', camera: camera.id, encode: 'preview', size: running.shape?.size ?? null, at: now, reason },
    ];
    for (const [index, encode] of (['stream', 'preview'] as const).entries()) {
      const policy = encode === 'stream' ? camera.stream : camera.preview;
      const rate = running[encode];
      const matching = reports.filter(report => (report.encode ?? 'preview') === encode);
      const decision = decisions[index];
      if (policy.mode === 'fixed') { decision.reason = 'Fixed bitrate is selected.'; continue; }
      if (rate === null) { decision.reason = 'Waiting for encoder readback.'; continue; }
      let state = this.states.get(encode);
      const policyKey = JSON.stringify(policy);
      if (!state || now < state.sample || state.policy !== policyKey) {
        state = { sample: -Infinity, changed: -Infinity, healthy: null, congested: null, refused: null, refusedFrom: null, policy: policyKey };
        this.states.set(encode, state);
      }
      const clamp = (value: number) => Math.min(policy.ceiling_kbps, Math.max(policy.floor_kbps, value));
      let target = clamp(rate);
      let why = `Restoring the applied ${policy.floor_kbps}–${policy.ceiling_kbps} kb/s bounds.`;
      if (target === rate) {
        if (!matching.length) { state.healthy = null; state.congested = null; decision.reason = 'No receiver feedback for this output; its bitrate is held.'; continue; }
        const newest = Math.max(...matching.map(report => report.at));
        if (newest <= state.sample) continue;
        if (newest - state.sample > (this.timings.staleAfterMs ?? 6000)) { state.healthy = null; state.congested = null; }
        state.sample = newest;
        const loss = Math.max(...matching.map(report => report.loss));
        const queued = matching.some(report => report.rtt > this.baseline(report, now) + (this.timings.rttInflationMs ?? 100));
        const congested = loss > 0.02 || queued;
        const receiving = matching.every(report => report.egress > 0);
        if (congested) { state.congested ??= now; state.healthy = null; }
        else if (receiving) { state.healthy ??= now; state.congested = null; }
        else { state.healthy = null; state.congested = null; }
        why = congested ? `Receiver congestion (${(loss * 100).toFixed(1)}% loss${queued ? ', RTT increased' : ''}).`
          : receiving ? `Receiver delivery is healthy; probing within ${policy.floor_kbps}–${policy.ceiling_kbps} kb/s.` : 'No received video to evaluate; holding the rate.';
        decision.reason = why;
        if (this.busy) { decision.reason = 'Waiting for the encoder to confirm the preceding change.'; continue; }
        if (congested && now - state.congested! >= 1000 && now - state.changed >= 1000) {
          target = clamp(Math.floor(rate * 0.75 / 50) * 50);
        } else if (receiving && state.healthy !== null && now - state.healthy >= 5000 && now - state.changed >= 5000) {
          target = clamp(rate + Math.max(50, Math.round(Math.min(200, rate * 0.1) / 50) * 50));
        }
        if (encode === 'preview' && target === rate && camera.preview.size === 'auto' && running.shape) {
          const here = PREVIEW_RUNGS.indexOf(running.shape.size);
          const top = PREVIEW_RUNGS.indexOf(camera.preview.ladder_top), bottom = PREVIEW_RUNGS.indexOf(camera.preview.ladder_bottom);
          const down = congested && rate <= policy.floor_kbps && state.congested !== null && now - state.congested >= this.timings.tDown;
          const up = receiving && !congested && rate >= policy.ceiling_kbps && state.healthy !== null && now - state.healthy >= this.timings.tUp;
          const next = here < top ? top : here > bottom ? bottom : down && here < bottom ? here + 1 : up && here > top ? here - 1 : here;
          if (here >= 0 && next >= 0 && next !== here) {
            this.busy = true; state.healthy = null; state.congested = null;
            const size = PREVIEW_RUNGS[next];
            const request = `${running.shape.size}:${size}:${running.shape.fps}`;
            if (this.refusedSize === request) {
              this.busy = false; decisions[2].reason = "The encoder refused this preview size."; continue;
            }
            this.track(this.channel.reconfigurePreview(camera, { size, fps: running.shape.fps }).then(ack => { this.refusedSize = "notControllable" in ack ? request : null; }, () => { this.refusedSize = request; })
              .finally(() => { this.busy = false; }));
            decisions[2] = { action: 'size', camera: camera.id, encode: 'preview', size, at: now, reason: why };
          } else decisions[2].reason = camera.preview.size === 'auto' ? why : 'The preview size is held by the operator.';
        }
      }
      if (target !== rate && !this.busy) {
        if (state.refused === target && state.refusedFrom === rate) { decision.reason = 'The encoder refused that rate; waiting for a different request or policy.'; continue; }
        this.busy = true; state.refusedFrom = rate; state.changed = now; state.healthy = null;
        this.track(this.channel.retune(camera, encode, target).then(ack => {
          if ('notControllable' in ack) state!.refused = target;
          else state!.refused = null;
        }, () => { state!.refused = target; }).finally(() => { this.busy = false; }));
        decisions[index] = { action: 'rate', camera: camera.id, encode, kbps: target, at: now,
          reason: `${why} Requesting ${target} kb/s from delivery feedback; this is not a measured link-capacity value.` };
      }
    }
    if (decisions[2].action === 'hold-size' && decisions[2].reason === reason) decisions[2].reason = decisions[1].reason;
    return decisions;
  }
}
