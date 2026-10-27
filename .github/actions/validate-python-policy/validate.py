#!/usr/bin/env python3
"""Validate the organization-wide Python tool policy without third-party dependencies."""

from __future__ import annotations

import datetime
import re
import sys
import tomllib
from pathlib import Path
from typing import Any


COMMON_DEV_DEPENDENCIES = {
    "build>=1.3.0",
    "commitizen>=4.18.0",
    "cyclonedx-bom>=7.3.1",
    "mypy>=2.3.1",
    "pip-audit>=2.10.1",
    "pip-licenses>=5.5.5",
    "pytest>=9.1.1",
    "pytest-asyncio>=1.4.0",
    "pytest-cov>=7.1.0",
    "pytest-timeout>=2.4.0",
    "pytest-xdist>=3.8.0",
    "ruff>=0.16.4",
}

EXPECTED_FAMILY_ORDER = [
    "build-system",
    "project",
    "dependency-groups",
    "tool.hatch",
    "tool.uv",
    "tool.ruff",
    "tool.mypy",
    "tool.pytest",
    "tool.coverage",
    "tool.commitizen",
]

RUFF_SELECT = ["ARG", "B", "C4", "E", "F", "I", "PLC", "PTH", "RUF", "S", "SIM", "T20", "TCH", "UP", "W"]
RUFF_IGNORE = ["B008", "C901", "E501", "S101"]

PYTHON_REQUIREMENT = {">=3.14", "<3.15"}
PYTHON_REQUIREMENT_TEXT = ">=3.14,<3.15"
RUFF_TARGET = "py314"
PYTHON_MINOR = "3.14"
MISE_PYTHON_PIN = "3.14.7"
FULL_VERSION = re.compile(r"\d+\.\d+\.\d+")
MINOR_VERSION = re.compile(r"\d+\.\d+")

MYPY_POLICY = {
    "python_version": PYTHON_MINOR,
    "warn_return_any": True,
    "warn_unused_configs": True,
    "disallow_untyped_defs": True,
    "disallow_incomplete_defs": True,
    "check_untyped_defs": True,
    "no_implicit_optional": True,
    "warn_redundant_casts": True,
    "warn_unused_ignores": True,
    "warn_no_return": True,
    "warn_unreachable": True,
    "strict_equality": True,
}

PYTEST_POLICY = {
    "addopts": "-ra -q --strict-markers --tb=short",
    "asyncio_mode": "strict",
    "asyncio_default_fixture_loop_scope": "function",
    "timeout": 60,
    "timeout_method": "thread",
}

COMMON_MARKERS = {
    "benchmark: performance regression benchmarks",
    "e2e: end-to-end tests requiring external services",
    "integration: tests requiring a live backing service",
}

COVERAGE_OMIT = ["*/tests/*", "*/__init__.py"]
COVERAGE_EXCLUDES = [
    "def __repr__",
    "if __name__ == .__main__.:",
    "pragma: no cover",
    "raise AssertionError",
    "raise NotImplementedError",
]

COMMITIZEN_POLICY = {
    "name": "cz_conventional_commits",
    "version_provider": "uv",
    "version_scheme": "pep440",
    "tag_format": "v$version",
    "annotated_tag": True,
    "update_changelog_on_bump": True,
    "changelog_file": "CHANGELOG.md",
}

EXCLUDE_NEWER = "7 days"
EXCLUDE_NEWER_WINDOW = datetime.timedelta(days=7)
UTC_TIMESTAMP = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z")
LOCAL_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")
DURATION = re.compile(r"P(?=\d|T)[\dYMWDTHS.,]+|\d+\s*[A-Za-z]+(?:\s+\d+\s*[A-Za-z]+)*")
# PEP 508 name grammar; PEP 503 normalization only folds case and runs of ._- so it adds no characters.
PACKAGE_NAME = re.compile(r"[A-Z0-9](?:[A-Z0-9._-]*[A-Z0-9])?", re.IGNORECASE)

IGNORED_DIRECTORIES = {".git", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".venv", "node_modules", "target"}
HEADER = re.compile(r"^\[([^[][^]]*)\]$")


def escape_data(value: str) -> str:
    """Escape annotation data as GitHub's workflow-command parser expects, so it cannot end the line."""
    return value.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def escape_property(value: str) -> str:
    """Escape an annotation property value; properties also reserve the `:` and `,` delimiters."""
    return escape_data(value).replace(":", "%3A").replace(",", "%2C")


def annotation(level: str, message: str, file: str | None = None) -> str:
    """Build the only workflow-command line this script emits; every caller-supplied byte is escaped."""
    properties = f" file={escape_property(file)}" if file is not None else ""
    return f"::{level}{properties}::{escape_data(message)}"


def error_line(message: str) -> str:
    """Format a stderr error; the runner scans stderr for commands too, so it is escaped the same way."""
    return f"ERROR {escape_data(message)}"


