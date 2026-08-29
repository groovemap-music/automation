#!/usr/bin/env python3
"""Validate the organization-wide Python tool policy without third-party dependencies."""

from __future__ import annotations

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

MYPY_POLICY = {
    "python_version": "3.13",
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

IGNORED_DIRECTORIES = {".git", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".venv", "node_modules", "target"}
HEADER = re.compile(r"^\[([^[][^]]*)\]$")


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


def validate_pyproject(path: Path) -> list[str]:
    errors: list[str] = []
    text = path.read_text(encoding="utf-8")
    try:
        document = tomllib.loads(text)
    except tomllib.TOMLDecodeError as error:
        return [f"{path}: invalid TOML: {error}"]

    families = physical_families(text)
    check_equal(errors, path, "section-family order", families, EXPECTED_FAMILY_ORDER)

    try:
        check_equal(errors, path, "build backend", nested(document, "build-system", "build-backend"), "hatchling.build")
        check_equal(errors, path, "build requirements", nested(document, "build-system", "requires"), ["hatchling>=1.27.0"])

        project = nested(document, "project")
        check_equal(errors, path, "Python requirement", project.get("requires-python"), ">=3.13")

        development = set(nested(document, "dependency-groups", "dev"))
        missing_development = sorted(COMMON_DEV_DEPENDENCIES - development)
        if missing_development:
            errors.append(f"{path}: development dependencies missing {missing_development!r}")

        nested(document, "tool", "hatch", "build", "targets", "wheel")
        check_equal(errors, path, "uv.exclude-newer", nested(document, "tool", "uv", "exclude-newer"), "2 days")

        ruff = nested(document, "tool", "ruff")
        check_equal(errors, path, "ruff.line-length", ruff.get("line-length"), 150)
        check_equal(errors, path, "ruff.target-version", ruff.get("target-version"), "py313")
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

    return errors


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

    errors = [error for path in paths for error in validate_pyproject(path)]
    if errors:
        for error in errors:
            print(f"ERROR {error}", file=sys.stderr)
        return 1

    print(f"Validated shared Python policy in {len(paths)} pyproject.toml file(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
