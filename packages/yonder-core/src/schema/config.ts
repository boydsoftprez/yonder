// SPDX-License-Identifier: GPL-3.0-or-later
import { z } from "zod";
import {
  RTSP_PORT, SRT_PORT, WEBRTC_LOCAL_UDP_PORT, WEBRTC_PORT,
} from "../media/ports.js";
import { RESERVED_ENDPOINT_NAMES } from "../mav/router/config.js";

/**
 * A dotted-quad octet, 0–255. Pinned to the range an octet actually has
 * rather than the `\d{1,3}` that would be shorter: that accepts 999.1.1.1,
 * and IPV4_PATTERN is exported for readers outside this file that have to
 * tell a genuine address apart from something that only looks like one.
 */
const OCTET = String.raw`(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)`;
const IPV4 = `${OCTET}(\\.${OCTET}){3}`;

/**
 * An IPv4 address, no prefix — e.g. `192.168.77.1`. Exported so code outside
 * the schema can recognise a real address by the same octet-accurate rule a
 * configured one is held to, instead of a second, looser pattern that could
 * drift from this one. `parseDeviceShow`
 * (packages/yonder-core/src/net/nmcli/parse.ts) is the first such caller: it
 * has to tell a genuine `nmcli` address apart from a placeholder like `--` or
 * `(none)`.
 */
export const IPV4_PATTERN = new RegExp(`^${IPV4}$`);
/** An IPv4 address in CIDR form — e.g. `192.168.77.1/24`. See IPV4_PATTERN. */
export const CIDR_PATTERN = new RegExp(`^${IPV4}/(3[0-2]|[12]?\\d)$`);

const cidr = z.string().regex(
  CIDR_PATTERN,
  "must be an address in CIDR form, for example 192.168.77.1/24",
);

const port = z.number().int().min(1).max(65535);

/** A reference to a value held in secrets.yaml rather than inline. */
export const SecretRef = z.object({ secret: z.string().min(1) }).strict();
export type SecretRef = z.infer<typeof SecretRef>;

const Interface = z.enum(["ethernet", "modem", "wifi_client", "usb"]);

const ApFallback = z.object({
  enabled: z.boolean().default(true),
  timeout: z.number().int().min(30).max(600).default(90),
}).strict();

/**
 * The access point.
 *
 * **There is no DHCP pool here, deliberately.** `ipv4.method shared` makes
 * NetworkManager run its own dnsmasq for this connection, and NetworkManager
 * passes that dnsmasq a range on the command line, derived from the access
 * point's own address:
 *
 *     /usr/sbin/dnsmasq … --dhcp-range=192.168.77.10,192.168.77.254,3600 \
 *                         --conf-dir=/etc/NetworkManager/dnsmasq-shared.d
 *
 * A command-line range wins over a `dhcp-range` in a drop-in, so the pool
 * Yonder used to write into that conf-dir decided nothing: a client on a real
 * board was handed 192.168.77.154, inside NetworkManager's range and outside
 * the configured 192.168.77.2–50. A configuration key that does nothing is
 * worse than an absent one, so it is absent. See K-15 in docs/known-issues.md
 * for what bringing it back would cost, and R-NET-02 for what is actually
 * promised: DHCP inside the access point's subnet, from an address range that
 * is not currently configurable.
 *
 * `address` still matters, and is still the only thing that does: the range
 * NetworkManager chooses is derived from it, so moving the access point to
 * another subnet moves the pool with it. That is what removed the cross-field
 * check this schema used to carry — the pool cannot be left behind in an old
 * subnet if there is no pool to leave behind.
 */
const AccessPoint = z.object({
  enabled: z.boolean().default(true),
  ssid: z.string().min(1).max(32).default("yonder"),
  psk: SecretRef,
  address: cidr.default("192.168.77.1/24"),
  fallback: ApFallback.default({}),
}).strict();

/**
 * The cellular modem.
 *
 * Two kinds of modem, and only one of them can be found automatically.
 *
 * `auto` means the modem ModemManager claims — the kind that exposes
 * registration, operator, radio technology and signal, and which
 * NetworkManager drives as a `gsm` connection. That is the only kind this
 * schema can identify without being told.
 *
 * `appliance` is a modem that holds the SIM, dials by itself and appears to
 * the host as an ordinary network adapter. It is indistinguishable from a
 * USB network adapter without a list of device identifiers written from a
 * vendor's documentation, so the operator names it in `interface` instead
 * (R-CEL-11). Nothing about signal or operator is available for one.
 *
 * `enabled: false` is the default and means no modem is configured — not a
 * modem configured and idle. A board with a stick plugged in and nothing
 * here brings up no cellular connection (R-CFG-08).
 *
 * `dial` exists because R-CEL-02 asks for it and is unused on every modem
 * measured: a QMI or MBIM bearer has no dial step, and `gsm.number` was empty
 * on the link that worked. It applies to a serial connection only.
 */
