// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { ensureStartupSecrets, prepareRequiredSecrets } from "./server.js";
import { ApplyEngine } from "../apply/engine.js";
import { ConfigSchema, DEFAULT_CONFIG } from "../schema/config.js";
import { MEDIA_OBSERVER_SECRET } from "../media/config.js";
import type { DurableState, StateCoordinator, StateTransaction } from "../state/types.js";

function harness(initial: DurableState) {
  let state = structuredClone(initial);
  let generation = "g1";
  const calls: string[] = [];
  const coordinator: StateCoordinator = {
    async status() { return { activeGeneration: generation, operation: null }; },
    async beginSnapshot() {
      calls.push("snapshot");
      return {
        snapshot: { generation, state: structuredClone(state) },
        async release() { calls.push("release"); },
      };
    },
    async begin({ id, expectedActiveGeneration }) {
      calls.push(`begin:${expectedActiveGeneration}`);
      const previous = { generation, state: structuredClone(state) };
      let next: DurableState | undefined;
      const tx: StateTransaction = {
        id, previous,
        async stage(value) { calls.push("stage"); next = structuredClone(value); return { generation: "g2" }; },
        async activate() { calls.push("activate"); state = structuredClone(next!); return { generation: "g2" }; },
        async holdForConfirmation() { calls.push("hold"); },
        async commit() { calls.push("commit"); generation = "g2"; return { generation }; },
        async rollback(reason) { calls.push(`rollback:${reason}`); state = previous.state; return { generation: previous.generation }; },
      };
      return tx;
    },
    async recover() { return { selectedGeneration: generation, action: "none" }; },
  };
  return { coordinator, calls, state: () => structuredClone(state) };
}

function initial(): DurableState {
  return { config: structuredClone(DEFAULT_CONFIG), secrets: {}, linuxOwner: null, zeroTier: null };
}

function withCamera() {
  return ConfigSchema.parse({
    version: 1,
    network: { ap: { psk: { secret: "ap_psk" } } },
    ui: { editor: {} },
    cameras: [{
      id: "cam0", name: "Nose", source: "usb", device: "platform-camera",
      outputs: [{ kind: "rtsp", password: { secret: "rtsp_password" } }],
    }],
  });
}

describe("durable startup credentials", () => {
  it("publishes all credentials required by the current camera configuration in one generation", async () => {
    const value = initial();
    value.config = withCamera();
    const h = harness(value);
    const generated = await ensureStartupSecrets(h.coordinator, true);
    expect(generated.sort()).toEqual([MEDIA_OBSERVER_SECRET, "ap_psk", "rtsp_password"].sort());
    expect(Object.keys(h.state().secrets).sort()).toEqual(generated.sort());
    expect(h.calls).toEqual(["snapshot", "release", "begin:g1", "stage", "activate", "commit"]);
  });

  it("does not open a write transaction when the selected generation is complete", async () => {
    const value = initial();
    value.secrets = { ap_psk: "operator-value" };
    const h = harness(value);
    expect(await ensureStartupSecrets(h.coordinator, true)).toEqual([]);
    expect(h.calls).toEqual(["snapshot", "release"]);
    expect(h.state().secrets.ap_psk).toBe("operator-value");
  });

  it("adds first-camera credentials to the same generation before rendering", async () => {
    const h = harness({ ...initial(), secrets: { ap_psk: "operator-value" } });
    const next = withCamera();
    let renderedSecret: string | undefined;
    const engine = new ApplyEngine({
      configPath: "/unused/config.yaml", journalPath: "/unused/apply.json",
      stateCoordinator: h.coordinator,
      prepareState: state => prepareRequiredSecrets(state, true).state,
      renderers: [{ name: "media", async render() { renderedSecret = h.state().secrets.rtsp_password; } }],
    });
    const result = await engine.apply(next);
    expect(renderedSecret).toBeTruthy();
    await engine.confirm(result.id);
    expect(h.state().secrets.rtsp_password).toBe(renderedSecret);
  });
});
