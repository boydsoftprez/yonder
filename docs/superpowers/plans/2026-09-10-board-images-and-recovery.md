# Yonder Board Images and Recovery Implementation Plan

> Execution: yonder-cost-aware-execution. Requirements and acceptance criteria are binding; test order and review effort follow the Yonder risk-based policy. Use yonder-page-verification for console evidence where applicable.

**Goal:** Build three draft-release images that boot into Yonder's existing AP/setup flow, survive routine power removal through protected storage and durable state, retain apt maintenance, and let owners provision Linux access and back up/restore supported configuration.

**Architecture:** Customize pinned Raspberry Pi OS/Armbian Trixie ARM64 images with one image-safe installer. Separate immutable system files, persistent owner/device state and media. A root-only administrative service handles bounded Linux/storage operations; existing authenticated console transport remains the web boundary. Configuration and recovery use a common durable-state contract.

**Tech stack:** Existing TypeScript/Node 24 payload, POSIX installer shell, Linux systemd/initramfs and ext4, NetworkManager, Node-RED/Vue Settings, GitHub Actions ARM64 VMs, existing Vitest and browser harness. Host-side image scripts may use Bash where namespace/trap handling needs it; installer roles remain POSIX shell. Standard distro account/SSH/package tools remain authoritative for Linux administration.

**Spec:** [Board images, owner access and recovery](../specs/2026-09-10-board-images-and-recovery-design.md).

**Baseline:** `origin/main` at `e1c4e1f5539f3353c3d50b029c2ba9727351a252`. The task checkout is older `codex/yonder-brand`; paths below describe current main, not that older source. Planning does not establish passing runtime or hardware checks. Execution starts in an isolated worktree from refreshed, reviewed main and reconciles any intervening changes.

## Global constraints

- Targets: `rpi` (Pi 3/4/5), `radxa-zero3w`, `radxa-rock5c`; Trixie ARM64 Lite/Minimal bases; vendor kernels on Radxa.
- Preserve the complete current video, telemetry, Flight, camera and networking application. No port back to the older task checkout.
- Preserve AP `yonder`, public passphrase `yonder1234`, address `192.168.77.1/24`, console port 3000 and first-run administrator-password gate. No wizard, internet or boot-file prerequisite.
- Owner Linux account is separate from the `yonder` service account. Sudo requires the Linux password; direct root login remains disabled; SSH starts disabled and permits owner-enabled keys and password authentication.
- Ordinary operation expects power removal, with protected system/boot, bounded volatile RAM state, durable settings/identities, bounded persistent diagnostic logs and separate media capacity. Logs use a 10-second synchronization interval; settings/credentials commit immediately and independently.
- Apt must change the real persistent system in explicit maintenance. Interrupted maintenance may require reflash; no A/B updater or uninterrupted-upgrade guarantee.
- Plain authenticated recovery backup includes secrets, Linux owner access and ZeroTier identity. No owner encryption step. No recordings, arbitrary home files, OS binaries, custom Node-RED flows/extensions or automatic package reinstallation.
- Yonder owns Node-RED and shipped flows. All UI behavior remains in packages; flows are wiring only.
- No aircraft commands originate from maintenance, setup, restore or recovery. Preserve existing armed/reboot refusal and configuration/AP safeguards.
- Follow current CI, signing/DCO and CalVer rules. Do not publish releases, operate boards, or push code merely because a planning task mentions those actions.

## Requirement map

Existing: R-HW-04, R-CFG-01/02/03/04/07/08/09/13/14, R-SEC-01/02/04/07/09/10/11/12/14, R-STO-01 through 06, R-UI-12/16/19, R-VPN-05. Preserve the specific source requirements for UART/video/modem behavior touched by installation.

Allocate the following presently unused IDs in Task 1, rechecking availability against the execution baseline:

| ID | Contract |
|---|---|
| R-CFG-15 | Explicit authenticated owner backup/restore of versioned supported device state, compatibility checks and interruption recovery |
| R-SYS-10 | Separate Linux owner account provisioned locally or through authenticated/re-authenticated Settings, with sudo and explicit SSH policy |
| R-STO-07 | Observed protected/maintenance state; durable ordinary settings and real apt changes during explicit maintenance |

Amend R-CFG-04 to allow owner recovery backups containing secrets while excluding secrets from images/support bundles. Amend R-SEC-02 to permit owner-enabled SSH passwords. Promote R-STO-04 to protected-by-default images with maintenance. R-CFG-05 remains outstanding and excluded. Existing R-SEC-14 reauthentication is reused, not replaced.

## Shared contracts and ownership

### Image and storage handoff

`image/build.sh --target TARGET --output DIR` consumes versioned manifests and a complete payload; `installer/install.sh --image --target TARGET` installs offline into the already-mounted target. A target mismatch or incomplete payload fails. Live install without `--image` retains its current semantics.

`image/targets/TARGET.json` owns upstream partition/boot metadata, not runtime device capabilities. `image/bases.lock.json` owns exact URLs/hashes and package-input-set references. `image/storage-layout.json` indexes validated per-base reports in `image/layouts/TARGET-BASE_SHA256.json`, with schema version, exact base hash, observed partition facts, authorized partition operations, final mounts/labels, boot-growth overrides and verification result. Task 2 produces them and `image/lib/storage-schema.mjs` validates them. Only `image/build.sh` mutates image geometry; storage scripts do not attach independent loop devices. Separate `installer/targets/TARGET.sh` files own only actual target boot/network preparation. Do not make every board execute the current ZERO 3W UART overlay.

Storage Task 2 must establish the mount/boot/account-database strategy with evidence before Tasks 4/5/7 finalize it. Required stable logical locations: persistent state mounted at `/var/lib/yonder-state`, bulk media separately, existing application paths preserved through documented mounts or generated files. State/media sizes and initramfs hooks are outputs of the measured discovery, not arbitrary values to guess during parallel implementation.

### Administration and sensitive transport

Add `yonder-admin.service` and `yonder-admin.socket` at `/run/yonder-admin/control.sock`, root:root mode 0600. The root core daemon and local root-owned setup program may connect; the unprivileged console may not. The service exposes typed allowlisted operations only—no shell, arbitrary command, caller-selected file path, arbitrary user/group or unrestricted mount request. Children of the core inherit its sandbox, so account/mount changes must not be implemented by widening the web console or assuming a root child escapes that sandbox.

Public account projection: `{ configured, username: string|null, sshEnabled, sshPasswordAuthentication, authorizedKeyFingerprints: string[] }`. Never return Linux password hashes or private identity bytes here. Internal backup projection: `{ username, passwordHash, authorizedKeys: string[], sshEnabled, sshPasswordAuthentication, sudo: true } | null`; UID/GID are not restoration authority and target collisions are validated.

New public routes are mounted under existing `/maintenance/api/` through dedicated handler modules, with an authenticated session owner supplied by the server. Account and mode writes require `currentPassword` and existing throttle/reauthentication; create/change password forms send `newPassword` and `confirmPassword`. No passwords enter Dashboard message stores. The current general proxy's 8 KiB bound remains; backup/import routes have explicit separate bounds. All sensitive replies use `Cache-Control: no-store`.

