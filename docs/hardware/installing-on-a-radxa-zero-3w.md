# Installing on a Radxa Zero 3W

What happened when `install.sh` was run on a stock Armbian board for the first time. The
encoder findings from the same board are in
[`hardware-encode-on-a-radxa-zero-3w.md`](hardware-encode-on-a-radxa-zero-3w.md); this note
is about getting Yonder onto it at all.

**The headline is that it works.** `architecture.md` §6 and `roadmap.md` both say Radxa is
"image-only in practice" because it needs the board vendor's BSP kernel and the Rockchip
MPP libraries. Neither half survives contact: Armbian ships the BSP kernel, `install.sh`
ran on it unmodified, and the MPP libraries arrive inside one published `.deb`. **Radxa is
installable.** Those two documents are wrong and are corrected in the design that cites
this note.

## The board as it arrived

| | |
|---|---|
| Board | Radxa ZERO 3 (`radxa,zero3`), RK3566, 4 × Cortex-A55, 1.9 GB RAM |
| OS | Armbian 26.8.1 trixie (Debian 13), kernel `6.1.115-vendor-rk35xx` |
| Card | one ext4 partition, 29 GB — **no FAT `/boot`**, so a Mac cannot read it in a reader |
| Networking | netplan → systemd-networkd, Wi-Fi via `netplan-wpa-wlan0` |
| Present | `yonder` user already created; no git, node, npm, or NetworkManager |

That single ext4 partition matters before you start: "pop the card in the laptop" is not a
recovery plan on macOS without ext4 tooling.

## The install failed three times before it completed

Two of the three are defects in the installer, not in the board.

**1. Role 20's build-on-the-board path is broken.** When `prebuilt_deps_present` rejects the
source tree — which it does for any plain `npm ci` in this workspace, because `yaml`, `zod`
and `zod-to-json-schema` hoist to the workspace root — the role falls back to building at
the destination. That path copies `package.json`, `package-lock.json`, `tsconfig.json` and
`src/`, but **not `scripts/`**, while the build script is `tsc && node scripts/copy-assets.mjs`:

```
Error: Cannot find module '/opt/yonder/packages/yonder-core/scripts/copy-assets.mjs'
```

The workaround is to make the source tree genuinely self-contained — build it outside the
workspace so nothing hoists — which makes role 20 take the prebuilt path and skip the
broken one. That is also the path R-CFG-07 intends.

**2. `yonder-core` crash-loops between roles 20 and 50, and `install.sh` exits 0 anyway.**
The unit declares `ReadWritePaths=/etc/yonder /var/lib/yonder /etc/mediamtx` with
`ProtectSystem=strict`. `/etc/mediamtx` is created by role **50**; role **20** enables and
starts the daemon. systemd cannot build the mount namespace for a path that does not exist:

```
yonder-core.service: Failed to set up mount namespacing: /etc/mediamtx: No such file or directory
Main process exited, code=exited, status=226/NAMESPACE
```

With `Restart=always` it burns its `StartLimitBurst` — observed at 48 restarts — so by the
time role 50 creates the directory systemd refuses to start it at all: *"Start request
repeated too quickly."* The installer then completes every role and exits 0, leaving a
working console and a **dead daemon**. Recovery is `systemctl reset-failed yonder-core`,
which an operator has no way to know. This is R-CFG-08 violated outright.

**3. The console role needs the contrib packages built.** `30-console.sh` dies with
`node-red-contrib-yonder-system has not been built` if `packages/*/dist` is absent. Build
them before copying the tree; the message says so plainly, which is the role behaving well.

## The offline payload works, and is worth using

`make-payload.sh --arch linux-arm64` staged Node, ZeroTier, mediamtx and the console, all
verified. Two additions made the install genuinely offline and are worth repeating: caching
every apt package first (`apt-get install --download-only`), and prebuilding `yonder-core`
on the board. With both done the install reaches for the network not once — which matters,
because the network is about to move underneath it.

## The thing that actually blocks Yonder on Armbian

