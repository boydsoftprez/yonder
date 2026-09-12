# Draft image release assembler

`draft.mjs` validates a self-contained release staging directory and can create or
update a GitHub **draft** release. Validation is the default:

```sh
node image/release/draft.mjs \
  --manifest /staging/release-set.json \
  --repo OWNER/REPO \
  --target all
```

Repeat `--target rpi`, `--target radxa-zero3w` or `--target radxa-rock5c` for a
manual partial candidate. A three-target manifest with `candidateId` is also a
candidate; only a complete manifest without that field uses the version tag.
`--apply` is the only mode that calls GitHub. It requires an authenticated `gh`
CLI and still sends `draft: true` on every release mutation.
The helper never publishes a release.

The staging directory must contain only regular files and directories. Every path
in the manifest is relative to that directory. Absolute paths, traversal, symlinks,
private-access material, bench/prototype material, credential files and assets at
or above 2 GiB are rejected. Use an isolated staging directory; the scan covers the
whole directory, including files not named by the manifest.

## Release-set manifest

```json
{
  "schemaVersion": 1,
  "kind": "yonder-image-release-set",
  "version": "2026.9.0",
  "sourceCommit": "0123456789abcdef0123456789abcdef01234567",
  "status": "partial",
  "candidateId": "github-run-4812",
  "targets": {
    "rpi": {
      "status": "success",
      "buildManifest": "yonder-2026.9.0-rpi-arm64.build.json",
      "assets": [
        { "role": "image", "path": "yonder-2026.9.0-rpi-arm64.img.xz", "sha256": "..." },
        { "role": "checksum", "path": "yonder-2026.9.0-rpi-arm64.sha256", "sha256": "..." },
        { "role": "build-manifest", "path": "yonder-2026.9.0-rpi-arm64.build.json", "sha256": "..." },
        { "role": "packages", "path": "yonder-2026.9.0-rpi-arm64.packages.tsv", "sha256": "..." },
        { "role": "verification", "path": "yonder-2026.9.0-rpi-arm64.verification.json", "sha256": "..." }
      ]
    },
    "radxa-zero3w": { "status": "failed", "reason": "builder failed" },
    "radxa-rock5c": { "status": "failed", "reason": "builder failed" }
  },
  "retainedInputs": [
    { "role": "input-index", "path": "inputs/input-index.json", "sha256": "..." },
    { "role": "input-bundle", "path": "inputs/rpi.inputs.tar.zst.part000", "sha256": "..." }
  ]
}
```

The real manifest may omit targets that a manual run did not select. A successful
target has all five assets with the exact filenames shown by the pattern above. A
failed target has only `status` and `reason`. `status: complete` requires all three
targets to be present and successful. A partial draft requires a lowercase,
tag-safe `candidateId` that identifies the build run.

Each `.build.json` must identify `kind: release-image`, the exact version, target,
source commit and image hash. It must set `sourceHasUncommittedChanges: false`,
`protectedStorage: true` and `temporaryBenchSsh: false` as JSON booleans. Private
hardware-test and storage-prototype manifests therefore fail closed.

Each `.verification.json` must use `kind: yonder-image-verification`, bind the same
version, target, source commit and image hash, and contain:

```json
{
  "checks": {
    "credentialMaterialAbsent": true,
    "temporaryBenchAccessAbsent": true,
    "protectedStorage": true
  }
}
```

The build verifier that produces this file is responsible for actually inspecting
the image; these values are mandatory evidence inputs to the release gate.

## Retained-input generator and index

Create the retained archives only after all selected target input sets have been
accepted. The input root contains one `input-set.json` directory per target; the
output directory must not exist or overlap that root.

```sh
node image/release/input-bundles.mjs \
  --input-root /accepted/image-inputs \
  --output /accepted/image-inputs/release \
  --version 2026.9.0 \
  --source 0123456789abcdef0123456789abcdef01234567 \
  --target rpi --target radxa-zero3w --target radxa-rock5c
```

