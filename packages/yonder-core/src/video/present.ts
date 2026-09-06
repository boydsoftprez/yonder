// SPDX-License-Identifier: GPL-3.0-or-later
import type { Camera } from "../schema/config.js";
import {
  CAPABILITY_KEYS, noCapabilities,
  type CameraCapabilities, type Capability, type ControlRange,
} from "./capability.js";
import { describe, type DescriptorView } from "./descriptors.js";
import { outputReach, type OutputKind, type OutputReach, type ReachPaths } from "./outputs.js";
import type { RunState } from "./supervisor.js";

/**
 * What a camera page *reads*, as strings a widget can bind.
 *
 * It is here, in a package, and not in a `change` node in `flows.json`, for
 * the reason CLAUDE.md rule 2 gives: a JSONata expression composing
 * `1280 × 720` beside a wire coordinate is presentation logic serialised into
 * an artefact nobody can review. `system/format.ts` made the same move for the
 * Status page's numbers and `displayFacts` is the shape this follows.
 *
 * **Nothing here decides anything about a camera.** Every value is a
 * restatement of what the device or the configuration already said; the one
 * arithmetic in the file is the IP overhead below, and it carries its
 * measurement.
 */

/**
 * What the encoder's configured rate costs on an uplink, measured.
 *
 * One 2000 kb/s stream on the board was 2003 kb/s of elementary stream, 2022
 * kb/s once RTP framing was added, and ~2067 kb/s at IP and UDP — over an 8 s
 * steady-state window. Rate control itself is within 0.2%, so the whole 3.35%
 * is framing rather than the encoder missing its target.
 *
 * **The IP figure is the one an uplink actually carries**, so it is the one
 * every number in this file counts, and the label says so. A budget that did
 * not name its layer would invite exactly the wrong conclusion from the 3%
 * an operator can see between the figure they chose and the figure they are
 * billed for.
 */
export const IP_OVERHEAD = 1.0335;

/**
 * What a field cellular uplink is taken to carry, in kb/s.
 *
 * **An assumption, and labelled as one wherever it is drawn.** Nothing in this
 * repository measures a carrier's uplink yet, and 1–5 Mb/s is the range these
 * links are actually seen at; 5000 is the optimistic end, so the budget errs
 * towards *not* crying oversubscription at a configuration that might fit.
 * The moment R-VID-11 has a measurement to use, this constant is what it
 * replaces.
 */
export const ASSUMED_UPLINK_KBPS = 5000;

/** The IP-layer cost of a configured encoder rate, rounded to whole kb/s. */
export function atIp(kbps: number): number {
  return Math.round(kbps * IP_OVERHEAD);
}

/** One output leaving over the path the budget measures (R-VID-11). */
export interface BudgetSegment {
  readonly label: string;
  /** At IP, the layer an uplink actually carries. */
  readonly kbps: number;
}

export interface UplinkBudget {
  readonly capacityKbps: number;
  readonly segments: readonly BudgetSegment[];
}

/**
 * Every stream this configuration puts on the uplink, and what the path
 * carries (R-VID-11).
 *
 * **The total lives on the Cameras page and not on any one camera's**, because
 * it is shared: *starting the second camera would need 2.1 Mb/s more* is a
 * sentence no single camera's page can say.
 *
 * A camera that is not enabled contributes nothing — it has no pipeline — and
 * the browser preview is counted once per camera because that is what watching
 * one costs while it is being watched (R-VID-13). **A disabled output
 * contributes nothing either (R-VID-16)**: it has no branch in `compose()`
 * (`video/pipeline.ts`), so charging its bitrate here would bill an operator
 * for a stream that is not running — the fix mirrors `compose()`'s own
 * filter, one line above the loop it belongs to.
 */
