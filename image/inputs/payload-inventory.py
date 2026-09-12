#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Capture and replay an exact, public application payload input set."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import sys
from typing import Any
from urllib.parse import urlsplit


TARGET_COMPONENTS = {
    "rpi": ["node", "zerotier", "mediamtx", "mavlink-router", "console", "application"],
    "radxa-zero3w": [
        "node", "zerotier", "mediamtx", "mavlink-router", "gst-rockchip", "seekerhd", "console",
        "application"
    ],
    "radxa-rock5c": [
        "node", "zerotier", "mediamtx", "mavlink-router", "gst-rockchip", "console", "application"
    ],
}
NOTICE = re.compile(r"^(?:licen[cs]e|notice|copying)(?:[._-].*)?$", re.IGNORECASE)
HASH = re.compile(r"^[a-f0-9]{64}$")
NPM_NAME = re.compile(r"^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$")
TOOLCHAIN = re.compile(r"^([^=\x00-\x20]+)=([^\x00-\x20]+@sha256:[a-f0-9]{64})$")
RECORD_KINDS = {"archive", "index", "git-source", "npm-cache", "patch", "notice"}
PRIVATE_INPUT_NAMES = {
    ".netrc", ".npmrc", "authorized_key", "authorized_keys", "credentials",
    "id_dsa", "id_ecdsa", "id_ed25519", "id_rsa", "password", "password.txt",
    "private_key", "secret", "token",
}
COMMON_RECORDS = {
    "node-distribution", "node-checksums",
    "zerotier-inrelease", "zerotier-packages", "zerotier-package", "zerotier-source",
    "zerotier-copyright",
    "mediamtx-checksums", "mediamtx-distribution", "mavlink-router",
    "console-package-json", "console-package-lock", "console-npm-cache",
    "application-source", "application-manifests", "application-npm-cache",
}
ROCKCHIP_RECORDS = {"rockchip-mpp", "librga", "gstreamer-rockchip"}
SEEKERHD_RECORDS = {
    "rkaiq", "rkaiq-aiq-server.patch", "rkaiq-aiq-thread-fallback.patch",
    "rkaiq-aiq-sensor-timing.patch", "rkaiq-aiq-live-controls.patch",
    "rkaiq-aiq-vendor-hdr-abi.patch", "seekerhd-reference-iq", "seekerhd-divimath-iq",
}
EXPECTED_TOOLCHAINS = {
    "rpi": {"application", "mavlink-router"},
    "radxa-rock5c": {"application", "mavlink-router", "gst-rockchip"},
    "radxa-zero3w": {"application", "mavlink-router", "gst-rockchip", "seekerhd-rkaiq"},
}
APPLICATION_PACKAGES = [
    "yonder-core", "node-red-contrib-yonder-system", "node-red-contrib-yonder-network",
    "node-red-contrib-yonder-remote", "node-red-contrib-yonder-modem",
    "node-red-contrib-yonder-video", "node-red-contrib-yonder-mavlink",
    "node-red-dashboard-2-yonder",
]
APPLICATION_WORKSPACE_RESOLUTIONS = {f"packages/{name}" for name in APPLICATION_PACKAGES}
APPLICATION_OFFLINE_BUILD = {
    "status": "verified",
    "network": "none",
    "source": "retained-git-archive",
    "npmInputs": "retained-cache-and-manifests",
}
SOURCE_REBUILD = {
    "status": "incomplete",
    "gaps": [
        {"code": "UPSTREAM_BINARY_SOURCE_NOT_RETAINED",
         "detail": "Node and MediaMTX source trees are not retained; their verified release binaries are replayed."},
        {"code": "OCI_IMAGE_NOT_RETAINED",
         "detail": "Pinned source-build OCI images are identified but are not stored in this capture."},
        {"code": "OCI_APT_INPUTS_NOT_RETAINED",
         "detail": "Packages fetched inside source-build OCI containers are not stored in this capture."},
    ],
}


class CaptureError(Exception):
    pass


def fail(message: str) -> None:
    raise CaptureError(message)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def relative_path(value: str, label: str) -> PurePosixPath:
    if not value or "\\" in value or any(ord(char) < 32 for char in value):
        fail(f"{label} is not a portable relative path")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in ("", ".", "..") for part in path.parts):
        fail(f"{label} is not a safe relative path")
    return path