export const ModemSettings = z.object({
  enabled: z.boolean().default(false),
  mode: z.enum(["auto", "appliance"]).default("auto"),
  interface: z.string().min(1).nullable().default(null),
  apn: z.string().min(1).max(100).nullable().default(null),
  username: z.string().nullable().default(null),
  password: SecretRef.nullable().default(null),
  dial: z.string().nullable().default(null),
}).strict();

/**
 * The one thing about this section that no single field can say.
 *
 * **An appliance is nothing but its name.** `auto` is found by asking
 * ModemManager; an appliance presents as an ordinary network adapter and is
 * indistinguishable from one, so `interface` is the whole of how this device
 * locates it (R-CEL-11). With it null and the modem enabled, `modemDevice`
 * returns null, `desiredProfiles` writes no profile, nothing is ever dialled —
 * and `modemState` still reported the appliance as connected and said it was
 * "using the named adapter", naming nothing. Every field was individually
 * valid and the document as a whole described a modem that cannot exist.
 *
 * Only while it is **enabled**. `enabled: false` is a board with no modem
 * configured whatever else this section says, and refusing that would strand
 * a device whose operator switched an appliance off rather than deleting its
 * settings — and would refuse the shipped default besides.
 *
 * A cross-field rule rather than a discriminated union, because the union
 * would change the shape every reader of `network.modem` sees for a rule that
 * applies to one field in one mode. The cost is that `Modem` is a
 * `ZodEffects` and not an object any more, which is why `ModemSettings` above
 * is exported: `net/modem/configure.ts` derives the shape a form may send from
 * it, and `.partial()` is an object's method.
 */
const Modem = ModemSettings.superRefine((modem, ctx) => {
  if (!modem.enabled || modem.mode !== "appliance") return;
  if (modem.interface !== null && modem.interface !== "") return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ["interface"],
    message:
      "an appliance modem is found by name and nothing else, so name the adapter it "
      + "appears as — for example usb0 (R-CEL-11)",
  });
});

const Network = z.object({
  ap: AccessPoint,
  client: z.object({
    ssid: z.string().max(32).nullable().default(null),
    psk: SecretRef.nullable().default(null),
  }).strict().default({ ssid: null, psk: null }),
  ethernet: z.object({ dhcp: z.boolean().default(true) }).strict().default({}),
  modem: Modem.default({}),
  priority: z.array(Interface).min(1).default(["ethernet", "modem", "wifi_client"]),
}).strict();

/**
 * The palettes, in one place (R-UI-07, ADR-0009).
 *
 * `ui/theme.ts` validates `POST /ui/theme` against this same list rather than
 * restating it. It used to restate it, and the copies drifted the moment a
 * third mode was added: the schema accepted `sunlight`, the route refused it,
 * and the console offered a control that returned an error. One list.
 */
export const THEME_NAMES = ["day", "night"] as const;

const Ui = z.object({
  port: port.default(3000),
  /**
   * Two modes for two conditions (R-UI-07, ADR-0009).
   *
   * `day` is the chart: a light page, because in direct sun a dark screen is a
   * mirror at any brightness. `night` is the glass display in its carbon
   * panel. Different materials, identical layout — nothing moves between them.
   */
  theme: z.enum(THEME_NAMES).default("day"),
  editor: z.object({
    enabled: z.boolean().default(true),
    /**
     * Null until an operator sets an administrator password (R-SEC-09).
     *
     * The shipped default used to name `editor_password`, a secret that by
     * design does not exist on any device: buildRenderers deliberately never
     * seeds it. Nothing resolves this reference today, so it was inert — but
     * the first caller that resolves it eagerly would fail on every fresh
     * device, which is the opposite of what R-CFG-06 asks for. A configuration
     * says what is true: there is no administrator password yet.
     */
    password: SecretRef.nullable().default(null),
    interfaces: z.array(Interface).default(["ethernet", "wifi_client"]),
  }).strict(),
}).strict();

/**
 * The confirmation windows R-CFG-03 is built on.
 *
 * A change is applied, and reverts unless the operator confirms it from the
 * other side. The window is how long they have to get back in and say so, and
 * one number cannot serve both cases:
 *
 *   - An ordinary change — an SSID, a console port — leaves the operator's
 *     connection exactly where it was. They confirm in seconds.
 *   - A change that **moves the Wi-Fi radio between modes** takes the access
 *     point off the air, because one radio cannot be an access point and a
 *     client at once. The operator has to notice, find the device on a
 *     different network, and open it again. That is minutes, not seconds, and
 *     a window budgeted for the first case reverts a perfectly good
 *     configuration out from under them.
 *
 * Both are bounded at both ends, the same 30–600 seconds the access-point
 * fallback is: below 30 s no operator can confirm anything, and above 600 s an
 * unconfirmed change that broke the device sits there for ten minutes.
 */
const Apply = z.object({
  timeout: z.number().int().min(30).max(600).default(120),
  radioTimeout: z.number().int().min(30).max(600).default(300),
}).strict();

const System = z.object({
  hostname: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).default("yonder"),
  timezone: z.string().default("UTC"),
}).strict();

