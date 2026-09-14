#!/usr/bin/env python3
"""Behavior tests for the reusable database-fixture validator."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
VALIDATOR = ROOT / ".github/actions/validate-database-fixtures/validate.py"
FIXTURES = ROOT / "fixtures/database-fixtures"
ACTION = ROOT / ".github/actions/validate-database-fixtures/action.yml"


def run(name: str, paths: str | None = None) -> subprocess.CompletedProcess[str]:
    environment = os.environ.copy()
    if paths is not None:
        environment["GROOVEMAP_DATABASE_FIXTURE_PATHS"] = paths
    return subprocess.run(
        ["python3", str(VALIDATOR), str(FIXTURES / name)],
        check=False,
        capture_output=True,
        env=environment,
        text=True,
    )


action = ACTION.read_text(encoding="utf-8")
assert "paths:" in action
assert "GROOVEMAP_DATABASE_FIXTURE_PATHS: ${{ inputs.paths }}" in action
assert '"${GITHUB_WORKSPACE}"' in action

valid = run("valid", "tests/conftest.py")
assert valid.returncode == 0, valid.stderr
assert valid.stderr == ""
assert "Validated database fixture mocks in 1 Python file(s)." in valid.stdout

invalid = run("invalid")
assert invalid.returncode == 1, invalid.stdout
assert invalid.stdout == ""
assert "tests/conftest.py:8:12: unspecced MagicMock" in invalid.stderr
assert "database-boundary fixture 'mock_neo4j_driver'" in invalid.stderr
assert "tests/conftest.py:14:12: unspecced AsyncMock" in invalid.stderr
assert "database-boundary fixture 'postgresql_connection'" in invalid.stderr
assert "fixtures/database-fixtures" not in invalid.stderr

print("Validated database-fixture checker contract fixtures.")
