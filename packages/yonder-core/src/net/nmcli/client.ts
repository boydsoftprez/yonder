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
  /** nmcli connection type: `wifi`, `ethernet`, `gsm`. Sent only when creating. */
  type: string;
  /** The interface to bind. `ifname` when creating, `connection.interface-name` when modifying. */
  ifname: string;
  /** Fully-qualified `setting.property value` pairs. Never a bare property name. */
  settings: string[][];
  /**
   * Properties this profile wants **unset**, sent as `property ""`.
   *
   * A setting the configuration no longer holds has to be said, not omitted.
   * `nmcli connection modify` only writes what it is given, so a profile that
   * simply left `gsm.apn` out left the stored APN in place and in use: an
   * operator who cleared the field kept dialling on the old value, and the
   * `config.yaml` that is meant to be the single source of every generated
   * file no longer described the profile it had generated (R-CFG-13).
   *
   * Only on the modify path. A connection that is being created has no stored
   * value to reset, and `connection add` is where the shipped behaviour of a
   * modem with no APN was measured — sending it an empty one would be a
   * change to something that works, for no gain.
   *
   * ASSUMED, NOT OBSERVED: that `nmcli connection modify <name> gsm.apn ""`
   * resets the property rather than storing an empty string. It is nmcli's
   * documented idiom and the only one it offers for a plain string property,
   * and there was no nmcli on the machine this was written on. It is safe to
   * be wrong about in one direction only, which is why nothing in this list is
   * a whole *setting*: removing `802-11-wireless-security` is a different
   * operation with a different verb, and a half-cleared security setting on
   * the one radio an operator is joined over is not a thing to guess at.
   */
  clear?: string[];
}

/**
 * What nmcli calls a connection's type in the two places it is named.
 *
 * `connection add` takes the alias — `wifi`, `ethernet`, `gsm` — and
 * `connection show` reports the setting name in its TYPE column:
 * `802-11-wireless`, `802-3-ethernet`, `gsm`. They are the same fact spelled
 * two ways, and comparing one against the other without this map would call
 * every profile mistyped and recreate the access point on every render.
 */
const REPORTED_TYPE: Record<string, string> = {
  wifi: "802-11-wireless",
  ethernet: "802-3-ethernet",
  gsm: "gsm",
};

/**
 * Whether an existing connection is definitely not the kind now wanted.
 *
 * **Only on positive evidence, and that is the whole of the safety here.** The
 * answer decides whether a profile is deleted and created again, and one of
 * the profiles this is asked about is the access point an operator may be
 * joined to. A type nobody here recognises, or a TYPE column nmcli left empty,
 * answers `false` — modify it in place, exactly as before — because being
 * wrong in that direction costs a stale property and being wrong the other way
 * drops every station on the radio. The same shape `pathsDown` takes about
 * NetworkManager's state words and `bearerChanges` about an unreadable
 * property: silence is never a difference.
 *
 * Both spellings are accepted for the wanted type, so an nmcli that reports
 * the alias rather than the setting name is not read as a mismatch either.
 */
/**
 * What `addOrModify` did, so the caller can say the half an operator reads.
 *
 * `replaced` is the one that matters: a profile was deleted and created again
 * because a connection's type cannot be changed. The client says it to the
 * journal in nmcli's own words; the renderer says it to the activity pane in
 * Yonder's.
 */
export type ConnectionWrite = "added" | "modified" | "replaced";

export function typeDiffers(reported: string, wanted: string): boolean {
  const expected = REPORTED_TYPE[wanted];
  if (expected === undefined || reported === "") return false;
  return reported !== expected && reported !== wanted;
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

  /**
   * Run one nmcli command and return its stdout.
   *
   * Public because `joinSucceeded` (net/joined.ts) needs a field set no
   * method here returns — device, connection, address and gateway together —
   * and adding a one-caller method to this class would be a worse trade than
   * letting that caller name its own fields. Everything about redaction and
   * error shaping still happens here.
   */
  async exec(argv: string[]): Promise<string> {
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
   * **A connection whose type has changed is replaced, not modified.** The
   * paragraph above says a type cannot be changed and this method used to
   * modify anyway: both modem modes use the name `yonder-modem`, so an
   * operator moving from `auto` to `appliance` had every ethernet property
   * written onto a profile that was still `gsm` and stayed one. Nothing
   * failed, nothing was logged, and the modem went on dialling as it had.
   * Deleting and creating again is the only way NetworkManager offers, and it
   * happens only on positive evidence — see `typeDiffers`.
   *
   * ASSUMED, NOT OBSERVED: there was no nmcli on the machine this was written
   * on. Confirming that `nmcli connection modify yonder-ap type wifi` is
   * rejected — and that `connection.interface-name` is accepted — is Step 1 of
   * docs/hardware/verifying-m1a.md.
   */
  async addOrModify(name: string, spec: ConnectionSpec): Promise<ConnectionWrite> {
    const existing = await this.connections();
    const properties = spec.settings.flat();
    const found = existing.find((c) => c.name === name);

    if (found !== undefined && !typeDiffers(found.type, spec.type)) {
      // `clear` last, so a property that is both written and reset — which
      // nothing generates today — ends unset rather than depending on
      // argument order inside nmcli.
      await this.exec([
        "nmcli", "connection", "modify", name,
        "connection.interface-name", spec.ifname,
        ...properties,
        ...(spec.clear ?? []).flatMap((property) => [property, ""]),
      ]);
      return "modified";
    }

    if (found !== undefined) {
      // The journal, not the console's activity pane: this line names both
      // nmcli spellings and is diagnostic. The caller is told what happened
      // and says the operator's version of it — see `NetworkRenderer.render`.
      this.log(
        `${name} is a ${found.type} connection and the configuration now asks for a `
        + `${spec.type} one; a connection's type cannot be changed, so it is being replaced`,
      );
      await this.remove(name);
    }

    // Created: either it was never there, or it has just been removed because
    // it was the wrong kind. `clear` has nothing to do here — a new profile
    // holds no value to reset — and sending an empty property on `add` would
    // be a change to the one path a board was measured on.
    await this.exec([
      "nmcli", "connection", "add", "con-name", name,
      "type", spec.type, "ifname", spec.ifname,
      ...properties,
    ]);
    return found === undefined ? "added" : "replaced";
  }

  /**
   * Set both address families' route metrics on a connection that already exists.
   *
   * `connection modify`, never `add`: this is only ever called about a
   * profile a render wrote, and the metric is the only property being
   * touched. Both families together because a board can hold a v6 default
   * route as well as a v4 one, and moving traffic off a path that reaches
   * nothing means moving all of it.
   *
   * It changes the stored profile, not the live device — see `reapply`.
   */
  async setRouteMetric(name: string, metric: number): Promise<void> {
    await this.exec([
      "nmcli", "connection", "modify", name,
      "ipv4.route-metric", String(metric),
      "ipv6.route-metric", String(metric),
    ]);
  }

  /**
   * Make a device take up the changes to the profile it is already running.
   *
   * `nmcli device reapply` re-applies the connection **in place**: the link
   * is not taken down, the address is not released, and the on-link route
   * stays. That is what makes a route-metric change safe to issue against a
   * cable an operator is sitting on, and it was measured doing exactly this
   * on the board (design spec §6: removing and restoring a default route
   * moved traffic between paths, and `nmcli device reapply eth0` put it
   * back).
   */
  async reapply(device: string): Promise<void> {
    await this.exec(["nmcli", "device", "reapply", device]);
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
