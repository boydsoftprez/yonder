// SPDX-License-Identifier: GPL-3.0-or-later
import { IPV4_PATTERN, CIDR_PATTERN } from "../../schema/config.js";

/**
 * Split one `nmcli -t` line into its fields.
 *
 * Terse mode is a machine interface: fields separated by a colon, and any
 * colon or backslash inside a value escaped with a backslash. Splitting
 * naively on ":" corrupts SSIDs and MAC addresses, so this walks the string
 * one character at a time and returns the fields already unescaped.
 */
function splitTerseLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let escaped = false;

  for (const ch of line) {
    if (escaped) {
      current += ch;
      escaped = false;
    } else if (ch === "\\") {
      escaped = true;
    } else if (ch === ":") {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

/**
 * Parse record-shaped `nmcli -t` output: one record per line, a fixed number
 * of fields per record, in the order given to `-f`.
 *
 * This is the shape of `device status`, `connection show` and `device wifi
 * list`. It is **not** the shape of `device show` — see parseDeviceShow.
 */
export function parseTerse(stdout: string, fieldCount: number): string[][] {
  const records: string[][] = [];

  for (const line of stdout.split("\n")) {
    if (line === "") continue;

    const fields = splitTerseLine(line);
    if (fields.length !== fieldCount) {
      throw new Error(
        `nmcli output: expected ${fieldCount} fields, got ${fields.length} in ${JSON.stringify(line)}`,
      );
    }
    records.push(fields);
  }

  return records;
}

export interface DeviceAddresses {
  device: string;
  /** Every IPv4 address the device holds, in CIDR form. Often empty. */
  addresses: string[];
}

const DEVICE_FIELD = "GENERAL.DEVICE";
/** `IP4.ADDRESS`, or the indexed form `IP4.ADDRESS[1]` when there are several. */
const ADDRESS_FIELD = /^IP4\.ADDRESS(\[\d+\])?$/;

/**
 * True for a value that actually looks like an IPv4 address, with or without
 * a `/prefix` — the same octet-accurate patterns the schema holds a
 * configured address to (packages/yonder-core/src/schema/config.ts), reused
 * rather than a third regex that could disagree with either.
 */
function looksLikeAnAddress(value: string): boolean {
  return IPV4_PATTERN.test(value) || CIDR_PATTERN.test(value);
}

/**
 * Parse `nmcli -t -f GENERAL.DEVICE,IP4.ADDRESS device show`.
 *
 * `device show` does not emit records. It emits a **stream** of `FIELD:value`
 * lines — one line per property, per device — so a device with two addresses
 * occupies three lines and a device with none occupies one:
 *
 *     GENERAL.DEVICE:eth0
 *     IP4.ADDRESS[1]:192.168.1.50/24
 *     GENERAL.DEVICE:wlan0
 *
 * Forcing that through parseTerse is how this probe was broken: with a field
 * count of 2, `GENERAL.DEVICE:eth0` parses cleanly into the record
 * `{ device: "GENERAL.DEVICE", address: "eth0" }` — an address that does not
 * exist, on an interface that does not exist, which the fallback watchdog
 * would read as "this device is reachable" and stand down.
 *
 * So this parser can only ever *lose* an address, never invent one. A
 * `GENERAL.DEVICE` line starts a device; a value under a recognised
 * IP4.ADDRESS field becomes an address only when it also looks like one.
 * Recognising the field name is not enough by itself: a NetworkManager build
 * that prints a recognised field with a placeholder for "nothing here" —
 * `--` and `(none)` both appear across real versions — is otherwise exactly
 * the "GENERAL.DEVICE read as an address" bug this parser exists to prevent,
 * just moved from the field name to the value. Every line that fails either
 * test is ignored. If a NetworkManager version emits a shape or a value this
 * does not recognise, the result is an empty list, the watchdog decides
 * nothing is reachable, and the access point comes up — the harmless
 * direction.
 *
 * OBSERVED. A Raspberry Pi 4 on Debian 13 (NetworkManager 1.52) printed
 * exactly this shape, and `fixtures/device-show-ip4.txt` is that capture
 * rather than a hand-written guess. It settled the one question this parser
 * was written blind against: **an address-less device emits no `IP4.ADDRESS`
 * line at all** — not `--`, not `(none)`, not an empty value. It occupies a
 * single `GENERAL.DEVICE` line, and a blank line separates each device's
 * block.
 *
 * The placeholder handling stays anyway. One board on one NetworkManager
 * version does not speak for the versions this has still never run against,
 * and the cost of keeping it is a comparison; the cost of being wrong is a
 * device that decides it is reachable when it is not. See
 * docs/hardware/verifying-m1a.md for what else that boot recorded.
 */
export function parseDeviceShow(stdout: string): DeviceAddresses[] {
  const devices: DeviceAddresses[] = [];

  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;

    const fields = splitTerseLine(line);
    // No colon at all: not a FIELD:value line. Nothing to learn from it.
    if (fields.length < 2) continue;
    const name = fields[0];
    // Rejoin on the unescaped colons the walker split at, so a value that
    // legitimately contains one survives whether or not nmcli escaped it.
    const value = fields.slice(1).join(":");

    if (name === DEVICE_FIELD) {
      devices.push({ device: value, addresses: [] });
      continue;
    }
    if (!ADDRESS_FIELD.test(name) || !looksLikeAnAddress(value)) continue;
    // An address before any device line cannot be attributed to an interface,
    // and an address we cannot attribute is not evidence of reachability.
    const current = devices[devices.length - 1];
    if (current !== undefined) current.addresses.push(value);
  }

  return devices;
}