Recovery format: UTF-8 JSON with `format: "yonder-recovery"`, `formatVersion: 1`, source version/board/schema metadata, a typed payload containing configuration/secrets/owner/ZeroTier, and SHA-256 of a defined canonical payload serialization. Maximum archive 4 MiB; reject oversized input while reading, before parsing. No tar extraction, arbitrary paths, code or installer scripts. Checksum detects corruption, not trust. Canonical serialization and per-section limits belong to Task 6's schema, and the exact transport envelope reserves bounded overhead separately from the archive. Export must report oversize state rather than silently truncate it.

### Durable state contract

Task 4 defines these shared types in `src/state/types.ts`; Task 5 imports `OwnerAccessRecord` rather than creating a competing type. `Config` remains the existing schema-inferred type. `SecretPatch` applies only inside a transaction and never appears in a public state reply.

```ts
type StateKind = "bootstrap" | "config-apply" | "owner-access" | "restore" | "maintenance";
type SecretPatch = Readonly<Record<string, string | null>>;
interface OwnerAccessRecord {
  username: string; passwordHash: string; authorizedKeys: string[];
  sshEnabled: boolean; sshPasswordAuthentication: boolean; sudo: true;
}
interface DurableState {
  config: Config;
  secrets: Readonly<Record<string, string>>;
  linuxOwner: OwnerAccessRecord | null;
  zeroTier: null | { identitySecret: string; identityPublic: string; memberships: { networkId: string }[] };
}
interface StateSnapshot { generation: string; state: DurableState }
interface StateTransaction {
  id: string; previous: StateSnapshot;
  stage(next: DurableState): Promise<{ generation: string }>;
  activate(): Promise<{ generation: string }>;
  holdForConfirmation(): Promise<void>;
  commit(): Promise<{ generation: string }>;
  rollback(reasonCode: string): Promise<{ generation: string }>;
}
interface StateCoordinator {
  status(): Promise<{ activeGeneration: string; operation: null | {
    id: string; kind: StateKind; phase: "staging" | "activating" | "awaiting-confirmation" |
      "committing" | "rolling-back" | "recovering";
  } }>;
  begin(input: { id: string; kind: StateKind; expectedActiveGeneration?: string }): Promise<StateTransaction>;
  beginSnapshot(input: { id: string }): Promise<{ snapshot: StateSnapshot; release(): Promise<void> }>;
  recover(): Promise<{ selectedGeneration: string; action: "none" | "discarded-staged" | "rolled-back" | "kept-committed" }>;
}
```

The helper owns the mutex and durable journal across processes. RPC operations map to `state.status`, `state.begin`, `state.stage`, `state.activate`, `state.hold`, `state.commit`, `state.rollback`, `state.snapshot.begin/release`, and `state.recover`; returned transaction IDs authorize only the corresponding already-validated operation/phase on this root-only socket. No request chooses a filesystem path. Fixed projectors implement `apply({operationId, previous:DurableState, next:DurableState}):Promise<void>` and `verify({operationId, expected:DurableState}):Promise<void>`; owner code implements the Linux projector, and the state/recovery work owns the ZeroTier adapter. Registration is static trusted code, never a name or command from an upload. Standard control requests are bounded at 64 KiB, staged complete state at the declared 4 MiB maximum; malformed/deep input is rejected before mutation.

`stage` writes and fsyncs a complete private generation and checksum manifest. `activate` durably records previous/next generation before changing the active selection and applying fixed owner/mesh projections. `commit` verifies projection/activation and fsyncs a committed record before success; subsequent journal/old-generation cleanup is recoverable housekeeping. A cut before durable commit rolls back the complete previous generation; a cut after committed record keeps the new one even if cleanup was interrupted. Pending ordinary configuration changes hold the transaction through confirm/revert and revert on reboot as they do today. Response loss after commit is resolved by operation ID; never repeat a mutation blindly. Snapshot leases block writers and are released on completion/disconnect with bounded lifetime. A disconnected writer is recovered, not silently committed or left locking the device indefinitely; a valid pending apply follows its existing confirmation deadline.

Extend existing `ApplyEngine.apply(next, options)` to accept `secretPatch?: SecretPatch` alongside its existing options. Join/modem configuration builders collect a patch in memory instead of mutating `SecretStore` before `apply`; reject/busy therefore changes neither config nor credentials. Retain existing synchronous public APIs only where their call graph truly stays synchronous; migrate async credential/bootstrap callers explicitly. Task 4 tests all changed call sites and old journal migration. The old apply journal cannot remain a second competing authority. Import a conventional installation once, recovering any existing pending apply first; journal migration must itself survive interruption.

External service state is not automatically frozen by selecting a generation. ZeroTier's actual identity/membership writes must be observed, quiesced when necessary and reconciled through an explicit lifecycle/snapshot adapter; backup must include the current identity rather than a stale/null copy. NetworkManager profiles remain generated from config, with only inventory-proven irreducible state persisted. Neither adapter may copy arbitrary external files into an archive or bypass the operation guard. Exact ZeroTier files/modes and identity-validation command are discovery outputs. Helper failure leaves core free to read the last validated configuration and maintain AP diagnostics but refuses new privileged/persistent writes; it never converts an unreadable owned device into fresh unauthenticated setup.

### Public endpoint contract

New endpoints below are implementation targets, not claims that these routes exist today. Use dedicated routers to keep the existing large daemon route file as composition only.

| Browser path after `/maintenance/api/` | Method | Daemon route | Request/result |
|---|---|---|---|
| `owner` | GET | `/owner/state` | Public owner projection |
| `owner/create` | POST | `/owner/create` | currentPassword, username, newPassword, confirmPassword → public state |
| `owner/password` | POST | `/owner/password` | currentPassword, newPassword, confirmPassword → public state |
| `owner/ssh` | POST | `/owner/ssh` | currentPassword, enabled, passwordAuthentication, authorizedKeys → validated effective public state |
| `storage` | GET | `/storage/state` | StorageStatus |
| `storage/maintenance` | POST | `/storage/maintenance` | currentPassword, enabled, confirm → accepted operation ID or refusal |
| `backup/export` | POST | `/recovery/export` | currentPassword → attachment bytes, `application/json`, no-store |
| `backup/preview` | POST | `/recovery/preview` | archive → session-bound restore ID, destination revision, safe summary/warnings |
| `backup/restore` | POST | `/recovery/restore` | currentPassword, restoreId, destinationRevision, confirm → operation ID before planned disconnect |
| `operations/ID` | GET | `/admin/operations/ID` | Safe phase/result scoped to current session; after credential change use fresh login and current device state |

