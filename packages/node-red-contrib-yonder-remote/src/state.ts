// SPDX-License-Identifier: GPL-3.0-or-later
import { clientFor, fetched, readFailure } from "yonder-core";
import type { DaemonClient, RemoteState } from "yonder-core";
import type { RED, RedNode } from "./red.js";
import { formatBytes, formatLastHeard, formatRate, formatSpan } from "./format.js";

/**
 * What one sample in the sparkline's series is worth, in milliseconds.
 *
 * The daemon's sampler owns the real interval; this mirrors it so the span can
 * be stated in words. Named here rather than inferred from timestamps so that
 * if the two ever disagree the span is wrong out loud rather than quietly.
 */
const SAMPLE_INTERVAL_MS = 2_000;

/** A CIDR-suffixed address, for the one-line summary that has no room for it. */
function withoutPrefixLength(address: string): string {
  return address.replace(/\/\d+$/, "");
}

/**
 * One object per state, so no widget has to know a client's vocabulary.
 *
 * `waiting` is its own field rather than a comparison the page makes, because
 * it is the state this whole surface is shaped around and it is neither a fault
 * nor a connection (R-VPN-06).
 *
 * `now` is a parameter, not a call to `Date.now()` in here, so `lastHeard`
 * never makes a test race the wall clock — the default is only what a real
 * node falls back on.
 */
export function messageFor(state: RemoteState, now: number = Date.now()): {
  payload: {
    label: string;
    waiting: boolean;
    networkId: string | null;
    deviceId: string | null;
    address: string | null;
    detail: string | null;
    networkName: string | null;
    /** In words, never a boolean a widget would have to translate (R-VPN-03). */
    path: "Direct" | "Relayed" | null;
    /** `null` when unknown - never "0 ms", which would report a measurement that was never taken. */
    latency: string | null;
    traffic: string | null;
    /** R-NET-10: a rate, e.g. "1.4 Mbps down · 300 kbps up" - `traffic` above stays the running total. */
    throughput: string | null;
    /** What the sparkline draws: the same history, split into two plain arrays. */
    series: { rx: number[]; tx: number[] };
    /** The ceiling the sparkline is drawn against, already in words (R-UI-09). */
    peak: string | null;
    /** How much time the sparkline covers, already in words. */
    span: string | null;
    lastHeard: string | null;
    summary: string;
  };
} {
  const label =
    state.phase === "off"
      ? "Not configured"
      : state.phase === "no-client"
        ? "The mesh client is not installed"
        : state.phase === "joining"
          ? "Joining…"
          : state.phase === "waiting-for-approval"
            ? "Waiting for you to approve it"
            : state.phase === "connected"
              ? "Connected"
              : // Authorised, and the client still holds a valid configuration for
                // the network — it simply cannot reach anything right now. That is
                // not a fault: it is what an aircraft looks like between one uplink
                // and the next, and calling it a fault would send an operator
                // looking for a broken configuration that is not broken (R-VPN-10).
                state.phase === "no-path"
                ? "Authorised, not reaching the network"
                : (state.detail ?? "Fault");

  // R-VPN-03: direct or relayed, in words - never a boolean a widget would
  // have to translate, and never guessed when the client did not say.
  const path = state.relayed === false ? "Direct" : state.relayed === true ? "Relayed" : null;

  // R-VPN-10's load-bearing distinction: an unmeasured latency and a measured
  // zero are opposite facts, so `null` stays `null` all the way to the page
  // rather than becoming "0 ms".
  // Checked for being a finite number rather than compared to `null`: a daemon
  // older than this console omits these fields entirely, so they arrive
  // `undefined`, and `=== null` waves that straight through. See formatBytes
  // for what that cost on a board.
  const latencyMs = typeof state.latencyMs === "number" && Number.isFinite(state.latencyMs)
    ? state.latencyMs
    : null;
  const latency = latencyMs === null ? null : `${String(latencyMs)} ms`;

  const traffic =
    formatBytes(state.rxBytes) === null || formatBytes(state.txBytes) === null
      ? null
      : `${String(formatBytes(state.rxBytes))} in · ${String(formatBytes(state.txBytes))} out`;

  // R-NET-10: a rate, never the running total `traffic` already carries -
  // "this link has carried 1.5 MB" and "it is doing 1.4 Mbps right now" are
  // different questions, and both are shown. `formatRate` already treats
  // anything that is not a finite number as unknown, which is what makes the
  // upgrade window safe here too: a daemon older than this console never
  // sent these fields, so they arrive `undefined`, and `formatRate` reads
  // that the same way it reads `null` (see formatRate's own comment).
  const throughput =
    formatRate(state.rxBitsPerSecond) === null || formatRate(state.txBitsPerSecond) === null
      ? null
      : `${String(formatRate(state.rxBitsPerSecond))} down · ${String(formatRate(state.txBitsPerSecond))} up`;

  // The sparkline's own shape: two parallel arrays rather than an array of
  // {rx, tx} pairs, so the widget does not have to unzip one. Guarded with
  // `Array.isArray` rather than trusted from the type, for the same upgrade
  // reason as above - an older daemon's state has no `throughputHistory` at
  // all, and a `.map` over `undefined` is exactly the shape of throw that
  // crash-looped a board on formatBytes before this file guarded it.
  const series = Array.isArray(state.throughputHistory)
    ? { rx: state.throughputHistory.map((s) => s.rx), tx: state.throughputHistory.map((s) => s.tx) }
    : { rx: [], tx: [] };

  // R-UI-09: a bounded quantity is drawn against its bounds. The sparkline
  // fits itself to the tallest value in its own window, so a flat trace and a
  // busy one are the same picture unless the ceiling is printed beside it —
  // and one spike quietly shrinks everything before it. The peak is that
  // ceiling, formatted here so the instrument stays ignorant of units, and the
  // span says how much time the shape covers.
  const peakBits = Math.max(0, ...series.rx, ...series.tx);
  const peak = series.rx.length === 0 ? null : formatRate(peakBits);
  const span = series.rx.length === 0 ? null : formatSpan(series.rx.length * SAMPLE_INTERVAL_MS);

  const address = state.addresses[0] ?? null;

  // The Status page's one line. Nothing configured says so and nothing else;
  // otherwise every part that is actually known joins in, in the order an
  // operator would ask for it, and a part that is not known is left out
  // rather than printed empty.
  const summary =
    state.phase === "off"
      ? "not configured"
      : ["zerotier", path?.toLowerCase() ?? null, latency, address === null ? null : withoutPrefixLength(address)]
          .filter((part): part is string => part !== null)
          .join(" · ");

  return {
    payload: {
      label,
      waiting: state.phase === "waiting-for-approval",
      networkId: state.networkId,
      deviceId: state.deviceId,
      address,
      detail: state.detail,
      networkName: state.networkName ?? null,
      path,
      latency,
      traffic,
      throughput,
      series,
      peak,
      span,
      lastHeard: formatLastHeard(state.lastHeardMs, now),
      summary,
    },
  };
}

