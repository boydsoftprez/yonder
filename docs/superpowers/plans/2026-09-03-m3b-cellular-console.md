# M3b Cellular Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The operator can see what the modem is doing, see which way out is carrying
traffic, and fix a wrong APN from the console rather than over `ssh`.

**Architecture:** One new contrib package of thin adapters over two existing daemon routes
and two new ones, rendered with the instruments the console already has. The only change to
the shared instrument library is teaching `reading()` — and therefore every instrument —
which direction of a quantity is the bad one.

**Tech Stack:** TypeScript, Node-RED Dashboard 2.x, Vue 3 SFCs, vitest, Playwright for the
capture gate.

**Spec:** [2026-09-03-cellular-console-design.md](../specs/2026-09-03-cellular-console-design.md).
Every decision is settled there; this is how it gets built.

## Global Constraints

- **Logic never goes in a Node-RED `function` node** (rule 2). `flows/flows.json` is wiring
  only, and `packages/yonder-core/src/flows.test.ts` asserts it against the artefact.
  Anything needing a decision goes in `yonder-core` or a contrib package.
- **Presentation is Vue components in `node-red-dashboard-2-yonder`**, never markup pasted
  into a `ui-template`.
- **Every change traces to a requirement ID** (rule 3), added to `docs/requirements.md` in
  the same commit that implements it.
- **Commits are GPG-signed.** `git commit -s`. Never `--no-gpg-sign`; if signing fails,
  stop and report it.
- **No credential in a log line, an error message or an API response** (R-SEC-10).
- **Nothing may make the device unreachable** (rule 6).
- Every source file starts with `// SPDX-License-Identifier: GPL-3.0-or-later`.
- `npm test` at the repo root runs every workspace; `npx vitest run <path>` runs one file;
  `npm run lint` type-checks every package.

## What already exists

- `GET /modem/state` → `ModemState` and `GET /reach/state` → `ReachState`, both served and
  correct. Types exported from `yonder-core`.