export function uplinkBudget(
  cameras: readonly Camera[],
  capacityKbps: number = ASSUMED_UPLINK_KBPS,
): UplinkBudget {
  const segments: BudgetSegment[] = [];
  for (const camera of cameras) {
    if (!camera.enabled) continue;
    // One segment per consumer, not one per camera: the tee costs almost
    // nothing on the board (68% of a core for one output against 70% for two)
    // and every consumer that leaves over cellular costs its own bitrate. That
    // asymmetry is the whole reason this instrument exists.
    for (const output of camera.outputs.filter((o) => o.enabled)) {
      segments.push({
        label: `${camera.name} · ${output.kind}`,
        kbps: atIp(camera.bitrate_kbps),
      });
    }
    segments.push({
      label: `${camera.name} · preview`,
      kbps: atIp(camera.preview.bitrate_kbps),
    });
  }
  return { capacityKbps, segments };
}

/**
 * One row of the facts row: a capability this camera's page does not offer a
 * control for, and which of the four reasons that is (R-UI-20, R-UI-21).
 *
 *   - `not-offered` — the camera does not have it. Nothing is wrong.
 *   - `advertised` — it lists the capability, accepts the command and does
 *     nothing. Something is misreporting itself.
 *   - `gated` — another control has charge of it right now. Nothing is
 *     wrong, and `reason` names that control the way an operator would,
 *     rather than by its V4L2 identifier.
 *   - `undrawn` — the camera has it and this page does not draw it. Nothing is
 *     wrong with the device; the console has not been built that far.
 */
export interface CapabilityFact {
  readonly label: string;
  readonly state: "not-offered" | "advertised" | "gated" | "undrawn";
  readonly reason?: string;
}

/**
 * The words an operator reads for each capability.
 *
 * Written out rather than derived from the key, because `whiteBalance` is not
 * a label and a page that showed one would be showing its own field names.
 *
 * Exported so a test can ask for `LABELS.exposure` rather than repeating the
 * literal `"Exposure"` — the same reason `CAPABILITY_KEYS` is exported from
 * `capability.ts` rather than re-typed at every call site.
 */
export const LABELS: Record<(typeof CAPABILITY_KEYS)[number], string> = {
  formats: "Capture formats",
  zoom: "Zoom",
  focus: "Focus",
  exposure: "Exposure",
  whiteBalance: "White balance",
  brightness: "Brightness",
  contrast: "Contrast",
  rotation: "Rotation",
  aim: "Aim",
  recording: "Recording",
  stills: "Stills",
  saturation: "Saturation",
  hue: "Hue",
  autoWhiteBalance: "Auto white balance",
  gamma: "Gamma",
  gain: "Gain",
  powerLineFrequency: "Mains frequency",
  sharpness: "Sharpness",
  backlightCompensation: "Backlight compensation",
  autoExposure: "Auto exposure",
  autoFocus: "Auto focus",
};

/**
 * The capabilities a camera's page draws a control for.
 *
 * `brightness` and `contrast` are the two sliders on the Live deck.
 * `formats` is drawn as well, though not as a control: the readout strip
 * states the size and the rate the camera is capturing at, and the Setup deck
 * lets the rate be changed, so an operator is not left wondering what happened
 * to it.
 *
 * **Everything else the camera offers gets a row saying so**, which is the
 * half of R-UI-20 nobody was watching. `flows.test.ts` holds this list against
 * the shipped wiring, so a control added to the page without being named here
 * is drawn *and* reported as missing, and a control taken off the page is
 * reported.
 */
export const DRAWN_CAPABILITIES = ["formats", "brightness", "contrast"] as const;

/**
 * The row for a capability the loop below has already ruled `present` out
 * of — built by a `switch` that **returns** from every case rather than
 * `push`ing and `break`ing, and carries no `default:`.
 *
 * That shape is load-bearing, not a style choice. This project's
 * `strict: true` turns "a path falls off the end of a function whose return
 * type excludes `undefined`" into a real compile error (`strictNullChecks`),
 * and TypeScript's reachability analysis knows exactly which `case` is left
 * uncovered — so a fifth `Capability` state is a compile error here, at the
 * one place a person must decide how it reads, rather than a silent
 * `not-offered` on a page (which is exactly the bug this function was
 * rewritten to fix: it used to be a ternary between `advertised` and
 * everything else, so `gated` fell into "everything else" and told an
 * operator their camera had none of a control it was actively using).
 * A `default:` would take the guarantee back — it is exactly the branch
 * that would swallow a state nobody has decided how to draw yet. A `switch`
 * that only `push`es and `break`s inside the caller's loop does **not** get
 * this guarantee either: nothing downstream would force the compiler to
 * prove it exhaustive, so it would compile cleanly with a case missing and
 * silently drop that capability's row.
 */
