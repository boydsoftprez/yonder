// SPDX-License-Identifier: GPL-3.0-or-later
import { request } from "node:http";

/**
 * The console's client for the daemon's Unix socket.
 *
 * The console runs as the unprivileged `yonder` user and holds no credential
 * at all: `secrets.yaml` is 0600 root, so the administrator password hash is
 * not something it *can* read. Authentication is therefore a question it asks
 * over this socket, and every answer here is treated accordingly.
 *
 * **Everything fails closed** (R-SEC-11). A socket that is not there, a
 * connection refused, a daemon that has stopped answering, a reply that is not
 * JSON, a reply that is JSON but not the shape expected — all of them are
 * "cannot verify", which is a failed login. None of them is an exception:
 * this runs inside Node-RED, and an unhandled rejection from a middleware is
 * a console that falls over. The rule is that a daemon which is down, slow or
 * returning nonsense produces a failed login and never a successful one.
 */

export interface DaemonRequest {
  method: string;
  path: string;
  body?: unknown;
}

export interface DaemonResponse {
  status: number;
  /** The raw text. Parsing is the client's business, so a transport is trivial to fake. */
  body: string;
}

/**
 * How a request actually reaches the daemon. Injected so tests can produce
 * every failure mode — refusal, timeout, truncation, nonsense — without a
 * daemon and without waiting.
 */
export type Transport = (req: DaemonRequest) => Promise<DaemonResponse>;

/** Why a request did not produce a usable answer. */
export type DaemonFailure = "unreachable" | "malformed";

export type DaemonReply =
  | { ok: true; status: number; body: unknown }
  | { ok: false; reason: DaemonFailure; message: string };

/** How long to wait for the daemon before giving up. */
export const REQUEST_TIMEOUT_MS = 5_000;

/**
 * The most reply this client will read.
 *
 * The daemon is trusted, but a socket path pointed at something else is not,
 * and a console that will buffer an unbounded response can be made to
 * exhaust a board's memory by whatever is on the other end.
 */
const MAX_REPLY_BYTES = 1 << 20;

