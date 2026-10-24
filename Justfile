set shell := ["bash", "-euo", "pipefail", "-c"]

default:
    @just --list

setup:
    mise install

check: test
    node --check scripts/validate.mjs
    node --check scripts/validate.test.mjs
    node --check scripts/workflow-contract.mjs
    PYTHONPYCACHEPREFIX=.build/pycache python3 -m py_compile .github/actions/validate-database-fixtures/validate.py
    PYTHONPYCACHEPREFIX=.build/pycache python3 -m py_compile .github/actions/validate-python-policy/validate.py
    PYTHONPYCACHEPREFIX=.build/pycache python3 -m py_compile scripts/publication-hygiene.py
    node scripts/validate.mjs

test:
    node --test scripts/validate.test.mjs
    python3 scripts/validate-database-fixtures.test.py
    PYTHONPYCACHEPREFIX=.build/pycache python3 scripts/validate-python-policy.test.py
    PYTHONPYCACHEPREFIX=.build/pycache python3 scripts/signed-codecov.test.py
    PYTHONPYCACHEPREFIX=.build/pycache python3 scripts/publication-hygiene.test.py

# Reject tracked bytecode and absolute user-home paths in the worktree and in every commit.
hygiene *args:
    python3 -B scripts/publication-hygiene.py {{args}}
