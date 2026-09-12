# ZERO 3W bench image size

Measured from the clean `zero3w-bench-02` candidate on 11 September 2026 using a
private read-only, no-journal-replay mount. No physical card was mounted or changed.

| Measurement | Size |
|---|---:|
| Raw image, fixed builder geometry | 8 GiB |
| Compressed download | 1.107 GiB |
| Allocated filesystem space | 3.296 GiB |
| Files measured by du | 3.104 GiB |
| Free filesystem blocks | 4.687 GiB |

The difference between allocated space and du includes filesystem metadata.
The builder explicitly grows the raw image to 8 GiB; that is headroom, not software
consumption. A smaller raw image would reduce flashing volume more than download
size because free blocks compress well.

| Top-level content | Size |
|---|---:|
| /usr | 2.312 GiB |
| /opt/yonder | 532.4 MiB |
| /boot | 171.9 MiB |
| /var | 102.6 MiB |
| /etc | 4.1 MiB |

Yonder's directory consists of console dependencies (246.3 MiB), bundled Node.js
(203.6 MiB), and core code/dependencies (82.4 MiB). Node includes a 117 MiB
executable, 66.8 MiB headers, and about 18 MiB of npm files. Console dependencies
include ECharts (61.5 MiB) and Node-RED packages (39 MiB). Core dependencies include
TypeScript (22.9 MiB).

Within /usr, firmware occupies 450.4 MiB, including 295.7 MiB of Qualcomm firmware.
Kernel modules occupy 142.6 MiB. Kernel headers plus AIC8800 DKMS sources occupy
about 179.4 MiB. Selected media/graphics/codec packages total about 359.7 MiB of
package-declared installed size; that grouping includes shared dependencies and
must not be added to the directory totals. MediaMTX's executable is 60.2 MiB;
the custom Rockchip libraries/plugin and pipeline executable are comparatively small.

Potential reductions, not implemented:

- Remove 63.2 MiB of APT lists; require apt update before package operations.
- Separate Node headers and TypeScript tooling from runtime payload, after testing
  Node-RED and supported native-module installation behavior.
- Package-managed pruning of locales, documentation and manuals, with usability costs.
- Board-qualified firmware selection, preserving every supported radio/adapter.
- Smaller initial filesystem geometry, retaining sufficient update headroom.

Do not remove compiler/kernel headers/AIC8800 DKMS sources merely because they are
unused at boot. Kernel updates may need them to rebuild the board's Wi-Fi driver.
Video-library removal changes supported functionality and needs a deliberate profile.
