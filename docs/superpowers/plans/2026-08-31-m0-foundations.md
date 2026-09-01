# M0 Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the configuration layer Yonder stands on — a validated declarative config, a secrets store, an apply/rollback daemon that can recover a device from a bad change, and an installer that can lay all of it down on a bare board.

**Architecture:** `yonder-core` is a **standalone daemon** that owns `/etc/yonder/config.yaml` and is the only writer of derived system configuration. It exposes a Unix-socket HTTP API. Everything else — the Node-RED console, the CLI — is a client. It is separate from the Node-RED process on purpose: it holds the rollback countdown, and a countdown that dies with the process that made the bad change cannot roll anything back. Config shape is defined once in Zod; TypeScript types are inferred and JSON Schema is generated. The installer is dependency-free POSIX shell, because it must run in a chroot before Node exists.

**Tech Stack:** Node 20+ · TypeScript · Zod (schema) · `yaml` (parser) · `vitest` (tests) · POSIX `sh` (installer) · GitHub Actions (CI)

## Global Constraints

- **Licence:** GPL-3.0. Every source file carries an SPDX header: `// SPDX-License-Identifier: GPL-3.0-or-later`
- **Commits:** GPG-signed and DCO signed-off. Always `git commit -s`. Never `--no-gpg-sign`.
- **Node:** 20.x minimum (Debian trixie ships 20 via nodesource). Do not use APIs newer than Node 20.
- **Requirements:** every task cites the `R-*` IDs it satisfies. Requirements live in `docs/requirements.md`.
- **This repository is self-contained.** No references to paths outside it; no comparisons to other products; state what Yonder does, positively. See `CLAUDE.md`.
- **Paths:** config `/etc/yonder/config.yaml`, secrets `/etc/yonder/secrets.yaml` (mode `0600`), state `/var/lib/yonder/`, socket `/run/yonder/core.sock`.
- **No placeholder secrets.** No default password, key or token may appear in any source file or committed fixture.
- **Package naming:** `yonder-core` is a plain library/daemon package. Node-RED packages are unscoped `node-red-contrib-yonder-*` (none in M0).

---

## File Structure

```
packages/yonder-core/
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── src/
    ├── index.ts              barrel export
    ├── schema/
    │   ├── config.ts         Zod schema — the single source of truth for config shape
    │   └── generate.ts       CLI: emit JSON Schema from the Zod schema
    ├── config/
    │   ├── load.ts           read + parse + validate config.yaml
    │   ├── save.ts           atomic write (temp file + rename)
    │   └── errors.ts         ConfigError types with human-readable messages
    ├── secrets/
    │   ├── store.ts          read/write secrets.yaml, 0600 enforcement
    │   └── generate.ts       cryptographically random secret generation
    ├── apply/
    │   ├── engine.ts         the apply/rollback state machine
    │   ├── journal.ts        durable record of in-flight applies
    │   └── types.ts          ApplyState, ApplyResult, Renderer interface
    └── daemon/
        ├── server.ts         Unix-socket HTTP API
        └── routes.ts         route handlers

config/schema/yonder.schema.json    generated, committed
installer/
├── install.sh                orchestrator
├── lib/common.sh             logging, idempotency helpers
└── roles/
    ├── 10-base.sh
    └── 20-yonder-core.sh
systemd/yonder-core.service
.github/workflows/ci.yml
```

**Responsibility boundaries.** `schema/` knows shape and nothing else. `config/` does file I/O and knows nothing about applying. `apply/` orchestrates and knows nothing about *what* is being rendered — renderers are injected, so M1's network renderer plugs in without touching the engine. `daemon/` is transport only. This split is what lets M1 add a renderer without reopening M0's code.

---

## Task 1: Package scaffold and CI

**Files:**
- Create: `packages/yonder-core/package.json`, `packages/yonder-core/tsconfig.json`, `packages/yonder-core/vitest.config.ts`, `packages/yonder-core/src/index.ts`, `packages/yonder-core/src/version.test.ts`
- Create: `package.json` (workspace root), `.github/workflows/ci.yml`
- Delete: `packages/yonder-core/.gitkeep`

**Interfaces:**
- Consumes: nothing
- Produces: `VERSION: string` exported from `yonder-core`; an `npm test` that runs vitest across the workspace

- [ ] **Step 1: Write the failing test**

`packages/yonder-core/src/version.test.ts`:

```typescript
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { VERSION } from "./index.js";

describe("yonder-core", () => {
  it("exports a semver version string", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
```

- [ ] **Step 2: Create the workspace root**

`package.json` at repo root:

```json
{
  "name": "yonder",
  "private": true,
  "license": "GPL-3.0-or-later",
  "workspaces": ["packages/*"],
  "engines": { "node": ">=20" },
  "scripts": {
    "test": "npm run test --workspaces --if-present",
    "build": "npm run build --workspaces --if-present",
    "lint": "tsc --noEmit -p packages/yonder-core/tsconfig.json"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 3: Create the package**

`packages/yonder-core/package.json`:

```json
{
  "name": "yonder-core",
  "version": "0.1.0",
  "license": "GPL-3.0-or-later",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "bin": { "yonder-core": "./dist/daemon/server.js" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "yaml": "^2.5.0",
    "zod": "^3.23.0"
  }
}
```

`packages/yonder-core/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "skipLibCheck": true
  },
  "include": ["src/**/*"],
  "exclude": ["src/**/*.test.ts"]
}
```

`packages/yonder-core/vitest.config.ts`:

```typescript
// SPDX-License-Identifier: GPL-3.0-or-later
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node" } });
```

`packages/yonder-core/src/index.ts`:

```typescript
// SPDX-License-Identifier: GPL-3.0-or-later
export const VERSION = "0.1.0";
```

- [ ] **Step 4: Install and run the test**

Run: `npm install && npm test`
Expected: PASS, 1 test.

- [ ] **Step 5: Add CI**

`.github/workflows/ci.yml`:

```yaml
name: CI
on:
  push: { branches: [main] }
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm test
  installer:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Lint shell
        run: |
          sudo apt-get update && sudo apt-get install -y shellcheck
          shellcheck installer/install.sh installer/lib/*.sh installer/roles/*.sh
```

Note: the `installer` job will fail until Task 8 creates those files. Add the job in Task 8 instead if you want CI green throughout — the `test` job is the one that must pass now.

- [ ] **Step 6: Commit**

```bash
rm -f packages/yonder-core/.gitkeep
git add package.json package-lock.json packages/yonder-core .github/workflows/ci.yml
git commit -s -m "feat(core): package scaffold, vitest and CI

Satisfies no requirement directly; every later task depends on it."
```

---

## Task 2: Config schema in Zod

**Requirements:** R-CFG-01, R-CFG-02

**Files:**
- Create: `packages/yonder-core/src/schema/config.ts`, `packages/yonder-core/src/schema/config.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `ConfigSchema: z.ZodType<Config>` — the Zod schema
  - `type Config` — inferred TypeScript type
  - `DEFAULT_CONFIG: Config` — a minimal valid config

- [ ] **Step 1: Write the failing test**

`packages/yonder-core/src/schema/config.test.ts`:

```typescript
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { ConfigSchema, DEFAULT_CONFIG } from "./config.js";

describe("ConfigSchema", () => {
  it("accepts the default config", () => {
    expect(ConfigSchema.safeParse(DEFAULT_CONFIG).success).toBe(true);
  });

  it("rejects an unknown top-level key", () => {
    const bad = { ...DEFAULT_CONFIG, nonsense: true };
    expect(ConfigSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a version it does not understand", () => {
    const bad = { ...DEFAULT_CONFIG, version: 99 };
    expect(ConfigSchema.safeParse(bad).success).toBe(false);
  });

  it("requires an access point address in CIDR form", () => {
    const bad = structuredClone(DEFAULT_CONFIG);
    bad.network.ap.address = "192.168.77.1";
    expect(ConfigSchema.safeParse(bad).success).toBe(false);
  });

  it("defaults the access point fallback to enabled at 90 seconds", () => {
    const parsed = ConfigSchema.parse(DEFAULT_CONFIG);
    expect(parsed.network.ap.fallback.enabled).toBe(true);
    expect(parsed.network.ap.fallback.timeout).toBe(90);
  });

  it("rejects an egress priority containing an unknown interface", () => {
    const bad = structuredClone(DEFAULT_CONFIG);
    bad.network.priority = ["ethernet", "carrier_pigeon"] as never;
    expect(ConfigSchema.safeParse(bad).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w yonder-core`
Expected: FAIL — cannot resolve `./config.js`.

- [ ] **Step 3: Write the schema**

`packages/yonder-core/src/schema/config.ts`:

```typescript
// SPDX-License-Identifier: GPL-3.0-or-later
import { z } from "zod";

const cidr = z.string().regex(
  /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/,
  "must be an address in CIDR form, for example 192.168.77.1/24",
);

const ipv4 = z.string().regex(/^(\d{1,3}\.){3}\d{1,3}$/, "must be an IPv4 address");
const port = z.number().int().min(1).max(65535);

/** A reference to a value held in secrets.yaml rather than inline. */
export const SecretRef = z.object({ secret: z.string().min(1) }).strict();
export type SecretRef = z.infer<typeof SecretRef>;

