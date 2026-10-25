#!/usr/bin/env python3
# Author: jperch1987
"""Read non-secret profile metadata from a standard local AWS config file."""

from __future__ import annotations

import argparse
import configparser
import json
from pathlib import Path
import shlex
import sys
import unicodedata


MAX_CONFIG_BYTES = 1024 * 1024
MAX_PROFILES = 1000
PROFILE_FIELDS = ("role_arn", "source_profile", "region")


class ProfileConfigError(ValueError):
    """A safe diagnostic that never contains source lines or field values."""


def _validate_single_line(value: str) -> None:
    if any(unicodedata.category(character) in ("Cc", "Cs") for character in value):
        raise ProfileConfigError(
            "Profile names and metadata must be single-line text without control characters."
        )


def _profile_name(section: str) -> str | None:
    normalized = section.strip()
    if normalized == "default":
        return "default"
    prefix = normalized.split(maxsplit=1)
    if not prefix or prefix[0] != "profile":
        return None
    # AWS uses shell-style quoting for section names, so [profile "team dev"]
    # means the profile named team dev, without literal surrounding quotes.
    try:
        parts = shlex.split(normalized)
    except ValueError as error:
        raise ProfileConfigError("Invalid profile section name. Check its quotation marks.") from error
    if len(parts) < 2 or not parts[1].strip():
        raise ProfileConfigError("A profile section is missing its profile name.")
    if len(parts) != 2:
        raise ProfileConfigError("Invalid profile section name. Quote profile names containing spaces.")
    name = parts[1]
    _validate_single_line(name)
    return name


def parse_profiles(text: str) -> list[dict[str, str]]:
    """Parse AWS profile sections without interpolation or implicit inheritance."""
    # A newline default-section name cannot be a valid INI section. In particular,
    # an INI [DEFAULT] section must never inject region/role values into profiles.
    parser = configparser.ConfigParser(
        interpolation=None,
        strict=True,
        default_section="\n",
        empty_lines_in_values=False,
    )
    try:
        parser.read_string(text)
    except configparser.DuplicateSectionError as error:
        raise ProfileConfigError(
            "Duplicate section in AWS config. Each section must appear only once."
        ) from error
    except configparser.DuplicateOptionError as error:
        raise ProfileConfigError(
            "Duplicate option in AWS config. Each option must appear only once per section."
        ) from error
    except configparser.Error as error:
        raise ProfileConfigError(
            "Invalid AWS config format. Check section headers and key/value entries."
        ) from error

    profiles: list[dict[str, str]] = []
    names: set[str] = set()
    for section in parser.sections():
        name = _profile_name(section)
        if name is None:
            continue
        if name in names:
            raise ProfileConfigError(
                "Duplicate profile name in AWS config after normalizing section names."
            )
        names.add(name)
        if len(names) > MAX_PROFILES:
            raise ProfileConfigError(f"AWS config contains more than {MAX_PROFILES} profiles.")
        profile = {"profile": name}
        for field in PROFILE_FIELDS:
            value = parser.get(section, field, fallback="")
            _validate_single_line(value)
            profile[field] = value
        profiles.append(profile)
    return profiles


def read_profiles(file_path: str | Path) -> dict[str, object]:
    """Read at most 1 MiB; expose only explicitly allowed metadata fields."""
    try:
        path = Path(file_path).expanduser().resolve()
        with path.open("rb") as config_file:
            raw = config_file.read(MAX_CONFIG_BYTES + 1)
    except FileNotFoundError as error:
        raise ProfileConfigError("Profiles file was not found. Check the configured file path.") from error
    except PermissionError as error:
        raise ProfileConfigError("Permission denied while reading the profiles file.") from error
    except IsADirectoryError as error:
        raise ProfileConfigError("The profiles file path points to a directory.") from error
    except (OSError, ValueError, RuntimeError) as error:
        raise ProfileConfigError("Unable to read the profiles file. Check the configured file path.") from error
    if len(raw) > MAX_CONFIG_BYTES:
        raise ProfileConfigError("Profiles file is too large. The maximum size is 1 MiB.")
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise ProfileConfigError("Profiles file must be UTF-8 text.") from error
    return {"profiles": parse_profiles(text), "file": str(path)}


def main() -> int:
    argument_parser = argparse.ArgumentParser(description=__doc__)
    argument_parser.add_argument("--file", required=True, help="Path to an AWS config-format text file")
    args = argument_parser.parse_args()
    try:
        result = read_profiles(args.file)
    except ProfileConfigError as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=True), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
