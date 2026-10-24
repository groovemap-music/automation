"""Behavior tests for the publication-hygiene check; every fixture path and name is synthetic."""
import importlib.util
import os
import py_compile
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts/publication-hygiene.py"
WORKFLOW = ROOT / ".github/workflows/reusable-ci.yml"
sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location("publication_hygiene", SCRIPT)
hygiene = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hygiene)

# Fixtures assemble the forbidden prefixes at run time so this file never contains one.
NAME = "synthetic" + "-person"
MAC_PATH = "/".join(["", "Us" + "ers", NAME, "project", "module.py"])
LINUX_PATH = "/".join(["", "ho" + "me", NAME, "project", "module.py"])
WINDOWS_PATH = "\\".join(["C:", "Us" + "ers", NAME, "project", "module.py"])
GIT_ENV = {
    **os.environ,
    "GIT_AUTHOR_NAME": "Synthetic",
    "GIT_AUTHOR_EMAIL": "synthetic@example.invalid",
    "GIT_COMMITTER_NAME": "Synthetic",
    "GIT_COMMITTER_EMAIL": "synthetic@example.invalid",
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_CONFIG_SYSTEM": os.devnull,
}


def git(repo, *args):
    result = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, env=GIT_ENV, check=False)
    assert result.returncode == 0, result.stderr
    return result.stdout.strip()


def check(repo, *args):
    result = subprocess.run(
        [sys.executable, "-B", str(SCRIPT), "--repo", str(repo), *args], capture_output=True, text=True, env=GIT_ENV, check=False
    )
    return result


class Repository:
    """A throwaway repository whose commits are made from synthetic content."""

    def __init__(self, test):
        self.directory = tempfile.TemporaryDirectory()
        test.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "repo"
        self.path.mkdir()
        git(self.path, "init", "--quiet", "--initial-branch=main")
        git(self.path, "config", "commit.gpgsign", "false")

    def commit(self, message, files=None, remove=()):
        for name, content in (files or {}).items():
            target = self.path / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content if isinstance(content, bytes) else content.encode())
        for name in remove:
            git(self.path, "rm", "--quiet", name)
        git(self.path, "add", "--all")
        git(self.path, "commit", "--quiet", "--allow-empty", "-m", message)
        return git(self.path, "rev-parse", "HEAD")


def build_bytecode(directory, recorded_path):
    """Compile a synthetic module so the resulting bytecode embeds `recorded_path` as its source path."""
    source = Path(directory) / "synthetic_module.py"
    source.write_text("VALUE = 1\n", encoding="utf-8")
    target = Path(directory) / "synthetic_module.cpython.pyc"
    py_compile.compile(str(source), cfile=str(target), dfile=recorded_path, doraise=True)
    return target.read_bytes()


class ClassificationTests(unittest.TestCase):
    def test_each_home_path_class_in_text(self):
        for label, path in (("home-path-macos", MAC_PATH), ("home-path-linux", LINUX_PATH), ("home-path-windows", WINDOWS_PATH)):
            with self.subTest(label=label):
                self.assertEqual(hygiene.classify_content(f"see {path} for details\n".encode()), [label])
        self.assertIn("home-path-windows", hygiene.classify_content(("path = " + WINDOWS_PATH.replace("\\", "/")).encode()))
        self.assertEqual(hygiene.classify_content(("file://" + MAC_PATH).encode()), ["home-path-macos"])
        self.assertEqual(hygiene.classify_content(f'"{WINDOWS_PATH.replace(chr(92), chr(92) * 2)}"'.encode()), ["home-path-windows"])

    def test_binary_content_matches_without_a_leading_delimiter(self):
        self.assertEqual(hygiene.classify_content(b"\x00\x01z\x41" + MAC_PATH.encode() + b"\x00"), ["home-path-macos"])

    def test_relative_paths_placeholders_and_dots_are_not_home_paths(self):
        for sample in (
            "docs/" + "ho" + "me/guide/index.md",
            "/".join(["", "ho" + "me", "<name>", "x"]),
            "/".join(["", "Us" + "ers", "$USER", "x"]),
            "/".join(["", "ho" + "me", "{user}", "x"]),
            "/".join(["", "ho" + "me", "..", "x"]),
            "/".join(["", "ho" + "me"]) + "/",
            "/".join(["", "ho" + "me", NAME]),
            "plain prose with no paths",
        ):
            with self.subTest(sample=sample):
                self.assertEqual(hygiene.classify_content(sample.encode()), [])

    def test_bytecode_paths(self):
        for path in ("a.pyc", "pkg/a.cpython-313.PYC", "pkg/a.pyo", "pkg/__pycache__/a.txt", "__pycache__/x"):
            with self.subTest(path=path):
                self.assertTrue(hygiene.bytecode_path(path))
        for path in ("a.py", "pkg/pycache/a.txt", "a.pyc.md", "docs/bytecode.md"):
            with self.subTest(path=path):
                self.assertFalse(hygiene.bytecode_path(path))

    def test_output_helpers_escape_hostile_paths(self):
        self.assertEqual(hygiene.printable("a\nb\x1b[0m\udcff"), "a\\x0ab\\x1b[0m\\udcff")
        self.assertEqual(hygiene.error_line("100%\n::error::x"), "ERROR 100%25%0A::error::x")


