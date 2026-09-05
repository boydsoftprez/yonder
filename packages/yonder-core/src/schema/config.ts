// SPDX-License-Identifier: GPL-3.0-or-later
import { z } from "zod";

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
export const ConfigSchema = z.object({
  version: z.literal(1),
  network: Network,
  ui: Ui,
  apply: Apply.default({}),
  system: System.default({}),
  remote: Remote.default({}),
  mavlink: Mavlink.default({}),
}).strict().superRefine((config, ctx) => {
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
});

export type Config = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG: Config = ConfigSchema.parse({
  version: 1,
  network: { ap: { psk: { secret: "ap_psk" } } },
  ui: { editor: {} },
});