function absentFact(
  label: string,
  cap: Exclude<Capability<unknown>, { readonly state: "present" }>,
): CapabilityFact {
  switch (cap.state) {
    case "not-offered":
      return { label, state: "not-offered" };
    case "advertised":
      return { label, state: "advertised", reason: cap.reason };
    case "gated":
      return { label, state: "gated", reason: cap.by.label };
  }
}

/**
 * Everything this camera's page does not give the operator, stated (R-UI-20).
 *
 * **Three states, not two.** A capability that is `present` and has a control
 * is silent — a row as well would be the page saying both. A capability that
 * is `present` and has *no* control on this page was silent too, and that was
 * the requirement failing in the direction nothing was watching: the bench's
 * own camera answers `zoom`, `focus`, `exposure` and `whiteBalance` as
 * present, and the committed page image shows them nowhere at all — no
 * control, and no fact. An operator reads that page and concludes the camera
 * has two adjustable settings when it has six. R-UI-20 is *an operator must be
 * able to tell "this camera cannot" from "this page failed"*, and neither was
 * being said. `rotation` is the same hole: R-CTL-05 is built end to end in
 * `controls.ts` and has no control on any page.
 *
 * The order is `CAPABILITY_KEYS`, so adding a capability puts it in the right
 * place rather than at the end of whichever object literal was edited last.
 *
 * **Never hidden when the whole probe failed.** A camera that answered nothing
 * yields every row, which is the honest reading: an operator has to be able to
 * tell *this camera cannot* from *this page failed*, and an empty facts row on
 * a failed probe says neither.
 */
export function capabilityFacts(
  caps: CameraCapabilities,
  drawn: readonly (typeof CAPABILITY_KEYS)[number][] = [...DRAWN_CAPABILITIES],
): CapabilityFact[] {
  const facts: CapabilityFact[] = [];
  for (const key of CAPABILITY_KEYS) {
    const cap = caps[key] as Capability<unknown>;
    if (cap.state === "present") {
      if (!drawn.includes(key)) facts.push({ label: LABELS[key], state: "undrawn" });
      continue;
    }
    facts.push(absentFact(LABELS[key], cap));
  }
  return facts;
}

/**
 * The readout strip under the picture: what is running, and at what.
 *
 * Flat strings, because a widget binds a key and cannot divide bytes or
 * compose a resolution — see the file's opening note.
 */
export interface CameraStrip {
  /** What the supervisor observed, never what the configuration asked for. */
  readonly state: string;
  readonly picture: string;
  readonly rate: string;
  readonly bitrate: string;
  /** This camera's own share of the uplink, at IP. */
  readonly uplink: string;
  /**
   * Whether Start would be refused, and why (R-CAM-10).
   *
   * Always a sentence, never an empty string. A row labelled "cannot start"
   * with nothing after it reads as *this camera cannot start* — the opposite
   * of what a null refusal means — and a page that says the opposite of the
   * truth when everything is fine is worse than one that says nothing.
   */
  readonly startCheck: string;
  /**
   * What watching this camera in the browser costs, both copies, before it is
   * asked for (R-VID-11).
   *
   * **Computed here, and it has to be.** These two strings were literals in
   * `flows.json` — `preview 0.41 Mb/s · full rate 2.07 Mb/s at IP` — which are
   * this fixture's numbers frozen at deploy time. Raise `bitrate_kbps` to 8000
   * and the page said 2.07 while the readout strip beside it, which *is*
   * computed, said 8.27: the figure an operator uses to decide whether to
   * spend a field uplink, wrong by four times, sitting next to the right one.
   * R-VID-11 is about stating the cost *before* it is asked, so a stale cost
   * is the requirement failing rather than a cosmetic slip.
   */
  readonly pictureCost: string;
  /** What holding the full-rate key costs, or why there is nothing to hold. */
  readonly holdCost: string;
  /**
   * Whether a full-rate stream exists on this device at all.
   *
   * The full-rate path is published only where an RTSP output is configured
   * (`media/config.ts`, `pipeline.ts`), so on a camera with only an `rtp`
   * output — or none — holding FULL RATE asks for a path that does not exist
   * and gets a 404 the picture reports as "this camera is not streaming".
   * R-UI-20's own exception clause is that the soft-key rail carries only what
   * can be done.
   */
  readonly fullRate: boolean;
  /** The `/dev` node the configured by-path name resolves to right now. */
  readonly device: string;
  /** Whether that identity survives a reboot (R-CAM-05), in words. */
  readonly identity: string;
  readonly encoder: string;
}