def safe_tree(root: Path) -> None:
    if not root.is_dir() or root.is_symlink():
        fail(f"required directory is unavailable: {root}")
    for directory, names, files in os.walk(root, followlinks=False):
        base = Path(directory)
        for name in [*names, *files]:
            path = base / name
            rel = path.relative_to(root)
            if any(ord(char) < 32 for char in rel.as_posix()):
                fail(f"non-portable path in retained tree: {rel.as_posix()}")
            mode = path.lstat().st_mode
            if stat.S_ISLNK(mode):
                target = os.readlink(path)
                if os.path.isabs(target):
                    fail(f"escaping symlink in retained tree: {rel.as_posix()}")
                candidate = PurePosixPath(rel.parent.as_posix()) / PurePosixPath(target)
                depth = 0
                for part in candidate.parts:
                    if part in ("", "."):
                        continue
                    if part == "..":
                        depth -= 1
                        if depth < 0:
                            fail(f"escaping symlink in retained tree: {rel.as_posix()}")
                    else:
                        depth += 1
            elif not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):
                fail(f"special file in retained tree: {rel.as_posix()}")


def reject_private_inputs(inputs: Path) -> None:
    allowed = {"downloads", "notices", "sources", "patches", "npm"}
    if not inputs.is_dir() or any(path.name not in allowed for path in inputs.iterdir()):
        fail("retained input tree contains an unsupported top-level path")
    for path in inputs.rglob("*"):
        if path.name.casefold() in PRIVATE_INPUT_NAMES:
            fail(f"private access input is forbidden: {path.relative_to(inputs).as_posix()}")
        if path.name == "config" and ".git" in path.parts and path.is_file():
            try:
                lines = path.read_text(encoding="utf-8").splitlines()
            except (OSError, UnicodeDecodeError) as error:
                fail(f"could not validate retained Git config: {error}")
            for line in lines:
                stripped = line.strip()
                lowered = stripped.casefold()
                if lowered.startswith("extraheader") or lowered.startswith("credential"):
                    fail("retained Git config contains credential configuration")
                if lowered.startswith("url") and "=" in stripped:
                    parsed = urlsplit(stripped.split("=", 1)[1].strip())
                    if parsed.username or parsed.password:
                        fail("retained Git origin contains credentials")


def copy_tree(source: Path, destination: Path) -> None:
    safe_tree(source)
    shutil.copytree(source, destination, symlinks=True, copy_function=shutil.copy2)


def paths_overlap(left: Path, right: Path) -> bool:
    return left == right or left in right.parents or right in left.parents


def inventory(root: Path) -> list[dict[str, Any]]:
    safe_tree(root)
    result: list[dict[str, Any]] = []
    for path in sorted(root.rglob("*"), key=lambda item: item.relative_to(root).as_posix()):
        rel = path.relative_to(root).as_posix()
        mode = path.lstat().st_mode
        common: dict[str, Any] = {"path": rel, "mode": stat.S_IMODE(mode)}
        if stat.S_ISDIR(mode):
            result.append({**common, "type": "directory"})
        elif stat.S_ISREG(mode):
            result.append({**common, "type": "file", "sha256": sha256(path), "bytes": path.stat().st_size})
        elif stat.S_ISLNK(mode):
            result.append({**common, "type": "symlink", "linkTarget": os.readlink(path)})
        else:
            fail(f"special file in retained tree: {rel}")
    return result


def read_records(staging: Path) -> list[dict[str, str]]:
    path = staging / "records.tsv"
    if not path.is_file():
        fail("capture staging has no records.tsv")
    records: list[dict[str, str]] = []
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        fields = line.split("\t")
        if len(fields) != 5 or fields[0] not in RECORD_KINDS or any(not field for field in fields):
            fail(f"invalid retained input record on line {number}")
        kind, name, identity, origin, retained = fields
        if any(ord(char) < 32 for field in fields for char in field):
            fail(f"invalid retained input record on line {number}")
        rel = relative_path(retained, f"record {number} path")
        if rel.parts[0] != "inputs" or not (staging / Path(*rel.parts)).exists():
            fail(f"retained input record {number} does not name captured input")
        parsed_origin = urlsplit(origin)
        if parsed_origin.scheme in {"http", "https"} and (
            parsed_origin.username or parsed_origin.password or parsed_origin.query or parsed_origin.fragment
        ):
            fail(f"retained input record {number} origin contains credentials")
        records.append({"kind": kind, "name": name, "identity": identity, "origin": origin,
                        "path": f"files/{rel.as_posix()}"})
    if not records:
        fail("capture has no retained input records")
    return records


