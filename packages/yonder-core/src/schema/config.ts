// SPDX-License-Identifier: GPL-3.0-or-later
import { z } from "zod";

const cidr = z.string().regex(
  /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/,
  "must be an address in CIDR form, for example 192.168.77.1/24",
);

const ipv4 = z.string().regex(/^(\d{1,3}\.){3}\d{1,3}$/, "must be an IPv4 address");
const port = z.number().int().min(1).max(65535);

/** A reference to a value held in secrets.yaml rather than inline. */
export const SecretRef = z.object({ secret: z.string().min(1) }).strict();
export type SecretRef = z.infer<typeof SecretRef>;

const Interface = z.enum(["ethernet", "modem", "wifi_client", "usb"]);

const ApFallback = z.object({
  enabled: z.boolean().default(true),
  timeout: z.number().int().min(30).max(600).default(90),
}).strict();

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
    password: SecretRef,
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
  ui: { editor: { password: { secret: "editor_password" } } },
});
