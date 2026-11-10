"""Release enano: version bump -> tests -> build -> PyPI -> tag -> Homebrew tap.

Usage:
  python3 scripts/release.py                minor bump (0.2.0 -> 0.3.0), full run
  python3 scripts/release.py 1.0.0          explicit version
  python3 scripts/release.py --dry-run      build + checks only; no commit/upload/tag
  python3 scripts/release.py --push         also push branch + release tag after tagging
  python3 scripts/release.py --skip-tap     skip the homebrew-tap update

PyPI upload uses twine credentials from ~/.pypirc or TWINE_* env vars. The
Homebrew tap (enano-ai/homebrew-tap, Formula/enano.rb) is updated in place
through the gh CLI; --skip-tap or a missing gh leaves it untouched and the
formula is printed instead.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PYPROJECT = ROOT / "pyproject.toml"
TAP_REPO = "enano-ai/homebrew-tap"
TAP_FORMULA = "Formula/enano.rb"


def run(cmd: list[str], **kwargs) -> subprocess.CompletedProcess:
    print(f"$ {' '.join(str(c) for c in cmd)}", flush=True)
    return subprocess.run([str(c) for c in cmd], check=True, **kwargs)


def current_version() -> str:
    match = re.search(r'^version = "([^"]+)"', PYPROJECT.read_text(encoding="utf-8"), re.MULTILINE)
    if not match:
        raise SystemExit(f"no version string found in {PYPROJECT}")
    return match.group(1)


def set_version(version: str) -> None:
    text = PYPROJECT.read_text(encoding="utf-8")
    text = re.sub(r'^version = "[^"]+"', f'version = "{version}"', text, count=1, flags=re.MULTILINE)
    PYPROJECT.write_text(text, encoding="utf-8")


def bump_minor(version: str) -> str:
    major, minor, _patch = (int(n) for n in version.split("."))
    return f"{major}.{minor + 1}.0"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def ensure_tools() -> None:
    missing = [
        name
        for name in ("build", "twine")
        if subprocess.run([sys.executable, "-m", name, "--version"], capture_output=True).returncode != 0
    ]
    if missing:
        run([sys.executable, "-m", "pip", "install", "-q", *missing])


def sdist_url(version: str) -> str:
    with urllib.request.urlopen(f"https://pypi.org/pypi/enano/{version}/json", timeout=30) as response:
        doc = json.load(response)
    for artifact in doc["urls"]:
        if artifact["packagetype"] == "sdist":
            return artifact["url"]
    raise SystemExit(f"PyPI lists no sdist for enano {version} (upload may still be propagating)")


def formula(version: str, url: str, sha: str) -> str:
    return f'''class Enano < Formula
  include Language::Python::Virtualenv
  desc "Explorable nano models for your second brain: pull versioned bundles, scan deterministically"
  homepage "https://enano.ai"
  url "{url}"
  sha256 "{sha}"
  license :cannot_represent

  depends_on "python@3.12"

  def install
    virtualenv_install_with_resources
  end

  test do
    assert_match version.to_s, shell_output("#{{bin}}/enano --version")
  end
end
'''


def update_tap(version: str, url: str, sha: str) -> None:
    """Commit the new formula to enano-ai/homebrew-tap through the gh CLI."""
    current = subprocess.run(
        ["gh", "api", f"repos/{TAP_REPO}/contents/{TAP_FORMULA}"],
        capture_output=True,
        text=True,
    )
    if current.returncode != 0:
        print(f"gh could not read {TAP_REPO} — update the tap manually with the formula above")
        return
    payload = json.dumps(
        {
            "message": f"enano {version}",
            "content": base64.b64encode(formula(version, url, sha).encode()).decode(),
            "sha": json.loads(current.stdout)["sha"],
        }
    )
    run(
        ["gh", "api", "-X", "PUT", f"repos/{TAP_REPO}/contents/{TAP_FORMULA}", "--input", "-"],
        input=payload,
        text=True,
    )
    print(f"updated {TAP_REPO}/{TAP_FORMULA} — brew install enano-ai/tap/enano now serves {version}")

def main() -> int:
    parser = argparse.ArgumentParser(description="release enano to PyPI + generate the Homebrew formula")
    parser.add_argument("version", nargs="?", help="target version, e.g. 0.3.0 (default: minor bump)")
    parser.add_argument("--dry-run", action="store_true", help="build + checks only; no commit, upload, or tag")
    parser.add_argument("--skip-tests", action="store_true", help="skip the pytest gate")
    parser.add_argument("--skip-tap", action="store_true", help="skip the homebrew-tap update")
    parser.add_argument("--push", action="store_true", help="push branch + release tag after tagging")
    args = parser.parse_args()

    old = current_version()
    version = args.version or bump_minor(old)
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise SystemExit(f"bad version {version!r} — expected X.Y.Z")
    if version == old:
        raise SystemExit(f"version {version} is already in {PYPROJECT}")
    print(f"releasing enano {old} -> {version}")

    dirty = subprocess.run(["git", "status", "--porcelain"], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    if dirty and not args.dry_run:
        raise SystemExit("working tree is not clean — commit or stash first (a release commits the version bump)")

    if not args.skip_tests:
        venv_python = ROOT / ".venv" / "bin" / "python"
        py = str(venv_python) if venv_python.exists() else sys.executable
        run([py, "-m", "pytest", "tests/"])

    ensure_tools()

    if not args.dry_run:
        set_version(version)
        run(["git", "add", "pyproject.toml"], cwd=ROOT)
        run(["git", "commit", "-m", f"Release {version}"], cwd=ROOT)

    dist = ROOT / "dist"
    shutil.rmtree(dist, ignore_errors=True)
    run([sys.executable, "-m", "build", "--outdir", str(dist), str(ROOT)])
    run([sys.executable, "-m", "twine", "check", *[str(p) for p in sorted(dist.iterdir())]])

    sdist = next(dist.glob("*.tar.gz"), None)
    if sdist is None:
        raise SystemExit(f"build produced no sdist in {dist}")
    sha = sha256_file(sdist)

    url = f"https://pypi.org/project/enano/{version}/#files (dry run — real files.pythonhosted.org url lands after upload)"
    if not args.dry_run:
        run([sys.executable, "-m", "twine", "upload", *[str(p) for p in sorted(dist.iterdir())]])
        url = sdist_url(version)
        run(["git", "tag", f"v{version}"], cwd=ROOT)
        if args.push:
            run(["git", "push"], cwd=ROOT)
            run(["git", "push", "origin", f"v{version}"], cwd=ROOT)

    text = formula(version, url, sha)
    print()
    print(text)
    if not args.dry_run and not args.skip_tap:
        update_tap(version, url, sha)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
