set shell := ["bash", "-euo", "pipefail", "-c"]

default:
    @just --list

setup:
    mise install

check: test
    node --check scripts/validate.mjs
    node --check scripts/validate.test.mjs
    node --check scripts/workflow-contract.mjs
    PYTHONPYCACHEPREFIX=.build/pycache python3 -m py_compile .github/actions/validate-python-policy/validate.py
    node scripts/validate.mjs

test:
    node --test scripts/validate.test.mjs
