// SPDX-License-Identifier: GPL-3.0-or-later
import type { PipelineRenderer } from "../video/renderer.js";
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
import { configureModem } from "../net/modem/configure.js";
import type { NetworkState } from "../net/state.js";
import type { ModemState } from "../net/modem/state.js";
import type { PathName, ReachState } from "../net/reach/standing.js";
import { setTheme, type ThemeRequest } from "../ui/theme.js";
import type { ScanResult } from "../net/scan.js";
import type { BoardFacts } from "../system/facts.js";
import type { Versions } from "../system/versions.js";
import { z } from "zod";
import {
  CameraControls, DEFAULT_CONFIG, PREVIEW_RUNGS, ZEROTIER_NETWORK_ID, type Camera,
} from "../schema/config.js";
import { publishableApPassphrase } from "../net/profiles.js";
import type { RemoteState } from "../remote/state.js";
import { compose, refuse } from "../video/pipeline.js";
import { noCapabilities, summarise, type CameraCapabilities } from "../video/capability.js";
import {
  aimPanel, cameraDeck, cameraIndex, cameraStrip, capabilityFacts, identityWords, removalRefusal,
  uplinkBudget,
  type AimPanel, type CameraDeck, type CameraStrip, type CapabilityFact,
} from "../video/present.js";
import { applyCameraDraft, deckDraft, interruption, validateDraft } from "../apply/draft.js";
import { captureRefusal, captureSizes } from "../video/capability.js";
import type { ReachPaths } from "../video/outputs.js";
import type { AnswerableAddress } from "../net/dial-in.js";
import { CONTROL_NAMES, type ApplyControlsOptions, type ApplyControlsResult } from "../video/controls.js";
import { setCameraSettings, type CameraSettings } from "../video/settings.js";
import { renderReceive, type Rendering } from "../video/receive.js";
import type { CameraRun, Supervisor } from "../video/supervisor.js";
import type { ViewerStats, Viewers, Want } from "../video/viewers.js";
import {
  SAFE_CAPTURE_NAME, isRefusal,
  type Capture, type Recorder, type RecordingState, type Refusal,
} from "../video/recorder.js";
import type { Detection, DetectResult, Rejection } from "../video/probe/camera.js";
import type { Encoder } from "../video/probe/encoder.js";
import type { SupplyFlags, SupplyState } from "../system/supply.js";
import { RTSP_BASE, RTSP_PORT } from "../media/ports.js";
import { pathCheck } from "../mav/check.js";
import type { LinkState } from "../mav/link.js";
import { SweepInProgressError, type DetectOutcome } from "../mav/detect.js";

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
  /** What the modem says about itself. Injected, so this router knows no mmcli. */
  modemState?: () => Promise<ModemState>;
  /** Which way out is in use, and which paths have been stood down. */
  reachState?: () => Promise<ReachState>;
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
   *
   * **`get` is here for exactly one question**: whether the access point is
   * still on the passphrase this project publishes (R-UI-18). It is optional
   * because the answer is allowed to be *cannot tell* — see
   * `publishableApPassphrase`, which never hands back what it was given. No
   * route reads any other row through this, and none should: a value out of
   * this store is a credential unless something has established that it is
   * not.
   */
  secrets?: {
    put(name: string, value: string): void;
    get?(name: string): string | undefined;
  };
  /** The buffer GET /log serves. Defaults to the one this process writes to. */
  activity?: ActivityLog;
  /** The mesh join state. Absent on a daemon with no remote layer. */
  remoteState?: () => Promise<RemoteState>;
  /**
   * Test one path now and answer when the result is known.
   *
   * R-CEL-09's "on request". Injected, so this router still knows no probe —
   * and wired to the same ReachMonitor the automatic probes use, so a test an
   * operator asked for and one the device ran itself are the same evidence.
   */
  testPath?: (path: PathName) => Promise<boolean>;
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
  pipelineRenderer?: PipelineRenderer;
  /**
   * Who is watching each camera, and what each of them is being sent
   * (R-VID-11, R-VID-13; spec §8.2).
   *
   * It lives for the daemon's lifetime beside the supervisor, and for the
   * same reason: a redeploy destroys every Node-RED node, and a register of
   * who is watching that was emptied whenever somebody edited a flow would
   * make every open picture cost nothing on paper while it went on costing
   * the uplink.
   *
   * Injected like every other camera-layer part. Absent means this daemon
   * has no video layer to report on, which `POST …/viewers/:viewer` says
   * rather than answering with an empty state that would read as *nobody is
   * watching*.
   */
  viewers?: Viewers;
  /**
   * Recording to the board and taking a still (R-CAM-17, R-CAM-18,
   * R-STO-06).
   *
   * It lives for the daemon's lifetime beside the supervisor and `viewers`,
   * and for the same reason: a redeploy destroys every Node-RED node, and a
   * recorder in one would forget which cameras were recording the moment
   * somebody edited a flow — leaving a branch on a tee that nothing could
   * stop and a card filling with a file the console had stopped counting.
   *
   * Injected like every other camera-layer part. Absent means this daemon has
   * no video layer, which the routes say rather than answering with an empty
   * capture list that would read as *nothing has been recorded*.
   */
  recorder?: Recorder;
  /**
   * The RTSP credential, resolved from `secrets.yaml`.
   *
   * A function returning one value rather than the whole store, because the
   * narrowness *is* the guarantee: `GET /cameras/:id/stream-address` is the one
   * route allowed to spend it, and nothing else in this router can reach a
   * secret at all (R-SEC-10). `null` before the media server has ever been
   * configured, which the rendering says in words rather than printing a URL
   * that would not work.
   */
  rtspPassword?: () => string | null;
  /**
   * Every address this device answers on, most-used first, and whether a peer
   * could **dial in** to each one.
   *
   * R-VID-15 wants the stream address to carry the address the operator is
   * actually reaching the device on. A Unix socket carries no Host header, so
   * the caller may name one with `?address=` — and it is honoured only if it
   * is in this list, which makes the allowed set the set of real addresses
   * rather than a pattern somebody had to guess.
   *
   * **`path` is here because an address is not one fact but two** (R-UI-24).
   * Three of the four renderings need no address at all — the ground station
   * listens and this board pushes to it — and the fourth is an RTSP URL, which
   * only works if a peer can open a socket *to* this device over a path that
   * is up. The modem's address cannot be dialled at all, and the access
   * point's cannot stand in for the mesh: a verdict rests on a particular
   * path, so the address printed under it has to come from that path. See
   * `net/dial-in.ts`, which is where that shape and its reasons live.
   *
   * Which path each address is on is the assembly's fact, not this router's:
   * it takes both of the modem's interface names, the access point's own
   * address, and the device each address is held on. `server.ts` does that
   * once, where all of them are already in hand.
   */
  addresses?: () => Promise<AnswerableAddress[]>;
  /**
   * The supply register (R-SYS-09). Injected for the same reason as `cameras`:
   * absent means this board does not expose it, and no caller runs `vcgencmd`
   * by omission.
   */
  supply?: () => Promise<SupplyState | null>;
  /**
   * The telemetry link, read and driven. **Absent when this daemon was
   * started without a way to do telemetry at all**: `MavlinkRenderer` is
   * assembled only when a caller supplies a way to open a serial port
   * (`BuildRenderersOptions.mavlink`), and `main()` always does. So this is
   * no longer the ordinary state of a device — a board with nothing on its
   * UART now has a telemetry layer that answers R-MAV-13's "which kind of
   * nothing", rather than a 503 that cannot tell an absent autopilot from an
   * absent capability. Every `/mav/*` route still says so with a 503 naming
   * the absence when there is genuinely no layer to ask.
   */
  mavlink?: MavlinkControl;
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
  /** False where the kernel publishes no stable name for this camera (R-UI-20). */
  byPathStable: boolean;
  capabilities: CameraCapabilities | null;
  /** Why there are no capabilities, in the probe's own words, or null. */
  reason: string | null;
  encoder: Encoder;
  /** Why a start would be refused (R-CAM-10), or null. */
  refusal: string | null;
  /**
   * The same facts as strings the readout strip binds — see `video/present.ts`
   * and `displayFacts` beside it. A page binds a widget to a key and cannot
   * compose `1280 × 720`; doing that in a `function` node is CLAUDE.md rule 2
   * and doing it in a `change` node's JSONata is the same rule wearing a
   * different hat. Anything that wants the raw values still has them above.
   */
  display: CameraStrip;
  /**
   * What this camera cannot do (R-UI-20), computed from the capabilities
   * beside it rather than listed in the flows — a stored list is a stale list
   * the first time a different camera is plugged in, which is the whole of
   * R-CAM-14.
   */
  facts: CapabilityFact[];
  /**
   * `ui-yonder-deck`'s whole payload, and `ui-yonder-aim`'s (R-UI-08,
   * R-UI-28) — composed in `video/present.ts` beside `display` above and for
   * the identical reason: a widget binds one object, and the alternative is
   * a `change` node's JSONata assembling twenty-three descriptors next to a
   * wire coordinate, which is CLAUDE.md rule 2 wearing a different hat.
   *
   * Two fields and not one, because the Cockpit (M5) draws the aim panel
   * with no deck beside it and this shape is what it will read (R-UI-28).
   */
  deck: CameraDeck;
  aim: AimPanel;
  /**
   * What this camera's recorder is doing, and how long the medium has left
   * (R-CAM-17, R-STO-06).
   *
   * Carried on the camera's own page rather than fetched separately, so the
   * REC pill and the remaining time are drawn from the same read as
   * everything else and cannot disagree with it about one camera.
   *
   * `null` on a daemon assembled with no video layer — the same *cannot tell*
   * every other field here uses, and deliberately not a state saying
   * `recording: false`, which would read as *this camera is not recording*
   * when the truth is that nothing here can say.
   */
  recorder: RecordingState | null;
  /**
   * What this camera is holding, in the shape the captures panel draws
   * (R-CAM-18).
   *
   * The same listing `deck.captures.count` is composed from, on the same
   * read — a panel and the link that counts it disagreeing would be two
   * answers to one question on one screen. Empty on a daemon with no video
   * layer, which is what a device that has never held a capture also reads
   * as; the difference between the two is a question about the *device*, and
   * `recorder: null` above is where it is answered.
   */
  captures: { camera: string; captures: readonly Capture[] };
}