/** What `state()` reports, and the reason where the supervisor has one. */
function runWords(state: string, reason: string | undefined): string {
  return reason === undefined || reason === "" ? state : `${state} — ${reason}`;
}

/**
 * `byPathStable` in words, which is the only form of it an operator can act
 * on (R-CAM-05, R-UI-20).
 *
 * Nothing rendered this until the Cameras page did, and until something does
 * the stable-identity work stops at the type: a `false` here means the
 * configured camera is held by an enumeration number that the next boot may
 * hand to a different device, and the operator is the only one who can move
 * the plug or fix the configuration.
 */
export function identityWords(byPath: string | null, stable: boolean): string {
  if (byPath === null) return "not resolved — this camera did not answer";
  return stable
    ? `${byPath} — survives a reboot`
    : `${byPath} — an enumeration number; it may mean a different camera after a reboot`;
}

export function cameraStrip(view: {
  camera: Camera;
  run: { state: string; reason?: string };
  device: string | null;
  byPathStable: boolean;
  encoder: { element: string; hardware: boolean };
  refusal?: string | null;
}): CameraStrip {
  const { camera } = view;
  const outputs = camera.outputs.length;
  const own = atIp(camera.bitrate_kbps) * outputs + atIp(camera.preview.bitrate_kbps);
  const mbps = (kbps: number): string => (atIp(kbps) / 1000).toFixed(2);
  // The browser's full rate comes off the same path a ground station's RTSP
  // does, so it exists exactly where that output does.
  const fullRate = camera.outputs.some((o) => o.kind === "rtsp");
  return {
    state: runWords(view.run.state, view.run.reason),
    picture: `${camera.width} × ${camera.height}`,
    // Units keep their case, always: `FPS` says nothing and `KB/S` says
    // kilobytes.
    rate: `${camera.framerate} fps`,
    bitrate: `${camera.bitrate_kbps} kb/s`,
    uplink: `${(own / 1000).toFixed(2)} Mb/s at IP`,
    pictureCost: fullRate
      ? `preview ${mbps(camera.preview.bitrate_kbps)} Mb/s · full rate ${mbps(camera.bitrate_kbps)} Mb/s at IP`
      : `preview ${mbps(camera.preview.bitrate_kbps)} Mb/s at IP`,
    holdCost: fullRate
      ? `${mbps(camera.bitrate_kbps)} Mb/s while held`
      : "no full-rate stream on this camera; add an RTSP output",
    fullRate,
    startCheck: view.refusal ?? "nothing is stopping it",
    device: view.device ?? "not resolved",
    identity: identityWords(view.device === null ? null : camera.device, view.byPathStable),
    encoder: `${view.encoder.element} · ${view.encoder.hardware ? "hardware" : "software"}`,
  };
}