- `packages/node-red-contrib-yonder-remote/` — the worked example of this package shape:
  `state.ts` (polls, formats, emits), `format.ts` (pure), `join.ts`/`leave.ts` (actions),
  `red.ts` (the six-member slice of Node-RED's API), one `.html` per node.
- `yonder-core` exports `clientFor`, `fetched`, `readFailure` for talking to the socket.
- `packages/yonder-core/src/console/reading.ts` — `reading(value, bounds)`, the one place
  that decides which band a value is in. Every instrument imports it.
- `packages/node-red-dashboard-2-yonder/src/` — `gauge`, `databar`, `annunciator`,
  `softkeys`, `sparkline`, `tape`, each a node plus a `ui/Yonder*.vue`.
- `scripts/capture-pages.mjs` — the R-UI-12 gate. It already walks a tabbed page tab by tab.

## File Structure

**Create**

| Path | Responsibility |
|---|---|
| `packages/node-red-contrib-yonder-modem/package.json` | Package manifest, node registrations |
| `packages/node-red-contrib-yonder-modem/tsconfig.json` | Build config |
| `packages/node-red-contrib-yonder-modem/vitest.config.ts` | Test config |
| `.../src/red.ts` | The Node-RED API slice, copied from the remote package |
| `.../src/format.ts` | Pure: units, phrases, gauge bounds for signal |
| `.../src/state.ts` | Polls both routes, emits one payload per surface |
| `.../src/configure.ts` | `POST /modem/configure` |
| `.../src/test.ts` | `POST /reach/test` |
| `.../src/*.html` | One editor pane per node |

**Modify**

| Path | Change |
|---|---|
| `packages/yonder-core/src/console/reading.ts` | `ReadingBounds.sense` |
| `packages/node-red-dashboard-2-yonder/src/gauge.ts` | Pass `sense` through |
| `packages/node-red-dashboard-2-yonder/src/ui/YonderGauge.vue` | Draw the bands in the right order |
| `packages/yonder-core/src/daemon/routes.ts` | Two routes |
| `packages/yonder-core/src/daemon/server.ts` | Wire them |
| `flows/flows.json` | Cellular tab, Way out, three Status changes — wiring only |
| `docs/requirements.md` | R-UI-15, R-UI-16, R-CEL-12; R-UI-09 gains a sentence |
| `docs/console/capture/`, `docs/console/shape/` | Five new shapes |

---

## Task 1: `reading()` learns which direction is bad

**Files:**
- Modify: `packages/yonder-core/src/console/reading.ts`
- Test: `packages/yonder-core/src/console/reading.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ReadingBounds` gains `sense?: "higher-is-worse" | "higher-is-better"`,
  defaulting to `"higher-is-worse"`. `Reading` carries `sense` through so a component can
  draw the bands in the right order. Tasks 2 and 4 depend on both names.

**Why here and not in the component.** `reading()` is imported by every instrument and by
`yonder-core`'s own tests, and its comment says why: a threshold means the same on a
component, in a node, and anywhere else it is asked. A component that decided its own bands
would be a second rule.

- [ ] **Step 1: Write the failing tests**

Append to `packages/yonder-core/src/console/reading.test.ts`:

```ts
describe("a quantity where higher is better", () => {
  // Signal strength, in dBm. -120 is the floor of the scale, -70 the top;
  // below -105 is bad and below -90 is marginal. These are the values the
  // cellular console uses.
  const SIGNAL = { min: -120, max: -70, caution: -90, limit: -105, sense: "higher-is-better" } as const;

  it("is good above the caution", () => {
    expect(reading(-85, SIGNAL).tone).toBe("good");
  });

  it("is waiting at and below the caution", () => {
    // At, not past: a threshold an operator was told about announces itself
    // when it is reached, which is the same rule the other direction uses.
    expect(reading(-90, SIGNAL).tone).toBe("waiting");
    expect(reading(-99, SIGNAL).tone).toBe("waiting");
  });

  it("is bad at and below the limit", () => {
    expect(reading(-105, SIGNAL).tone).toBe("bad");
    expect(reading(-118, SIGNAL).tone).toBe("bad");
  });

  it("fills more as the value rises, not less", () => {
    // The fill is the value's position on its own scale and does not change
    // with the sense. A stronger signal must draw a fuller bar; the sense
    // decides which end is alarming, not which way the bar grows.
    expect(reading(-75, SIGNAL).fraction).toBeGreaterThan(reading(-110, SIGNAL).fraction);
  });

  it("puts the thresholds where they are on the scale, whichever sense applies", () => {
    const r = reading(-99, SIGNAL);
    expect(r.limitAt).toBeCloseTo(0.30, 2);
    expect(r.cautionAt).toBeCloseTo(0.60, 2);
  });

  it("carries the sense through so a component can draw it", () => {
    expect(reading(-99, SIGNAL).sense).toBe("higher-is-better");
  });
});

describe("the default sense", () => {
  it("is higher-is-worse, so every existing caller is unchanged", () => {
    // CPU temperature: 80 is the throttle point, 60 the caution.
    const TEMP = { min: 0, max: 100, caution: 60, limit: 80 };
    expect(reading(51, TEMP).tone).toBe("good");
    expect(reading(65, TEMP).tone).toBe("waiting");
    expect(reading(85, TEMP).tone).toBe("bad");
    expect(reading(51, TEMP).sense).toBe("higher-is-worse");
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run packages/yonder-core/src/console/reading.test.ts`
Expected: FAIL — `sense` is not a property of `ReadingBounds`, and `tone()` judges
`-85` against `limit: -105` as `bad` because it only compares upwards.

- [ ] **Step 3: Add the sense**

In `packages/yonder-core/src/console/reading.ts`, add to `ReadingBounds`:

```ts
  /**
   * Which direction of this quantity is the bad one.
   *
   * `higher-is-worse` is the default and is right for everything this console
   * drew first: temperature, load, memory, disk. Signal is the other kind —
   * -70 dBm is a strong link and -110 is a dying one — and so are battery
   * charge, link margin and throughput headroom.
   *
   * It is stated rather than inferred. A guess from the order of `caution`
   * and `limit` would be right most of the time and silently wrong for a
   * quantity configured with only one of them, and being silently wrong about
   * which end is alarming is the whole failure this exists to prevent
   * (R-UI-09).
   */
  sense?: "higher-is-worse" | "higher-is-better";
```

Add `sense` to `Reading` (it extends `ReadingBounds`, so it is carried automatically — but
`reading()` must return it explicitly, since it builds its result field by field).

Replace `tone()`:

```ts
function tone(value: number, bounds: ReadingBounds): ReadingTone {
  if (bounds.caution === undefined && bounds.limit === undefined) return "neutral";
  // At, not past, in both directions: a threshold an operator was told about
  // announces itself when it is reached, not one sample later.
  const past = (threshold: number) =>
    bounds.sense === "higher-is-better" ? value <= threshold : value >= threshold;
  if (bounds.limit !== undefined && past(bounds.limit)) return "bad";
  if (bounds.caution !== undefined && past(bounds.caution)) return "waiting";
  return "good";
}
```

and in `reading()`, add `sense: bounds.sense ?? "higher-is-worse",` to both returned
objects — the non-finite early return as well as the normal one, so a component never has
to handle an absent sense.

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run packages/yonder-core/src/console/reading.test.ts`
Expected: PASS, including every pre-existing test in that file unchanged.

- [ ] **Step 5: Extend R-UI-09**

In `docs/requirements.md`, R-UI-09 currently ends `A bare number for such a value is not a
reading`. Append to that same cell, before the closing `|`:

```
. **Which direction of the quantity is the bad one is stated, not assumed**: an instrument that assumes one direction draws a higher-is-better quantity backwards — a full bar for a dying link — and signal is named above
```

The ID does not change and nothing is renumbered.

- [ ] **Step 6: Commit**

```bash
npm test
git add packages/yonder-core/src/console/reading.ts packages/yonder-core/src/console/reading.test.ts docs/requirements.md
git commit -s -m "feat(console): a reading knows which direction is bad — R-UI-09"
```

---

## Task 2: The gauge draws both senses

**Files:**
- Modify: `packages/node-red-dashboard-2-yonder/src/gauge.ts`
- Modify: `packages/node-red-dashboard-2-yonder/src/ui/YonderGauge.vue`
- Test: `packages/node-red-dashboard-2-yonder/src/nodes.test.ts`

**Interfaces:**
- Consumes: `reading()` and `ReadingBounds.sense` (Task 1).
- Produces: the `ui-yonder-gauge` node accepts a `sense` config property, defaulting to
  `"higher-is-worse"`. Task 7 and Task 9 configure gauges with `sense: "higher-is-better"`.

- [ ] **Step 1: Write the failing test**

Append to `packages/node-red-dashboard-2-yonder/src/nodes.test.ts`, following that file's
existing pattern for asserting a node's resolved props:

```ts
it("passes the gauge a sense, defaulting to higher-is-worse", () => {
  // Everything already drawn by this instrument — temperature, load, memory —
  // is higher-is-worse, so an omitted sense must keep behaving exactly as it
  // did before this property existed.
  expect(gaugeProps({ label: "CPU TEMP", max: 100, caution: 60, limit: 80 }).sense)
    .toBe("higher-is-worse");
  expect(gaugeProps({ label: "SIGNAL", min: -120, max: -70, caution: -90, limit: -105, sense: "higher-is-better" }).sense)
    .toBe("higher-is-better");
});

it("refuses a sense it does not have, rather than drawing an arbitrary one", () => {
  // A typo in a flow must not silently pick a direction. Falling back to the
  // default is the safe answer only because the default is the common case;
  // it is still logged so the flow can be fixed.
  expect(gaugeProps({ label: "X", max: 100, sense: "sideways" }).sense).toBe("higher-is-worse");
});
```

> `gaugeProps(...)` is a helper you add to that file if one does not already exist: it
> calls the gauge node's `props` function with a fake node and the given config and returns
> the result. Match how the file's existing tests reach a node's props rather than
> inventing a second way.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run packages/node-red-dashboard-2-yonder/src/nodes.test.ts`
Expected: FAIL — `sense` is `undefined`.

- [ ] **Step 3: Pass it through the node**

In `packages/node-red-dashboard-2-yonder/src/gauge.ts`, inside the `props` object beside
`caution` and `limit`:

```ts
      // Named in the flow, never guessed. See ReadingBounds.sense.
      sense: config.sense === "higher-is-better" ? "higher-is-better" : "higher-is-worse",
```

- [ ] **Step 4: Draw the bands in the right order**

In `packages/node-red-dashboard-2-yonder/src/ui/YonderGauge.vue`, replace the three band
elements with an order that follows the sense. `r.sense` comes from `reading()`:

```html
<span class="y-gauge__bands" aria-hidden="true">
    <template v-if="r.sense === 'higher-is-better'">
        <i v-if="r.limitAt !== undefined" class="band bad" :style="bandStyle(0, r.limitAt)" />
        <i v-if="r.cautionAt !== undefined" class="band waiting"
           :style="bandStyle(r.limitAt ?? 0, r.cautionAt)" />
        <i class="band good" :style="bandStyle(r.cautionAt ?? r.limitAt ?? 0, 1)" />
    </template>
    <template v-else>
        <i class="band good" :style="bandStyle(0, r.cautionAt ?? r.limitAt ?? 1)" />
        <i v-if="r.cautionAt !== undefined" class="band waiting"
           :style="bandStyle(r.cautionAt, r.limitAt ?? 1)" />
        <i v-if="r.limitAt !== undefined" class="band bad" :style="bandStyle(r.limitAt, 1)" />
    </template>
</span>
```

Leave `y-gauge__fill`, `y-gauge__ptr` and `y-gauge__redline` alone. The fill is the value's
position on its own scale and does not change with the sense — a stronger signal draws a
fuller bar.

- [ ] **Step 5: Run the suite and the type-check**

Run: `npm test && npm run lint`
Expected: PASS, with every pre-existing gauge test unchanged.

- [ ] **Step 6: Commit**

```bash
git add packages/node-red-dashboard-2-yonder/
git commit -s -m "feat(console): the gauge draws a higher-is-better quantity the right way up — R-UI-09"
```

---

## Task 3: The two daemon routes

**Files:**
- Modify: `packages/yonder-core/src/daemon/routes.ts`
- Modify: `packages/yonder-core/src/daemon/server.ts`
- Test: `packages/yonder-core/src/daemon/routes.test.ts`, `.../server.wiring.test.ts`

**Interfaces:**
- Consumes: `ReachMonitor` and `Standing` from `net/reach/`, `loadConfig`, the apply engine.
- Produces: `POST /modem/configure` and `POST /reach/test`. `RouterDeps` gains
  `testPath?: (path: PathName) => Promise<boolean>`. Tasks 6 and 7 call both routes.

- [ ] **Step 1: Write the failing tests**

Append to `packages/yonder-core/src/daemon/routes.test.ts`:

```ts
describe("POST /modem/configure", () => {
  it("merges the fields into the configuration and applies the whole document", async () => {
    // The same shape /net/join and /remote/join use: the router merges one
    // section and hands the engine a complete document. Nothing about a modem
    // is stored anywhere else.
    const route = provisioned({});
    const res = await route("POST", "/modem/configure", { enabled: true, apn: "ereseller" });
    expect(res.status).toBe(200);
    const config = (await route("GET", "/config", undefined)).body as Config;
    expect(config.network.modem.enabled).toBe(true);
    expect(config.network.modem.apn).toBe("ereseller");
  });

  it("leaves the rest of the configuration alone", async () => {
    const route = provisioned({});
    const before = (await route("GET", "/config", undefined)).body as Config;
    await route("POST", "/modem/configure", { enabled: true, apn: "ereseller" });
    const after = (await route("GET", "/config", undefined)).body as Config;
    expect(after.network.ap).toEqual(before.network.ap);
    expect(after.network.client).toEqual(before.network.client);
  });

  it("refuses a body that is not a modem configuration", async () => {
    const res = await provisioned({})("POST", "/modem/configure", { apn: 42 });
    expect(res.status).toBe(400);
  });

  it("never returns the modem password", async () => {
    // R-SEC-10. The response is an apply status, not a configuration.
    const res = await provisioned({})("POST", "/modem/configure", { enabled: true, apn: "a", password: "hunter2" });
    expect(JSON.stringify(res.body)).not.toMatch(/hunter2/);
  });
});

describe("POST /reach/test", () => {
  it("tests the path it is given and answers with the result", async () => {
    const asked: string[] = [];
    const route = provisioned({ testPath: async (p) => { asked.push(p); return true; } });
    const res = await route("POST", "/reach/test", { path: "modem" });
    expect(res.status).toBe(200);
    expect(asked).toEqual(["modem"]);
    expect((res.body as { reached: boolean }).reached).toBe(true);
  });

  it("refuses a path that is not one of the three", async () => {
    const res = await provisioned({ testPath: async () => true })("POST", "/reach/test", { path: "carrier-pigeon" });
    expect(res.status).toBe(400);
  });

  it("says so plainly when this daemon has no reach monitor to ask", async () => {
    const res = await provisioned({})("POST", "/reach/test", { path: "modem" });
    expect(res.status).toBe(503);
  });
});
```

> `provisioned(...)` already exists in that file — it builds a router behind a set
> administrator password. Reuse it.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run packages/yonder-core/src/daemon/routes.test.ts`
Expected: FAIL — both paths fall through to the 404.

- [ ] **Step 3: Add the routes**

In `routes.ts`, add to `RouterDeps`:

```ts
  /**
   * Test one path now and answer when the result is known.
   *
   * R-CEL-09's "on request". Injected, so this router still knows no probe —
   * and wired to the same ReachMonitor the automatic probes use, so a test an
   * operator asked for and one the device ran itself are the same evidence.
   */
  testPath?: (path: PathName) => Promise<boolean>;
```

and beside the `/remote/join` handler:

```ts
      if (method === "POST" && path === "/modem/configure") {
        const wanted = ModemRequest.safeParse(body);
        if (!wanted.success) {
          return { status: 400, body: { error: "that is not a modem configuration" } };
        }
        const config = loadConfig(deps.configPath);
        return {
          status: 200,
          body: await deps.engine.apply({
            ...config,
            network: { ...config.network, modem: { ...config.network.modem, ...wanted.data } },
          }),
        };
      }

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
```

Define `ModemRequest` beside the other request schemas in that file, as a `.partial()` of
the schema's own modem object so the two cannot drift:

```ts
/**
 * What a form may send. A partial of the schema's own section rather than a
 * second list of fields: a key added to the configuration is then accepted
 * here without anybody remembering to add it twice.
 */
const ModemRequest = ConfigSchema.shape.network.shape.modem.partial();
```

- [ ] **Step 4: Wire `testPath` in `server.ts`**

Where `createRouter` is called, beside `reachState`:

```ts
    testPath: async (path) => monitor.test(path),
```

- [ ] **Step 5: Add wiring coverage**

Append to `packages/yonder-core/src/daemon/server.wiring.test.ts`, in that file's idiom of
driving a real `startServer` over its socket: assert that `POST /reach/test` with
`{ path: "modem" }` causes the injected probe to be called for the modem's device, and that
the answer comes back in the response body. This file exists because daemon-side wiring was
once deleted with the suite still green.

- [ ] **Step 6: Run everything and commit**

```bash
npm test && npm run lint
git add packages/yonder-core/src/daemon/
git commit -s -m "feat(daemon): configure the modem and test a path on request — R-CEL-09, R-CEL-12"
```

---

## Task 4: The package, and what it decides

**Files:**
- Create: `packages/node-red-contrib-yonder-modem/{package.json,tsconfig.json,vitest.config.ts}`
- Create: `packages/node-red-contrib-yonder-modem/src/{red.ts,format.ts}`
- Test: `packages/node-red-contrib-yonder-modem/src/format.test.ts`
- Modify: root `package.json` build and lint scripts

**Interfaces:**
- Consumes: `ModemState`, `ReachState`, `SignalReading` from `yonder-core`.
- Produces: from `format.ts` —
  `SIGNAL_BOUNDS` and `QUALITY_BOUNDS` (`ReadingBounds` with `sense: "higher-is-better"`),
  `formatDbm(n: number | null): string`, `formatDb(n: number | null): string`,
  `verdict(reach: ReachState): { text: string; tone: "good" | "bad" | "neutral" }`,
  `pathDetail(p: PathReport): string`. Task 5 imports all of them.

**Why the bounds live here.** They are a presentation decision — where an operator is told
to start worrying — not a fact about the modem, so they do not belong in the daemon. They
are exported constants rather than numbers typed into a flow, because a threshold typed
into JSON is a threshold nobody can test.

- [ ] **Step 1: Write the failing tests**

`packages/node-red-contrib-yonder-modem/src/format.test.ts`:

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { reading } from "yonder-core";
import { QUALITY_BOUNDS, SIGNAL_BOUNDS, formatDb, formatDbm, verdict } from "./format.js";

describe("the signal bounds", () => {
  it("are the standard cellular thresholds, higher-is-better", () => {
    expect(SIGNAL_BOUNDS.caution).toBe(-90);
    expect(SIGNAL_BOUNDS.limit).toBe(-105);
    expect(SIGNAL_BOUNDS.sense).toBe("higher-is-better");
  });

  it("put a working bench board in the marginal band, which is the truth", () => {
    // The board this was designed against reads -99 to -103 dBm and works.
    // Marginal is the honest answer for a bench with a small antenna, and a
    // calibration that flattered it would make the amber band meaningless.
    expect(reading(-99, SIGNAL_BOUNDS).tone).toBe("waiting");
    expect(reading(-85, SIGNAL_BOUNDS).tone).toBe("good");
    expect(reading(-110, SIGNAL_BOUNDS).tone).toBe("bad");
  });

  it("puts a quality of 16 dB in the good band", () => {
    expect(reading(16, QUALITY_BOUNDS).tone).toBe("good");
    expect(reading(6, QUALITY_BOUNDS).tone).toBe("waiting");
    expect(reading(-2, QUALITY_BOUNDS).tone).toBe("bad");
  });
});

describe("formatting a measurement that may not exist", () => {
  it("says so rather than printing a number that was never taken", () => {
    // 0 dBm is a real and extraordinary reading. Printing it for "unknown"
    // would show a perfect signal on a device that has none.
    expect(formatDbm(null)).toBe("—");
    expect(formatDb(null)).toBe("—");
  });

  it("carries the unit, because a bare number is not a reading", () => {
    expect(formatDbm(-99)).toBe("-99 dBm");
    expect(formatDb(16)).toBe("16 dB");
  });
});

describe("the verdict", () => {
  const path = (over = {}) => ({
    path: "modem" as const, device: "wwan0", standing: "standing-by" as const,
    since: null, detail: "", ...over,
  });

  it("is carrying traffic when the modem is the path in use", () => {
    const v = verdict({ inUse: "modem", carrying: true, paths: [path({ standing: "in-use" })] });
    expect(v.tone).toBe("good");
    expect(v.text).toBe("CARRYING TRAFFIC");
  });

  it("is no data getting through when the modem reached nothing", () => {
    const v = verdict({ inUse: "ethernet", carrying: true, paths: [path({ standing: "no-route-out" })] });
    expect(v.tone).toBe("bad");
    expect(v.text).toBe("NO DATA GETTING THROUGH");
  });

  it("does not claim anything about a path nobody has tested", () => {
    // The distinction the fallback watchdog had to learn, at the display
    // layer: not yet condemned is not the same as working.
    const v = verdict({ inUse: "ethernet", carrying: true, paths: [path({ detail: "untested" })] });
    expect(v.tone).toBe("neutral");
  });

  it("says a modem is absent rather than broken when there is none", () => {
    const v = verdict({ inUse: "ethernet", carrying: true, paths: [] });
    expect(v.tone).toBe("neutral");
    expect(v.text).toBe("NO MODEM");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run packages/node-red-contrib-yonder-modem/src/format.test.ts`
Expected: FAIL — the package does not exist.

- [ ] **Step 3: Create the package**

`package.json`, mirroring `node-red-contrib-yonder-remote` exactly:

```json
{
  "name": "node-red-contrib-yonder-modem",
  "version": "0.1.0",
  "license": "GPL-3.0-or-later",
  "description": "Yonder console nodes for the cellular link: modem and reach state, configure, test. Thin adapters over the yonder-core daemon socket; every decision lives in yonder-core.",
  "keywords": ["node-red", "yonder"],
  "node-red": {
    "version": ">=5.0.0",
    "nodes": {
      "yonder-modem-state": "dist/state.js",
      "yonder-modem-configure": "dist/configure.js",
      "yonder-reach-test": "dist/test.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json && node ../../scripts/copy-node-html.mjs",
    "test": "vitest run"
  },
  "dependencies": { "yonder-core": "^0.1.0" },
  "devDependencies": { "@types/node": "^20.19.43", "typescript": "^5.6.0" },
  "engines": { "node": ">=22.12" }
}
```

Copy `tsconfig.json`, `vitest.config.ts` and `src/red.ts` verbatim from
`packages/node-red-contrib-yonder-remote/`. `red.ts` is the six-member slice of Node-RED's
API and is deliberately duplicated rather than shared — its own comment explains why.

Delete `packages/node-red-contrib-yonder-modem/.gitkeep`.

Add the package to the root `package.json`'s `build` and `lint` scripts, beside the other
contrib packages.

- [ ] **Step 4: Write `format.ts`**

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
import type { ReadingBounds, ReachState, PathReport } from "yonder-core";

/**
 * Where an operator is told to start worrying about signal strength.
 *
 * The standard cellular thresholds, deliberately: a number that looks
 * alarming here has to look alarming in every other tool an operator might
 * check, including a carrier's support desk. A scale tuned to this project
 * would disagree with all of them.
 *
 * The floor and ceiling are the ends of the useful range rather than the ends
 * of what a modem can report — a reading is clamped, so nothing is lost, and
 * a scale running to -140 would spend most of its width on values that mean
 * "no service" either way.
 */
export const SIGNAL_BOUNDS: ReadingBounds = {
  min: -120, max: -70, caution: -90, limit: -105, sense: "higher-is-better",
};

/** SINR, in dB. Above 13 is good; below 0 the link is not usable. */
export const QUALITY_BOUNDS: ReadingBounds = {
  min: -5, max: 25, caution: 13, limit: 0, sense: "higher-is-better",
};

/**
 * A measurement, or a mark saying it was not taken.
 *
 * Never a zero: 0 dBm is a real and extraordinary reading, and printing it
 * for "unknown" would show a perfect signal on a device that has none.
 */
export function formatDbm(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)} dBm`;
}

export function formatDb(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)} dB`;
}

