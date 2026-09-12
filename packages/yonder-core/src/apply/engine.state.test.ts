// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { ApplyEngine } from "./engine.js";
import { DEFAULT_CONFIG, type Config } from "../schema/config.js";
import type {
  DurableState,
  StateCoordinator,
  StateSnapshot,
  StateTransaction,
} from "../state/types.js";
import type { Clock } from "./types.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { SecretStore } from "../secrets/store.js";
import { AdminCredential, ADMIN_PASSWORD_SECRET } from "../console/credential.js";
import { hashPassword } from "../console/password.js";

function durable(config: Config = DEFAULT_CONFIG): DurableState {
  return {
    config: structuredClone(config),
    secrets: { ap_psk: "old-access-point-secret", wifi_psk: "old-client-secret" },
    linuxOwner: null,
    zeroTier: null,
  };
}

function coordinator(initial = durable(), project: (state: DurableState) => void = () => {}) {
  let active = structuredClone(initial);
  let staged: DurableState | undefined;
  let operation: { id: string; phase: string } | undefined;
  const calls: string[] = [];
  let rollbackFailure: Error | undefined;
  let commitFailure: Error | undefined;
  let holdFailure: Error | undefined;
  let pendingPrevious: DurableState | undefined;
  const api: StateCoordinator = {
    async status() {
      return { activeGeneration: "active", operation: operation as never ?? null };
    },
    async begin({ id }) {
      if (operation) throw new Error("busy");
      operation = { id, phase: "staging" };
      const previous: StateSnapshot = { generation: "old", state: structuredClone(active) };
      pendingPrevious = structuredClone(active);
      const tx: StateTransaction = {
        id,
        previous,
        async stage(next) { calls.push("stage"); staged = structuredClone(next); return { generation: "new" }; },
        async activate() {
          calls.push("activate");
          if (!staged) throw new Error("nothing staged");
          active = structuredClone(staged);
          project(active);
          operation = { id, phase: "activating" };
          return { generation: "new" };
        },
        async holdForConfirmation() {
          calls.push("hold");
          operation = { id, phase: "awaiting-confirmation" };
          if (holdFailure) { const error = holdFailure; holdFailure = undefined; throw error; }
        },
        async commit() {
          calls.push("commit");
          if (commitFailure) { const error = commitFailure; commitFailure = undefined; throw error; }
          operation = undefined; pendingPrevious = undefined; return { generation: "new" };
        },
        async rollback(reason) {
          calls.push(`rollback:${reason}`);
          if (rollbackFailure) throw rollbackFailure;
          active = structuredClone(previous.state);
          project(active);
          operation = undefined;
          pendingPrevious = undefined;
          return { generation: "old" };
        },
      };
      return tx;
    },
    async beginSnapshot() { throw new Error("unused"); },
    async recover() {
      calls.push("recover");
      if (operation && pendingPrevious) {
        active = structuredClone(pendingPrevious);
        project(active);
        operation = undefined;
        pendingPrevious = undefined;
        return { selectedGeneration: "old", action: "rolled-back" };
      }
      return { selectedGeneration: "active", action: "none" };
    },
  };
  return {
    api, calls,
    active: () => structuredClone(active),
    failRollback(error: Error) { rollbackFailure = error; },
    failNextCommit(error: Error) { commitFailure = error; },
    failNextHold(error: Error) { holdFailure = error; },
  };
}

function clock() {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const value: Clock = {
    now: () => now,
    setTimer(ms, fn) { const id = next++; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimer(id) { timers.delete(id as number); },
  };
  return {
    value,
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) { timers.delete(id); timer.fn(); }
      }
    },
  };
}

function clientConfig(): Config {
  const next = structuredClone(DEFAULT_CONFIG);
  next.network.client.ssid = "flight-line";
  next.network.client.psk = { secret: "wifi_psk" };
  return next;
}

