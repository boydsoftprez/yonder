# Disposable storage prototype

Run from the repository root:

```sh
./scripts/spikes/image-storage/run.sh
```

Requires Docker with a Linux daemon, network access for Debian packages, and support for
container-local mounts with `CAP_SYS_ADMIN`. This is an experiment for
[image storage discovery](../../../docs/hardware/image-storage-discovery.md), not an
installer or a device test. Run the wrapper; do not run the container fixtures directly.
It makes a disposable Debian root, uses artificial account credentials, exercises protected
mounts/account updates/apt, restarts its container, checks persistence, and removes the
container. It never mounts a host directory or a board's SD card. An optional
`YONDER_PROBE_IMAGE` override changes the experiment base; it is not a release-image pin.

A pass establishes the limited assertions described in the report. It does not establish
board boot, SD-card power-loss tolerance, real SSH/sudo login, or a finished owner-state
transaction implementation. The 32 MiB `/etc` tmpfs is an experiment limit, not a chosen
production memory budget. Package versions are resolved from live repositories.