General input limit stays 8 KiB. Preview permits a 4 MiB archive plus 16 KiB bounded envelope, at both HTTP layers; export receives the same route-specific maximum at the daemon client, while unrelated replies retain their current limits. Check actual body bytes during reads, including chunked input; Content-Length alone is insufficient. Restore previews expire after 10 minutes, are bound to the authenticated session and destination revision, and cannot be replayed after commit. Public operation state carries no archive bytes, secrets or passwords. Reauthentication failures use existing credential throttling. GET endpoints require authentication and never return sensitive projections.

### Shared-file coordination

Backend tasks own their new modules; Task 8 owns final wiring of `daemon/routes.ts`, `console/maintenance.ts` and Settings. Task 4 owns prerequisite recovery/startup wiring in `daemon/server.ts` and admin units; Tasks 5/7 extend their account/storage dependencies serially, before Task 8 adds the public routes. The image-installer task may touch existing role files first; storage installation hooks follow it serially. Specialists do not concurrently edit shared core/installer/workflow files. One final combined review covers the integrated consequential changes; move review earlier for a concrete risky interface, not automatically after every task.

## Dependency order

Task 1 → Tasks 2 and 3 in parallel. Task 2 → Task 4. Tasks 2/3/4 → Task 5. Tasks 4/5 → Task 6. Tasks 2/3/4/5 → Task 7. Tasks 5/6/7 → Task 8. Tasks 3/7/8 → Task 9. Task 9 → Task 10. Task 11 qualifies the complete artifacts and blocks supported-release claims until its required evidence is recorded.

Tasks 2 and 3 are the first useful parallel implementation boundaries. Later tasks may overlap only after shared interface decisions are ratified and file ownership is disjoint. The executor must not build owner/restore behavior on an unproven persistence layout.

## Task 1 — Establish execution baseline and requirement contract

**Requirements:** all mapped above. **Dependencies:** approved spec. **Deliverable:** correct source baseline, amended requirements and one execution ledger.

**Files:** modify `docs/requirements.md`, `docs/roadmap.md`, `docs/architecture.md`, `docs/adr/0007-credential-boundary.md`; create `docs/adr/0010-image-storage-and-owner-recovery.md` if that number remains unused; carry this spec/plan onto the execution branch. Keep task progress outside production code.

**Interfaces:** produces the stable requirement IDs and records the exact baseline used by all workers. No runtime API changes.

- [x] Read current instructions, fetch/review main changes since `e1c4e1f`, and create/reuse an isolated worktree through the applicable worktree workflow. Preserve all existing task files. Open/associate the required repository issue as part of authorized implementation.
- [x] Amend the three conflicting requirements explicitly, add the three new requirement rows, and record user-approved exclusions and maintenance risk. Do not claim all M8 work is finished.
- [x] Capture baseline checks appropriate to subsequent runtime work; keep an owner/status/revision/check ledger. Use `npm ci` in the isolated tree and the existing project checks, recording unrelated failures without silently weakening them.

**Acceptance:** newest integrated application is present; no custom-flow backup or key-only constraint survives in the executable plan; requirement IDs are unused before allocation and referenced consistently afterward.

**Verification:** documentation inspection, `git diff --check`, `npm run version:check`; applicable baseline runtime CI commands listed in the final-check section. No new documentation-only tests.

**Execution recommendation:** lead-owned; mechanical documentation assistance may use Luna only after wording and IDs are fixed.

## Task 2 — Establish storage and board facts with a bounded prototype

**Requirements:** R-HW-04, R-STO-01/03/04/05/06/07, R-CFG-08, R-SYS-10. **Dependencies:** Task 1. **Deliverable:** measured layout/write inventory and prototype evidence that protects normal boot while preserving apt and owner state.

**Files:** create `docs/hardware/image-storage-discovery.md`, `image/storage-layout.json`, `image/layouts/`, `image/lib/storage-schema.mjs`, `image/discover-base.sh`, `image/lib/{inspect-storage,verify-storage}.sh`, and a bounded experiment under `scripts/spikes/image-storage/`; initial per-target facts under `image/targets/`. The prototype is not automatically production initramfs code.

**Interfaces:** produces exact mount paths, supported boot hooks, sizes/minimum card capacity, persistent-path projections, recovery ordering and target-specific expansion rules consumed by Tasks 4/5/7/9. Mark physical hardware observations separately from mount/VM observations.

- [ ] Inspect the exact candidate images: partition table, bootloader sectors, filesystem/UUID usage, initramfs generation, startup/account automation and root growth. Verify upstream bytes/signatures and record candidates without inventing pins.
- [ ] Inventory actual writers: config/secrets/apply journal, owner account tools and account locks, SSH host/authorized keys, NM profiles/state, ZeroTier identity/state, Node-RED generated settings/theme/auth state, media config/registry, journald/timesync/random-seed, swap and recordings. Record each path's owner, frequency, persistence class and power-cut recovery behavior.
- [ ] Prototype protected root/boot plus durable state and separate media on Pi. Test real account-tool file replacement and NSS/PAM reads: bind-mounting an individual `/etc/shadow` file can break rename-based tools and is not acceptable merely because login reads work.
- [ ] Demonstrate an apt-installed test package persists through maintenance exit and reboot. Verify no package changes hide in a discarded overlay. Determine how maintenance merges changes to account databases with persistent owner projection without wiping distro service users.
- [ ] Test bounded volatile storage on the smallest available Pi memory configuration; size persistent state and media reserve from observed use. Declare minimum supported card capacity. Replace rather than reuse root-expansion assumptions that would consume added partitions.
- [ ] Observe ZERO 3W and ROCK 5C boot/network/UART differences and AP regulatory behavior. If no valid no-wizard AP startup can be achieved on a target, record the exact refusal and return the material constraint to the lead before dependent boot implementation.

**Acceptance:** a recorded mount map proves system writes fail in normal mode, legitimate settings/account writes persist, temp/log writes remain bounded, media cannot fill state, and apt changes persist. Failures block the dependent layout task; a guessed mount map is not a passed discovery.

**Verification:** read-only image inspection (`sfdisk --json`, `lsblk --json`, `blkid`), disposable Linux mount prototype (`findmnt`, `stat`, real distro account/apt tools), filesystem remount/reboot observations, physical board evidence where available. Package changes and power cycling require a disposable/authorized test target, never the developer host.

**Execution recommendation:** Sol/high for mount/account interactions, with bounded Terra assistance for per-board inspection if independent. Runs alongside Task 3.

## Task 3 — Make the shared installer explicitly image-safe

**Requirements:** R-HW-04, R-CFG-08, R-SEC-07/12, R-VPN-05, R-UI-19. **Dependencies:** Task 1. **Deliverable:** `--image --target TARGET` installs the complete target payload without operating the host.

**Files:** modify `installer/install.sh`, `installer/lib/common.sh`, affected roles `10-base`, `15-mavlink-router`, `15-usb-power`, `18-accessory-usb`, `20-yonder-core`, `30-console`, `40-modem`, `40-uart`, `40-zerotier`, `50-mediamtx`, `52-gst-rockchip`, `55-pipeline-host`; create focused `installer/lib/services.sh`, `installer/targets/{rpi,radxa-zero3w,radxa-rock5c}.sh` where needed; extend actual installer tests and `scripts/verify-installer-lib.sh`.