/**
 * The one line at the top of the Cellular tab.
 *
 * Three answers and not two. A path nobody has tested is not claimed to be
 * working — the same distinction the fallback watchdog had to learn, at the
 * display layer (R-CEL-09).
 */
export function verdict(reach: ReachState): { text: string; tone: "good" | "bad" | "neutral" } {
  const modem = reach.paths.find((p) => p.path === "modem");
  if (modem === undefined) return { text: "NO MODEM", tone: "neutral" };
  if (modem.standing === "no-route-out") return { text: "NO DATA GETTING THROUGH", tone: "bad" };
  if (modem.standing === "in-use") return { text: "CARRYING TRAFFIC", tone: "good" };
  if (modem.detail.includes("not yet tested")) return { text: "NOT YET TESTED", tone: "neutral" };
  return { text: "READY", tone: "good" };
}

/** The sentence under a path's name on the Way out panel. Already in Yonder's words. */
export function pathDetail(p: PathReport): string {
  return p.detail;
}
```

> `pathDetail` is a pass-through today and exists so the page never reads a daemon field
> directly: when a state needs different words on the page than in the journal, this is
> where that happens, and no flow changes.

- [ ] **Step 5: Run it and watch it pass**

Run: `npm install && npx vitest run packages/node-red-contrib-yonder-modem/`
Expected: PASS, 9 tests.

- [ ] **Step 6: Commit**

```bash
npm test && npm run lint
git add packages/node-red-contrib-yonder-modem/ package.json package-lock.json
git commit -s -m "feat(modem): the console package, and where an operator is told to worry"
```

---

## Task 5: The state node

**Files:**
- Create: `packages/node-red-contrib-yonder-modem/src/state.ts`, `src/state.html`
- Test: `packages/node-red-contrib-yonder-modem/src/state.test.ts`

**Interfaces:**
- Consumes: `format.ts` (Task 4); `clientFor`, `fetched`, `readFailure`, `ModemState`,
  `ReachState` from `yonder-core`.
- Produces: `messageFor(modem: ModemState, reach: ReachState): { payload: {...} }` and the
  registered node type `yonder-modem-state`, emitting on four outputs: the tab's payload,
  the signal readings, the Way out rows, and the Status summary. Task 7, 8 and 9 wire them.

**Four outputs, not four nodes.** Both routes are read once per tick and fanned out, so
three surfaces cannot disagree about what the modem is doing — which they would if each
polled separately and landed on different ticks.

- [ ] **Step 1: Write the failing test**

`packages/node-red-contrib-yonder-modem/src/state.test.ts`:

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { messageFor } from "./state.js";
import type { ModemState, ReachState } from "yonder-core";

const MODEM: ModemState = {
  mode: "connected", summary: "Connected to Dark Star",
  operator: "Dark Star", technology: "lte", registration: "home",
  apn: "ereseller", address: "10.16.166.223", mtu: 1430,
  signal: { rssi: -71, rsrq: -12, rsrp: -99, snr: 16 },
  ports: ["cdc-wdm0 (mbim)", "wwan0 (net)"], reportsSignal: true,
};

const REACH: ReachState = {
  inUse: "ethernet", carrying: true,
  paths: [
    { path: "ethernet", device: "eth0", standing: "in-use", since: null, detail: "Carrying traffic" },
    { path: "modem", device: "wwan0", standing: "standing-by", since: null, detail: "Ready — traffic is not going out over cellular" },
  ],
};

describe("messageFor", () => {
  it("carries the four signal numbers with their units", () => {
    const p = messageFor(MODEM, REACH).payload;
    expect(p.signal.strength).toBe("-99 dBm");
    expect(p.signal.quality).toBe("16 dB");
    expect(p.signal.rssi).toBe("-71 dBm");
    expect(p.signal.rsrq).toBe("-12 dB");
  });

  it("reports the raw numbers too, because a gauge needs a number", () => {
    const p = messageFor(MODEM, REACH).payload;
    expect(p.gauges.strength).toBe(-99);
    expect(p.gauges.quality).toBe(16);
  });

  it("says an appliance modem cannot report signal, rather than showing none", () => {
    // R-CEL-11. Four dashes read as a fault; "this kind of modem does not
    // report it" does not.
    const p = messageFor({ ...MODEM, reportsSignal: false }, REACH).payload;
    expect(p.reportsSignal).toBe(false);
  });

  it("names every path in the operator's order for the Way out panel", () => {
    const p = messageFor(MODEM, REACH).payload;
    expect(p.paths.map((x) => x.name)).toEqual(["Ethernet", "Cellular"]);
    expect(p.paths[1].detail).toBe("Ready — traffic is not going out over cellular");
  });

  it("gives Status one word for how the device is reachable", () => {
    expect(messageFor(MODEM, REACH).payload.reachableBy).toBe("ETHERNET");
    expect(messageFor(MODEM, { ...REACH, inUse: "modem" }).payload.reachableBy).toBe("CELLULAR");
  });

  it("says so when nothing is carrying traffic at all", () => {
    const p = messageFor(MODEM, { ...REACH, inUse: null, carrying: false }).payload;
    expect(p.reachableBy).toBe("NOTHING");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run packages/node-red-contrib-yonder-modem/src/state.test.ts`
