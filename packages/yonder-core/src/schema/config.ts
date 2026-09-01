// SPDX-License-Identifier: GPL-3.0-or-later
import { z } from "zod";

/**
 * A dotted-quad octet, 0–255. Pinned this tightly because the cross-field
 * check below does arithmetic on these values: `\d{1,3}` accepts 999.1.1.1,
 * and a subnet calculation over that answers a question nobody asked.
 */
const OCTET = String.raw`(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)`;
const IPV4 = `${OCTET}(\\.${OCTET}){3}`;

const cidr = z.string().regex(
  new RegExp(`^${IPV4}/(3[0-2]|[12]?\\d)$`),
  "must be an address in CIDR form, for example 192.168.77.1/24",
);

const ipv4 = z.string().regex(new RegExp(`^${IPV4}$`), "must be an IPv4 address");
const port = z.number().int().min(1).max(65535);

/** Dotted quad to a 32-bit number. Only ever called on a value `ipv4` accepted. */
function toInt(address: string): number {
  return address.split(".").reduce((acc, octet) => acc * 256 + Number(octet), 0);
}

/** A reference to a value held in secrets.yaml rather than inline. */
export const SecretRef = z.object({ secret: z.string().min(1) }).strict();
export type SecretRef = z.infer<typeof SecretRef>;

const Interface = z.enum(["ethernet", "modem", "wifi_client", "usb"]);

const ApFallback = z.object({
  enabled: z.boolean().default(true),
  timeout: z.number().int().min(30).max(600).default(90),
}).strict();

/**
 * The access point, with the one cross-field rule the fields cannot express
 * on their own: **the DHCP pool has to be inside the access point's subnet.**
 *
 * Nothing downstream catches this. Changing `address` to 10.0.0.1/24 while
 * the pool still reads 192.168.77.2–50 renders successfully — a `nmcli
 * connection modify` and a file write, both of which report success — so
 * there is nothing for the apply engine to roll back. The operator's existing
 * DHCP lease keeps them connected long enough to confirm the change. On the
 * next boot no client can get an address, and the fallback watchdog's only
 * action is to raise that same unusable access point.
 *
 * The pool is checked strictly inside the subnet, not merely within it: the
 * network and broadcast addresses are not host addresses, and the access
 * point's own address must not be in a pool it hands out.
 */
const AccessPoint = z.object({
  enabled: z.boolean().default(true),
  ssid: z.string().min(1).max(32).default("yonder"),
  psk: SecretRef,
  address: cidr.default("192.168.77.1/24"),
  dhcp: z.object({
    start: ipv4.default("192.168.77.2"),
    end: ipv4.default("192.168.77.50"),
    lease: z.string().regex(/^\d+[mhd]$/).default("12h"),
  }).strict().default({}),
  fallback: ApFallback.default({}),
}).strict().superRefine((ap, ctx) => {
  const [host, length] = ap.address.split("/");
  const prefix = Number(length);
  // Every intermediate is forced back to unsigned: JavaScript's bitwise
  // operators work on *signed* 32-bit integers, so 192.168.77.0 & /24 comes
  // out negative and compares below every address in its own subnet.
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (toInt(host) & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  const self = toInt(host);
  const start = toInt(ap.dhcp.start);
  const end = toInt(ap.dhcp.end);

  const say = (path: string[], message: string) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });

  // Strictly inside: the network and broadcast addresses are not host
  // addresses and a client handed either of them has no usable link.
  for (const [field, value] of [["start", start], ["end", end]] as const) {
    if (value <= network || value >= broadcast) {
      say(
        ["dhcp", field],
        `${ap.dhcp[field]} is not a host address inside the access point's subnet ${ap.address}; `
        + "a client given an address outside it cannot reach the device",
      );
    }
  }

  if (start > end) {
    say(["dhcp", "end"], `the DHCP pool ends (${ap.dhcp.end}) before it starts (${ap.dhcp.start})`);
  } else if (self >= start && self <= end) {
    say(
      ["dhcp", "start"],
      `the pool ${ap.dhcp.start}–${ap.dhcp.end} contains the access point's own address `
      + `${host}, which cannot be handed out to a client`,
    );
  }
});

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