const Interface = z.enum(["ethernet", "modem", "wifi_client", "usb"]);

const ApFallback = z.object({
  enabled: z.boolean().default(true),
  timeout: z.number().int().min(30).max(600).default(90),
}).strict();

const AccessPoint = z.object({
  enabled: z.boolean().default(true),
  ssid: z.string().min(1).max(32).default("yonder"),
  psk: SecretRef,
  address: cidr.default("192.168.77.1/24"),
  dhcp: z.object({
    start: ipv4.default("192.168.77.2"),
    end: ipv4.default("192.168.77.50"),
    lease: z.string().regex(/^\d+[mhd]$/).default("12h"),
  }).strict().default({}),
  fallback: ApFallback.default({}),
}).strict();

const Network = z.object({
  ap: AccessPoint,
  client: z.object({
    ssid: z.string().max(32).nullable().default(null),
    psk: SecretRef.nullable().default(null),
  }).strict().default({ ssid: null, psk: null }),
  ethernet: z.object({ dhcp: z.boolean().default(true) }).strict().default({}),
  priority: z.array(Interface).min(1).default(["ethernet", "modem", "wifi_client"]),
}).strict();

const Ui = z.object({
  port: port.default(3000),
  theme: z.enum(["day", "night"]).default("day"),
  editor: z.object({
    enabled: z.boolean().default(true),
    password: SecretRef,
    interfaces: z.array(Interface).default(["ethernet", "wifi_client"]),
  }).strict(),
}).strict();

const System = z.object({
  hostname: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).default("yonder"),
  timezone: z.string().default("UTC"),
}).strict();

export const ConfigSchema = z.object({
  version: z.literal(1),
  network: Network,
  ui: Ui,
  system: System.default({}),
}).strict();

export type Config = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG: Config = ConfigSchema.parse({
  version: 1,
  network: { ap: { psk: { secret: "ap_psk" } } },
  ui: { editor: { password: { secret: "editor_password" } } },
});
```

Note on scope: M0 defines only the sections M0 and M1 need. `mavlink`, `cameras`, `remote`, `gpio` are added by the milestones that implement them — each extending this file, each with its own tests. `.strict()` means an unknown key is an error, so a config from a newer version fails loudly instead of being silently half-applied.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w yonder-core`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/yonder-core/src/schema
git commit -s -m "feat(core): config schema in Zod

One source of truth for config shape; types are inferred from it.
Strict object parsing so unknown keys fail loudly.

R-CFG-01, R-CFG-02"
```

---

## Task 3: JSON Schema generation

**Requirements:** R-CFG-02

**Files:**
- Create: `packages/yonder-core/src/schema/generate.ts`, `packages/yonder-core/src/schema/generate.test.ts`
- Modify: `packages/yonder-core/package.json` (add `zod-to-json-schema` dependency and a `schema` script)
- Create: `config/schema/yonder.schema.json` (generated, committed)
- Delete: `config/schema/.gitkeep`

**Interfaces:**
- Consumes: `ConfigSchema` from Task 2
- Produces: `toJsonSchema(): object`; an `npm run schema -w yonder-core` that writes `config/schema/yonder.schema.json`

- [ ] **Step 1: Write the failing test**

`packages/yonder-core/src/schema/generate.test.ts`:

```typescript
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { toJsonSchema } from "./generate.js";

describe("toJsonSchema", () => {
  it("produces a draft-07 schema with a title", () => {
    const s = toJsonSchema() as Record<string, unknown>;
    expect(s.$schema).toContain("json-schema.org");
    expect(s.title).toBe("Yonder configuration");
  });

  it("describes the network section", () => {
    const s = toJsonSchema() as { properties: Record<string, unknown> };
    expect(s.properties).toHaveProperty("network");
    expect(s.properties).toHaveProperty("ui");
  });
});
```

- [ ] **Step 2: Add the dependency and run the test to verify it fails**

Run: `npm i -w yonder-core zod-to-json-schema@^3.23.0 && npm test -w yonder-core`
Expected: FAIL — cannot resolve `./generate.js`.

- [ ] **Step 3: Write the generator**

`packages/yonder-core/src/schema/generate.ts`:

```typescript
// SPDX-License-Identifier: GPL-3.0-or-later
import { writeFileSync } from "node:fs";
import { zodToJsonSchema } from "zod-to-json-schema";
import { ConfigSchema } from "./config.js";

export function toJsonSchema(): object {
  return zodToJsonSchema(ConfigSchema, {
    name: undefined,
    target: "jsonSchema7",
    definitionPath: "definitions",
    $refStrategy: "none",
    nameStrategy: "title",
  }) as object;
}

