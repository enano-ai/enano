"""Unit tests for enano.registry: index parsing, resolution, verified downloads."""

from __future__ import annotations

import hashlib
import json

import pytest

from enano import registry as reg


def test_registry_url_default(monkeypatch):
    monkeypatch.delenv("ETINY_REGISTRY", raising=False)
    monkeypatch.delenv("ENANO_REGISTRY", raising=False)
    assert reg.registry_url() == reg.DEFAULT_REGISTRY_URL


def test_registry_url_env_override(monkeypatch):
    monkeypatch.setenv("ETINY_REGISTRY", "https://example.com/registry.json")
    assert reg.registry_url() == "https://example.com/registry.json"


def test_registry_url_prefers_enano_env(monkeypatch):
    monkeypatch.setenv("ENANO_REGISTRY", "https://enano.example.com/registry.json")
    monkeypatch.setenv("ETINY_REGISTRY", "https://legacy.example.com/registry.json")
    assert reg.registry_url() == "https://enano.example.com/registry.json"


def test_registry_models_empty():
    assert reg.registry_models({}) == {}
    assert reg.registry_models({"models": {"m": {}}}) == {"m": {}}


def test_resolve_entry_latest():
    doc = {"models": {"m": {"latest": "2", "versions": {"1": {"bytes": 10}, "2": {"bytes": 20}}}}}
    entry = reg.resolve_entry(doc, "m", None)
    assert entry["model"] == "m"
    assert entry["version"] == "2"
    assert entry["bytes"] == 20


def test_resolve_entry_explicit_version():
    doc = {"models": {"m": {"latest": "2", "versions": {"1": {"bytes": 10}}}}}
    assert reg.resolve_entry(doc, "m", "1")["bytes"] == 10


def test_resolve_entry_unknown_model():
    with pytest.raises(SystemExit, match="registry has: m"):
        reg.resolve_entry({"models": {"m": {}}}, "nope", None)


def test_resolve_entry_unknown_version():
    doc = {"models": {"m": {"latest": "1", "versions": {"1": {}}}}}
    with pytest.raises(SystemExit, match="available: 1"):
        reg.resolve_entry(doc, "m", "9")


def test_resolve_entry_no_latest():
    doc = {"models": {"m": {"versions": {"1": {}}}}}
    with pytest.raises(SystemExit, match="no 'latest' version"):
        reg.resolve_entry(doc, "m", None)


def test_sha256_file(tmp_path):
    f = tmp_path / "blob.bin"
    f.write_bytes(b"hello")
    assert reg.sha256_file(f) == hashlib.sha256(b"hello").hexdigest()


def test_fetch_registry_uses_cache(tmp_path, monkeypatch):
    cache = tmp_path / "registry.json"
    cache.write_text(json.dumps({"models": {"cached": {}}}))
    monkeypatch.setattr(reg, "registry_url", lambda: "file:///missing/registry.json")
    assert reg.fetch_registry(cache_path=cache) == {"models": {"cached": {}}}


def test_fetch_registry_refresh_bypasses_cache(tmp_path, monkeypatch):
    cache = tmp_path / "registry.json"
    cache.write_text(json.dumps({"models": {"stale": {}}}))
    monkeypatch.setattr(reg, "_get_json", lambda url: {"models": {"fresh": {}}})
    doc = reg.fetch_registry(refresh=True, cache_path=cache)
    assert doc == {"models": {"fresh": {}}}
    assert json.loads(cache.read_text()) == doc


def test_fetch_registry_corrupt_cache_refetches(tmp_path, monkeypatch):
    cache = tmp_path / "registry.json"
    cache.write_text("}{ not json")
    monkeypatch.setattr(reg, "_get_json", lambda url: {"models": {}})
    assert reg.fetch_registry(cache_path=cache) == {"models": {}}


class _FakeResponse:
    def __init__(self, payload):
        self.payload = payload
        self.status = 200
        self.headers = {"Content-Length": str(len(payload))}

    def read(self, size=-1):
        chunk, self.payload = self.payload[:size], self.payload[size:]
        return chunk

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


@pytest.fixture
def serve(tmp_path, monkeypatch):
    """Serve local bytes through a fake urlopen: no network, no file:// quirks."""

    def start(payload):
        monkeypatch.setattr(
            "urllib.request.urlopen", lambda url, timeout=None: _FakeResponse(payload)
        )
        return "https://example.com/bundle.zip"

    return start


def test_download_archive_verifies_and_lands(tmp_path, serve):
    payload = b"bundle-bytes"
    url = serve(payload)
    dest = reg.download_archive(
        url, len(payload), hashlib.sha256(payload).hexdigest(), tmp_path / "dl"
    )
    assert dest.name == "bundle.zip"
    assert dest.read_bytes() == payload


def test_download_archive_sha_mismatch(tmp_path, serve):
    payload = b"bundle-bytes"
    url = serve(payload)
    with pytest.raises(SystemExit, match="sha256 mismatch"):
        reg.download_archive(url, 0, "0" * 64, tmp_path / "dl")
    assert list((tmp_path / "dl").glob("*.part")) == []
    assert not (tmp_path / "dl" / "bundle.zip").exists()


def test_download_archive_size_mismatch(tmp_path, serve):
    payload = b"short"
    url = serve(payload)
    with pytest.raises(SystemExit, match="size mismatch"):
        reg.download_archive(
            url, 999, hashlib.sha256(payload).hexdigest(), tmp_path / "dl"
        )
