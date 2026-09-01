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

### K-02 · `apply()` has no render timeout
`src/apply/engine.ts`

The apply reservation is held for the whole duration of `renderAll`. A renderer that throws
is handled; a renderer that **never settles** pins the engine in `applying` permanently, and
every later apply is refused with "an apply is already pending".

Harmless today because there are no renderers. M1 adds the first real one, and a network
apply can hang on a wedged `nmcli` or a driver that never returns. Needs a timeout that
fails the apply and rolls back, not an indefinite wait.

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