/**
 * What recording may never take from the card (R-STO-06).
 *
 * **Device-wide, and deliberately not per camera, because the medium is not
 * per camera.** Two cameras recording at once share one floor: each one's
 * remaining time is measured against the same free space, and whichever
 * reaches the reserve first ends. A reserve written on a camera would read as
 * a promise this device cannot keep — a second camera would consume the first
 * one's headroom while its own number went on counting down.
 *
 * A gigabyte by default. It is not a guess at what the rest of the system
 * needs: R-STO-02 already bounds what logging may take and R-STO-01 keeps
 * volatile state off the card, so this reserve is headroom for the writes a
 * running board makes that nothing bounds — the journal's own rotation
 * boundary, a support bundle written in the field, and the apply journal that
 * has to be writable for a rollback to happen at all. A card with no space
 * left is a device that cannot roll back, which is rule 6 arriving through
 * the storage layer.
 *
 * Zero is allowed and means *no reserve*: an operator who has told this board
 * to fill the card is entitled to. It is not the default, and the console
 * shows the remaining time against whatever is set.
 */
const Storage = z.object({
  reserve_mb: z.number().int().min(0).max(1024 * 1024).default(1024),
}).strict();

/**
 * Sixteen lowercase hex characters. Uppercase is rejected rather than folded:
 * `zerotier-cli` takes the id verbatim, and a configuration that stores one
 * form while the client reports another is two spellings of the same network.
 */
export const ZEROTIER_NETWORK_ID = /^[0-9a-f]{16}$/;

const ZeroTier = z
  .object({
    enabled: z.boolean().default(false),
    network_id: z.string().regex(ZEROTIER_NETWORK_ID).nullable().default(null),
  })
  .strict();

const Remote = z.object({ zerotier: ZeroTier.default({}) }).strict();

/**
 * A camera's identity, source and settings.
 *
 * **The device is held by port, not by enumeration number** (R-CAM-05).
 * `/dev/video0` is whichever camera the kernel probed first this boot; the
 * `by-path` name — for example
 * `platform-fd500000.pcie-pci-0000:01:00.0-usb-0:1.3:1.0-video-index0` — is
 * the entry under `/dev/v4l/by-path/` for the socket it is plugged into, so
 * the configured camera is the detected one after a reboot and after a
 * plug-order change. `probe/camera.ts` resolves it to a node at run time.
 *
 * **Not the bus id.** `v4l2-ctl --list-devices` prints a bus id in
 * parentheses after the card name — `usb-0000:01:00.0-1.3` on this same
 * socket — and it is tempting to reach for because it is shorter. It will
 * not work: the bus id has no entry under `/dev/v4l/by-path/`, so a
 * configuration holding one resolves to nothing and the operator sees a
 * gstreamer failure with no explanation why.
 *
 * **What is not here.** No capability is stored: R-CAM-14 requires formats,
 * rates and controls to come from what the device answers, and a stored copy
 * is a stale copy the first time a lens or a firmware changes. This section
 * holds what an operator *chose*; `capability.ts` holds what the camera
 * *offers*, and only one of those belongs in a file.
 */
const CameraId = z.string().regex(
  /^[a-z0-9][a-z0-9-]{0,31}$/,
  "must be lower-case letters, digits and hyphens, starting with a letter or digit",
);

/**
 * Where a stream goes.
 *
 * `rtp` is an outbound push to a ground station: no listener, nothing to
 * protect (R-VID-01). `rtsp` and `srt` are listeners on this device, so
 * R-SEC-13 applies — the RTSP stream carries a generated per-device credential
 * held by reference, exactly as the access point's passphrase is.
 *
 * **An RTSP output names no path of its own, and that is a fix rather than an
 * omission.** It used to carry `path`, and three files then held two different
 * answers to *where is this camera's full-rate stream*: `media/config.ts`
 * declared `<id>`, the pipeline published to `<path>`, and the console asked
 * the media server for `<id>` again. They agreed only where somebody had typed
 * the same string twice, and where they did not, mediamtx refused the ANNOUNCE
 * with 400, the whole pipeline exited — **taking the browser preview with it,
 * because both branches are one process** — and nothing anywhere named the
 * path. A camera's stream is at `<id>`, its cheap copy at `<id>-preview`, and
 * there is one place either can come from. `whep.ts`'s `MEDIA_PATH`, sized for
 * an id plus `-preview`, was already written to that model.
 *
 * **`enabled` stops an output without discarding it (R-VID-16).** The default
 * of `true` matters as much as the field: every `config.yaml` already in the
 * field predates it, and a default of `false` would silently stop an
 * aircraft's stream on the next upgrade with nothing in the file changed to
 * explain why. A disabled output keeps its host, its port, its credential —
 * everything an operator typed — because stopping traffic is a different
 * decision from forgetting where it goes. `video/pipeline.ts`'s `compose()`
 * is where a disabled output actually stops: it contributes no branch to the
 * pipeline at all, never a branch that opens a socket and sits muted, which
 * is a different claim to an operator than "stopped". Whether a *listener*
 * output can be reached at all, as distinct from whether it is *enabled*, is
 * a separate question `video/outputs.ts`'s `outputReach` answers (R-UI-24) —
 * the console states one and the other independently, and neither implies
 * the other (R-CMD-04).
 */
