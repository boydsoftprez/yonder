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

/** Everything with a meaning in a regular expression. */
function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
}

/**
 * `psk=hunter2` and `802-11-wireless-security.psk: hunter2`, in free text.
 *
 * The third consumer of the one list, after argv (`redactArgv`) and request
 * bodies (`secretValuesIn`). Those two work on structure: a caller that knows
 * which array slot or which JSON key held the value. A log line has neither,
 * and the activity buffer this feeds is **served to a browser**, so a line
 * assembled by hand out of a name and a value would otherwise arrive on a page
 * intact.
 *
 * Still not a guess about what a secret *looks like* — that is the mistake
 * this module's header refuses to make, because a password can look like a
 * word. This recognises the same names `redactArgv` recognises, and takes what
 * follows one of them across a separator that means "here is its value". A
 * sentence that merely mentions a password is untouched, which is why the
 * separator is required rather than merely allowed.
 *
 * Longest name first, so `802-11-wireless-security.psk` is not matched as
 * `psk` with a prefix.
 */
const NAMED_VALUE = new RegExp(
  `\\b(${[...SECRET_KEYS]
    .sort((a, b) => b.length - a.length)
    .map(escapeForRegExp)
    .join("|")})(\\s*[:=]\\s*)("[^"]*"|'[^']*'|\\S+)`,
  "gi",
);

export function redactNamedValues(text: string): string {
  return text.replace(NAMED_VALUE, (_match, name: string, separator: string) =>
    `${name}${separator}${REDACTED}`);
}

/**
 * The values this device actually holds.
 *
 * Names are knowledge this module has by construction; *values* are knowledge
 * only the secret store has, and only once it has read the file. Registering
 * them here is what makes the redaction cover a line nobody anticipated —
 * `joining the network with hunter2` names nothing and matches no pattern, and
 * is exactly the line a future caller writes.
 *
 * `SecretStore` registers on every read and every write, so this cannot be
 * forgotten by a new call site the way a per-caller list can. Deliberately
 * process-wide: "this string is a credential on this device" is a fact about
 * the device, not about one object.
 *
 * The cost is noise, in the same harmless direction `daemon/routes.ts`
 * already accepts: a secret that happens to be a substring of ordinary text
 * takes that substring with it. A log line reading `<redacted>er` is worse to
 * read and better than the alternative.
 */
const guarded = new Set<string>();

export function guardSecretValue(value: string): void {
  if (value !== "") guarded.add(value);
}

/** Strip every registered value, whatever line carries it and however. */
export function redactGuarded(text: string): string {
  return guarded.size === 0 ? text : redactValues(text, [...guarded]);
}

/** Test-only. Nothing on a device ever stops a value being a credential. */
export function forgetGuardedValues(): void {
  guarded.clear();
}

/**
 * Everything this project knows how to strip, applied to one line.
 *
 * The single entry point for free text — a journal line, an activity entry —
 * so a caller does not have to know there are two mechanisms.
 */
export function redactLine(text: string): string {
  return redactNamedValues(redactGuarded(text));
}
