"""Local bundle store: ~/.enano layout (a legacy ~/.etiny is moved here once)."""

from __future__ import annotations

import json
import os
import shutil
import zipfile
from dataclasses import dataclass
from pathlib import Path

DEFAULT_HOME = Path.home() / ".enano"
_LEGACY_HOME = Path.home() / ".etiny"


def store_root() -> Path:
    env = os.environ.get("ENANO_HOME") or os.environ.get("ETINY_HOME")
    if env:
        return Path(env)
    if not DEFAULT_HOME.is_dir() and _LEGACY_HOME.is_dir():
        try:
            _LEGACY_HOME.rename(DEFAULT_HOME)
        except OSError:
            return _LEGACY_HOME
    return DEFAULT_HOME


def registry_cache_path() -> Path:
    return store_root() / "registry.json"


def default_model() -> str:
    """The model `use` selected (persisted); falls back to the global default."""
    pointer = store_root() / "default-model"
    if pointer.is_file():
        value = pointer.read_text(encoding="utf-8").strip()
        if value:
            return value
    return "personal-goals"


def write_default_model(model: str) -> None:
    root = store_root()
    root.mkdir(parents=True, exist_ok=True)
    (root / "default-model").write_text(model, encoding="utf-8")


def models_root() -> Path:
    return store_root() / "models"


def model_dir(model: str, version: str) -> Path:
    return models_root() / model / version


@dataclass
class LocalModel:
    model: str
    version: str
    path: Path
    bytes: int

    @property
    def version_doc(self) -> dict:
        path = self.path / "VERSION.json"
        if not path.is_file():
            return {}
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return {}

    @property
    def runnable(self) -> bool:
        return (self.path / "tools" / "scan.py").is_file()


def read_latest(model: str) -> str | None:
    pointer = models_root() / model / "latest"
    if pointer.is_symlink():
        target = pointer.resolve()
        return target.name if target.is_dir() else None
    if pointer.is_file():
        value = pointer.read_text(encoding="utf-8").strip()
        return value or None
    return None


def write_latest(model: str, version: str) -> None:
    pointer = models_root() / model / "latest"
    if pointer.is_symlink() or pointer.is_file():
        pointer.unlink()
    try:
        pointer.symlink_to(version, target_is_directory=True)
    except OSError:
        pointer.write_text(version, encoding="utf-8")


def resolve_version(model: str, version: str | None) -> Path | None:
    """Resolve name or name@version to a bundle directory on disk."""
    if version:
        path = model_dir(model, version)
        return path if path.is_dir() else None
    latest = read_latest(model)
    if not latest:
        return None
    path = model_dir(model, latest)
    return path if path.is_dir() else None


def local_models() -> list[LocalModel]:
    out: list[LocalModel] = []
    root = models_root()
    if not root.is_dir():
        return out
    for model_path in sorted(root.iterdir()):
        if not model_path.is_dir():
            continue
        for version_path in sorted(model_path.iterdir()):
            if not version_path.is_dir() or version_path.name == "latest":
                continue
            out.append(
                LocalModel(
                    model=model_path.name,
                    version=version_path.name,
                    path=version_path,
                    bytes=sum(f.stat().st_size for f in version_path.rglob("*") if f.is_file()),
                )
            )
    return out


def install_bundle(model: str, version: str, archive: Path) -> Path:
    """Extract a bundle zip into the store and point latest at it.

    The zip contains a single top-level directory (enano-<model>-model-<date>
    or etiny-...); its contents are lifted into models/<model>/<version>/ so
    the store is addressed by clean names regardless of the artifact naming.
    """
    staging = model_dir(model, f".{version}.tmp")
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)
    with zipfile.ZipFile(archive) as bundle:
        bundle.extractall(staging)
    top = [p for p in staging.iterdir() if p.is_dir()]
    payload = top[0] if len(top) == 1 else staging
    target = model_dir(model, version)
    if target.exists():
        shutil.rmtree(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(payload), str(target))
    shutil.rmtree(staging, ignore_errors=True)
    write_latest(model, version)
    return target


def remove_version(model: str, version: str, force: bool = False) -> bool:
    path = model_dir(model, version)
    if not path.is_dir():
        return False
    if read_latest(model) == version and not force:
        raise SystemExit(
            f"refusing to remove {model}@{version}: 'latest' points at it (use --force)"
        )
    shutil.rmtree(path)
    return True
