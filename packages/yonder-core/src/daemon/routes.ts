// SPDX-License-Identifier: GPL-3.0-or-later
import { ApplyEngine } from "../apply/engine.js";
import { loadConfig } from "../config/load.js";
import { ConfigError } from "../config/errors.js";
import { warn } from "../log.js";
import { activityLog, type ActivityLog } from "../log/activity.js";
import { AdminCredential } from "../console/credential.js";
import { AttemptThrottle } from "../console/throttle.js";
import { secretValuesIn, redactValues } from "../secrets/redact.js";
import { readBoardFacts } from "../system/read.js";
import { readVersions } from "../system/versions.js";
import { displayFacts, type BoardDisplay } from "../system/format.js";
import { isProbeHost, type PingResult } from "../diag/probe.js";
import { joinNetwork, type JoinRequest } from "../net/join.js";
import { setTheme, type ThemeRequest } from "../ui/theme.js";
import type { ScanResult } from "../net/scan.js";
import type { BoardFacts } from "../system/facts.js";
import type { Versions } from "../system/versions.js";

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
  /**
   * What this board says about itself. Defaulted to the real readers, which
   * only open files under /proc and /sys and answer null for every one that
   * is not there — so a test that does not inject gets a record full of
   * nulls rather than a failure or a real measurement.
   */
  system?: () => SystemReport;
  /**
   * Scans for Wi-Fi networks. **Absent when the network layer could not be
   * assembled** — a malformed secrets.yaml does that — and the route then
   * says so rather than pretending the air is empty.
   */
  scan?: () => Promise<ScanResult>;
  /** See DiagProbes. Absent means this daemon cannot probe, not that nothing answered. */
  diag?: DiagProbes;
  /**
   * Stores the Wi-Fi passphrase for POST /net/join. Absent when the secret
   * store could not be read, which is the same condition that leaves
   * `credential` undefined — so the route refuses rather than applying a
   * configuration whose secret reference points at nothing.
   */
  secrets?: { put(name: string, value: string): void };
  /** The buffer GET /log serves. Defaults to the one this process writes to. */
  activity?: ActivityLog;
}

/** What GET /system answers with. */
export interface SystemReport {
  facts: BoardFacts;
  versions: Versions;
  /** The same facts as strings a widget can bind. See system/format.ts. */
  display: BoardDisplay;
}

/**
 * The reachability probes, injected.
 *
 * Given rather than defaulted, for the same reason `scan` is: with a default
 * these routes would run a real `ping` from any test that reached them, and
 * "no test may execute ping" is a rule that has to be impossible to break
 * rather than remembered. `daemon/server.ts` builds them from the same
 * CommandRunner the renderers use, so a test that injects a fake runner gets
 * a fake ping for free.
 */
