"""Registry client: fetch the index, verify and download bundle artifacts."""

from __future__ import annotations

import hashlib
import json
import tempfile
import urllib.request
from pathlib import Path
from typing import Any

DEFAULT_REGISTRY_URL = (
    "https://amplify-ddcl74bt0u5nd-mai-enanopacksbucket30a8cb47-dzorvtabphoz"
    ".s3.us-east-2.amazonaws.com/builtin-data/model-zips/registry.json"
)


def registry_url() -> str:
    import os

    return os.environ.get("ETINY_REGISTRY", DEFAULT_REGISTRY_URL)


def fetch_registry(refresh: bool = False, cache_path: Path | None = None) -> dict[str, Any]:
    """Fetch the registry index; cache it in the store between commands."""
    from .store import registry_cache_path

    path = cache_path or registry_cache_path()
    if not refresh and path.is_file():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    doc = _get_json(registry_url())
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc, indent=2), encoding="utf-8")
    return doc


def _get_json(url: str) -> Any:
    with urllib.request.urlopen(url, timeout=30) as response:
        if response.status != 200:
            raise SystemExit(f"registry fetch failed: {url} -> {response.status}")
        return json.loads(response.read().decode("utf-8"))


def registry_models(registry: dict[str, Any]) -> dict[str, Any]:
    return registry.get("models", {})


def resolve_entry(registry: dict[str, Any], model: str, version: str | None) -> dict[str, Any]:
    models = registry_models(registry)
    if model not in models:
        known = ", ".join(sorted(models)) or "none published"
        raise SystemExit(f"unknown model {model!r} (registry has: {known})")
    entry = models[model]
    if version is None:
        version = entry.get("latest")
        if not version:
            raise SystemExit(f"model {model!r} has no 'latest' version in the registry")
    versions = entry.get("versions", {})
    if version not in versions:
        raise SystemExit(
            f"unknown version {model}@{version} (available: {', '.join(sorted(versions))})"
        )
    return {"model": model, "version": version, **versions[version]}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download_archive(url: str, expected_bytes: int, sha256: str, dest_dir: Path) -> Path:
    """Stream a bundle zip to disk, verifying size + sha. Progress readout
    only when attached to a terminal; piped/CI output stays clean."""
    import sys

    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / url.rsplit("/", 1)[-1]
    tty = sys.stdout.isatty()
    with tempfile.NamedTemporaryFile(dir=dest_dir, delete=False, suffix=".part") as tmp:
        with urllib.request.urlopen(url, timeout=60) as response:
            if response.status != 200:
                raise SystemExit(f"download failed: {url} -> {response.status}")
            total = int(response.headers.get("Content-Length") or expected_bytes)
            done = 0
            if not tty:
                print(f"  downloading {total / 1e6:.1f} MB …", flush=True)
            while True:
                chunk = response.read(1 << 18)
                if not chunk:
                    break
                tmp.write(chunk)
                done += len(chunk)
                if tty:
                    pct = min(100, round(done * 100 / total)) if total else 0
                    print(f"\r  {pct:>3}%  {done / 1e6:6.1f} / {total / 1e6:.1f} MB", end="", flush=True)
        if tty:
            print()
        if expected_bytes and done != expected_bytes:
            raise SystemExit(f"size mismatch: got {done} bytes, registry says {expected_bytes}")
        tmp_path = Path(tmp.name)
    digest = sha256_file(tmp_path)
    if digest != sha256:
        tmp_path.unlink(missing_ok=True)
        raise SystemExit(f"sha256 mismatch: {digest} != {sha256} — download corrupted or tampered")
    tmp_path.replace(dest)
    return dest