class WorktreeTests(unittest.TestCase):
    def test_clean_repository_passes(self):
        repo = Repository(self)
        repo.commit("clean", {"README.md": "synthetic\n", "src/a.py": "VALUE = 1\n"})
        result = check(repo.path, "--history")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Publication hygiene clean", result.stdout)
        self.assertEqual(result.stderr, "")

    def test_tracked_bytecode_fails_and_reports_without_content(self):
        repo = Repository(self)
        with tempfile.TemporaryDirectory() as scratch:
            bytecode = build_bytecode(scratch, MAC_PATH)
        sha = repo.commit("add bytecode", {"pkg/__pycache__/module.cpython-313.pyc": bytecode})
        result = check(repo.path)
        self.assertEqual(result.returncode, 1)
        self.assertIn("bytecode in worktree: pkg/__pycache__/module.cpython-313.pyc", result.stderr)
        self.assertIn("home-path-macos in worktree: pkg/__pycache__/module.cpython-313.pyc", result.stderr)
        self.assertNotIn(NAME, result.stdout + result.stderr)
        self.assertNotIn(sha[:12], result.stderr)

    def test_real_bytecode_under_an_innocent_name_is_still_found_by_content(self):
        repo = Repository(self)
        with tempfile.TemporaryDirectory() as scratch:
            bytecode = build_bytecode(scratch, MAC_PATH)
        self.assertIn(MAC_PATH.encode(), bytecode)
        repo.commit("disguised", {"assets/blob.bin": bytecode})
        result = check(repo.path)
        self.assertEqual(result.returncode, 1)
        self.assertIn("home-path-macos in worktree: assets/blob.bin", result.stderr)
        self.assertNotIn("ERROR bytecode", result.stderr)

    def test_each_text_class_in_the_worktree(self):
        for label, path in (("home-path-macos", MAC_PATH), ("home-path-linux", LINUX_PATH), ("home-path-windows", WINDOWS_PATH)):
            with self.subTest(label=label):
                repo = Repository(self)
                repo.commit("leak", {"notes.txt": f"built in {path}\n"})
                result = check(repo.path)
                self.assertEqual(result.returncode, 1)
                self.assertIn(f"{label} in worktree: notes.txt", result.stderr)
                self.assertNotIn(NAME, result.stdout + result.stderr)

    def test_symlink_target_is_scanned(self):
        repo = Repository(self)
        link = repo.path / "link"
        link.symlink_to(LINUX_PATH)
        git(repo.path, "add", "link")
        git(repo.path, "commit", "--quiet", "-m", "link")
        result = check(repo.path, "--history")
        self.assertEqual(result.returncode, 1)
        self.assertIn("home-path-linux in worktree: link", result.stderr)

    def test_hostile_path_names_cannot_start_a_workflow_command(self):
        repo = Repository(self)
        hostile = "pkg/__pycache__/x\n::error::forged.pyc"
        repo.commit("hostile", {hostile: "x"})
        result = check(repo.path)
        self.assertEqual(result.returncode, 1)
        for line in result.stderr.splitlines():
            self.assertTrue(line.startswith("ERROR ") or line.startswith("Matched text"), line)
        self.assertIn("x\\x0a::error::forged.pyc", result.stderr)


