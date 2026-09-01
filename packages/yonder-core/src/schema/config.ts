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
 * worse than an absent one, so it is absent. See K-14 in docs/known-issues.md
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

const Network = z.object({
  ap: AccessPoint,
  client: z.object({
    ssid: z.string().max(32).nullable().default(null),
    psk: SecretRef.nullable().default(null),
  }).strict().default({ ssid: null, psk: null }),
  ethernet: z.object({ dhcp: z.boolean().default(true) }).strict().default({}),
  priority: z.array(Interface).min(1).default(["ethernet", "modem", "wifi_client"]),
}).strict();

const Ui = z.object({
  port: port.default(3000),
  theme: z.enum(["day", "night"]).default("day"),
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

const System = z.object({
  hostname: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).default("yonder"),
  timezone: z.string().default("UTC"),
}).strict();

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
  system: System.default({}),
}).strict();

export type Config = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG: Config = ConfigSchema.parse({
  version: 1,
  network: { ap: { psk: { secret: "ap_psk" } } },
  ui: { editor: {} },
});
