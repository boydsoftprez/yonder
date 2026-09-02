// SPDX-License-Identifier: GPL-3.0-or-later
import { parseTerse, parseDeviceShow } from "./parse.js";
import { redactArgv, redactText, type CommandRunner } from "../runner.js";

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

/**
 * A failed nmcli invocation.
 *
 * Both fields are redacted at construction, not at the point of use. This
 * error is thrown from a renderer, so it travels: into the journal, into an
 * apply's failure, and — until the router stopped echoing arbitrary error
 * messages — into an HTTP response body. Anything that has to be scrubbed
 * before one of those has to be scrubbed here, once, or the next place that
 * prints it is a fresh leak. `argv` carries the pre-shared key the renderer
 * passed; `stderr` can quote it back.
 */
export class NmcliError extends Error {
  readonly argv: string[];
  readonly stderr: string;
  constructor(argv: string[], code: number, stderr: string) {
    const safeStderr = redactText(stderr, argv);
    super(`nmcli exited ${code}: ${safeStderr.trim() || "(no stderr)"}\n  ${redactArgv(argv).join(" ")}`);
    this.name = "NmcliError";
    this.argv = redactArgv(argv);
    this.stderr = safeStderr;
  }
}

export class NmcliClient {
  /**
   * The process runner this client was built from, deliberately readable.
   *
   * Not every command the network layer has to issue is an nmcli one:
   * clearing the kernel's rfkill block needs `rfkill`, a separate binary,
   * which has no business on a class named for nmcli. The alternative — a
   * second runner handed to the network renderer alongside this client — is
   * two references that must agree and can silently stop agreeing, and the
   * failure mode of them disagreeing is a test reaching a real `rfkill` on
   * the machine running it. One runner, read from the one place that holds
   * it, cannot drift.
   */
  constructor(
    readonly runner: CommandRunner,
    private readonly log: (line: string) => void = () => {},
  ) {}

  private async exec(argv: string[]): Promise<string> {
    this.log(redactArgv(argv).join(" "));
    const result = await this.runner(argv);
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
   * This is the probe behind the access-point fallback (R-NET-07). Its output
   * shape has now been seen on a real board — see parseDeviceShow, and
   * `fixtures/device-show-ip4.txt`, which is that capture.
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
  /**
   * Take a connection down, tolerating one that is already down.
   *
   * `nmcli connection down` exits 10 with "is not an active connection" when
   * the thing is not up. That is the state being asked for, not a failure —
   * but it failed a whole render on a real board:
   *
   *     POST /net/join failed: nmcli exited 10:
   *     Error: 'yonder-ap' is not an active connection.
   *
   * `settleRadio` does check first, against the device list it read at the
   * start of the render. Between that read and this command NetworkManager
   * can have moved: a connection that was activating can have given up, and
   * the radio can have been reconfigured by the profile writes in between. A
   * check against a snapshot cannot close that, so the command itself has to
   * be idempotent — which is what "down" should have meant all along.
   */
  async down(name: string): Promise<void> {
    try {
      await this.exec(["nmcli", "connection", "down", name]);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (/is not an active connection|no active connection provided/i.test(message)) {
        this.log(`network: ${name} was already down`);
        return;
      }
      throw e;
    }
  }
  async remove(name: string): Promise<void> { await this.exec(["nmcli", "connection", "delete", name]); }
}
