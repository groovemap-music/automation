#!/usr/bin/env python3
"""Behavior tests for the shared Python policy validator."""

from __future__ import annotations

import datetime
import importlib.util
import subprocess
import sys
import tempfile
import tomllib
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
requires-python = ">=3.14,<3.15"

[dependency-groups]
dev = [{dev}]

[tool.hatch.build.targets.wheel]
packages = ["src/synthetic"]

[tool.uv]
exclude-newer = "{window}"
{uv_extra}

[tool.ruff]
line-length = 150
target-version = "py314"

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


def with_packages(body: str) -> str:
    return render().replace("\n[tool.ruff]", f"\n{packages(body)}\n[tool.ruff]", 1)


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

    # The Python 3.14 contract: a 3.13 configuration fails with one clear message per setting.
    old = render().replace('">=3.14,<3.15"', '">=3.13"').replace('"py314"', '"py313"').replace('python_version = "3.14"', 'python_version = "3.13"')
    errors, _ = check(directory, old)
    assert len(errors) == 3, errors
    assert any("project.requires-python must be '>=3.14,<3.15'; found '>=3.13'" in e for e in errors), errors
    assert any("ruff.target-version must be 'py314'; found 'py313'" in e for e in errors), errors
    assert any("mypy.python_version must be '3.14'; found '3.13'" in e for e in errors), errors
    errors, _ = check(directory, render().replace('">=3.14,<3.15"', '">=3.14, <3.15"'))
    assert errors == [], errors
    errors, _ = check(directory, render().replace('">=3.14,<3.15"', '">=3.14"'))
    assert len(errors) == 1 and "requires-python" in errors[0], errors

    # The mise pin: 3.14.7 and unpinned or minor-only 3.14 pass; any other Python pin fails.
    mise = directory / ".mise.toml"
    for body, ok in (
        ('python = "3.14.7"', True),
        ('python = "3.14"', True),
        ('python = { version = "3.14.7" }', True),
        ('just = "1.57.0"', True),
        ('python = "3.14.6"', False),
        ('python = "3.13.9"', False),
        ('python = "3.13"', False),
        ('python = { version = "3.13.9" }', False),
    ):
        mise.write_text(f"[tools]\n{body}\n", encoding="utf-8")
        found = policy.mise_python_findings(mise)
        assert (found == []) == ok, (body, found)
    mise.write_text('[tools]\npython = "3.13.9"\n', encoding="utf-8")
    assert "mise tools.python must be '3.14.7' when patch-pinned; found '3.13.9'" in policy.mise_python_findings(mise)[0]
    (directory / "pyproject.toml").write_text(render(), encoding="utf-8")
    result = subprocess.run(["python3", str(VALIDATOR), str(directory)], check=False, capture_output=True, text=True)
    assert result.returncode == 1 and ".mise.toml" in result.stderr, (result.stdout, result.stderr)
    mise.write_text('[tools]\npython = "3.14.7"\n', encoding="utf-8")
    result = subprocess.run(["python3", str(VALIDATOR), str(directory)], check=False, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    mise.unlink()

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
        assert "uv.exclude-newer-package['pillow']" in error, (name, error)
        assert message in error and detail in error, (name, error)
        assert warnings == [], (name, warnings)

    errors, _ = check(directory, render().replace('exclude-newer = "7 days"', 'exclude-newer = "7 days"\nexclude-newer-package = false', 1))
    assert "uv.exclude-newer-package must be a table" in only(errors)

    # An exception older than the window warns, naming the package, and never fails.
    boundary = (NOW - policy.EXCLUDE_NEWER_WINDOW).strftime("%Y-%m-%dT%H:%M:%SZ")
    older = (NOW - policy.EXCLUDE_NEWER_WINDOW - datetime.timedelta(seconds=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    body = packages(f'edge = "{boundary}"\nstale = "{older}"')
    errors, warnings = check(directory, render().replace("\n[tool.ruff]", f"\n{body}\n[tool.ruff]", 1))
    assert errors == [], errors
    warning = only(warnings)
    assert "uv.exclude-newer-package['stale']" in warning and older in warning and "older than 7 days" in warning, warning

    # An exception must name an already-published release: a timestamp equal to now passes, any later one fails.
    stamp = "%Y-%m-%dT%H:%M:%SZ"
    present = NOW.strftime(stamp)
    errors, warnings = check(directory, with_packages(f'now = "{present}"'))
    assert errors == [] and warnings == [], (errors, warnings)
    for name, future in {
        "one second": NOW + datetime.timedelta(seconds=1),
        "months": datetime.datetime(2027, 1, 1, tzinfo=datetime.UTC),
    }.items():
        errors, warnings = check(directory, with_packages(f'soon = "{future.strftime(stamp)}"'))
        error = only(errors)
        assert "uv.exclude-newer-package['soon']" in error and future.strftime(stamp) in error, (name, error)
        assert "in the future" in error and "already been published" in error, (name, error)
        assert warnings == [], (name, warnings)

    # Only valid PEP 508 / PEP 503 names are accepted, in any case and with ._- separators.
    good = packages('Foo_Bar = "2026-10-20T00:00:00Z"\n"a.b-c" = "2026-10-20T00:00:00Z"\nx = "2026-10-20T00:00:00Z"')
    errors, warnings = check(directory, render().replace("\n[tool.ruff]", f"\n{good}\n[tool.ruff]", 1))
    assert errors == [] and warnings == [], (errors, warnings)

    hostile_names = {
        "newline": "pillow\\n::error::injected",
        "colons": "pil::low",
        "comma": "a,b",
        "space": "a b",
        "empty": "",
        "leading separator": "-pillow",
        "trailing separator": "pillow.",
        "percent": "a%0Ab",
        "carriage return": "a\\rb",
        "non-ascii": "p\\u00efllow",
    }
    for name, key in hostile_names.items():
        text = with_packages(f'"{key}" = "2026-10-20T00:00:00Z"')
        errors, warnings = check(directory, text)
        error = only(errors)
        assert "is not a valid PEP 508 package name" in error, (name, error)
        assert "\n" not in error and "\r" not in error, (name, error)
        assert warnings == [], (name, warnings)
        assert repr(tomllib.loads(text)["tool"]["uv"]["exclude-newer-package"].popitem()[0]) in error, (name, error)

    # The command line emits a GitHub annotation relative to the repository root and still succeeds.
    stale = packages('stale = "2000-01-01T00:00:00Z"')
    (directory / "pyproject.toml").write_text(render().replace("\n[tool.ruff]", f"\n{stale}\n[tool.ruff]", 1), encoding="utf-8")
    result = subprocess.run(["python3", str(VALIDATOR), str(directory)], check=False, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    assert result.stderr == ""
    assert "::warning file=pyproject.toml::" in result.stdout
    assert "uv.exclude-newer-package['stale'] (2000-01-01T00:00:00Z)" in result.stdout
    assert str(directory) not in result.stdout
    assert "Validated shared Python policy in 1 pyproject.toml file(s)." in result.stdout

    (directory / "pyproject.toml").write_text(render().replace("\n[tool.ruff]", f"\n{packages('pillow = false')}\n[tool.ruff]", 1), encoding="utf-8")
    result = subprocess.run(["python3", str(VALIDATOR), str(directory)], check=False, capture_output=True, text=True)
    assert result.returncode == 1, result.stdout
    assert "ERROR" in result.stderr and "uv.exclude-newer-package['pillow'] must not be false" in result.stderr

# Workflow commands are parsed from the start of a line, so no hostile text may add a line or reach column zero.
def unescape(value: str) -> str:
    for encoded, decoded in (("%3A", ":"), ("%2C", ","), ("%0D", "\r"), ("%0A", "\n"), ("%25", "%")):
        value = value.replace(encoded, decoded)
    return value


hostile = "x%0A\r\n::error::injected\n::set-output name=a::b%"
line = policy.annotation("warning", hostile, file=f"dir,with:delims\n::error::{hostile}.toml")
assert len(line.splitlines()) == 1 and "\r" not in line and "\n" not in line, line
assert line.startswith("::warning file="), line
head, _, data = line[len("::warning file=") :].partition("::")
assert ":" not in head and "," not in head and "\r" not in head, head
assert unescape(data) == hostile, data
assert unescape(head) == f"dir,with:delims\n::error::{hostile}.toml", head
assert policy.annotation("error", "plain") == "::error::plain"
assert policy.error_line("bad\n::error::x\r") == "ERROR bad%0A::error::x%0D"
assert policy.escape_data("100%\r\n") == "100%25%0D%0A"
assert policy.escape_property("a:b,c%d\n") == "a%3Ab%2Cc%25d%0A"

with tempfile.TemporaryDirectory() as scratch:
    directory = Path(scratch)

    def run_cli(text: str, sub: str = "") -> subprocess.CompletedProcess[str]:
        target = directory / sub
        target.mkdir(parents=True, exist_ok=True)
        (target / "pyproject.toml").write_text(text, encoding="utf-8")
        return subprocess.run(["python3", str(VALIDATOR), str(directory)], check=False, capture_output=True, text=True)

    def assert_no_injected_command(output: str, allowed: str) -> None:
        for output_line in output.splitlines():
            assert output_line.startswith(allowed) or not output_line.startswith("::"), repr(output_line)

    # A hostile package name fails validation and cannot start a new workflow-command line on stdout or stderr.
    attack = '"pillow\\n::error title=pwned::injected\\r::warning::x"'
    result = run_cli(with_packages(f'{attack} = "2026-10-20T00:00:00Z"'))
    assert result.returncode == 1, result.stdout
    assert "is not a valid PEP 508 package name" in result.stderr and "injected" in result.stderr
    assert len(result.stderr.splitlines()) == 1 and result.stderr.startswith("ERROR "), repr(result.stderr)
    assert result.stdout == "", result.stdout
    (directory / "pyproject.toml").unlink()

    # A hostile directory name reaches the warning's file property escaped, on a single line.
    nasty = "pkg,a:b\n::error::pwned"
    stale = packages('stale = "2000-01-01T00:00:00Z"')
    result = run_cli(render().replace("\n[tool.ruff]", f"\n{stale}\n[tool.ruff]", 1), nasty)
    assert result.returncode == 0, result.stderr
    assert_no_injected_command(result.stdout, "::warning file=")
    warning_lines = [output_line for output_line in result.stdout.splitlines() if output_line.startswith("::warning")]
    assert len(warning_lines) == 1, result.stdout
    assert warning_lines[0].startswith("::warning file=pkg%2Ca%3Ab%0A%3A%3Aerror%3A%3Apwned/pyproject.toml::"), warning_lines[0]

assert "validate.py" in ACTION.read_text(encoding="utf-8")
print("Validated shared Python policy checker contract.")