function main(): void {
  const schema = { title: "Yonder configuration", ...toJsonSchema() };
  const out = process.argv[2] ?? "config/schema/yonder.schema.json";
  writeFileSync(out, JSON.stringify(schema, null, 2) + "\n");
  process.stdout.write(`wrote ${out}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
```

The spread order puts our `title` first, then lets the generated schema's own keys follow; `$schema` comes from the generator.

Add to `packages/yonder-core/package.json` scripts:

```json
"schema": "tsc -p tsconfig.json && node dist/schema/generate.js ../../config/schema/yonder.schema.json"
```

- [ ] **Step 4: Run the tests, then generate**

Run: `npm test -w yonder-core`
Expected: PASS, 9 tests.

Run: `rm -f config/schema/.gitkeep && npm run schema -w yonder-core`
Expected: `wrote ../../config/schema/yonder.schema.json`

- [ ] **Step 5: Commit**

```bash
git add packages/yonder-core config/schema package-lock.json
git commit -s -m "feat(core): generate JSON Schema from the Zod schema

Committed output so editors can offer completion on config.yaml without
a build step.

R-CFG-02"
```

---

## Task 4: Load and save config.yaml

**Requirements:** R-CFG-01, R-CFG-02, R-STO-03

**Files:**
- Create: `packages/yonder-core/src/config/errors.ts`, `packages/yonder-core/src/config/load.ts`, `packages/yonder-core/src/config/save.ts`, `packages/yonder-core/src/config/config.test.ts`

**Interfaces:**
- Consumes: `ConfigSchema`, `Config` from Task 2
- Produces:
  - `class ConfigError extends Error { readonly issues: string[] }`
  - `loadConfig(path: string): Config` — throws `ConfigError` on parse or validation failure
  - `saveConfig(path: string, config: Config): void` — atomic
  - `formatIssues(err: z.ZodError): string[]`

- [ ] **Step 1: Write the failing test**

`packages/yonder-core/src/config/config.test.ts`:

```typescript
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./load.js";
import { saveConfig } from "./save.js";
import { ConfigError } from "./errors.js";
import { DEFAULT_CONFIG } from "../schema/config.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "yonder-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("loadConfig", () => {
  it("round-trips a saved config", () => {
    const p = join(dir, "config.yaml");
    saveConfig(p, DEFAULT_CONFIG);
    expect(loadConfig(p)).toEqual(DEFAULT_CONFIG);
  });

  it("throws ConfigError with a readable message on invalid YAML", () => {
    const p = join(dir, "bad.yaml");
    writeFileSync(p, "version: 1\n  bad indent:\n");
    expect(() => loadConfig(p)).toThrow(ConfigError);
  });

  it("names the offending field when validation fails", () => {
    const p = join(dir, "invalid.yaml");
    writeFileSync(p, "version: 1\nnetwork:\n  ap:\n    address: nonsense\n");
    try {
      loadConfig(p);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).issues.join(" ")).toContain("network.ap.address");
    }
  });

  it("throws ConfigError when the file is missing", () => {
    expect(() => loadConfig(join(dir, "nope.yaml"))).toThrow(ConfigError);
  });
});

describe("saveConfig", () => {
  it("writes YAML a human can read", () => {
    const p = join(dir, "config.yaml");
    saveConfig(p, DEFAULT_CONFIG);
    expect(readFileSync(p, "utf8")).toContain("version: 1");
  });

  it("leaves no temporary file behind", () => {
    const p = join(dir, "config.yaml");
    saveConfig(p, DEFAULT_CONFIG);
    expect(readdirSync(dir)).toEqual(["config.yaml"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w yonder-core`
Expected: FAIL — cannot resolve `./load.js`.

- [ ] **Step 3: Write the implementation**

`packages/yonder-core/src/config/errors.ts`:

```typescript
// SPDX-License-Identifier: GPL-3.0-or-later
import type { ZodError } from "zod";

export class ConfigError extends Error {
  readonly issues: string[];
  constructor(message: string, issues: string[] = []) {
    super(issues.length ? `${message}\n  ${issues.join("\n  ")}` : message);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

export function formatIssues(err: ZodError): string[] {
  return err.issues.map((i) => {
    const path = i.path.join(".") || "(root)";
    return `${path}: ${i.message}`;
  });
}
```

`packages/yonder-core/src/config/load.ts`:

```typescript
// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { ConfigSchema, type Config } from "../schema/config.js";
import { ConfigError, formatIssues } from "./errors.js";

export function loadConfig(path: string): Config {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new ConfigError(`cannot read ${path}: ${(e as Error).message}`);
  }

  let doc: unknown;
  try {
    doc = parse(raw);
  } catch (e) {
    throw new ConfigError(`${path} is not valid YAML: ${(e as Error).message}`);
  }

  const result = ConfigSchema.safeParse(doc);
  if (!result.success) {
    throw new ConfigError(`${path} is not a valid Yonder configuration`, formatIssues(result.error));
  }
  return result.data;
}
```

`packages/yonder-core/src/config/save.ts`:

```typescript
// SPDX-License-Identifier: GPL-3.0-or-later
import { writeFileSync, renameSync, unlinkSync, openSync, fsyncSync, closeSync } from "node:fs";
import { stringify } from "yaml";
import type { Config } from "../schema/config.js";
import { ConfigError } from "./errors.js";

/**
 * Write atomically: temp file in the same directory, fsync, then rename.
 * A rename within a directory is atomic, so a power loss mid-write leaves
 * either the old file or the new one, never a truncated hybrid (R-STO-03).
 */
export function saveConfig(path: string, config: Config): void {
  const tmp = `${path}.tmp`;
  try {
    writeFileSync(tmp, stringify(config), { mode: 0o644 });
    const fd = openSync(tmp, "r");
    fsyncSync(fd);
    closeSync(fd);
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw new ConfigError(`cannot write ${path}: ${(e as Error).message}`);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w yonder-core`
Expected: PASS, 15 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/yonder-core/src/config
git commit -s -m "feat(core): load and save config.yaml

Atomic save via temp file plus rename, so an interrupted write cannot
leave a truncated config. Validation errors name the offending field.

R-CFG-01, R-CFG-02, R-STO-03"
```

---

## Task 5: Secrets store

**Requirements:** R-CFG-04, R-CFG-06, R-SEC-01, R-SEC-07

**Files:**
- Create: `packages/yonder-core/src/secrets/generate.ts`, `packages/yonder-core/src/secrets/store.ts`, `packages/yonder-core/src/secrets/secrets.test.ts`

**Interfaces:**
- Consumes: `ConfigError` from Task 4
- Produces:
  - `generateSecret(kind: "psk" | "password" | "token"): string`
  - `class SecretStore` with `constructor(path: string)`, `get(name): string | undefined`, `ensure(name, kind): { value: string; created: boolean }`, `resolve(ref: SecretRef): string`

- [ ] **Step 1: Write the failing test**

`packages/yonder-core/src/secrets/secrets.test.ts`:

```typescript
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSecret } from "./generate.js";
import { SecretStore } from "./store.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "yonder-sec-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("generateSecret", () => {
  it("produces a WPA2-legal pre-shared key", () => {
    const s = generateSecret("psk");
    expect(s.length).toBeGreaterThanOrEqual(12);
    expect(s.length).toBeLessThanOrEqual(63);
  });

  it("never repeats across many calls", () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateSecret("psk")));
    expect(seen.size).toBe(500);
  });

  it("avoids characters that are ambiguous when read aloud", () => {
    for (let i = 0; i < 200; i++) {
      expect(generateSecret("psk")).not.toMatch(/[O0lI1]/);
    }
  });
});