const CameraOutput = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("rtp"),
    enabled: z.boolean().default(true),
    host: z.string().regex(IPV4_PATTERN, "must be an IPv4 address, for example 192.168.1.50"),
    port,
  }).strict(),
  z.object({
    kind: z.literal("rtsp"),
    enabled: z.boolean().default(true),
    password: SecretRef,
  }).strict(),
  z.object({ kind: z.literal("srt"), enabled: z.boolean().default(true), port }).strict(),
]);
export type CameraOutput = z.infer<typeof CameraOutput>;

/**
 * The sizes the preview's automatic stepping can hold at, largest first.
 *
 * Exported so `apply/draft.ts` can check a held size against what a specific
 * camera actually offers, rather than restating this list. `"auto"` is not a
 * member: it names the controller's own free-running mode, never a size in
 * its own right, so `preview.size` adds it separately instead of folding it
 * in here.
 */
export const PREVIEW_RUNGS = ["1280x720", "854x480", "640x360"] as const;
export type PreviewRung = (typeof PREVIEW_RUNGS)[number];

/**
 * The cheap copy the interface watches (R-VID-13).
 *
 * **No longer exempt from the confirmation window (R-NET-07, R-CFG-03).**
 * `reachability.ts` used to drop this whole object from the comparison the
 * confirmation window arms on, on the grounds that no setting of it could
 * change what leaves the aircraft on the path the console itself shares —
 * true only while the ceiling stayed at 2000 kb/s. It now reaches 4000,
 * enough on a thin cellular link to take that path with it, so the exemption
 * is withdrawn in the same change that raises the bound: every field below
 * is load-bearing from here on, exactly as `bitrate_kbps` always has been.
 *
 * **`size` replaces `width`/`height`.** A preview is now pinned to one of
 * three offered resolutions, or left at `"auto"` for the rate controller to
 * choose (spec §8.1 — not built by this change). `width`/`height` are still
 * accepted on input, migrated into `size` below rather than reinterpreted:
 * every `config.yaml` in the field carries them, and the migrated pair must
 * name one of the three sizes this schema offers *exactly*, because
 * inventing a fourth rung to hold an arbitrary legacy pixel size is not
 * something this schema can validate against anything a camera actually
 * offers, and silently rounding to the nearest one would be a repair —
 * R-CMD-04's reasoning against that applies here as much as it does in
 * `validateDraft`. Both `width`/`height` and `size` at once is refused
 * rather than resolved by precedence, because a precedence rule would pick
 * one silently and an operator would never learn which.
 *
 * **`ladder_top`/`ladder_bottom`** are the endpoints Auto steps between.
 * Defaulted here to the widest either end of this schema can express, not
 * what any one camera actually offers — the same posture `CameraControls`
 * takes on its own bounds, and for the same reason: a real camera's offered
 * sizes are what `validateDraft`'s `supportedRungs` argument narrows this
 * down to, and this file cannot know them.
 *
 * **`floor_kbps`/`ceiling_kbps`/`bitrate_kbps` share one 100–4000 kb/s
 * range** — the blueprint's 4 Mb/s ceiling, covering every kb/s figure here
 * alike rather than three copies of the same bound that could drift apart.
 */
const PreviewShape = z.object({
  mode: z.enum(["adaptive", "fixed"]).default("adaptive"),
  size: z.enum(["auto", ...PREVIEW_RUNGS]).default("auto"),
  ladder_top: z.enum(PREVIEW_RUNGS).default("1280x720"),
  ladder_bottom: z.enum(PREVIEW_RUNGS).default("640x360"),
  floor_kbps: z.number().int().min(100).max(4000).default(300),
  ceiling_kbps: z.number().int().min(100).max(4000).default(2000),
  bitrate_kbps: z.number().int().min(100).max(4000).default(400),
  framerate: z.number().int().min(1).max(30).default(15),
}).strict();

/**
 * Migrates `width`/`height` into `size` before `PreviewShape` ever sees
 * them.
 *
 * A `.preprocess`, not a `.transform`: the fields this schema no longer has
 * are never declared just to be stripped again, so `PreviewShape.strict()`
 * never has to be told to tolerate a key that is not part of what it means
 * any more. See the type header above for why both sources at once, or a
 * pair naming no offered size, are refused rather than resolved.
 */
const Preview = z.preprocess((input: unknown, ctx: z.RefinementCtx) => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
  const raw = input as Record<string, unknown>;
  const hasWidth = "width" in raw;
  const hasHeight = "height" in raw;
  if (!hasWidth && !hasHeight) return raw;
  if (hasWidth !== hasHeight) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [hasWidth ? "height" : "width"],
      message: "preview needs both width and height together to migrate into a size, or neither",
    });
    return z.NEVER;
  }
  if ("size" in raw) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["size"],
      message:
        "preview carries both width/height and size for the same picture; set only one, so it "
        + "is unambiguous which one was meant",
    });
    return z.NEVER;
  }
  const { width, height, ...rest } = raw;
  if (typeof width !== "number" || typeof height !== "number") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["width"],
      message: "preview width and height must both be numbers",
    });
    return z.NEVER;
  }
  const migrated = `${width}x${height}`;
  if (!(PREVIEW_RUNGS as readonly string[]).includes(migrated)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["width"],
      message: `preview ${migrated} is not one of the sizes this schema offers `
        + `(${PREVIEW_RUNGS.join(", ")}); set preview.size to one of those directly`,
    });
    return z.NEVER;
  }
  return { ...rest, size: migrated };
}, PreviewShape);