**Interfaces:** consumes declared target/payload; produces installed files/offline unit state and target boot preparation. Live-board installation remains supported. This task creates the service-helper contract later installer roles reuse.

- [x] Validate target/flag combinations before mutations. Image mode requires a complete built application and target payload; missing components fail without source/npm-network fallback.
- [x] Centralize live versus offline enable/disable/reload/start behavior. Apply temporary package-service suppression with restoration on every exit. In image mode never trigger udev, modprobe, configfs, USB hardware changes or target device probes.
- [x] Start services only after their installed entry points and required paths exist; in particular, do not start a new admin helper from an early role before role 20 has copied its compiled program. Validate the live activation ordering, including `--only` operation. Preserve existing source-install script-copy fix and installed-flow composition checks. Fix actual service-order problems such as mandatory writable directories needed before live core start, with a regression that observes ordering.
- [x] Split Rockchip filesystem installation from `gst-inspect` hardware validation; declared Radxa targets install verified payloads even without `/dev/mpp_service`. Keep actual encoder discovery on the board.
- [ ] Move boot-specific UART/network preparation behind explicit targets. ZERO 3W's overlay must not be assumed on ROCK 5C; wait for Task 2 facts before enabling uncertain branches. Ensure no role silently reports successful supported hardware when it skipped required preparation.

**Acceptance:** offline unit links match declared defaults; core/console enabled, mesh and other configuration-owned services retain existing disabled/start-by-config semantics. Image mode emits no host-service/device calls. A missing/cross-architecture payload fails. Live install idempotence remains covered. Pi does not install a Rockchip-only payload by accidental host detection.

**Verification:** meaningful regressions before service/privilege changes; `./scripts/verify-installer-lib.sh`, existing installer tests, shellcheck and a disposable ARM64 chroot integration. Unit call-recording alone does not prove chroot behavior.

**Execution recommendation:** Terra/medium following the defined interface; lead reviews service/host isolation. Parallel with Task 2, serial before Task 7 modifies installer integration.

## Task 4 — Add durable state coordination and recovery

**Requirements:** R-CFG-01/02/03/04/09/13/14/15, R-STO-03/07, R-SEC-10/12. **Dependencies:** Task 2. **Deliverable:** one durable mutation/recovery boundary that account provisioning, backup/restore and normal configuration can share.

**Files:** create `packages/yonder-core/src/state/{types,coordinator,journal,recover}.ts`, `src/admin/{protocol,client,server,main}.ts`, `systemd/yonder-admin.{socket,service}` and focused tests; modify `src/apply/{engine,journal,types}.ts`, `src/secrets/store.ts`, `src/config/save.ts`, `src/fs/durable.ts` only as required by the inspected current interfaces. Task 4 owns the helper transport/state lock and minimum core startup/mutation wiring needed to execute recovery; Task 8 subsequently adds owner-facing routes/UI. Include `src/net/join.ts`, `src/net/modem/configure.ts`, `src/console/credential.ts`, `src/daemon/server.ts` and their callers when migrating secret writes. No independent local lock may compete with the helper's state mutex.

**Interfaces:** see the durable state contract above; consumers must not call raw account/file writes around it. Read-only public state never exposes hashes or private backup bytes.

- [ ] Establish regression coverage for config/secrets mismatch, failed secret persistence, pending apply, stale state in memory and power loss between durable steps before changing these transitions.
- [ ] Journal complete supported before/after state and operation identity, with a durable activation boundary and deterministic boot recovery. Validate staging before active changes. Keep current unconfirmed apply semantics: reboot before confirmation recovers the prior configuration and matching secrets.
- [ ] Serialize normal apply, secret/credential mutations, owner changes, restore and maintenance transitions; take consistent backup snapshots under the same coordination. Reject incompatible concurrent actions with a safe busy result; do not deadlock render callbacks through a nested lock.
- [ ] Recover interrupted changes before starting dependent services or accepting new writes. Rebuild in-memory stores after restoration; a switched file with a stale `SecretStore` cache is not a completed restore.
- [ ] Retain prior valid state until post-activation checks succeed, and avoid unbounded generation/journal growth. An unrecoverable state error must produce a bounded diagnostic/reflash path, not an endless reboot or an unauthenticated bypass to an existing owner's account. Never interpret an unreadable previously provisioned state as a fresh ownerless device.

**Acceptance:** injected failure at every durable boundary yields a complete old or new state; failed/rejected operation leaves old credentials usable; backup cannot capture a half-applied config/secret pair; concurrent local/web account attempts produce at most one owner. Secret values never appear in failure messages. Existing apply/confirm/revert and startup renderer isolation regressions still pass.

**Verification:** focused Vitest tests for the new state modules plus `src/apply`, `src/config`, `src/secrets`, `src/fs`; process-kill/restart integration using disposable filesystems. Actual electrical power cuts remain Task 11.

**Execution recommendation:** Sol/high; consequential shared interface warrants lead review before downstream account/restore code. This is not a generic rewrite of all configuration handling.

## Task 5 — Implement Linux owner access and the root-only helper

**Requirements:** R-SYS-10, R-SEC-01/02/04/09/10/11/14, R-STO-03. **Dependencies:** Tasks 2/3/4. **Deliverable:** local and web-callable owner-account operations that persist without weakening existing service isolation.

**Files:** create `packages/yonder-core/src/owner-access/{model,service,linux,cli}.ts`, `src/admin/sensitive-process.ts` and tests; extend Task 4's admin protocol/service; create `systemd/yonder-local-setup.service`, installer role `19-owner-access.sh`; modify installer account/prerequisite hooks after Task 3 completes. Do not add account logic to Node-RED nodes.

**Interfaces:** root-only helper protocol `version:1` with named operations; only verified owner access records and registered persistence operations. Local CLI uses the same service and cross-process coordinator as core. Public state follows the projection above. Sensitive subprocess input uses stdin pipes with bounded timeout/output, never argv/environment/logs; existing `CommandRunner` does not currently provide this input channel.

- [ ] Implement strict account/key/password validation: one managed non-service account, valid conservative username, independent Linux password, reserved names denied, no arbitrary shell/home/sudo policy from requests. Check user/group conflicts before mutation; leave unrelated accounts intact.
- [ ] Create/modify through standard account tools using supported distro password hashing; do not reuse Yonder's application scrypt format as a Linux shadow hash. Preserve only validated supported shadow hashes on restore. Validate sudo/SSH configuration with native parsers before activation and inspect effective SSH root/password policy.
- [ ] Expose account create/password change/authorized-key/SSH-policy operations through the helper. The core reauthenticates web operations; the helper independently enforces target/operation limits. Bind the socket root-only and test Node-RED's actual service UID cannot connect.
- [ ] Add the narrow tty1 first-owner prompt with password confirmation/no echo. If already configured, start normal getty. No remote/serial autologin root shell; failed/aborted setup is retryable while browser setup continues independently.
- [ ] Supply internal sanitized account snapshot/restore projection for Task 6. UID/GID allocation follows destination constraints; do not import the source account database or overwrite service accounts. Interrupted account writes recover through Task 4.