/**
 * `yonder-remote-state` — where the mesh join stands, in an operator's words
 * (R-VPN-01, R-UI-05).
 *
 * A read, shaped by `messageFor` rather than passed through raw: the page
 * that shows this never learns a client's vocabulary (`ACCESS_DENIED`,
 * `REQUESTING_CONFIGURATION`), only the words above.
 */
interface StateNode extends RedNode {
  client: DaemonClient;
}

/**
 * `export default` rather than `export =`: this file also carries the named
 * export `messageFor`, and TypeScript does not allow the two export forms
 * together. Node-RED's loader already unwraps a `__esModule` default export
 * (`r = r.__esModule ? r.default : r` in `@node-red/registry`), which is
 * exactly what `esModuleInterop` produces here, so this registers the same
 * way `export =` does in the sibling packages.
 */
export default function register(RED: RED): void {
  RED.nodes.registerType("yonder-remote-state", function registered(this: RedNode, config) {
    RED.nodes.createNode(this, config);
    const node = this as StateNode;
    node.client = clientFor(RED.settings);

    node.on("input", (_msg, send, done) => {
      void (async () => {
        const result = fetched(await node.client.request({ method: "GET", path: "/remote/state" }));
        if (!result.ok) {
          node.status({ fill: "red", shape: "ring", text: "not answering" });
          send({ payload: null, yonder: readFailure(result.message, Date.now()) });
          done();
          return;
        }
        const state = result.value as RemoteState;
        node.status({ fill: "green", shape: "dot", text: state.phase });
        send(messageFor(state));
        done();
      })();
    });
  });
};