/* ------------------------------------------------------------------------ *
 * The three payloads the instrument library reads (R-UI-08, R-CAM-12).
 *
 * `ui-yonder-deck`, `ui-yonder-aim` and `ui-yonder-index` were each built
 * against a payload shape and none of them was ever wired: `Detection` and
 * `Rejection` carry `{ device, card, byPath, capabilities }` and
 * `{ device, card, reason }`, with no `id`, `name`, `bus`, `state`, `tone` or
 * `rate` anywhere between them. This is the seam, and it is here rather than
 * in `daemon/routes.ts` or in a `change` node for the reason the rest of this
 * file gives: composing a page's values is presentation, it belongs in a
 * package with tests, and a JSONata expression beside a wire coordinate is
 * CLAUDE.md rule 2 wearing a different hat.
 * ------------------------------------------------------------------------ */

/**
 * The four tones every state-bearing part of this console draws from
 * (`console/command.ts`'s own register, R-UI-11). Restated as a type here
 * rather than imported, because a camera's *run* state is not a
 * `CommandStatus` and must not be routed through `presentation()` — the
 * apply/confirm vocabulary (idle · pending · confirmed · rejected) means
 * something else entirely, and a run state passed through it would draw the
 * wrong words in the wrong colour. `YonderIndex.vue`'s own doc comment
 * states the same conclusion from the component's side.
 */
export type RunTone = "good" | "waiting" | "bad" | "neutral";

/** One camera as the Cameras index draws it. */
export interface CameraRow {
  /**
   * The configured id, or `null` where a camera was detected on a socket
   * nothing is configured for.
   *
   * **Not the enumeration number, and not the card name** (R-CAM-05). A
   * configuration stores the *socket* — the `/dev/v4l/by-path/` name — and
   * this id is the one whose `device` matches the socket this camera was
   * found on. That is the whole of how an id survives a replug: unplug the
   * camera and plug it back into the same socket and `byPath` is the same
   * string, so the same configured camera is matched, whatever `/dev/videoN`
   * the kernel hands it this time. Move it to a different socket and it is a
   * different camera as far as the configuration is concerned, which is the
   * honest answer — nothing here can tell one identical UVC camera from
   * another. `identity` below carries the case the kernel publishes no
   * by-path name at all, where the match is by enumeration number and will
   * mean a different camera after a reboot.
   */
  readonly id: string | null;
  readonly name: string;
  /** Where it is attached: the source and the node the socket resolves to now. */
  readonly bus: string;
  /** What it is configured to send, or why there is nothing to say. */
  readonly spec: string;
  /** R-CAM-05 in words, from `identityWords()` — the same sentence the page uses. */
  readonly identity: string;
  /** One word for the supervisor's observed run state. Never the configuration's. */
  readonly state: string;
  readonly tone: RunTone;
  /**
   * Measured egress, in Mb/s at IP — **never the configured target**.
   *
   * `null` until something measures it, which nothing in this repository does
   * yet (see `ASSUMED_UPLINK_KBPS` above, and spec §8.1's rate controller).
   * A configured `bitrate_kbps` is what an operator asked for; printing it
   * here would put a number on the page that nobody measured, in the column
   * an operator reads to find out what is actually going out. `YonderIndex`
   * draws `null` as "none" rather than as a gap, so absence is stated.
   */
  readonly rate: number | null;
  readonly capabilities: CameraCapabilities;
}

/** One device the probe refused, and why (R-CAM-12). */
export interface RejectionRow {
  readonly device: string;
  readonly reason: string;
}

export interface CameraIndex {
  readonly cameras: readonly CameraRow[];
  readonly rejected: readonly RejectionRow[];
}

/**
 * The supervisor's run state, in the operator's words and a tone.
 *
 * Exhaustive by construction: every case returns, there is no `default:`, and
 * the return type is written out — all three, because an inferred return type
 * widens to `string | undefined` and lets a missing case through (the same
 * shape, and the same reasoning, as `absentFact` above).
 *
 * **One word, never the reason.** `runWords()` appends the supervisor's
 * failure reason for the readout strip, which has room for a sentence; an
 * index row draws this inside a lamp-and-caption pill, and a 104-character
 * GStreamer failure in it is a row that cannot be laid out at any width. The
 * reason is on that camera's own page, one press away, where the operator
 * goes to act on it.
 */
