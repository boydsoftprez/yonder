// SPDX-License-Identifier: GPL-3.0-or-later
import { ApplyEngine } from "../apply/engine.js";
import { loadConfig } from "../config/load.js";
import { ConfigError } from "../config/errors.js";
import { warn } from "../log.js";
import { activityLog, type ActivityLog } from "../log/activity.js";
import { AdminCredential } from "../console/credential.js";
import { AttemptThrottle } from "../console/throttle.js";
import { secretValuesIn, redactValues } from "../secrets/redact.js";
import { readBoardFacts } from "../system/read.js";
import { readVersions } from "../system/versions.js";
import { displayFacts, type BoardDisplay } from "../system/format.js";
import { isProbeHost, type PingResult } from "../diag/probe.js";
import { joinNetwork, leaveNetwork, type JoinRequest } from "../net/join.js";
import type { NetworkState } from "../net/state.js";
import { setTheme, type ThemeRequest } from "../ui/theme.js";
import type { ScanResult } from "../net/scan.js";
import type { BoardFacts } from "../system/facts.js";
import type { Versions } from "../system/versions.js";
import { ZEROTIER_NETWORK_ID, type Camera } from "../schema/config.js";
import type { RemoteState } from "../remote/state.js";
import { compose, refuse } from "../video/pipeline.js";
import { noCapabilities, summarise, type CameraCapabilities } from "../video/capability.js";
import { CONTROL_NAMES, type ApplyControlsOptions, type ApplyControlsResult } from "../video/controls.js";
import { renderReceive, type Rendering } from "../video/receive.js";
import type { CameraRun, Supervisor } from "../video/supervisor.js";
import type { Detection, DetectResult, Rejection } from "../video/probe/camera.js";
import type { Encoder } from "../video/probe/encoder.js";
import type { SupplyFlags, SupplyState } from "../system/supply.js";
import { RTSP_PORT } from "../media/ports.js";

export interface RouterDeps {
  engine: ApplyEngine;
  configPath: string;
  /**
   * The administrator password, or `undefined` when the secret store could
   * not be read at all — a malformed `secrets.yaml` is what does that, and
   * `startServer` serves anyway so the device stays diagnosable.
   *
   * Required rather than optional, so that a new construction site has to
   * decide what it is passing rather than quietly getting the unprovisioned
   * behaviour by omission. Undefined means *cannot tell*, and every route
   * below treats that exactly as it treats "not provisioned": refuse. The
   * safe direction when this daemon does not know whether the device has a
   * lock on it is to behave as though it has one nobody can open, never as
   * though it needs none.
   */
  credential: AdminCredential | undefined;
  /** Backoff on failed logins. One administrator, one counter — see throttle.ts. */
  throttle?: AttemptThrottle;
  /** What the radio is doing. Injected, so this router still knows no nmcli. */
  netState?: () => Promise<NetworkState>;
  /**
   * Called after an administrator password is set, so the console can be
   * rewritten and restarted into its provisioned shape.
   *
   * Synchronous and not awaited, on purpose. Restarting the console kills the
   * process that is answering the operator's browser, so this route must
   * return first; the implementation in server.ts defers the work on the
   * injected clock. A hook that could block this route would turn the one
   * interaction every operator has into a connection reset.
   */
  onProvisioned?: () => void;
  /**
   * What this board says about itself. Defaulted to the real readers, which
   * only open files under /proc and /sys and answer null for every one that
   * is not there — so a test that does not inject gets a record full of
   * nulls rather than a failure or a real measurement.
   */
  system?: () => SystemReport;
  /**
   * Scans for Wi-Fi networks. **Absent when the network layer could not be
   * assembled** — a malformed secrets.yaml does that — and the route then
   * says so rather than pretending the air is empty.
   */
  scan?: () => Promise<ScanResult>;
  /** See DiagProbes. Absent means this daemon cannot probe, not that nothing answered. */
  diag?: DiagProbes;
  /**
   * Stores the Wi-Fi passphrase for POST /net/join. Absent when the secret
   * store could not be read, which is the same condition that leaves
   * `credential` undefined — so the route refuses rather than applying a
   * configuration whose secret reference points at nothing.
   */
  secrets?: { put(name: string, value: string): void };
  /** The buffer GET /log serves. Defaults to the one this process writes to. */
  activity?: ActivityLog;
  /** The mesh join state. Absent on a daemon with no remote layer. */
  remoteState?: () => Promise<RemoteState>;
  /**
   * What is plugged into this board. **Given, never defaulted**, exactly as
   * `scan` and `diag` are: with a default, any caller reaching a camera route
   * would run a real `v4l2-ctl`, and "no test executes v4l2-ctl" is a rule
   * that has to be impossible to break rather than remembered. Absent means
   * this daemon cannot detect cameras, not that none is attached.
   */
  cameras?: CameraProbes;
  /** Which encoder this board actually has (R-CAM-13). Injected, like `cameras`. */
  encoder?: () => Promise<Encoder>;
  /**
   * Writes image controls to a camera's device node and reads them back
   * (R-CTL-04, R-CTL-05, R-CTL-10). Injected, like `cameras` and `encoder`:
   * with a default, a test that merely exercised this route would run a real
   * `v4l2-ctl`. Absent means this daemon cannot change a camera's controls,
   * not that the device has none to offer — `POST …/controls` says so rather
   * than pretending the write happened.
   */
  applyControls?: (opts: ApplyControlsOptions) => Promise<ApplyControlsResult>;
  /**
   * The one supervisor this process owns.
   *
   * It lives here, for the daemon's lifetime, and deliberately not inside a
   * Node-RED node: a redeploy destroys and recreates every node, so a
   * supervisor in one would drop every camera's pipeline the moment somebody
   * edited a flow — including, on a flying aircraft, the feed a ground
   * station is watching.
   */
  supervisor?: Supervisor;
  /**
   * The RTSP credential, resolved from `secrets.yaml`.
   *
   * A function returning one value rather than the whole store, because the
   * narrowness *is* the guarantee: `GET /cameras/:id/receive-line` is the one
   * route allowed to spend it, and nothing else in this router can reach a
   * secret at all (R-SEC-10). `null` before the media server has ever been
   * configured, which the rendering says in words rather than printing a URL
   * that would not work.
   */
  rtspPassword?: () => string | null;
  /**
   * Every address this device answers on, most-used first.
   *
   * R-VID-15 wants the receive line to carry the address the operator is
   * actually reaching the device on. A Unix socket carries no Host header, so
   * the caller may name one with `?address=` — and it is honoured only if it
   * is in this list, which makes the allowed set the set of real addresses
   * rather than a pattern somebody had to guess.
   */
  addresses?: () => Promise<string[]>;
  /**
   * The supply register (R-SYS-09). Injected for the same reason as `cameras`:
   * absent means this board does not expose it, and no caller runs `vcgencmd`
   * by omission.
   */
  supply?: () => Promise<SupplyState | null>;
}