Expected: FAIL — `Cannot find module './state.js'`.

- [ ] **Step 3: Write it**

Follow `packages/node-red-contrib-yonder-remote/src/state.ts` closely: a pure `messageFor`
exported for tests, and a node registration below it that polls on an interval, calls
`messageFor`, sends, and reports a `CommandStatus` on failure through `readFailure`. Poll
both routes with `fetched` and `clientFor`.

The payload's shape is what the tests above assert. `reachableBy` is the in-use path's name
uppercased, or `NOTHING`; the path names are `Ethernet`, `Cellular` and `Wi-Fi` — Yonder's
words, not the configuration's keys.

Write `state.html` following the remote package's, describing the four outputs.

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run packages/node-red-contrib-yonder-modem/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm test && npm run lint
git add packages/node-red-contrib-yonder-modem/
git commit -s -m "feat(modem): one poll, four surfaces, so none of them disagree"
```

---

## Task 6: The two action nodes

**Files:**
- Create: `packages/node-red-contrib-yonder-modem/src/{configure.ts,configure.html,test.ts,test.html}`
- Test: `packages/node-red-contrib-yonder-modem/src/configure.test.ts`

**Interfaces:**
- Consumes: `red.ts`, the daemon client helpers, Task 3's routes.
- Produces: node types `yonder-modem-configure` and `yonder-reach-test`, both emitting a
  `CommandStatus` on `msg.yonder`. Tasks 7 wires them to the softkeys.

- [ ] **Step 1: Write the failing test**

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { modemRequest } from "./configure.js";

describe("modemRequest", () => {
  it("sends only the fields the operator filled in", () => {
    // An empty box is not an instruction to clear a setting. Sending "" for a
    // password an operator did not touch would wipe a working credential.
    expect(modemRequest({ apn: "ereseller", username: "", password: "", dial: "" }))
      .toEqual({ enabled: true, apn: "ereseller" });
  });

  it("enables the modem, because typing an APN is asking for it to be used", () => {
    expect(modemRequest({ apn: "a" }).enabled).toBe(true);
  });

  it("refuses to send nothing at all", () => {
    // A form submitted empty would otherwise apply a document identical to the
    // one already in force, which reports success and changes nothing.
    expect(() => modemRequest({ apn: "" })).toThrow(/needs an APN/i);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run packages/node-red-contrib-yonder-modem/src/configure.test.ts`