**Armbian gives the interfaces to systemd-networkd, and netplan writes a NetworkManager
deny-list.** After a clean install:

```
end1:ethernet:unmanaged:
wlan0:wifi:unmanaged:
      Network File: /run/systemd/network/10-netplan-wlan0.network
```

`yonder-core` starts, writes all three profiles correctly — `yonder-ap`, `yonder-wifi`,
`yonder-eth` — and then cannot apply any of them:

```
network: bringing the wifi client up
network: the wifi client did not come up; raising the access point so the device stays reachable
yonder-core: could not render the current configuration, serving anyway
```

The cause is not netplan directly but a udev rule it generates,
`/run/udev/rules.d/90-netplan.rules`, which sets `NM_UNMANAGED=1` on `wlan0` and every
`e*`. That file is regenerated from `/etc/netplan/*.yaml` on every boot.

**The consequence is worse than "the network page does not work".** R-NET-07's rollback and
the R-NET-02 access-point fallback are both NetworkManager operations. On a board in this
state they are inert: the device *looks* fine because netplan is still holding the link,
and the safety net that is supposed to catch a bad configuration silently is not there.
An install that ends here reports success and has no fallback.

### Handing the interfaces over

Retiring the netplan configuration is enough — with no yaml, netplan generates neither the
`.network` units nor the deny-list:

```sh
mkdir -p /etc/netplan.disabled && mv /etc/netplan/*.yaml /etc/netplan.disabled/
systemctl disable systemd-networkd.service systemd-networkd.socket systemd-networkd-wait-online.service
systemctl enable NetworkManager.service
reboot
```

Stage it and reboot; do not try to switch a live board. On the next boot NetworkManager
takes `wlan0`, `yonder-wifi` autoconnects, and the daemon's render succeeds:

```
wlan0:wifi:connected:yonder-wifi
network: testing Wi-Fi because it has just started carrying traffic
```

**Seed the client credentials into `config.yaml` before this reboot** — SSID in
`network.client.ssid`, passphrase as `wifi_psk` in `secrets.yaml` — or the board comes back
on its own access point with no route to it. `ensureValue` only fills a missing secret, so
a hand-written `secrets.yaml` is safe: the daemon still seeds `ap_psk` beside it.

A rescue timer is worth having while this is unproven: a `OnBootSec=6min` one-shot that
restores the netplan backup and reboots unless an interface holds a LAN address. It cost
nothing here — the handover worked first time — but the alternative to it was an ext4 card
in a reader.

## Smaller things that cost time

- **`gst-inspect-1.0` is installed by no role.** `50-mediamtx.sh` guards its
  `rtspclientsink` check with `command -v gst-inspect-1.0` and falls back to a package test,
  so the strong check it appears to perform has never run on a real board. Worse for anyone
  debugging: without the tool, every query for an encoder answers "not found", which reads
  as "the board has no encoder" and is wrong.
- **No role installs an H.264 encoder.** `probeEncoder`'s documented software fallback names
  `x264enc`, which lives in `gstreamer1.0-plugins-ugly` and is not installed.
- **Two boards both named `yonder` collide on mDNS.** With a Pi and a Radxa on one mesh,
  `yonder.local` resolved to the Pi. Use addresses when both are up; `system.hostname`
  being applied (R-NET-09) makes this easy to walk into.
- **The setup gate works as designed.** A fresh console serves nothing until an
  administrator password is set, and the WHEP video proxy returns 401 until it is — which
  is correct, and worth knowing before assuming the video is broken.
- **ZeroTier needed nothing.** Enabled from `config.yaml`, joined, and reported
  `phase: connected`, not relayed. Cellular likewise came up on its own once the modem was
  attached.

## What is still unproven here

- Whether `install.sh` produces this result **twice** — every run in this session followed a
  failure, so the clean-first-run path has not been walked end to end.
- Whether the by-path camera identity survives repeated reboots
  ([see the encoder note](hardware-encode-on-a-radxa-zero-3w.md)).
- A cold flash from an image built this way, powered on and left alone. That is the M1a
  exit criterion and it has not happened on this board either.
