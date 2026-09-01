# Security policy

## Reporting

Report vulnerabilities through GitHub's private advisory reporting on this repository.
Please do not open a public issue for anything exploitable.

Expect an acknowledgement within a week. This is a volunteer project; there is no paid
on-call and no bounty.

## Threat model

Yonder runs on a companion computer attached to an aircraft, reachable over Wi-Fi, a
cellular link and a mesh VPN. Assume the network is hostile.

**Yonder can command the aircraft.** It sets flight modes, writes autopilot parameters and
drives payload outputs. Unauthorised access to the interface is therefore unauthorised
control of an aircraft in flight, and reports should be weighted accordingly.

**In scope**

- Remote code execution or privilege escalation on the device
- Unauthenticated access to the web interface or the flow editor
- Unauthenticated MAVLink injection reaching the flight controller
- Credential leakage — Wi-Fi PSKs, VPN identities, API tokens — in images, logs or backups
- Config or update paths that let an attacker persist

**Out of scope**

- Physical access to the board or the SD card
- Attacks requiring the operator to deliberately disable a documented protection
- Anything in the flight controller — report those to ArduPilot
- Denial of service by jamming or saturating a cellular link

## Design commitments

These are enforced in review, not aspirations:

- **No shared default credentials.** Anything secret is generated per device at first boot.
- **No unauthenticated write path** to configuration, the flow editor, or MAVLink from a
  non-loopback interface by default.
- **Least privilege.** The control plane does not run as root; privileged operations go
  through narrowly scoped helpers.
- **No phone-home.** Nothing contacts a server we operate. There is no activation and no
  telemetry. This is a security property as well as a design principle.
- **Secrets never enter the repository or a published image.** Image builds are checked for
  credential material before release.

## A note on published images

A flashed and used card carries real secrets — Wi-Fi passwords, VPN node identities, SSH
host keys. **Do not share an image taken from a device you have flown.** If you need to
share one for debugging, ask first and we will tell you what to strip.
