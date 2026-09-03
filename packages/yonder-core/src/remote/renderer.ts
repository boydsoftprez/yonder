// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from "node:fs";
import { systemClock, type Clock, type Renderer } from "../apply/types.js";
import { writeFileDurable, unlinkDurable } from "../fs/durable.js";
import type { CommandRunner } from "../net/runner.js";
import type { Config } from "../schema/config.js";
import { ZeroTierCli, ZeroTierCliError } from "./zerotier/cli.js";
import type { ZeroTierNetwork } from "./zerotier/parse.js";

const UNIT = "zerotier-one";

/**
 * What `systemRunner` reports when it could not spawn the binary at all.
 *
 * The one exit code that means "there is no client here" rather than "the
 * client did not answer" — a distinction this renderer has to make before it
 * decides that nothing is joined.
 */
const ABSENT_EXIT = 127;

/**
 * What `systemctl` needs to be told before it will enable or disable a unit
 * from inside this daemon's sandbox.
 *
 * `yonder-core.service` runs under `ProtectSystem=strict` with
 * `ReadWritePaths=/etc/yonder /var/lib/yonder`, so every other path in /etc is
 * mounted read-only in the daemon's own mount namespace. That is a commitment
 * worth keeping, and it collides with one detail of Debian's systemctl: the
 * unit-file symlink work of `enable`/`disable` is done by PID 1 over D-Bus and
 * is unaffected, but the SysV compatibility step is run *client-side*, in this
 * process's namespace. The ZeroTier package ships an `/etc/init.d` script
 * alongside its unit, so systemctl also runs
 * `/usr/lib/systemd/systemd-sysv-install`, which runs `update-rc.d`, which
 * tries to write the `/etc/rc?.d` symlinks — and gets EROFS. Measured on a
 * board, both through this daemon and in a transient unit given the same two
 * sandbox settings:
 *
 *     Synchronizing state of zerotier-one.service with SysV service script …
 *     Executing: /usr/lib/systemd/systemd-sysv-install disable zerotier-one
 *     update-rc.d: error: Read-only file system
 *     (exit 1)
 *
 * so `disable` failed every leave, and `enable` failed every join that had to
 * create those links — an exit status this renderer is right to treat as a
 * failure (R-VPN-07), for a step whose outcome Yonder does not care about.
 * The banner is the *first* line and the error the third, which is why every
 * report of this quoted a line that is printed on success too.
 *
 * Yonder does not manage SysV runlevels. This board boots systemd, systemd
 * runs the native unit, and the generator that would make something of an
 * init.d script skips one that has a unit of its own; the `/etc/rc?.d` links
 * decide nothing here, which is why the installer's offline path (which uses
 * deb-systemd-helper) has never touched them either. So the step is skipped
 * rather than the sandbox widened: `SYSTEMCTL_SKIP_SYSV` is the switch
 * systemctl reads for exactly this, and skipping it leaves nothing for the
 * read-only mount to refuse. If a future systemctl stopped honouring the
 * variable the failure would be the loud one above, not a silent one.
 *
 * K-34.
 */
const SYSTEMCTL_ENV = { SYSTEMCTL_SKIP_SYSV: "1" } as const;

/**
 * How long to wait, after `systemctl enable --now zerotier-one` reports
 * success, for the client to answer `zerotier-cli listnetworks`.
 *
 * `enable --now` returns as soon as systemd has forked the unit, not once the
 * client is listening on its control socket, and a render that calls
 * `listNetworks()` straight after that lost the race on a real board: the
 * first join on a freshly installed device — the exact path an operator takes
 * — failed with
 *
 *     POST /remote/join failed: zerotier is configured and its service
 *     started, but the client did not answer; look at the journal for
 *     zerotier-one
 *
 * and because render() throws, the apply engine reverted the change and
 * discarded the operator's network id along with it. Measured on that same
 * board: a *warm* start (the unit already run once, its identity already on
 * disk) becomes answerable after **~368 ms**. A *first* start after
 * installation is slower still, because the client has no identity yet and
 * generates a keypair before it opens its control socket — which is exactly
 * the start every fresh device makes.
 *
 * 10 s is about 27x the measured warm figure, which leaves ample room for a
 * first-boot keypair generation the warm number never had to pay for, while
 * staying a sixth of `renderTimeoutMs` (60 s, `apply/engine.ts`) so a client
 * that is genuinely absent or wedged is still reported with this renderer's
 * own "did not answer" message — pointing at the journal, which is
 * actionable — rather than by the engine's generic per-renderer timeout
 * firing first and saying nothing about which command was waited on.
 */
export const ZEROTIER_WAIT_MS = 10_000;

