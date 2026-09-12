#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Build the first-party ARM64 application from an exact clean Git archive."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
from typing import Any


PACKAGES = [
    "yonder-core",
    "node-red-contrib-yonder-system",
    "node-red-contrib-yonder-network",
    "node-red-contrib-yonder-remote",
    "node-red-contrib-yonder-modem",
    "node-red-contrib-yonder-video",
    "node-red-contrib-yonder-mavlink",
    "node-red-dashboard-2-yonder",
]
OFFLINE_BUILD = {
    "status": "verified",
    "network": "none",
    "source": "retained-git-archive",
    "npmInputs": "retained-cache-and-manifests",
}
COMMIT = re.compile(r"^[a-f0-9]{40}(?:[a-f0-9]{24})?$")
IMAGE = re.compile(r"^[^\s@]+@sha256:[a-f0-9]{64}$")
PRIVATE_NAMES = {
    ".netrc", ".npmrc", "authorized_key", "authorized_keys", "credentials",
    "id_dsa", "id_ecdsa", "id_ed25519", "id_rsa", "password", "password.txt",
    "private_key", "secret", "token",
}
NPM_NAME = re.compile(r"^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$")


class BundleError(Exception):
    pass


def fail(message: str) -> None:
    raise BundleError(message)


def run(args: list[str], cwd: Path, capture: bool = False) -> str:
    try:
        result = subprocess.run(
            args, cwd=cwd, check=False, text=True,
            stdout=subprocess.PIPE if capture else None,
            stderr=subprocess.PIPE if capture else None,
        )
    except OSError as error:
        fail(f"could not execute application build tool: {error}")
    if result.returncode != 0:
        detail = (result.stderr or "").strip() if capture else ""
        fail(f"application build command failed{f': {detail}' if detail else ''}")
    return (result.stdout or "").strip()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def require_arm64_elf(path: Path, label: str) -> None:
    try:
        header = path.read_bytes()[:20]
    except OSError as error:
        fail(f"could not read {label}: {error}")
    if len(header) < 20 or header[:4] != b"\x7fELF" or header[5] != 1 \
            or int.from_bytes(header[18:20], "little") != 183:
        fail(f"{label} is not a little-endian ARM64 ELF executable")


def separate_new_paths(paths: list[Path]) -> None:
    resolved = [path.resolve() for path in paths]
    if any(path.exists() or path.is_symlink() for path in resolved):
        fail("application bundle outputs must be new")
    for index, left in enumerate(resolved):
        for right in resolved[index + 1:]:
            if left == right or left in right.parents or right in left.parents:
                fail("application bundle outputs must be separate, non-nested paths")


def validate_archive_members(archive: Path) -> None:
    with tarfile.open(archive, "r:") as source:
        for member in source.getmembers():
            path = PurePosixPath(member.name)
            if path.is_absolute() or any(part in ("", ".", "..") for part in path.parts):
                fail("Git source archive contains an unsafe path")
            if any(part.casefold() in PRIVATE_NAMES for part in path.parts):
                fail("Git source archive contains a private access input")
            if not (member.isfile() or member.isdir() or member.issym()):
                fail("Git source archive contains an unsupported entry")
            if member.issym():
                target = PurePosixPath(member.linkname)
                if target.is_absolute():
                    fail("Git source archive contains an unsafe symlink")
                depth = len(path.parent.parts)
                for part in target.parts:
                    if part == "..":
                        depth -= 1
                        if depth < 0:
                            fail("Git source archive contains an escaping symlink")
                    elif part not in ("", "."):
                        depth += 1


def extract_archive(archive: Path, destination: Path) -> None:
    validate_archive_members(archive)
    destination.mkdir()
    with tarfile.open(archive, "r:") as source:
        source.extractall(destination)


def read_json(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"could not read {label}: {error}")
    if not isinstance(value, dict):
        fail(f"{label} must be a JSON object")
    return value


def require_tree(root: Path, label: str) -> None:
    if not root.is_dir() or root.is_symlink():
        fail(f"built application is missing {label}")
    found = False
    for path in root.rglob("*"):
        mode = path.lstat().st_mode
        if stat.S_ISREG(mode):
            found = found or path.stat().st_size > 0
        elif stat.S_ISLNK(mode):
            target = os.readlink(path)
            if os.path.isabs(target):
                fail(f"built application contains an absolute symlink in {label}")
        elif not stat.S_ISDIR(mode):
            fail(f"built application contains a special file in {label}")
    if not found:
        fail(f"built application has an empty {label}")