**Acceptance:** either onboarding path creates exactly one usable owner; reboot preserves login and sudo; sudo does not become NOPASSWD; root direct login is refused; SSH remains off until enabled, then password/key options behave exactly as selected. Wrong web current password makes no mutation. A local account does not provision the Yonder console password. Service account remains unchanged.

**Verification:** new unit/invariant tests; isolated Linux VM/rootfs real `getent`, PAM/login, sudo, SSH effective-policy and credential tests; socket-permission check as the console UID. Never run account tests against the developer's real `/etc`. Local human check: owner or operator follows tty prompt and then logs in; pending until observed.

**Execution recommendation:** Sol for helper/privileged contract, Terra for CLI once fixed. Do not parallelize changes to account/persistence helpers with Task 4 until their interface is accepted.

## Task 6 — Implement plain owner recovery archives

**Requirements:** R-CFG-02/03/04/09/15, R-SEC-04/10/11/14, R-STO-03, R-SYS-10. **Dependencies:** Tasks 4/5. **Deliverable:** consistent bounded backup, preflight preview, transactional restore and credentials/session replacement.

**Files:** create `packages/yonder-core/src/recovery/{schema,canonical,export,import,service}.ts` and tests; existing config schema and secret codecs are reused; Task 8 creates and integrates the dedicated `src/console/recovery.ts` transport. No custom-flow handling.

**Interfaces:** `RecoveryArchiveV1` as defined above; `preview` returns an opaque session-bound expiring restore ID and a safe summary, never secrets. `commit` consumes that ID plus current administrator reauthentication and the reviewed state revision. A changed destination or staged archive invalidates preview. Export returns bytes only to the dedicated authenticated download path.

- [ ] Define strict known-field schemas, payload serialization/checksum, byte/depth/count limits and explicit source-version policy. Reject future schema/archive versions, invalid hashes, unknown archive sections, malicious usernames/SSH settings and invalid identity files before writing active state.
- [ ] Snapshot known config/secrets, owner projection and ZeroTier state consistently. Pause/quiesce an identity writer only when necessary under the shared operation guard; bound interruption and resume on failure. No archive path or file selector is supplied by the caller.
- [ ] Preview replacement credentials, mesh identity, destination compatibility and exclusions. Carry absent-device settings only where the config schema/runtime can represent them safely; never map an old UART/camera to another device silently. Keep destination firmware/driver/boot setup.
- [ ] Commit via the state coordinator, with persistent recovery across reboot and failed activation. Disclose service/network interruption before commit. Revoke old console/editor sessions after success using the existing reset-auth mechanism; restored credentials are authoritative afterward.
- [ ] Remove staged temporary archive files on success, cancellation, expiry and failure. Store them root-private with 0600 files; refuse exports beyond the declared maximum instead of truncating. No backup bytes in logs, support bundles or URLs. Observe and validate ZeroTier identity/public-key agreement using the installed tool before projection; quiesce it for capture/projection, resume on failure, and regenerate only its supported membership state without importing arbitrary network configuration files.

**Acceptance:** flash/setup/restore recovers supported settings, owner login and mesh identity; corrupted or incompatible backup leaves current configuration/credentials untouched; stale/session-spoofed preview fails; a cut during restore recovers a complete generation; nothing imports Node-RED runtime/custom flows, OS account databases, boot files or recordings. Browser-only Flight state is explicitly excluded in output/UI.

**Verification:** generated fixture archives and boundary/invariant tests; integration with real credential stores and helper projections; fake external commands only for unit tests, plus a real Linux restore scenario in Task 11. Test exact maximum/over-maximum bytes at both proxy and daemon, and absence of secrets in captured logs.

**Execution recommendation:** Sol for transactional activation, Terra for strict schema/export once interfaces are fixed; independent of UI presentation after contract settlement.

## Task 7 — Install protected boot, persistence and apt maintenance

**Requirements:** R-STO-01/02/03/04/05/06/07, R-CFG-08/14, R-SEC-12. **Dependencies:** Tasks 2/3/4/5. **Deliverable:** production boot/mount behavior proven by Task 2, shared with image assembly and account/recovery operations.

**Files:** create `installer/storage/` with only the initramfs/mount hooks established in discovery, `installer/roles/12-storage.sh`, `packages/yonder-core/src/storage/{model,maintenance,cli}.ts`, tests and necessary systemd units/tmpfiles/journald drop-ins; update existing service paths/mount dependencies serially. Extend the root helper for fixed maintenance operations, after Task 5 protocol is settled if needed.

**Interfaces:** `StorageStatus` reports `managed:boolean`, observed `mode: protected|maintenance|transition-pending|failed|null`, persistent-state health and whether a reboot is needed; `enter/exit` are explicit guarded operations. A conventional live install reports `managed:false, mode:null` as standard writable Linux; protection controls are unavailable, and the installer never repartitions that device. Owner/config operations still work on its conventional persistent filesystem, without image-protection claims. `image/storage-layout.json` is the single layout input, not a second runtime policy list.

- [ ] Implement protected system and boot mounts, bounded volatile writes and separate persistent/media mounts. Honor actual filesystem labels/UUIDs and boot firmware placement. Remove conflicting first-login/root-growth behavior only for the selected base versions.
- [ ] Apply persistence mappings from the write inventory, including owner account/SSH state and managed secret stores. Ensure normal account/config writes survive. Keep generated/reconstructable state transient where practical; do not make arbitrary `/var` persist by default.
- [ ] Implement the approved bounded persistent journal with `SyncIntervalSec=10s`, immediate synchronization for critical/alert/emergency records, rotation/headroom isolated from state/media, and bounded RAM fallback. Remove duplicate syslog and Armbian RAM-log copies; reuse/review the existing opt-in command-tracing patch. Verify previous-boot logs survive, log-full cannot exhaust state, and measure actual block writes. The interval is a normal-I/O sync target, not a strict tail-loss bound or physical-write cadence.
- [ ] Install recovery ordering before dependent services. Handle low/full state, RAM exhaustion, missing media and mount failure distinctly; preserve an honest recovery surface without hiding disk failure or writing credentials into an unintended root directory.
- [ ] Provide `yonder-maintenance status|enter|exit` for the local Linux owner, with changes requiring sudo and the same observed-state checks and operation guard as Settings. Implement maintenance transitions through the fixed helper operations; serialize against config/restore/account changes. Reuse the existing armed/reboot refusal for disruptive operations. A restart-based transition may be used if discovery requires it; no caller can request an arbitrary mount or command.
- [ ] Verify apt writes the real package database and files and updates initramfs/boot correctly. Return to protection on exit and ordinary boot; automatic/background apt work must not mutate protected system storage. Warn that a power cut during maintenance may require reflash.

