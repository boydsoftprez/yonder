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

Yonder installs without a network (R-CFG-07). `install_bundled_node` installs
a vendored Node runtime rather than reaching for the distro package,
`20-yonder-core.sh` installs a prebuilt `yonder-core` rather than building
one, and `30-console.sh` copies a prebuilt console rather than fetching
Node-RED. None of those is present in a checkout. This is how to make them.

**Everything an install needs and this repository does not carry — the Node
runtime, ZeroTier, `mavlink-router` and the console — comes from one
script:**

```sh
./installer/make-payload.sh --arch linux-arm64     # a Raspberry Pi or Radxa
./installer/make-payload.sh --arch linux-x64       # a PC
./installer/make-payload.sh --arch linux-arm64 --only console   # just one part
```

It stages `vendor/node/bin/node`,
`vendor/zerotier/zerotier-one_<version>_<arch>.deb`,
`vendor/mavlink-router/mavlink-routerd` and
`vendor/console/node_modules/node-red/red.js`, and it is re-runnable: each run
replaces what the last one left. `--only` narrows a run to one or more of
`node`, `zerotier`, `mavlink-router` and `console`; what it does not stage it
leaves exactly as an earlier run left it, so it is a way to update one part of
a payload rather than a way to build a smaller one. `vendor/` is downloaded
and built binaries rather than source, so `.gitignore` keeps it out of the
repository.

What it stages:

- `vendor/zerotier/zerotier-one_<version>_<arch>.deb` — the primary mesh client.
  One file, ~2.7 MB, depending only on `adduser`, `libstdc++6` and `openssl`, all
  of which a stock Debian board already has. Pinned, fingerprinted, and verified
  against ZeroTier's repository signature using `installer/keys/zerotier.gpg`.
  Installed by role `40-zerotier`, which leaves it stopped and disabled until
  a network is configured (R-VPN-05, R-VPN-08). **Disabled offline**, with
  `deb-systemd-helper` rather than `systemctl`: the package's `postinst`
  enables the unit with `deb-systemd-helper enable`, which writes the `.wants`
  symlink straight to the filesystem and so works perfectly well in a chroot,
  while `systemctl disable` in that same chroot answers `Running in chroot,
  ignoring request` and exits 0. An image built with the latter shipped the
  client enabled, and nothing on the device would ever have turned it off —
  `yonder-core` only stops a client it has a record of starting, and a fresh
  image has none. The role asserts the result rather than assuming it, so a
  build that cannot disable the unit fails where the message can be read.
  Tailscale is **not** carried: it is 31 MB, pulls in `iptables` and two
  libraries that a board does not have, and switches four `update-alternatives`
  entries. It is fetched over the network and installed when Tailscale is
  configured (R-VPN-08).

- `vendor/mavlink-router/mavlink-routerd` — the service that owns the serial
  port and fans MAVLink out to the ground stations. One file, 325 KB stripped,
  needing nothing but `libc6`, `libstdc++6` and `libgcc-s1`, which every Debian
  board already has — so the role that installs it calls no package manager at
  all. Installed by role `15-mavlink-router`, which leaves it **stopped and
  disabled** (R-MAV-17): `yonder-core` starts it, and only once detection has
  found a port and a speed and generated `/etc/mavlink-router/main.conf`. A
  unit enabled at install would open the serial port at every boot before the
  sweep could, which is the one resource the two of them contend for.

  **It is the only component that is built rather than downloaded.** It is not
  in Debian and publishes no binary, so `make-payload.sh` clones the pinned
  commit, checks that the checkout *is* that commit, and builds it inside a
  `debian:trixie` container for the target's architecture — Docker or Podman,
  and there is no third option, because a C++ build for another architecture
  needs that architecture's toolchain. The post-condition is the built binary's
  own `--version` reporting the pinned commit, run inside the same container,
  which is the only place an arm64 binary can be executed on an x86 build host.

  **The pin is a commit, and that commit is the fingerprint.** Node and
  ZeroTier are downloads, so a recorded `sha256` is what says the bytes are the
  bytes. Here the bytes come out of a compiler, and a compiler's output moves
  with its version — a hash of the *binary* would fail the day Debian updated
  gcc rather than the day somebody changed the source. A git commit id is a
  hash over the complete tree, every submodule included, so checking it checks
  precisely the input the build consumes.

  Building on the board was measured and rejected: a stock image is missing
  `meson`, `ninja-build`, `libsystemd-dev` **and** `systemd-dev` — the build
  asks pkg-config for `systemd`, not `libsystemd`, so installing the obvious
  one still fails with a message naming neither — and a default parallel build
  is killed by the OOM killer on a 905 MiB Pi 4. See
  [an autopilot on the UART](../docs/hardware/an-autopilot-on-the-uart.md).

  The `payload-mavlink-router` job in CI builds the arm64 binary on every
  change to `make-payload.sh` and uploads it, so a payload can be assembled on
  a machine with no container runtime: download the artifact into
  `vendor/mavlink-router/` and the role takes it from there.

