// SPDX-License-Identifier: GPL-3.0-or-later
import { parseTerse, parseDeviceShow } from "./parse.js";
import { redactArgv, type CommandRunner } from "../runner.js";

export interface DeviceInfo { device: string; type: string; state: string; connection: string }
export interface ConnectionInfo { name: string; uuid: string; type: string; device: string }
export interface AccessPointInfo { ssid: string; signal: number; security: string }

/**
 * One connection, in the two halves nmcli actually distinguishes.
 *
 * `type` and `ifname` are `connection add` common options, not properties;
 * `settings` are `setting.property value` pairs, valid on both add and modify.
 * Keeping them apart in the type is what stops an add-only option being sent
 * to `connection modify` — see addOrModify.
 */
export interface ConnectionSpec {
  /** nmcli connection type: `wifi`, `ethernet`. Sent only when creating. */
  type: string;
  /** The interface to bind. `ifname` when creating, `connection.interface-name` when modifying. */
  ifname: string;
  /** Fully-qualified `setting.property value` pairs. Never a bare property name. */
  settings: string[][];
}

export class NmcliError extends Error {
  readonly argv: string[];
  readonly stderr: string;
  constructor(argv: string[], code: number, stderr: string) {
    super(`nmcli exited ${code}: ${stderr.trim() || "(no stderr)"}\n  ${redactArgv(argv).join(" ")}`);
    this.name = "NmcliError";
    this.argv = redactArgv(argv);
    this.stderr = stderr;
  }
}

export class NmcliClient {
  constructor(
    private readonly run: CommandRunner,
    private readonly log: (line: string) => void = () => {},
  ) {}

  private async exec(argv: string[]): Promise<string> {
    this.log(redactArgv(argv).join(" "));
    const result = await this.run(argv);
    if (result.code !== 0) throw new NmcliError(argv, result.code, result.stderr);
    return result.stdout;
  }

  async devices(): Promise<DeviceInfo[]> {
    const out = await this.exec(["nmcli", "-t", "-f", "DEVICE,TYPE,STATE,CONNECTION", "device", "status"]);
    return parseTerse(out, 4).map(([device, type, state, connection]) => ({ device, type, state, connection }));
  }

  async connections(): Promise<ConnectionInfo[]> {
    const out = await this.exec(["nmcli", "-t", "-f", "NAME,UUID,TYPE,DEVICE", "connection", "show"]);
    return parseTerse(out, 4).map(([name, uuid, type, device]) => ({ name, uuid, type, device }));
  }

  async scan(iface: string): Promise<AccessPointInfo[]> {
    const out = await this.exec([
      "nmcli", "-t", "-f", "SSID,SIGNAL,SECURITY", "device", "wifi", "list",
      "ifname", iface, "--rescan", "yes",
    ]);
    return parseTerse(out, 3)
      .filter(([ssid]) => ssid !== "")
      .map(([ssid, signal, security]) => ({ ssid, signal: Number(signal), security }));
  }

  /**
   * Every IPv4 address currently held, one entry per address per interface.
   *
   * This is the probe behind the access-point fallback (R-NET-07) and the one
   * call here whose real output has never been seen — see parseDeviceShow.
   *
   * Two things about the argv are deliberate. `device show` takes
   * section-qualified field names, so it is `GENERAL.DEVICE`, never the bare
   * `DEVICE` that belongs to `device status`. And its `-t` output is a stream
   * of `FIELD:value` lines rather than one record per device, so it is parsed
   * by parseDeviceShow and not by parseTerse.
   */
  async activeIpv4(): Promise<{ device: string; address: string }[]> {
    const out = await this.exec([
      "nmcli", "-t", "-f", "GENERAL.DEVICE,IP4.ADDRESS", "device", "show",
    ]);
    return parseDeviceShow(out).flatMap(({ device, addresses }) =>
      addresses.map((address) => ({ device, address })),
    );
  }

  /**
   * Create the connection if absent, otherwise update it in place. Idempotent.
   *
   * The two nmcli subcommands do not take the same arguments, and sending one
   * argument list to both is why every render after the first used to fail.
   *
   * `connection add` takes *common options* — `type`, `ifname`, `con-name` —
   * followed by `setting.property value` pairs. `connection modify` takes
   * `[+|-]setting.property value` pairs and nothing else: `type` and `ifname`
   * are not properties, and a connection's type cannot be changed at all. So
   * the type is sent only on the add path, and the interface binding is sent
   * under its real property name, `connection.interface-name`, on the modify
   * path.
   *
   * ASSUMED, NOT OBSERVED: there was no nmcli on the machine this was written
   * on. Confirming that `nmcli connection modify yonder-ap type wifi` is
   * rejected — and that `connection.interface-name` is accepted — is Step 1 of
   * docs/hardware/verifying-m1a.md.
   */
  async addOrModify(name: string, spec: ConnectionSpec): Promise<void> {
    const existing = await this.connections();
    const properties = spec.settings.flat();
    if (existing.some((c) => c.name === name)) {
      await this.exec([
        "nmcli", "connection", "modify", name,
        "connection.interface-name", spec.ifname,
        ...properties,
      ]);
    } else {
      await this.exec([
        "nmcli", "connection", "add", "con-name", name,
        "type", spec.type, "ifname", spec.ifname,
        ...properties,
      ]);
    }
  }

  async up(name: string): Promise<void> { await this.exec(["nmcli", "connection", "up", name]); }
  async down(name: string): Promise<void> { await this.exec(["nmcli", "connection", "down", name]); }
  async remove(name: string): Promise<void> { await this.exec(["nmcli", "connection", "delete", name]); }
}
