// SPDX-License-Identifier: GPL-3.0-or-later

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
 * `GENERAL.DEVICE` line starts a device; only a value under a recognised
 * IP4.ADDRESS field becomes an address; every other line is ignored. If a
 * NetworkManager version emits a shape this does not recognise, the result is
 * an empty list, the watchdog decides nothing is reachable, and the access
 * point comes up — the harmless direction.
 *
 * ASSUMED, NOT OBSERVED: there was no nmcli on the machine where this was
 * written. The shape above comes from the documented grammar of `-t` output,
 * and confirming it is the first thing docs/hardware/verifying-m1a.md asks of
 * a real board. If a board disagrees, **this parser is wrong** — fix it and
 * replace the fixture with what the board actually printed.
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
    if (!ADDRESS_FIELD.test(name) || value === "") continue;
    // An address before any device line cannot be attributed to an interface,
    // and an address we cannot attribute is not evidence of reachability.
    const current = devices[devices.length - 1];
    if (current !== undefined) current.addresses.push(value);
  }

  return devices;
}
