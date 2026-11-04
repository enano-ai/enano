"""Unit tests for enano.store: root resolution, latest pointer, bundle lifecycle."""

from __future__ import annotations

import json
import zipfile

import pytest

from enano import store


# ------------------------------------------------------------------ roots


def test_store_root_env_override(store_home):
    assert store.store_root() == store_home


def test_store_root_precedence(monkeypatch, tmp_path):
    default = tmp_path / "default-enano"
    default.mkdir()
    monkeypatch.setattr(store, "DEFAULT_HOME", default)
    monkeypatch.setattr(store, "_LEGACY_HOME", tmp_path / "legacy-etiny")
    monkeypatch.delenv("ENANO_HOME", raising=False)
    monkeypatch.delenv("ETINY_HOME", raising=False)
    assert store.store_root() == default
    monkeypatch.setenv("ETINY_HOME", str(tmp_path / "env-etiny"))
    assert store.store_root() == tmp_path / "env-etiny"
    monkeypatch.setenv("ENANO_HOME", str(tmp_path / "env-enano"))
    assert store.store_root() == tmp_path / "env-enano"


def test_store_root_migrates_legacy_dir(monkeypatch, tmp_path):
    default = tmp_path / "default-enano"
    legacy = tmp_path / "legacy-etiny"
    legacy.mkdir()
    (legacy / "default-model").write_text("pitch-decks")
    monkeypatch.setattr(store, "DEFAULT_HOME", default)
    monkeypatch.setattr(store, "_LEGACY_HOME", legacy)
    monkeypatch.delenv("ENANO_HOME", raising=False)
    monkeypatch.delenv("ETINY_HOME", raising=False)
    assert store.store_root() == default
    assert (default / "default-model").read_text() == "pitch-decks"
    assert not legacy.exists()


def test_store_root_migration_failure_falls_back(monkeypatch, tmp_path):
    default = tmp_path / "default-enano"
    legacy = tmp_path / "legacy-etiny"
    legacy.mkdir()

    def refuse(self, target):
        raise OSError("cannot rename")

    monkeypatch.setattr(store.Path, "rename", refuse)
    monkeypatch.setattr(store, "DEFAULT_HOME", default)
    monkeypatch.setattr(store, "_LEGACY_HOME", legacy)
    monkeypatch.delenv("ENANO_HOME", raising=False)
    monkeypatch.delenv("ETINY_HOME", raising=False)
    assert store.store_root() == legacy


# ----------------------------------------------------------- default model


def test_default_model_fallback(store_home):
    assert store.default_model() == "personal-goals"


def test_default_model_roundtrip(store_home):
    store.write_default_model("career-advice")
    assert store.default_model() == "career-advice"


# ------------------------------------------------------------ latest pointer


def test_latest_pointer_roundtrip(store_home):
    for version in ("1.0", "2.0"):
        store.model_dir("m", version).mkdir(parents=True)
    store.write_latest("m", "1.0")
    assert store.read_latest("m") == "1.0"
    store.write_latest("m", "2.0")
    assert store.read_latest("m") == "2.0"


def test_read_latest_ignores_dangling_symlink(store_home):
    store.model_dir("m", "1.0").mkdir(parents=True)
    pointer = store.models_root() / "m" / "latest"
    pointer.symlink_to("missing", target_is_directory=True)
    assert store.read_latest("m") is None


def test_latest_pointer_file_fallback(store_home, monkeypatch):
    def refuse(self, target, target_is_directory=False):
        raise OSError("symlinks unavailable")

    monkeypatch.setattr(store.Path, "symlink_to", refuse)
    store.model_dir("m", "1.0").mkdir(parents=True)
    store.write_latest("m", "1.0")
    pointer = store.models_root() / "m" / "latest"
    assert not pointer.is_symlink()
    assert pointer.read_text(encoding="utf-8") == "1.0"
    assert store.read_latest("m") == "1.0"


# ---------------------------------------------------------------- resolution


def test_resolve_version_explicit(store_home):
    d = store.model_dir("m", "1.0")
    d.mkdir(parents=True)
    assert store.resolve_version("m", "1.0") == d
    assert store.resolve_version("m", "9.9") is None
    assert store.resolve_version("m", None) is None


def test_resolve_version_via_latest(store_home):
    d = store.model_dir("m", "1.0")
    d.mkdir(parents=True)
    store.write_latest("m", "1.0")
    assert store.resolve_version("m", None) == d


# -------------------------------------------------------------- local models


def test_local_models_skips_latest_and_files(store_home):
    for version in ("1.0", "2.0"):
        store.model_dir("m", version).mkdir(parents=True)
    (store.models_root() / "m" / "latest").write_text("1.0")
    (store.models_root() / "stray.txt").write_text("x")
    models = store.local_models()
    assert [m.version for m in models] == ["1.0", "2.0"]
    assert all(m.model == "m" for m in models)


def test_local_model_runnable_and_version_doc(store_home):
    d = store.model_dir("m", "1.0")
    (d / "tools").mkdir(parents=True)
    (d / "tools" / "scan.py").write_text("print('hi')")
    (d / "VERSION.json").write_text(json.dumps({"counts": {"rules": 7}}))
    [m] = store.local_models()
    assert m.runnable is True
    assert m.version_doc == {"counts": {"rules": 7}}


def test_local_model_missing_manifest_and_tools(store_home):
    store.model_dir("m", "1.0").mkdir(parents=True)
    [m] = store.local_models()
    assert m.version_doc == {}
    assert m.runnable is False


def test_version_doc_survives_bad_json(store_home):
    d = store.model_dir("m", "1.0")
    d.mkdir(parents=True)
    (d / "VERSION.json").write_text("{not json")
    [m] = store.local_models()
    assert m.version_doc == {}


# ------------------------------------------------------------- install/remove


def _zip_with(path, root, files):
    with zipfile.ZipFile(path, "w") as zf:
        for name, text in files.items():
            zf.writestr(f"{root}/{name}", text)


def test_install_bundle_lifts_single_top_dir(store_home):
    archive = store_home / "a.zip"
    _zip_with(archive, "enano-m-model-2026", {"VERSION.json": "{}", "tools/scan.py": "x"})
    target = store.install_bundle("m", "1.0", archive)
    assert (target / "tools" / "scan.py").is_file()
    assert not (target / "enano-m-model-2026").exists()
    assert store.read_latest("m") == "1.0"


def test_install_bundle_flat_zip(store_home):
    archive = store_home / "flat.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("VERSION.json", "{}")
    target = store.install_bundle("m", "1.0", archive)
    assert (target / "VERSION.json").is_file()


def test_install_bundle_replaces_existing(store_home):
    archive = store_home / "a.zip"
    _zip_with(archive, "top", {"VERSION.json": "new"})
    stale = store.model_dir("m", "1.0")
    stale.mkdir(parents=True)
    (stale / "stale.txt").write_text("old")
    target = store.install_bundle("m", "1.0", archive)
    assert not (target / "stale.txt").exists()
    assert (target / "VERSION.json").read_text() == "new"


def test_remove_version_guards_latest(store_home):
    store.model_dir("m", "1.0").mkdir(parents=True)
    store.write_latest("m", "1.0")
    with pytest.raises(SystemExit, match="'latest' points at it"):
        store.remove_version("m", "1.0")
    assert store.model_dir("m", "1.0").is_dir()
    assert store.remove_version("m", "1.0", force=True) is True
    assert not store.model_dir("m", "1.0").exists()


def test_remove_version_missing(store_home):
    assert store.remove_version("m", "9.9") is False
