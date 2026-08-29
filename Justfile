set shell := ["bash", "-euo", "pipefail", "-c"]

default:
    @just --list

setup:
    mise install

check: syntax-check test policy-check

syntax-check:
    node --check scripts/validate.mjs
    node --check scripts/validate.test.mjs

test:
    node --test scripts/validate.test.mjs

policy-check:
    node scripts/validate.mjs
