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

    def test_generic_and_placeholder_account_names_are_exempt(self):
        self.assertEqual(
            hygiene.GENERIC_ACCOUNTS, ("runner", "Shared", "user", "username", "you", "yourname", "name", "me", "example")
        )
        for account in hygiene.GENERIC_ACCOUNTS:
            for path in (
                f"/{'Us' + 'ers'}/{account}/project/x.py",
                f"/{'ho' + 'me'}/{account}/project/x.py",
                f"C:\\{'Us' + 'ers'}\\{account}\\project\\x.py",
                f"C:/{'Us' + 'ers'}/{account}/project/x.py",
                f"C:\\\\{'Us' + 'ers'}\\\\{account}\\\\x",
            ):
                for data in (f"see {path}\n".encode(), b"\x00\x01z\x41" + path.encode() + b"\x00"):
                    with self.subTest(path=path, binary=b"\0" in data):
                        self.assertEqual(hygiene.classify_content(data), [])

    def test_near_misses_of_generic_names_still_fail(self):
        for account in (
            "username2", "user1", "users", "runners", "Runner", "SHARED", "shared", "You", "names", "memo", "example.com",
            "my-user", "user.name", "username-", "e", "us",
        ):
            for prefix, label in (("/" + "Us" + "ers", "home-path-macos"), ("/" + "ho" + "me", "home-path-linux")):
                for data in (f"{prefix}/{account}/x\n".encode(), b"\x00z\x10" + f"{prefix}/{account}/x".encode()):
                    with self.subTest(account=account, prefix=prefix, binary=b"\0" in data):
                        self.assertEqual(hygiene.classify_content(data), [label])
            with self.subTest(account=account, windows=True):
                data = f"C:\\{'Us' + 'ers'}\\{account}\\x".encode()
                self.assertEqual(hygiene.classify_content(data), ["home-path-windows"])

    def test_a_generic_name_does_not_hide_a_real_path_on_the_same_line(self):
        data = f"{'/' + 'Us' + 'ers'}/user/a and {MAC_PATH}\n".encode()
        self.assertEqual(hygiene.classify_content(data), ["home-path-macos"])

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

    def test_without_a_usable_base_only_the_head_commit_and_tree_are_scanned(self):
        repo, _, leak, last = self.leak_then_delete()
        for base in ("0" * 40, "", "f" * 40):
            with self.subTest(base=base):
                result = check(repo.path, "--base", base, "--head", last)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("head commit's own changes only", result.stdout)
                self.assertIn("earlier history is not scanned", result.stdout)
                self.assertIn("1 commit(s)", result.stdout)
                self.assertNotIn(leak[:12], result.stdout + result.stderr)

    def test_the_head_commit_own_changes_still_fail_without_a_usable_base(self):
        repo, _, _, _ = self.leak_then_delete()
        leaking = repo.commit("new leak", {"notes/new.txt": f"at {LINUX_PATH}\n"})
        repo.commit("remove again", remove=("notes/new.txt",))
        for base in ("0" * 40, "f" * 40):
            with self.subTest(base=base, head="leaking commit"):
                result = check(repo.path, "--base", base, "--head", leaking)
                self.assertEqual(result.returncode, 1)
                self.assertIn(f"home-path-linux in {leaking[:12]}: notes/new.txt", result.stderr)
                self.assertNotIn("notes/trace.txt", result.stderr)
        self.assertEqual(check(repo.path, "--base", "0" * 40).returncode, 0, "the later head no longer holds the leak")

    def test_a_root_head_commit_is_scanned_in_full_without_a_base(self):
        repo = Repository(self)
        root = repo.commit("root leak", {"notes.txt": f"{WINDOWS_PATH}\n", "README.md": "synthetic\n"})
        result = check(repo.path, "--base", "0" * 40, "--head", root)
        self.assertEqual(result.returncode, 1)
        self.assertIn(f"home-path-windows in {root[:12]}: notes.txt", result.stderr)

    def test_a_merge_head_is_compared_with_its_first_parent(self):
        repo = Repository(self)
        repo.commit("base", {"README.md": "synthetic\n"})
        git(repo.path, "checkout", "--quiet", "-b", "topic")
        repo.commit("topic", {"topic.txt": "synthetic\n"})
        git(repo.path, "checkout", "--quiet", "main")
        repo.commit("main", {"main.txt": "synthetic\n"})
        git(repo.path, "merge", "--quiet", "--no-ff", "-m", "merge", "topic")
        result = check(repo.path, "--base", "0" * 40)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("1 commit(s)", result.stdout)

    def test_a_shallow_clone_can_scan_the_head_commit_but_not_a_range_or_history(self):
        repo, _, _, last = self.leak_then_delete()
        with tempfile.TemporaryDirectory() as scratch:
            clone = Path(scratch) / "clone"
            git(scratch, "clone", "--quiet", "--depth", "1", f"file://{repo.path}", str(clone))
            self.assertEqual(check(clone, "--base", "0" * 40, "--head", last).returncode, 0)
            self.assertEqual(check(clone, "--base", last).returncode, 2)

    def test_a_clean_new_branch_reports_its_narrowed_scope(self):
        repo = Repository(self)
        head = repo.commit("clean", {"README.md": "synthetic\n"})
        result = check(repo.path, "--base", "0" * 40, "--head", head)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("no base revision", result.stdout)
        result = check(repo.path, "--base", "f" * 40, "--head", head)
        self.assertIn("base revision is not available locally", result.stdout)

    def test_history_is_explicit_only(self):
        repo, _, leak, _ = self.leak_then_delete()
        self.assertEqual(check(repo.path).returncode, 0)
        self.assertIn("tracked tree at HEAD only", check(repo.path).stdout)
        result = check(repo.path, "--history")
        self.assertEqual(result.returncode, 1)
        self.assertIn(f"in {leak[:12]}: notes/trace.txt", result.stderr)

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
        start = lines.index("          python3 - ${hygiene_range[@]+\"${hygiene_range[@]}\"} <<'PY'") + 1
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

    def run_step(self, repo, **environment):
        lines = WORKFLOW.read_text(encoding="utf-8").split("\n")
        step = lines.index(f"      - name: {self.STEP}")
        start = lines.index("        run: |", step) + 1
        end = lines.index("          PY", start) + 1
        script = "\n".join(line[10:] if line.strip() else "" for line in lines[start:end]) + "\n"
        env = {**GIT_ENV, **{f"HYGIENE_{key}": value for key, value in environment.items()}}
        return subprocess.run(["bash", "-c", script], cwd=repo.path, capture_output=True, text=True, env=env, check=False)

    def test_the_step_scopes_each_event(self):
        repo = Repository(self)
        first = repo.commit("clean", {"README.md": "synthetic\n"})
        repo.commit("leak", {"notes.txt": f"{MAC_PATH}\n"})
        head = repo.commit("remove", remove=("notes.txt",))
        for event in ("schedule", "workflow_dispatch", "release"):
            with self.subTest(event=event):
                result = self.run_step(repo, EVENT=event)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("tracked tree at HEAD only", result.stdout)
        result = self.run_step(repo, EVENT="push", PUSH_BEFORE="0" * 40, PUSH_AFTER=head)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("head commit's own changes only", result.stdout)
        result = self.run_step(repo, EVENT="push", PUSH_BEFORE=first, PUSH_AFTER=head)
        self.assertEqual(result.returncode, 1)
        self.assertIn("home-path-macos in", result.stderr)
        result = self.run_step(repo, EVENT="pull_request", PR_BASE=first, PR_HEAD=head)
        self.assertEqual(result.returncode, 1)
        (repo.path / "tree.txt").write_text(f"{LINUX_PATH}\n", encoding="utf-8")
        git(repo.path, "add", "tree.txt")
        result = self.run_step(repo, EVENT="schedule")
        self.assertEqual(result.returncode, 1, "a leak in the tracked tree still fails a scheduled run")
        self.assertIn("home-path-linux in worktree: tree.txt", result.stderr)

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
            "hygiene_range=()",
        ):
            self.assertIn(expected, block)
        self.assertNotIn("if:", block, "every caller runs the check")


class CommandLineTests(unittest.TestCase):
    def test_the_repository_itself_is_clean(self):
        result = check(ROOT)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