function runState(state: RunState): { state: string; tone: RunTone } {
  switch (state) {
    case "running":
      return { state: "Streaming", tone: "good" };
    case "starting":
      return { state: "Starting", tone: "waiting" };
    case "failed":
      return { state: "Failed", tone: "bad" };
    case "stopped":
      return { state: "Idle", tone: "neutral" };
  }
}

/**
 * What the Cameras page draws (R-CAM-12, R-UI-03, R-CAM-05).
 *
 * A row per *detection*, not per configured camera: the page's subject is
 * what is attached to this board right now, and a configured camera that is
 * not plugged in has no row here — its absence is the fact, and the
 * rejection list beside it is where a device that is present and unusable
 * appears. A detection on a socket nothing is configured for is still a row,
 * with `id: null`, because "there is a camera here and Yonder is not set up
 * for it" is exactly the thing an operator has to be told; `YonderIndex`
 * draws such a row inert, because there is no page to open for it (R-UI-03).
 */
export function cameraIndex(input: {
  readonly found: readonly {
    readonly device: string;
    readonly card: string;
    readonly byPath: string;
    readonly byPathStable: boolean;
    readonly capabilities: CameraCapabilities;
  }[];
  readonly rejected: readonly RejectionRow[];
  readonly cameras: readonly Camera[];
  /** The supervisor's own observation for a configured id (R-CTL-10). */
  readonly run: (id: string) => RunState;
  /**
   * Measured egress for a configured id, in kb/s at IP, or `null`.
   *
   * A seam and not a default: the daemon has nothing to put here today and
   * passes nothing, so every row reads `rate: null`. It exists so that the
   * day something measures egress there is one place to connect it, and so
   * that no caller can reach for `bitrate_kbps` instead without editing this
   * signature.
   */
  readonly egressKbps?: (id: string) => number | null;
}): CameraIndex {
  const cameras = input.found.map((detected): CameraRow => {
    const configured = input.cameras.find((c) => c.device === detected.byPath);
    const identity = identityWords(detected.byPath, detected.byPathStable);
    const bus = `${configured?.source ?? "usb"} · ${detected.device}`;
    if (configured === undefined) {
      return {
        id: null,
        name: detected.card,
        bus,
        spec: "not configured",
        identity,
        state: "Not configured",
        tone: "neutral",
        rate: null,
        capabilities: detected.capabilities,
      };
    }
    const measured = input.egressKbps?.(configured.id) ?? null;
    return {
      id: configured.id,
      name: configured.name,
      bus,
      spec: `${configured.codec.toUpperCase()} · ${configured.width}×${configured.height}p${configured.framerate}`,
      identity,
      ...runState(input.run(configured.id)),
      // Mb/s at IP, the layer an uplink actually carries — the same layer
      // every other rate on this console is stated at (`IP_OVERHEAD` above).
      rate: measured === null ? null : Number((atIp(measured) / 1000).toFixed(2)),
      capabilities: detected.capabilities,
    };
  });
  return { cameras, rejected: input.rejected };
}

/** One output as the deck draws it. */
export interface DeckOutput {
  readonly kind: OutputKind;
  readonly label: string;
  readonly enabled: boolean;
  /** At IP, like every other rate here. */
  readonly costKbps: number;
  readonly reach: OutputReach;
}

/** `ui-yonder-deck`'s whole payload — `YonderDeck.vue`'s own documented shape. */
export interface CameraDeck {
  readonly camera: { readonly id: string; readonly name: string; readonly spec: string };
  readonly capabilities: CameraCapabilities;
  readonly descriptors: Record<string, DescriptorView>;
  readonly values: Record<string, number | null>;
  readonly commanded: Record<string, number | null>;
  readonly policy: { readonly stream: Camera["stream"] & { bitrate_kbps: number }; readonly preview: Camera["preview"] };
  readonly applied: { readonly stream: Camera["stream"] & { bitrate_kbps: number }; readonly preview: Camera["preview"] };
  readonly outputs: readonly DeckOutput[];
  readonly captures: { readonly count: number };
}