**Acceptance:** mount observations match UI state; ordinary logs/temp do not write the system partition; settings persist; media-full does not fill state; apt install/update persists after exit/reboot; an unexpected restart doesn't silently remain in maintenance. Failures report actual state instead of claiming protection is enabled.

**Verification:** production hook tests against disposable base images, namespace/mount integration and actual apt package install; size-pressure tests; power cuts in Task 11. New host/kernel behavior requires the established discovery evidence, not mocks of `findmnt` alone.

**Execution recommendation:** Sol/high for boot/persistence integration; serialized with image/shared installer edits. This and Task 6 may overlap after the state/helper contract is fixed and ownership is disjoint.

## Task 8 — Wire authenticated APIs and Settings

**Requirements:** R-SYS-10, R-CFG-15, R-STO-07, R-SEC-04/09/10/11/12/14, R-UI-12/16/19. **Dependencies:** Tasks 5/6/7. **Deliverable:** owner account, backup/restore and observed maintenance controls usable in the shipped console.

**Files:** modify `packages/yonder-core/src/daemon/{routes,server}.ts`, `src/console/{maintenance,client,settings,reset-auth}.ts`, relevant tests; create focused `src/daemon/owner-tools.ts` and `src/console/recovery.ts`; modify `packages/node-red-dashboard-2-yonder/src/ui/{YonderSettings.vue,maintenance-api.ts,maintenance.css,maintenance.component.test.ts}` and add `OwnerAccess.vue`, `RecoverySettings.vue`, `StorageSettings.vue` with tests; extend real verification fixtures/scripts and operator guides. Parent Settings composes components; do not put all implementation into one large Vue file.

**Interfaces:** see the endpoint table below. Root socket remains internal; the web proxy supplies session ownership, content limits and same-origin protection. Preview/commit tokens never substitute for current-password verification.

- [ ] Wire the service modules once and share the coordinator/helper clients. Retain existing auth throttle/session invalidation rather than implementing parallel password verification. Install route-specific body limits on the daemon before buffering as well as on the public proxy.
- [ ] Build owner account create/state/password/key/SSH controls. Keep sensitive input local to the component and clear it after submission/unmount. Never seed password/hash/key-private content into a form or Dashboard datastore.
- [ ] Add Download backup, upload/preflight summary and explicit Restore; show credential replacement, network interruption, same-identity replacement and excluded content before commit. Permit a clear retry after transport loss by checking operation state, not automatically resubmitting a mutation.
- [ ] Add actual storage protection/maintenance state and explicit entry/exit, with backup nearby. Keep apt available through the normal Linux account; this is not an arbitrary package-execution API.
- [ ] Preserve first-run AP/setup gate and the recovery console if a helper/storage/media operation fails. Session loss after restore must lead to sign-in with restored credentials, not an apparent generic server error.
- [ ] Document local setup, sudo/SSH, backup handling, post-reflash restore and maintenance. Include browser-only Flight export and no custom-flow/package backup limits. Amend current test fixtures so the photographed console is the installed console.

**Acceptance:** unauthenticated/incorrect-password/cross-origin/oversized requests never reach mutators; unprovisioned board still offers only console password setup; authorized owner can complete each operation and observe its result. Node-RED UID cannot read protected state or connect to the root helper. All new controls are readable in both palettes at tablet/narrow widths; known pending hardware checks remain visible in reports.

**Verification:** new route/proxy/component tests, existing maintenance/credential/reset-auth suites; `./scripts/verify-console.sh` and full required `./scripts/verify-pages.sh` at final integration. Local focused browser iteration may use supported capture flags only with a running stack; do not invent smoke flags or autoaccept baselines. User/operator smoke: create owner, download backup, inspect restore warning and find maintenance status; record who observed it and result or mark pending.

**Execution recommendation:** lead integrates shared files; Terra for disjoint Settings components once endpoints are fixed. One integrated consequential review includes auth, persistence and helper boundaries.

## Task 9 — Assemble and inspect all three final images

**Requirements:** R-HW-04, R-CFG-07/08, R-SEC-07, R-STO-04/07, R-UI-19. **Dependencies:** Tasks 3/7/8 and board facts from Task 2. **Deliverable:** complete independently inspectable `.img.xz` artifacts with provenance.

**Files:** create `image/{build.sh,prepare-payload.sh,capture-inputs.sh,verify.sh,finalize.sh,test.sh}`, focused `image/lib/` helpers, base lock, target manifests and tests; document CLI in `image/README.md` and `installer/README.md`.

**Interfaces:** input contract above; output `yonder-VERSION-TARGET-arm64.img.xz`, adjacent `.sha256`, and the same target-specific stem with `.build.json`, `.packages.tsv`, `.verification.json` suffixes. No generic filenames collide when three targets share an output directory. Record source SHA, base hash, input-set ID, build tool digests and exact target. Report runtime/hardware acceptance separately from static success.

- [ ] Implement `image/capture-inputs.sh --target TARGET --output DIR` to prepare a reviewable candidate input set, then lock its identities/hashes before release assembly; this is an explicit refresh operation, never an implicit fallback from a failed locked build. Resolve and retain verified base/APT/payload inputs. Separate release-build package sources from owner maintenance apt sources. Build all first-party artifacts and standalone core production dependencies with target-compatible native bindings.
- [ ] Inspect layouts, allocate output space, attach only owned loop devices and use a private mount namespace. Create storage layout without touching upstream bootloader sectors. Mount actual target boot/root paths and invoke the image installer with the target.
- [ ] Verify application module graphs and shipped flow-node availability without starting the daemon; verify unit links, executable architectures, ownership and required paths. Do not infer radios/encoders from CI devices.
- [ ] Finalize per-device state: remove owner credentials, machine/SSH/mesh identities, network profiles from the builder, logs and caches. Keep public AP defaults and intended boot setup. Assert root login/SSH defaults, protection hooks, payload completeness and no stray service suppression/resolver mounts.
- [ ] Flush/unmount/check filesystems and compress only after success. Kill/failure injection must prove cleanup of owned mounts/loops and absence of a success manifest. Rebuild from the same captured input set on a clean builder and compare package/content manifests.

**Acceptance:** each target image passes its own structural/static checks; input corruption/mismatch fails before execution; no host identity or secret is present; the storage and boot partition contract matches target metadata; a successful build is not labeled hardware-qualified. Media and state filesystems cannot be consumed by upstream first-boot expansion.

**Verification:** new `./image/test.sh` (to be implemented: manifest, cleanup and disposable-image integration suites), existing installer tests, real native ARM64 build; shellcheck on all new scripts. No final image build is possible on the macOS host alone without an appropriate Linux builder.

**Execution recommendation:** Terra for bounded image plumbing after storage contracts, Sol/lead for mount/cleanup integration. One target first, then matrix expansion.

## Task 10 — GitHub matrix, retained inputs and draft releases