class HistoryTests(unittest.TestCase):
    def leak_then_delete(self):
        repo = Repository(self)
        first = repo.commit("clean", {"README.md": "synthetic\n"})
        leak = repo.commit("leak", {"notes/trace.txt": f"at {MAC_PATH}\n", "build/mod.pyc": b"\x00synthetic"})
        repo.commit("remove", remove=("notes/trace.txt", "build/mod.pyc"))
        last = repo.commit("later", {"docs/guide.md": "synthetic\n"})
        return repo, first, leak, last

    def test_a_file_added_then_deleted_in_the_range_still_fails(self):
        repo, first, leak, last = self.leak_then_delete()
        self.assertEqual(check(repo.path).returncode, 0, "the worktree itself is clean")
        result = check(repo.path, "--base", first, "--head", last)
        self.assertEqual(result.returncode, 1)
        self.assertIn(f"home-path-macos in {leak[:12]}: notes/trace.txt", result.stderr)
        self.assertIn(f"bytecode in {leak[:12]}: build/mod.pyc", result.stderr)
        self.assertNotIn(NAME, result.stdout + result.stderr)

    def test_history_mode_scans_every_commit(self):
        repo, _, leak, _ = self.leak_then_delete()
        result = check(repo.path, "--history")
        self.assertEqual(result.returncode, 1)
        self.assertIn(f"in {leak[:12]}: notes/trace.txt", result.stderr)
        self.assertIn("2 finding(s) (bytecode: 1, home-path-macos: 1)", result.stderr)

    def test_a_range_after_the_leak_does_not_report_it(self):
        repo, _, leak, last = self.leak_then_delete()
        result = check(repo.path, "--base", leak, "--head", last)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("2 commit(s)", result.stdout)

    def test_pull_request_style_range_checks_only_the_branch(self):
        repo = Repository(self)
        repo.commit("base", {"README.md": "synthetic\n"})
        base = repo.commit("base two", {"docs/a.md": "synthetic\n"})
        git(repo.path, "checkout", "--quiet", "-b", "topic")
        repo.commit("topic leak", {"notes.txt": f"{LINUX_PATH}\n"})
        head = repo.commit("topic remove", remove=("notes.txt",))
        self.assertEqual(check(repo.path, "--base", base, "--head", head).returncode, 1)
        self.assertEqual(check(repo.path, "--base", head, "--head", head).returncode, 0)

    def test_new_branch_and_first_push_scan_everything(self):
        repo, _, leak, last = self.leak_then_delete()
        for base in ("0" * 40, "", "f" * 40):
            with self.subTest(base=base):
                result = check(repo.path, "--base", base, "--head", last)
                self.assertEqual(result.returncode, 1)
                self.assertIn(f"in {leak[:12]}: notes/trace.txt", result.stderr)

    def test_clean_new_branch_reports_its_scope(self):
        repo = Repository(self)
        head = repo.commit("clean", {"README.md": "synthetic\n"})
        result = check(repo.path, "--base", "0" * 40, "--head", head)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("no base revision", result.stdout)

    def test_a_blob_shared_by_two_commits_is_reported_for_each(self):
        repo = Repository(self)
        repo.commit("clean", {"README.md": "synthetic\n"})
        one = repo.commit("one", {"a.txt": f"{MAC_PATH}\n"})
        two = repo.commit("two", {"b.txt": f"{MAC_PATH}\n"})
        result = check(repo.path, "--history")
        self.assertIn(f"in {one[:12]}: a.txt", result.stderr)
        self.assertIn(f"in {two[:12]}: b.txt", result.stderr)

    def test_root_commit_is_scanned(self):
        repo = Repository(self)
        root = repo.commit("root leak", {"notes.txt": f"{WINDOWS_PATH}\n"})
        repo.commit("remove", remove=("notes.txt",))
        result = check(repo.path, "--history")
        self.assertEqual(result.returncode, 1)
        self.assertIn(f"home-path-windows in {root[:12]}: notes.txt", result.stderr)

    def test_shallow_clone_fails_closed(self):
        repo, _, _, _ = self.leak_then_delete()
        with tempfile.TemporaryDirectory() as scratch:
            clone = Path(scratch) / "clone"
            git(scratch, "clone", "--quiet", "--depth", "1", f"file://{repo.path}", str(clone))
            result = check(clone, "--history")
            self.assertEqual(result.returncode, 2)
            self.assertIn("shallow clone", result.stderr)
            self.assertEqual(check(clone).returncode, 0, "a worktree-only scan needs no history")

    def test_options_conflict_and_missing_head_are_usage_errors(self):
        repo = Repository(self)
        repo.commit("clean", {"README.md": "synthetic\n"})
        self.assertEqual(check(repo.path, "--history", "--base", "x").returncode, 2)
        result = check(repo.path, "--base", "", "--head", "does-not-exist")
        self.assertEqual(result.returncode, 2)
        self.assertIn("head revision is not a commit", result.stderr)


