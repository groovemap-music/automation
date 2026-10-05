#!/usr/bin/env python3
"""Read truthful checked-out Git and GitHub event metadata for explicit CLI options."""
import os
from pathlib import Path
import re
import subprocess


def metadata(env, cwd):
    sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=cwd, text=True).strip()
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise ValueError("invalid actual checkout SHA")
    branch = env.get("GITHUB_HEAD_REF") or env["GITHUB_REF_NAME"]
    if any(c in branch for c in "\r\n"):
        raise ValueError("invalid branch metadata")
    subprocess.run(["git", "check-ref-format", "--branch", branch], cwd=cwd, check=True, stdout=subprocess.DEVNULL)
    slug = env["GITHUB_REPOSITORY"]
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", slug):
        raise ValueError("invalid repository metadata")
    run = env["GITHUB_RUN_ID"]
    pr = env.get("CODECOV_EVENT_PR", "")
    if not run.isdecimal() or (pr and not pr.isdecimal()):
        raise ValueError("invalid run or PR metadata")
    if env["GITHUB_SERVER_URL"] != "https://github.com":
        raise ValueError("supported public GitHub server required")
    return {"sha": sha, "branch": branch, "slug": slug, "git-service": "github",
            "build": run, "build-url": f"https://github.com/{slug}/actions/runs/{run}", "pr": pr}


if __name__ == "__main__":
    values = metadata(os.environ, Path.cwd())
    with Path(os.environ["GITHUB_OUTPUT"]).open("a") as output:
        for key, value in values.items():
            output.write(f"{key}={value}\n")