/** How often `listnetworks` is retried while waiting for the client. */
export const ZEROTIER_POLL_MS = 250;

/**
 * What systemd and a shell say when the thing asked for is not on the device.
 *
 * systemd: *Unit zerotier-one.service does not exist* / *not loaded*; a shell
 * that cannot find a binary: *command not found*. Matched on the wording
 * because there is no exit status that separates "absent" from "refused" for
 * every one of these commands, and getting it wrong in either direction is
 * only ever a clearer or a vaguer error message — never an action taken.
 */
const ABSENT = /not loaded|does not exist|not found|no such file/i;

/**
 * Turns `remote.zerotier` into a running client on the right network.
 *
 * **Installing a client does not start one.** The Debian package enables and
 * starts itself, and a daemon with zero networks joined still holds live
 * sessions with ZeroTier's root servers — a board printed four of them,
 * unprompted, moments after the package landed. A device that talks to a
 * company's infrastructure because software is merely present contradicts the
 * first thing this project claims about itself, so the installer disables the
 * unit and this renderer is the only thing that starts it (R-VPN-08, R-VPN-05).
 *
 * **And it only ever touches what it started.** Everything this class does to
 * the unit and to the client's memberships is gated on the state file below,
 * because the alternative was a defect: a device an operator had joined to a
 * mesh by hand, and was reaching the console over, lost that mesh to a change
 * of palette — every apply ran `stop` and `disable` on a service Yonder had
 * never started, and a palette change carries no confirmation window to
 * revert it. Nothing may make the device unreachable, so nothing here acts on
 * a service it has no record of having asked for.
 */
export class RemoteRenderer implements Renderer {
  readonly name = "remote";

  private readonly cli: ZeroTierCli;
  private readonly run: CommandRunner;
  private readonly statePath: string;
  private readonly log: (line: string) => void;
  private readonly clock: Clock;
  private readonly waitMs: number;
  private readonly pollMs: number;