describe("ApplyEngine durable state integration", () => {
  it("projects matching config and secrets, then commits only after confirmation", async () => {
    const state = coordinator();
    const refresh = vi.fn();
    const seen: Array<{ ssid: string | null; secret: string | undefined }> = [];
    const engine = new ApplyEngine({
      configPath: "/unused/config.yaml",
      journalPath: "/unused/apply.json",
      stateCoordinator: state.api,
      refreshSecrets: refresh,
      renderers: [{ name: "network", async render(config) {
        seen.push({ ssid: config.network.client.ssid, secret: state.active().secrets.wifi_psk });
      } }],
    });

    const result = await engine.apply(clientConfig(), { secretPatch: { wifi_psk: "new-client-secret" } });
    expect(result.expiresAt).not.toBeNull();
    expect(seen).toEqual([{ ssid: "flight-line", secret: "new-client-secret" }]);
    expect(state.calls).toEqual(["stage", "activate", "hold"]);
    await engine.confirm(result.id);
    expect(state.calls).toEqual(["stage", "activate", "hold", "commit"]);
    expect(engine.status().state).toBe("confirmed");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("restores matching old config and secrets when a renderer fails", async () => {
    const state = coordinator();
    const refresh = vi.fn();
    const seen: string[] = [];
    const engine = new ApplyEngine({
      configPath: "/unused/config.yaml",
      journalPath: "/unused/apply.json",
      stateCoordinator: state.api,
      refreshSecrets: refresh,
      renderers: [{ name: "network", async render(config) {
        seen.push(`${config.network.client.ssid ?? "ap"}:${state.active().secrets.wifi_psk}`);
        if (config.network.client.ssid) throw new Error("radio failed");
      } }],
    });

    await expect(engine.apply(clientConfig(), { secretPatch: { wifi_psk: "new-client-secret" } }))
      .rejects.toThrow("radio failed");
    expect(state.calls).toEqual(["stage", "activate", "rollback:renderer-failed"]);
    expect(seen).toEqual(["flight-line:new-client-secret", "ap:old-client-secret"]);
    expect(state.active()).toEqual(durable());
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(engine.status().state).toBe("idle");
  });

  it("restores and renders the old generation when confirmation hold fails", async () => {
    const state = coordinator();
    state.failNextHold(new Error("hold response failed"));
    const seen: string[] = [];
    const engine = new ApplyEngine({
      configPath: "/unused/config.yaml",
      journalPath: "/unused/apply.json",
      stateCoordinator: state.api,
      renderers: [{ name: "network", async render(config) {
        seen.push(`${config.network.client.ssid ?? "ap"}:${state.active().secrets.wifi_psk}`);
      } }],
    });

    await expect(engine.apply(clientConfig(), { secretPatch: { wifi_psk: "new-client-secret" } }))
      .rejects.toThrow("hold response failed");
    expect(state.calls).toEqual(["stage", "activate", "hold", "rollback:hold-failed"]);
    expect(state.active()).toEqual(durable());
    expect(seen).toEqual(["flight-line:new-client-secret", "ap:old-client-secret"]);
    expect(engine.status().state).toBe("idle");
  });

  it("keeps all later writes blocked when the root helper cannot roll back", async () => {
    const state = coordinator();
    state.failRollback(new Error("helper unavailable"));
    const engine = new ApplyEngine({
      configPath: "/unused/config.yaml",
      journalPath: "/unused/apply.json",
      stateCoordinator: state.api,
      renderers: [{ name: "network", async render() { throw new Error("radio failed"); } }],
    });

    await expect(engine.apply(clientConfig(), { secretPatch: { wifi_psk: "new-client-secret" } }))
      .rejects.toThrow("radio failed");
    expect(engine.status().state).toBe("reverting");
    await expect(engine.apply(DEFAULT_CONFIG)).rejects.toThrow(/previous configuration is being put back/);
  });

  it("restores the old config and secret generation when confirmation expires", async () => {
    const state = coordinator();
    const time = clock();
    const engine = new ApplyEngine({
      configPath: "/unused/config.yaml", journalPath: "/unused/apply.json",
      stateCoordinator: state.api, clock: time.value, timeoutMs: 10, radioTimeoutMs: 10,
      renderers: [{ name: "network", async render() {} }],
    });
    await engine.apply(clientConfig(), { secretPatch: { wifi_psk: "new-client-secret" } });
    time.advance(11);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(state.active()).toEqual(durable());
    expect(engine.status().lastResult?.outcome).toBe("reverted");
  });

  it("reloads the old generation after restart recovery of a pending apply", async () => {
    const state = coordinator();
    const first = new ApplyEngine({
      configPath: "/unused/config.yaml", journalPath: "/unused/apply.json",
      stateCoordinator: state.api, renderers: [{ name: "network", async render() {} }],
    });
    await first.apply(clientConfig(), { secretPatch: { wifi_psk: "new-client-secret" } });
    expect(state.active().secrets.wifi_psk).toBe("new-client-secret");
    const refresh = vi.fn();
    const restarted = new ApplyEngine({
      configPath: "/unused/config.yaml", journalPath: "/unused/apply.json",
      stateCoordinator: state.api, refreshSecrets: refresh, renderers: [],
    });
    await restarted.recover();
    expect(state.active()).toEqual(durable());
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("commits a credential-only patch without running hardware renderers", async () => {
    const state = coordinator();
    const render = vi.fn(async () => {});
    const engine = new ApplyEngine({
      configPath: "/unused/config.yaml", journalPath: "/unused/apply.json",
      stateCoordinator: state.api, renderers: [{ name: "hardware", render }],
    });
    const result = await engine.apply(DEFAULT_CONFIG, {
      secretOnly: true,
      secretPatch: { admin_password: "new-password-hash" },
    });
    expect(result.expiresAt).toBeNull();
    expect(state.active().secrets.admin_password).toBe("new-password-hash");
    expect(render).not.toHaveBeenCalled();
  });

  it("retries the same terminal operation id after a lost commit response", async () => {
    const state = coordinator();
    state.failNextCommit(new Error("response lost"));
    const engine = new ApplyEngine({
      configPath: "/unused/config.yaml", journalPath: "/unused/apply.json",
      stateCoordinator: state.api, renderers: [{ name: "network", async render() {} }],
    });
    const applied = await engine.apply(clientConfig());
    await engine.confirm(applied.id);
    expect(state.calls.filter(call => call === "commit")).toHaveLength(2);
    expect(engine.status().state).toBe("confirmed");
  });

  it("reloads credential readers after the helper projects a new secret generation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yonder-state-credential-"));
    try {
      const path = join(dir, "secrets.yaml");
      const oldPassword = "the old password";
      const newPassword = "the new password";
      const initial = durable();
      initial.secrets = { ...initial.secrets, [ADMIN_PASSWORD_SECRET]: hashPassword(oldPassword) };
      const project = (state: DurableState) => writeFileSync(path, stringify(state.secrets), { mode: 0o600 });
      project(initial);
      const store = new SecretStore(path);
      const credential = new AdminCredential(store);
      const state = coordinator(initial, project);
      const engine = new ApplyEngine({
        configPath: "/unused/config.yaml", journalPath: "/unused/apply.json",
        stateCoordinator: state.api, refreshSecrets: () => store.reload(), renderers: [],
      });
      await engine.apply(DEFAULT_CONFIG, {
        secretOnly: true,
        secretPatch: { [ADMIN_PASSWORD_SECRET]: hashPassword(newPassword) },
      });
      expect(credential.verify(newPassword)).toBe(true);
      expect(credential.verify(oldPassword)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
