#!/usr/bin/env python3
"""Behavior tests for the shared Python policy validator."""

from __future__ import annotations

import datetime
import importlib.util
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
VALIDATOR = ROOT / ".github/actions/validate-python-policy/validate.py"
ACTION = ROOT / ".github/actions/validate-python-policy/action.yml"
sys.dont_write_bytecode = True
NOW = datetime.datetime(2026, 10, 23, 12, 0, 0, tzinfo=datetime.UTC)

spec = importlib.util.spec_from_file_location("validate_python_policy", VALIDATOR)
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)

PYPROJECT = """\
[build-system]
requires = ["hatchling>=1.27.0"]
build-backend = "hatchling.build"

[project]
name = "synthetic"
version = "0.0.0"
requires-python = ">=3.13"

[dependency-groups]
dev = [{dev}]

[tool.hatch.build.targets.wheel]
packages = ["src/synthetic"]

[tool.uv]
exclude-newer = "{window}"
{uv_extra}

[tool.ruff]
line-length = 150
target-version = "py313"

[tool.ruff.lint]
select = {select}
ignore = {ignore}

[tool.ruff.lint.isort]
known-first-party = ["synthetic"]
lines-after-imports = 2

[tool.mypy]
files = ["src"]
{mypy}

[tool.pytest.ini_options]
testpaths = ["tests"]
markers = {markers}
{pytest}

[tool.coverage.run]
source = ["src"]
omit = {omit}

[tool.coverage.report]
exclude_lines = {excludes}

[tool.commitizen]
version_files = []
{commitizen}
"""


def toml_value(value: object) -> str:
    if isinstance(value, bool):
        return str(value).lower()
    if isinstance(value, list):
        return "[" + ", ".join(toml_value(item) for item in value) + "]"
    return '"' + str(value) + '"' if isinstance(value, str) else str(value)


def render(window: str = "7 days", uv_extra: str = "") -> str:
    return PYPROJECT.format(
        dev=", ".join(toml_value(item) for item in sorted(policy.COMMON_DEV_DEPENDENCIES)),
        window=window,
        uv_extra=uv_extra,
        select=toml_value(policy.RUFF_SELECT),
        ignore=toml_value(policy.RUFF_IGNORE),
        mypy="\n".join(f"{key} = {toml_value(value)}" for key, value in policy.MYPY_POLICY.items()),
        markers=toml_value(sorted(policy.COMMON_MARKERS)),
        pytest="\n".join(f"{key} = {toml_value(value)}" for key, value in policy.PYTEST_POLICY.items()),
        omit=toml_value(policy.COVERAGE_OMIT),
        excludes=toml_value(policy.COVERAGE_EXCLUDES),
        commitizen="\n".join(f"{key} = {toml_value(value)}" for key, value in policy.COMMITIZEN_POLICY.items()),
    )


def packages(body: str) -> str:
    return f"[tool.uv.exclude-newer-package]\n{body}\n"


def check(directory: Path, text: str) -> tuple[list[str], list[str]]:
    path = directory / "pyproject.toml"
    path.write_text(text, encoding="utf-8")
    return policy.validate_pyproject(path, NOW)


def only(findings: list[str]) -> str:
    assert len(findings) == 1, findings
    return findings[0]