Expected: FAIL — no `./configure.js`.

- [ ] **Step 3: Write both nodes**

`configure.ts` exports the pure `modemRequest(fields)` the test asserts, and registers
`yonder-modem-configure`, which POSTs it to `/modem/configure` and puts the returned apply
status on `msg.yonder` — an apply is **pending**, not done, exactly as
`node-red-contrib-yonder-network/src/apply.ts` documents.

`test.ts` registers `yonder-reach-test`, which POSTs `{ path }` to `/reach/test` and emits
the answer. Its node status goes green or red on the result, and grey while in flight.

Write both `.html` panes, following the remote package's.

- [ ] **Step 4: Run and commit**

```bash
npm test && npm run lint
git add packages/node-red-contrib-yonder-modem/
git commit -s -m "feat(modem): a form that applies, and a test you can ask for — R-CEL-12"
```

---

## Task 7: The Cellular tab

**Files:**
- Modify: `flows/flows.json` — **wiring only**
- Test: `packages/yonder-core/src/flows.test.ts`
- Create: `docs/console/capture/network-cellular.{day,night}.png`, `docs/console/shape/network-cellular.{day,night}.darwin.json`

**Interfaces:**
- Consumes: `yonder-modem-state` outputs 1 and 2, `yonder-modem-configure`,
  `yonder-reach-test` (Tasks 5, 6); `ui-yonder-gauge` with `sense` (Task 2).
