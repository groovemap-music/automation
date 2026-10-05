"""Synthetic fail-closed tests; no network, credentials or uploader execution."""
import copy
import hashlib
import importlib.util
import os
import re
import shutil
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

MODULE = Path(__file__).parent / "signed-codecov/prepare.py"
spec = importlib.util.spec_from_file_location("signed_codecov", MODULE)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class PreparationTests(unittest.TestCase):
    def test_exact_certificate_claims_and_all_wrong_bindings(self):
        m.check_claims(dict(m.CLAIMS))
        for oid in m.CLAIMS:
            for value in ("foreign", None):
                claims = dict(m.CLAIMS)
                claims[oid] = value
                with self.subTest(oid=oid, value=value), self.assertRaises(ValueError):
                    m.check_claims(claims)

    def test_publisher_and_ambiguity_fail_closed(self):
        p = {"attestation_bundles": [{"publisher": {"environment": None, "kind": "GitHub", "repository": "getsentry/prevent-cli", "workflow": "release-codecov-cli.yml"}, "attestations": [{}]}]}
        self.assertEqual(m.publisher_attestation(p), {})
        for key in p["attestation_bundles"][0]["publisher"]:
            bad = copy.deepcopy(p)
            bad["attestation_bundles"][0]["publisher"][key] = "foreign"
            with self.assertRaises(ValueError):
                m.publisher_attestation(bad)
        for count in (0, 2):
            bad = copy.deepcopy(p)
            bad["attestation_bundles"][0]["attestations"] = [{}] * count
            with self.assertRaises(ValueError):
                m.publisher_attestation(bad)

    def test_bad_certificate_encoding_fails_closed(self):
        self.assertEqual(m.decode_claim(b"\x0c\x04pypi"), "pypi")
        self.assertEqual(m.decode_claim(b"release"), "release")
        for raw in (b"\x0c", b"\x0c\x80", b"\x0c\x04bad", b"\xff"):
            with self.assertRaises((ValueError, UnicodeDecodeError)):
                m.decode_claim(raw)

    def execute_prepare(self, failure=None):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "owned"
            root.mkdir()
            assets = Path(temp) / "assets"
            assets.mkdir()
            events = []
            def download(url, path, limit):
                if failure == "provenance" and url == m.PROVENANCE_URL:
                    raise OSError("unavailable provenance")
                path.write_bytes(b"synthetic")
                events.append("download")
            def create(path):
                (path / "bin").mkdir(parents=True)
                (path / "bin/python").touch()
            def run(argv, **kwargs):
                if "verify" in argv:
                    events.append("crypto")
                    if failure in ("trust", "signature", "statement", "source", "publisher"):
                        raise subprocess.CalledProcessError(1, argv)
                elif "check" in argv:
                    events.append("package-check")
                else:
                    events.append("uploader-install")
                    (root / "cli/bin/codecovcli").touch()
                return subprocess.CompletedProcess(argv, 0)
            def install(python, lock):
                events.append("verifier-deps" if lock.name == "verifier.lock" else "cli-deps")
            with patch.object(sys, "platform", "linux"), patch.object(sys, "version_info", (3, 12, 0)), patch.object(m, "download", download), patch.object(m, "check_digest"), patch.object(m.venv.EnvBuilder, "create", lambda self, path: create(path)), patch.object(m, "pip_install", install), patch.object(m.subprocess, "run", run):
                if failure:
                    with self.assertRaises((OSError, subprocess.CalledProcessError)):
                        m.prepare(root, assets)
                    self.assertEqual(list(root.iterdir()), [])
                    self.assertNotIn("uploader-install", events)
                    self.assertNotIn("cli-deps", events)
                else:
                    binary = m.prepare(root, assets)
                    self.assertEqual(binary, root / "cli/bin/codecovcli")
                    self.assertLess(events.index("crypto"), events.index("cli-deps"))
                    self.assertLess(events.index("crypto"), events.index("uploader-install"))
                    self.assertNotIn("upload", events)
            return events

    def test_verified_before_isolated_uploader_install(self):
        self.execute_prepare()

    def test_verification_failures_never_install_or_execute_uploader(self):
        for failure in ("trust", "signature", "statement", "source", "publisher", "provenance"):
            with self.subTest(failure=failure):
                self.execute_prepare(failure)

    def test_wrong_artifact_digest_or_filename(self):
        with tempfile.TemporaryDirectory() as temp:
            wheel = Path(temp) / m.WHEEL
            wheel.write_bytes(b"synthetic")
            with self.assertRaises(ValueError):
                m.check_digest(wheel)
            with patch.object(m, "DIGEST", hashlib.sha256(b"synthetic").hexdigest()):
                m.check_digest(wheel)
                wrong = wheel.with_name("foreign.whl")
                wrong.write_bytes(b"synthetic")
                with self.assertRaises(ValueError):
                    m.check_digest(wrong)

    def test_foreign_nonempty_or_symlink_root_not_removed(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(sys, "platform", "linux"), patch.object(sys, "version_info", (3, 12, 0)):
            root = Path(temp) / "owned"
            root.mkdir()
            kept = root / "existing"
            kept.write_text("keep")
            with self.assertRaises(ValueError):
                m.prepare(root, Path(temp))
            self.assertEqual(kept.read_text(), "keep")
            link = Path(temp) / "link"
            link.symlink_to(root)
            with self.assertRaises(ValueError):
                m.prepare(link, Path(temp))
            self.assertEqual(kept.read_text(), "keep")

    def test_locked_install_retains_hashes_binary_only_and_no_global_environment(self):
        with patch.object(m.subprocess, "run") as run:
            m.pip_install(Path("/owned/verifier/bin/python"), Path("/assets/verifier.lock"))
        args = run.call_args.args[0]
        self.assertEqual(args[0], "/owned/verifier/bin/python")
        self.assertIn("--isolated", args)
        self.assertIn("--require-hashes", args)
        self.assertIn("--only-binary=:all:", args)
        self.assertIn("https://pypi.org/simple", args)

    def test_crypto_policy_precedes_claim_checks_and_rejects_missing_trust(self):
        # Synthetic adapter tests the integration boundary, not cryptography itself.
        raw = {"verification_material": {"certificate": "c3ludGhldGlj"}}
        provenance = {"attestation_bundles": [{"publisher": {"environment": None, "kind": "GitHub", "repository": "getsentry/prevent-cli", "workflow": "release-codecov-cli.yml"}, "attestations": [raw]}]}
        events = []
        class MissingExtension(Exception):
            pass
        class Extensions:
            def get_extension_for_oid(self, oid):
                if oid == "1.3.6.1.4.1.57264.1.23":
                    raise MissingExtension()
                return types.SimpleNamespace(value=types.SimpleNamespace(value=m.CLAIMS[oid].encode()))
        def crypto(**kwargs):
            events.append("crypto")
            self.assertIs(kwargs["staging"], False)
            self.assertIs(kwargs["offline"], False)
            self.assertEqual(kwargs["identity"].identity, m.IDENTITY)
            self.assertEqual(kwargs["identity"].issuer, m.ISSUER)
            return ("https://docs.pypi.org/attestations/publish/v1", None)
        attestation = types.SimpleNamespace(verify=crypto)
        api = types.SimpleNamespace(Attestation=types.SimpleNamespace(model_validate=lambda value: attestation), Distribution=types.SimpleNamespace(from_file=lambda value: value))
        x509 = types.SimpleNamespace(load_der_x509_certificate=lambda data: events.append("claims") or types.SimpleNamespace(extensions=Extensions()), ExtensionNotFound=MissingExtension)
        modules = {"pypi_attestations": api, "sigstore.verify.policy": types.SimpleNamespace(Identity=lambda **kw: types.SimpleNamespace(**kw)), "cryptography": types.SimpleNamespace(x509=x509), "cryptography.x509.oid": types.SimpleNamespace(ObjectIdentifier=lambda oid: oid)}
        with patch.dict(sys.modules, modules), patch.object(m, "check_digest"):
            m.verify(Path(m.WHEEL), provenance)
            self.assertEqual(events, ["crypto", "claims"])
            events.clear()
            attestation.verify = lambda **kw: (_ for _ in ()).throw(ValueError("trust/signature invalid"))
            with self.assertRaises(ValueError):
                m.verify(Path(m.WHEEL), provenance)
            self.assertEqual(events, [])
            attestation.verify = crypto
            x509.load_der_x509_certificate = lambda data: types.SimpleNamespace(extensions=types.SimpleNamespace(get_extension_for_oid=lambda oid: types.SimpleNamespace(value=types.SimpleNamespace(value=("unexpected" if oid.endswith(".23") else m.CLAIMS[oid]).encode()))))
            with self.assertRaisesRegex(ValueError, "environment"):
                m.verify(Path(m.WHEEL), provenance)

    def test_truthful_metadata_from_checkout_and_event(self):
        spec = importlib.util.spec_from_file_location("metadata", MODULE.with_name("metadata.py"))
        meta = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(meta)
        env = {"GITHUB_HEAD_REF": "feature/test", "GITHUB_REF_NAME": "123/merge", "GITHUB_REPOSITORY": "example/public", "GITHUB_RUN_ID": "123", "GITHUB_SERVER_URL": "https://github.com", "CODECOV_EVENT_PR": "12"}
        with patch.object(meta.subprocess, "check_output", return_value="a" * 40 + "\n"), patch.object(meta.subprocess, "run"):
            values = meta.metadata(env, Path("/checkout"))
            self.assertEqual(values["sha"], "a" * 40)
            self.assertEqual(values["branch"], "feature/test")
            self.assertEqual(values["pr"], "12")
            self.assertEqual(values["build-url"], "https://github.com/example/public/actions/runs/123")
            for key, bad in [("GITHUB_HEAD_REF", "bad\nbranch"), ("GITHUB_REPOSITORY", "bad\nslug"), ("GITHUB_RUN_ID", "invalid"), ("CODECOV_EVENT_PR", "foreign"), ("GITHUB_SERVER_URL", "http://github.com")]:
                with self.subTest(key=key), self.assertRaises(ValueError):
                    meta.metadata({**env, key: bad}, Path("/checkout"))


class WorkflowBootstrapTests(unittest.TestCase):
    def test_both_sites_bind_immutable_assets_and_mandatory_metadata(self):
        repo = Path(__file__).resolve().parent.parent
        workflow = (repo / ".github/workflows/reusable-ci.yml").read_text()
        sites = workflow.split("      - name: Prepare publisher-verified Codecov CLI\n")[1:]
        self.assertEqual(len(sites), 2)
        for site in sites:
            prep, upload = site.split("      - name: Upload ", 1)
            pairs = re.findall(r'automation/([0-9a-f]{40})/scripts/signed-codecov/([^" ]+)".*?"([0-9a-f]{64})" "\$\{root\}/assets/', prep, re.S)
            self.assertEqual(len(pairs), 4)
            self.assertEqual(len({sha for sha, _, _ in pairs}), 1)
            for sha, name, digest in pairs:
                blob = subprocess.check_output(["git", "show", f"{sha}:scripts/signed-codecov/{name}"], cwd=repo)
                self.assertEqual(hashlib.sha256(blob).hexdigest(), digest)
                self.assertEqual((repo / "scripts/signed-codecov" / name).read_bytes(), blob)
            self.assertLess(prep.index("sha256sum --check"), prep.index('prepare.py" prepare'))
            upload = upload.split("      - name: Remove isolated", 1)[0]
            for required in ("steps.signed-codecov.outcome == 'success'", "binary: ${{ steps.signed-codecov.outputs.binary }}", "disable_search: true", "fail_ci_if_error: true", "override_commit:", "override_branch:", "slug:", "git_service:", "override_build:", "override_build_url:", "override_pr:"):
                self.assertIn(required, upload)
            self.assertNotIn("skip_validation:", upload)
            self.assertNotIn("use_pypi:", upload)
        self.assertIn("needs.validate.outputs.codecov-sha", sites[1])
        self.assertIn("git", (repo / "scripts/signed-codecov/metadata.py").read_text())

    def test_tampered_bootstrap_fails_before_helper_execution(self):
        workflow = (Path(__file__).resolve().parent.parent / ".github/workflows/reusable-ci.yml").read_text()
        block = workflow.split("      - name: Prepare publisher-verified Codecov CLI\n", 1)[1].split("      - name: Upload coverage", 1)[0]
        run = block.split("        run: |\n", 1)[1]
        script = "\n".join(line[10:] for line in run.splitlines())
        subprocess.run(["bash", "-n"], input=script, text=True, check=True)
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            fakebin = base / "bin"
            fakebin.mkdir()
            fakecurl = fakebin / "curl"
            fakecurl.write_text("#!/bin/sh\nwhile [ \"$1\" != -o ]; do shift; done\nshift\nprintf tampered > \"$1\"\n")
            fakecurl.chmod(0o700)
            env = {**os.environ, "PATH": str(fakebin) + os.pathsep + os.environ["PATH"], "RUNNER_TEMP": tmp, "GITHUB_OUTPUT": str(base / "outputs")}
            result = subprocess.run(["bash", "-c", script], env=env, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            roots = list(base.glob("signed-codecov.*"))
            self.assertEqual(len(roots), 1)
            self.assertFalse((roots[0] / "preparation.log").exists())
            self.assertEqual(list((roots[0] / "environment").iterdir()), [])


if __name__ == "__main__":
    unittest.main()
