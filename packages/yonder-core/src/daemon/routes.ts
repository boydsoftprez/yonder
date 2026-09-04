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
import { joinNetwork, leaveNetwork, type JoinRequest } from "../net/join.js";
import { configureModem } from "../net/modem/configure.js";
import type { NetworkState } from "../net/state.js";
import type { ModemState } from "../net/modem/state.js";
import type { PathName, ReachState } from "../net/reach/standing.js";
import { setTheme, type ThemeRequest } from "../ui/theme.js";
import type { ScanResult } from "../net/scan.js";
import type { BoardFacts } from "../system/facts.js";
import type { Versions } from "../system/versions.js";
import { DEFAULT_CONFIG, ZEROTIER_NETWORK_ID } from "../schema/config.js";
import { publishableApPassphrase } from "../net/profiles.js";
import type { RemoteState } from "../remote/state.js";

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
  /** What the radio is doing. Injected, so this router still knows no nmcli. */
  netState?: () => Promise<NetworkState>;
  /** What the modem says about itself. Injected, so this router knows no mmcli. */
  modemState?: () => Promise<ModemState>;
  /** Which way out is in use, and which paths have been stood down. */
  reachState?: () => Promise<ReachState>;
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
   *
   * **`get` is here for exactly one question**: whether the access point is
   * still on the passphrase this project publishes (R-UI-18). It is optional
   * because the answer is allowed to be *cannot tell* — see
   * `publishableApPassphrase`, which never hands back what it was given. No
   * route reads any other row through this, and none should: a value out of
   * this store is a credential unless something has established that it is
   * not.
   */
  secrets?: {
    put(name: string, value: string): void;
    get?(name: string): string | undefined;
  };
  /** The buffer GET /log serves. Defaults to the one this process writes to. */
  activity?: ActivityLog;
  /** The mesh join state. Absent on a daemon with no remote layer. */
  remoteState?: () => Promise<RemoteState>;
  /**
   * Test one path now and answer when the result is known.
   *
   * R-CEL-09's "on request". Injected, so this router still knows no probe —
   * and wired to the same ReachMonitor the automatic probes use, so a test an
   * operator asked for and one the device ran itself are the same evidence.
   */
  testPath?: (path: PathName) => Promise<boolean>;
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

/**
 * How to get back to this device when the console has stopped being one
 * (R-UI-18).
 *
 * Every field here is public by construction, which is what makes it
 * acceptable on a route that sits in front of the administrator-password
 * gate. The SSID is beaconed continuously; the address is what the access
 * point's own DHCP hands to every client that joins it; the hostname is
 * announced over mDNS. None of the three is knowledge somebody in radio range
 * lacks, and all three are useless without a way past the console's login.
 *
 * The passphrase is the one that needed a rule, and it has one: see
 * `publishableApPassphrase`.
 */
export interface WayBackIn {
  /** The access point to join. */
  ssid: string;
  /** Its address, without the prefix length — what a browser is pointed at. */
  address: string;
  /** The name it answers to, ready to type. */
  hostname: string;
  /**
   * The published default while the device is still on it, and **null once
   * the operator has set their own** (R-SEC-10). Never the stored value: this
   * is either the constant in `net/profiles.ts` or nothing at all.
   */
  passphrase: string | null;
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

  /**
   * The way back in, assembled from the configuration and one secret row
   * (R-UI-18).
   *
   * **It cannot throw.** `GET /status` is what answers on a device that has
   * gone wrong, and an unreadable config.yaml is one of the ways a device
   * goes wrong — so a configuration that will not load falls back to the
   * shipped defaults rather than taking the panel down. Those defaults are
   * also what such a device is genuinely reachable on: they are what the
   * access-point profile it is running was rendered from.
   */
  const wayBackIn = (): WayBackIn => {
    let config = DEFAULT_CONFIG;
    try {
      config = loadConfig(deps.configPath);
    } catch {
      // Not logged. This route is polled by a page every few seconds, and a
      // line per poll would bury the reason the configuration will not load
      // under thousands of copies of the fact that it will not.
    }
    return {
      ssid: config.network.ap.ssid,
      // Without the prefix length: an operator types this into a browser, and
      // `192.168.77.1/24` is not an address a browser can be given.
      address: config.network.ap.address.split("/")[0],
      // mDNS answers for `<hostname>.local`, and the panel prints what gets
      // typed rather than a name plus an instruction about what to add to it.
      hostname: `${config.system.hostname}.local`,
      passphrase: publishableApPassphrase(deps.secrets?.get?.("ap_psk")),
    };
  };

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