/**
 * The telemetry link as the console's routes need it.
 *
 * Injected as an interface rather than taken as a `MavlinkRenderer`, exactly
 * as `DiagProbes` is and for the same reason: ADR-0006 puts every `systemctl`
 * behind a renderer, and a route is not one. This router asks systemd nothing,
 * opens no serial port and runs no command — and a route test needs a plain
 * object rather than a whole renderer.
 *
 * `MavlinkRenderer` satisfies this shape as it stands; `daemon/server.ts`
 * passes the renderer straight in.
 */
export interface MavlinkControl {
  /** Everything measured about the aircraft's link. */
  state(): LinkState;
  /**
   * Whether anything is being sent to the ground stations (R-MAV-09).
   *
   * A property rather than a method because the renderer exposes it as a
   * getter — which also means a route reads it afresh on every request rather
   * than capturing whatever it was when the router was assembled.
   */
  readonly telemetryRunning: boolean;
  /**
   * Whether `mavlink-router` is on the air at all.
   *
   * Not the same question. A stop takes the ground stations out of the
   * generated file and restarts the router onto it, so the service stays up
   * carrying the flight controller link and the loopback copy: telemetry is
   * off and the console goes on hearing the aircraft. The path check needs
   * both and would draw the Autopilot row wrong with either alone.
   */
  readonly routerRunning: boolean;
  /** Stop the router, sweep the port it was holding, start it again. */
  detectNow(): Promise<DetectOutcome>;
  /** R-MAV-09, both halves. */
  startTelemetry(): Promise<void>;
  stopTelemetry(): Promise<void>;
}

/**
 * What `GET /mav/state` answers with — and what the two run routes and the
 * re-probe answer with too, so the page binds one shape.
 *
 * **Two named halves, not one flat record.** `LinkState` is deliberately
 * nothing but measurements about the *aircraft* (`mav/link.ts` says so in its
 * first paragraph); whether `mavlink-router` is on the air is a fact about
 * *this device*, and only the renderer that started it knows. Spreading the
 * two into one object would re-mix exactly what was separated on purpose, and
 * would invite a later contributor to tidy the field into `LinkState`, where
 * the first thing to report a stale one would be a page in flight.
 *
 * **And `telemetryRunning` is not optional.** Without it the console cannot
 * tell *an autopilot was found and telemetry is deliberately switched off*
 * from *an autopilot was found and telemetry is running* — `phase` reads
 * `linked` in both, and R-MAV-10 asks for both. Answering with the link state
 * alone is the one way this route can be quietly wrong, so the shape makes
 * omitting it impossible rather than merely discouraged.
 *
 * **Two running fields, because there are two facts.** A stop removes the
 * ground-station endpoints and restarts the router onto the remainder, so the
 * service is up and nothing is being sent: `telemetryRunning` is false and
 * `routerRunning` is true, and the page shows a live Autopilot row beside a
 * Ground stations row reading *stopped by you*. Folding them back into one
 * boolean gives a console that claims telemetry is flowing whenever the
 * process happens to be alive.
 */
export interface MavlinkStateBody {
  link: LinkState;
  /** Is anything reaching the ground stations? Drives the Start/Stop key. */
  telemetryRunning: boolean;
  /** Is `mavlink-router` up at all? Decides whether heartbeats can arrive. */
  routerRunning: boolean;
}

