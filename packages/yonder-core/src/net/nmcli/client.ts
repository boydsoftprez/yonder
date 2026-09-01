// SPDX-License-Identifier: GPL-3.0-or-later
import { parseTerse } from "./parse.js";
import { redactArgv, type CommandRunner } from "../runner.js";

export interface DeviceInfo { device: string; type: string; state: string; connection: string }
export interface ConnectionInfo { name: string; uuid: string; type: string; device: string }
export interface AccessPointInfo { ssid: string; signal: number; security: string }

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

  async activeIpv4(): Promise<{ device: string; address: string }[]> {
    const out = await this.exec(["nmcli", "-t", "-f", "DEVICE,IP4.ADDRESS", "device", "show"]);
    return parseTerse(out, 2)
      .filter(([, address]) => address !== "")
      .map(([device, address]) => ({ device, address }));
  }

  /** Create the connection if absent, otherwise update it in place. Idempotent. */
  async addOrModify(name: string, settings: string[][]): Promise<void> {
    const existing = await this.connections();
    const flat = settings.flat();
    if (existing.some((c) => c.name === name)) {
      await this.exec(["nmcli", "connection", "modify", name, ...flat]);
    } else {
      await this.exec(["nmcli", "connection", "add", "con-name", name, ...flat]);
    }
  }

  async up(name: string): Promise<void> { await this.exec(["nmcli", "connection", "up", name]); }
  async down(name: string): Promise<void> { await this.exec(["nmcli", "connection", "down", name]); }
  async remove(name: string): Promise<void> { await this.exec(["nmcli", "connection", "delete", name]); }
}