      // Deliberately in front of the gate below. It carries an apply state,
      // an expiry, the reason the renderer set could not be assembled, and
      // the way back into the device — and it is the one thing that makes a
      // board whose secrets.yaml is unreadable diagnosable at all. Gating it
      // would mean a device that can only say "403" about a fault an operator
      // has to be on the device to fix anyway.
      //
      // **`wayBackIn` is the only configuration this route carries, and it is
      // meant to stay that way** (R-UI-18). Three fields that are beaconed,
      // handed out by DHCP and announced over mDNS anyway, plus a passphrase
      // that is either the published one or nothing. A test asserts that
      // nothing else out of config.yaml follows them here; if a future field
      // needs the gate, it belongs on a route that has one.
      if (method === "GET" && path === "/status") {
        return { status: 200, body: { ...deps.engine.status(), wayBackIn: wayBackIn() } };
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

      // The inverse of /net/join, and the control the console did not have:
      // joining was a one-way door, so an operator on the wrong network had
      // no way back to the access point from the interface that took them
      // there. Clearing the SSID is the whole change; radioPlan does the rest.
      if (method === "POST" && path === "/net/leave") {
        return { status: 200, body: await deps.engine.apply(leaveNetwork(loadConfig(deps.configPath))) };
      }

      // One line that answers "what is the radio doing", computed from the
      // configuration *and* the devices, because the two disagree exactly
      // when it matters - a configuration naming a network the radio never
      // joined is the state an apply is about to revert.
      if (method === "GET" && path === "/net/state") {
        if (deps.netState === undefined) {
          say("GET /net/state: there is no network layer on this daemon to ask");
          return {
            status: 503,
            body: { error: "this device cannot report its network state" },
          };
        }
        return { status: 200, body: await deps.netState() };
      }

      // What the modem says about itself, and which way out is actually
      // working. Two routes rather than one because they answer different
      // questions and fail independently: a board can have a modem this
      // daemon can read and no reach monitor, or the reverse.
      //
      // Absent means *this daemon has no such layer*, which is a 503 naming
      // the absence — never an empty record, which a page would render as a
      // modem with no signal on a board that has one.
      if (method === "GET" && path === "/modem/state") {
        if (deps.modemState === undefined) {
          say("GET /modem/state: there is no modem layer on this daemon to ask");
          return { status: 503, body: { error: "this device cannot report a modem" } };
        }
        // Never a credential. ModemState is assembled from what the device
        // reports, not from the configuration, so the APN comes back off the
        // connected bearer and `gsm.password` has no field to arrive in
        // (R-SEC-10).
        return { status: 200, body: await deps.modemState() };
      }

      if (method === "GET" && path === "/reach/state") {
        if (deps.reachState === undefined) {
          say("GET /reach/state: there is no reach monitor on this daemon to ask");
          return { status: 503, body: { error: "this device cannot report its way out" } };
        }
        return { status: 200, body: await deps.reachState() };
      }

      // The same shape as /net/join and /remote/join: the router merges one
      // section into the document and hands the whole thing to the apply
      // engine. Nothing about a modem is stored anywhere else, and the
      // response is an apply status, not a configuration — R-SEC-10 says
      // `gsm.password` never comes back out of this route, and an apply
      // status is not a shape it could arrive in.
      //
      // **The password takes the same road the Wi-Fi passphrase does.** The
      // operator types a string; `config.yaml` holds a reference to a row in
      // `secrets.yaml`. `configureModem` is the one thing that converts
      // between them, exactly as `joinNetwork` is for `network.client.psk` —
      // and it is why this route needs a secret store rather than being pure
      // schema validation. Without one there is nowhere to put the
      // credential, and applying a reference to a row that was never written
      // would take the modem off the air while reporting success.
      //
      // The submitted password is redacted at the top of this function like
      // every other body, so nothing below can log it (R-SEC-10).
      if (method === "POST" && path === "/modem/configure") {
        if (deps.secrets === undefined) {
          say("POST /modem/configure: the secret store could not be read, so nothing can be stored in it");
          return {
            status: 503,
            body: { error: "the device's secrets could not be read; see the device journal" },
          };
        }
        const wanted = configureModem(loadConfig(deps.configPath), body, deps.secrets);
        if (!wanted.ok) return { status: 400, body: { error: wanted.error } };
        return { status: 200, body: await deps.engine.apply(wanted.config) };
      }

      // R-CEL-09's "on request", answered by the same ReachMonitor the
      // automatic probes use — never a second way to decide whether a path
      // works, only a second reason to ask it.
      if (method === "POST" && path === "/reach/test") {
        if (deps.testPath === undefined) {
          say("POST /reach/test: there is no reach monitor on this daemon to ask");
          return { status: 503, body: { error: "this device cannot test its way out" } };
        }
        const wanted = (body as { path?: unknown } | undefined)?.path;
        if (wanted !== "ethernet" && wanted !== "modem" && wanted !== "wifi_client") {
          return { status: 400, body: { error: "name one of: ethernet, modem, wifi_client" } };
        }
        return { status: 200, body: { path: wanted, reached: await deps.testPath(wanted) } };
      }

      // The same shape as /net/join: the router merges one field into the
      // document and hands it to the engine. Nothing about a mesh is stored
      // anywhere else, and a network id is not a secret - it is the name of a
      // network, not a way into one - so it lives in config.yaml.
      if (method === "POST" && path === "/remote/join") {
        const wanted = (body as { networkId?: unknown } | undefined)?.networkId;
        if (typeof wanted !== "string" || !ZEROTIER_NETWORK_ID.test(wanted)) {
          return {
            status: 400,
            body: { error: "a ZeroTier network id is sixteen lowercase hexadecimal characters" },
          };
        }
        const config = loadConfig(deps.configPath);
        return {
          status: 200,
          body: await deps.engine.apply({
            ...config,
            remote: { ...config.remote, zerotier: { enabled: true, network_id: wanted } },
          }),
        };
      }

      if (method === "POST" && path === "/remote/leave") {
        const config = loadConfig(deps.configPath);
        return {
          status: 200,
          body: await deps.engine.apply({
            ...config,
            remote: { ...config.remote, zerotier: { enabled: false, network_id: null } },
          }),
        };
      }

      if (method === "GET" && path === "/remote/state") {
        if (deps.remoteState === undefined) {
          say("GET /remote/state: there is no remote layer on this daemon to ask");
          return { status: 503, body: { error: "this device cannot report its mesh state" } };
        }
        return { status: 200, body: await deps.remoteState() };
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
      // The other half of the same decision (R-UI-15). A console that can only
      // confirm leaves an operator who has already decided the change was
      // wrong watching a timer — and reaching for the power instead, which is
      // the one thing that turns a rollback into a recovery.
      if (method === "POST" && path === "/revert") {
        const id = (body as { id?: string } | undefined)?.id;
        if (typeof id !== "string") return { status: 400, body: { error: "id is required" } };
        await deps.engine.revertNow(id);
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
