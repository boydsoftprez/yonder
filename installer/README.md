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

## Building an offline payload

`20-yonder-core.sh` will install a prebuilt `yonder-core` rather than fetching
and building one, and `install_bundled_node` will install a vendored Node
runtime rather than reaching for the distro package. Together those are an
install that touches the network for nothing. Neither is present in a
checkout, and neither is produced by any step above — this is how to make
them.

**The daemon.** `packages/yonder-core` needs a `dist/` and a `node_modules/`
holding its *production* dependencies:

```sh
npm run build -w yonder-core
npm ci --omit=dev --prefix packages/yonder-core --workspaces=false
```

`--workspaces=false` is the part that matters. Without it npm hoists the
dependencies to the repository root, which is not what gets copied to the
board: only `packages/yonder-core/node_modules` is. A tree hoisted that way
looks complete from the repository root and arrives on the board empty.

`node_modules/.vite` — a vitest cache, created by `npm test` — is **not** a
dependency tree. The installer says so and builds instead of trusting it.

**The Node runtime.** Unpack a Linux build for the board's architecture
(`arm64` for a Raspberry Pi 4 or 5) into `vendor/node`, so that
`vendor/node/bin/node` exists. It is a downloaded binary rather than source,
so `.gitignore` keeps it out of the repository.

**Checking the payload before it is flashed.** A dry run reports which route
each half took:

```
bundled node found at …/vendor/node; installing to /opt/yonder/node, …
prebuilt dist/ and a complete node_modules/ found in …; using them, …
```

Anything else means that half will be built or fetched on the board. The
installer refuses to trust a half-built tree rather than copying one: a
`node_modules` without the daemon's dependencies in it produces
`ERR_MODULE_NOT_FOUND` on the board's first start, and under `Restart=always`
that is a crash loop with no socket, no access point and no console. On a real
install the daemon's entry point is loaded, imports and all, before anything
is enabled.