/**
 * The bitrate policy for the stream leaving on the console's own path
 * (R-VID-07, R-VID-17).
 *
 * **Seeded from `bitrate_kbps`, one level up.** `floor_kbps`/`ceiling_kbps`
 * are optional here, not at the point anything reads them: `Camera`'s own
 * transform fills whichever is left unset from this camera's `bitrate_kbps`
 * — its existing Fixed target — so a `config.yaml` written before this field
 * existed means exactly what it meant before (Coordinator resolution 6).
 * That happens on `Camera` rather than here because the value being seeded
 * from is a sibling this object cannot see.
 *
 * **Bounded 100–20000, unchanged from `bitrate_kbps`'s own range**: the main
 * stream gains no new ceiling in this task, only a policy that can move it
 * inside that range automatically. Load-bearing in `reachability.ts`, the
 * same as `bitrate_kbps` has always been — an adaptive envelope is still
 * egress on the path the console is standing on.
 */
const Stream = z.object({
  mode: z.enum(["fixed", "adaptive"]).default("fixed"),
  floor_kbps: z.number().int().min(100).max(20000).optional(),
  ceiling_kbps: z.number().int().min(100).max(20000).optional(),
}).strict();

/**
 * Image controls: applied live on the running stream, never a respawn.
 *
 * **`null` means leave the camera alone; it is not zero.** Zero is a legal,
 * meaningful reading for several of these — `brightness: 0` is the bench
 * camera's own shipped default, and `gain: 0` is its floor — so a schema
 * that folded an explicit `0` into the same stored value as an absent field
 * would silently stop sending a control the operator deliberately set to
 * its floor. `config.test.ts` asserts the two stay distinguishable.
 *
 * **Units are device-native, never display units.** `exposureTime: 156` is
 * 156 raw 100-µs units — the same number `exposure_time_absolute` answers on
 * the wire — not 15600 µs. `video/descriptors.ts`'s `DESCRIPTORS` is the one
 * place a raw value is converted to what an operator reads (spec §7); this
 * file must not duplicate that factor, or the two would eventually disagree
 * about what a stored number means.
 *
 * **Every bound below is the widest the V4L2 control can express, not the
 * widest any one camera reports — say so, because the two are easy to
 * confuse.** This schema has to accept every camera Yonder might meet, so a
 * field's bound is the width of the wire value the Linux kernel's uvcvideo
 * driver maps it onto (`uvc_ctrl_mappings` in
 * `drivers/media/usb/uvc/uvc_ctrl.c`): an unsigned or signed 16-bit field for
 * most Processing Unit and Camera Terminal controls, 32-bit for
 * `exposure_time_absolute`, and the fixed four-entry menus V4L2 itself
 * defines for `auto_exposure` (`V4L2_EXPOSURE_AUTO`=0 …
 * `V4L2_EXPOSURE_APERTURE_PRIORITY`=3) and `power_line_frequency`
 * (`V4L2_CID_POWER_LINE_FREQUENCY_DISABLED`=0 … `_AUTO`=3 — docs.kernel.org's
 * V4L2 user-controls reference). **This is not the bench camera's own
 * range** — its measured numbers, recorded in `capability.test.ts`'s
 * fixture, are narrower than every bound below — and the narrow, real clamp
 * against what a given device actually answered is `applyControls`'s job
 * (`video/controls.ts`), which already clamps to `capabilities` and has a
 * test saying so. A future reader who tightens a bound here to this
 * camera's numbers would silently refuse a setting a wider camera's
 * operator is entitled to make.
 *
 * **Menu membership is not this schema's job.** `autoExposure` and
 * `powerLineFrequency` accept any integer in the menu's full defined range,
 * because this file cannot know which entries a given camera actually
 * offers — the bench camera's `auto_exposure` answers a queryable range of
 * 0..3 but lists only ids 1 and 3 as selectable. Refusing an id the device
 * did not list is `applyControls`'s job, checked against
 * `ControlRange.menu` (R-CTL-11 … R-CTL-14).
 */
const ctl = (lo: number, hi: number) =>
  z.number().int().min(lo).max(hi).nullable().default(null);