def nested(document: dict[str, Any], *keys: str) -> Any:
    value: Any = document
    for key in keys:
        if not isinstance(value, dict) or key not in value:
            raise KeyError(".".join(keys))
        value = value[key]
    return value


def table_family(header: str) -> str | None:
    for family in EXPECTED_FAMILY_ORDER:
        if header == family or header.startswith(f"{family}."):
            return family
    return None


def physical_families(text: str) -> list[str]:
    families: list[str] = []
    for line in text.splitlines():
        match = HEADER.match(line.strip())
        if not match:
            continue
        family = table_family(match.group(1))
        if family is not None and (not families or families[-1] != family):
            families.append(family)
    return families


def check_equal(errors: list[str], path: Path, label: str, actual: Any, expected: Any) -> None:
    if actual != expected:
        errors.append(f"{path}: {label} must be {expected!r}; found {actual!r}")


def exclude_newer_package_findings(path: Path, table: Any, now: datetime.datetime) -> tuple[list[str], list[str]]:
    """Validate per-package exceptions; each admits one fixed release rather than opting a package out."""
    if not isinstance(table, dict):
        return [f"{path}: uv.exclude-newer-package must be a table of package timestamps; found {table!r}"], []

    errors: list[str] = []
    warnings: list[str] = []
    guidance = "an exception admits one fixed release as an RFC 3339 UTC timestamp (YYYY-MM-DDTHH:MM:SSZ)"
    for package, value in table.items():
        label = f"uv.exclude-newer-package[{package!r}]"
        if not PACKAGE_NAME.fullmatch(package):
            errors.append(f"{path}: uv.exclude-newer-package key {package!r} is not a valid PEP 508 package name")
        elif isinstance(value, bool):
            errors.append(f"{path}: {label} must not be {str(value).lower()}; {guidance}, it does not opt a package out of the window")
        elif isinstance(value, datetime.date) or (isinstance(value, str) and LOCAL_DATE.fullmatch(value)):
            errors.append(f"{path}: {label} must not be a local date ({value}); {guidance}")
        elif isinstance(value, str) and DURATION.fullmatch(value):
            errors.append(f"{path}: {label} must not be a duration ({value!r}); {guidance}, the global window is already {EXCLUDE_NEWER!r}")
        elif not isinstance(value, str) or not UTC_TIMESTAMP.fullmatch(value):
            errors.append(f"{path}: {label} must be an RFC 3339 UTC timestamp string (YYYY-MM-DDTHH:MM:SSZ); found {value!r}")
        else:
            try:
                admitted = datetime.datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.UTC)
            except ValueError:
                errors.append(f"{path}: {label} is not a valid calendar timestamp; found {value!r}")
                continue
            if admitted > now:
                errors.append(
                    f"{path}: {label} ({value}) is in the future; an exception admits a release that has already been published, "
                    "so use the timestamp of that release"
                )
            elif now - admitted > EXCLUDE_NEWER_WINDOW:
                warnings.append(
                    f"{label} ({value}) is older than {EXCLUDE_NEWER}; the global window now covers it and keeping it freezes the package, remove it"
                )
    return errors, warnings


