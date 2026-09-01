# Known issues

Real defects and gaps, recorded rather than forgotten. Each says what breaks and when it
starts to matter. Fix them when they become load-bearing, not before — but do not
rediscover them.

Nothing here is a requirement. Requirements live in [`requirements.md`](requirements.md).

---

## Must be resolved during M1

### K-01 · The daemon socket is unreachable by the console
`systemd/yonder-core.service`, `src/daemon/server.ts`

The unit sets no `User=` or `Group=`, so the daemon runs as root and the socket is created
`root:root` mode `0660`. `RuntimeDirectory` is `0750`, so `/run/yonder` is root-only too.

The design says filesystem ownership is the access control for the configuration API. That
model is not expressed anywhere yet: as it stands, a console running as a non-root user
cannot open the socket at all. M1 introduces that console, so M1 has to settle the
ownership model — a shared group, a `User=`/`Group=` on the unit, and matching modes on the
runtime directory and the socket.

---

## General

### K-04 · Test files are never type-checked
`packages/yonder-core/tsconfig.json`

`tsconfig.json` excludes `*.test.ts`, and `npm run lint` uses that config. `vitest` strips
types via esbuild without checking them. So **no CI step type-checks test code at all** — the
gap is total, not partial. A separate `tsconfig.lint.json` without the exclude fixes it while
keeping tests out of `dist/`.

### K-05 · Development dependency advisories
`npm audit` reports several transitive advisories through the pinned `vitest ^2.1.0`
(esbuild/vite). All development-only and outside the runtime dependency closure; the
esbuild advisory needs a dev server this project never runs. Resolve with a deliberate
vitest major bump, and add `npm audit --omit=dev` to CI so the closure that actually flies
is the one being checked.

### K-06 · No request body size limit
`src/daemon/server.ts`

Request bodies accumulate unbounded; 5 MB goes through without complaint. Low severity
behind a root-only socket, but an OOM kill of the configuration daemon on a 512 MB board is
a safety event, not an inconvenience.

### K-07 · The socket has no lock
`src/daemon/server.ts`

Startup unconditionally unlinks any existing socket, including one held by a live second
instance — which would silently steal the configuration API from a running daemon.

### K-08 · `--only` with an unknown role name succeeds silently
`installer/install.sh`

A name matching no role skips every role and exits 0 reporting "done".
`--only 20-yonder-core.sh` (extension included) installs nothing and claims success.

### K-09 · Smaller edges
- `Journal.write` does not clean up its temp file on the error path, unlike `saveConfig` and
  `SecretStore.flush`. Self-heals on the next write.
- `saveConfig` reports "cannot write" when only the post-rename directory fsync failed —
  i.e. after the data actually landed. The message is wrong about what happened.
- The installer copies `*.test.ts` to the target. Excluded from the build, so dead weight
  rather than a defect.
- `require_node` errors under `set -e` if `node -p` ever emits non-numeric output.
- `writeFileDurable`'s leading unlink of the temp path defeats the `wx` exclusivity it
  documents, if two writers ever race the same path. Related to K-07.

### K-10 · A render timeout rolls the configuration back but not the system
`src/apply/engine.ts`

When a renderer exceeds `renderTimeoutMs`, `apply()` restores `config.yaml` to the previous
configuration and then **deliberately skips the rollback re-render** — a renderer that has
just timed out is presumed still wedged, and retrying it would hold the apply reservation
for a second full timeout before failing again the same way.

The consequence is that the file on disk and the running system can disagree. The renderer
may have applied part of the change before it stalled: a NetworkManager connection modified,
a drop-in written, a profile brought up. Nothing undoes that. `config.yaml` says one thing,
`nmcli` says another, and `GET /config` reports the file.

Bounded in practice — the access-point fallback still raises the access point if the board
ends up unreachable, so this is a divergence rather than a lockout. It starts to matter when
the console shows a configuration the board is not actually running, which is the moment
somebody trusts the screen over the radio. The fix is a renderer that can report what it
managed to do before it stalled, or a reconciling render on the next start; the startup
render added for R-CFG-08 already narrows the window to "until the daemon next restarts".

### K-11 · The fallback watchdog fires once per daemon start, and never again
`src/net/watchdog.ts`, `src/daemon/server.ts`

`FallbackWatchdog.start()` sets a single timer and `fire()` clears it. It is armed once, in
`startServer()`, and nothing re-arms it — not an apply, not a confirm, not a revert. After
that one check the guarantee is spent for the life of the process.

R-NET-07 is written about boot, so this satisfies it as worded. What it does not cover is
the case the requirement exists for: an operator applies a change that takes the board off
the air *after* the window has already elapsed. The apply confirmation timer catches the
unconfirmed case, but a change that is confirmed — or one whose damage appears later than
the render — leaves no watchdog behind it. It starts to matter with M1b, where a console
makes applying changes routine and a device may run for days between restarts. The fix is to
re-arm on every apply and confirm, which is small; it is recorded rather than done because
M1a's exit criterion is the boot path.