/**
 * The camera probes, injected — the same reasoning as `DiagProbes` below.
 *
 * Two members and not one: `detect()` sweeps the board, which is what names
 * the `/dev` node a configured by-path name currently means; `probe()` reads
 * one device again, which is what the Setup deck's *Re-probe* key asks for
 * and what makes R-CTL-10 a read-back at the moment of the request rather
 * than a repeat of the sweep's answer.
 */
export interface CameraProbes {
  detect(): Promise<DetectResult>;
  probe(node: string, card: string): Promise<Detection | Rejection>;
}

/**
 * One camera, as its page reads it.
 *
 * `camera` is what an operator chose and `capabilities` is what the device
 * answers *now* — R-CAM-14 keeps those apart, and R-CTL-10 says the controls
 * are drawn from the second. `run` is what the supervisor observed, never
 * what the configuration asked for.
 */
export interface CameraView {
  camera: Camera;
  run: CameraRun;
  /** The `/dev` node this camera's by-path name resolves to now, or null. */
  device: string | null;
  card: string | null;
  /** False where the kernel publishes no stable name for this camera (R-UI-15). */
  byPathStable: boolean;
  capabilities: CameraCapabilities | null;
  /** Why there are no capabilities, in the probe's own words, or null. */
  reason: string | null;
  encoder: Encoder;
  /** Why a start would be refused (R-CAM-10), or null. */
  refusal: string | null;
}

/** What GET /system answers with. */
export interface SystemReport {
  facts: BoardFacts;
  versions: Versions;
  /** The same facts as strings a widget can bind. See system/format.ts. */
  display: BoardDisplay;
}

/**
 * The reachability probes, injected.
 *
 * Given rather than defaulted, for the same reason `scan` is: with a default
 * these routes would run a real `ping` from any test that reached them, and
 * "no test may execute ping" is a rule that has to be impossible to break
 * rather than remembered. `daemon/server.ts` builds them from the same
 * CommandRunner the renderers use, so a test that injects a fake runner gets
 * a fake ping for free.
 */
export interface DiagProbes {
  ping(host: string, count: number | undefined): Promise<PingResult>;
  reachable(): Promise<PingResult>;
}

export interface RouteResult {
  status: number;
  body: unknown;
}

export type Router = (method: string, path: string, body: unknown) => Promise<RouteResult>;

/** The body shape both administrator routes take. */
function submittedPassword(body: unknown): string | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const value = (body as { password?: unknown }).password;
  return typeof value === "string" ? value : undefined;
}