- Produces: a `Cellular` tab in the Network page's tab strip, between `ZeroTier` and
  `Activity`.

- [ ] **Step 1: Add the groups**

Three `ui-group` nodes on the Network page, `Cellular`, `Signal` and `Connection`, laid out
in two columns — `Cellular` in the left column, `Signal` above `Connection` in the right.
Match the `width` and `order` conventions the existing groups on that page use.

- [ ] **Step 2: Fill them, with no `function` node**

- `Cellular`: a `ui-yonder-annunciator` fed by the verdict, a `ui-template`-free warning row
  fed by the modem's summary, and `ui-yonder-databar` nodes for operator/network/
  registration, address/public, MTU/composition.
- `Signal`: two `ui-yonder-gauge` nodes —
  `{ label: "SIGNAL", unit: "dBm", min: -120, max: -70, caution: -90, limit: -105, sense: "higher-is-better" }`
  and
  `{ label: "QUALITY", unit: "dB", min: -5, max: 25, caution: 13, limit: 0, sense: "higher-is-better" }`
  — plus a databar for RSSI and RSRQ.
- `Connection`: `ui-text-input` nodes for APN, dial number, username and password, and a
  `ui-yonder-softkeys` with `[{label:"TEST NOW",action:"test",tone:"act"},{label:"CONNECT",action:"connect",tone:"warn"}]`.

Wire the softkeys' output to `yonder-reach-test` and `yonder-modem-configure` through core
`switch` and `change` nodes. **No `function` node anywhere** — `flows.test.ts` asserts it
against the artefact and `settings.js` does not enable the type.

- [ ] **Step 3: Run the flows assertion**

Run: `npx vitest run packages/yonder-core/src/flows.test.ts`
Expected: PASS — no `function` node, every node type registered.

- [ ] **Step 4: Capture the tab**

Run: `node scripts/capture-pages.mjs --accept`
Then inspect the two new PNGs by eye before committing them. The script walks a tabbed page
tab by tab already, so the new tab is picked up without changing the script.

- [ ] **Step 5: Commit**

