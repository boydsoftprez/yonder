// SPDX-License-Identifier: GPL-3.0-or-later
import { ApplyEngine } from "../apply/engine.js";
import { loadConfig } from "../config/load.js";
import { ConfigError } from "../config/errors.js";
import { warn } from "../log.js";
import { AdminCredential } from "../console/credential.js";
import { AttemptThrottle } from "../console/throttle.js";
import { secretValuesIn, redactValues } from "../secrets/redact.js";

export interface RouterDeps {
  engine: ApplyEngine;
  configPath: string;
  /**
   * The administrator password, or `undefined` when the secret store could
   * not be read at all — a malformed `secrets.yaml` is what does that, and
   * `startServer` serves anyway so the device stays diagnosable.
   *
   * Required rather than optional, so that a new construction site has to
   * decide what it is passing rather than quietly getting the unprovisioned
   * behaviour by omission. Undefined means *cannot tell*, and every route
   * below treats that exactly as it treats "not provisioned": refuse. The
   * safe direction when this daemon does not know whether the device has a
   * lock on it is to behave as though it has one nobody can open, never as
   * though it needs none.
   */
  credential: AdminCredential | undefined;
  /** Backoff on failed logins. One administrator, one counter — see throttle.ts. */
  throttle?: AttemptThrottle;
  /**
   * Called after an administrator password is set, so the console can be
   * rewritten and restarted into its provisioned shape.
   *
   * Synchronous and not awaited, on purpose. Restarting the console kills the
   * process that is answering the operator's browser, so this route must
   * return first; the implementation in server.ts defers the work on the
   * injected clock. A hook that could block this route would turn the one
   * interaction every operator has into a connection reset.
   */
  onProvisioned?: () => void;
}

export interface RouteResult {
  status: number;
  body: unknown;
}

export type Router = (method: string, path: string, body: unknown) => Promise<RouteResult>;

/** The body shape both administrator routes take. */
function submittedPassword(body: unknown): string | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const value = (body as { password?: unknown }).password;
  return typeof value === "string" ? value : undefined;
}

