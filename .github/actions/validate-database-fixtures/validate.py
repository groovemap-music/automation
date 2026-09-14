#!/usr/bin/env python3
"""Reject unspecced mocks inside Neo4j and PostgreSQL pytest fixtures."""

from __future__ import annotations

import ast
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


MOCK_CONSTRUCTORS = {
    "AsyncMock",
    "MagicMock",
    "Mock",
    "NonCallableMagicMock",
    "NonCallableMock",
}
AUTOSPEC_CONSTRUCTORS = {"create_autospec"}
DATABASE_MARKERS = re.compile(r"neo4j|psycopg|postgresql|postgres|cypher", re.IGNORECASE)
EXEMPTION = re.compile(r"#\s*groovemap-db-fixture:\s*allow-unspecced\(([^)\r\n]+)\)")
SKIPPED_DIRECTORIES = {
    ".git",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".venv",
    "node_modules",
    "target",
}


@dataclass(frozen=True)
class Finding:
    path: Path
    line: int
    column: int
    fixture: str
    constructor: str

    def render(self, root: Path) -> str:
        relative = self.path.relative_to(root).as_posix()
        return (
            f"{relative}:{self.line}:{self.column}: unspecced {self.constructor} in "
            f"database-boundary fixture {self.fixture!r}; use create_autospec(Interface, "
            "instance=True, spec_set=True), Mock(spec=Interface), or a line-scoped "
            "# groovemap-db-fixture: allow-unspecced(reason) exemption"
        )


def dotted_name(node: ast.expr) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        owner = dotted_name(node.value)
        return f"{owner}.{node.attr}" if owner else node.attr
    return None


def is_fixture(function: ast.FunctionDef | ast.AsyncFunctionDef) -> bool:
    for decorator in function.decorator_list:
        target = decorator.func if isinstance(decorator, ast.Call) else decorator
        name = dotted_name(target)
        if name and name.split(".")[-1] == "fixture":
            return True
    return False


def fixture_source(lines: list[str], function: ast.FunctionDef | ast.AsyncFunctionDef) -> str:
    end = function.end_lineno or function.lineno
    return "\n".join(lines[function.lineno - 1 : end])


def imported_mock_names(tree: ast.Module) -> tuple[dict[str, str], set[str]]:
    constructors: dict[str, str] = {}
    modules: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module == "unittest.mock":
            for alias in node.names:
                if alias.name in MOCK_CONSTRUCTORS | AUTOSPEC_CONSTRUCTORS:
                    constructors[alias.asname or alias.name] = alias.name
        elif isinstance(node, ast.ImportFrom) and node.module == "unittest":
            for alias in node.names:
                if alias.name == "mock":
                    modules.add(alias.asname or alias.name)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name == "unittest.mock":
                    modules.add(alias.asname or alias.name)
    return constructors, modules


def mock_constructor(
    call: ast.Call,
    imported_names: dict[str, str],
    imported_modules: set[str],
) -> str | None:
    name = dotted_name(call.func)
    if not name:
        return None
    leaf = name.split(".")[-1]
    if isinstance(call.func, ast.Name) and call.func.id in imported_names:
        return imported_names[call.func.id]
    if isinstance(call.func, ast.Attribute):
        owner = dotted_name(call.func.value)
        if owner in imported_modules and leaf in MOCK_CONSTRUCTORS | AUTOSPEC_CONSTRUCTORS:
            return leaf
    return None


def has_interface_spec(call: ast.Call, constructor: str) -> bool:
    def names_interface(node: ast.expr) -> bool:
        return not isinstance(node, ast.Constant) or node.value not in {None, True, False}

    if constructor in AUTOSPEC_CONSTRUCTORS:
        return (bool(call.args) and names_interface(call.args[0])) or any(
            keyword.arg == "spec" and names_interface(keyword.value) for keyword in call.keywords
        )
    if call.args and names_interface(call.args[0]):
        return True
    for keyword in call.keywords:
        if keyword.arg not in {"spec", "spec_set"}:
            continue
        if names_interface(keyword.value):
            return True
    return False


def is_exempt(call: ast.Call, lines: list[str]) -> bool:
    end = call.end_lineno or call.lineno
    source = "\n".join(lines[call.lineno - 1 : end])
    match = EXEMPTION.search(source)
    return bool(match and match.group(1).strip())


def validate_file(path: Path) -> list[Finding]:
    source = path.read_text(encoding="utf-8")
    lines = source.splitlines()
    tree = ast.parse(source, filename=str(path))
    imported_names, imported_modules = imported_mock_names(tree)
    findings: list[Finding] = []

    for function in ast.walk(tree):
        if not isinstance(function, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        if not is_fixture(function) or not DATABASE_MARKERS.search(fixture_source(lines, function)):
            continue
        for call in ast.walk(function):
            if not isinstance(call, ast.Call):
                continue
            constructor = mock_constructor(call, imported_names, imported_modules)
            if constructor not in MOCK_CONSTRUCTORS:
                continue
            if has_interface_spec(call, constructor) or is_exempt(call, lines):
                continue
            findings.append(
                Finding(
                    path=path,
                    line=call.lineno,
                    column=call.col_offset + 1,
                    fixture=function.name,
                    constructor=constructor,
                )
            )
    return findings


def discover(root: Path, targets: Iterable[str]) -> tuple[list[Path], list[str]]:
    files: set[Path] = set()
    errors: list[str] = []
    for raw_target in targets:
        target = Path(raw_target)
        if target.is_absolute() or ".." in target.parts:
            errors.append(f"target must be repository-relative without '..': {raw_target}")
            continue
        resolved = root / target
        if not resolved.exists():
            errors.append(f"target does not exist: {raw_target}")
            continue
        candidates = [resolved] if resolved.is_file() else resolved.rglob("*.py")
        for candidate in candidates:
            relative_parts = candidate.relative_to(root).parts
            if candidate.suffix == ".py" and not any(part in SKIPPED_DIRECTORIES for part in relative_parts):
                files.add(candidate)
    return sorted(files), errors


def configured_targets(arguments: list[str]) -> list[str]:
    if arguments:
        return arguments
    configured = os.environ.get("GROOVEMAP_DATABASE_FIXTURE_PATHS", "tests")
    return [line.strip() for line in configured.splitlines() if line.strip()]


def main(arguments: list[str] | None = None) -> int:
    arguments = list(sys.argv[1:] if arguments is None else arguments)
    root = Path(arguments.pop(0) if arguments else ".").resolve()
    if not root.is_dir():
        print(f"ERROR repository root is not a directory: {root}", file=sys.stderr)
        return 2

    targets = configured_targets(arguments)
    if not targets:
        print("ERROR at least one repository-relative scan path is required", file=sys.stderr)
        return 2
    paths, errors = discover(root, targets)
    findings: list[Finding] = []
    for path in paths:
        try:
            findings.extend(validate_file(path))
        except (OSError, UnicodeError, SyntaxError) as error:
            errors.append(f"{path.relative_to(root).as_posix()}: cannot inspect Python source: {error}")

    for error in errors:
        print(f"ERROR {error}", file=sys.stderr)
    for finding in sorted(findings, key=lambda item: (item.path, item.line, item.column)):
        print(f"ERROR {finding.render(root)}", file=sys.stderr)
    if errors or findings:
        return 1

    print(f"Validated database fixture mocks in {len(paths)} Python file(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