/** The real transport: HTTP over a Unix domain socket. */
export function unixTransport(socketPath: string, timeoutMs = REQUEST_TIMEOUT_MS): Transport {
  return (req) => new Promise<DaemonResponse>((resolve, reject) => {
    const payload = req.body === undefined ? undefined : Buffer.from(JSON.stringify(req.body), "utf8");
    const outgoing = request(
      {
        socketPath,
        method: req.method,
        path: req.path,
        headers: payload === undefined
          ? {}
          : { "content-type": "application/json", "content-length": String(payload.length) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let length = 0;
        res.on("data", (c: Buffer) => {
          length += c.length;
          if (length > MAX_REPLY_BYTES) {
            res.destroy();
            reject(new Error("the reply was larger than this console will read"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
        });
        res.on("error", reject);
      },
    );
    // A daemon that accepts the connection and then never answers is the
    // failure mode a plain socket error does not cover, and the one that
    // would otherwise leave a browser waiting for ever.
    outgoing.setTimeout(timeoutMs, () => {
      outgoing.destroy(new Error(`the configuration service did not answer within ${timeoutMs} ms`));
    });
    outgoing.on("error", reject);
    if (payload !== undefined) outgoing.write(payload);
    outgoing.end();
  });
}

export interface DaemonClientOptions {
  /** Ignored when `transport` is given. */
  socketPath?: string;
  transport?: Transport;
  timeoutMs?: number;
}

/** What POST /admin/password came back with, in a shape a page can render. */
export interface PasswordResult {
  ok: boolean;
  /** The daemon's status, or 503 when it could not be reached at all. */
  status: number;
  /** Safe to show: it states a rule and never quotes what was submitted. */
  error?: string;
}

export class DaemonClient {
  private readonly transport: Transport;

  constructor(opts: DaemonClientOptions) {
    if (opts.transport !== undefined) {
      this.transport = opts.transport;
    } else {
      if (opts.socketPath === undefined) {
        throw new Error("a DaemonClient needs either a socketPath or a transport");
      }
      this.transport = unixTransport(opts.socketPath, opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
    }
  }

  /**
   * One request. Never rejects — every way this can go wrong comes back as a
   * value, because the callers are Node-RED middleware and an unhandled
   * rejection there takes the console down.
   */
  async request(req: DaemonRequest): Promise<DaemonReply> {
    let response: DaemonResponse;
    try {
      response = await this.transport(req);
    } catch (e) {
      return { ok: false, reason: "unreachable", message: (e as Error).message };
    }
    if (response.body === "") {
      return { ok: true, status: response.status, body: undefined };
    }
    try {
      return { ok: true, status: response.status, body: JSON.parse(response.body) };
    } catch {
      // A reply that is not JSON is not the daemon, or is a daemon that has
      // gone wrong. Either way it is not an answer.
      return { ok: false, reason: "malformed", message: "the reply was not valid JSON" };
    }
  }

  /**
   * Whether this device has an administrator password.
   *
   * `undefined` means *cannot tell* — the daemon is not answering, or
   * answered with something this client does not recognise. Callers must not
   * turn that into `false`: "no password yet" is what opens the setup page.
   */
  async provisioned(): Promise<boolean | undefined> {
    const reply = await this.request({ method: "GET", path: "/console/state" });
    if (!reply.ok || reply.status !== 200) return undefined;
    const value = (reply.body as { provisioned?: unknown } | undefined)?.provisioned;
    return typeof value === "boolean" ? value : undefined;
  }

  /**
   * A login attempt, and enough about a refusal to say something useful.
   *
   * `ok` is true for exactly one outcome: the daemon answered 200 with a body
   * whose `ok` is the boolean `true`. Every other outcome — refused,
   * throttled, unreachable, malformed, `{ok: "true"}` — is false. That is
   * what "fail closed" means here, and it is asserted as such in the tests.
   *
   * `retryAfter` is set only when the daemon said it was throttling, so the
   * login page can say "wait" rather than "wrong password" — telling an
   * operator their correct password is wrong is how a device gets declared
   * broken and sent back.
   */
  async login(password: string): Promise<{ ok: boolean; retryAfter?: number }> {
    const reply = await this.request({
      method: "POST",
      path: "/admin/verify",
      body: { password },
    });
    if (!reply.ok) return { ok: false };
    if (reply.status === 429) {
      const wait = (reply.body as { retryAfter?: unknown } | undefined)?.retryAfter;
      return typeof wait === "number" && Number.isFinite(wait) && wait > 0
        ? { ok: false, retryAfter: Math.ceil(wait) }
        : { ok: false };
    }
    if (reply.status !== 200) return { ok: false };
    return { ok: (reply.body as { ok?: unknown } | undefined)?.ok === true };
  }

  /**
   * Whether `password` is this device's administrator password.
   *
   * The plain boolean the flow editor's `adminAuth` needs. Same answer as
   * `login`, with the throttling detail dropped — passport has nowhere to put
   * it.
   */
  async verify(password: string): Promise<boolean> {
    return (await this.login(password)).ok;
  }

  /** Set the administrator password, once. Relays the daemon's own refusal. */
  async setPassword(password: string): Promise<PasswordResult> {
    const reply = await this.request({
      method: "POST",
      path: "/admin/password",
      body: { password },
    });
    if (!reply.ok) {
      return {
        ok: false,
        status: 503,
        error: "the device's configuration service is not answering; "
          + "wait a moment and try again",
      };
    }
    if (reply.status === 200) {
      // Strict about the body as well as the status. A 200 from something
      // that is not this daemon would otherwise have the setup page announce
      // a password that was never stored — and the operator would find that
      // out only when the console came back still asking for one.
      if ((reply.body as { ok?: unknown } | undefined)?.ok === true) return { ok: true, status: 200 };
      return {
        ok: false,
        status: 502,
        error: "the device's configuration service answered with something this console "
          + "did not understand; the password was not set",
      };
    }
    const error = (reply.body as { error?: unknown } | undefined)?.error;
    return {
      ok: false,
      status: reply.status,
      error: typeof error === "string" ? error : "the password was not accepted",
    };
  }
}
