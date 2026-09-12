# Yonder versions and upgrades

Yonder uses [Calendar Versioning](https://calver.org/overview.html):
**`YYYY.M.RELEASE`**. The first version in this scheme is **2026.9.0**.

| Part | Meaning | Example |
| --- | --- | --- |
| `YYYY` | Four-digit release year | `2026` |
| `M` | Release month, without a leading zero | `9` |
| `RELEASE` | Release counter within that month, starting at zero | `0` |

The next September release is `2026.9.1`; the first October release is
`2026.10.0`. Release tags use a `v` prefix, such as `v2026.9.0`. A version change
in source does not itself create a tag, publish packages, or produce a disk image.

## What a version tells you

A CalVer version identifies when an assembled Yonder release was made. It does
not encode API compatibility. Read the [change notes](../CHANGELOG.md) and configuration migration
notes before upgrading. Pre-alpha status continues independently of the number.

The root manifest, runtime version, first-party workspace packages, and installer
console manifest move together. Internal package dependencies are pinned to that
same version so a release is installed as a coherent set. Third-party dependency
versions and the Dashboard widget-protocol version follow their own schemes.

The `version: 1` field in `config.yaml` is the **configuration schema version**;
it is not the Yonder release number and is not changed by a calendar release.
Historical fixture names and hardware evidence retain the versions they tested.

## Prepare a version

From the repository root:

```sh
npm run version:set -- 2026.9.1
npm run version:check
npm ci
npm run lint
npm test
npm run build
```

`version:set` updates first-party manifests, their lockfile metadata, and the
exported runtime version, plus the marked current version in the README and
installation guide. It does not update external dependencies. `version:check`
runs in CI and refuses inconsistent release metadata. Choose the actual release
month; do not pad the month or counter with zeros.

Commit the change with GPG signing and DCO sign-off. Tag only a reviewed release
commit; keep release notes explicit about hardware evidence, known issues, and
configuration changes. Creating a release artifact is a separate action.

## Upgrade an installed board

1. Record the installed version from **Status**, and read the target’s notes.
2. Export local Flight plans and note browser-only display/data settings.
3. In **Settings → Recovery backup and restore**, choose **Download backup** and
   store the JSON file securely. It includes supported device settings,
   credentials, Linux owner access and mesh identity. Never put it in Git, a
   support issue, or a public artifact.
4. Build the complete target version using the [installation guide](getting-started.md#4-build-yonder-on-your-computer).
5. For a protected image, use **Settings → Storage protection and maintenance**
   to reboot into writable maintenance. Install during that bench session,
   then choose **Return to protection**. Check core, console, networking,
   telemetry, and video after the protected reboot.

The installer preserves an existing device configuration. That is not a promise
that every older version can read a newer configuration: downgrades need the
matching saved configuration and the corresponding complete application build.
Apply/Keep/Revert protects configuration transactions, not software upgrades.
The recovery restore screen previews hardware compatibility and the identities
it will replace before it accepts confirmation. Do not run the original and
restored boards concurrently when they share the restored mesh identity.