def validate_and_copy(source: Path, output: Path) -> list[str]:
    destination = output / "packages"
    destination.mkdir(parents=True)
    license_path = source / "LICENSE"
    if not license_path.is_file() or license_path.is_symlink():
        fail("archived application source is missing LICENSE")
    shutil.copy2(license_path, output / "LICENSE")
    core_dependencies: list[str] = []
    for package in PACKAGES:
        package_source = source / "packages" / package
        manifest_path = package_source / "package.json"
        manifest = read_json(manifest_path, f"{package} package.json")
        if manifest.get("name") != package:
            fail(f"built application package name mismatch: {package}")
        require_tree(package_source / "dist", f"{package}/dist")
        package_destination = destination / package
        package_destination.mkdir()
        shutil.copy2(manifest_path, package_destination / "package.json")
        shutil.copytree(package_source / "dist", package_destination / "dist", symlinks=True)
        resources = package_source / "resources"
        if resources.exists() or package == "node-red-dashboard-2-yonder":
            require_tree(package_source / "resources", f"{package}/resources")
            shutil.copytree(
                package_source / "resources", package_destination / "resources", symlinks=True
            )
        if package == "yonder-core":
            for name in ("package-lock.json", "tsconfig.json"):
                path = package_source / name
                if not path.is_file() or path.is_symlink():
                    fail(f"built application is missing yonder-core/{name}")
                shutil.copy2(path, package_destination / name)
            dependencies = manifest.get("dependencies")
            if not isinstance(dependencies, dict) or not dependencies:
                fail("yonder-core has no declared production dependencies")
            core_dependencies = sorted(dependencies)
            if any(not NPM_NAME.fullmatch(dependency) for dependency in core_dependencies):
                fail("yonder-core declares an unsupported production dependency name")
            modules = package_source / "node_modules"
            require_tree(modules, "yonder-core/node_modules")
            for dependency in core_dependencies:
                parts = dependency.split("/")
                dependency_root = modules.joinpath(*parts)
                dependency_manifest = dependency_root / "package.json"
                if not dependency_root.is_dir() or dependency_root.is_symlink() \
                        or not dependency_manifest.is_file() or dependency_manifest.is_symlink():
                    fail(f"yonder-core production dependency is missing: {dependency}")
            shutil.copytree(modules, package_destination / "node_modules", symlinks=True)
    return core_dependencies


def copy_manifests(source: Path, npm_input: Path) -> None:
    manifests = npm_input / "manifests"
    (manifests / "packages").mkdir(parents=True)
    for name in ("package.json", "package-lock.json"):
        path = source / name
        if not path.is_file() or path.is_symlink():
            fail(f"archived application source is missing {name}")
        shutil.copy2(path, manifests / name)
    for package in PACKAGES:
        package_dir = manifests / "packages" / package
        package_dir.mkdir(parents=True)
        shutil.copy2(source / "packages" / package / "package.json", package_dir / "package.json")
    shutil.copy2(
        source / "packages" / "yonder-core" / "package-lock.json",
        manifests / "packages" / "yonder-core" / "package-lock.json",
    )


def validate_workspace_set(source: Path) -> None:
    actual = sorted(
        path.parent.name
        for path in (source / "packages").glob("*/package.json")
        if path.is_file() and not path.is_symlink()
    )
    if actual != sorted(PACKAGES):
        fail("archived application workspace package set is not explicitly covered")


PRIME_SCRIPT = r"""
set -eu
export PATH=/runtime/bin:/usr/bin:/bin
node --version
npm ci --cache /npm-input/cache/workspace --include=dev --no-audit --no-fund --os=linux --cpu=arm64 --libc=glibc
rm -rf packages/yonder-core/node_modules
npm ci --prefix packages/yonder-core --workspaces=false --omit=dev --no-audit --no-fund --cache /npm-input/cache/core --os=linux --cpu=arm64 --libc=glibc
rm -rf /npm-input/cache/workspace/_logs /npm-input/cache/core/_logs
rm -f /npm-input/cache/workspace/_update-notifier-last-checked /npm-input/cache/core/_update-notifier-last-checked
chown -R "$BUILD_OWNER" /npm-input
"""


BUILD_SCRIPT = r"""
set -eu
export PATH=/runtime/bin:/usr/bin:/bin
node --version
npm ci --offline --cache /npm-input/cache/workspace --include=dev --no-audit --no-fund --os=linux --cpu=arm64 --libc=glibc
npm run build
rm -rf packages/yonder-core/node_modules
npm ci --offline --prefix packages/yonder-core --workspaces=false --omit=dev --no-audit --no-fund --cache /npm-input/cache/core --os=linux --cpu=arm64 --libc=glibc
rm -rf /npm-input/cache/workspace/_logs /npm-input/cache/core/_logs
rm -f /npm-input/cache/workspace/_update-notifier-last-checked /npm-input/cache/core/_update-notifier-last-checked
node --input-type=module -e 'await import("./packages/yonder-core/dist/daemon/server.js"); await import("./packages/yonder-core/dist/admin/main.js"); await import("./packages/yonder-core/dist/owner-access/cli.js")'
chown -R "$BUILD_OWNER" /src /npm-input
"""


