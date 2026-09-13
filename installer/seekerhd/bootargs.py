#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Add the SeekerHD RKISP notifier preservation argument to armbianEnv.txt."""
import argparse
import os
from pathlib import Path
import stat
import tempfile
from typing import List, Optional, Tuple


CALLBACK = "rkisp_clr_unready_dev"
TOKEN = f"initcall_blacklist={CALLBACK}"


def arguments(value: str) -> List[Tuple[int, int, str]]:
    """Preserve spans using Linux next_arg double-quote rules, not shell escapes."""
    tokens = []
    position = 0
    while position < len(value):
        if value[position].isspace():
            position += 1
            continue
        start = position
        quoted = False
        while position < len(value):
            character = value[position]
            if character.isspace() and not quoted:
                break
            if character == '"':
                quoted = not quoted
            position += 1
        if quoted:
            raise ValueError("unsupported unterminated double quote in extraargs")
        raw = value[start:position]
        # Linux lib/cmdline.c next_arg strips an enclosing argument quote
        # and quotes around its value; single quotes/backslashes are literal.
        argument = raw[1:-1] if raw.startswith('"') and raw.endswith('"') else raw
        name, separator, argument_value = argument.partition('=')
        if argument_value.startswith('"'):
            argument_value = argument_value[1:]
            if argument_value.endswith('"'):
                argument_value = argument_value[:-1]
        decoded = name + separator + argument_value
        if decoded == '--':
            raise ValueError("extraargs contains --; kernel parameters must precede the init argument terminator")
        tokens.append((start, position, decoded))
    return tokens


def blacklist_arguments(value: str) -> List[Tuple[int, int, str]]:
    return [token for token in arguments(value) if token[2].startswith("initcall_blacklist=")]


def blacklist_replacement(raw: str, decoded: str, callbacks: List[str]) -> str:
    value = ",".join(callbacks)
    prefix = "initcall_blacklist="
    if raw.startswith(prefix):
        tail = raw[len(prefix):]
        if not tail or tail[0] != '"':
            return prefix + value
        if len(tail) >= 2 and tail[0] == tail[-1] and tail[0] == '"':
            return prefix + tail[0] + value + tail[-1]
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] == '"':
        return raw[0] + prefix + value + raw[-1]
    raise ValueError(f"unsupported quoting around {decoded}")


def parse(path: Path) -> Tuple[List[str], Optional[int]]:
    lines = path.read_text().splitlines(keepends=True)
    indices = [index for index, line in enumerate(lines) if line.rstrip("\r\n").startswith("extraargs=")]
    if len(indices) > 1:
        raise ValueError("ambiguous armbianEnv.txt: more than one extraargs line")
    return lines, indices[0] if indices else None


def updated(lines: List[str], index: Optional[int]) -> List[str]:
    if index is None:
        result = lines.copy()
        if result and not result[-1].endswith(("\n", "\r")):
            result[-1] += "\n"
        return [*result, f"extraargs={TOKEN}\n"]
    ending = "\r\n" if lines[index].endswith("\r\n") else "\n"
    value = lines[index].rstrip("\r\n")[len("extraargs="):]
    blacklist = blacklist_arguments(value)
    if len(blacklist) > 1:
        raise ValueError("ambiguous armbianEnv.txt: more than one initcall_blacklist argument")
    if blacklist:
        start, end, current = blacklist[0]
        callbacks = current.split("=", 1)[1].split(",")
        if CALLBACK not in callbacks:
            callbacks.append(CALLBACK)
        callbacks = [callback for callback in callbacks if callback]
        replacement = blacklist_replacement(value[start:end], current, callbacks)
        value = value[:start] + replacement + value[end:]
    else:
        value += (" " if value else "") + TOKEN
    result = lines.copy()
    result[index] = "extraargs=" + value + ending
    return result


def has_token(lines: List[str], index: Optional[int]) -> bool:
    if index is None:
        return False
    value = lines[index].rstrip("\r\n")[len("extraargs="):]
    blacklist = blacklist_arguments(value)
    if len(blacklist) > 1:
        raise ValueError("ambiguous armbianEnv.txt: more than one initcall_blacklist argument")
    return bool(blacklist and CALLBACK in blacklist[0][2].split("=", 1)[1].split(","))


def replace(path: Path, content: str) -> None:
    previous = path.stat()
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(descriptor, stat.S_IMODE(previous.st_mode))
        os.fchown(descriptor, previous.st_uid, previous.st_gid)
        with os.fdopen(descriptor, "w") as file:
            file.write(content)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    except BaseException:
        try:
            os.close(descriptor)
        except OSError:
            pass
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument("path", type=Path)
    options = parser.parse_args()
    lines, index = parse(options.path)
    if options.check:
        if not has_token(lines, index):
            raise SystemExit(f"{options.path} does not contain {TOKEN}")
        return
    replace(options.path, "".join(updated(lines, index)))


if __name__ == "__main__":
    main()