export const CameraControls = z.object({
  brightness: z.number().int().min(-100).max(100).nullable().default(null),
  contrast: z.number().int().min(-100).max(100).nullable().default(null),
  /** R-CTL-05: by degrees rather than a boolean. */
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).default(0),

  /**
   * Fourteen more, ordered as `probe/camera.ts`'s `CONTROL_MAP` reads them
   * off the device rather than alphabetically, so a diff against a
   * `v4l2-ctl` dump reads by eye (R-CTL-11 … R-CTL-14). Each is named to
   * match the capability key it describes the same control as —
   * `capability.ts`'s `exposure` and `whiteBalance` excepted, stored here as
   * `exposureTime` and `whiteBalanceTemperature`: a config field says what
   * it holds, and a raw exposure count is not "the exposure" any more than a
   * raw kelvin reading is "the white balance".
   */
  zoom: ctl(0, 65535),                     // zoom_absolute — driver-specific units
  focus: ctl(0, 65535),                    // focus_absolute — driver-specific units
  exposureTime: ctl(0, 4_294_967_295),     // exposure_time_absolute — RAW 100 µs units (156 raw is 15600 µs shown)
  whiteBalanceTemperature: ctl(0, 65535),  // white_balance_temperature — kelvin
  gain: ctl(0, 65535),                     // gain — driver-specific units
  backlightCompensation: ctl(0, 65535),    // backlight_compensation — driver-specific units
  gamma: ctl(0, 65535),                    // gamma — driver-specific units
  sharpness: ctl(0, 65535),                // sharpness — driver-specific units
  saturation: ctl(0, 65535),               // saturation — driver-specific units
  hue: ctl(-32768, 32767),                 // hue — driver-specific units, signed
  powerLineFrequency: ctl(0, 3),           // power_line_frequency — menu id: 0 disabled, 1 50 Hz, 2 60 Hz, 3 auto
  autoExposure: ctl(0, 3),                 // auto_exposure — menu id: 0 auto, 1 manual, 2 shutter priority, 3 aperture priority
  autoWhiteBalance: z.boolean().nullable().default(null), // white_balance_automatic
  autoFocus: z.boolean().nullable().default(null),        // focus_automatic_continuous

  /**
   * **A mirror and a flip, each a switch — not more degrees on `rotation`**
   * (R-CTL-05). A flip is not a rotation and cannot be expressed as one:
   * 180° is both flips together, and neither flip alone is any rotation at
   * all. A single degrees field therefore reaches four of the eight
   * orientations an airframe mount can need, and cannot say which of the
   * other four it is looking at — so rotation keeps its degrees and each
   * flip gets its own field.
   *
   * Nullable like the two switches above and unlike `rotation`, because the
   * distinction this file's header draws applies here too: `null` is *leave
   * the camera alone*, and `false` is an operator saying the picture is not
   * mirrored. A camera whose sensor is already flipped in hardware should
   * not have that undone by a default nobody chose.
   */
  horizontalFlip: z.boolean().nullable().default(null),   // horizontal_flip (V4L2_CID_HFLIP)
  verticalFlip: z.boolean().nullable().default(null),     // vertical_flip (V4L2_CID_VFLIP)
}).strict();
export type CameraControls = z.infer<typeof CameraControls>;

/**
 * Every field a camera has, before `stream`'s adaptive envelope is seeded
 * from `bitrate_kbps` below.
 *
 * Exported — as a plain object, not the transformed `Camera` below — so
 * anything that needs the shape itself rather than a parsed instance has the
 * schema to ask: `reachability.ts`'s leaf enumeration is the first such
 * reader, and asking here means it can never hold a hand-typed copy of this
 * field list that quietly drifts from it.
 */
export const CameraShape = z.object({
  id: CameraId,
  name: z.string().min(1).max(48),
  /** M6 adds `csi` and `hdmi`; M5 adds the accessory camera. One today. */
  source: z.enum(["usb"]),
  /** A `by-path` name, without the `/dev/v4l/by-path/` prefix. See above. */
  device: z.string().min(1).max(128),
  enabled: z.boolean().default(true),
  /**
   * Whether the pipeline starts at boot.
   *
   * Off by default and deliberately: R-MAV-08 autocasts telemetry because a
   * quiet aircraft is unflyable, and video has no equivalent claim. The
   * asymmetry is recorded in the spec's §12 as an unmade decision rather than
   * settled here.
   */
  autostart: z.boolean().default(false),
  width: z.number().int().min(160).max(3840).default(1280),
  height: z.number().int().min(90).max(2160).default(720),
  framerate: z.number().int().min(1).max(60).default(30),
  // R-CAM-08. H.265 is refused by `video/pipeline.ts`'s refuse() on a board
  // whose probed encoder has none — a schema cannot know what the board in
  // front of it can encode (R-CAM-13), and a refusal with the encoder named
  // is what R-CAM-10 asks for. The interface's own copy stays H.264 whatever
  // is chosen here (R-VID-20).
  codec: z.enum(["h264", "h265"]).default("h264"),
  bitrate_kbps: z.number().int().min(100).max(20000).default(2000),
  preview: Preview.default({}),
  controls: CameraControls.default({}),
  outputs: z.array(CameraOutput).max(8).default([]),
  stream: Stream.default({}),
}).strict();