/** `POST /mav/detect`: the same two halves, plus what the sweep found. */
export interface MavlinkDetectBody extends MavlinkStateBody {
  outcome: DetectOutcome;
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

/**
 * How to get back to this device when the console has stopped being one
 * (R-UI-18).
 *
 * Every field here is public by construction, which is what makes it
 * acceptable on a route that sits in front of the administrator-password
 * gate. The SSID is beaconed continuously; the address is what the access
 * point's own DHCP hands to every client that joins it; the hostname is
 * announced over mDNS. None of the three is knowledge somebody in radio range
 * lacks, and all three are useless without a way past the console's login.
 *
 * The passphrase is the one that needed a rule, and it has one: see
 * `publishableApPassphrase`.
 */
export interface WayBackIn {
  /** The access point to join. */
  ssid: string;
  /** Its address, without the prefix length — what a browser is pointed at. */
  address: string;
  /** The name it answers to, ready to type. */
  hostname: string;
  /**
   * The published default while the device is still on it, **null once the
   * operator has set their own**, and **absent when this device cannot tell**
   * (R-SEC-10). Never the stored value: this is either the constant in
   * `net/profiles.ts` or no value at all.
   *
   * Three states, the same way `RouterDeps.credential` has three. A daemon
   * serving without a secret store — a malformed `secrets.yaml` — does not
   * know which passphrase its own access point is on, and saying "yonder1234"
   * there names a value that will not work on any device whose operator
   * changed it.
   */
  passphrase?: string | null;
}

export interface RouteResult {
  status: number;
  body: unknown;
  /**
   * The content type of `body`, where it is **not** JSON.
   *
   * Absent on every route but one, and that is the point: everything this
   * daemon serves is a document a page reads, except a capture, which is a
   * photograph or a recording an operator downloads (R-CAM-18). Set it, and
   * `body` is a `Buffer` written to the socket as it stands; leave it, and
   * `body` is serialised as JSON exactly as it always was.
   *
   * A flag rather than a second router: one route answering with bytes must
   * not turn every other route's answer into something a caller has to
   * inspect before reading.
   */
  contentType?: string;
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
 * Whether `fieldSchema` is `z.boolean()` under any of the wrappers a
 * `CameraControls` field actually carries — `.nullable().default(null)` for
 * every field but `rotation` (`.default(0)` alone, over a `z.union` of
 * literals, never a boolean or a number). Unwrapping `_def.innerType` this
 * way is Zod's own introspection surface, the same one `zod-to-json-schema`
 * (already a dependency — see `schema/generate.ts`) walks to turn this exact
 * schema into JSON Schema, not a private detail this file invented a reason
 * to poke at.
 */
function isBooleanControl(fieldSchema: z.ZodTypeAny): boolean {
  let s: z.ZodTypeAny = fieldSchema;
  while (s._def.innerType) s = s._def.innerType;
  return s._def.typeName === z.ZodFirstPartyTypeKind.ZodBoolean;
}

/**
 * Which `CameraControls` fields are booleans, read off the schema itself
 * (R-CTL-11 … R-CTL-14) rather than typed out by hand a third time.
 * `video/controls.ts`'s `CONTROL_NAMES` is the second list of the same
 * nineteen controls, and it and the schema already drifted apart once in
 * this plan — Task 8 gave the schema fourteen more fields before Task 9
 * taught `CONTROL_NAMES` about them — caught only because a `satisfies`
 * clause happened to tie that particular pair together. A hand-written pair
 * of names here (`["autoWhiteBalance", "autoFocus"]`) would be a third list
 * with nothing watching it: a fifth boolean control added to the schema
 * later would silently fall through this route's number-only check instead
 * of failing to compile the way a `CONTROL_NAMES` omission does.
 */
export const BOOLEAN_CONTROLS: ReadonlySet<string> = new Set(
  Object.entries(CameraControls.shape)
    .filter(([, fieldSchema]) => isBooleanControl(fieldSchema))
    .map(([key]) => key),
);

/**
 * `POST /cameras/:id/controls`'s body, off the wire and rejected before it
 * reaches `applyControls` if it names nothing this route understands.
 *
 * A key naming a control the schema does not have is ignored rather than
 * refused — the same tolerance `submittedPassword` shows an extra field.
 * `null` is the schema's own "leave it" for a nullable control, so it is
 * dropped rather than treated as a value; what is refused is a value that is
 * neither the right JS type for that particular control nor absent, and a
 * body that — once nulls and absent keys are set aside — names nothing left
 * to change, which is indistinguishable from a caller that meant to ask for
 * something and did not.
 *
 * **A boolean is accepted only for the controls the schema itself types as
 * boolean** (`BOOLEAN_CONTROLS` above — `autoWhiteBalance` and `autoFocus`
 * today) and a number for every other one. Getting this wrong in either
 * direction is a real fault: refusing a genuine boolean control would leave
 * `applyControls`'s own `1`/`0` encoding (`video/controls.ts`) unreachable by
 * the only caller that would ever send one; accepting a boolean for a
 * numeric control would hand `applyControls` a `true`/`false` where it
 * expects a device-native number.
 *
 * **One bad field refuses the whole body, not just that field** — deliberate,
 * not an oversight: a page setting brightness and auto focus in the same
 * request must not have brightness silently applied while auto focus is
 * quietly dropped for being the wrong JS type. Better an operator sees
 * nothing happened and tries again than have one of two settings they asked
 * for take effect unannounced.
 *
 * Deliberately not a bound on the *number* — the schema's own bound is
 * `-100..100` and a real device's is usually narrower still. Neither belongs
 * here: `applyControls` clamps to what `capabilities` reports (rule 1), which
 * this function has no access to and must not guess at.
 */
export function requestedControls(body: unknown): Partial<Camera["controls"]> | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const out: Partial<Record<keyof Camera["controls"], number | boolean>> = {};
  for (const control of Object.keys(CONTROL_NAMES) as (keyof Camera["controls"])[]) {
    const value = (body as Record<string, unknown>)[control];
    if (value === undefined || value === null) continue;
    if (BOOLEAN_CONTROLS.has(control)) {
      if (typeof value !== "boolean") return null;
      out[control] = value;
    } else {
      if (typeof value !== "number" || !Number.isFinite(value)) return null;
      out[control] = value;
    }
  }
  // The cast is the one place a plain number or boolean crosses into the
  // schema's own, narrower shape (`rotation` is a literal union there, not
  // `number`); `applyControls` reads a field as whichever of the two it
  // actually is regardless of which control it names, so nothing downstream
  // relies on the narrower type.
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
 * A viewer id, off a URL, matched rather than trusted — the same reasoning
 * as `CAMERA_ID` above.
 *
 * The console mints these from the browser's own session (`console/
 * middleware.ts`), so what actually arrives is hexadecimal. The pattern is
 * wider than that on purpose: it is a statement of what this route will
 * accept as a key in a map, not a restatement of one minter's format.
 */
const VIEWER_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * `/cameras/<id>` and its suffixes.
 *
 * Deliberately permissive about the id — `.+?` rather than the pattern above —
 * so that a traversal is refused by `CAMERA_ID` with a 404 that means "no such
 * camera", rather than falling through to the router's generic 404 by not
 * matching at all. The difference is not cosmetic: a guard nothing can reach
 * is a guard no test can prove.
 */
const CAMERA_ROUTE = /^\/cameras\/(.+?)(?:\/(run|probe|stream-address|controls|settings|apply|record|photo|captures(?:\/[^/]+)?|outputs\/(?:rtp|rtsp|srt)|viewers\/[^/]+))?$/;

const WANTS: readonly Want[] = ["video", "stills", "off"];

/**
 * What each kind of capture refusal is answered with (R-CAM-17, R-CAM-18).
 *
 * A table rather than a chain of comparisons, so a refusal added to
 * `video/recorder.ts` cannot reach a route without somebody deciding what it
 * means over HTTP: the type is exhaustive, and an unmapped kind will not
 * compile.
 *
 * **409 and not 400 or 500 for all but one of them.** Every one of these is
 * *not now*: the camera is not running, something else is in flight on it, or
 * the card is at its reserve. None of them is a malformed request and none is
 * this daemon failing — an operator who presses REC on a stopped camera has
 * asked a reasonable question and is owed the reason.
 *
 * `on-camera` is overridden to 404 on the two routes that address one capture,
 * because there the fact is not *not now* but *this device does not have that
 * file* — see `captureRoute`.
 */
const REFUSAL_STATUS: Record<Refusal["because"], number> = {
  busy: 409,
  "no-space": 409,
  "not-running": 409,
  "on-camera": 409,
  "not-found": 404,
  unanswered: 409,
};

/**
 * A browser's statistic, off the wire, or null where it is not one.
 *
 * Rejected here as well as inside `RateController.observe`, which silently
 * drops a reading it will not believe. The two are not the same guard: the
 * controller's refusal keeps bad evidence out of a decision, and this one
 * makes a browser sending nonsense visible as a 400 rather than as an
 * adaptive mode that mysteriously never acts.
 */
function viewerStats(camera: string, raw: unknown): ViewerStats | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const { rtt, loss, egress, capacity, frameAge, size, fps } = raw as Record<string, unknown>;
  const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  if (!finite(rtt) || !finite(loss) || !finite(egress) || !finite(capacity)) return null;
  if (loss < 0 || loss > 1 || rtt < 0 || egress < 0 || capacity < 0) return null;
  return {
    camera, rtt, loss, egress, capacity,
    ...(finite(frameAge) && frameAge >= 0 ? { frameAge } : {}),
    ...(typeof size === "string" ? { size } : {}),
    ...(finite(fps) && fps > 0 ? { fps } : {}),
  };
}

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
   * The way back in, assembled from the configuration and one secret row
   * (R-UI-18).
   *
   * **It cannot throw.** `GET /status` is what answers on a device that has
   * gone wrong, and an unreadable config.yaml is one of the ways a device
   * goes wrong — so a configuration that will not load falls back to the
   * shipped defaults rather than taking the panel down. Those defaults are
   * also what such a device is genuinely reachable on: they are what the
   * access-point profile it is running was rendered from.
   */
  const wayBackIn = (): WayBackIn => {
    let config = DEFAULT_CONFIG;
    try {
      config = loadConfig(deps.configPath);
    } catch {
      // Not logged. This route is polled by a page every few seconds, and a
      // line per poll would bury the reason the configuration will not load
      // under thousands of copies of the fact that it will not.
    }
    // Spread rather than assigned, so *cannot tell* is an absent key rather
    // than an explicit `undefined` — `null` already means something else here
    // and the two must not be able to be confused by a reader of the body.
    const passphrase = publishableApPassphrase(deps.secrets?.get?.("ap_psk"));
    return {
      ssid: config.network.ap.ssid,
      // Without the prefix length: an operator types this into a browser, and
      // `192.168.77.1/24` is not an address a browser can be given.
      address: config.network.ap.address.split("/")[0],
      // mDNS answers for `<hostname>.local`, and the panel prints what gets
      // typed rather than a name plus an instruction about what to add to it.
      hostname: `${config.system.hostname}.local`,
      ...(passphrase === undefined ? {} : { passphrase }),
    };
  };

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
   * Which ways off this board a peer could use, for `outputReach()` (R-UI-24).
   *
   * **False means *no evidence*, never *broken*.** A daemon assembled with no
   * network layer, or a path nothing has probed, answers false here, and
   * `outputReach` then says a listener is not reachable. That is the honest
   * direction for this particular question: R-UI-24 exists so an operator is
   * not left waiting for a player to connect to a port nothing can dial, and
   * "no path has been shown to work" is the same practical answer as "no path
   * works" for somebody about to try it. `PathReport.evidence` is what is
   * read rather than `standing`, for the reason that field was added:
   * `standing-by` covers a path that is reaching, a path that is failing, and
   * a path nothing has looked at, and treating those as one is K-42.
   */
  const reachPaths = async (): Promise<ReachPaths> => {
    const reach = deps.reachState === undefined ? null : await deps.reachState();
    const remote = deps.remoteState === undefined ? null : await deps.remoteState();
    const reaching = (name: PathName): boolean =>
      reach?.paths.some((p) => p.path === name && p.evidence === "reaching") ?? false;
    return {
      lan: reaching("ethernet") || reaching("wifi_client"),
      cellular: reaching("modem"),
      mesh: (remote?.online ?? false) && (remote?.addresses.length ?? 0) > 0,
    };
  };

  /**
   * One browser's own statistic, and what it wants (spec §8.2).
   *
   * `POST /cameras/<id>/viewers/<viewer>` carries any of three things, each
   * optional and each independent of the others:
   *
   *   - `want` — `"video"`, `"stills"` or `"off"`, what this browser is
   *     asking this camera for;
   *   - `fullRate` — true while the operator holds the key, false the moment
   *     they let go (R-VID-13);
   *   - `stats` — the browser's own WebRTC measurement of the path its
   *     picture is arriving on, which is the evidence the rate controller
   *     acts on and the only measurement of that path anything has.
   *
   * A post carrying none of them is a **reconnect**: the answer is the state
   * as it now stands, which is what §8.2 means by publishing on reconnect.
   *
   * `DELETE` is one page closing: it ends that browser's subscription to
   * *this* camera and touches none of its others — and, emphatically, no
   * configured RTSP, SRT or RTP output. Those are stored decisions of the
   * operator's and they go on leaving the aircraft whether or not anyone
   * has a browser open (§8.6).
   *
   * **The freshness of a statistic is not this route's to state.** It carries
   * what the browser measured and lets `Viewers` stamp the arrival in this
   * daemon's own clock. A browser cannot tell this device how fresh to
   * consider its own reading, and nothing here re-dates one.
   */
  const viewerRoute = async (
    method: string,
    id: string,
    viewer: string,
    body: unknown,
    say: (line: string) => void,
  ): Promise<RouteResult> => {
    const viewers = deps.viewers;
    if (viewers === undefined) {
      return noCameraLayer(`${method} /cameras/${id}/viewers/${viewer}`, say);
    }
    if (!VIEWER_ID.test(viewer)) {
      return { status: 404, body: { error: "that is not a viewer this device would have issued" } };
    }
    const config = loadConfig(deps.configPath);
    if (!config.cameras.some((c) => c.id === id)) {
      return { status: 404, body: { error: `no camera is configured with the id "${id}"` } };
    }

    if (method === "DELETE") {
      viewers.leave(viewer, id);
      return { status: 200, body: viewers.state(id, viewer) };
    }
    if (method !== "POST") {
      return { status: 404, body: { error: `no route for ${method} /cameras/${id}/viewers/${viewer}` } };
    }

    if (body !== undefined && (typeof body !== "object" || body === null || Array.isArray(body))) {
      return { status: 400, body: { error: "a viewer report is an object" } };
    }
    const sent = (body ?? {}) as { want?: unknown; fullRate?: unknown; stats?: unknown };
    if (sent.want !== undefined && !WANTS.includes(sent.want as Want)) {
      return { status: 400, body: { error: 'want is "video", "stills" or "off"' } };
    }
    if (sent.fullRate !== undefined && typeof sent.fullRate !== "boolean") {
      return { status: 400, body: { error: "fullRate is true while the key is held and false when it is let go" } };
    }
    const stats = sent.stats === undefined ? undefined : viewerStats(id, sent.stats);
    if (sent.stats !== undefined && stats === null) {
      return {
        status: 400,
        body: {
          error: "a statistic carries rtt, loss, egress and capacity as finite numbers, "
            + "with loss between 0 and 1",
        },
      };
    }

    // In the order a browser means them: what it is asking for, then whether
    // the key is held (which only a video subscriber may hold), then what it
    // measured — so a report arriving in the same post as the subscription
    // that made it evidence is treated as evidence.
    if (sent.want !== undefined) viewers.subscribe(viewer, id, sent.want as Want);
    if (sent.fullRate !== undefined) viewers.fullRate(viewer, id, sent.fullRate);
    if (stats !== undefined && stats !== null) viewers.report(viewer, stats);
    return { status: 200, body: viewers.state(id, viewer) };
  };

  /**
   * Recording, stills, and the captures this device is holding (R-CAM-17,
   * R-CAM-18, R-STO-06).
   *
   * **One operation at a time, per camera, and a second press is refused**
   * rather than queued — `Recorder` holds that guard and answers `busy`, and
   * this is where that becomes a 409. An operator who presses REC twice must
   * not get two branches on one tee, and the honest answer to the second
   * press is *not now*, not a silent success.
   *
   * **A capture the camera holds is a 404 with the reason.** Yonder never saw
   * the file: it is on the camera's own medium, and offering it here and
   * failing to produce it would be the console claiming something it does not
   * have (R-CAM-18).
   *
   * The name off the URL is matched against `SAFE_CAPTURE_NAME` **after it is
   * decoded and before it is used for anything**, exactly as `CAMERA_ID`
   * guards the id above and for the same reason: this is the second place in
   * this router where something from a URL becomes part of a file path.
   */
  const captureRoute = async (
    method: string,
    id: string,
    verb: string,
    body: unknown,
    say: (line: string) => void,
  ): Promise<RouteResult> => {
    const recorder = deps.recorder;
    if (recorder === undefined) {
      return noCameraLayer(`${method} /cameras/${id}/${verb}`, say);
    }
    /** A refusal, with the status this route answers that kind with. */
    const refuseWith = (
      refusal: Refusal, overrides: Partial<Record<Refusal["because"], number>> = {},
    ): RouteResult => {
      say(`${method} /cameras/${id}/${verb}: ${refusal.refused}`);
      return {
        status: overrides[refusal.because] ?? REFUSAL_STATUS[refusal.because],
        body: { error: refusal.refused },
      };
    };

    if (method === "POST" && verb === "record") {
      const action = (body as { action?: unknown } | undefined)?.action;
      if (action !== "start" && action !== "stop") {
        return { status: 400, body: { error: 'action must be "start" or "stop"' } };
      }
      const answer = await recorder.record(id, action);
      return isRefusal(answer) ? refuseWith(answer) : { status: 200, body: answer.ok };
    }

    if (method === "POST" && verb === "photo") {
      // Answered only once the file is written, never on dispatch: a capture
      // reported before it exists is a thumbnail that 404s.
      const answer = await recorder.photo(id);
      return isRefusal(answer) ? refuseWith(answer) : { status: 200, body: answer.ok };
    }

    if (method === "GET" && verb === "captures") {
      const answer = await recorder.captures(id);
      // **The answer names the camera it is about.** The captures panel
      // builds every thumbnail, View and Download URL from an id, and the
      // node that fetched this list emits a fresh message — `msg.camera` does
      // not survive the round trip, the same fact `adapter.ts` records for a
      // refusal. A listing that did not say whose it was could be drawn
      // against a different camera's page after a switch, offering files that
      // are not there.
      return isRefusal(answer)
        ? refuseWith(answer)
        : { status: 200, body: { camera: id, captures: answer.ok } };
    }

    if (verb.startsWith("captures/") && (method === "GET" || method === "DELETE")) {
      let name = verb.slice("captures/".length);
      try {
        name = decodeURIComponent(name);
      } catch {
        // A malformed escape is not a name; it is refused as one rather than
        // throwing out of this router.
        return { status: 404, body: { error: "that is not a capture on this device" } };
      }
      if (!SAFE_CAPTURE_NAME.test(name)) {
        return { status: 404, body: { error: "that is not a capture on this device" } };
      }
      if (method === "DELETE") {
        const answer = await recorder.remove(id, name);
        // 404 for a camera-held one, with the body saying the camera holds
        // it — the same answer the fetch gives, because it is the same fact.
        return isRefusal(answer)
          ? refuseWith(answer, { "on-camera": 404 })
          : { status: 200, body: answer.ok };
      }
      const answer = await recorder.fetch(id, name);
      if (isRefusal(answer)) return refuseWith(answer, { "on-camera": 404 });
      return {
        status: 200,
        body: answer.ok.bytes,
        contentType: answer.ok.contentType,
      };
    }

    return { status: 404, body: { error: `no route for ${method} /cameras/${id}/${verb}` } };
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
    // Before the probes, deliberately. A browser saying what it is watching
    // and what it is measuring needs no `v4l2-ctl` run on its behalf, and a
    // sweep of the board on every statistic — at a report a second, per
    // viewer — would be this route spending the device on bookkeeping.
    if (verb.startsWith("viewers/")) {
      return viewerRoute(method, id, verb.slice("viewers/".length), body, say);
    }

    // Before the probes as well, and for the same reason: pressing REC, taking
    // a still or listing what has been captured needs no `v4l2-ctl` run on the
    // operator's behalf. A recording is taken off the pipeline that is already
    // running, and whether it is running is the supervisor's answer rather
    // than a fresh sweep of the board.
    if (verb === "record" || verb === "photo" || verb === "captures"
      || verb.startsWith("captures/")) {
      // The configuration is still what says a camera exists — every other
      // answer here would be `Recorder`'s, and it reads the same list.
      const known = loadConfig(deps.configPath).cameras.some((c) => c.id === id);
      if (!known) {
        return { status: 404, body: { error: `no camera is configured with the id "${id}"` } };
      }
      return captureRoute(method, id, verb, body, say);
    }

    /**
     * **Take a camera out of the configuration** (R-CAM-21, R-CAM-05,
     * R-CFG-01, R-CFG-03).
     *
     * The mirror of `POST /cameras`, and the other half of the state the
     * operator found a board in. A camera's identity is the socket it is
     * attached to (R-CAM-05), so moving it between USB ports makes it a
     * *different* camera as far as the configuration is concerned. Nothing
     * ever removed the old entry, so one physical camera ended up configured
     * three times, twice against empty ports. `POST /cameras` could adopt;
     * nothing could undo it, and the only repair left was editing
     * `/etc/yonder/config.yaml` by hand on the device — which is the exact
     * thing R-CFG-01's single writer exists so that nobody has to do.
     *
     * **Before the probe guard below, deliberately**, and for the same reason
     * the capture routes are: this needs no `v4l2-ctl` run on the operator's
     * behalf. It is a configuration edit, and the commonest case for it is a
     * socket with nothing on it — a sweep would tell it nothing it does not
     * already know, and a daemon with no camera layer at all should still be
     * able to shed an entry it can never answer for.
     *
     * **Through `engine.apply`, never a direct write** (R-CFG-03). It is
     * journalled, confirmable and revertible on the same terms as every other
     * change to the single declarative file; whether it earns a confirmation
     * window is the engine's decision, not this route's.
     *
     * **What happens to the captures this camera made: they stay.**
     * `/var/lib/yonder/captures/<id>/` is untouched here. Removing an entry
     * is a configuration change and the apply engine can revert it — deleting
     * the recordings would make half of it irreversible while the console
     * told the operator the whole thing could be undone, and flight footage
     * is not a thing to destroy as a side effect of tidying a list. R-CAM-18
     * gives deleting a capture its own control, on the camera's own page,
     * where an operator does it deliberately.
     *
     * The consequence, stated rather than discovered: ids are handed out
     * lowest-free, so re-adopting a camera after removing `cam2` gives it
     * `cam2` again — and that camera's page will list the removed camera's
     * captures, because they are filed under the id. On a board where the
     * same camera has moved sockets that is very often the right answer, and
     * where it is not, the captures panel is where they can be removed.
     */
    if (method === "DELETE" && verb === "") {
      const held = loadConfig(deps.configPath);
      const going = held.cameras.find((c) => c.id === id);
      if (going === undefined) {
        return { status: 404, body: { error: `no camera is configured with the id "${id}"` } };
      }
      // The supervisor's own observation, never the configuration's
      // `enabled`: what must not be pulled out from under a pipeline is a
      // pipeline that is actually up. Absent supervisor means this daemon
      // started nothing, so nothing is running.
      const refusal = removalRefusal(deps.supervisor?.state(id).state ?? "stopped");
      if (refusal !== null) {
        say(`DELETE /cameras/${id}: ${refusal}`);
        return { status: 409, body: { error: refusal } };
      }
      // A failed run can still have a retry armed. Retire it synchronously,
      // before apply yields to a renderer. Revert restores configuration,
      // not runtime Start intent (R-CTL-01); a rejected removal stays stopped.
      deps.supervisor?.stop(id);
      const next = structuredClone(held);
      next.cameras = next.cameras.filter((c) => c.id !== id);
      say(`cameras: removed ${id}, which was configured on ${going.device}`);
      // `camera`, not `id`, for the reason `POST /cameras` gives: the apply's
      // own answer carries an `id` — the confirmation handle — and two
      // different ids under one name in one body is how a caller confirms the
      // wrong thing.
      return { status: 200, body: { camera: id, ...(await deps.engine.apply(next)) } };
    }

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
      const run = supervisor.state(id);
      const device = answer?.device ?? null;
      const byPathStable = found?.byPathStable ?? false;
      const capabilities = found?.capabilities ?? null;
      // From the recorder that holds the recording, never from a count of
      // files on the disk: a file is there whether or not anything is still
      // writing to it, and a page drawing a REC pill off the second would go
      // on drawing it for ever.
      const recorderState = deps.recorder === undefined
        ? null
        : await deps.recorder.state(id);
      /**
       * How many captures this camera has, for the link that opens the panel
       * listing them (R-CAM-18).
       *
       * A directory read per camera-page poll, which is worth naming: it is
       * the same order of cost as the `statfs` the recorder's own state does,
       * and it is the only way the count on the page can be true without the
       * panel having been opened first. A count the operator has to open a
       * panel to learn is a count that tells them nothing about whether to.
       *
       * A refusal counts as none rather than propagating: this is a number
       * beside a link, and a camera whose listing cannot be read is a camera
       * whose panel will say so when it is opened.
       */
      const listed = deps.recorder === undefined
        ? undefined
        : await deps.recorder.captures(id);
      const heldCaptures = listed === undefined || isRefusal(listed) ? [] : listed.ok;
      return {
        camera,
        run,
        device,
        card: answer?.card ?? null,
        byPathStable,
        capabilities,
        reason: rejection?.reason ?? null,
        encoder,
        display: cameraStrip({
          camera, run, device, byPathStable, encoder,
          refusal: refuse({
            camera,
            capabilities: capabilities ?? noCapabilities(),
            encoder,
            rtspBase: RTSP_BASE,
            knownDevices: known,
          }),
        }),
        // From what the device answered a moment ago, never from a list. A
        // camera that answered nothing yields every row, which is the honest
        // reading: an operator has to be able to tell *this camera cannot*
        // from *this page failed*.
        facts: capabilityFacts(capabilities ?? noCapabilities()),
        // The two instrument payloads, from the same read as everything
        // above — never a second sweep, so the deck and the readout strip
        // can never disagree about the same camera.
        deck: cameraDeck({
          camera, capabilities, encoder, paths: await reachPaths(),
          // The same two facts the `recorder` field below carries, on the
          // deck's own payload: the capture column draws the shutter key's
          // destination line and its elapsed time from the first, and the
          // `Captures (n)` link from the second. Read once here and handed to
          // both, so the pill on the picture and the key under it can never
          // be reading two different answers from one read.
          recorder: recorderState,
          captures: heldCaptures.length,
        }),
        aim: aimPanel(capabilities),
        // From the recorder that holds the recording, never from a count of
        // files on the disk: a file is there whether or not anything is still
        // writing to it, and a page drawing a REC pill off the second would
        // go on drawing it for ever.
        recorder: recorderState,
        /**
         * What this camera is holding, in the shape the captures panel draws
         * (R-CAM-18).
         *
         * **The same listing the deck's count is composed from**, on the same
         * read, for the reason the two instrument payloads beside it are:
         * a panel and a link that disagreed about how many captures there are
         * would be two answers to one question on one screen. It costs
         * nothing extra — the count above already had to read the directory.
         *
         * `camera` travels with it because the panel builds every thumbnail,
         * View and Download URL from an id, and the node that carries this to
         * the page emits a fresh message that has no `msg.camera` of its own.
         */
        captures: { camera: id, captures: heldCaptures },
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
            error: "name at least one recognised camera control, each a finite "
              + "number, or a boolean for a switch like autoFocus (null leaves it alone)",
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

    /**
     * R-CTL-02, R-CTL-03: the stream settings, through the apply engine.
     *
     * **Never a write to config.yaml from here.** The engine is what makes a
     * change reversible: it snapshots the document, renders it, and either
     * keeps it or arms the confirmation window — and it decides which from
     * `apply/reachability.ts` and `CAMERA_EXEMPT_LEAVES`, not from anything
     * this route knows. So the Setup deck draws a countdown exactly where one
     * armed, because it is drawing the engine's own answer rather than a
     * prediction of it.
     *
     * Deliberately unlike `run` and `controls` above, which are runtime and
     * take effect at once: those change what the device is *doing*, this
     * changes what it *is*.
     */
    if (method === "POST" && verb === "settings") {
      const next = setCameraSettings(config, id, body as CameraSettings);
      if (!next.ok) return { status: 400, body: { error: next.error } };
      return { status: 200, body: await deps.engine.apply(next.config) };
    }

    /**
     * The Setup deck's **Apply** — one whole draft, through the apply engine
     * (R-CFG-03, R-CTL-02, spec §7).
     *
     * Deliberately not `settings` above, and the difference is the point of
     * this task. `settings` takes the seven flat keys a `ui-number-input`
     * could post one at a time, which is how a page ends up applying on blur:
     * one field, one apply, one confirmation window per keystroke that leaves
     * a box. This takes the *shared draft* — everything the operator changed,
     * once, when they pressed Apply — validates it as a whole, and submits it
     * as one change. A Live deck never reaches here at all: an image control
     * posts to `controls`, which touches no configuration and arms no window.
     *
     * **Validated before it is applied, and never repaired** (R-CMD-04).
     * `validateDraft` owns the cross-field rules the schema cannot express —
     * a floor above its ceiling is two legal numbers in an illegal order —
     * and its answer is returned by path, so the page marks the field the
     * operator has to change rather than showing a sentence about a form.
     * The bounds themselves stay the schema's, checked by the engine.
     *
     * **The window arms where `apply/reachability.ts` says it does**, not
     * where this route guesses. The answer carries the engine's own deadline,
     * which is what the Setup deck's countdown draws.
     */
    if (method === "POST" && verb === "apply") {
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        return { status: 400, body: { error: "an apply needs a draft object naming what to change" } };
      }
      /**
       * The body is the deck's own staged draft, flat and in the blueprint's
       * UI-facing names — `streamMode`, `previewLadderBottom` — because that
       * is the shape the one client that posts here holds. `deckDraft()` is
       * the seam between those names and the schema's; it translates and
       * judges nothing.
       *
       * **A staged path this device does not know is refused, by name.**
       * Dropping it would be an Apply that reported success and left one of
       * the operator's edits unmade, which is the failure the whole draft
       * mechanism exists to remove.
       */
      const { draft, name, unknown } = deckDraft(body as Record<string, unknown>);
      if (unknown.length > 0) {
        return {
          status: 400,
          body: {
            error: `this device does not know how to apply: ${unknown.join(", ")}`,
            problems: unknown.map((path) => ({ path, message: "not a setting this device has" })),
          },
        };
      }
      // The rungs *this* camera makes, not the three the schema allows in
      // general: a size the schema permits is still wrong for a camera that
      // does not capture it, which is the case `validateDraft`'s own
      // `supportedRungs` argument exists for.
      const found = await view(false);
      const formats = found.capabilities?.formats;
      const offers = formats !== undefined && formats.state === "present" ? formats.value : [];
      const rungs = PREVIEW_RUNGS.filter((rung) => {
        const [w, h] = rung.split("x").map(Number);
        return offers.some((f) => f.width === w && f.height === h);
      });
      /**
       * **And the capture itself, against what this camera answered**
       * (R-CAM-14, R-VID-07). `validateDraft` owns the cross-field rules the
       * schema cannot express; this is the one rule the schema cannot express
       * *and* cannot know — 1920x1080 is inside every bound in the schema and
       * still wrong for a camera that does not make it.
       *
       * Judged over the draft **laid on the applied values**, not over the
       * draft alone: an operator who changes only the rate has staged no size,
       * and the size the rate has to be legal at is the one already running.
       *
       * Refused here rather than left to `video/pipeline.ts`'s `refuse()`,
       * which would catch the same pair one layer later — after the engine had
       * written the document and armed the window, with the picture gone until
       * the rollback took it back. Same function, so the two cannot disagree
       * about what this camera offers.
       */
      const wanted = {
        width: draft.width ?? camera.width,
        height: draft.height ?? camera.height,
        framerate: draft.framerate ?? camera.framerate,
      };
      const staged = draft.width !== undefined || draft.height !== undefined
        || draft.framerate !== undefined;
      // Only against a list this camera actually answered. `offers` is also
      // `[]` for a camera that has not been probed, and refusing every size on
      // the strength of an empty list would make an unprobed camera
      // unconfigurable — `refuse()` states *that* fact, in its own words, at
      // the moment a pipeline is composed.
      const refusal = staged && offers.length > 0 ? captureRefusal(offers, wanted) : null;
      // Named for the picker that has to change, so `draftPathFor()` puts the
      // sentence under a control rather than under the form: `width` when the
      // size itself is not on offer, `framerate` when the size is fine and the
      // rate is not made at it. Decided from the two lists, never by reading
      // the sentence back.
      const sizeOffered = captureSizes(offers)
        .some((sz) => sz.width === wanted.width && sz.height === wanted.height);
      const problems = [
        ...validateDraft(draft, rungs),
        ...(refusal === null
          ? []
          : [{ path: sizeOffered ? "framerate" : "width", message: refusal }]),
      ];
      if (problems.length > 0) {
        return {
          status: 400,
          body: { error: "this draft cannot be applied as it stands", problems },
        };
      }
      const next = applyCameraDraft(config, id, draft);
      if (!next.ok) return { status: 400, body: { error: next.error } };
      // The camera's own name, when the deck staged one. Written here rather
      // than inside `applyCameraDraft` because a name is not a stream or a
      // preview policy, and a function that quietly renamed a camera while
      // applying a bitrate would be doing two things under one name.
      if (name !== undefined) {
        const renamed = next.config.cameras.find((c) => c.id === id);
        if (renamed !== undefined) renamed.name = name;
      }
      const applied = await deps.engine.apply(next.config);
      const video = deps.pipelineRenderer?.report(id);
      return {
        status: 200,
        body: {
          ...applied,
          ...(video === undefined ? {} : { video }),
          // The renderer reports what actually happened, including a live
          // host refusal falling back to a restart. Draft-only callers still
          // use the static warning when this daemon has no video renderer.
          interruption: video?.interruption ?? interruption(draft, {
            width: camera.width,
            height: camera.height,
            framerate: camera.framerate,
            codec: camera.codec,
            stream: camera.stream,
            preview: camera.preview,
          }),
        },
      };
    }

    /**
     * One output stopped or started (R-UI-24, spec §7's *Outputs* table).
     *
     * Through the apply engine like every other change to what leaves the
     * aircraft, and emphatically not as a runtime toggle: `enabled` is a
     * stored field, and turning an RTP push to a ground station back on is
     * exactly the kind of change `R-NET-07` holds pending a confirmation.
     * **A stopped output keeps its port, its path and its secret** — only
     * `enabled` is written, so nothing has to be typed again to start it.
     */
    if (method === "POST" && verb.startsWith("outputs/")) {
      const kind = verb.slice("outputs/".length);
      const enabled = (body as { enabled?: unknown } | undefined)?.enabled;
      if (typeof enabled !== "boolean") {
        return { status: 400, body: { error: "an output is switched with { enabled: true | false }" } };
      }
      const next = structuredClone(config);
      const target = next.cameras.find((c) => c.id === id);
      const output = target?.outputs.find((o) => o.kind === kind);
      if (target === undefined || output === undefined) {
        return { status: 404, body: { error: `this camera has no ${kind} output` } };
      }
      output.enabled = enabled;
      return { status: 200, body: await deps.engine.apply(next) };
    }

    // The credential leaves the daemon on exactly one route. Everything else
    // answers with the reference the configuration holds, never the value
    // (R-SEC-10). This one is allowed it because the operator is being handed
    // a URL to copy, which is the whole of R-VID-15.
    if (method === "GET" && verb === "stream-address") {
      const answering = deps.addresses === undefined ? [] : await deps.addresses();
      const addresses = answering.map((a) => a.address);
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
        // Every address, with the path a peer would reach each one over, so the
        // RTSP URL is built from the path its own verdict rests on rather than
        // from whichever address happened to be first. See `RouterDeps.
        // addresses` and `net/dial-in.ts`.
        answering,
        rtspPassword: deps.rtspPassword?.() ?? null,
        rtspPort: RTSP_PORT,
        // **The device's own paths, at the moment the line was asked for**
        // (R-UI-24). The same `reachPaths()` the deck's outputs are drawn
        // from, so an output the deck says nothing can dial in to and the
        // address for that output cannot disagree — a page saying
        // *unreachable* beside a line offered as usable is the console
        // contradicting itself about one fact.
        paths: await reachPaths(),
      });
      return { status: 200, body: { renderings } };
    }

    return { status: 404, body: { error: `no route for ${method} /cameras/${id}` } };
  };
   /**
   * What every `/mav/*` route answers when this build has no telemetry layer.
   *
   * The same shape `/modem/state` and `/remote/state` use: a 503 naming the
   * absence, never a 500 and never an empty link state — a page handed one of
   * those would draw a device patiently searching for an autopilot it has no
   * means of finding.
   */
  const noTelemetry = (): RouteResult => ({
    status: 503,
    body: { error: "this device has no telemetry layer; see the device journal for the reason" },
  });

  /** Both halves of the telemetry answer. See MavlinkStateBody. */
  const mavlinkState = (mavlink: MavlinkControl): MavlinkStateBody => ({
    link: mavlink.state(),
    telemetryRunning: mavlink.telemetryRunning,
    routerRunning: mavlink.routerRunning,
  });

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

      // Deliberately in front of the gate below. It carries an apply state,
      // an expiry, the reason the renderer set could not be assembled, and
      // the way back into the device — and it is the one thing that makes a
      // board whose secrets.yaml is unreadable diagnosable at all. Gating it
      // would mean a device that can only say "403" about a fault an operator
      // has to be on the device to fix anyway.
      //
      // **`wayBackIn` is the only configuration this route carries, and it is
      // meant to stay that way** (R-UI-18). Three fields that are beaconed,
      // handed out by DHCP and announced over mDNS anyway, plus a passphrase
      // that is either the published one or nothing. A test asserts that
      // nothing else out of config.yaml follows them here; if a future field
      // needs the gate, it belongs on a route that has one.
      if (method === "GET" && path === "/status") {
        return { status: 200, body: { ...deps.engine.status(), wayBackIn: wayBackIn() } };
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
              // no Aim group before anyone goes looking for one — R-UI-20
              // applied a level up from the page it governs.
              summary: summarise(detected.capabilities),
              // R-CAM-05 in words. Nothing rendered `byPathStable` until this
              // page did, and until something does, the stable-identity work
              // stops at the type: an operator never learns whether the camera
              // they configured will still be the one this name means after a
              // reboot.
              identity: identityWords(detected.byPath, detected.byPathStable),
              // Null where nothing is configured for this socket yet: a
              // detected camera with no id has no page to open (R-UI-03).
              id: config.cameras.find((c) => c.device === detected.byPath)?.id ?? null,
            })),
            rejected,
            // Both totals live here rather than on any one camera's page,
            // because both are shared: *starting the second camera would need
            // 2.1 Mb/s more* is a sentence no single camera's page can say
            // (R-VID-11).
            budget: uplinkBudget(config.cameras),
            /**
             * `ui-yonder-index`'s whole payload — the probe-to-row adapter
             * (R-CAM-12, R-CAM-05).
             *
             * Beside `found` and not instead of it: `found` is what the probe
             * answered and this is what one page draws from it, and collapsing
             * the two would make every other reader of this route depend on
             * one widget's field names. `video/present.ts` owns the mapping;
             * this route owns nothing but handing it the three things it
             * cannot read for itself — the configuration, the supervisor's
             * observed run state, and (when something measures one) the
             * egress. **No `egressKbps` is passed**, deliberately: nothing on
             * this branch measures a camera's egress, so every row reads
             * `rate: null` rather than echoing the configured target back as
             * if it had been observed.
             */
            index: cameraIndex({
              found,
              rejected,
              cameras: config.cameras,
              run: (id) => deps.supervisor?.state(id).state ?? "stopped",
            }),
          },
        };
      }

      /**
       * **Adopt a camera the board has already found** (R-UI-03, R-CAM-05).
       *
       * The one thing the Cameras page could not do. A detected camera on a
       * socket nothing is configured for carries `id: null`, which is honest
       * — `cameraIndex()` composes `state: "Not configured"` for it and
       * `YonderIndex` disables OPEN, because a page for a camera the
       * configuration has never heard of answers 404 on every widget. But
       * nothing anywhere could give it an entry, so an operator who plugged
       * a second camera in saw it listed, saw a dead key, and had no way
       * forward. Found by the operator on a board, not by any test.
       *
       * Everything an entry needs is already in hand at this point and none
       * of it is guessed: the socket is the detection's own `byPath`, the
       * name is the card the device reported, and every other field has a
       * schema default. Nothing is written that the device did not say.
       *
       * The socket, never `/dev/videoN` — R-CAM-05's whole subject. Unplug
       * the camera and plug it into the same socket and the `by-path` name is
       * the same string, so this entry still means this camera whatever
       * enumeration number the kernel hands it next.
       *
       * Through `engine.apply` like every other configuration change, so it
       * is journalled, confirmable and revertible (R-CFG-03). Adopting a
       * camera is not load-bearing — it starts nothing and takes no path
       * away — so it carries no confirmation window; the engine decides that,
       * not this route.
       */
      if (method === "POST" && path === "/cameras") {
        if (deps.cameras === undefined) return noCameraLayer("POST /cameras", say);
        const device = (body as { device?: unknown } | undefined)?.device;
        if (typeof device !== "string" || device === "") {
          return { status: 400, body: { error: "name the camera to adopt with { device: \"<by-path name>\" }" } };
        }
        const config = loadConfig(deps.configPath);
        if (config.cameras.some((c) => c.device === device)) {
          return { status: 409, body: { error: "this socket already has a camera configured on it" } };
        }
        // Asked of the probe rather than taken from the body: a caller may
        // name any string, and a configuration entry for a socket this board
        // cannot see is a camera page that will never answer.
        const { found } = await deps.cameras.detect();
        const detected = found.find((d) => d.byPath === device);
        if (detected === undefined) {
          return { status: 404, body: { error: "no camera is attached to that socket" } };
        }
        if (config.cameras.length >= 8) {
          return { status: 409, body: { error: "this board already has the eight cameras it can carry" } };
        }
        // `Cam N` on the lowest free number, which is R-UI-27's default and
        // is what the operator renames from. Lowest free rather than
        // next-highest: a board that has had cameras removed should not count
        // upward for ever.
        const taken = new Set(config.cameras.map((c) => c.id));
        let n = 1;
        while (taken.has(`cam${n}`)) n += 1;
        const id = `cam${n}`;
        const next = structuredClone(config);
        next.cameras.push({
          id,
          // The card the device reported, at the schema's 48-character cap.
          // Not the socket: an operator names a camera for where it points,
          // and `Global Shutter Camera: Global S` is at least a thing they
          // can recognise while they think of a better one.
          name: detected.card.slice(0, 48),
          source: detected.source ?? "usb",
          ...(detected.source === "csi" && detected.capabilities.formats.state === "present"
            ? { width: detected.capabilities.formats.value[0].width,
              height: detected.capabilities.formats.value[0].height,
              framerate: detected.capabilities.formats.value[0].rates[0] }
            : {}),
          device,
        } as (typeof next.cameras)[number]);
        say(`cameras: adopted ${device} as ${id}`);
        // `camera`, not `id`: the apply's own answer carries an `id` — the
        // confirmation handle — and two different ids under one name in one
        // body is how a caller confirms the wrong thing.
        return { status: 200, body: { camera: id, ...(await deps.engine.apply(next)) } };
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

      // What the modem says about itself, and which way out is actually
      // working. Two routes rather than one because they answer different
      // questions and fail independently: a board can have a modem this
      // daemon can read and no reach monitor, or the reverse.
      //
      // Absent means *this daemon has no such layer*, which is a 503 naming
      // the absence — never an empty record, which a page would render as a
      // modem with no signal on a board that has one.
      if (method === "GET" && path === "/modem/state") {
        if (deps.modemState === undefined) {
          say("GET /modem/state: there is no modem layer on this daemon to ask");
          return { status: 503, body: { error: "this device cannot report a modem" } };
        }
        // Never a credential. ModemState is assembled from what the device
        // reports, not from the configuration, so the APN comes back off the
        // connected bearer and `gsm.password` has no field to arrive in
        // (R-SEC-10).
        return { status: 200, body: await deps.modemState() };
      }

      if (method === "GET" && path === "/reach/state") {
        if (deps.reachState === undefined) {
          say("GET /reach/state: there is no reach monitor on this daemon to ask");
          return { status: 503, body: { error: "this device cannot report its way out" } };
        }
        return { status: 200, body: await deps.reachState() };
      }

      // The same shape as /net/join and /remote/join: the router merges one
      // section into the document and hands the whole thing to the apply
      // engine. Nothing about a modem is stored anywhere else, and the
      // response is an apply status, not a configuration — R-SEC-10 says
      // `gsm.password` never comes back out of this route, and an apply
      // status is not a shape it could arrive in.
      //
      // **The password takes the same road the Wi-Fi passphrase does.** The
      // operator types a string; `config.yaml` holds a reference to a row in
      // `secrets.yaml`. `configureModem` is the one thing that converts
      // between them, exactly as `joinNetwork` is for `network.client.psk` —
      // and it is why this route needs a secret store rather than being pure
      // schema validation. Without one there is nowhere to put the
      // credential, and applying a reference to a row that was never written
      // would take the modem off the air while reporting success.
      //
      // The submitted password is redacted at the top of this function like
      // every other body, so nothing below can log it (R-SEC-10).
      if (method === "POST" && path === "/modem/configure") {
        if (deps.secrets === undefined) {
          say("POST /modem/configure: the secret store could not be read, so nothing can be stored in it");
          return {
            status: 503,
            body: { error: "the device's secrets could not be read; see the device journal" },
          };
        }
        const wanted = configureModem(loadConfig(deps.configPath), body, deps.secrets);
        if (!wanted.ok) return { status: 400, body: { error: wanted.error } };
        return { status: 200, body: await deps.engine.apply(wanted.config) };
      }

      // R-CEL-09's "on request", answered by the same ReachMonitor the
      // automatic probes use — never a second way to decide whether a path
      // works, only a second reason to ask it.
      if (method === "POST" && path === "/reach/test") {
        if (deps.testPath === undefined) {
          say("POST /reach/test: there is no reach monitor on this daemon to ask");
          return { status: 503, body: { error: "this device cannot test its way out" } };
        }
        const wanted = (body as { path?: unknown } | undefined)?.path;
        if (wanted !== "ethernet" && wanted !== "modem" && wanted !== "wifi_client") {
          return { status: 400, body: { error: "name one of: ethernet, modem, wifi_client" } };
        }
        return { status: 200, body: { path: wanted, reached: await deps.testPath(wanted) } };
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

      // ---- telemetry: what the Telemetry page reads and drives ----------
      //
      // Five routes over one injected object (`MavlinkControl`). None of them
      // shells out, re-implements a measurement or holds state of its own:
      // the renderer owns the router and the tracker owns what was measured,
      // and these carry the answers to a page.

      if (method === "GET" && path === "/mav/state") {
        const mavlink = deps.mavlink;
        if (mavlink === undefined) {
          say("GET /mav/state: there is no telemetry layer on this daemon to ask");
          return noTelemetry();
        }
        // R-MAV-10, all of it: heartbeat present, telemetry running, and the
        // endpoints in use. Never `mavlink.state()` on its own — see
        // MavlinkStateBody for what that would silently drop.
        return { status: 200, body: mavlinkState(mavlink) };
      }

      /**
       * R-DIA-04 — verify the MAVLink path end to end — as the three-link
       * chain §8 draws rather than a single verdict, and computed by a pure
       * function with tests of its own (`mav/check.ts`). The distinction that
       * matters is `ok: null`: a link nobody attempted draws a dash, never a
       * cross.
       */
      if (method === "GET" && path === "/mav/check") {
        const mavlink = deps.mavlink;
        if (mavlink === undefined) {
          say("GET /mav/check: there is no telemetry layer on this daemon to ask");
          return noTelemetry();
        }
        // The ground stations and `autocast` come from the configuration, not
        // from the measured state: a station that is configured and has never
        // been sampled is a different answer from one that was never
        // configured at all, and `LinkState.groundStations` — which is filled
        // in from the router's own counters — cannot tell those apart for the
        // first couple of seconds of every daemon's life.
        const config = loadConfig(deps.configPath).mavlink;
        return {
          status: 200,
          body: pathCheck({
            state: mavlink.state(),
            telemetryRunning: mavlink.telemetryRunning,
            routerRunning: mavlink.routerRunning,
            endpoints: config.endpoints.map((endpoint) => endpoint.name),
            autocast: config.autocast,
          }),
        };
      }

      /**
       * The one route in this file that takes a working link down.
       *
       * Re-detecting means stopping `mavlink-router` to get the serial port
       * back, so **every ground station receiving now stops receiving until
       * it comes back** (R-MAV-16, and R-NET-12's instinct). The console says
       * so before the operator commits and the renderer logs it at the moment
       * it happens. Nothing else here re-probes: the two read routes above
       * are reads, and a page polling one of them must never be able to seize
       * the port from a router that is working.
       *
       * **409 while a sweep is already running.** Two sweeps at once set the
       * baud rate out from under each other — termios belongs to the tty, not
       * to a descriptor — and can end in `found` at a speed the port is no
       * longer running at. The renderer refuses; this turns the refusal into
       * the status code that says *already happening*, rather than the 500
       * below that would say *broken*.
       */
      if (method === "POST" && path === "/mav/detect") {
        const mavlink = deps.mavlink;
        if (mavlink === undefined) {
          say("POST /mav/detect: there is no telemetry layer on this daemon to ask");
          return noTelemetry();
        }
        const outcome = await mavlink.detectNow();
        // Both halves of the answer moved — what the sweep found, and whether
        // the router came back — so both are returned with it, rather than
        // leaving a page to discover the rest on its next poll.
        return { status: 200, body: { outcome, ...mavlinkState(mavlink) } satisfies MavlinkDetectBody };
      }

      // R-MAV-09, both halves. Each answers with the state its own action
      // produced, so the page's Start/Stop key flips on the reply rather than
      // on the next poll — and `telemetryRunning` is the field that says which
      // it now is, because `phase` reads `linked` either way.
      if (method === "POST" && path === "/mav/start") {
        const mavlink = deps.mavlink;
        if (mavlink === undefined) {
          say("POST /mav/start: there is no telemetry layer on this daemon to ask");
          return noTelemetry();
        }
        await mavlink.startTelemetry();
        return { status: 200, body: mavlinkState(mavlink) };
      }

      if (method === "POST" && path === "/mav/stop") {
        const mavlink = deps.mavlink;
        if (mavlink === undefined) {
          say("POST /mav/stop: there is no telemetry layer on this daemon to ask");
          return noTelemetry();
        }
        await mavlink.stopTelemetry();
        return { status: 200, body: mavlinkState(mavlink) };
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
      // The other half of the same decision (R-UI-15). A console that can only
      // confirm leaves an operator who has already decided the change was
      // wrong watching a timer — and reaching for the power instead, which is
      // the one thing that turns a rollback into a recovery.
      if (method === "POST" && path === "/revert") {
        const id = (body as { id?: string } | undefined)?.id;
        if (typeof id !== "string") return { status: 400, body: { error: "id is required" } };
        await deps.engine.revertNow(id);
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
      // Not a fault either: a sweep is already running on the port the caller
      // asked to sweep. Its message names no path and runs no subprocess, so
      // it can be answered with rather than swallowed — and 409 is what lets
      // a page say "already looking" instead of "the request failed".
      if (e instanceof SweepInProgressError) {
        return { status: 409, body: { error: e.message } };
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