describe("SecretStore", () => {
  it("creates a secret on first ensure and reports it as new", () => {
    const s = new SecretStore(join(dir, "secrets.yaml"));
    const first = s.ensure("ap_psk", "psk");
    expect(first.created).toBe(true);
    const second = s.ensure("ap_psk", "psk");
    expect(second.created).toBe(false);
    expect(second.value).toBe(first.value);
  });

  it("writes the file 0600", () => {
    const p = join(dir, "secrets.yaml");
    new SecretStore(p).ensure("ap_psk", "psk");
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it("persists across instances", () => {
    const p = join(dir, "secrets.yaml");
    const value = new SecretStore(p).ensure("ap_psk", "psk").value;
    expect(new SecretStore(p).get("ap_psk")).toBe(value);
  });

  it("resolves a secret reference", () => {
    const p = join(dir, "secrets.yaml");
    const s = new SecretStore(p);
    const value = s.ensure("editor_password", "password").value;
    expect(s.resolve({ secret: "editor_password" })).toBe(value);
  });

  it("throws when resolving a reference that does not exist", () => {
    const s = new SecretStore(join(dir, "secrets.yaml"));
    expect(() => s.resolve({ secret: "missing" })).toThrow(/missing/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w yonder-core`
Expected: FAIL — cannot resolve `./generate.js`.

- [ ] **Step 3: Write the implementation**

`packages/yonder-core/src/secrets/generate.ts`:

```typescript
// SPDX-License-Identifier: GPL-3.0-or-later
import { randomInt } from "node:crypto";

/**
 * Alphabet excludes O, 0, l, I and 1 — a per-device access-point password
 * gets read off a screen and typed on a phone, often in a field.
 */
const ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const LENGTHS = { psk: 16, password: 16, token: 32 } as const;

export function generateSecret(kind: keyof typeof LENGTHS): string {
  const n = LENGTHS[kind];
  let out = "";
  for (let i = 0; i < n; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}
```

`packages/yonder-core/src/secrets/store.ts`:

```typescript
// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync, writeFileSync, renameSync, chmodSync, existsSync, unlinkSync } from "node:fs";
import { parse, stringify } from "yaml";
import { generateSecret } from "./generate.js";
import { ConfigError } from "../config/errors.js";
import type { SecretRef } from "../schema/config.js";

type Bag = Record<string, string>;

export class SecretStore {
  private readonly path: string;
  private bag: Bag;

  constructor(path: string) {
    this.path = path;
    this.bag = existsSync(path) ? (parse(readFileSync(path, "utf8")) as Bag) ?? {} : {};
  }

  get(name: string): string | undefined {
    return this.bag[name];
  }

  /** Return the secret, creating it if absent. `created` tells the caller to show it once. */
  ensure(name: string, kind: "psk" | "password" | "token"): { value: string; created: boolean } {
    const existing = this.bag[name];
    if (existing !== undefined) return { value: existing, created: false };
    const value = generateSecret(kind);
    this.bag[name] = value;
    this.flush();
    return { value, created: true };
  }

  resolve(ref: SecretRef): string {
    const value = this.bag[ref.secret];
    if (value === undefined) {
      throw new ConfigError(`no secret named "${ref.secret}" in ${this.path}`);
    }
    return value;
  }

  private flush(): void {
    const tmp = `${this.path}.tmp`;
    try {
      writeFileSync(tmp, stringify(this.bag), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.path);
      chmodSync(this.path, 0o600);
    } catch (e) {
      try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
      throw new ConfigError(`cannot write ${this.path}: ${(e as Error).message}`);
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w yonder-core`
Expected: PASS, 24 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/yonder-core/src/secrets
git commit -s -m "feat(core): per-device secret generation and store

No shared defaults; secrets are generated on first use, held 0600 in a
file separate from config, and reported once on creation. Alphabet omits
characters that are ambiguous when read off a screen.

R-CFG-04, R-CFG-06, R-SEC-01, R-SEC-07"
```

---

## Task 6: Apply/rollback engine

**Requirements:** R-CFG-03

This is the heart of M0. Everything else exists so this can work.

**Files:**
- Create: `packages/yonder-core/src/apply/types.ts`, `packages/yonder-core/src/apply/journal.ts`, `packages/yonder-core/src/apply/engine.ts`, `packages/yonder-core/src/apply/engine.test.ts`

**Interfaces:**
- Consumes: `Config` (Task 2), `loadConfig`/`saveConfig` (Task 4)
- Produces:
  - `interface Renderer { name: string; render(config: Config): Promise<void>; }`
  - `type ApplyState = "idle" | "pending" | "confirmed" | "reverting"`
  - `class ApplyEngine` with `apply(next)`, `confirm(id)`, `status()`, `recover()`
  - `interface Clock { now(): number; setTimer(ms, fn): unknown; clearTimer(h): void; }`

- [ ] **Step 1: Write the failing test**

`packages/yonder-core/src/apply/engine.test.ts`:

```typescript
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplyEngine } from "./engine.js";
import type { Renderer, Clock } from "./types.js";
import { saveConfig } from "../config/save.js";
import { loadConfig } from "../config/load.js";
import { DEFAULT_CONFIG } from "../schema/config.js";
import type { Config } from "../schema/config.js";

let dir: string, configPath: string, journalPath: string;

/** A clock the test drives by hand, so no test ever waits on real time. */
function fakeClock() {
  let t = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let next = 1;
  const clock: Clock = {
    now: () => t,
    setTimer: (ms, fn) => { const h = next++; timers.set(h, { at: t + ms, fn }); return h; },
    clearTimer: (h) => { timers.delete(h as number); },
  };
  return {
    clock,
    advance(ms: number) {
      t += ms;
      for (const [h, timer] of [...timers]) {
        if (timer.at <= t) { timers.delete(h); timer.fn(); }
      }
    },
  };
}

function renderer(name = "test"): Renderer & { calls: Config[] } {
  const calls: Config[] = [];
  return { name, calls, async render(c) { calls.push(structuredClone(c)); } };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yonder-apply-"));
  configPath = join(dir, "config.yaml");
  journalPath = join(dir, "apply.json");
  saveConfig(configPath, DEFAULT_CONFIG);
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function changed(): Config {
  const c = structuredClone(DEFAULT_CONFIG);
  c.system.hostname = "changed";
  return c;
}

describe("ApplyEngine", () => {
  it("starts idle", () => {
    const { clock } = fakeClock();
    const e = new ApplyEngine({ configPath, journalPath, renderers: [renderer()], clock });
    expect(e.status().state).toBe("idle");
  });

  it("rejects a config that fails validation, leaving the old one in place", async () => {
    const { clock } = fakeClock();
    const e = new ApplyEngine({ configPath, journalPath, renderers: [renderer()], clock });
    await expect(e.apply({ version: 1 } as unknown as Config)).rejects.toThrow();
    expect(loadConfig(configPath).system.hostname).toBe("yonder");
    expect(e.status().state).toBe("idle");
  });

  it("writes the new config and enters pending", async () => {
    const { clock } = fakeClock();
    const r = renderer();
    const e = new ApplyEngine({ configPath, journalPath, renderers: [r], clock });
    const { id } = await e.apply(changed());
    expect(id).toBeTruthy();
    expect(e.status().state).toBe("pending");
    expect(loadConfig(configPath).system.hostname).toBe("changed");
    expect(r.calls).toHaveLength(1);
  });

  it("stays applied once confirmed, even after the timeout passes", async () => {
    const { clock, advance } = fakeClock();
    const e = new ApplyEngine({ configPath, journalPath, renderers: [renderer()], clock });
    const { id } = await e.apply(changed());
    e.confirm(id);
    expect(e.status().state).toBe("confirmed");
    advance(200_000);
    expect(loadConfig(configPath).system.hostname).toBe("changed");
  });

  it("reverts when the confirmation window expires", async () => {
    const { clock, advance } = fakeClock();
    const r = renderer();
    const e = new ApplyEngine({ configPath, journalPath, renderers: [r], clock, timeoutMs: 120_000 });
    await e.apply(changed());
    advance(119_000);
    expect(loadConfig(configPath).system.hostname).toBe("changed");
    advance(2_000);
    expect(loadConfig(configPath).system.hostname).toBe("yonder");
    expect(r.calls).toHaveLength(2);
    expect(r.calls[1].system.hostname).toBe("yonder");
    expect(e.status().state).toBe("idle");
  });

  it("ignores confirmation of an id it does not recognise", async () => {
    const { clock, advance } = fakeClock();
    const e = new ApplyEngine({ configPath, journalPath, renderers: [renderer()], clock });
    await e.apply(changed());
    expect(() => e.confirm("not-the-id")).toThrow(/unknown apply/);
    advance(200_000);
    expect(loadConfig(configPath).system.hostname).toBe("yonder");
  });

  it("refuses a second apply while one is pending", async () => {
    const { clock } = fakeClock();
    const e = new ApplyEngine({ configPath, journalPath, renderers: [renderer()], clock });
    await e.apply(changed());
    await expect(e.apply(changed())).rejects.toThrow(/already pending/);
  });

  it("reverts when a renderer throws, and reports the failure", async () => {
    const { clock } = fakeClock();
    const bad: Renderer = { name: "bad", async render() { throw new Error("nope"); } };
    const e = new ApplyEngine({ configPath, journalPath, renderers: [bad], clock });
    await expect(e.apply(changed())).rejects.toThrow(/nope/);
    expect(loadConfig(configPath).system.hostname).toBe("yonder");
    expect(e.status().state).toBe("idle");
  });

  it("reverts an apply left pending by a crash, on recover()", async () => {
    const { clock, advance } = fakeClock();
    const first = new ApplyEngine({ configPath, journalPath, renderers: [renderer()], clock });
    await first.apply(changed());
    // Simulate a crash: a fresh engine over the same journal, nothing in memory.
    const r = renderer();
    const second = new ApplyEngine({ configPath, journalPath, renderers: [r], clock });
    await second.recover();
    expect(loadConfig(configPath).system.hostname).toBe("yonder");
    expect(second.status().state).toBe("idle");
    advance(200_000);
  });

  it("does nothing on recover() when no apply was in flight", async () => {
    const { clock } = fakeClock();
    const e = new ApplyEngine({ configPath, journalPath, renderers: [renderer()], clock });
    await e.recover();
    expect(e.status().state).toBe("idle");
    expect(loadConfig(configPath).system.hostname).toBe("yonder");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w yonder-core`
Expected: FAIL — cannot resolve `./engine.js`.

- [ ] **Step 3: Write the types and journal**

`packages/yonder-core/src/apply/types.ts`:

```typescript
// SPDX-License-Identifier: GPL-3.0-or-later
import type { Config } from "../schema/config.js";

/** Turns config into system state. M1 supplies the network renderer. */
export interface Renderer {
  readonly name: string;
  render(config: Config): Promise<void>;
}

/** Injected so tests drive time by hand and never wait on the wall clock. */
export interface Clock {
  now(): number;
  setTimer(ms: number, fn: () => void): unknown;
  clearTimer(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimer: (ms, fn) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as NodeJS.Timeout),
};

export type ApplyState = "idle" | "pending" | "confirmed" | "reverting";

export interface ApplyStatus {
  state: ApplyState;
  id?: string;
  expiresAt?: number;
}
```

`packages/yonder-core/src/apply/journal.ts`:

```typescript
// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from "node:fs";
import type { Config } from "../schema/config.js";

export interface JournalEntry {
  id: string;
  previous: Config;
  startedAt: number;
}

/**
 * A durable note that an apply is in flight. If the daemon dies between
 * writing this and confirmation, recover() finds it on next start and
 * reverts — which is the whole reason the engine lives outside the console.
 */
export class Journal {
  constructor(private readonly path: string) {}

  write(entry: JournalEntry): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(entry), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  read(): JournalEntry | null {
    if (!existsSync(this.path)) return null;
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as JournalEntry;
    } catch {
      return null;
    }
  }

  clear(): void {
    try { unlinkSync(this.path); } catch { /* already gone */ }
  }
}
```

- [ ] **Step 4: Write the engine**

`packages/yonder-core/src/apply/engine.ts`:

```typescript
// SPDX-License-Identifier: GPL-3.0-or-later
import { randomUUID } from "node:crypto";
import { ConfigSchema, type Config } from "../schema/config.js";
import { ConfigError, formatIssues } from "../config/errors.js";
import { loadConfig } from "../config/load.js";
import { saveConfig } from "../config/save.js";
import { Journal } from "./journal.js";
import { systemClock, type ApplyStatus, type ApplyState, type Clock, type Renderer } from "./types.js";

export interface ApplyEngineOptions {
  configPath: string;
  journalPath: string;
  renderers: Renderer[];
  clock?: Clock;
  timeoutMs?: number;
}

export class ApplyEngine {
  private readonly configPath: string;
  private readonly renderers: Renderer[];
  private readonly clock: Clock;
  private readonly timeoutMs: number;
  private readonly journal: Journal;

  private state: ApplyState = "idle";
  private id?: string;
  private previous?: Config;
  private timer?: unknown;
  private expiresAt?: number;

  constructor(opts: ApplyEngineOptions) {
    this.configPath = opts.configPath;
    this.renderers = opts.renderers;
    this.clock = opts.clock ?? systemClock;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.journal = new Journal(opts.journalPath);
  }

  status(): ApplyStatus {
    return { state: this.state, id: this.id, expiresAt: this.expiresAt };
  }

  /** Validate, snapshot, write, render, then start the countdown. */
  async apply(next: unknown): Promise<{ id: string; expiresAt: number }> {
    if (this.state === "pending") {
      throw new ConfigError("an apply is already pending; confirm or wait for it to revert");
    }

    const parsed = ConfigSchema.safeParse(next);
    if (!parsed.success) {
      throw new ConfigError("rejected: not a valid configuration", formatIssues(parsed.error));
    }

    const previous = loadConfig(this.configPath);
    const id = randomUUID();

    this.journal.write({ id, previous, startedAt: this.clock.now() });
    saveConfig(this.configPath, parsed.data);

    try {
      await this.renderAll(parsed.data);
    } catch (e) {
      // A renderer failed. Put everything back before returning the error.
      saveConfig(this.configPath, previous);
      await this.renderAll(previous).catch(() => { /* best effort */ });
      this.journal.clear();
      this.reset();
      throw e;
    }

    this.state = "pending";
    this.id = id;
    this.previous = previous;
    this.expiresAt = this.clock.now() + this.timeoutMs;
    this.timer = this.clock.setTimer(this.timeoutMs, () => { void this.revert(); });

    return { id, expiresAt: this.expiresAt };
  }

  /** Operator saw the device still working. Keep the change. */
  confirm(id: string): void {
    if (this.state !== "pending") throw new ConfigError("nothing is pending confirmation");
    if (id !== this.id) throw new ConfigError(`unknown apply id "${id}"`);
    if (this.timer !== undefined) this.clock.clearTimer(this.timer);
    this.journal.clear();
    this.state = "confirmed";
    this.timer = undefined;
    this.expiresAt = undefined;
  }

  /** Called at start-up. Reverts an apply the previous process never confirmed. */
  async recover(): Promise<void> {
    const entry = this.journal.read();
    if (entry === null) return;
    saveConfig(this.configPath, entry.previous);
    await this.renderAll(entry.previous).catch(() => { /* best effort */ });
    this.journal.clear();
    this.reset();
  }

  private async revert(): Promise<void> {
    if (this.state !== "pending" || this.previous === undefined) return;
    this.state = "reverting";
    const previous = this.previous;
    saveConfig(this.configPath, previous);
    await this.renderAll(previous).catch(() => { /* best effort */ });
    this.journal.clear();
    this.reset();
  }

  private async renderAll(config: Config): Promise<void> {
    for (const r of this.renderers) await r.render(config);
  }

  private reset(): void {
    this.state = "idle";
    this.id = undefined;
    this.previous = undefined;
    this.timer = undefined;
    this.expiresAt = undefined;
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w yonder-core`
Expected: PASS, 34 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/yonder-core/src/apply
git commit -s -m "feat(core): apply/rollback engine with confirmation timer

Validate, snapshot, write, render, then count down. Unconfirmed changes
revert. A journal on disk means an apply left in flight by a crash is
reverted on next start, which is why this lives outside the console
process rather than inside it.

Time is injected so tests never wait on the wall clock.

R-CFG-03"
```

---

## Task 7: Daemon with a Unix-socket API

**Requirements:** R-CFG-03, R-SEC-04

**Files:**
- Create: `packages/yonder-core/src/daemon/routes.ts`, `packages/yonder-core/src/daemon/server.ts`, `packages/yonder-core/src/daemon/server.test.ts`
- Modify: `packages/yonder-core/src/index.ts`
- Create: `systemd/yonder-core.service`
- Delete: `systemd/.gitkeep`

**Interfaces:**
- Consumes: `ApplyEngine` (Task 6), `loadConfig` (Task 4), `SecretStore` (Task 5)
- Produces: `createRouter(deps): (method, path, body) => Promise<{status, body}>`; `startServer(opts): Promise<{ close(): Promise<void> }>`

The API binds a **Unix socket, not a TCP port**. Nothing on the network can reach it; the console talks to it over the filesystem, where ownership is the access control (R-SEC-04).

- [ ] **Step 1: Write the failing test**

`packages/yonder-core/src/daemon/server.test.ts`:

```typescript
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRouter } from "./routes.js";
import { ApplyEngine } from "../apply/engine.js";
import { saveConfig } from "../config/save.js";
import { DEFAULT_CONFIG } from "../schema/config.js";
import type { Clock, Renderer } from "../apply/types.js";
import type { Config } from "../schema/config.js";

let dir: string, configPath: string, journalPath: string;
const noopRenderer: Renderer = { name: "noop", async render() {} };
const frozenClock: Clock = { now: () => 0, setTimer: () => 1, clearTimer: () => {} };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yonder-api-"));
  configPath = join(dir, "config.yaml");
  journalPath = join(dir, "apply.json");
  saveConfig(configPath, DEFAULT_CONFIG);
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function router() {
  const engine = new ApplyEngine({ configPath, journalPath, renderers: [noopRenderer], clock: frozenClock });
  return createRouter({ engine, configPath });
}

function changed(): Config {
  const c = structuredClone(DEFAULT_CONFIG);
  c.system.hostname = "changed";
  return c;
}

describe("router", () => {
  it("GET /config returns the current configuration", async () => {
    const res = await router()("GET", "/config", undefined);
    expect(res.status).toBe(200);
    expect((res.body as { version: number }).version).toBe(1);
  });

  it("GET /status reports idle before any apply", async () => {
    const res = await router()("GET", "/status", undefined);
    expect(res.status).toBe(200);
    expect((res.body as { state: string }).state).toBe("idle");
  });

  it("POST /apply returns 200 and an id", async () => {
    const res = await router()("POST", "/apply", changed());
    expect(res.status).toBe(200);
    expect((res.body as { id: string }).id).toBeTruthy();
  });

  it("POST /apply returns 400 with issues when config is invalid", async () => {
    const res = await router()("POST", "/apply", { version: 1 });
    expect(res.status).toBe(400);
    expect((res.body as { issues: string[] }).issues.length).toBeGreaterThan(0);
  });

  it("POST /confirm keeps the change", async () => {
    const r = router();
    const applied = await r("POST", "/apply", changed());
    const id = (applied.body as { id: string }).id;
    const res = await r("POST", "/confirm", { id });
    expect(res.status).toBe(200);
    expect(((await r("GET", "/status", undefined)).body as { state: string }).state).toBe("confirmed");
  });

  it("POST /confirm with a wrong id returns 400", async () => {
    const r = router();
    await r("POST", "/apply", changed());
    const res = await r("POST", "/confirm", { id: "wrong" });
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown route", async () => {
    const res = await router()("GET", "/nope", undefined);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w yonder-core`
Expected: FAIL — cannot resolve `./routes.js`.

- [ ] **Step 3: Write the router**

`packages/yonder-core/src/daemon/routes.ts`:

```typescript
// SPDX-License-Identifier: GPL-3.0-or-later
import { ApplyEngine } from "../apply/engine.js";
import { loadConfig } from "../config/load.js";
import { ConfigError } from "../config/errors.js";

export interface RouterDeps {
  engine: ApplyEngine;
  configPath: string;
}

export interface RouteResult {
  status: number;
  body: unknown;
}

export type Router = (method: string, path: string, body: unknown) => Promise<RouteResult>;

export function createRouter(deps: RouterDeps): Router {
  return async (method, path, body) => {
    try {
      if (method === "GET" && path === "/config") {
        return { status: 200, body: loadConfig(deps.configPath) };
      }
      if (method === "GET" && path === "/status") {
        return { status: 200, body: deps.engine.status() };
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
      if (e instanceof ConfigError) {
        return { status: 400, body: { error: e.message, issues: e.issues } };
      }
      return { status: 500, body: { error: (e as Error).message } };
    }
  };
}
```

- [ ] **Step 4: Write the server**

`packages/yonder-core/src/daemon/server.ts`:

```typescript
// SPDX-License-Identifier: GPL-3.0-or-later
import { createServer, type Server } from "node:http";
import { unlinkSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { ApplyEngine } from "../apply/engine.js";
import { createRouter } from "./routes.js";
import type { Renderer } from "../apply/types.js";

export interface ServerOptions {
  socketPath: string;
  configPath: string;
  journalPath: string;
  renderers: Renderer[];
}

export async function startServer(opts: ServerOptions): Promise<{ close(): Promise<void> }> {
  const engine = new ApplyEngine({
    configPath: opts.configPath,
    journalPath: opts.journalPath,
    renderers: opts.renderers,
  });

  // Anything left pending by a previous process is reverted before we serve.
  await engine.recover();

  const route = createRouter({ engine, configPath: opts.configPath });

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let body: unknown;
      if (chunks.length > 0) {
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "body is not valid JSON" }));
          return;
        }
      }
      void route(req.method ?? "GET", req.url ?? "/", body).then((r) => {
        res.writeHead(r.status, { "content-type": "application/json" });
        res.end(JSON.stringify(r.body));
      });
    });
  });

  mkdirSync(dirname(opts.socketPath), { recursive: true });
  if (existsSync(opts.socketPath)) unlinkSync(opts.socketPath);

  await new Promise<void>((resolve) => server.listen(opts.socketPath, resolve));
  chmodSync(opts.socketPath, 0o660);

  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          if (existsSync(opts.socketPath)) unlinkSync(opts.socketPath);
          resolve();
        });
      }),
  };
}

async function main(): Promise<void> {
  await startServer({
    socketPath: process.env.YONDER_SOCKET ?? "/run/yonder/core.sock",
    configPath: process.env.YONDER_CONFIG ?? "/etc/yonder/config.yaml",
    journalPath: process.env.YONDER_JOURNAL ?? "/var/lib/yonder/apply.json",
    renderers: [],
  });
  process.stdout.write("yonder-core listening\n");
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
```

Update `packages/yonder-core/src/index.ts`:

```typescript
// SPDX-License-Identifier: GPL-3.0-or-later
export const VERSION = "0.1.0";
export { ConfigSchema, DEFAULT_CONFIG, type Config, type SecretRef } from "./schema/config.js";
export { loadConfig } from "./config/load.js";
export { saveConfig } from "./config/save.js";
export { ConfigError } from "./config/errors.js";
export { SecretStore } from "./secrets/store.js";
export { generateSecret } from "./secrets/generate.js";
export { ApplyEngine } from "./apply/engine.js";
export { systemClock, type Renderer, type Clock, type ApplyStatus } from "./apply/types.js";
export { startServer } from "./daemon/server.js";
```

`systemd/yonder-core.service`:

```ini
[Unit]
Description=Yonder core configuration service
Documentation=https://github.com/boydsoftprez/yonder
After=local-fs.target
Before=network-pre.target

[Service]
Type=simple
ExecStart=/usr/bin/node /opt/yonder/packages/yonder-core/dist/daemon/server.js
Restart=always
RestartSec=2
RuntimeDirectory=yonder
RuntimeDirectoryMode=0750
StateDirectory=yonder
StateDirectoryMode=0750
ProtectSystem=strict
ReadWritePaths=/etc/yonder /var/lib/yonder
ProtectHome=yes
NoNewPrivileges=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
```

`Restart=always` is deliberate. If the daemon dies with an apply in flight, systemd restarts it, `recover()` runs, and the unconfirmed change is reverted.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w yonder-core && npm run lint`
Expected: PASS, 41 tests; lint clean.

- [ ] **Step 6: Commit**

```bash
rm -f systemd/.gitkeep
git add packages/yonder-core/src systemd
git commit -s -m "feat(core): daemon with a Unix-socket API

Binds a Unix socket, never a TCP port, so nothing on the network can
reach the configuration API. recover() runs before the socket is served,
so a crashed apply is reverted on restart.

R-CFG-03, R-SEC-04"
```

---

## Task 8: Installer skeleton and role runner

**Requirements:** R-CFG-05 (groundwork), R-HW-04 (groundwork)

**Files:**
- Create: `installer/install.sh`, `installer/lib/common.sh`, `installer/roles/10-base.sh`, `installer/roles/20-yonder-core.sh`, `installer/README.md`
- Modify: `.github/workflows/ci.yml` (the `installer` job from Task 1 now has files to lint)
- Delete: `installer/roles/.gitkeep`, `installer/profiles/.gitkeep`

**Interfaces:**
- Consumes: the built `yonder-core` package
- Produces: `installer/install.sh [--dry-run] [--only ROLE]`; roles are `NN-name.sh` run in ascending order

POSIX `sh` with no dependencies, because this must run inside a chroot on a base image where Node does not exist yet.

- [ ] **Step 1: Write the shared library**

`installer/lib/common.sh`:

```sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Shared helpers for installer roles. Sourced, never executed.

: "${DRY_RUN:=0}"
: "${YONDER_PREFIX:=/opt/yonder}"
: "${YONDER_ETC:=/etc/yonder}"

log()  { printf '  %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

# Run a command, or print it when DRY_RUN=1.
run() {
    if [ "$DRY_RUN" = "1" ]; then
        printf '  + %s\n' "$*"
    else
        "$@" || die "command failed: $*"
    fi
}

# True when a package is already installed.
have_pkg() {
    dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q 'ok installed'
}

# Install packages, skipping any already present. Idempotent.
ensure_pkgs() {
    missing=""
    for p in "$@"; do
        have_pkg "$p" || missing="$missing $p"
    done
    if [ -z "$missing" ]; then
        log "packages already present: $*"
        return 0
    fi
    log "installing:$missing"
    # shellcheck disable=SC2086
    run env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $missing
}

ensure_dir() {
    if [ -d "$1" ]; then
        log "directory exists: $1"
    else
        run mkdir -p "$1"
    fi
    [ -n "${2:-}" ] && run chmod "$2" "$1"
    return 0
}
```

- [ ] **Step 2: Write the orchestrator**

`installer/install.sh`:

```sh
#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Yonder installer. The single definition of a working system; images are
# produced by running this in a chroot rather than by hand.
set -eu

HERE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
export YONDER_SRC="$HERE/.."
DRY_RUN=0
ONLY=""

usage() {
    cat <<'EOF'
Usage: install.sh [options]

  --dry-run      print what would be done, change nothing
  --only ROLE    run a single role, for example --only 20-yonder-core
  -h, --help     this message
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run) DRY_RUN=1 ;;
        --only)    shift; [ $# -gt 0 ] || { usage; exit 2; }; ONLY="$1" ;;
        -h|--help) usage; exit 0 ;;
        *)         printf 'unknown option: %s\n' "$1" >&2; usage; exit 2 ;;
    esac
    shift
done
export DRY_RUN

# shellcheck source=lib/common.sh
. "$HERE/lib/common.sh"

[ "$DRY_RUN" = "1" ] || [ "$(id -u)" = "0" ] || die "must run as root (or use --dry-run)"

for role in "$HERE"/roles/*.sh; do
    [ -f "$role" ] || continue
    name=$(basename "$role" .sh)
    if [ -n "$ONLY" ] && [ "$name" != "$ONLY" ]; then
        continue
    fi
    step "$name"
    # shellcheck source=/dev/null
    . "$role"
done

step "done"
log "configuration: $YONDER_ETC/config.yaml"
```

- [ ] **Step 3: Write the two roles**

`installer/roles/10-base.sh`:

```sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Base system packages and the directories Yonder owns.

ensure_pkgs ca-certificates curl

ensure_dir "$YONDER_ETC" 0755
ensure_dir /var/lib/yonder 0750
ensure_dir "$YONDER_PREFIX" 0755
```

`installer/roles/20-yonder-core.sh`:

```sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Install the core configuration service and its unit.

ensure_pkgs nodejs

log "copying yonder-core to $YONDER_PREFIX"
ensure_dir "$YONDER_PREFIX/packages" 0755
run cp -r "$YONDER_SRC/packages/yonder-core" "$YONDER_PREFIX/packages/"

if [ -f "$YONDER_SRC/systemd/yonder-core.service" ]; then
    run cp "$YONDER_SRC/systemd/yonder-core.service" /etc/systemd/system/yonder-core.service
    if [ "$DRY_RUN" != "1" ] && command -v systemctl >/dev/null 2>&1; then
        run systemctl daemon-reload
        run systemctl enable yonder-core.service
    else
        log "skipping systemctl (dry run or not a systemd host)"
    fi
fi
```

`installer/README.md`:

```markdown
# Installer

`install.sh` is the single definition of a working Yonder system. Images are
built by running it in a chroot over a base OS image, so there is no
hand-made image and no drift between "installed" and "flashed".

    sudo ./installer/install.sh              # install on this board
    ./installer/install.sh --dry-run         # print the plan, change nothing
    sudo ./installer/install.sh --only 20-yonder-core

## Roles

Roles are `roles/NN-name.sh`, sourced in ascending numeric order. Each one:

- is **idempotent** — running it twice changes nothing the second time
- can run **standalone** via `--only`
- uses only helpers from `lib/common.sh` and POSIX `sh`

No bashisms, no Python, no Ansible. This has to run in a chroot on a base
image where none of those are guaranteed to exist.
```

- [ ] **Step 4: Verify it runs and lints**

Run: `chmod +x installer/install.sh && ./installer/install.sh --dry-run`
Expected: prints `== 10-base`, `== 20-yonder-core`, `== done` with `+ `-prefixed commands and no errors.

Run: `shellcheck installer/install.sh installer/lib/common.sh installer/roles/*.sh`
Expected: no output.

Run: `./installer/install.sh --only 10-base --dry-run`
Expected: only the `10-base` role runs.

- [ ] **Step 5: Commit**

```bash
rm -f installer/roles/.gitkeep installer/profiles/.gitkeep
git add installer .github/workflows/ci.yml
git commit -s -m "feat(installer): POSIX sh role runner

Dependency-free by necessity: this runs in a chroot over a base image
before Node exists. Roles are idempotent and individually runnable.

R-CFG-05, R-HW-04"
```

---

## Task 9: End-to-end round trip

**Requirements:** R-CFG-01, R-CFG-02, R-CFG-03 — this is M0's exit criterion, made executable.

**Files:**
- Create: `packages/yonder-core/src/roundtrip.test.ts`

**Interfaces:**
- Consumes: everything above
- Produces: the test that proves M0 is done

- [ ] **Step 1: Write the test**

`packages/yonder-core/src/roundtrip.test.ts`:

```typescript
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplyEngine } from "./apply/engine.js";
import { loadConfig } from "./config/load.js";
import { saveConfig } from "./config/save.js";
import { SecretStore } from "./secrets/store.js";
import { DEFAULT_CONFIG } from "./schema/config.js";
import type { Clock, Renderer } from "./apply/types.js";
import type { Config } from "./schema/config.js";

let dir: string, configPath: string, journalPath: string;

function fakeClock() {
  let t = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let next = 1;
  const clock: Clock = {
    now: () => t,
    setTimer: (ms, fn) => { const h = next++; timers.set(h, { at: t + ms, fn }); return h; },
    clearTimer: (h) => { timers.delete(h as number); },
  };
  return {
    clock,
    advance(ms: number) {
      t += ms;
      for (const [h, timer] of [...timers]) {
        if (timer.at <= t) { timers.delete(h); timer.fn(); }
      }
    },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yonder-e2e-"));
  configPath = join(dir, "config.yaml");
  journalPath = join(dir, "apply.json");
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("M0 exit criterion", () => {
  it("validates, applies and reverts a configuration", async () => {
    // A device is provisioned: secrets are generated, config is written.
    const secrets = new SecretStore(join(dir, "secrets.yaml"));
    const psk = secrets.ensure("ap_psk", "psk");
    const editor = secrets.ensure("editor_password", "password");
    expect(psk.created).toBe(true);
    expect(editor.created).toBe(true);
    expect(psk.value).not.toBe(editor.value);

    saveConfig(configPath, DEFAULT_CONFIG);
    expect(loadConfig(configPath).network.ap.ssid).toBe("yonder");

    const applied: string[] = [];
    const renderer: Renderer = {
      name: "recorder",
      async render(c) { applied.push(c.network.ap.ssid); },
    };
    const { clock, advance } = fakeClock();
    const engine = new ApplyEngine({
      configPath, journalPath, renderers: [renderer], clock, timeoutMs: 120_000,
    });

    // An invalid change is refused and changes nothing.
    await expect(engine.apply({ version: 1, nonsense: true })).rejects.toThrow();
    expect(loadConfig(configPath).network.ap.ssid).toBe("yonder");

    // A valid change is applied and rendered.
    const next: Config = structuredClone(DEFAULT_CONFIG);
    next.network.ap.ssid = "yonder-field";
    const { id } = await engine.apply(next);
    expect(loadConfig(configPath).network.ap.ssid).toBe("yonder-field");
    expect(applied).toEqual(["yonder-field"]);

    // Nobody confirms. The window closes. Everything goes back.
    advance(121_000);
    expect(loadConfig(configPath).network.ap.ssid).toBe("yonder");
    expect(applied).toEqual(["yonder-field", "yonder"]);
    expect(engine.status().state).toBe("idle");

    // The same change, confirmed this time, stays.
    const second = await engine.apply(next);
    engine.confirm(second.id);
    advance(500_000);
    expect(loadConfig(configPath).network.ap.ssid).toBe("yonder-field");
    expect(id).not.toBe(second.id);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npm test -w yonder-core`
Expected: PASS, 42 tests.

- [ ] **Step 3: Run the whole gate**

Run: `npm run lint && npm test && ./installer/install.sh --dry-run && shellcheck installer/install.sh installer/lib/*.sh installer/roles/*.sh`
Expected: all clean.

- [ ] **Step 4: Commit and tag**

```bash
git add packages/yonder-core/src/roundtrip.test.ts
git commit -s -m "test(core): M0 exit criterion as an executable test

Validate, apply, revert unconfirmed, apply again, confirm, stays.

R-CFG-01, R-CFG-02, R-CFG-03"
git tag -s m0-complete -m "M0: foundations complete"
```

---

## Self-Review

**Spec coverage.** M0 in `docs/roadmap.md` lists six items:

| Roadmap item | Task |
|---|---|
| Repository, GPL-3.0, contribution and security policy | Already committed before this plan |
| CI: lint, unit tests, Node-RED node test harness | Task 1 (lint + tests). **Gap:** the Node-RED harness has no node to test in M0 — it lands with the first node package in M1, and the roadmap line should say so |
| Configuration schema and model — R-CFG-01, R-CFG-02 | Tasks 2, 3, 4 |
| Apply/rollback engine with confirmation timer — R-CFG-03 | Task 6, proven in Task 9 |
| Secret generation and storage — R-CFG-04 | Task 5 |
| `install.sh` skeleton with the role runner | Task 8 |

**Placeholder scan.** No TBD, no "add error handling", no "similar to Task N". Every code step carries the code. Every test step carries the assertions.

**Type consistency.** `Renderer`, `Clock`, `ApplyState`, `ApplyStatus`, `SecretRef` and `Config` are defined once and used with the same names throughout. `ApplyEngine.apply()` takes `unknown` and validates internally, which is why Task 7's router can hand it a raw request body. `SecretStore.ensure()` returns `{ value, created }` in Tasks 5, 7 and 9 alike.

**One deviation worth noting.** `ApplyEngine.apply()` accepts `unknown` rather than `Config`, so validation happens in exactly one place and an untrusted request body cannot bypass it by being cast. Task 6's test passes `{ version: 1 }` to prove it.

**Deferred deliberately.** The `mavlink`, `cameras`, `remote` and `gpio` config sections are not in the M0 schema — each arrives with the milestone that implements it, extending `schema/config.ts`. M0 defines only what M0 and M1 need.