**Requirements:** R-HW-04, R-SEC-07, R-CFG-15 recovery linkage; CalVer contract. **Dependencies:** Task 9. **Deliverable:** manual builds and tag-driven draft releases using tested image scripts.

**Files:** create `.github/workflows/images.yml`, add image checks to `.github/workflows/ci.yml`, create a narrowly scoped draft-upload helper under `image/`, update `image/README.md`, `docs/versioning.md`, `CHANGELOG.md` and getting-started download instructions.

**Interfaces:** manual input `target=all|rpi|radxa-zero3w|radxa-rock5c`; release tags require `all`. Jobs consume captured input-set manifests and produce the exact Task 9 artifacts. Use `IMAGE_RUNNER` or explicit native ARM64 label independently of `CI_RUNNER`; verify runner architecture early.

- [ ] Pin Actions/tooling and use minimal read permissions for build jobs. Add a publish-to-draft job with write permission only after all required target results pass. Never automatically toggle draft off.
- [ ] Validate CalVer tag equals checked-out source version, source is on the authorized release lineage and required CI passed for that revision. Reject unrelated/unreviewed refs rather than trusting the tag name alone.
- [ ] Attach checksummed input-set bundles and their index to the same draft release, alongside the image artifacts, with suitable license/source notices; this is the default archive, avoiding a new external storage service. Validate current asset size limits and split bundles if needed, retaining a complete index. Refuse to mark the release rebuildable if required inputs cannot be retained. Authenticate access to private/draft assets without recording tokens in manifests; use caches only to accelerate fetching. Record storage/retention cost and avoid indefinite retention of every PR image.
- [ ] Make retry behavior explicit: reuse matching immutable artifacts or create a distinctly identified candidate; do not overwrite a hash already recorded as hardware-tested. Failed matrix targets leave no complete-success release state.
- [ ] Test manual selection, one failed target, duplicate/retried tag job and all-success draft assembly in a controlled workflow run. No public publication or repository visibility change is part of this task.

**Acceptance:** one tag yields all three files/checksums/manifests in a draft; a failure cannot be mistaken for full success; reruns preserve evidence-to-artifact identity; manual single-board runs are clearly not full release candidates; public/private repository settings do not bypass the draft gate.

**Verification:** workflow syntax/lint and isolated script tests; actual authorized GitHub run on the candidate revision, downloaded checksums verified; measured disk/runtime/artifact usage. Do not claim workflow success from YAML inspection alone.

**Execution recommendation:** Terra/medium after local build interface stabilizes; lead owns release permissions and artifact identity review.

## Task 11 — Fresh-flash, power-cut and recovery qualification

**Requirements:** all hardware/user acceptance in the spec. **Dependencies:** complete candidate from Task 10 (Task 9 artifacts may support early tests). **Deliverable:** per-board evidence linked to exact image hashes, with explicit passed/pending/failed status.

**Files:** create `docs/hardware/image-qualification/{rpi3,rpi4,rpi5,radxa-zero3w,radxa-rock5c}.md`, common test protocol and machine-readable evidence manifest; update user guide, hardware support table and draft release notes. No changing production behavior in the evidence-only task; failures return to the owning task with a concrete reproduction.

**Interfaces:** consumes immutable image hashes, hardware details and recorded operation checkpoints. Produces qualification data for manual publication. No human observation is assumed merely because a checklist exists.

- [ ] Arrange a named operator (user or explicitly authorized hardware operator), actual boards/cards and a safe bench power-cut setup. Record missing equipment as pending. Do not issue aircraft commands or test on an active aircraft.
- [ ] Fresh-flash each board and perform offline AP/DHCP/setup, local owner creation and login/sudo, browser owner management, SSH password/key modes, network recovery and reboot. Test exact Pi/Radxa UART/video/camera combinations; absent devices remain unqualified.
- [ ] Run at least 20 normal-operation power cuts per available board: five during boot/idle, five during settings/credential mutations, five during owner/restore transitions, five while recording. Vary timing across observable stages; add software kill tests for each transaction boundary. More cuts are required after a related failure/fix, not as a claim of statistical immunity.
- [ ] After each cut, inspect boot health, AP/console, complete old/new configuration and matching credentials, account consistency and completed media. Capture filesystem recovery messages. Verify prior-boot logs and bounded tail loss; test low/full log, state, media and volatile storage separately.
- [ ] Install a small real apt package in maintenance, exit/reboot and verify persistence and protection. Reflash and restore a downloaded backup; verify restored Yonder/Linux access and mesh identity without concurrently operating the original identity. Include invalid/cross-board backup rejection or explicit compatibility handling.
- [ ] User smoke: from a clean boot, locate setup, create owner access, save backup and identify the maintenance/recovery controls without terminal instructions. Record observer and outcome, both software evidence and any unfinished physical checks.
- [ ] Update draft evidence; publication remains explicit and uses these exact hashes. An experimental target can be labeled pending, but cannot be described as supported/power-cut-qualified.

**Acceptance:** no unexplained corrupt/mixed acknowledged configuration, inaccessible owner account or lost AP recovery in the required successful qualification run; failures remain blockers for that claim. Lost buffered frames in an interrupted recording are distinguished from loss of completed recordings or system/state corruption. Missing board evidence prevents a claim of complete five-board qualification.

**Verification:** real hardware and human evidence plus relevant focused regression tests after fixes. Neither existing 5,080-test historical results nor new mocks substitute for this task.

**Execution recommendation:** lead coordinates one hardware operator/resource at a time; Terra can structure evidence after observations, not invent it.

## Combined final checks

Run from the isolated current-main implementation tree, once against the integrated revision after focused checks have passed:

```sh
npm ci
npm run version:check
npm run lint
npm run test --workspaces --if-present -- --maxWorkers=4 --minWorkers=1
npm run build
npm run schema -w yonder-core
npm run defaults -w yonder-core
git diff --exit-code config/schema config/defaults
./installer/install.sh --dry-run
./scripts/verify-installer-lib.sh
./installer/make-payload.sh --arch linux-x64 --only console
./scripts/verify-console.sh
./scripts/verify-pages.sh
git diff --check
```

Use actual CI setup for browser dependencies and current shellcheck file coverage, extended to every new installer/image/helper shell script. On an ARM64 final-check host stage `linux-arm64` for its executable console instead; CI's existing browser path is x64. Also run the current Node-20 core floor job, router/Rockchip payload checks, new state/account/recovery integration and image test suites, actual three-image build, and Task 11's separate qualification. Reconcile commands with any main changes; do not silently substitute an unsupported smoke flag or omit a failing existing gate. Inspect visual baseline changes before committing them.

## Historical evidence reconciliation

Read [recovered storage/boot evidence](../../hardware/storage-history-review.md) before further Task 2 work. Reuse the existing Radxa repair/boot/shrink and Pi reboot results within their tested scope. Preserve the existing command-tracing patch for evaluation. The user confirmed bounded persistent logs with a 10-second sync interval after this review; A/B slots and custom-flow preservation remain excluded by current decisions.

