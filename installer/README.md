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