/** The words for an output kind, once, so two pages cannot disagree. */
const OUTPUT_LABEL: Record<OutputKind, string> = {
  rtp: "RTP · to the ground station",
  rtsp: "RTSP · a player connects",
  srt: "SRT · a player connects",
};

/**
 * Everything `ui-yonder-deck` draws, composed from what the device answered
 * and what the configuration holds (R-UI-08, R-CTL-10).
 *
 * **`descriptors` and `values` are the device's, `policy` is the
 * configuration's**, and the two are never mixed: an image control's current
 * reading comes from the probe (`ControlRange.current`, "what the device says
 * it is *now* — never what was last sent"), while a stream or preview policy
 * is what `config.yaml` holds, because that is the thing Apply changes.
 * `commanded` is the third and separate fact — the value `config.yaml` last
 * asked the device for — so a control whose reading disagrees with what was
 * commanded can draw both rather than silently showing one.
 *
 * **`applied` is `policy` today, and is still a second field.** Nothing on
 * this branch tracks a running pipeline's own settings apart from the
 * document it was started from, so the two are equal on every read. They stay
 * two names because a respawn in flight is exactly the moment they can
 * disagree, and the deck compares its draft against `applied` — pointing that
 * comparison at `policy` would be right by coincidence and wrong the day a
 * runtime tracker exists.
 *
 * **`captures.count` is 0 by construction**: board recording (§8.3) is
 * unbuilt, so there is nothing to count.
 *
 * **There is no `interruption` here, and there was never a value this
 * function could put in it.** What a draft would interrupt is a fact about a
 * draft that has not been sent, and this daemon has never seen one: the field
 * was `[]` on every read, `YonderDeck` drew it, and the warning spec §8.1
 * asks for *before* Apply is pressed could not appear while two doc comments
 * said it did. The deck calls `interruption()` itself now, over its own
 * staged draft, and the apply route calls the same function over the draft it
 * was actually sent — one calculation, two callers, neither of them this one.
 */
export function cameraDeck(view: {
  readonly camera: Camera;
  readonly capabilities: CameraCapabilities | null;
  readonly encoder: { readonly element: string; readonly hardware: boolean };
  readonly paths: ReachPaths;
}): CameraDeck {
  const { camera } = view;
  const caps = view.capabilities ?? noCapabilities();
  const descriptors: Record<string, DescriptorView> = {};
  const values: Record<string, number | null> = {};
  for (const key of CAPABILITY_KEYS) {
    const cap = caps[key] as Capability<unknown>;
    // A range is what `describe()` converts, and only these keys carry one:
    // `formats` is a list, `aim` a pair of ranges, `recording` and `stills`
    // are facts about where a capture goes. Each of those is drawn by its own
    // branch in `YonderDeck`, from `capabilities` directly.
    const value = cap.state === "not-offered" ? undefined : (cap as { value?: unknown }).value;
    if (value === undefined || typeof value !== "object" || !("current" in (value as object))) continue;
    const range = value as ControlRange;
    descriptors[key] = describe(key, range);
    values[key] = descriptors[key].current;
  }
  const commanded: Record<string, number | null> = {};
  for (const [key, raw] of Object.entries(camera.controls)) {
    commanded[key] = typeof raw === "number" ? raw : raw === null ? null : raw ? 1 : 0;
  }
  const policy = {
    stream: { ...camera.stream, bitrate_kbps: camera.bitrate_kbps },
    preview: camera.preview,
  };
  return {
    camera: {
      id: camera.id,
      name: camera.name,
      spec: `${camera.source.toUpperCase()} · ${camera.codec.toUpperCase()} · `
        + `${camera.width}×${camera.height}p${camera.framerate} · ${view.encoder.element}`,
    },
    capabilities: caps,
    descriptors,
    values,
    commanded,
    policy,
    applied: policy,
    outputs: camera.outputs.map((output) => ({
      kind: output.kind,
      label: OUTPUT_LABEL[output.kind],
      enabled: output.enabled,
      costKbps: atIp(camera.bitrate_kbps),
      reach: outputReach(output.kind, view.paths),
    })),
    captures: { count: 0 },
  };
}