## Discovery progress — 10 September 2026

The [initial storage discovery report](../../hardware/image-storage-discovery.md) records read-only Pi 4/ZERO 3W evidence and a passing disposable ARM64 Debian mount/account/apt prototype. Exact pinned downloads now have checksum/partition evidence and selected read-only boot-file observations; both Armbian signatures were verified. Task 2 remains incomplete: final bootloader/initramfs analysis, Pi signature verification, real boot/login/upgrade tests, memory sizing and power-cut qualification remain pending. No production storage layout is validated yet.

## Plan completion record

This plan is a design-to-implementation handoff, not implementation completion. Specialist findings are integrated by the lead, with one final self-review for spec coverage, consistent interfaces, dependency order and material uncertainties. Hardware/base-layout discovery remains an explicit prerequisite with pass/fail criteria. Production code, images, board tests and GitHub releases have not been created by this planning session.

## Implementation progress — foundation

Task 1 is complete on `codex/image-storage-discovery` from the recorded baseline,
tracked by [issue 11](https://github.com/boydsoftprez/yonder/issues/11). Baseline dependency
installation, version consistency and 5,149 workspace tests passed. Base-fetch and
read-only inspector tools are implemented, including checksum-bound evidence, bounded
input/decompression and validated primary/backup GPT metadata. All three actual bases
pass inspection; they remain unqualified hardware candidates.

Task 3's installer changes are implemented for review: explicit image/target preflight,
ARM64 payload closure, offline service handling, package-start suppression, hardware
isolation, and separate Pi/ZERO 3W preparation. ROCK 5C intentionally refuses before
mutation until its UART preparation is established. Focused verifiers and the 127-test
installer suite pass; a disposable ARM64 Debian integration demonstrated actual apt
service suppression and offline unit enablement. The complete ARM64 payload is now built and full installer exercises use extracted
base userlands; see [the integration record](../../hardware/image-installer-integration.md).
A faithful mounted-image installation and ROCK 5C preparation remain pending, so Task 3
is not marked complete. Integrated review findings led to cancellation-safe policy
restoration, exact Rockchip soname and recursive Node-dependency checks. Actual Armbian
integration exposed untracked service-enable links, now handled through offline systemctl.

No finished image or image-release workflow exists yet. The next dependency is a
reviewable disposable boot/storage prototype using the observed base hooks, followed by
physical validation before the final persistence layout is accepted. The original plan
completion record above describes plan writing, not the implementation work recorded here.

## User-directed ROCK 5C bench priority

The operator prioritized a flashable ROCK 5C bench image before protected-storage work,
then physical UART and Divimath SeekerHD CSI/H.265 qualification. This is an explicit
private hardware-test branch of the work, not a supported release or proof of final
storage/owner recovery. Preserve the AP-first experience; Ethernet is not a prerequisite.
The operator approved temporary bench SSH on a separate account with password/key login,
password-required sudo and no remote root. Final release SSH remains off by default.

Use the exact locked ROCK 5C base and built ARM64 payload. Retain the board bootloader
region, grow only the copied root/image for this experiment, and preserve filesystem
metadata through an actual Linux mount. Add an explicit hardware-test installer flag;
ordinary ROCK 5C image installation remains gated while qualification is pending.
UART preparation follows observed board assets and vendor pinout; never copy the ZERO
3W camera/UART setup merely because its overlay files exist in the shared kernel package.
Keep the normal writable filesystem explicitly labeled as unqualified for power cuts.

Deliver a local `.img.xz`, checksum, non-secret provenance manifest and private access
instructions. The AP/console must remain independent of camera success. Stage diagnostic
tools and bench sources; do not claim SeekerHD support before its different connector,
control voltage, device-tree path and ISP generation are validated. The operator currently
has only the SeekerHD cable; CSI connection awaits a verified adapter. Test the H.265
encoder first with a generated pattern, then the real sensor path when connected safely.

### Immediate ZERO 3W bench flash

The operator subsequently has the ZERO 3W available and explicitly requested
flashing the inserted 32 GB SD card with its image. Reuse the same approved
private bench access and writable-storage scope, selecting the ZERO 3W's own
locked base, inspected identifiers and existing board installer target. Keep
the ROCK 5C artifact separate. Validate image identity and removable card
identity before writing, then verify the full written image by read-back
checksum and eject. First boot/AP and hardware testing follow on the ZERO 3W.

### ZERO 3W provisioning correction — 11 September bench finding

R-CAM-01, R-CAM-14, R-HW-03, R-HW-04. The merged SeekerHD application was
present while its board driver/overlay/ISP setup was still manual. See the
[provisioning audit](../../hardware/image-provisioning-audit.md).

- [x] Build a pinned ARM64 SeekerHD ISP payload and tuning profiles from the
  existing reviewed sources; require it for ZERO 3W image assembly.
- [x] Install the matching sensor driver with package-manager kernel rebuild
  support, compose its overlay with the actual base tree and UART overlay,
  and install camera startup services without making the console depend on
  a physically attached camera.
- [x] Verify the installed kernel module, overlay, runtime libraries, profile
  checksums and enabled services inside the assembled filesystem.
- [x] Build a new candidate and verify actual sensor discovery and H.265 capture
  on the ZERO 3W, preserving owner configuration on the current board.

Verification: exercise missing/corrupt payload rejection and absent-camera
startup; build the real ARM64 payload and target-root kernel module; inspect
assembled artifacts. Pin-level UART, camera output and cold-boot behavior need
hardware evidence. Never enable experimental HDR or infer ROCK 5C compatibility
from ZERO 3W results. The next image must not pass provisioning checks with the
camera stack omitted.

Result: the camera stack was installed on bench02, then detected after reboot
through Yonder's own camera API. A bounded 90-frame 1080p CSI-to-H.265 capture
completed successfully. Bench04 was assembled from the final reviewed installer
source, including runtime dependencies and DKMS interrupted-install recovery.
Fresh-card boot of bench04 and physical camera-absent boot remain separate
hardware qualification checks; the successful live retrofit is not relabelled
as either of those tests.

### Return to image work — protected-storage checkpoint

The operator resumed the SD-image work after camera bring-up and requested the
remaining work followed by another ZERO 3W image. Task 2's physical boot gate
still precedes production owner/recovery implementation. The next candidate is
therefore explicitly a protected-storage boot prototype, preserving the latest
application fixes and temporary bench access, rather than another unchanged
writable image. This checkpoint does not close Tasks 4–10.

See [prototype behavior and limitations](../../../image/prototype/README.md).
The candidate layout is fixed at 8 GiB (6 GiB system, 512 MiB state, 256 MiB
logs, remaining image space media). Mount/namespace tests, actual initramfs
content, independent filesystem checks and source-to-installed artifact hashes
must pass before delivery; physical first boot, memory sizing and power cuts
remain pending. The state/owner/restore contract is not weakened or replaced
by the prototype's path mounts. No production storage-layout entry is marked
validated until the boot experiment provides its required evidence.