def validate_record_coverage(target: str, records: list[dict[str, str]]) -> None:
    expected_keys = {"kind", "name", "identity", "origin", "path"}
    if not all(isinstance(record, dict) and set(record) == expected_keys
               and all(isinstance(value, str) and value for value in record.values())
               and record["kind"] in RECORD_KINDS for record in records):
        fail("retained input records have an unsupported shape")
    names = [record["name"] for record in records]
    if len(names) != len(set(names)):
        fail("retained input record names must be unique")
    expected = set(COMMON_RECORDS)
    if target in {"radxa-zero3w", "radxa-rock5c"}:
        expected.update(ROCKCHIP_RECORDS)
    if target == "radxa-zero3w":
        expected.update(SEEKERHD_RECORDS)
    if set(names) != expected:
        missing = sorted(expected.difference(names))
        extra = sorted(set(names).difference(expected))
        detail = f"missing {','.join(missing)}" if missing else f"unexpected {','.join(extra)}"
        fail(f"retained inputs do not exactly cover {target}: {detail}")
    for record in records:
        rel = relative_path(record["path"], "retained input record path")
        if rel.parts[:2] != ("files", "inputs"):
            fail("retained input record does not name captured input")
        origin = urlsplit(record["origin"])
        if origin.username or origin.password or origin.query or origin.fragment:
            fail("retained input record origin contains credentials")