  constructor(opts: {
    cli: ZeroTierCli;
    run: CommandRunner;
    /** Where the joined network is recorded, under /var/lib/yonder. */
    statePath: string;
    log?: (line: string) => void;
    /**
     * Drives waitForClient's bounded wait. Injected for the same reason as
     * everywhere else in this daemon: no test may wait on the wall clock.
     */
    clock?: Clock;
    /** Overrides ZEROTIER_WAIT_MS. Test-only. */
    zerotierWaitMs?: number;
    /** Overrides ZEROTIER_POLL_MS. Test-only. */
    zerotierPollMs?: number;
  }) {
    this.cli = opts.cli;
    this.run = opts.run;
    this.statePath = opts.statePath;
    this.log = opts.log ?? (() => {});
    this.clock = opts.clock ?? systemClock;
    this.waitMs = opts.zerotierWaitMs ?? ZEROTIER_WAIT_MS;
    this.pollMs = opts.zerotierPollMs ?? ZEROTIER_POLL_MS;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.clock.setTimer(ms, resolve);
    });
  }

  /**
   * Poll `listnetworks` until the client answers or the bound runs out.
   *
   * Returns the parsed list on success. Throws the same "did not answer"
   * error `render()` has always thrown on the first failure, once the bound
   * is spent — a client that never comes up must still fail the apply
   * (R-VPN-07); this only buys the client the time a real one needs to
   * finish starting before that verdict is reached.
   */
  private async waitForClient(): Promise<ZeroTierNetwork[]> {
    const deadline = this.clock.now() + this.waitMs;
    let waited = false;

    for (;;) {
      try {
        const networks = await this.cli.listNetworks();
        if (waited) this.log("zerotier: the client answered");
        return networks;
      } catch (e) {
        if (this.clock.now() >= deadline) {
          throw new Error(
            `zerotier is configured and its service started, but the client did not answer; ` +
              `look at the journal for ${UNIT}`,
          );
        }
        if (!waited) {
          this.log(`zerotier: the client has not answered yet (${(e as Error).message}); waiting for it to start`);
          waited = true;
        }
        await this.sleep(this.pollMs);
      }
    }
  }

  /**
   * The network this renderer joined, on disk rather than in a field.
   *
   * It has to survive the process. A daemon restarts between a join and a leave
   * for entirely ordinary reasons - an upgrade, a reboot, a crash - and a
   * renderer that remembered this in memory would come back knowing nothing,
   * leave nothing, and strand the device on a mesh its configuration no longer
   * names. Recording it also keeps the leave narrow: Yonder removes what Yonder
   * joined, and a network an operator joined by hand stays theirs.
   */
  private owned(): string | null {
    try {
      const held = JSON.parse(readFileSync(this.statePath, "utf8")) as { network?: unknown };
      return typeof held.network === "string" ? held.network : null;
    } catch {
      // Absent or unreadable both mean the same thing: nothing is known to be
      // ours, so nothing is ours to leave, and nothing is ours to stop.
      return null;
    }
  }

  private remember(network: string | null): void {
    if (network === null) unlinkDurable(this.statePath);
    else writeFileDurable(this.statePath, JSON.stringify({ network }) + "\n", 0o644);
  }

  /**
   * `systemctl`, with its exit status read rather than discarded.
   *
   * `systemRunner` never rejects — a non-zero exit is an ordinary
   * `CommandResult`, deliberately, so a caller decides what a failure means.
   * This renderer's answer is that every one of them matters: R-VPN-07 names
   * "a service that will not start" as a failure that must fail the apply, and
   * R-VPN-08's "installed and off" is a claim this class makes and therefore
   * has to check. A `stop` that did not stop leaves an aircraft talking to a
   * company's root servers with nothing on the console saying so.
   *
   * The one tolerated failure is a unit that is not there at all, and only for
   * `stop` and `disable`: those two ask for a service that is not running and
   * will not start at boot, and a unit systemd has never heard of is both. A
   * client somebody removed by hand must not be able to fail every later apply
   * on the device — including one that has nothing to do with a mesh.
   */
  private async systemctl(args: string[], opts: { absentIsFine?: boolean } = {}): Promise<void> {
    const { code, stdout, stderr } = await this.run(["systemctl", ...args], { env: { ...SYSTEMCTL_ENV } });
    if (code === 0) return;
    const reason = said(stderr, stdout, code);
    if (opts.absentIsFine === true && ABSENT.test(reason)) {
      this.log(`zerotier: ${UNIT} is not installed here, so it is already off`);
      return;
    }
    throw new Error(`systemctl ${args.join(" ")} failed: ${reason}`);
  }

  async render(config: Config): Promise<void> {
    const { enabled, network_id } = config.remote.zerotier;
    const wanted = enabled && network_id !== null ? network_id : null;

    const held = this.owned();

    if (wanted === null) {
      // Nothing configured and nothing of ours running: there is nothing to
      // do, and doing something anyway is how the console goes away. A
      // default device reaches this branch on every single apply.
      if (held === null) return;

      // Leave only what we joined — but first, find out whether we can ask at
      // all, because "the client did not answer" is not "the device is not a
      // member".
      //
      // **This cost an operator an afternoon.** The client was masked, so
      // listNetworks failed, and this swallowed the failure and treated it as
      // an empty list: no leave was issued, the record below was cleared, and
      // ZeroTier's own membership file stayed on disk. The moment the client
      // was unmasked it read that file, rejoined a network whose subnet
      // collided with the board's LAN, and took the device off the air — the
      // exact failure the operator had masked it to escape.
      //
      // The membership lives in the client's database, not in ours. Ours is
      // only a note saying there is something to clean up, so throwing it away
      // at the one moment we could not check is the worst possible time.
      let joined: ZeroTierNetwork[];
      try {
        joined = await this.cli.listNetworks();
      } catch (error) {
        // A client that is not installed is the one case where "cannot ask" and
        // "nothing joined" really are the same: there is no database to hold a
        // membership. `systemRunner` reports a binary it could not spawn as
        // 127, which is how that case is told apart from a client that is
        // present and simply not running.
        if (error instanceof ZeroTierCliError && error.code === ABSENT_EXIT) {
          this.log(`zerotier: no client here, so ${held} cannot still be joined`);
          joined = [];
        } else {
          throw new Error(
            `zerotier should leave ${held}, but the client is not answering, so ` +
              `whether this device is still a member cannot be established. The ` +
              `membership lives in the client's own database and would take effect ` +
              `again the moment it starts, so the configuration is left as it was ` +
              `rather than reporting a departure that did not happen`,
          );
        }
      }
      // A `leave` that fails is not swallowed. The membership lives in the
      // client's own database, so a leave that did not happen leaves the
      // device on a mesh its configuration no longer names — and clearing the
      // record below would then destroy the only thing that knew to try
      // again. Failing the apply keeps both the membership and the record.
      for (const net of joined) {
        if (net.nwid === held) {
          this.log(`zerotier: leaving ${net.nwid}`);
          await this.cli.leave(net.nwid);
        }
      }
      await this.systemctl(["stop", UNIT], { absentIsFine: true });
      await this.systemctl(["disable", UNIT], { absentIsFine: true });
      // Last, so that anything above which failed leaves the record standing
      // and the next apply tries again. Forgetting first would leave a client
      // Yonder started, still running, with nothing left that knows to stop it.
      this.remember(null);
      return;
    }

    // Everything from starting the service to recording that we own it runs
    // under one guard, because the rollback cannot clean up after it.
    //
    // `enable --now` starts the unit. If anything between there and the record
    // then fails — the client never answers, leaving a previous network fails,
    // the write itself fails — the apply engine re-renders the previous
    // configuration, which asks for no mesh. That render reads the ownership
    // record, finds none (it was never written), and correctly returns without
    // touching the service: stopping a client it does not own is exactly the
    // bug that took an operator's console away. So the rollback is right to do
    // nothing, and the result is a client left running and enabled with no
    // network — which is the state R-VPN-08 exists to prevent.
    //
    // Only when the service was not already ours. If `held` names a network we
    // were on, the service was ours and running before this apply, and undoing
    // an activation we did not perform would take the mesh down over a failure
    // to change it.
    const wasOurs = held !== null;
    let joined: ZeroTierNetwork[];
    try {
      // The service first, because the two failures R-VPN-07 distinguishes —
      // no client at all, and a client whose service will not start — are both
      // reported here and they have different remedies.
      const enable = await this.run(["systemctl", "enable", "--now", UNIT], { env: { ...SYSTEMCTL_ENV } });
      if (enable.code !== 0) {
        const reason = said(enable.stderr, enable.stdout, enable.code);
        throw new Error(
          // systemd says "does not exist" for a unit file that is not there,
          // and a shell says "not found" for a binary that is not. Either is a
          // client that was never installed; anything else is a client that is
          // installed and would not start, and sending that operator away to
          // rebuild a payload wastes a trip to the aircraft.
          ABSENT.test(reason)
            ? `zerotier is configured but the client is not installed on this device; ` +
              `re-run the installer with a payload that carries it`
            : `zerotier is configured but its service would not start: ${reason}`,
        );
      }

      // Bounded, because `enable --now` returning does not mean the client is
      // listening yet — see ZEROTIER_WAIT_MS above.
      joined = await this.waitForClient();

      // A network id that changed: leave the old one before joining the new, or
      // the device sits on both and the configuration describes neither. Not
      // best-effort — a leave that fails here is the same defect as the one
      // above, and the state file still names the old network, so failing the
      // apply is what lets the next one try again.
      if (held !== null && held !== wanted && joined.some((n) => n.nwid === held)) {
        this.log(`zerotier: leaving ${held}`);
        await this.cli.leave(held);
      }

      // Written *before* the join, not after. The record exists so a daemon that
      // dies between a join and a leave cannot strand the device, and a record
      // written afterwards leaves exactly that window open: power is cut on an
      // aircraft mid-apply, the membership is in the client's database and
      // nothing on disk says Yonder put it there, so the next leave skips it for
      // ever. The same window opens without a crash, because a write that throws
      // (ENOSPC, EIO) fails the apply and the re-render of the previous
      // configuration sees no record either. Recording a join that then fails
      // costs one superfluous `leave` later, and leaving a network you are not
      // on does nothing at all.
      this.remember(wanted);
    } catch (error) {
      if (!wasOurs) {
        this.log(`zerotier: the join failed, so stopping the client it started`);
        await this.systemctl(["stop", UNIT], { absentIsFine: true }).catch(() => undefined);
        await this.systemctl(["disable", UNIT], { absentIsFine: true }).catch(() => undefined);
      }
      throw error;
    }

    if (!joined.some((n) => n.nwid === wanted)) {
      this.log(`zerotier: joining ${wanted}`);
      await this.cli.join(wanted);
    } else {
      this.log(`zerotier: already on ${wanted}`);
    }

    // Deliberately not waited on. The next thing that happens is that a human
    // approves this device in a controller, which may be a minute or a week,
    // and a render is not the place to wait for a person (R-VPN-06).
  }
}

/**
 * Everything a command said about itself, or its exit status.
 *
 * This took the *first* line, and that cost days. `systemctl disable` on a
 * unit with a SysV script opens with a banner it prints on success too —
 * *Synchronizing state of zerotier-one.service …* — and says what actually
 * went wrong two lines later. Every report of the defect above therefore
 * quoted a sentence that is not an error, and every attempt to reproduce it
 * by hand succeeded, because the one line that named the cause
 * (*update-rc.d: error: Read-only file system*) was thrown away here.
 *
 * So: all of it, joined, in the order it was said. A diagnostic is only worth
 * carrying if it carries the reason. K-34.
 */
function said(stderr: string, stdout: string, code: number): string {
  const lines = (stderr || stdout)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  return lines.length === 0 ? `exited ${code}` : lines.join("; ");
}