with tempfile.TemporaryDirectory() as scratch:
    directory = Path(scratch)

    errors, warnings = check(directory, render())
    assert errors == [] and warnings == [], (errors, warnings)

    errors, _ = check(directory, render(window="2 days"))
    assert "uv.exclude-newer must be '7 days'; found '2 days'" in only(errors)

    # The accepted form is an RFC 3339 UTC timestamp, and a fresh exception is silent.
    fresh = packages('pillow = "2026-10-20T00:00:00Z"')
    errors, warnings = check(directory, render(uv_extra="").replace("\n[tool.ruff]", f"\n{fresh}\n[tool.ruff]", 1))
    assert errors == [] and warnings == [], (errors, warnings)

    # An empty table is harmless.
    errors, warnings = check(directory, render().replace("\n[tool.ruff]", f"\n{packages('')}\n[tool.ruff]", 1))
    assert errors == [] and warnings == [], (errors, warnings)

    rejected = {
        "false": ("false", "must not be false", "does not opt a package out"),
        "true": ("true", "must not be true", "does not opt a package out"),
        "duration": ('"3 days"', "must not be a duration ('3 days')", "one fixed release"),
        "iso duration": ('"P3D"', "must not be a duration ('P3D')", "one fixed release"),
        "local date": ('"2026-10-20"', "must not be a local date (2026-10-20)", "one fixed release"),
        "unquoted date": ("2026-10-20", "must not be a local date (2026-10-20)", "one fixed release"),
        "offset timestamp": ('"2026-10-20T00:00:00+02:00"', "must be an RFC 3339 UTC timestamp string", "found '2026-10-20T00:00:00+02:00'"),
        "local timestamp": ('"2026-10-20T00:00:00"', "must be an RFC 3339 UTC timestamp string", "found '2026-10-20T00:00:00'"),
        "impossible date": ('"2026-13-45T00:00:00Z"', "is not a valid calendar timestamp", "found '2026-13-45T00:00:00Z'"),
        "integer": ("7", "must be an RFC 3339 UTC timestamp string", "found 7"),
    }
    for name, (value, message, detail) in rejected.items():
        text = render().replace("\n[tool.ruff]", f"\n{packages(f'pillow = {value}')}\n[tool.ruff]", 1)
        errors, warnings = check(directory, text)
        error = only(errors)
        assert "uv.exclude-newer-package.pillow" in error, (name, error)
        assert message in error and detail in error, (name, error)
        assert warnings == [], (name, warnings)

    errors, _ = check(directory, render().replace('exclude-newer = "7 days"', 'exclude-newer = "7 days"\nexclude-newer-package = false', 1))
    assert "uv.exclude-newer-package must be a table" in only(errors)

    # An exception older than the window warns, naming the package, and never fails.
    boundary = (NOW - policy.EXCLUDE_NEWER_WINDOW).strftime("%Y-%m-%dT%H:%M:%SZ")
    older = (NOW - policy.EXCLUDE_NEWER_WINDOW - datetime.timedelta(seconds=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    body = packages(f'edge = "{boundary}"\nstale = "{older}"\nfuture = "2027-01-01T00:00:00Z"')
    errors, warnings = check(directory, render().replace("\n[tool.ruff]", f"\n{body}\n[tool.ruff]", 1))
    assert errors == [], errors
    warning = only(warnings)
    assert "uv.exclude-newer-package.stale" in warning and older in warning and "older than 7 days" in warning, warning

    # The command line emits a GitHub annotation relative to the repository root and still succeeds.
    stale = packages('stale = "2000-01-01T00:00:00Z"')
    (directory / "pyproject.toml").write_text(render().replace("\n[tool.ruff]", f"\n{stale}\n[tool.ruff]", 1), encoding="utf-8")
    result = subprocess.run(["python3", str(VALIDATOR), str(directory)], check=False, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    assert result.stderr == ""
    assert "::warning file=pyproject.toml::" in result.stdout
    assert "uv.exclude-newer-package.stale (2000-01-01T00:00:00Z)" in result.stdout
    assert str(directory) not in result.stdout
    assert "Validated shared Python policy in 1 pyproject.toml file(s)." in result.stdout

    (directory / "pyproject.toml").write_text(render().replace("\n[tool.ruff]", f"\n{packages('pillow = false')}\n[tool.ruff]", 1), encoding="utf-8")
    result = subprocess.run(["python3", str(VALIDATOR), str(directory)], check=False, capture_output=True, text=True)
    assert result.returncode == 1, result.stdout
    assert "ERROR" in result.stderr and "uv.exclude-newer-package.pillow must not be false" in result.stderr

assert "validate.py" in ACTION.read_text(encoding="utf-8")
print("Validated shared Python policy checker contract.")
