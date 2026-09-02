// SPDX-License-Identifier: GPL-3.0-or-later
import { redactArgv, type CommandRunner } from "../../runner.js";
import { arrayAt, parseKeyValue } from "./parse.js";

export interface ModemPorts {
  /** What NetworkManager binds a connection to. `cdc-wdm0` on the EC25. */
  control: string | null;
  /** What holds the address and carries the bytes. `wwan0` on the EC25. */
  net: string | null;
}

export interface ModemInfo {
  path: string;
  manufacturer: string | null;
  model: string | null;
  state: string | null;
  failedReason: string | null;
  powerState: string | null;
  accessTechnology: string | null;
  operatorName: string | null;
  operatorCode: string | null;
  registration: string | null;
  imei: string | null;
  ports: ModemPorts;
  /** Every port with its kind, as mmcli prints it. R-CEL-03's raw material. */
  portList: string[];
  bearerPaths: string[];
}

export interface BearerInfo {
  path: string;
  connected: boolean;
  interface: string | null;
  apn: string | null;
  ipType: string | null;
  address: string | null;
  gateway: string | null;
  mtu: number | null;
}

export interface SignalReading {
  rssi: number | null;
  rsrq: number | null;
  rsrp: number | null;
  snr: number | null;
}

/** A failed mmcli invocation, redacted like NmcliError is. */
export class MmcliError extends Error {
  readonly argv: string[];
  constructor(argv: string[], code: number, stderr: string) {
    super(`mmcli exited ${code}: ${stderr.trim() || "(no stderr)"}\n  ${redactArgv(argv).join(" ")}`);
    this.name = "MmcliError";
    this.argv = redactArgv(argv);
  }
}

/** `cdc-wdm0 (mbim)` → `["cdc-wdm0", "mbim"]`. */
function splitPort(entry: string): [string, string] {
  const m = /^(\S+)\s*\(([^)]*)\)$/.exec(entry.trim());
  return m === null ? [entry.trim(), ""] : [m[1], m[2]];
}

/** A number, or null for mmcli's absent. Never a zero standing in for unknown. */
function num(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * ModemManager, read and never driven.
 *
 * The connection is NetworkManager's — see net/modem/profiles.ts. What is
 * here is everything only ModemManager knows: registration, operator, access
 * technology, the ports a modem came up on, and signal.
 */
export class MmcliClient {
  constructor(
    private readonly runner: CommandRunner,
    private readonly log: (line: string) => void = () => {},
  ) {}

  private async exec(argv: string[]): Promise<string> {
    this.log(redactArgv(argv).join(" "));
    const result = await this.runner(argv);
    if (result.code !== 0) throw new MmcliError(argv, result.code, result.stderr);
    return result.stdout;
  }

  /** Every modem ModemManager has claimed. Empty is an ordinary answer. */
  async modems(): Promise<string[]> {
    const out = await this.exec(["mmcli", "-L", "--output-keyvalue"]);
    return arrayAt(parseKeyValue(out), "modem-list");
  }

  async modem(path: string): Promise<ModemInfo> {
    const r = parseKeyValue(await this.exec(["mmcli", "-m", path, "--output-keyvalue"]));
    const portList = arrayAt(r, "modem.generic.ports");
    const ports: ModemPorts = { control: null, net: null };
    for (const entry of portList) {
      const [name, kind] = splitPort(entry);
      // The kinds that matter. `at` is a control port too, but only as the
      // fallback a modem with no data port ends up on — which is the
      // arrangement the install role exists to prevent, not one to configure.
      if (kind === "net") ports.net = name;
      else if (kind === "mbim" || kind === "qmi") ports.control = name;
    }
    // The primary port is the control port when mmcli named one, which it does
    // for every modem that has a data path.
    ports.control = ports.control ?? r["modem.generic.primary-port"] ?? null;
    return {
      path,
      manufacturer: r["modem.generic.manufacturer"] ?? null,
      model: r["modem.generic.model"] ?? null,
      state: r["modem.generic.state"] ?? null,
      failedReason: r["modem.generic.state-failed-reason"] ?? null,
      powerState: r["modem.generic.power-state"] ?? null,
      accessTechnology: arrayAt(r, "modem.generic.access-technologies")[0] ?? null,
      operatorName: r["modem.3gpp.operator-name"] ?? null,
      operatorCode: r["modem.3gpp.operator-code"] ?? null,
      registration: r["modem.3gpp.registration-state"] ?? null,
      imei: r["modem.3gpp.imei"] ?? null,
      ports,
      portList,
      bearerPaths: arrayAt(r, "modem.generic.bearers"),
    };
  }

  async bearer(path: string): Promise<BearerInfo> {
    const r = parseKeyValue(await this.exec(["mmcli", "-b", path, "--output-keyvalue"]));
    return {
      path,
      connected: r["bearer.status.connected"] === "yes",
      interface: r["bearer.status.interface"] ?? null,
      apn: r["bearer.properties.apn"] ?? null,
      ipType: r["bearer.properties.ip-type"] ?? null,
      address: r["bearer.ipv4-config.address"] ?? null,
      gateway: r["bearer.ipv4-config.gateway"] ?? null,
      mtu: num(r["bearer.ipv4-config.mtu"]),
    };
  }

  /**
   * The bearer actually carrying traffic.
   *
   * **Not `bearers[0]`, and not bearer 0.** A modem reports its network's own
   * initial bearer alongside the one Yonder created. On the board this was
   * measured on, the initial bearer was index 0, was *not* connected, and
   * carried `nxtgenphone` — an APN nobody configured and the one that failed.
   * Reading the first bearer reads that. Every bearer is asked, and the
   * connected one is returned.
   */
  async connectedBearer(modem: ModemInfo): Promise<BearerInfo | null> {
    for (const path of modem.bearerPaths) {
      const bearer = await this.bearer(path);
      if (bearer.connected) return bearer;
    }
    return null;
  }

  /**
   * Turn on detailed signal polling.
   *
   * Without this a modem reports only a coarse quality percentage, which on
   * the measured board read 60 and then 29 while the real numbers moved three
   * dB. It is a privileged operation and the daemon runs as root already.
   */
  async armSignal(path: string, seconds: number): Promise<void> {
    await this.exec(["mmcli", "-m", path, `--signal-setup=${seconds}`]);
  }

  /**
   * The four numbers, for the technology in use.
   *
   * LTE first and 5G after it, because a modem reports one set and dashes for
   * the rest. Nulls when polling was never armed — never zeroes, because 0 dBm
   * is a real and extraordinary reading and would show a perfect signal on a
   * device that has none.
   */
  async signal(path: string): Promise<SignalReading> {
    const r = parseKeyValue(await this.exec(["mmcli", "-m", path, "--signal-get", "--output-keyvalue"]));
    for (const tech of ["lte", "5g", "umts", "gsm"]) {
      const rssi = num(r[`modem.signal.${tech}.rssi`]);
      const rsrp = num(r[`modem.signal.${tech}.rsrp`]);
      if (rssi !== null || rsrp !== null) {
        return {
          rssi,
          rsrq: num(r[`modem.signal.${tech}.rsrq`]),
          rsrp,
          snr: num(r[`modem.signal.${tech}.snr`]),
        };
      }
    }
    return { rssi: null, rsrq: null, rsrp: null, snr: null };
  }
}
