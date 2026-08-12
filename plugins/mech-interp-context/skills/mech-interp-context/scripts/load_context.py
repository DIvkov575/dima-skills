#!/usr/bin/env python3
"""Resolve, validate, and emit the local ARENA context file."""

from __future__ import annotations

import argparse
import hashlib
import os
import sys
from pathlib import Path


FILENAME = "arena_all_650k.txt"
EXPECTED_BYTES = 2_327_866
EXPECTED_LINES = 48_640
EXPECTED_SHA256 = (
    "9b22955cd5e52cdce4b02c628c3da037df4540226aaa3107edb0def025dfb8ef"
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Validate and emit the full local ARENA context."
    )
    parser.add_argument("--file", type=Path, help="Explicit context file path")
    parser.add_argument(
        "--check",
        action="store_true",
        help="Validate the file and print metadata without emitting its contents",
    )
    parser.add_argument(
        "--path",
        action="store_true",
        help="Validate the file and print only its resolved path",
    )
    parser.add_argument("--start-line", type=int, help="First line to emit, inclusive")
    parser.add_argument("--end-line", type=int, help="Last line to emit, inclusive")
    return parser.parse_args()


def candidate_paths(explicit: Path | None) -> list[Path]:
    candidates: list[Path] = []
    if explicit is not None:
        candidates.append(explicit.expanduser())

    context_file = os.environ.get("MECH_INTERP_CONTEXT_FILE")
    if context_file:
        candidates.append(Path(context_file).expanduser())

    project_root = os.environ.get("MECH_INTERP_ROOT")
    if project_root:
        candidates.append(Path(project_root).expanduser() / "resources" / FILENAME)

    candidates.append(
        Path.home() / "workplace" / "mech-interp" / "resources" / FILENAME
    )
    return candidates


def resolve_context(explicit: Path | None) -> Path:
    candidates = candidate_paths(explicit)
    for candidate in candidates:
        if candidate.is_file():
            return candidate.resolve()

    checked = "\n".join(f"  - {path}" for path in candidates)
    raise FileNotFoundError(f"{FILENAME} was not found. Checked:\n{checked}")


def validate_context(path: Path) -> tuple[bytes, int, str]:
    data = path.read_bytes()
    byte_count = len(data)
    line_count = data.count(b"\n")
    digest = hashlib.sha256(data).hexdigest()

    errors = []
    if byte_count != EXPECTED_BYTES:
        errors.append(f"bytes={byte_count}, expected={EXPECTED_BYTES}")
    if line_count != EXPECTED_LINES:
        errors.append(f"lines={line_count}, expected={EXPECTED_LINES}")
    if digest != EXPECTED_SHA256:
        errors.append(f"sha256={digest}, expected={EXPECTED_SHA256}")
    if errors:
        raise ValueError(f"Context validation failed for {path}: " + "; ".join(errors))
    return data, line_count, digest


def select_lines(data: bytes, start: int | None, end: int | None) -> bytes:
    if start is None and end is None:
        return data

    first = 1 if start is None else start
    last = EXPECTED_LINES if end is None else end
    if first < 1 or last < first or last > EXPECTED_LINES:
        raise ValueError(
            f"Invalid line range {first}-{last}; expected 1-{EXPECTED_LINES}"
        )
    return b"".join(data.splitlines(keepends=True)[first - 1 : last])


def main() -> int:
    args = parse_args()
    if args.check and args.path:
        raise ValueError("--check and --path are mutually exclusive")

    path = resolve_context(args.file)
    data, line_count, digest = validate_context(path)

    if args.path:
        print(path)
        return 0
    if args.check:
        print(
            f"OK path={path} bytes={len(data)} lines={line_count} sha256={digest}"
        )
        return 0

    output = select_lines(data, args.start_line, args.end_line)
    try:
        sys.stdout.buffer.write(output)
    except BrokenPipeError:
        return 0
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (FileNotFoundError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1)