def validate_pyproject(path: Path, now: datetime.datetime | None = None) -> tuple[list[str], list[str]]:
    """Return (errors, warnings); `now` is injectable so the stale-exception check is deterministic."""
    errors: list[str] = []
    warnings: list[str] = []
    now = now or datetime.datetime.now(datetime.UTC)
    text = path.read_text(encoding="utf-8")
    try:
        document = tomllib.loads(text)
    except tomllib.TOMLDecodeError as error:
        return [f"{path}: invalid TOML: {error}"], []

    families = physical_families(text)
    check_equal(errors, path, "section-family order", families, EXPECTED_FAMILY_ORDER)

    try:
        check_equal(errors, path, "build backend", nested(document, "build-system", "build-backend"), "hatchling.build")
        check_equal(errors, path, "build requirements", nested(document, "build-system", "requires"), ["hatchling>=1.27.0"])

        project = nested(document, "project")
        requirement = project.get("requires-python")
        if not isinstance(requirement, str) or {part.strip().replace(" ", "") for part in requirement.split(",")} != PYTHON_REQUIREMENT:
            errors.append(f"{path}: project.requires-python must be {PYTHON_REQUIREMENT_TEXT!r}; found {requirement!r}")

        development = set(nested(document, "dependency-groups", "dev"))
        missing_development = sorted(COMMON_DEV_DEPENDENCIES - development)
        if missing_development:
            errors.append(f"{path}: development dependencies missing {missing_development!r}")

        nested(document, "tool", "hatch", "build", "targets", "wheel")
        check_equal(errors, path, "uv.exclude-newer", nested(document, "tool", "uv", "exclude-newer"), EXCLUDE_NEWER)
        uv = nested(document, "tool", "uv")
        if "exclude-newer-package" in uv:
            package_errors, package_warnings = exclude_newer_package_findings(path, uv["exclude-newer-package"], now)
            errors.extend(package_errors)
            warnings.extend(package_warnings)

        ruff = nested(document, "tool", "ruff")
        check_equal(errors, path, "ruff.line-length", ruff.get("line-length"), 150)
        check_equal(errors, path, "ruff.target-version", ruff.get("target-version"), RUFF_TARGET)
        lint = nested(document, "tool", "ruff", "lint")
        check_equal(errors, path, "ruff select rules", lint.get("select"), RUFF_SELECT)
        check_equal(errors, path, "ruff ignored rules", lint.get("ignore"), RUFF_IGNORE)
        isort = nested(document, "tool", "ruff", "lint", "isort")
        check_equal(errors, path, "isort lines-after-imports", isort.get("lines-after-imports"), 2)
        if not isinstance(isort.get("known-first-party"), list) or not isort["known-first-party"]:
            errors.append(f"{path}: isort.known-first-party must be a non-empty repository-specific list")

        mypy = nested(document, "tool", "mypy")
        for key, expected in MYPY_POLICY.items():
            check_equal(errors, path, f"mypy.{key}", mypy.get(key), expected)
        if not any(key in mypy for key in ("files", "packages", "modules")):
            errors.append(f"{path}: mypy must declare a repository-specific files, packages, or modules target")

        pytest = nested(document, "tool", "pytest", "ini_options")
        for key, expected in PYTEST_POLICY.items():
            check_equal(errors, path, f"pytest.{key}", pytest.get(key), expected)
        if not isinstance(pytest.get("testpaths"), list) or not pytest["testpaths"]:
            errors.append(f"{path}: pytest.testpaths must be a non-empty repository-specific list")
        missing_markers = sorted(COMMON_MARKERS - set(pytest.get("markers", [])))
        if missing_markers:
            errors.append(f"{path}: pytest markers missing {missing_markers!r}")

        coverage_run = nested(document, "tool", "coverage", "run")
        if not isinstance(coverage_run.get("source"), list) or not coverage_run["source"]:
            errors.append(f"{path}: coverage.run.source must be a non-empty repository-specific list")
        check_equal(errors, path, "coverage.run.omit", coverage_run.get("omit"), COVERAGE_OMIT)
        check_equal(
            errors,
            path,
            "coverage.report.exclude_lines",
            nested(document, "tool", "coverage", "report", "exclude_lines"),
            COVERAGE_EXCLUDES,
        )

        commitizen = nested(document, "tool", "commitizen")
        for key, expected in COMMITIZEN_POLICY.items():
            check_equal(errors, path, f"commitizen.{key}", commitizen.get(key), expected)
        if not isinstance(commitizen.get("version_files"), list):
            errors.append(f"{path}: commitizen.version_files must be a repository-specific list")
    except KeyError as error:
        errors.append(f"{path}: required configuration table or key is missing: {error.args[0]}")

    return errors, warnings


def mise_python_findings(path: Path) -> list[str]:
    """Check the Python pin in a `.mise.toml`; unpinned and non-version declarations are outside the contract."""
    try:
        tools = tomllib.loads(path.read_text(encoding="utf-8")).get("tools", {})
    except tomllib.TOMLDecodeError as error:
        return [f"{path}: invalid TOML: {error}"]
    pin = tools.get("python") if isinstance(tools, dict) else None
    if isinstance(pin, dict):
        pin = pin.get("version")
    if not isinstance(pin, str):
        return []
    if FULL_VERSION.fullmatch(pin) and pin != MISE_PYTHON_PIN:
        return [f"{path}: mise tools.python must be {MISE_PYTHON_PIN!r} when patch-pinned; found {pin!r}"]
    if MINOR_VERSION.fullmatch(pin) and pin != PYTHON_MINOR:
        return [f"{path}: mise tools.python must be {PYTHON_MINOR!r} (or patch-pinned to {MISE_PYTHON_PIN!r}); found {pin!r}"]
    return []


def discover_mise(root: Path) -> list[Path]:
    return sorted(
        path
        for path in root.rglob(".mise.toml")
        if not any(part in IGNORED_DIRECTORIES for part in path.relative_to(root).parts)
    )


def discover(root: Path) -> list[Path]:
    return sorted(
        path
        for path in root.rglob("pyproject.toml")
        if not any(part in IGNORED_DIRECTORIES for part in path.relative_to(root).parts)
    )


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
    paths = discover(root)
    if not paths:
        print("No pyproject.toml files found; shared Python policy not applicable.")
        return 0

    errors: list[str] = []
    for path in paths:
        path_errors, path_warnings = validate_pyproject(path)
        errors.extend(path_errors)
        for warning in path_warnings:
            print(annotation("warning", warning, file=path.relative_to(root).as_posix()))
    for mise_path in discover_mise(root):
        errors.extend(mise_python_findings(mise_path))
    if errors:
        for error in errors:
            print(error_line(error), file=sys.stderr)
        return 1

    print(f"Validated shared Python policy in {len(paths)} pyproject.toml file(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