```bash
npm test
git add flows/flows.json docs/console/
git commit -s -m "feat(console): the Cellular tab — R-CEL-09, R-CEL-12, R-UI-09"
```

---

## Task 8: The Way out panel

**Files:**
- Modify: `flows/flows.json`
- Create: `docs/console/capture/network-interfaces.*` (recapture), plus shape references
- Test: `packages/yonder-core/src/flows.test.ts`

**Interfaces:**
- Consumes: `yonder-modem-state` output 3 (Task 5).
- Produces: a `Way out` group on the Interfaces tab.

- [ ] **Step 1: Add the group**

A `Way out` `ui-group` on the Interfaces tab, in the left column, above the existing
`Interfaces` group. One row per path: the name, a `ui-yonder-annunciator` for its standing,
and the detail sentence beneath.

- [ ] **Step 2: Recapture the Interfaces tab in each of its three states**

R-UI-12 requires a surface that hides part of itself to be captured in each part, and the
three path states are three shapes. Drive the daemon's fake to produce each, capture, and
inspect. The defect this guards against is real and was found here before: an interface
name right-aligned inside its own column because it carried a class with
`text-align: right`, visible only when the qualifier beneath it was the wider line.

- [ ] **Step 3: Commit**

```bash
npm test
git add flows/flows.json docs/console/
git commit -s -m "feat(console): every way out, and why each is in the state it is — R-NET-13"
```

---

## Task 9: Status — `REACHABLE BY`, and `APPEARANCE` removed

**Files:**
- Modify: `flows/flows.json`
- Create/replace: `docs/console/capture/status.{day,night}.png` and shape references

**Interfaces:**
- Consumes: `yonder-modem-state` output 4 (Task 5).
- Produces: a `Reachable by` group on Status.

- [ ] **Step 1: Remove `Appearance` and widen `This board`**

Delete the `Appearance` `ui-group` and the `ui-template` markdown node inside it. Set
`This board` to the page's full width, and raise its three gauges' `track` from its present
value to `430`.

- [ ] **Step 2: Add `Reachable by`**

Full width, directly below `This board`. A `ui-yonder-annunciator` for the one-word answer,
a text row for what changed and when, two `ui-yonder-gauge` nodes with the same bounds as
Task 7 but `track: 430` and the labels `SIGNAL` and `QUALITY`, and a `ui-yonder-databar` for
operator, network, address and public address.

The gauges are fed from output 4 and are absent — not empty — when `reportsSignal` is false.
Use the group's `visible` binding rather than sending a null: a gauge with no needle reads
as a fault, and *there is no modem* is not a fault.

- [ ] **Step 3: Capture both states**

Capture Status with a modem and without one. Two shapes, both palettes.

- [ ] **Step 4: Commit**

```bash
npm test
git add flows/flows.json docs/console/
git commit -s -m "feat(console): Status says how the aircraft is reachable, and stops explaining itself"
```

---

## Task 10: Status — `CHANGE PENDING`

**Files:**
- Modify: `flows/flows.json`
- Modify: `docs/requirements.md` — R-UI-15
- Create: `docs/console/capture/status-pending.{day,night}.png` and shapes

**Interfaces:**
- Consumes: the existing `/status` route's `ApplyStatus` (`state`, `expiresAt`), and the
  existing `yonder-confirm` node — which K-30 records as registered and used by nothing.
  **This task closes K-30.**
- Produces: a `Change pending` group on Status, visible only while one is.

- [ ] **Step 1: Add the group**

A `Change pending` `ui-group` at the top of Status, bound to `visible` on
`state === "pending"`. It carries a `ui-yonder-annunciator` in the waiting tone with the
countdown, a line naming what changed, the explanatory sentence, and a
`ui-yonder-softkeys` with `[{label:"CONFIRM",action:"confirm",tone:"warn"},{label:"REVERT NOW",action:"revert",tone:"act"}]`.

`CONFIRM` takes the irreversible tone because confirming is the irreversible act. Reverting
is the safe direction and does not.

The countdown is computed from `expiresAt` in `yonder-core` and sent as text — **not** in a
`function` node.

- [ ] **Step 2: Add R-UI-15**

Copy the R-UI-15 row verbatim from §7 of the spec into `docs/requirements.md` after R-UI-14.

- [ ] **Step 3: Close K-30**

`docs/known-issues.md`: mark K-30 — *`yonder-confirm` is registered and used by nothing* —
closed, naming this commit.

- [ ] **Step 4: Capture the pending state and commit**

```bash
npm test
git add flows/flows.json docs/requirements.md docs/known-issues.md docs/console/
git commit -s -m "feat(console): a change that will revert says so wherever you are — R-UI-15, K-30"
```

---

## Task 11: Status — `IF YOU LOSE THIS CONSOLE`

**Files:**
- Modify: `flows/flows.json`, `packages/yonder-core/src/daemon/routes.ts`
- Modify: `docs/requirements.md` — R-UI-16
- Test: `packages/yonder-core/src/daemon/routes.test.ts`

**Interfaces:**
- Consumes: `SecretStore`, `DEFAULT_AP_PASSPHRASE` from `net/profiles.ts`.
- Produces: `GET /status` gains `wayBackIn: { ssid, address, hostname, passphrase: string | null }`.

**The one rule this task exists to get right.** The passphrase is returned **only while it
is the published default.** ADR-0007 makes that value deliberately public — a per-device one
could only be read from the device you are locked out of — but one the operator has set is
theirs, and returning it would be a credential in an API response (R-SEC-10).

- [ ] **Step 1: Write the failing test**

```ts
describe("the way back in", () => {
  it("names the access point, its address and the hostname", async () => {
    const res = await provisioned({})("GET", "/status", undefined);
    const back = (res.body as { wayBackIn: { ssid: string; address: string; hostname: string } }).wayBackIn;
    expect(back.ssid).toBe("yonder");
    expect(back.address).toBe("192.168.77.1");
    expect(back.hostname).toBe("yonder.local");
  });

  it("gives the passphrase while it is the published default", async () => {
    // ADR-0007: published, documented, the same on every device, and the only
    // thing that makes a locked-out operator's way back in usable.
    const res = await provisioned({})("GET", "/status", undefined);
    expect((res.body as { wayBackIn: { passphrase: string | null } }).wayBackIn.passphrase)
      .toBe("yonder1234");
  });

  it("withholds it once the operator has set their own", async () => {
    // R-SEC-10. Theirs, not ours, and not for an API response.
    const route = provisionedWithApPassphrase("something-they-chose");
    const res = await route("GET", "/status", undefined);
    expect((res.body as { wayBackIn: { passphrase: string | null } }).wayBackIn.passphrase).toBeNull();
    expect(JSON.stringify(res.body)).not.toMatch(/something-they-chose/);
  });
});
```