/**
 * A finite, non-negative integer out of a query string, or 0.
 *
 * A cursor a page could not parse is a page asking for everything, which is
 * the harmless direction: it repeats entries it already has rather than
 * silently skipping ones it never saw.
 */
function sinceParam(query: string): number {
  const raw = new URLSearchParams(query).get("since");
  if (raw === null) return 0;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * `POST /cameras/:id/controls`'s body, off the wire and rejected before it
 * reaches `applyControls` if it names nothing this route understands.
 *
 * A key naming anything but `brightness`, `contrast` or `rotation` is
 * ignored rather than refused — the same tolerance `submittedPassword` shows
 * an extra field. `null` is the schema's own "leave it" for a nullable image
 * control, so it is dropped rather than treated as a value; what is refused
 * is a value that is neither a number nor absent, and a body that — once
 * nulls and absent keys are set aside — names nothing left to change, which
 * is indistinguishable from a caller that meant to ask for something and did
 * not.
 *
 * Deliberately not a bound on the *number* — the schema's own bound is
 * `-100..100` and a real device's is usually narrower still. Neither belongs
 * here: `applyControls` clamps to what `capabilities` reports (rule 1), which
 * this function has no access to and must not guess at.
 */
function requestedControls(body: unknown): Partial<Camera["controls"]> | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const out: Partial<Record<keyof Camera["controls"], number>> = {};
  for (const control of Object.keys(CONTROL_NAMES) as (keyof Camera["controls"])[]) {
    const value = (body as Record<string, unknown>)[control];
    if (value === undefined || value === null) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    out[control] = value;
  }
  // The cast is the one place a plain number crosses into the schema's own,
  // narrower shape (`rotation` is a literal union there, not `number`);
  // `applyControls` reads every field as a number regardless of which
  // control it names, so nothing downstream relies on the narrower type.
  return Object.keys(out).length === 0 ? null : (out as Partial<Camera["controls"]>);
}

/**
 * The camera id comes off a URL, so it is matched against the same pattern the
 * schema allows rather than trusted. It reaches `compose()` and becomes a
 * media path and a file path; this is the one place a traversal could get in.
 *
 * A pattern, not a filter for `..`: a filter is a list of the tricks somebody
 * thought of, and a pattern is a statement of what is allowed. Stated here
 * rather than imported from `schema/config.ts` for the reason `whep.ts` states
 * its own — the two are checked against each other by hand, and both say the
 * same thing: thirty-two characters of lower-case letters, digits and hyphens.
 */
const CAMERA_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * `/cameras/<id>` and its four suffixes.
 *
 * Deliberately permissive about the id — `.+?` rather than the pattern above —
 * so that a traversal is refused by `CAMERA_ID` with a 404 that means "no such
 * camera", rather than falling through to the router's generic 404 by not
 * matching at all. The difference is not cosmetic: a guard nothing can reach
 * is a guard no test can prove.
 */
const CAMERA_ROUTE = /^\/cameras\/(.+?)(?:\/(run|probe|receive-line|controls))?$/;

/**
 * Where a pipeline publishes: mediamtx, on loopback.
 *
 * No credential in it, and that is deliberate. `media/config.ts` grants
 * publish to the anonymous user from 127.0.0.1 only, so the board's own
 * pipeline needs none — and a credential here would be a credential in the
 * argv of a long-running process, which is a credential in `ps` output.
 */
const RTSP_BASE = `rtsp://127.0.0.1:${RTSP_PORT}`;

/** The latched supply bits, and the words the log uses for each (R-SYS-09). */
const LATCHED_BITS: readonly (readonly [keyof SupplyFlags, string])[] = [
  ["undervoltage", "undervoltage"],
  ["capped", "frequency capped"],
  ["throttled", "throttling"],
];