The generator resolves each accepted input set, verifies the base hash, complete
APT and payload `SHA256SUMS` inventories, payload structural inventory, retained
first-party Git archive, application metadata, and frozen ARM64 builder inventory.
It rejects special and hard-linked files, private input names, and symlinks that
are absent from the payload inventory or can escape the retained tree. Archive
entries have canonical order, root ownership and zero timestamps. Each target's
deterministic tar+zstd stream is split into numbered parts strictly smaller than
2 GiB.

The one `input-index` file uses schema version 2. The abbreviated example below
shows every field; each SHA-256 value is a lowercase 64-character digest.

```json
{
  "schemaVersion": 2,
  "kind": "yonder-release-input-index",
  "version": "2026.9.0",
  "sourceCommit": "0123456789abcdef0123456789abcdef01234567",
  "rebuildability": {
    "status": "incomplete",
    "retained": [
      "locked-base-image",
      "target-apt-input",
      "application-payload-input",
      "arm64-builder-image"
    ],
    "source": {
      "commit": "0123456789abcdef0123456789abcdef01234567",
      "firstPartyArchiveRetained": true,
      "buildSnapshotRetained": false
    },
    "limitations": [
      "build-source-snapshot-not-retained",
      "payload-source-rebuild-incomplete"
    ]
  },
  "targets": [
    {
      "target": "rpi",
      "inputSetManifestSha256": "...",
      "components": {
        "base": { "sha256": "...", "bytes": 1 },
        "apt": { "manifestSha256": "...", "sha256SumsSha256": "..." },
        "payload": {
          "manifestSha256": "...",
          "sha256SumsSha256": "...",
          "replayStatus": "complete",
          "sourceRebuildStatus": "incomplete",
          "sourceCommit": "0123456789abcdef0123456789abcdef01234567",
          "sourceArchiveSha256": "...",
          "applicationBundleSha256": "...",
          "applicationToolchainImage": "toolchain@sha256:...",
          "buildTools": {
            "outerBuilderSha256": "...",
            "targetBackendSha256": "...",
            "finalizerSha256": "..."
          }
        },
        "builder": {
          "manifestSha256": "...",
          "imageId": "sha256:...",
          "baseRuntime": "debian@sha256:..."
        }
      },
      "archive": {
        "format": "tar+zstd-split-v1",
        "inventorySha256": "...",
        "entryCount": 1,
        "uncompressedSha256": "...",
        "uncompressedBytes": 1,
        "compressedSha256": "...",
        "compressedBytes": 1,
        "parts": [
          { "fileName": "rpi.inputs.tar.zst.part000", "sha256": "...", "bytes": 1 }
        ]
      }
    }
  ]
}
```

The assembler concatenates and hashes each selected target's parts, decompresses
the stream, validates every tar header and inventory hash, and confirms the
archived base, APT, payload, first-party source, application bundle and builder
identities. It compares those identities and the retained build-tool hashes with
the target build manifest, then recomputes `inputSetId` using the verified four
component hashes and the build's declared `sourceSnapshotSha256`.

The rebuildability status is deliberately `incomplete`. The retained inputs now
include the exact clean first-party Git archive and frozen ARM64 builder image,
but `image/build.mjs` creates a separate composite source tar containing replayed
vendor payload bytes and records only its hash. That exact composite tar is not a
retained asset. The payload manifest also records upstream source/toolchain gaps,
including unretained OCI toolchain bytes and Node/MediaMTX source. The index must
not claim a fully source-rebuildable release while those gaps remain.

## Draft identity and retries

A complete three-target set without `candidateId` uses tag `vVERSION`. Any manifest
with a candidate ID, including a successful three-target manual build, uses
`vVERSION-candidate-TARGETS-SOURCE12-CANDIDATE_ID`, so it cannot create or downgrade
the signed version tag. The helper resolves an existing release's
`target_commitish` through the commits API and refuses a source mismatch or any
published release.

