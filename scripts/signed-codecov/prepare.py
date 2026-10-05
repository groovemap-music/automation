#!/usr/bin/env python3
"""Prepare an isolated, publisher-verified Codecov CLI; never upload coverage."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import urllib.request
import venv

VERSION = "11.2.2"
WHEEL = "codecov_cli-11.2.2-py3-none-any.whl"
DIGEST = "6fb5cca1cd92423c568293cc41ddf548ee6fe994f5001533567de3ff6ac46bee"
WHEEL_URL = 'https://files.pythonhosted.org/packages/92/e5/e9a5cf7d83be06bef05538cc011dd05d113f9db7039f3c777edcf074349f/codecov_cli-11.2.2-py3-none-any.whl'
PROVENANCE_URL = "https://pypi.org/integrity/codecov-cli/11.2.2/" + WHEEL + "/provenance"
IDENTITY = "https://github.com/getsentry/prevent-cli/.github/workflows/release-codecov-cli.yml@refs/tags/v11.2.2"
ISSUER = "https://token.actions.githubusercontent.com"
SOURCE = "8b09705f696b4e363c67e321f975c505b5991337"
CLAIMS = {
    "1.3.6.1.4.1.57264.1.2": "release",
    "1.3.6.1.4.1.57264.1.3": SOURCE,
    "1.3.6.1.4.1.57264.1.5": "getsentry/prevent-cli",
    "1.3.6.1.4.1.57264.1.6": "refs/tags/v11.2.2",
}


def check_digest(wheel):
    if wheel.name != WHEEL or wheel.is_symlink() or hashlib.sha256(wheel.read_bytes()).hexdigest() != DIGEST:
        raise ValueError("unexpected Codecov artifact name or digest")


def publisher_attestation(provenance):
    bundles = provenance["attestation_bundles"]
    if len(bundles) != 1 or len(bundles[0]["attestations"]) != 1:
        raise ValueError("ambiguous publisher attestation")
    publisher = bundles[0]["publisher"]
    if any(publisher.get(key) != expected for key, expected in {
        "kind": "GitHub", "repository": "getsentry/prevent-cli", "workflow": "release-codecov-cli.yml"
    }.items()):
        raise ValueError("unexpected publisher metadata")
    if "environment" not in publisher or publisher["environment"] is not None:
        raise ValueError("unexpected historical publisher environment")
    return bundles[0]["attestations"][0]


def decode_claim(data):
    # Fulcio legacy claims are raw UTF-8; newer claims are DER UTF8String.
    if data.startswith(b"\x0c"):
        if len(data) < 2 or data[1] >= 128 or len(data) != data[1] + 2:
            raise ValueError("invalid certificate UTF8String")
        data = data[2:]
    return data.decode("utf-8", errors="strict")


def check_claims(claims):
    if any(claims.get(oid) != expected for oid, expected in CLAIMS.items()):
        raise ValueError("verified certificate source/ref/event/environment mismatch")


def verify(wheel, provenance):
    check_digest(wheel)
    raw = publisher_attestation(provenance)
    from pypi_attestations import Attestation, Distribution
    from sigstore.verify.policy import Identity
    from cryptography import x509
    from cryptography.x509.oid import ObjectIdentifier

    attestation = Attestation.model_validate(raw)
    result = attestation.verify(
        identity=Identity(identity=IDENTITY, issuer=ISSUER),
        dist=Distribution.from_file(wheel), staging=False, offline=False,
    )
    if result != ("https://docs.pypi.org/attestations/publish/v1", None):
        raise ValueError("unexpected verified attestation predicate")
    # This is the SAME certificate already authenticated by Sigstore above.
    cert = x509.load_der_x509_certificate(base64.b64decode(raw["verification_material"]["certificate"], validate=True))
    claims = {oid: decode_claim(cert.extensions.get_extension_for_oid(ObjectIdentifier(oid)).value.value) for oid in CLAIMS}
    check_claims(claims)
    try:
        cert.extensions.get_extension_for_oid(ObjectIdentifier("1.3.6.1.4.1.57264.1.23"))
    except x509.ExtensionNotFound:
        pass  # This exact historical certificate has no publish-environment claim.
    else:
        raise ValueError("unexpected historical certificate environment claim")


def download(url, destination, limit):
    if not url.startswith("https://"):
        raise ValueError("HTTPS required")
    with urllib.request.urlopen(url, timeout=60) as response:
        if not response.url.startswith("https://"):
            raise ValueError("HTTPS redirect required")
        data = response.read(limit + 1)
    if len(data) > limit:
        raise ValueError("download too large")
    destination.write_bytes(data)


def pip_install(python, lock):
    subprocess.run([str(python), "-m", "pip", "--isolated", "install", "--disable-pip-version-check",
                    "--require-hashes", "--only-binary=:all:", "--index-url", "https://pypi.org/simple", "-r", str(lock)], check=True, timeout=300)


def prepare(root, assets):
    if sys.platform != "linux" or sys.version_info[:2] != (3, 12):
        raise ValueError("supported Linux Python 3.12 required")
    if root.is_symlink() or not root.is_dir() or any(root.iterdir()):
        raise ValueError("preparation directory must be owned, empty and nonsymlink")
    if root.stat().st_uid != os.getuid():
        raise ValueError("preparation directory not owned")
    try:
        wheel = root / WHEEL
        provenance = root / "provenance.json"
        download(WHEEL_URL, wheel, 1024 * 1024)
        download(PROVENANCE_URL, provenance, 1024 * 1024)
        check_digest(wheel)
        verifier = root / "verifier"
        venv.EnvBuilder(with_pip=True).create(verifier)
        verifier_python = verifier / "bin/python"
        pip_install(verifier_python, assets / "verifier.lock")
        # Nonzero/missing verifier, trust roots, transparency evidence or any
        # tampered binding abort here, BEFORE installing any uploader bytes.
        subprocess.run([str(verifier_python), str(assets / "prepare.py"), "verify", str(wheel), str(provenance)], check=True, timeout=180)
        cli = root / "cli"
        venv.EnvBuilder(with_pip=True).create(cli)
        cli_python = cli / "bin/python"
        pip_install(cli_python, assets / "cli-dependencies.lock")
        check_digest(wheel)
        subprocess.run([str(cli_python), "-m", "pip", "--isolated", "install", "--no-index", "--no-deps", str(wheel)], check=True, timeout=60)
        subprocess.run([str(cli_python), "-m", "pip", "check"], check=True, timeout=60)
        binary = cli / "bin/codecovcli"
        if binary.is_symlink() or not binary.is_file():
            raise ValueError("verified CLI entrypoint missing")
        return binary
    except BaseException:
        # Only contents of this prevalidated task-owned empty root are removed.
        for item in root.iterdir():
            if item.is_dir() and not item.is_symlink():
                shutil.rmtree(item)
            else:
                item.unlink()
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["prepare", "verify"])
    parser.add_argument("paths", nargs=2)
    args = parser.parse_args()
    if args.mode == "verify":
        verify(Path(args.paths[0]), json.loads(Path(args.paths[1]).read_text()))
    else:
        print(prepare(Path(args.paths[0]), Path(args.paths[1]).resolve()))


if __name__ == "__main__":
    main()