class AllowlistTests(unittest.TestCase):
    def test_default_allowlist_is_empty_and_optional(self):
        self.assertEqual(hygiene.load_allowlist("/nonexistent/allowlist", required=False), set())
        shipped = (ROOT / hygiene.ALLOWLIST_NAME).read_text(encoding="utf-8")
        self.assertEqual(hygiene.load_allowlist(str(ROOT / hygiene.ALLOWLIST_NAME), required=True), set(), shipped)

    def test_an_exact_path_is_exempt_in_the_worktree_and_in_history(self):
        repo = Repository(self)
        repo.commit("leaks", {"docs/example.md": f"{MAC_PATH}\n", "notes.txt": f"{MAC_PATH}\n"})
        self.assertEqual(check(repo.path).returncode, 1)
        (repo.path / hygiene.ALLOWLIST_NAME).write_text("# reviewed: documented example\ndocs/example.md\n", encoding="utf-8")
        result = check(repo.path, "--history")
        self.assertEqual(result.returncode, 1)
        self.assertIn("in worktree: notes.txt", result.stderr)
        self.assertNotIn("docs/example.md", result.stderr)
        (repo.path / hygiene.ALLOWLIST_NAME).write_text("docs/example.md\nnotes.txt\n", encoding="utf-8")
        result = check(repo.path, "--history")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("allowlist entries: 2", result.stdout)

    def test_the_allowlist_does_not_exempt_a_different_path(self):
        repo = Repository(self)
        repo.commit("leak", {"a/notes.txt": f"{MAC_PATH}\n"})
        (repo.path / hygiene.ALLOWLIST_NAME).write_text("notes.txt\n", encoding="utf-8")
        self.assertEqual(check(repo.path).returncode, 1)

    def test_broad_or_unsafe_entries_are_rejected(self):
        repo = Repository(self)
        repo.commit("clean", {"README.md": "synthetic\n"})
        for entry in ("docs/*", "../outside", "/absolute/path", "dir/[ab]"):
            with self.subTest(entry=entry):
                (repo.path / hygiene.ALLOWLIST_NAME).write_text(entry + "\n", encoding="utf-8")
                result = check(repo.path)
                self.assertEqual(result.returncode, 2)
                self.assertIn("exact repository-relative path", result.stderr)

    def test_an_explicit_allowlist_must_exist(self):
        repo = Repository(self)
        repo.commit("clean", {"README.md": "synthetic\n"})
        result = check(repo.path, "--allowlist", str(repo.path / "missing"))
        self.assertEqual(result.returncode, 2)
        self.assertIn("allowlist file not found", result.stderr)


class WorkflowEmbeddingTests(unittest.TestCase):
    STEP = "Reject committed bytecode and local home paths"

    def embedded_script(self):
        lines = WORKFLOW.read_text(encoding="utf-8").split("\n")
        start = lines.index("          python3 - \"${hygiene_range[@]}\" <<'PY'") + 1
        end = lines.index("          PY", start)
        return "\n".join(line[10:] if line.strip() else "" for line in lines[start:end]) + "\n"

    def test_the_workflow_embeds_the_script_verbatim(self):
        self.assertEqual(
            self.embedded_script(),
            SCRIPT.read_text(encoding="utf-8"),
            "re-embed scripts/publication-hygiene.py in reusable-ci.yml, indented by ten spaces",
        )

    def test_the_embedded_script_runs_from_standard_input(self):
        repo = Repository(self)
        repo.commit("leak", {"notes.txt": f"{MAC_PATH}\n"})
        result = subprocess.run(
            [sys.executable, "-B", "-", "--repo", str(repo.path), "--history"],
            input=self.embedded_script(),
            capture_output=True,
            text=True,
            env=GIT_ENV,
            check=False,
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("home-path-macos in worktree: notes.txt", result.stderr)

    def test_the_step_is_in_required_validation_after_the_secret_scan(self):
        workflow = WORKFLOW.read_text(encoding="utf-8")
        scan = workflow.index("      - name: Scan repository and history for secrets")
        step = workflow.index(f"      - name: {self.STEP}")
        following = workflow.index("      - name: Build package or application artifact")
        self.assertLess(scan, step)
        self.assertLess(step, following)
        block = workflow[step:following]
        for expected in (
            "github.event_name",
            "github.event.before",
            "github.event.after",
            "github.event.pull_request.base.sha",
            "github.event.pull_request.head.sha",
            "github.event.merge_group.base_sha",
            "hygiene_range=(--history)",
        ):
            self.assertIn(expected, block)
        self.assertNotIn("if:", block, "every caller runs the check")


class CommandLineTests(unittest.TestCase):
    def test_the_repository_itself_is_clean(self):
        result = check(ROOT)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