> Add `provisionedWithApPassphrase(...)` beside the existing helpers in that file: the same
> router, with `ap_psk` seeded to the given value.

- [ ] **Step 2: Run it and watch it fail**

Expected: FAIL — `wayBackIn` is not in the body.

- [ ] **Step 3: Add it to `/status`**

Read `ap_psk` from the secret store and compare it with `DEFAULT_AP_PASSPHRASE`; return the
value when they match and `null` when they do not. Compose `hostname` from
`system.hostname` plus `.local` and `address` from `network.ap.address` without its prefix
length.

- [ ] **Step 4: Add the group and R-UI-16**

A full-width `If you lose this console` group at the bottom of Status, a
`ui-yonder-databar` of `JOIN`, `PASSPHRASE`, `AT`, `OR`, and the explanatory line beneath.
When `passphrase` is null the cell reads `changed — the one you set`.

Copy the R-UI-16 row verbatim from §7 of the spec into `docs/requirements.md`.

- [ ] **Step 5: Capture and commit**

```bash
npm test && npm run lint
git add flows/flows.json packages/yonder-core/src/daemon/ docs/requirements.md docs/console/
git commit -s -m "feat(console): the device says how to get back to it — R-UI-16"
```

---

## Task 12: On the board

**Files:**
- Create: `docs/hardware/verifying-m3b.md`
- Modify: `docs/roadmap.md`

**This is the task no capture proves.** Every screen above is rendered by a headless browser
against a fake daemon. A board, a live SIM and a person are what close the milestone — and
M3a's own board run found four defects that 1039 passing tests did not.

Board: a Raspberry Pi 4 on Debian 13 with an EC25-AF and an active SIM, reached at its
console. The working APN is `ereseller`; `nxtgenphone` is the one that fails.

- [ ] **Step 1: Deploy and open the Cellular tab**

Expected: operator, network, registration, the two gauges with the pointer in the amber band
at about −99 dBm, and the addresses. Compare against the committed capture.

- [ ] **Step 2: Break it from the console**

Type `nxtgenphone` into the APN box and press `CONNECT`. Expected: the change goes pending
with a countdown on Status, the modem re-dials, the link is tested, and the tab says nothing
is getting through — **without touching a terminal.** This is R-CEL-12 and it is the reason
the milestone exists.

- [ ] **Step 3: Fix it from the console**

Type `ereseller`, press `CONNECT`, confirm. Expected: the tab returns to carrying traffic.

- [ ] **Step 4: Press `TEST NOW` on a standing-by path**

Expected: a fresh answer within a few seconds. This is the only way a standing-by path is
re-tested, so it is the only way to confirm the route works at all.

- [ ] **Step 5: Watch the pending banner from another page**

Make a change, navigate to Status, and confirm the countdown is there and the change can be
confirmed from it. Then make one and let it expire, and confirm the banner goes.

- [ ] **Step 6: Check the way back in, both ways**

With the published passphrase, the panel shows it. Change the access-point passphrase and
confirm the panel says it has been changed and does not print it — then grep the journal and
the response body for the value you set.

- [ ] **Step 7: Write it up**

Record every step's real output in `docs/hardware/verifying-m3b.md`, in the shape
`docs/hardware/verifying-m1a.md` uses. Update `docs/roadmap.md` with what was seen on
hardware and what was not — **and say plainly that the appliance modem path has still never
been exercised**, because no such modem exists on this bench.

- [ ] **Step 8: Commit**

```bash
git add docs/hardware/verifying-m3b.md docs/roadmap.md
git commit -s -m "docs(hardware): M3b on a board, fixing a wrong APN without a terminal"
```

---

## Self-review

**Spec coverage.**

| Spec section | Task |
|---|---|
| §1 the two missing routes | 3 |
| §2 built from existing instruments | 4, 5, 7 |
| §2 the gauge learns both senses | 1, 2 |
| §2 the bands | 4 |
| §3 the Cellular tab, two columns | 7 |
| §3 no APN suggested | 4, 6 (nothing offers a list) |
| §4 Way out, three states | 5, 8 |
| §4 the Interfaces address column | already built on this branch; Task 8 leaves it alone |
| §5 `REACHABLE BY`, degrades without a modem | 9 |
| §5 `CHANGE PENDING` | 10 |
| §5 `IF YOU LOSE THIS CONSOLE` | 11 |
| §5 `APPEARANCE` removed, `THIS BOARD` widened | 9 |
| §6 the daemon's two routes | 3 |
| §7 R-UI-15, R-UI-16, R-CEL-12, R-UI-09's sentence | 10, 11, 3, 1 |
| §8 shape of the code | File Structure |
| §9 five shapes captured | 7, 8, 9, 10 |

**Placeholders:** none. Task 7's and 8's flow work is described by node type and exact
configuration rather than by pasted JSON, because `flows.json` is a 1,800-line artefact
whose wire coordinates are not reviewable — which is the whole of rule 2.

**Type consistency:** `sense` is the same string union in `ReadingBounds` (Task 1), the
gauge node's props (Task 2) and `SIGNAL_BOUNDS`/`QUALITY_BOUNDS` (Task 4). `PathName` is the
daemon's, unchanged. `messageFor` (Task 5) returns `payload.gauges.{strength,quality}` as
numbers and `payload.signal.*` as strings — deliberately both, because a gauge needs a
number and a databar needs a formatted string, and computing either in a flow would need a
`function` node.

**Two gaps found while reviewing, and closed:**

- **R-CEL-12 had no task that proved it.** The requirement is that the surface reporting a
  fault can repair it; Tasks 3 and 6 build the parts, but only Task 12 Step 2 demonstrates
  it end to end without a terminal. That step is now written as the milestone's reason for
  existing rather than as one check among several.
- **K-30 was going to be closed by accident.** `yonder-confirm` is registered and used by
  nothing, and Task 10 is the first thing that uses it. Closing it silently would lose the
  fact that the pending banner is what that node was always for, so Task 10 closes it
  explicitly.