/** `ui-yonder-aim`'s whole payload — `YonderAim.vue`'s own documented shape. */
export interface AimPanel {
  readonly state: Capability<unknown>["state"];
  readonly reason: string | null;
  readonly pan: number | null;
  readonly tilt: number | null;
  readonly bounds: { readonly pan: readonly [number, number]; readonly tilt: readonly [number, number] } | null;
  readonly atLimit: { readonly pitch: boolean; readonly yaw: boolean };
  readonly mode: string | null;
  readonly modes: readonly string[];
  readonly inhibited: string | null;
}

/**
 * The Aim panel, from the one capability that answers for it (R-CAM-11,
 * R-UI-28).
 *
 * Its own payload rather than a slice of the deck's, exactly as
 * `YonderAim.vue` states: the Cockpit (M5) carries this panel and the picture
 * with no deck beside them, so the panel's payload must not be a projection
 * of a shape the deck owns.
 *
 * **`mode`, `modes` and `atLimit` are what no camera on this branch answers.**
 * The gimbal mode byte (`0x4C`) and the limit flags (byte 10 of the `0x05`
 * push) are spec §8.7's, unbuilt — so the mode is `null`, the list is empty
 * and neither limit is set. Reporting a *guessed* mode would be the panel
 * claiming a fact about the gimbal that nothing read, which is the same
 * defect as an unmeasured rate one field over.
 */
export function aimPanel(caps: CameraCapabilities | null): AimPanel {
  const aim = (caps ?? noCapabilities()).aim;
  const empty = {
    pan: null, tilt: null, bounds: null,
    atLimit: { pitch: false, yaw: false },
    mode: null, modes: [] as string[],
  };
  if (aim.state === "not-offered") {
    return { state: "not-offered", reason: null, inhibited: null, ...empty };
  }
  if (aim.state === "advertised") {
    return { state: "advertised", reason: aim.reason, inhibited: null, ...empty };
  }
  if (aim.state === "gated") {
    return { state: "gated", reason: `${aim.by.label} has it`, inhibited: null, ...empty };
  }
  // The envelope, only where the device answered both ends of both axes.
  // A half-known envelope is not an envelope: drawing a gauge against a
  // bound nothing reported would put a scale on the page that no device
  // agreed to, and `YonderPositionGauge`'s own `dead` state exists for
  // exactly this case. `yaw` is pan and `pitch` is tilt — the gimbal's own
  // axis names on one side of this seam, the operator's on the other.
  const { yaw, pitch } = aim.value;
  const known = yaw.min !== null && yaw.max !== null && pitch.min !== null && pitch.max !== null;
  return {
    state: "present",
    reason: null,
    // §8.7's 20 Hz attitude push is unbuilt, so nothing has reported where
    // this gimbal is pointing. `null` is that fact; a zero would be a claim.
    pan: null,
    tilt: null,
    bounds: known
      ? { pan: [yaw.min as number, yaw.max as number], tilt: [pitch.min as number, pitch.max as number] }
      : null,
    atLimit: { pitch: false, yaw: false },
    // The one mode the probe does answer: the work mode the envelope above
    // was learned in. There is no list to choose from until `0x44` is built,
    // so the mode is drawn and cannot be changed.
    mode: aim.value.mode,
    modes: [],
    // §8.7's guard is unbuilt, and the honest report of an unbuilt guard is
    // that the panel is inhibited until one exists — not that it is live.
    // R-CMD-04: nothing here originates a motion command, and a pad that
    // could send one with no bounds check behind it would be the console
    // deciding what is safe.
    inhibited: "the motion guard is not built yet, so nothing is sent",
  };
}
