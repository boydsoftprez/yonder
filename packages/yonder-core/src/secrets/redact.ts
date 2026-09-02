// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The one list of names whose value is a credential, and the redaction built
 * on it (R-SEC-10).
 *
 * It lives here rather than in net/runner.ts because it is no longer only
 * about argv. The same question — "is a value carried under this name a
 * secret?" — is asked of an nmcli command line and of a JSON request body,
 * and answering it from two lists is how one of them silently stops matching
 * the other. R-SEC-10 says redaction happens where the value is captured, and
 * a capture point that consults a different list is a new leak waiting to be
 * introduced.
 *
 * Redaction here is **by value, not by pattern**. A pattern has to guess what
 * a secret looks like and will be wrong about a password that looks like a
 * word. The callers know exactly which values they just handled, so they can
 * strip those and nothing else.
 */

/** Names whose accompanying value is a credential. */
export const SECRET_KEYS: ReadonlySet<string> = new Set([
  // nmcli property names, from the connection profiles this daemon writes.
  "wifi-sec.psk",
  "802-11-wireless-security.psk",
  "wifi-sec.wep-key0",
  "gsm.password",
  "ppp.password",
  // The bare names a request body uses. `password` covers both the console's
  // POST /admin/password and POST /admin/verify.
  "password",
  "psk",
  "passphrase",
]);

export const REDACTED = "<redacted>";

/** Whether a value carried under this name is a credential. */
export function isSecretKey(name: string): boolean {
  return SECRET_KEYS.has(name);
}

/**
 * Every string a request body carries under a secret-bearing name.
 *
 * Walks nested objects and arrays, because a configuration body is a tree and
 * the value that must not be logged can be at any depth. Depth is bounded so
 * a body someone has made self-referential cannot spin here — the daemon must
 * stay up more than it must be thorough about a malformed request.
 */
export function secretValuesIn(body: unknown, depth = 0): string[] {
  if (depth > 8 || body === null || typeof body !== "object") return [];
  const found: string[] = [];
  if (Array.isArray(body)) {
    for (const item of body) found.push(...secretValuesIn(item, depth + 1));
    return found;
  }
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (typeof value === "string") {
      if (value !== "" && isSecretKey(key)) found.push(value);
    } else {
      found.push(...secretValuesIn(value, depth + 1));
    }
  }
  return found;
}

/**
 * Strip a known set of secret values out of a line about to be logged.
 *
 * The caller supplies the values because the caller is what handled them:
 * net/runner.ts knows the argv it passed, and daemon/routes.ts knows the body
 * it was posted. Nothing here has to recognise a secret on sight.
 */
export function redactValues(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret === "") continue;
    out = out.split(secret).join(REDACTED);
  }
  return out;
}