export function createRouter(deps: RouterDeps): Router {
  const throttle = deps.throttle ?? new AttemptThrottle();

  return async (method, path, body) => {
    // Captured here, at the top, before any branch can do anything with the
    // body — R-SEC-10 says redaction happens where the value is captured, not
    // where it is printed. Everything this function logs goes through `say`,
    // so a line that picks up a submitted password on its way out of some
    // future branch is stripped of it without that branch having to know.
    const submitted = secretValuesIn(body);
    // Redaction is by value, so a password that happens to be a substring of
    // this daemon's own wording takes that substring with it — a refusal of
    // the password "short" logs `too-<redacted>`. Noisy, and the harmless
    // direction of the only mistake a value-based redactor can make. The
    // alternative is deciding per branch what might contain a secret, which
    // is how the leak comes back.
    const say = (line: string): void => warn(redactValues(line, submitted));

    try {
      // ---- the console's first-run routes -------------------------------
      //
      // GET /console/state is the only one of these reachable before an
      // administrator password exists, and it answers with one boolean. No
      // version, no hostname, no configuration: R-SEC-09 says a device
      // without a password offers no function but setting one, and a status
      // readout is a function.
      if (method === "GET" && path === "/console/state") {
        if (deps.credential === undefined) {
          say("GET /console/state: the secret store could not be read, so provisioning is unknown");
          return {
            status: 503,
            body: { error: "the device's secrets could not be read; see the device journal" },
          };
        }
        return { status: 200, body: { provisioned: deps.credential.isSet() } };
      }

      if (method === "POST" && path === "/admin/password") {
        if (deps.credential === undefined) {
          say("POST /admin/password: the secret store could not be read, so nothing can be stored in it");
          return {
            status: 503,
            body: { error: "the device's secrets could not be read; see the device journal" },
          };
        }
        const password = submittedPassword(body);
        if (password === undefined) return { status: 400, body: { error: "password is required" } };

        const result = deps.credential.set(password);
        if (result.ok) {
          say("an administrator password was set");
          try {
            deps.onProvisioned?.();
          } catch (e) {
            // The password is set. A console that did not get restarted comes
            // back into the right mode on the next apply or the next boot,
            // and that is not worth turning a success into a failure over.
            say(`the console could not be scheduled for a restart: ${(e as Error).message}`);
          }
          return { status: 200, body: { ok: true } };
        }
        // The message states the rule and never quotes what was submitted.
        say(`POST /admin/password refused: ${result.reason}`);
        return {
          status: result.reason === "already-set" ? 409 : 400,
          body: { error: result.message },
        };
      }

      if (method === "POST" && path === "/admin/verify") {
        // Before the password is even read out of the body: a refused
        // attempt must cost no scrypt derivation, or the refusal is itself a
        // way to keep this daemon's event loop busy.
        const decision = throttle.check();
        if (!decision.allowed) {
          return {
            status: 429,
            body: { ok: false, retryAfter: decision.retryAfter },
          };
        }
        const password = submittedPassword(body);
        // Fails closed in every direction: no credential store, no password
        // in the body, no password on the device. None of them authenticates
        // anyone, and all three count as a failed attempt so that hammering
        // any of them still meets the throttle.
        const ok = password !== undefined
          && deps.credential !== undefined
          && deps.credential.verify(password);
        throttle.record(ok);
        return { status: 200, body: { ok } };
      }

      // Deliberately in front of the gate below. GET /status carries no
      // configuration — an apply state, an expiry, and the reason the
      // renderer set could not be assembled — and it is the one thing that
      // makes a device whose secrets.yaml is unreadable diagnosable at all.
      // Gating it would mean a board that can only say "403" about a fault
      // an operator has to be on the device to fix anyway.
      if (method === "GET" && path === "/status") {
        return { status: 200, body: deps.engine.status() };
      }

      // ---- everything else is behind the administrator password ---------
      //
      // R-SEC-09: until one is set, there is no configuration read. The
      // console cannot reach these routes in setup mode because it has no
      // flow that calls them — but the socket is the boundary, not the
      // console, and a boundary that depends on the caller being polite is
      // not one.
      if (deps.credential === undefined || !deps.credential.isSet()) {
        return {
          status: 403,
          body: {
            error: "no administrator password is set on this device; "
              + "set one from the console before reading or changing its configuration",
          },
        };
      }

      if (method === "GET" && path === "/config") {
        return { status: 200, body: loadConfig(deps.configPath) };
      }
      if (method === "POST" && path === "/apply") {
        return { status: 200, body: await deps.engine.apply(body) };
      }
      if (method === "POST" && path === "/confirm") {
        const id = (body as { id?: string } | undefined)?.id;
        if (typeof id !== "string") return { status: 400, body: { error: "id is required" } };
        deps.engine.confirm(id);
        return { status: 200, body: deps.engine.status() };
      }
      return { status: 404, body: { error: `no route for ${method} ${path}` } };
    } catch (e) {
      // A ConfigError is written for the operator: it says what is wrong with
      // the configuration they sent, and its issues list is the whole point
      // of the route. It never carries anything from a subprocess.
      if (e instanceof ConfigError) {
        return { status: 400, body: { error: e.message, issues: e.issues } };
      }
      // Everything else does. A renderer failure arrives here as an
      // NmcliError whose message embeds nmcli's stderr verbatim, and echoing
      // an arbitrary error message into an HTTP body is how that leaves the
      // device. NmcliError does not extend ConfigError, so it fell straight
      // through to this branch.
      //
      // The detail goes to the journal, which needs being on the device to
      // read — and being on the device is exactly what the caller of this API
      // may not yet be. The response says only that something failed.
      say(`${method} ${path} failed: ${(e as Error).message}`);
      return {
        status: 500,
        body: { error: "the request failed; see the device journal for the reason" },
      };
    }
  };
}