/**
 * Seeds `stream`'s adaptive envelope from `bitrate_kbps` (Coordinator
 * resolution 6).
 *
 * A `.transform`, not a `superRefine`: seeding produces a value the parse
 * returns, not an issue about the one it was given. The cost, exactly as it
 * is for `Modem` above, is that `Camera` is a `ZodEffects` and not a plain
 * object any more — which is why `CameraShape` stays exported as the plain
 * version, for a reader that needs `.shape` rather than a parsed instance.
 *
 * **Only fills what is missing.** An operator who has set either bound
 * explicitly keeps it; widening the envelope afterwards is an explicit draft
 * edit (`apply/draft.ts`), never something this transform does again once a
 * value is on record.
 */
export const Camera = CameraShape.transform((camera) => ({
  ...camera,
  stream: {
    ...camera.stream,
    floor_kbps: camera.stream.floor_kbps ?? camera.bitrate_kbps,
    ceiling_kbps: camera.stream.ceiling_kbps ?? camera.bitrate_kbps,
  },
}));
export type Camera = z.infer<typeof Camera>;

/**
 * The rates ArduPilot is actually configured for in the field, slowest first.
 * Slowest first so a slow link is *found* rather than a fast one guessed at —
 * a wrong fast rate produces noise that a slow one would have decoded.
 */
export const MAVLINK_BAUDS = [57600, 115200, 230400, 921600] as const;

const MavlinkSerial = z
  .object({
    device: z.string().min(1).default("auto"),
    baud: z.union([z.literal("auto"), z.union(MAVLINK_BAUDS.map((b) => z.literal(b)) as [z.ZodLiteral<number>, z.ZodLiteral<number>, ...z.ZodLiteral<number>[]])])
      .default("auto"),
  })
  .strict();

/**
 * Three, because R-MAV-03 says three. The limit is in the schema rather than
 * in a renderer so a fourth is refused with the offending path named, at the
 * moment the operator writes it, rather than silently dropped later.
 */
const MavlinkEndpoint = z
  .object({ name: z.string().min(1), host: z.string().min(1), port: z.number().int().min(1).max(65535) })
  .strict();

const Mavlink = z
  .object({
    serial: MavlinkSerial.default({}),
    endpoints: z.array(MavlinkEndpoint).max(3).default([]),
    tcp_server: z.object({ enabled: z.boolean().default(true), port: z.number().int().min(1).max(65535).default(5760) })
      .strict().default({}),
    autocast: z.boolean().default(true),
    // R-MAV-07: an open MAVLink port on a routable address is an
    // unauthenticated command path to the vehicle. Closed unless asked for,
    // and the asking is logged.
    ingest: z.object({ loopback_only: z.boolean().default(true) }).strict().default({}),
  })
  .strict();

/**
 * Strict, deliberately: an unrecognised key is a misspelling, and a
 * misspelling silently ignored is a setting an operator believes is in force
 * and is not.
 *
 * That makes every *removal* from this schema a hazard to devices already in
 * the field, which is why removals are enumerated in `retired.ts`. **Anything
 * validating a document an operator may have written — a file, a request body
 * — must run it through `withoutRetiredKeys` first** (R-CFG-09); a validator
 * added here without that strands every device carrying a key an earlier
 * build wrote. `retired.test.ts` fails when a new call site appears.
 */
/**
 * Ports this device binds itself, and what holds each one.
 *
 * `ui.port` is the console's and is refused below beside these. The other four
 * are the media server's, imported from `media/ports.ts` rather than restated:
 * a number written twice is a number that moves once, and the symptom of the
 * copy left behind is a media server that will not start.
 *
 * **mediamtx does not degrade when two of its servers want one port — it
 * exits**, with the line `media/ports.ts` records verbatim, and every camera on
 * the device goes off the air with it, including the one the browser is
 * watching. `ports.ts`'s own worked example is 8890: it cost Task 9 a rewrite
 * when WebRTC's media port was derived as `WEBRTC_PORT + 1`, and an output
 * carrying the same number arrives at the same collision through a different
 * door.
 */
const BOUND_ON_THIS_DEVICE: ReadonlyMap<number, string> = new Map([
  [RTSP_PORT, "the media server's RTSP port"],
  [WEBRTC_PORT, "the media server's WebRTC port"],
  [WEBRTC_LOCAL_UDP_PORT, "the media server's WebRTC media port"],
  [SRT_PORT, "the media server's SRT port"],
]);