export function createRouter(deps: RouterDeps): Router {
  const throttle = deps.throttle ?? new AttemptThrottle();
  const activity = deps.activity ?? activityLog;
  const system = deps.system ?? ((): SystemReport => {
    const facts = readBoardFacts();
    const versions = readVersions();
    // `display` alongside the raw record, not instead of it. A page binds a
    // widget to a string and cannot divide bytes by 1024 twice — doing that
    // in a `function` node is CLAUDE.md rule 2, and doing it in a contrib
    // node is what this milestone forbids for the same reason — so the
    // formatting happens in yonder-core, where it has tests. Anything that
    // wants the numbers still has them.
    return { facts, versions, display: displayFacts(facts, versions) };
  });

  /**
   * R-SYS-09's second half: *record an occurrence in the log*.
   *
   * **The transition, not the state.** A board dirty since boot would
   * otherwise write one line every time a status page polled, for ever — and a
   * log that says the same thing four hundred times is a log with nothing in
   * it. Held here, on the router, because a router is per process and a latched
   * bit is per boot: the two have the same lifetime.
   *
   * The first read of a dirty board does log, once. That is the case the
   * requirement is written for — an undervoltage event restarts the board, and
   * a restart in flight presents as an aircraft that went quiet with nothing to
   * explain it, so the line has to appear even though nothing changed while
   * anyone was watching.
   */
  let latchedSeen: SupplyFlags | null = null;
  const supplyTransition = (state: SupplyState | null): string | null => {
    if (state === null) return null;
    const before = latchedSeen;
    latchedSeen = state.sinceBoot;
    const fresh = LATCHED_BITS
      .filter(([bit]) => state.sinceBoot[bit] && !(before?.[bit] ?? false))
      .map(([, words]) => words);
    if (fresh.length === 0) return null;
    return `supply: ${fresh.join(", ")} ${fresh.length === 1 ? "has" : "have"} been latched `
      + `since boot (${state.raw}); an undervoltage event restarts the board`;
  };

  /**
   * "This daemon has no camera layer", said once.
   *
   * Never a 500: a board whose secret store could not be read is assembled
   * without one, and a device that answers "I cannot" is diagnosable where a
   * device that throws is not.
   */
  const noCameraLayer = (what: string, say: (line: string) => void): RouteResult => {
    say(`${what}: there is no camera layer on this daemon to ask`);
    return {
      status: 503,
      body: { error: "this device cannot report on its cameras; see the device journal for the reason" },
    };
  };

  /**
   * Everything under `/cameras/<id>`.
   *
   * The id has already been matched against `CAMERA_ID` by the caller, before
   * anything at all was done with it — including reading the configuration.
   */
  const cameraRoute = async (
    method: string,
    id: string,
    verb: string,
    body: unknown,
    query: string,
    say: (line: string) => void,
  ): Promise<RouteResult> => {
    const probes = deps.cameras;
    const supervisor = deps.supervisor;
    const readEncoder = deps.encoder;
    if (probes === undefined || supervisor === undefined || readEncoder === undefined) {
      return noCameraLayer(`${method} /cameras/${id}`, say);
    }

    const config = loadConfig(deps.configPath);
    const camera = config.cameras.find((c) => c.id === id);
    if (camera === undefined) {
      return { status: 404, body: { error: `no camera is configured with the id "${id}"` } };
    }

    /** One camera's page, read from the device rather than from the form (R-CTL-10). */
    const view = async (reprobe: boolean): Promise<CameraView> => {
      const detection = await probes.detect();
      const known = new Set(detection.found.map((d) => d.byPath));
      const swept = detection.found.find((d) => d.byPath === camera.device);
      // The sweep names the `/dev` node and the card this by-path name means
      // right now; the re-probe is what the operator pressed, and it reads
      // that one device again so a control turned on the camera itself shows
      // up rather than the sweep's slightly older answer.
      const answer: Detection | Rejection | undefined = reprobe && swept !== undefined
        ? await probes.probe(swept.device, swept.card)
        : swept;
      const found = answer !== undefined && "capabilities" in answer ? answer : undefined;
      const rejection = answer !== undefined && !("capabilities" in answer) ? answer : undefined;
      const encoder = await readEncoder();
      return {
        camera,
        run: supervisor.state(id),
        device: answer?.device ?? null,
        card: answer?.card ?? null,
        byPathStable: found?.byPathStable ?? false,
        capabilities: found?.capabilities ?? null,
        reason: rejection?.reason ?? null,
        encoder,
        // Answered on the page rather than only on the start, so an operator
        // reads which of their settings this camera does not offer before
        // they press anything (R-CAM-10). `knownDevices` comes from the sweep
        // that just ran, so a `device` resolving to nothing is caught here
        // rather than later as `Internal data stream error`.
        refusal: refuse({
          camera,
          capabilities: found?.capabilities ?? noCapabilities(),
          encoder,
          rtspBase: RTSP_BASE,
          knownDevices: known,
        }),
      };
    };

    if (method === "GET" && verb === "") {
      return { status: 200, body: await view(false) };
    }

    /** The Setup deck's *Re-probe* key. */
    if (method === "POST" && verb === "probe") {
      return { status: 200, body: await view(true) };
    }

    // R-CTL-01: start and stop each stream independently. Runtime only — it
    // survives no apply and no reboot, because an operator watching the
    // uplink track go past its mark needs something that acts now rather than
    // something that takes a confirmation window to arm.
    if (method === "POST" && verb === "run") {
      const action = (body as { action?: unknown } | undefined)?.action;
      if (action !== "start" && action !== "stop") {
        return { status: 400, body: { error: 'action must be "start" or "stop"' } };
      }
      if (action === "stop") {
        supervisor.stop(id);
        return { status: 200, body: supervisor.state(id) };
      }
      // Through the same view the page reads, so the sentence an operator is
      // shown before they press Start and the sentence they get for pressing
      // it cannot differ. A start is refused before it is attempted
      // (R-CAM-10): a pipeline that fails to start says "Internal data stream
      // error" and nothing else, and an operator deserves to be told which of
      // their settings the camera does not offer.
      const found = await view(false);
      if (found.refusal !== null) return { status: 400, body: { error: found.refusal } };
      supervisor.start(id, compose({
        camera,
        // Never reached: `refuse` answers "this camera has not answered with
        // any capture format" for a camera with no capabilities, so a null
        // here has already been refused above.
        capabilities: found.capabilities ?? noCapabilities(),
        encoder: found.encoder,
        rtspBase: RTSP_BASE,
      }));
      return { status: 200, body: supervisor.state(id) };
    }

    /**
     * R-CTL-04, R-CTL-05: image controls reach the device directly, never
     * through config.yaml. A camera's *stored* controls still change only
     * through `yonder-apply` (`apply/reachability.ts` exempts them from the
     * confirmation window, on the grounds that none of them changes what
     * leaves the aircraft) — this route is the other half, the one that was
     * missing entirely: without it a stored value was committed and never
     * reached the sensor.
     *
     * Runtime only, like `run` above and for the same reason: an operator
     * moving a slider needs the picture to answer now, not after a
     * confirmation window.
     */
    if (method === "POST" && verb === "controls") {
      const apply = deps.applyControls;
      if (apply === undefined) return noCameraLayer(`${method} /cameras/${id}/controls`, say);

      const requested = requestedControls(body);
      if (requested === null) {
        return {
          status: 400,
          body: {
            error: "name at least one of brightness, contrast or rotation, "
              + "each a finite number (null leaves it alone)",
          },
        };
      }

      // Through the same view the page reads, so what the page shows before
      // a control is moved and what this route resolves cannot disagree.
      // `view(false)` rather than a re-probe: `run`'s refusal check above
      // takes the same sweep-freshness trade-off, and re-probing twice more
      // in this one request — once here and once for the read-back below —
      // would be three device round trips for one slider.
      const found = await view(false);
      if (found.device === null || found.card === null || found.capabilities === null) {
        return {
          status: 400,
          body: { error: "this camera's device could not be resolved; re-probe it and try again" },
        };
      }

      const { applied, refused, clamped } = await apply({
        node: found.device,
        controls: requested,
        capabilities: found.capabilities,
      });

      // R-CTL-10: the whole device, read again — not the pre-write snapshot
      // patched in memory with what `applied` says. A page showing three
      // controls must not show two fresh values and one this request
      // happened to leave alone; a rejection here (the device went away
      // between the write and this read) is `current: null`, the same
      // honest "no reading" `view()` reports elsewhere rather than a stale
      // number dressed as a fresh one.
      const after = await probes.probe(found.device, found.card);
      const current = "capabilities" in after ? after.capabilities : null;

      return { status: 200, body: { applied, refused, clamped, current } };
    }

    // The credential leaves the daemon on exactly one route. Everything else
    // answers with the reference the configuration holds, never the value
    // (R-SEC-10). This one is allowed it because the operator is being handed
    // a URL to copy, which is the whole of R-VID-15.
    if (method === "GET" && verb === "receive-line") {
      const addresses = deps.addresses === undefined ? [] : await deps.addresses();
      // A Unix socket carries no Host header, so the caller may name the
      // address it arrived on — honoured only when this device actually
      // answers on it, which makes the allowed set the set of real addresses
      // rather than a pattern somebody had to guess.
      const named = new URLSearchParams(query).get("address");
      const address = named !== null && addresses.includes(named)
        ? named
        // The access point is the address every device answers on before it
        // has joined anything, so it is the honest last resort rather than a
        // placeholder that would print a command nobody could run.
        : addresses[0] ?? config.network.ap.address.split("/")[0] ?? "";
      const renderings: Rendering[] = renderReceive({
        camera,
        address,
        alternatives: addresses.filter((a) => a !== address),
        rtspPassword: deps.rtspPassword?.() ?? null,
        rtspPort: RTSP_PORT,
      });
      return { status: 200, body: { renderings } };
    }

    return { status: 404, body: { error: `no route for ${method} /cameras/${id}` } };
  };

  return async (method, rawPath, body) => {
    // `req.url` carries the query string, and every comparison below is an
    // equality against a path. Split once, here, rather than have each route
    // decide — a route that forgets is a 404 an operator reads as a missing
    // feature.
    const queryAt = rawPath.indexOf("?");
    const path = queryAt < 0 ? rawPath : rawPath.slice(0, queryAt);
    const query = queryAt < 0 ? "" : rawPath.slice(queryAt + 1);
    // Captured here, at the top, before any branch can do anything with the
    // body — R-SEC-10 says redaction happens where the value is captured, not
    // where it is printed. Everything this function logs goes through `say`,
    // so a line that picks up a submitted password on its way out of some
    // future branch is stripped of it without that branch having to know.
    const submitted = secretValuesIn(body);
    // Redaction is by value, so a password that happens to be a substring of
    // this daemon's own wording takes that substring with it — a refusal of
    // the password "short" logs `too-<redacted>`. Noisy, and the harmless
    // direction of the only mistake a value-based redactor can make. The
    // alternative is deciding per branch what might contain a secret, which
    // is how the leak comes back.
    const say = (line: string): void => warn(redactValues(line, submitted));

    try {
      // ---- the console's first-run routes -------------------------------
      //
      // GET /console/state is the only one of these reachable before an
      // administrator password exists, and it answers with one boolean. No
      // version, no hostname, no configuration: R-SEC-09 says a device
      // without a password offers no function but setting one, and a status
      // readout is a function.
      if (method === "GET" && path === "/console/state") {
        if (deps.credential === undefined) {
          say("GET /console/state: the secret store could not be read, so provisioning is unknown");
          return {
            status: 503,
            body: { error: "the device's secrets could not be read; see the device journal" },
          };
        }
        return { status: 200, body: { provisioned: deps.credential.isSet() } };
      }

      if (method === "POST" && path === "/admin/password") {
        if (deps.credential === undefined) {
          say("POST /admin/password: the secret store could not be read, so nothing can be stored in it");
          return {
            status: 503,
            body: { error: "the device's secrets could not be read; see the device journal" },
          };
        }
        const password = submittedPassword(body);
        if (password === undefined) return { status: 400, body: { error: "password is required" } };

        const result = deps.credential.set(password);
        if (result.ok) {
          say("an administrator password was set");
          try {
            deps.onProvisioned?.();
          } catch (e) {
            // The password is set. A console that did not get restarted comes
            // back into the right mode on the next apply or the next boot,
            // and that is not worth turning a success into a failure over.
            say(`the console could not be scheduled for a restart: ${(e as Error).message}`);
          }
          return { status: 200, body: { ok: true } };
        }
        // The message states the rule and never quotes what was submitted.
        say(`POST /admin/password refused: ${result.reason}`);
        return {
          status: result.reason === "already-set" ? 409 : 400,
          body: { error: result.message },
        };
      }

      if (method === "POST" && path === "/admin/verify") {
        // Before the password is even read out of the body: a refused
        // attempt must cost no scrypt derivation, or the refusal is itself a
        // way to keep this daemon's event loop busy.
        const decision = throttle.check();
        if (!decision.allowed) {
          return {
            status: 429,
            body: { ok: false, retryAfter: decision.retryAfter },
          };
        }
        const password = submittedPassword(body);
        // Fails closed in every direction: no credential store, no password
        // in the body, no password on the device. None of them authenticates
        // anyone, and all three count as a failed attempt so that hammering
        // any of them still meets the throttle.
        const ok = password !== undefined
          && deps.credential !== undefined
          && deps.credential.verify(password);
        throttle.record(ok);
        return { status: 200, body: { ok } };
      }

      // Deliberately in front of the gate below. GET /status carries no
      // configuration — an apply state, an expiry, and the reason the
      // renderer set could not be assembled — and it is the one thing that
      // makes a device whose secrets.yaml is unreadable diagnosable at all.
      // Gating it would mean a board that can only say "403" about a fault
      // an operator has to be on the device to fix anyway.
      if (method === "GET" && path === "/status") {
        return { status: 200, body: deps.engine.status() };
      }

      // ---- everything else is behind the administrator password ---------
      //
      // R-SEC-09: until one is set, there is no configuration read. The
      // console cannot reach these routes in setup mode because it has no
      // flow that calls them — but the socket is the boundary, not the
      // console, and a boundary that depends on the caller being polite is
      // not one.
      if (deps.credential === undefined || !deps.credential.isSet()) {
        return {
          status: 403,
          body: {
            error: "no administrator password is set on this device; "
              + "set one from the console before reading or changing its configuration",
          },
        };
      }

      // ---- what the console's pages read -------------------------------
      //
      // All of these are behind the gate above, deliberately. None of them is
      // needed to set an administrator password, so none of them belongs in
      // front of it: a board model, a scan of the air and an activity log are
      // all "function", and R-SEC-09 says a device without a password offers
      // none.

      if (method === "GET" && path === "/system") {
        // Sampled where this daemon already samples system state, so R-SYS-09
        // has one reader rather than a second poller nobody remembers to run.
        const supply = deps.supply === undefined ? null : await deps.supply();
        const occurrence = supplyTransition(supply);
        if (occurrence !== null) say(occurrence);
        return { status: 200, body: { ...system(), supply } };
      }

      // ---- the cameras -------------------------------------------------
      //
      // R-CAM-12: what was found, what was rejected, and why. A rejection is a
      // value here for the same reason it is one in `probe/camera.ts` — a
      // thrown exception carries none of the third, and a camera that simply
      // did not appear sends an operator looking for the one that vanished.
      if (method === "GET" && path === "/cameras") {
        if (deps.cameras === undefined) return noCameraLayer("GET /cameras", say);
        const config = loadConfig(deps.configPath);
        const { found, rejected } = await deps.cameras.detect();
        return {
          status: 200,
          body: {
            found: found.map((detected) => ({
              ...detected,
              // `aim: none · zoom: none` explains why that camera's page has
              // no Aim group before anyone goes looking for one — R-UI-15
              // applied a level up from the page it governs.
              summary: summarise(detected.capabilities),
              // Null where nothing is configured for this socket yet: a
              // detected camera with no id has no page to open (R-UI-03).
              id: config.cameras.find((c) => c.device === detected.byPath)?.id ?? null,
            })),
            rejected,
          },
        };
      }

      const addressed = CAMERA_ROUTE.exec(path);
      if (addressed !== null) {
        const id = addressed[1];
        // Before the configuration is read, before the probe is asked
        // anything, before this id is used for anything at all.
        if (!CAMERA_ID.test(id)) {
          return { status: 404, body: { error: "no such camera" } };
        }
        return await cameraRoute(method, id, addressed[2] ?? "", body, query, say);
      }

      if (method === "GET" && path === "/net/scan") {
        if (deps.scan === undefined) {
          say("GET /net/scan: there is no network layer on this daemon to scan with");
          return {
            status: 503,
            body: { error: "this device cannot scan; see the device journal for the reason" },
          };
        }
        // Never a pre-shared key: a scan is a list of what is broadcasting,
        // and ScanResult has no field that could carry one. A failure throws
        // to the catch-all below rather than returning an empty list — a scan
        // that did not run is not a neighbourhood with no Wi-Fi in it.
        return { status: 200, body: await deps.scan() };
      }

      if (method === "POST" && path === "/diag/ping") {
        if (deps.diag === undefined) {
          return {
            status: 503,
            body: { error: "this device cannot run a probe; see the device journal for the reason" },
          };
        }
        const host = (body as { host?: unknown } | undefined)?.host;
        // Refused here as well as inside the probe. The probe cannot be made
        // to run this string either way; what this adds is a 400 rather than
        // a 200 carrying a refusal, so a page does not have to read the body
        // to know the request was wrong.
        if (typeof host !== "string" || !isProbeHost(host)) {
          return { status: 400, body: { error: "host must be a host name or an IPv4 address" } };
        }
        const count = (body as { count?: unknown } | undefined)?.count;
        return {
          status: 200,
          body: await deps.diag.ping(host, typeof count === "number" ? count : undefined),
        };
      }

      if (method === "GET" && path === "/diag/reachable") {
        if (deps.diag === undefined) {
          return {
            status: 503,
            body: { error: "this device cannot run a probe; see the device journal for the reason" },
          };
        }
        return { status: 200, body: await deps.diag.reachable() };
      }

      if (method === "GET" && path === "/log") {
        // Already redacted: entries go through secrets/redact.ts on the way
        // into the buffer, not on the way out of it (R-SEC-10). There is no
        // filtering step here to forget.
        return { status: 200, body: activity.page(sinceParam(query)) };
      }

      // The one write the network page makes, and the reason it is a route
      // rather than a form that assembles a configuration in a browser.
      //
      // Joining a network is three things that have to happen together: the
      // passphrase into `secrets.yaml` (which only root can write), a
      // reference to it into `network.client`, and the whole document through
      // the apply engine so it inherits the confirmation timer. A page that
      // did that itself would have to hold the operator's whole configuration
      // and merge into it, in a browser, and post back something it had built
      // — which is a decision, in wiring, about the thing that decides whether
      // the device is reachable.
      //
      // The submitted passphrase is redacted at the top of this function like
      // every other body, so nothing below can log it (R-SEC-10).
      if (method === "POST" && path === "/net/join") {
        if (deps.secrets === undefined) {
          say("POST /net/join: the secret store could not be read, so nothing can be stored in it");
          return {
            status: 503,
            body: { error: "the device's secrets could not be read; see the device journal" },
          };
        }
        const join = joinNetwork(loadConfig(deps.configPath), body as JoinRequest, deps.secrets);
        if (!join.ok) return { status: 400, body: { error: join.error } };
        return { status: 200, body: await deps.engine.apply(join.config) };
      }

      // The same shape as /net/join, and for the same reason. A page that
      // merged a theme into the configuration would be editing the document
      // that decides whether the device is reachable, in wiring, from a
      // browser — and the wiring that did it held the last configuration in
      // flow context and assigned straight through the reference, so choosing
      // a theme mutated the cache in place and a revert left it lying.
      if (method === "POST" && path === "/ui/theme") {
        const chosen = setTheme(loadConfig(deps.configPath), body as ThemeRequest);
        if (!chosen.ok) return { status: 400, body: { error: chosen.error } };
        return { status: 200, body: await deps.engine.apply(chosen.config) };
      }

      // The inverse of /net/join, and the control the console did not have:
      // joining was a one-way door, so an operator on the wrong network had
      // no way back to the access point from the interface that took them
      // there. Clearing the SSID is the whole change; radioPlan does the rest.
      if (method === "POST" && path === "/net/leave") {
        return { status: 200, body: await deps.engine.apply(leaveNetwork(loadConfig(deps.configPath))) };
      }

      // One line that answers "what is the radio doing", computed from the
      // configuration *and* the devices, because the two disagree exactly
      // when it matters - a configuration naming a network the radio never
      // joined is the state an apply is about to revert.
      if (method === "GET" && path === "/net/state") {
        if (deps.netState === undefined) {
          say("GET /net/state: there is no network layer on this daemon to ask");
          return {
            status: 503,
            body: { error: "this device cannot report its network state" },
          };
        }
        return { status: 200, body: await deps.netState() };
      }

      // The same shape as /net/join: the router merges one field into the
      // document and hands it to the engine. Nothing about a mesh is stored
      // anywhere else, and a network id is not a secret - it is the name of a
      // network, not a way into one - so it lives in config.yaml.
      if (method === "POST" && path === "/remote/join") {
        const wanted = (body as { networkId?: unknown } | undefined)?.networkId;
        if (typeof wanted !== "string" || !ZEROTIER_NETWORK_ID.test(wanted)) {
          return {
            status: 400,
            body: { error: "a ZeroTier network id is sixteen lowercase hexadecimal characters" },
          };
        }
        const config = loadConfig(deps.configPath);
        return {
          status: 200,
          body: await deps.engine.apply({
            ...config,
            remote: { ...config.remote, zerotier: { enabled: true, network_id: wanted } },
          }),
        };
      }

      if (method === "POST" && path === "/remote/leave") {
        const config = loadConfig(deps.configPath);
        return {
          status: 200,
          body: await deps.engine.apply({
            ...config,
            remote: { ...config.remote, zerotier: { enabled: false, network_id: null } },
          }),
        };
      }

      if (method === "GET" && path === "/remote/state") {
        if (deps.remoteState === undefined) {
          say("GET /remote/state: there is no remote layer on this daemon to ask");
          return { status: 503, body: { error: "this device cannot report its mesh state" } };
        }
        return { status: 200, body: await deps.remoteState() };
      }

      if (method === "GET" && path === "/config") {
        return { status: 200, body: loadConfig(deps.configPath) };
      }
      if (method === "POST" && path === "/apply") {
        return { status: 200, body: await deps.engine.apply(body) };
      }
      if (method === "POST" && path === "/confirm") {
        const id = (body as { id?: string } | undefined)?.id;
        if (typeof id !== "string") return { status: 400, body: { error: "id is required" } };
        deps.engine.confirm(id);
        return { status: 200, body: deps.engine.status() };
      }
      return { status: 404, body: { error: `no route for ${method} ${path}` } };
    } catch (e) {
      // A ConfigError is written for the operator: it says what is wrong with
      // the configuration they sent, and its issues list is the whole point
      // of the route. It never carries anything from a subprocess.
      if (e instanceof ConfigError) {
        return { status: 400, body: { error: e.message, issues: e.issues } };
      }
      // Everything else does. A renderer failure arrives here as an
      // NmcliError whose message embeds nmcli's stderr verbatim, and echoing
      // an arbitrary error message into an HTTP body is how that leaves the
      // device. NmcliError does not extend ConfigError, so it fell straight
      // through to this branch.
      //
      // The detail goes to the journal, which needs being on the device to
      // read — and being on the device is exactly what the caller of this API
      // may not yet be. The response says only that something failed.
      say(`${method} ${path} failed: ${(e as Error).message}`);
      return {
        status: 500,
        body: { error: "the request failed; see the device journal for the reason" },
      };
    }
  };
}