Two things it does that a by-hand download does not:

- **It verifies the Node tarball against the published `SHASUMS256.txt`** and
  refuses to unpack one that does not match. The thing being substituted would
  be the process that talks to an aircraft.
- **It resolves the console's dependencies for the *board*, not for the build
  machine** — `--os`, `--cpu` and `--libc`. Node-RED pulls `@node-rs/bcrypt`,
  whose real code is in a per-platform optional package, so a payload built on
  a laptop otherwise carries a macOS binary and no Linux one at all. Node-RED
  catches that and falls back to pure JavaScript, which is exactly why it
  would never have been noticed.

`installer/console/package-lock.json` **is** committed, and is what makes two
payloads built a week apart identical: the script installs with `npm ci` when
it is there, and writes one when it is not.

**Node 24, not 20.** Node 20 reached end of life in April 2026 and Node-RED 5
requires 22.9 or newer, so the payload's runtime is the current 24 LTS line.
The two roles still ask for different minimums, on purpose: `require_node 20`
in `20-yonder-core.sh` is genuinely the daemon's floor, and `require_node 22.12`
in `30-console.sh` is the floor that is actually true for the console — Node-RED
itself needs 22.9, but the generated `settings.js` and both contrib packages
`require()` an ES module, which node supports from 22.12. A board with a distro Node 20 and no payload
therefore installs a working daemon and fails loudly at the console, with a
reason, rather than installing a console that cannot start.

**The daemon.** `packages/yonder-core` also needs a `dist/` and a
`node_modules/` holding its *production* dependencies. That one is built from
this repository rather than downloaded, so it is not part of `make-payload.sh`:

```sh
npm run build -w yonder-core
npm ci --omit=dev --prefix packages/yonder-core --workspaces=false
```

`--workspaces=false` is the part that matters. Without it npm hoists the
dependencies to the repository root, which is not what gets copied to the
board: only `packages/yonder-core/node_modules` is. A tree hoisted that way
looks complete from the repository root and arrives on the board empty.

**The console's node packages.** `node-red-contrib-yonder-system` and
`node-red-contrib-yonder-network` are also built from this repository, and
`30-console.sh` copies their `dist/` into the console's `node_modules`. Unlike
the daemon there is **no fallback that builds them on the board**: they are
TypeScript compiled against the workspace's own tooling, and a board has none
of it. A missing `dist/` stops the install with a reason rather than producing
a console whose four pages are empty groups.

```sh
npm run build       # yonder-core first, then both contrib packages, in that order
```

The order is not decorative: `npm run --workspaces` does not sort
topologically, and the contrib packages type-resolve `yonder-core` through its
built declarations. The root `build` and `lint` scripts name the order for that
reason.

They have no runtime dependency but `yonder-core` itself, which the installer
**symlinks** into the console tree rather than copying — one device, one
`yonder-core`, and a copy would be a second version to keep in step. That is
also why `30-console.sh` needs node 22.12 rather than Node-RED's own 22.9: the
nodes are CommonJS and `yonder-core` is an ES module, and `require()` of an ES
module is what lets one package serve both the daemon and the console.

`node_modules/.vite` — a vitest cache, created by `npm test` — is **not** a
dependency tree. The installer says so and builds instead of trusting it.

`npm run build` also copies `src/**/assets` into `dist/`, which is how the
console's pages get onto a board. `tsc` copies only what it compiles, so a
`dist/` built any other way produces a console that answers every request
with a stack trace about a missing `setup.html`.

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