export const ConfigSchema = z.object({
  version: z.literal(1),
  network: Network,
  ui: Ui,
  apply: Apply.default({}),
  system: System.default({}),
  storage: Storage.default({}),
  remote: Remote.default({}),
  cameras: z.array(Camera).max(8).default([]),
  mavlink: Mavlink.default({}),
}).strict().superRefine((config, ctx) => {
  const seen = new Set<string>();
  // Every name this configuration would ask the media server to serve. Two
  // cameras cannot share one: mediamtx takes one publisher per path, so the
  // second pipeline's ANNOUNCE is refused and that camera dies with `400`
  // while the first goes on working, which is the hardest shape of fault to
  // read off a page. Unique ids are not enough on their own — a camera called
  // `nose` and a camera called `nose-preview` both want `nose-preview`.
  const mediaPaths = new Set<string>();
  const claim = (name: string, i: number, what: string): void => {
    if (mediaPaths.has(name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cameras", i, "id"],
        message: `two cameras would publish to the media path "${name}"; ${what}`,
      });
    }
    mediaPaths.add(name);
  };
  for (const [i, cam] of config.cameras.entries()) {
    if (seen.has(cam.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cameras", i, "id"],
        message: `two cameras share the id "${cam.id}"; each camera needs its own`,
      });
    }
    seen.add(cam.id);
    claim(cam.id, i, "a camera's stream is served at its id");
    claim(`${cam.id}-preview`, i, "a camera's preview is served at its id plus -preview");
    for (const [j, out] of cam.outputs.entries()) {
      // The class of fault a confirmation window never catches: an SRT output
      // is UDP against a TCP console, so on the day it is applied nothing
      // collides and the apply confirms. The bind race happens on the next
      // boot, by which time nobody is watching a countdown.
      //
      // **Only the kinds that bind here**, scoped exactly as the paragraph
      // below is and for the same reason. Two kinds carry a port and only
      // `srt` opens a socket on this board — `video/pipeline.ts` would give it
      // `srtsink uri=srt://:<port>`, which binds `0.0.0.0`. An `rtp` output's
      // port is a port on the *ground station*, reached as
      // `udpsink host=… port=…`, and binds nothing on this device, so it
      // cannot collide with the console whatever number it carries; refusing
      // it one was refusing a configuration that works.
      //
      // **Deliberately blind to `enabled`.** A stopped SRT output carrying
      // `ui.port` is refused now, at a keyboard, rather than when somebody
      // switches it on: that may be in flight, and the console it would
      // collide with is the only way left to reach the aircraft. Rule 6.
      if (out.kind === "srt" && out.port === config.ui.port) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cameras", i, "outputs", j, "port"],
          message: `port ${out.port} is ui.port; the console and a stream cannot share one`,
        });
      }
      // **Only the kinds that bind here.** An `rtp` output names a port on the
      // *ground station* — its `udpsink` binds nothing on this device — so
      // refusing it one of these numbers would be refusing a configuration
      // that works. `srt` is the one kind that opens a socket on this board,
      // and it is refused these four because the media server has them.
      //
      // **Deliberately ignores `enabled`.** A disabled SRT output still
      // claims this port the moment it is switched back on, so refusing it
      // now, at configuration time, catches the collision while an operator
      // is at a keyboard rather than when they flip the switch — possibly in
      // flight. Gating this on `enabled` would only delay the same message
      // to a worse moment, not avoid it.
      if (out.kind === "srt") {
        const held = BOUND_ON_THIS_DEVICE.get(out.port);
        if (held !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["cameras", i, "outputs", j, "port"],
            message: `port ${out.port} is ${held}; a stream that binds it takes every camera on this device off the air`,
          });
        }
      }
    }
  }

  // R-MAV-14. The router is started by yonder-core before the console is, so
  // a collision is not a race the console can win. Refused here rather than
  // in a renderer: a renderer runs after the apply has been accepted, and by
  // then the confirmation window is the only thing left to catch it.
  if (config.mavlink.tcp_server.enabled && config.mavlink.tcp_server.port === config.ui.port) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["mavlink", "tcp_server", "port"],
      message: `port ${config.ui.port} is the console's own (ui.port); MAVLink cannot take it`,
    });
  }

  // R-MAV-15. `router/config.ts` keys mavlink-router's own generated sections
  // by name — `autopilot`, `yonder` and `inbound` — and a ground station
  // reusing one of them, or two ground stations sharing a name with each
  // other, produces two identically-headed sections in the generated file.
  // The router keeps one and silently drops the other, with nothing anywhere
  // saying which. Refused here, at write time: a renderer runs only after
  // the apply has already been accepted, by which point the confirmation
  // window is the only thing left to catch it (the same reasoning R-MAV-14
  // above is built on). The console has no field for an endpoint's name
  // today, so this is reached by editing config.yaml directly — a fully
  // supported path, and the one place a typo like this would otherwise be
  // silent.
  const seenAt = new Map<string, number>();
  config.mavlink.endpoints.forEach((endpoint, index) => {
    if ((RESERVED_ENDPOINT_NAMES as readonly string[]).includes(endpoint.name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mavlink", "endpoints", index, "name"],
        message: `"${endpoint.name}" is reserved for mavlink-router's own generated endpoint of that name `
          + `(${RESERVED_ENDPOINT_NAMES.join(", ")} are all taken); choose a different name for this ground station`,
      });
    }
    const firstIndex = seenAt.get(endpoint.name);
    if (firstIndex !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mavlink", "endpoints", index, "name"],
        message: `"${endpoint.name}" is already the name of endpoint ${firstIndex}; `
          + "each ground station needs a name of its own",
      });
    } else {
      seenAt.set(endpoint.name, index);
    }
  });
});

export type Config = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG: Config = ConfigSchema.parse({
  version: 1,
  network: { ap: { psk: { secret: "ap_psk" } } },
  ui: { editor: {} },
});
