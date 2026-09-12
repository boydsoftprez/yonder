#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# R-SYS-10/R-SEC-10/14: actual distro account/SSH tools, isolated from host accounts.
set -euo pipefail
[[ $# == 0 && -f CLAUDE.md ]]
npm run build -w yonder-core
docker run --rm --platform linux/arm64 -v "$PWD:/source:ro" -w /source \
    debian@sha256:f324c7ff54321e8d9c588493a20244965938ce0aa50bbd1022d38010e9ffc4b1 \
    /bin/bash -c '
        set -euo pipefail
        export DEBIAN_FRONTEND=noninteractive
        printf "#!/bin/sh\nexit 101\n" >/usr/sbin/policy-rc.d
        chmod 755 /usr/sbin/policy-rc.d
        apt-get update >/dev/null
        apt-get install -y --no-install-recommends nodejs whois sudo openssh-server sshpass >/dev/null
        mkdir -p /lab/core/scripts /lab/core/node_modules
        cp -a /source/packages/yonder-core/dist /lab/core/dist
        cp /source/packages/yonder-core/package.json /lab/core/package.json
        cp /source/packages/yonder-core/scripts/verify-owner-linux.mjs /lab/core/scripts/
        cp -a /source/node_modules/zod /source/node_modules/yaml /lab/core/node_modules/
        (cd /lab/core; find dist -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum)
        node /lab/core/scripts/verify-owner-linux.mjs
    '