def build(args: argparse.Namespace) -> None:
    repo = Path(args.repo).resolve()
    output = Path(args.output).resolve()
    npm_input = Path(args.npm_input).resolve()
    source_output = Path(args.source_output).resolve()
    node_runtime = Path(args.node_runtime).resolve()
    separate_new_paths([output, npm_input, source_output])
    if not repo.is_dir() or not (repo / ".git").exists():
        fail("application source is not a Git checkout")
    if args.platform != "linux/arm64" or not IMAGE.fullmatch(args.image):
        fail("application build requires a digest-pinned linux/arm64 image")
    if not COMMIT.fullmatch(args.expected_commit):
        fail("expected application source commit is invalid")
    node = node_runtime / "bin" / "node"
    if not node.is_file() or node.is_symlink() or not os.access(node, os.X_OK):
        fail("pinned ARM64 Node runtime is unavailable")
    require_arm64_elf(node, "pinned Node runtime")
    engine = shutil.which(args.engine)
    if not engine:
        fail("container engine is unavailable")
    commit = run(["git", "rev-parse", "HEAD"], repo, capture=True)
    if commit != args.expected_commit:
        fail("application source commit does not match the requested commit")
    if not COMMIT.fullmatch(commit):
        fail("application source commit is invalid")
    if run(["git", "status", "--porcelain", "--untracked-files=all"], repo, capture=True):
        fail("application source tree is not clean")

    output.parent.mkdir(parents=True, exist_ok=True)
    npm_input.parent.mkdir(parents=True, exist_ok=True)
    source_output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".application-build-", dir=output.parent) as temporary:
        temporary_root = Path(temporary)
        archived = temporary_root / "source.tar"
        prime_source = temporary_root / "prime-source"
        source = temporary_root / "offline-source"
        output_partial = temporary_root / "application"
        npm_partial = temporary_root / "npm-input"
        npm_partial.mkdir()
        (npm_partial / "cache" / "workspace").mkdir(parents=True)
        (npm_partial / "cache" / "core").mkdir(parents=True)
        run(["git", "archive", "--format=tar", f"--output={archived}", commit], repo)
        extract_archive(archived, prime_source)
        validate_workspace_set(prime_source)
        copy_manifests(prime_source, npm_partial)
        run([
            engine, "run", "--rm", "--platform", args.platform,
            "-v", f"{prime_source}:/src", "-v", f"{node_runtime}:/runtime:ro",
            "-v", f"{npm_partial}:/npm-input", "-w", "/src",
            "-e", f"BUILD_OWNER={os.getuid()}:{os.getgid()}",
            args.image, "sh", "-c", PRIME_SCRIPT,
        ], repo)
        extract_archive(archived, source)
        run([
            engine, "run", "--rm", "--network", "none", "--platform", args.platform,
            "-v", f"{source}:/src", "-v", f"{node_runtime}:/runtime:ro",
            "-v", f"{npm_partial}:/npm-input", "-w", "/src",
            "-e", f"BUILD_OWNER={os.getuid()}:{os.getgid()}",
            args.image, "sh", "-c", BUILD_SCRIPT,
        ], repo)
        core_dependencies = validate_and_copy(source, output_partial)
        archive_hash = sha256(archived)
        metadata = {
            "schemaVersion": 1,
            "kind": "yonder-first-party-application",
            "sourceCommit": commit,
            "sourceKind": "git-archive",
            "sourceArchiveSha256": archive_hash,
            "platform": args.platform,
            "toolchainImage": args.image,
            "nodeRuntime": "retained-payload-node",
            "offlineBuild": OFFLINE_BUILD,
            "packages": PACKAGES,
            "coreProductionDependencies": core_dependencies,
        }
        (output_partial / "application-bundle.json").write_text(
            json.dumps(metadata, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        published: list[Path] = []
        try:
            os.replace(archived, source_output)
            published.append(source_output)
            os.replace(npm_partial, npm_input)
            published.append(npm_input)
            os.replace(output_partial, output)
            published.append(output)
        except BaseException:
            for path in reversed(published):
                if path.is_dir() and not path.is_symlink():
                    shutil.rmtree(path, ignore_errors=True)
                else:
                    path.unlink(missing_ok=True)
            raise


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--repo", required=True)
    result.add_argument("--output", required=True)
    result.add_argument("--npm-input", required=True)
    result.add_argument("--source-output", required=True)
    result.add_argument("--node-runtime", required=True)
    result.add_argument("--engine", required=True)
    result.add_argument("--image", required=True)
    result.add_argument("--platform", required=True)
    result.add_argument("--expected-commit", required=True)
    return result


def main() -> int:
    try:
        build(parser().parse_args())
    except BundleError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