Existing assets are downloaded and accepted only when their SHA-256 matches. A name
with different bytes is never overwritten. Missing assets are uploaded and then
downloaded for hash verification. A generated release index binds the selected
targets, source, manifest hash and complete asset set; the draft body leaves
`assembling` only after every download verifies, becoming `partial`, `candidate`
or `complete` according to the manifest identity.

The helper refreshes the release and checks that it is still a draft immediately
before each upload and body update. GitHub does not provide an atomic conditional
upload tied to draft state, so an operator can still publish in the interval between
that check and the request. The helper stops before its next mutation when it observes
publication; publication remains an operator-controlled action.

## GitHub image workflow

The release order is fixed:

1. Merge the intended source revision to `main` and let main CI pass.
2. On a trusted online host capable of producing the ARM64 captures, capture and
   accept the exact input set for each target, then generate the version/source
   bound retained archives with `input-bundles.mjs`.
3. Install those target directories and `release/` output as one exact,
   root-owned, read-only `IMAGE_INPUT_ROOT` mount on the dedicated image runner.
4. Run the manual workflow to create a candidate draft and qualify its images on
   the corresponding boards.
5. After qualification, create the signed `vVERSION` tag. Its all-target run may
   create or update the final version draft. Publication remains a separate
   operator action.

`.github/workflows/images.yml` runs manually for `all`, `rpi`,
`radxa-zero3w` or `radxa-rock5c`. A pushed `vVERSION` tag always selects all
three targets; `release-source.mjs` rejects a tag that does not exactly match the
checked-out package version, an unrelated source revision, an unverified source
or tag signature, or a revision without successful main CI.

Set `IMAGE_RUNNER` to the label of a dedicated native ARM64 Linux runner, or an
explicitly configured larger ARM64 runner, with at least 40 GiB free on both its
temporary filesystem and Docker storage. The runner must provide Node.js 24,
Docker, GNU or BSD tar, zstd, `findmnt`, `gh`, and the ordinary POSIX build tools.
The workflow refuses authorization when
the variable is empty; there is no hosted-runner fallback. Set `IMAGE_INPUT_ROOT`
to an absolute path that is an exact, root-owned, read-only mount on every image
runner. The input mount has this layout:

```text
$IMAGE_INPUT_ROOT/
├── rpi/{input-set.json,base.img.xz,apt/,payload/,builder/}
├── radxa-zero3w/{input-set.json,base.img.xz,apt/,payload/,builder/}
├── radxa-rock5c/{input-set.json,base.img.xz,apt/,payload/,builder/}
└── release/
    ├── input-index.json
    └── *.inputs.tar.zst.partNNN
```

Each target is a completed `capture-inputs.sh` output. `image/build.sh` resolves
and verifies its target-bound component manifests and hashes before it calls the
production assembler. `release/input-index.json` uses the retained-input contract
above and binds the bundles to the source revision. The workflow derives a
selected-target index for a manual candidate and verifies each copied bundle
against the retained hash before draft assembly.

Configure `IMAGE_TRANSFER_PUBLIC_KEY` and `IMAGE_TRANSFER_PRIVATE_KEY` as an RSA
key pair in repository secrets. Read-only matrix jobs receive only the public key.
They encrypt each completed target directory before the one-day Actions artifact
handoff and remove the plaintext scratch directory. The final job alone receives
the private key and `contents: write`; it authenticates every transfer, constructs
`release-set.json`, and runs `draft.mjs --apply`. The assembler downloads every
uploaded release asset and verifies its SHA-256 before it marks the draft body
complete, candidate or partial. No workflow step publishes a release.

Every manual run creates a separately identified candidate, including manual
`all`; it never claims or creates the version tag. Only a verified `vVERSION`
tag run omits the candidate ID and uses that version tag. Tag runs cannot reach
the draft job unless all three matrix builds succeed. Retry
behavior remains the `draft.mjs` contract: matching immutable assets are reused,
different bytes under an existing name are refused, and a published release is
never mutated.