export interface DiagProbes {
  ping(host: string, count: number | undefined): Promise<PingResult>;
  reachable(): Promise<PingResult>;
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

/**
 * A finite, non-negative integer out of a query string, or 0.
 *
 * A cursor a page could not parse is a page asking for everything, which is
 * the harmless direction: it repeats entries it already has rather than
 * silently skipping ones it never saw.
 */
function sinceParam(query: string): number {
  const raw = new URLSearchParams(query).get("since");
  if (raw === null) return 0;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function createRouter(deps: RouterDeps): Router {
  const throttle = deps.throttle ?? new AttemptThrottle();
  const activity = deps.activity ?? activityLog;
  const system = deps.system ?? ((): SystemReport => {
    const facts = readBoardFacts();
    const versions = readVersions();
    // `display` alongside the raw record, not instead of it. A page binds a
    // widget to a string and cannot divide bytes by 1024 twice — doing that
    // in a `function` node is CLAUDE.md rule 2, and doing it in a contrib
    // node is what this milestone forbids for the same reason — so the
    // formatting happens in yonder-core, where it has tests. Anything that
    // wants the numbers still has them.
    return { facts, versions, display: displayFacts(facts, versions) };
  });

  return async (method, rawPath, body) => {
    // `req.url` carries the query string, and every comparison below is an
    // equality against a path. Split once, here, rather than have each route
    // decide — a route that forgets is a 404 an operator reads as a missing
    // feature.
    const queryAt = rawPath.indexOf("?");
    const path = queryAt < 0 ? rawPath : rawPath.slice(0, queryAt);
    const query = queryAt < 0 ? "" : rawPath.slice(queryAt + 1);
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

      // ---- what the console's pages read -------------------------------
      //
      // All of these are behind the gate above, deliberately. None of them is
      // needed to set an administrator password, so none of them belongs in
      // front of it: a board model, a scan of the air and an activity log are
      // all "function", and R-SEC-09 says a device without a password offers
      // none.

      if (method === "GET" && path === "/system") {
        return { status: 200, body: system() };
      }

      if (method === "GET" && path === "/net/scan") {
        if (deps.scan === undefined) {
          say("GET /net/scan: there is no network layer on this daemon to scan with");
          return {
            status: 503,
            body: { error: "this device cannot scan; see the device journal for the reason" },
          };
        }
        // Never a pre-shared key: a scan is a list of what is broadcasting,
        // and ScanResult has no field that could carry one. A failure throws
        // to the catch-all below rather than returning an empty list — a scan
        // that did not run is not a neighbourhood with no Wi-Fi in it.
        return { status: 200, body: await deps.scan() };
      }

      if (method === "POST" && path === "/diag/ping") {
        if (deps.diag === undefined) {
          return {
            status: 503,
            body: { error: "this device cannot run a probe; see the device journal for the reason" },
          };
        }
        const host = (body as { host?: unknown } | undefined)?.host;
        // Refused here as well as inside the probe. The probe cannot be made
        // to run this string either way; what this adds is a 400 rather than
        // a 200 carrying a refusal, so a page does not have to read the body
        // to know the request was wrong.
        if (typeof host !== "string" || !isProbeHost(host)) {
          return { status: 400, body: { error: "host must be a host name or an IPv4 address" } };
        }
        const count = (body as { count?: unknown } | undefined)?.count;
        return {
          status: 200,
          body: await deps.diag.ping(host, typeof count === "number" ? count : undefined),
        };
      }

      if (method === "GET" && path === "/diag/reachable") {
        if (deps.diag === undefined) {
          return {
            status: 503,
            body: { error: "this device cannot run a probe; see the device journal for the reason" },
          };
        }
        return { status: 200, body: await deps.diag.reachable() };
      }

      if (method === "GET" && path === "/log") {
        // Already redacted: entries go through secrets/redact.ts on the way
        // into the buffer, not on the way out of it (R-SEC-10). There is no
        // filtering step here to forget.
        return { status: 200, body: activity.page(sinceParam(query)) };
      }

      // The one write the network page makes, and the reason it is a route
      // rather than a form that assembles a configuration in a browser.
      //
      // Joining a network is three things that have to happen together: the
      // passphrase into `secrets.yaml` (which only root can write), a
      // reference to it into `network.client`, and the whole document through
      // the apply engine so it inherits the confirmation timer. A page that
      // did that itself would have to hold the operator's whole configuration
      // and merge into it, in a browser, and post back something it had built
      // — which is a decision, in wiring, about the thing that decides whether
      // the device is reachable.
      //
      // The submitted passphrase is redacted at the top of this function like
      // every other body, so nothing below can log it (R-SEC-10).
      if (method === "POST" && path === "/net/join") {
        if (deps.secrets === undefined) {
          say("POST /net/join: the secret store could not be read, so nothing can be stored in it");
          return {
            status: 503,
            body: { error: "the device's secrets could not be read; see the device journal" },
          };
        }
        const join = joinNetwork(loadConfig(deps.configPath), body as JoinRequest, deps.secrets);
        if (!join.ok) return { status: 400, body: { error: join.error } };
        return { status: 200, body: await deps.engine.apply(join.config) };
      }

      // The same shape as /net/join, and for the same reason. A page that
      // merged a theme into the configuration would be editing the document
      // that decides whether the device is reachable, in wiring, from a
      // browser — and the wiring that did it held the last configuration in
      // flow context and assigned straight through the reference, so choosing
      // a theme mutated the cache in place and a revert left it lying.
      if (method === "POST" && path === "/ui/theme") {
        const chosen = setTheme(loadConfig(deps.configPath), body as ThemeRequest);
        if (!chosen.ok) return { status: 400, body: { error: chosen.error } };
        return { status: 200, body: await deps.engine.apply(chosen.config) };
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