def validate_npm_inputs(staging: Path) -> None:
    manifest_dir = staging / "inputs" / "npm" / "manifests"
    package_json = manifest_dir / "package.json"
    lock_path = manifest_dir / "package-lock.json"
    cache = staging / "inputs" / "npm" / "cache"
    if not package_json.is_file() or not lock_path.is_file() or not cache.is_dir() \
            or not any(cache.iterdir()):
        fail("retained npm manifests and cache must be present")
    def visit(value: Any) -> None:
        if isinstance(value, dict):
            resolved = value.get("resolved")
            if isinstance(resolved, str):
                url = urlsplit(resolved)
                public_registry = url.scheme == "https" and url.hostname == "registry.npmjs.org" \
                    and not url.username and not url.password and not url.query and not url.fragment
                if not public_registry and resolved not in APPLICATION_WORKSPACE_RESOLUTIONS:
                    fail("package-lock.json contains a non-public or credential-bearing resolved URL")
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    lock_paths = [lock_path, staging / "inputs" / "npm" / "application" / "manifests" / "package-lock.json",
                  staging / "inputs" / "npm" / "application" / "manifests" / "packages" /
                  "yonder-core" / "package-lock.json"]
    application_cache = staging / "inputs" / "npm" / "application" / "cache"
    if not application_cache.is_dir() \
            or not any(path.is_file() and not path.is_symlink() for path in application_cache.rglob("*")):
        fail("retained application npm cache must be present")
    for retained_lock in lock_paths:
        try:
            lock = json.loads(retained_lock.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            fail(f"could not read retained package-lock.json: {error}")
        visit(lock)


def read_json(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"could not read {label}: {error}")
    if not isinstance(value, dict):
        fail(f"{label} must be a JSON object")
    return value


def require_nonempty_directory(path: Path, label: str) -> None:
    if not path.is_dir() or path.is_symlink() or not any(item.is_file() for item in path.rglob("*")):
        fail(f"application bundle is missing {label}")


def validate_application(payload: Path, inputs: Path, records: list[dict[str, str]],
                         toolchains: list[dict[str, Any]]) -> dict[str, Any]:
    application = payload / "application"
    metadata = read_json(application / "application-bundle.json", "application bundle metadata")
    expected_keys = {"schemaVersion", "kind", "sourceCommit", "sourceKind", "sourceArchiveSha256",
                     "platform", "toolchainImage", "nodeRuntime", "offlineBuild", "packages",
                     "coreProductionDependencies"}
    if set(metadata) != expected_keys or metadata.get("schemaVersion") != 1 \
            or metadata.get("kind") != "yonder-first-party-application" \
            or not isinstance(metadata.get("sourceCommit"), str) \
            or not re.fullmatch(r"[a-f0-9]{40}(?:[a-f0-9]{24})?", metadata["sourceCommit"]) \
            or metadata.get("sourceKind") != "git-archive" \
            or not isinstance(metadata.get("sourceArchiveSha256"), str) \
            or not HASH.fullmatch(metadata["sourceArchiveSha256"]) \
            or metadata.get("platform") != "linux/arm64" \
            or metadata.get("nodeRuntime") != "retained-payload-node" \
            or metadata.get("offlineBuild") != APPLICATION_OFFLINE_BUILD \
            or metadata.get("packages") != APPLICATION_PACKAGES \
            or not isinstance(metadata.get("coreProductionDependencies"), list) \
            or not metadata["coreProductionDependencies"] \
            or any(not isinstance(name, str) or not NPM_NAME.fullmatch(name)
                   for name in metadata["coreProductionDependencies"]):
        fail("application bundle metadata has an unsupported shape")
    by_name = {record["name"]: record for record in records}
    source_record = by_name["application-source"]
    source_archive = inputs / "sources" / "application" / "source.tar"
    if source_record["identity"] != metadata["sourceCommit"] \
            or source_record["path"] != "files/inputs/sources/application/source.tar" \
            or not source_archive.is_file() or source_archive.is_symlink() \
            or sha256(source_archive) != metadata["sourceArchiveSha256"]:
        fail("application source archive does not match its bundle metadata")
    toolchain = next((item for item in toolchains if item["purpose"] == "application"), None)
    if toolchain is None or toolchain["image"] != metadata.get("toolchainImage"):
        fail("application toolchain does not match its bundle metadata")
    packages = application / "packages"
    actual_packages = sorted(
        path.name for path in packages.iterdir()
        if path.is_dir() and not path.is_symlink()
    ) if packages.is_dir() and not packages.is_symlink() else []
    if actual_packages != sorted(APPLICATION_PACKAGES):
        fail("application bundle package set does not exactly match the production set")
    for package in APPLICATION_PACKAGES:
        root = packages / package
        package_manifest = read_json(root / "package.json", f"{package} package manifest")
        if package_manifest.get("name") != package:
            fail(f"application bundle package name mismatch: {package}")
        require_nonempty_directory(root / "dist", f"{package}/dist")
    resources = [
        path.parent.name
        for path in packages.glob("*/resources")
        if path.is_dir() and not path.is_symlink()
    ]
    if "node-red-dashboard-2-yonder" not in resources:
        fail("application bundle is missing node-red-dashboard-2-yonder/resources")
    for package in resources:
        require_nonempty_directory(packages / package / "resources", f"{package}/resources")
    core = packages / "yonder-core"
    require_nonempty_directory(core / "node_modules", "yonder-core/node_modules")
    core_manifest = read_json(core / "package.json", "yonder-core package manifest")
    dependencies = core_manifest.get("dependencies")
    if not isinstance(dependencies, dict) \
            or sorted(dependencies) != metadata["coreProductionDependencies"]:
        fail("application core dependency metadata does not match package.json")
    for dependency in metadata["coreProductionDependencies"]:
        dependency_root = core.joinpath("node_modules", *dependency.split("/"))
        if not dependency_root.is_dir() or dependency_root.is_symlink() \
                or not (dependency_root / "package.json").is_file() \
                or (dependency_root / "package.json").is_symlink():
            fail(f"application core production dependency is missing: {dependency}")
    license_path = application / "LICENSE"
    if not license_path.is_file() or license_path.is_symlink() or license_path.stat().st_size == 0:
        fail("application bundle root license is missing")
    return metadata


def npm_packages(payload: Path) -> list[dict[str, Any]]:
    packages: list[dict[str, Any]] = []
    roots = [payload / "console" / "node_modules",
             payload / "application" / "packages" / "yonder-core" / "node_modules"]
    manifests = sorted(path for root in roots if root.is_dir() for path in root.rglob("package.json"))
    for manifest in manifests:
        try:
            value = json.loads(manifest.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            fail(f"could not read npm package manifest {manifest.relative_to(payload)}: {error}")
        if not isinstance(value, dict) or not isinstance(value.get("name"), str) \
                or not isinstance(value.get("version"), str):
            continue
        notices = [
            f"files/payload/{path.relative_to(payload).as_posix()}"
            for path in sorted(manifest.parent.iterdir())
            if path.is_file() and not path.is_symlink() and NOTICE.match(path.name)
        ]
        packages.append({"name": value["name"], "version": value["version"],
                         "license": value.get("license") if isinstance(value.get("license"), str) else None,
                         "noticeFiles": notices})
    return packages


def copy_notices(files_root: Path) -> None:
    notices = files_root / "notices"
    for top in (files_root / "inputs", files_root / "payload"):
        for path in sorted(top.rglob("*")):
            if path.is_file() and not path.is_symlink() and NOTICE.match(path.name):
                relative = path.relative_to(files_root)
                destination = notices / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(path, destination)


def parse_toolchains(values: list[str]) -> list[dict[str, Any]]:
    result = []
    seen = set()
    for value in values:
        match = TOOLCHAIN.fullmatch(value)
        if not match or match.group(1) in seen:
            fail(f"invalid or repeated toolchain: {value}")
        seen.add(match.group(1))
        result.append({"purpose": match.group(1), "image": match.group(2), "retained": False})
    return sorted(result, key=lambda item: item["purpose"])


def write_sums(root: Path, files: list[dict[str, Any]]) -> None:
    lines = [f"{sha256(root / 'payload-input.json')}  payload-input.json"]
    lines.extend(f"{item['sha256']}  {item['path']}" for item in files if item["type"] == "file")
    (root / "SHA256SUMS").write_text("\n".join(lines) + "\n", encoding="utf-8")


def capture(args: argparse.Namespace) -> None:
    staging = Path(args.staging).resolve()
    payload = Path(args.payload).resolve()
    output = Path(args.output).resolve()
    if output.exists() or output.is_symlink():
        fail("capture output must not already exist")
    if paths_overlap(output, staging) or paths_overlap(output, payload):
        fail("capture output must be separate from staging and payload paths")
    if args.target not in TARGET_COMPONENTS or args.arch != "linux-arm64":
        fail("application payload capture requires a supported ARM64 image target")
    selected = args.selected.split(",") if args.selected else []
    required = TARGET_COMPONENTS[args.target]
    if selected != required:
        fail(f"selected components do not exactly match {args.target}: {','.join(required)}")
    safe_tree(staging)
    if not payload.is_dir() or payload.is_symlink():
        fail(f"required directory is unavailable: {payload}")
    reject_private_inputs(staging / "inputs")
    entries = [path for path in payload.iterdir() if path.name != ".work"]
    if any(not path.is_dir() or path.is_symlink() for path in entries):
        fail("payload contains a non-directory top-level entry")
    present = sorted(path.name for path in entries)
    if present != sorted(required):
        missing = [name for name in required if name not in present]
        if missing:
            fail(f"missing required payload component {missing[0]}")
        fail("payload contains components outside the selected target")
    records = read_records(staging)
    validate_record_coverage(args.target, records)
    validate_npm_inputs(staging)
    toolchains = parse_toolchains(args.toolchain)
    if {toolchain["purpose"] for toolchain in toolchains} != EXPECTED_TOOLCHAINS[args.target]:
        fail(f"toolchains do not exactly cover {args.target}")
    application = validate_application(payload, staging / "inputs", records, toolchains)
    partial = output.parent / f".{output.name}.partial.{os.getpid()}"
    if partial.exists():
        fail("capture staging output already exists")
    try:
        files_root = partial / "files"
        partial.mkdir(parents=True)
        copy_tree(staging / "inputs", files_root / "inputs")
        (files_root / "payload").mkdir()
        for component in required:
            copy_tree(payload / component, files_root / "payload" / component)
        copy_notices(files_root)
        files = [{**item, "path": f"files/{item['path']}"} for item in inventory(files_root)]
        manifest = {
            "schemaVersion": 1,
            "kind": "yonder-application-payload-input",
            "target": args.target,
            "architecture": args.arch,
            "selectedComponents": required,
            "payloadReplay": {"status": "complete", "root": "files/payload"},
            "applicationBundle": application,
            "sourceRebuild": SOURCE_REBUILD,
            "toolchains": toolchains,
            "records": records,
            "npmPackages": npm_packages(files_root / "payload"),
            "files": files,
        }
        (partial / "payload-input.json").write_text(
            json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        write_sums(partial, files)
        os.replace(partial, output)
    except BaseException:
        shutil.rmtree(partial, ignore_errors=True)
        raise


def read_sums(root: Path) -> dict[str, str]:
    path = root / "SHA256SUMS"
    if not path.is_file() or path.is_symlink():
        fail("retained payload has no regular SHA256SUMS")
    result: dict[str, str] = {}
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if len(line) < 67 or line[64:66] != "  " or not HASH.fullmatch(line[:64]):
            fail(f"invalid SHA256SUMS line {number}")
        rel = relative_path(line[66:], f"SHA256SUMS line {number}")
        name = rel.as_posix()
        if name in result:
            fail(f"duplicate SHA256SUMS path: {name}")
        result[name] = line[:64]
    return result


def replay(args: argparse.Namespace) -> None:
    source = Path(args.input).resolve()
    output = Path(args.output).resolve()
    if output.exists() or output.is_symlink():
        fail("replay output must not already exist")
    if paths_overlap(output, source):
        fail("replay output must be separate from retained input")
    safe_tree(source)
    sums = read_sums(source)
    regular = {
        path.relative_to(source).as_posix()
        for path in source.rglob("*")
        if path.is_file() and not path.is_symlink() and path.name != "SHA256SUMS"
    }
    if set(sums) != regular:
        fail("SHA256SUMS does not exactly cover retained regular files")
    for rel, expected in sums.items():
        if sha256(source / Path(*PurePosixPath(rel).parts)) != expected:
            fail(f"hash mismatch for {rel}")
    try:
        manifest = json.loads((source / "payload-input.json").read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"could not read payload-input.json: {error}")
    expected_keys = {"schemaVersion", "kind", "target", "architecture", "selectedComponents",
                     "payloadReplay", "applicationBundle", "sourceRebuild", "toolchains", "records",
                     "npmPackages", "files"}
    if not isinstance(manifest, dict) or set(manifest) != expected_keys \
            or manifest.get("schemaVersion") != 1 \
            or manifest.get("kind") != "yonder-application-payload-input":
        fail("retained payload manifest has an unsupported shape")
    expected_inventory = manifest.get("files")
    actual_inventory = [
        {**item, "path": f"files/{item['path']}"} for item in inventory(source / "files")
    ]
    if not isinstance(expected_inventory, list) or actual_inventory != expected_inventory:
        fail("retained payload inventory does not match its files")
    target = manifest.get("target")
    if target not in TARGET_COMPONENTS or manifest.get("selectedComponents") != TARGET_COMPONENTS[target] \
            or manifest.get("architecture") != "linux-arm64" \
            or manifest.get("payloadReplay") != {"status": "complete", "root": "files/payload"} \
            or manifest.get("sourceRebuild") != SOURCE_REBUILD:
        fail("retained payload target or replay contract is invalid")
    reject_private_inputs(source / "files" / "inputs")
    validate_npm_inputs(source / "files")
    records = manifest.get("records")
    if not isinstance(records, list) or not all(isinstance(record, dict) for record in records):
        fail("retained payload records are invalid")
    validate_record_coverage(target, records)
    toolchains = manifest.get("toolchains")
    if not isinstance(toolchains, list) or any(
        not isinstance(item, dict) or set(item) != {"purpose", "image", "retained"}
        or item.get("retained") is not False or not isinstance(item.get("purpose"), str)
        or not TOOLCHAIN.fullmatch(f'{item.get("purpose", "")}={item.get("image", "")}')
        for item in toolchains
    ) or {item["purpose"] for item in toolchains} != EXPECTED_TOOLCHAINS[target]:
        fail("retained payload toolchain contract is invalid")
    application = validate_application(source / "files" / "payload", source / "files" / "inputs",
                                       records, toolchains)
    if manifest.get("applicationBundle") != application:
        fail("retained application bundle contract is invalid")
    partial = output.parent / f".{output.name}.partial.{os.getpid()}"
    try:
        copy_tree(source / "files" / "payload", partial)
        os.replace(partial, output)
    except BaseException:
        shutil.rmtree(partial, ignore_errors=True)
        raise


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    sub = result.add_subparsers(dest="command", required=True)
    create = sub.add_parser("capture")
    create.add_argument("--staging", required=True)
    create.add_argument("--payload", required=True)
    create.add_argument("--output", required=True)
    create.add_argument("--target", required=True)
    create.add_argument("--arch", required=True)
    create.add_argument("--selected", required=True)
    create.add_argument("--toolchain", action="append", default=[])
    restore = sub.add_parser("replay")
    restore.add_argument("--input", required=True)
    restore.add_argument("--output", required=True)
    return result


def main() -> int:
    args = parser().parse_args()
    try:
        if args.command == "capture":
            capture(args)
        else:
            replay(args)
    except CaptureError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
