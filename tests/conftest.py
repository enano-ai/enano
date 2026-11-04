"""Shared fixtures: an isolated store, an in-memory registry, hermetic downloads."""

from __future__ import annotations

import json
import sys
import zipfile

import pytest

from enano import registry as reg


SCAN_TOOL = (
    "import json, sys\n"
    "docs = [a for a in sys.argv[1:] if a != '--json']\n"
    "print(json.dumps({'scanned': docs, 'findings': 2}))\n"
)


def _entry(model: str, version: str, size: int) -> dict:
    stem = f"enano-{model}-model-{version}"
    return {
        "bytes": size,
        "sha256": "0" * 64,
        "url": f"https://example.com/{stem}.zip",
        "mirrorUrl": f"https://mirror.example.com/{stem}.zip",
    }


@pytest.fixture
def store_home(tmp_path, monkeypatch):
    home = tmp_path / "store"
    home.mkdir()
    monkeypatch.setenv("ENANO_HOME", str(home))
    return home


@pytest.fixture
def registry_doc():
    return {
        "models": {
            "personal-goals": {
                "description": "advice for personal goals",
                "latest": "2026-01-01",
                "versions": {
                    "2026-01-01": _entry("personal-goals", "2026-01-01", 2_000),
                    "2025-06-01": _entry("personal-goals", "2025-06-01", 1_500),
                },
            },
            "career-advice": {
                "description": "advice for careers",
                "latest": "2026-02-02",
                "versions": {
                    "2026-02-02": _entry("career-advice", "2026-02-02", 3_000),
                },
            },
        }
    }


@pytest.fixture
def registry(monkeypatch, registry_doc):
    monkeypatch.setattr(reg, "fetch_registry", lambda refresh=False, cache_path=None: registry_doc)
    return registry_doc


@pytest.fixture
def downloads(monkeypatch):
    """Fake download_archive: writes a real zip artifact instead of hitting the network."""

    def download_archive(url, expected_bytes, sha256, dest_dir):
        dest_dir.mkdir(parents=True, exist_ok=True)
        name = url.rsplit("/", 1)[-1]
        archive = dest_dir / name
        root = name.removesuffix(".zip")
        with zipfile.ZipFile(archive, "w") as zf:
            zf.writestr(f"{root}/VERSION.json", json.dumps({"built_at": "now", "counts": {"rules": 3}}))
            zf.writestr(f"{root}/tools/scan.py", SCAN_TOOL)
            zf.writestr(f"{root}/tools/verify.py", "print('verified')\n")
        return archive

    monkeypatch.setattr(reg, "download_archive", download_archive)
    return download_archive


@pytest.fixture
def bundle_factory(store_home):
    """Install a bundle directory directly on disk (no registry, no download)."""
    from enano import store

    def make(model="personal-goals", version="2026-01-01", tools=True, scan_exit=0, verify_exit=0):
        root = store.model_dir(model, version)
        root.mkdir(parents=True)
        (root / "VERSION.json").write_text(
            json.dumps({"built_at": version, "counts": {"rules": 4, "detectors": 2}})
        )
        if tools:
            (root / "tools").mkdir()
            scan = SCAN_TOOL if scan_exit == 0 else f"raise SystemExit({scan_exit})\n"
            (root / "tools" / "scan.py").write_text(scan)
            verify = (
                "print('verified')\n"
                if verify_exit == 0
                else f"print('broken'); raise SystemExit({verify_exit})\n"
            )
            (root / "tools" / "verify.py").write_text(verify)
        store.write_latest(model, version)
        return root

    return make


@pytest.fixture
def tty(monkeypatch):
    """Simulate an interactive terminal: stdin reports tty and input() answers 'y'."""

    class FakeStdin:
        def isatty(self):
            return True

    monkeypatch.setattr(sys, "stdin", FakeStdin())
    monkeypatch.setattr("builtins.input", lambda prompt="": "y")
