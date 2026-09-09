# Network observations, settings and diagnostics

Requirements: R-NET-06/07/17, R-DIA-01/03/07/08, R-SEC-10/14, R-UI-07/30.

Network → Interfaces and Status now show the same live kernel interface table:
Ethernet, Wi-Fi, cellular and ZeroTier addresses, IPv4 and IPv6 prefixes, carrier,
gateway and route metric. Reads run sequentially every five seconds. Failed reads
clear previous addresses, and a reading older than 15 seconds is marked stale.
The Wi-Fi summary also clears on a failed daemon read.

The lowest main-table metric determines the displayed default route for each IP
family. The existing IPv4 reachability monitor now reads the kernel default route,
so a preferred interface with a LAN address but no default route does not get
mistaken for the active internet connection. Configured priority still determines
generated metrics; applying or reverting updates active owned profiles in place.
The access-point fallback and configuration confirmation path remain active.

ZeroTier manages peer paths separately from the kernel's unbound default route.
Its virtual address identifies a tunnel endpoint; it does not identify the
physical interface carrying a particular peer's traffic. To investigate a path,
inspect ZeroTier's preferred physical peer endpoint and run Route lookup against
that address. A route lookup is evidence of the kernel route, not a packet capture
of an interface-bound ZeroTier socket.

Status repeats the existing ZeroTier identity, address, direct/relayed status,
controller latency, byte counters, throughput and history graph. Controller latency
does not represent every ground-station peer's latency.

## Diagnostics

Choose Ping, Traceroute, Route lookup, or Bandwidth. Supply a hostname or IP address,
an IPv4/IPv6 family, and optionally a currently present interface. Automatic route
lets the kernel choose. Selecting an interface binds the test to it; a removed
interface is refused rather than silently testing another link.

Actual command output appears as selectable plain text. Each test reports its
command, running/completion state, elapsed time and exit code. Cancel stops the
process; Save output downloads the text. Revisiting Diagnostics in the same browser
tab recovers its last job. Only the initiating authenticated session can read or
cancel it. Tests run one at a time, expire after ten minutes, stop within 30 seconds,
and retain at most 64 Ki characters of output. No arbitrary shell is exposed.

Traceroute sends one probe per hop, up to 20 hops. An asterisk means that hop did
not answer. Filtering or a hop's ICMP policy can produce asterisks on a working
path, so they are not a conclusive failure indication.

Bandwidth uses an operator-selected **iperf3 server**. Run `iperf3 -s` on the
target, then choose upload or download, port, duration (2–10 seconds) and rate
ceiling (1–100 Mb/s). Defaults are five seconds and 10 Mb/s, approximately 6.25 MB
of payload plus protocol overhead. The result is capped by that ceiling and shares
capacity with video and telemetry. Nothing runs automatically.

The installer supplies iproute2, iputils-ping, traceroute, iperf3 and coreutils.
Older installations need those packages as well as the new core and widgets.

Reboot system requires a second explicit confirmation and schedules a reboot
one minute later. The console explains that video and telemetry will disconnect.
A pending/applying/reverting configuration or a reported armed aircraft refuses
the request. The control does not command the autopilot.

## Settings

Settings holds the saved Day/Night choice and Change password. Status's former
palette keys now open Settings. A palette change goes through the existing theme
configuration route and refreshes its stylesheet.

Changing the console password requires the current password, a new password of
8–1024 characters and matching confirmation. Password requests travel directly
through the authenticated HTTP boundary, not through Node-RED flow context or
dashboard message history. Failed verification is throttled; secrets are redacted.
The new hash is written durably before success. Existing HTTP sessions are
revoked, then the console is restarted with its saved flow-editor tokens removed.
The new password applies to the console and flow editor; it does not change SSH
or the Wi-Fi access-point passphrase.

## Hardware evidence, 2026-09-09

Before the cable was connected, this Pi had Wi-Fi at 192.168.1.121 and cellular at
10.25.40.121; Ethernet reported no carrier and held no address. LTE owned both
default routes at metric 700, followed by Wi-Fi at 800.

At 21:29:09 in the device's journal timezone, connecting Ethernet to a router
triggered NetworkManager activation automatically. DHCP assigned 10.0.252.246/24
at 21:29:10; Ethernet took the IPv4 and IPv6 default routes at metric 100.
ZeroTier peer 4e183e1755 switched from its public endpoint to 10.0.252.216:9993
and reported 8 ms latency. This cable handover required no reboot or route edit.
It verifies the current setup; the earlier Ethernet failure was not reproduced.
The previous boot's journal was not persistent, so it cannot establish its cause.

The camera task separately compared a temporary peer-route MTU of 1280 with the
original 2800. The smaller value reduced delivered throughput and was restored.
Its attempted hardware CBR change subsequently failed the full pipeline check and
was rolled back. Preserve that rollback and the Flight Home changes when installing
this change.

## Installed verification

Revision `3c0ff46` was installed on the Pi on 2026-09-09. The 48-file update
checked old and new hashes, retained a rollback backup, and observed 45.05 seconds
of continuous USB absence before restarting core. The camera then remained
running with the same start timestamp and zero restarts for the 30-second
acceptance window. Configuration and secret-file hashes were unchanged.
The Home implementation and restored camera pipeline were preserved.

The new diagnostic job service ran these real commands on the board:

| Test | Observed result |
| --- | --- |
| Ethernet ping to 1.1.1.1 via hostname | 2/2 replies, mean 11.2 ms; source 10.0.252.246 |
| Wi-Fi ping to 1.1.1.1 | 2/2 replies, mean 52.8 ms; source 192.168.1.121 |
| LTE ping to 1.1.1.1 | 2/2 replies, mean 141.5 ms; source 10.25.40.121 |
| IPv6 ping to ::1 | 2/2 replies; command-family support verified locally |
| Traceroute to 1.1.1.1 on eth0 | Destination reached in nine hops; one intermediate hop did not reply |
| Hostname route lookup on eth0 | Resolved the hostname and reported gateway 10.0.252.1 and source 10.0.252.246 |
| Cancel running ping | Job marked cancelled and process stopped |
| iperf3 upload and download | Both completed against a temporary loopback server at a 2 Mb/s ceiling; this does not measure internet capacity |
| Unauthenticated interface HTTP request | Refused with HTTP 401 |

The new pages were exercised in the real Node-RED/Dashboard runtime using isolated
device fixtures: four desktop pages in both palettes and three mobile pages
rendered with no page errors or document overflow. Mobile addresses stack and wrap.
An isolated browser password change invalidated the old session (401), and the new
password signed in successfully (200). The operator's real password was not changed.
The reboot control's confirmation and configuration/armed guards were tested
without issuing an operating-system reboot.
