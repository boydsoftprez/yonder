// SPDX-License-Identifier: GPL-3.0-or-later
import type { Config } from "../../schema/config.js";
import type { BearerInfo, ModemInfo, SignalReading } from "./mmcli/client.js";

export type ModemMode =
  | "absent"        // nothing found, and the operator did not name one
  | "unconfigured"  // a modem is here and config.yaml says nothing about it
  | "joining"       // searching for a network
  | "waiting"       // registered, no bearer yet
  | "connected"     // a bearer is up
  | "failed";       // the modem itself reported a failure

export interface ModemState {
  mode: ModemMode;
  /** One line for a status readout, in Yonder's words. */
  summary: string;
  operator: string | null;
  technology: string | null;
  registration: string | null;
  /** The APN in use, read from the connected bearer — not from configuration. */
  apn: string | null;
  address: string | null;
  mtu: number | null;
  signal: SignalReading;
  /** Every port with its kind, as the modem came up. R-CEL-03. */
  ports: string[];
  /**
   * Whether this kind of modem can report signal at all (R-CEL-11).
   *
   * False for an appliance, which hides operator, technology and signal behind
   * its own interface. A page shows that as a property of the modem rather
   * than as four empty fields, which would read as a fault.
   */
  reportsSignal: boolean;
}

const NO_SIGNAL: SignalReading = { rssi: null, rsrq: null, rsrp: null, snr: null };

export function modemState(
  config: Config,
  modem: ModemInfo | null,
  bearer: BearerInfo | null,
  signal: SignalReading,
): ModemState {
  const wanted = config.network.modem;
  const appliance = wanted.mode === "appliance";

  const base = {
    operator: modem?.operatorName ?? null,
    technology: modem?.accessTechnology ?? null,
    registration: modem?.registration ?? null,
    apn: bearer?.apn ?? null,
    address: bearer?.address ?? null,
    mtu: bearer?.mtu ?? null,
    signal: appliance ? NO_SIGNAL : signal,
    ports: modem?.portList ?? [],
    reportsSignal: !appliance,
  };

  // An appliance is never "absent": it is a named adapter, and whether it is
  // working is a question for reach/, not for ModemManager, which will never
  // have heard of it.
  if (appliance) {
    return { ...base, mode: wanted.enabled ? "connected" : "unconfigured",
      summary: wanted.enabled ? `Using ${wanted.interface ?? "the named adapter"}` : "Not configured" };
  }

  if (modem === null) return { ...base, mode: "absent", summary: "No modem found" };
  if (!wanted.enabled) return { ...base, mode: "unconfigured", summary: "Modem found — not configured" };

  if (modem.state === "failed") {
    return { ...base, mode: "failed",
      summary: `The modem reported a failure: ${modem.failedReason ?? "no reason given"}` };
  }
  if (bearer !== null) {
    return { ...base, mode: "connected", summary: `Connected to ${modem.operatorName ?? "the network"}` };
  }
  if (modem.registration === "home" || modem.registration === "roaming") {
    return { ...base, mode: "waiting", summary: "Registered — no connection yet" };
  }
  return { ...base, mode: "joining", summary: "Looking for a network" };
}
