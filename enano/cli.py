"""The enano CLI: pull-based bundle management plus a front door to the
bundle's own deterministic scan tools."""

from __future__ import annotations

import argparse
import json as jsonlib
import os
import shutil
import subprocess
import sys
import time
import zipfile
from pathlib import Path
from typing import Any

from . import __version__
from . import registry as reg
from . import store
from . import web


def _parse_selector(selector: str) -> tuple[str, str | None]:
    model, _, version = selector.partition("@")
    return model.strip(), (version.strip() or None) if version else None


def _is_newer(candidate: str | None, current: str | None) -> bool:
    """True only when candidate is strictly newer than current. Versions are
    ISO dates (YYYY-MM-DD), so a local build ahead of the registry (e.g. an
    imported pipeline build) never counts as an update and never downgrades."""
    if not candidate or candidate == current:
        return False
    return current is None or candidate > current


def _require_bundle(selector: str) -> Path:
    model, version = _parse_selector(selector)
    path = store.resolve_version(model, version)
    if path:
        return path
    print(f"{model} is not installed. Run: enano pull {model}  (enano list shows what exists)")
    raise SystemExit(2)


def _run_tool(bundle: Path, tool: str, forward: list[str]) -> int:
    tool_path = bundle / "tools" / f"{tool}.py"
    if not tool_path.is_file():
        runnable = (bundle / "tools" / "scan.py").is_file()
        hint = "" if runnable else " (this bundle ships no scanner — weights/corpus only)"
        raise SystemExit(f"tool '{tool}' not found in {bundle.name}{hint}")
    return subprocess.call([sys.executable, str(tool_path), *forward], cwd=str(bundle))


def _pull(model: str, entry: dict, quiet: bool = False) -> Path:
    archive = reg.download_archive(
        entry.get("url") or entry["mirrorUrl"],
        entry.get("bytes", 0),
        entry["sha256"],
        store.store_root() / "archives",
    )
    target = store.install_bundle(model, entry["version"], archive)
    if not quiet:
        print(f"installed {model}@{entry['version']} -> {target}")
    return target


def _pull_runtime(registry: dict, quiet: bool = False) -> bool:
    """Install the shared runtime layer if the registry publishes one and it
    is not installed yet. Returns True when an install happened."""
    entry = reg.resolve_runtime_entry(registry)
    if entry is None or store.runtime_dir(entry["version"]).is_dir():
        return False
    archive = reg.download_archive(
        entry.get("url") or entry["mirrorUrl"],
        entry.get("bytes", 0),
        entry["sha256"],
        store.store_root() / "archives",
    )
    target = store.install_runtime(entry["version"], archive)
    if not quiet:
        print(f"installed runtime@{entry['version']} -> {target}")
    return True


# ------------------------------------------------------------- subcommands


def cmd_pull(args: argparse.Namespace) -> int:
    registry = reg.fetch_registry(refresh=True)
    selectors = list(args.selectors or [])
    if selectors == ["all"]:
        selectors = sorted(reg.registry_models(registry))
    if not selectors:
        raise SystemExit("nothing to pull: give a model (or: enano pull all)")
    results = []
    if "runtime" in selectors:
        selectors = [s for s in selectors if s != "runtime"]
        entry = reg.resolve_runtime_entry(registry)
        if entry is None:
            raise SystemExit("registry has no runtime published")
        if store.runtime_dir(entry["version"]).is_dir():
            if not args.json:
                print(f"runtime@{entry['version']} already installed")
            results.append({"model": "runtime", "version": entry["version"], "status": "already-installed"})
        elif _pull_runtime(registry, quiet=args.json):
            results.append({"model": "runtime", "version": entry["version"], "status": "installed"})
    if selectors:
        _pull_runtime(registry, quiet=args.json)
    for selector in selectors:
        model, version = _parse_selector(selector)
        entry = reg.resolve_entry(registry, model, version)
        if store.model_dir(model, entry["version"]).is_dir():
            if not args.json:
                print(f"{model}@{entry['version']} already installed")
            results.append({"model": model, "version": entry["version"], "status": "already-installed"})
            continue
        _pull(model, entry, quiet=args.json)
        results.append({"model": model, "version": entry["version"], "status": "installed"})
    if args.json:
        print(jsonlib.dumps(results, indent=2))
    return 0


# ------------------------------------------------------------------ import


def _import_targets(path: Path) -> tuple[Path, list[Path]]:
    """Resolve an import path to (build folder, zips).

    Accepts a .ena.zip file, a build folder full of zips (e.g. the pipeline's
    output/ena-zips/<date>/), or the ena-zips root — in which case the newest
    dated subfolder wins, so each build folder stays one immutable snapshot.
    """
    if path.is_file():
        if path.suffix != ".zip":
            raise SystemExit(f"not a zip: {path}")
        return path.parent, [path]
    if not path.is_dir():
        raise SystemExit(f"import path not found: {path}")
    zips = sorted(p for p in path.glob("*.zip") if p.is_file())
    if zips:
        return path, zips
    dated = sorted(d for d in path.iterdir() if d.is_dir() and any(d.glob("*.zip")))
    if dated:
        newest = dated[-1]
        return newest, sorted(newest.glob("*.zip"))
    raise SystemExit(f"no .ena zips found under {path}")


def _import_version_doc(archive: Path) -> dict:
    """VERSION.json from inside a .ena zip (fail-loud when absent or broken)."""
    with zipfile.ZipFile(archive) as bundle:
        matches = [n for n in bundle.namelist() if n.rsplit("/", 1)[-1] == "VERSION.json"]
        if not matches:
            raise SystemExit(f"{archive.name}: no VERSION.json inside — not an enano bundle")
        try:
            return jsonlib.loads(bundle.read(matches[0]))
        except jsonlib.JSONDecodeError as exc:
            raise SystemExit(f"{archive.name}: unreadable VERSION.json ({exc})")


def cmd_import(args: argparse.Namespace) -> int:
    """Install bundles from a local pipeline build instead of the registry."""
    folder, zips = _import_targets(Path(args.path).expanduser())
    registry_doc: dict = {}
    registry_path = folder / "registry.json"
    if registry_path.is_file():
        registry_doc = jsonlib.loads(registry_path.read_text(encoding="utf-8"))
        cache = store.registry_cache_path()
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(jsonlib.dumps(registry_doc, indent=2), encoding="utf-8")
    elif not args.json:
        print("note: no registry.json next to the zips — importing unverified")
    models = registry_doc.get("models", {})
    results = []
    for archive in zips:
        doc = _import_version_doc(archive)
        model = doc.get("slug") or doc.get("model") or archive.name.split(".ena")[0]
        version = doc.get("built_at")
        if not version:
            raise SystemExit(f"{archive.name}: VERSION.json has no built_at — cannot version the install")
        entry = (models.get(model) or {}).get("versions", {}).get(version)
        verified = False
        if entry:
            size = archive.stat().st_size
            if entry.get("bytes") and size != entry["bytes"]:
                raise SystemExit(
                    f"{archive.name}: size mismatch (got {size}, registry says {entry['bytes']})"
                )
            digest = reg.sha256_file(archive)
            if digest != entry["sha256"]:
                raise SystemExit(
                    f"{archive.name}: sha256 mismatch ({digest} != {entry['sha256']}) — "
                    "file corrupted or a stale registry"
                )
            verified = True
        elif models and not args.json:
            print(f"warning: {archive.name} not in registry.json — importing unverified")
        record = {
            "model": model,
            "version": version,
            "kind": doc.get("kind", "bundle"),
            "verified": verified,
        }
        if store.model_dir(model, version).is_dir():
            if not args.json:
                print(f"{model}@{version} already installed")
            results.append({**record, "status": "already-installed"})
            continue
        target = store.install_bundle(model, version, archive)
        if not args.json:
            note = "" if verified else " (unverified)"
            print(f"installed {model}@{version} -> {target}{note}")
        results.append({**record, "status": "installed"})
    if args.json:
        print(jsonlib.dumps(results, indent=2))
    return 0


def _human_bytes(size: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1000:
            return f"{size:.0f} {unit}" if unit == "B" else f"{size:.1f} {unit}"
        size /= 1000
    return f"{size:.1f} TB"


def _clip(text: str, width: int) -> str:
    return text if len(text) <= width else text[: width - 1].rstrip() + "…"


def _catalog_rows(registry: dict[str, Any]) -> list[dict]:
    """One row per registry model at latest, with local install state."""
    rows = []
    for name, entry in sorted(reg.registry_models(registry).items()):
        version = entry.get("latest") or sorted(entry.get("versions", {}))[-1]
        meta = entry.get("versions", {}).get(version, {})
        local = store.read_latest(name)
        if local == version:
            state = "installed"
        elif local:
            state = f"update ({version})" if version > local else f"ahead ({local})"
        else:
            state = "-"
        rows.append(
            {
                "model": name,
                "version": version,
                "kind": entry.get("kind", "bundle"),
                "description": entry.get("description", ""),
                "bytes": meta.get("bytes", 0),
                "state": state,
            }
        )
    return rows


def _print_catalog(rows: list[dict]) -> None:
    name_w = max([len("NAME")] + [len(r["model"]) for r in rows])
    desc_w = 44
    print(f"{'NAME':<{name_w}}  {'DESCRIPTION':<{desc_w}}  {'SIZE':>8}  {'UPDATED':<11} STATE")
    for r in rows:
        print(
            f"{r['model']:<{name_w}}  {_clip(r['description'], desc_w):<{desc_w}}"
            f"  {_human_bytes(r['bytes']):>8}  {r['version']:<11} {r['state']}"
        )


def cmd_list(args: argparse.Namespace) -> int:
    """Remote: the registry catalog — one row per model at latest."""
    registry = reg.fetch_registry(refresh=True)
    models = reg.registry_models(registry)
    if not models:
        raise SystemExit("registry has no models published")
    rows = _catalog_rows(registry)
    if args.json:
        print(jsonlib.dumps(rows, indent=2))
        return 0
    _print_catalog(rows)
    return 0


def cmd_search(args: argparse.Namespace) -> int:
    """Search the registry catalog by slug, description, or kind."""
    query = " ".join(args.query).strip().lower()
    if not query:
        raise SystemExit("nothing to search: give a term (e.g. enano search habit)")
    rows = [
        r
        for r in _catalog_rows(reg.fetch_registry(refresh=True))
        if query in f"{r['model']} {r['description']} {r['kind']}".lower()
    ]
    if args.json:
        print(jsonlib.dumps(rows, indent=2))
        return 0
    if not rows:
        print(f"no models match {query!r} — enano list shows everything")
        return 0
    _print_catalog(rows)
    return 0


def cmd_models(args: argparse.Namespace) -> int:
    """Local: what's installed in the store."""
    rows = []
    for m in store.local_models():
        rows.append(
            {
                "name": f"{m.model}@{m.version}",
                "bytes": m.bytes,
                "pulled": time.strftime("%Y-%m-%d", time.localtime(m.path.stat().st_mtime)),
                "state": "latest" if store.read_latest(m.model) == m.version else "old",
            }
        )
    runtime_latest = store.read_runtime_latest()
    if runtime_latest:
        path = store.runtime_dir(runtime_latest)
        rows.append(
            {
                "name": f"runtime@{runtime_latest}",
                "bytes": sum(f.stat().st_size for f in path.rglob("*") if f.is_file()),
                "pulled": time.strftime("%Y-%m-%d", time.localtime(path.stat().st_mtime)),
                "state": "shared engine assets",
            }
        )
    if not rows:
        print("nothing installed — try: enano pull personal-goals  (enano list shows what exists)")
        return 0
    if args.json:
        print(jsonlib.dumps(rows, indent=2))
        return 0
    name_w = max(len(r["name"]) for r in rows)
    print(f"{'NAME':<{name_w}}  {'SIZE':>8}  PULLED      STATE")
    for r in rows:
        print(f"{r['name']:<{name_w}}  {_human_bytes(r['bytes']):>8}  {r['pulled']}  {r['state']}")
    return 0


def _update_run(args: argparse.Namespace, fetch: bool) -> int:
    registry = reg.fetch_registry(refresh=True)
    targets = [args.model] if args.model else sorted({m.model for m in store.local_models()})
    rows = []
    for model in targets:
        entry = reg.registry_models(registry).get(model)
        if not entry:
            rows.append({"model": model, "status": "not-in-registry"})
            if not args.json:
                print(f"{model}: not in registry")
            continue
        latest = entry.get("latest")
        local_latest = store.read_latest(model)
        if not _is_newer(latest, local_latest):
            status = "up-to-date" if latest == local_latest else "ahead-of-registry"
            rows.append({"model": model, "current": local_latest, "latest": latest, "status": status})
            if not args.json:
                if status == "up-to-date":
                    print(f"{model}: up to date ({latest})")
                else:
                    print(f"{model}: local {local_latest} is ahead of the registry ({latest}) — skipping")
            continue
        rows.append({"model": model, "current": local_latest, "latest": latest, "status": "update-available"})
        if not args.json:
            print(f"{model}: {local_latest or 'none'} -> {latest}")
        if fetch:
            _pull(model, reg.resolve_entry(registry, model, latest), quiet=args.json)
    runtime_entry = reg.resolve_runtime_entry(registry)
    if runtime_entry:
        current = store.read_runtime_latest()
        if _is_newer(runtime_entry["version"], current):
            rows.append({"model": "runtime", "current": current, "latest": runtime_entry["version"], "status": "update-available"})
            if not args.json:
                print(f"runtime: {current or 'none'} -> {runtime_entry['version']}")
            if fetch:
                _pull_runtime(registry, quiet=args.json)
        else:
            rows.append({"model": "runtime", "current": current, "latest": current, "status": "up-to-date"})
            if not args.json:
                print(f"runtime: up to date ({current})")
    if args.json:
        print(jsonlib.dumps(rows, indent=2))
    return 0


def cmd_update(args: argparse.Namespace) -> int:
    return _update_run(args, fetch=False)


def cmd_upgrade(args: argparse.Namespace) -> int:
    return _update_run(args, fetch=True)


def cmd_use(args: argparse.Namespace) -> int:
    if args.model:
        registry = reg.fetch_registry(refresh=True)
        if args.model not in reg.registry_models(registry):
            raise SystemExit(f"unknown model {args.model!r} (enano list shows what exists)")
        store.write_default_model(args.model)
    current = store.default_model()
    if args.json:
        print(jsonlib.dumps({"default_model": current}))
        return 0
    note = "" if store.resolve_version(current, None) else f" (not installed — enano pull {current})"
    print(f"default model: {current}{note}")
    return 0


def cmd_info(args: argparse.Namespace) -> int:
    model, version = _parse_selector(args.model)
    path = store.resolve_version(model, version)
    if not path:
        raise SystemExit(f"{args.model} is not installed (try: enano pull {model})")
    m = next((lm for lm in store.local_models() if lm.path == path), None)
    doc = m.version_doc if m else {}
    info = {
        "model": model,
        "version": doc.get("built_at") or path.name,
        "latest_local": store.read_latest(model),
        "path": str(path),
        "disk_mb": round((m.bytes if m else 0) / 1e6, 1),
        "counts": doc.get("counts", {}),
        "runnable": (path / "tools" / "scan.py").is_file(),
    }
    if args.json:
        print(jsonlib.dumps(info, indent=2))
    else:
        for key, value in info.items():
            print(f"{key:>12}: {value}")
    return 0


def cmd_rm(args: argparse.Namespace) -> int:
    model, version = _parse_selector(args.model)
    if not version:
        versions = [lm.version for lm in store.local_models() if lm.model == model]
        if len(versions) == 1:
            version = versions[0]
        elif versions:
            raise SystemExit(f"multiple versions installed: {versions} — pick {model}@<version>")
    if store.read_latest(model) == version:
        prompt = f"{model}@{version} is what 'latest' points at — remove it anyway? [y/N] "
        if sys.stdin.isatty():
            if input(prompt).strip().lower() not in ("y", "yes"):
                raise SystemExit(2)
        else:
            raise SystemExit(
                f"refusing to remove {model}@{version}: 'latest' points at it (confirm on a terminal)"
            )
    if store.remove_version(model, version, force=True):
        if args.json:
            print(jsonlib.dumps({"removed": f"{model}@{version}"}))
        else:
            print(f"removed {model}@{version}")
        return 0
    raise SystemExit(f"{model}@{version} is not installed")


def cmd_prune(args: argparse.Namespace) -> int:
    everything = args.target == "all"
    removed = []
    for m in store.local_models():
        if not everything and store.read_latest(m.model) == m.version:
            continue
        store.remove_version(m.model, m.version, force=True)
        removed.append(f"{m.model}@{m.version}")
    if everything:
        shutil.rmtree(store.models_root(), ignore_errors=True)
    if args.json:
        print(jsonlib.dumps({"removed": removed, "store_emptied": everything}))
        return 0
    for name in removed:
        print(f"removed {name}")
    if everything and removed:
        print("store emptied")
    if not removed:
        print("nothing to prune")
    return 0


def cmd_verify(args: argparse.Namespace) -> int:
    if args.model:
        bundle = _require_bundle(args.model)
        targets = [m for m in store.local_models() if m.path == bundle]
    else:
        targets = store.local_models()
    results = []
    for m in targets:
        tool = m.path / "tools" / "verify.py"
        if not tool.is_file():
            results.append({"model": m.model, "version": m.version, "ok": None, "note": "no verify tool in bundle"})
            continue
        out = subprocess.run(
            [sys.executable, str(tool)], cwd=str(m.path), capture_output=True, text=True
        )
        results.append(
            {"model": m.model, "version": m.version, "ok": out.returncode == 0, "output": out.stdout.strip()}
        )
    ok = all(r.get("ok") for r in results)
    if args.json:
        print(jsonlib.dumps({"ok": ok, "results": results}, indent=2))
    else:
        for r in results:
            mark = "ok" if r.get("ok") else ("n/a" if r.get("ok") is None else "FAIL")
            print(f"[{mark}] {r['model']}@{r['version']}")
            if r.get("output") and not r.get("ok"):
                print("    " + r["output"].replace("\n", "\n    "))
    return 0 if ok else 1


def _forwardable(forward: list[str]) -> list[str]:
    """Absolutize file arguments: bundle tools run with cwd=<bundle>, so a
    relative path would resolve inside the bundle instead of the user's cwd."""
    out = []
    for arg in forward:
        if not arg.startswith("-") and Path(arg).exists():
            out.append(str(Path(arg).resolve()))
        else:
            out.append(arg)
    return out


def cmd_scan(args: argparse.Namespace) -> int:
    bundle = _require_bundle(store.default_model())
    forward = _forwardable(list(args.forward))
    json_flag = ["--json"] if args.json else []
    if forward:
        return _run_tool(bundle, "scan", forward + json_flag)
    if not sys.stdin.isatty():
        return _run_tool(bundle, "scan", ["-"] + json_flag)
    docs = sorted(Path.cwd().glob("*.md"))
    if not docs:
        raise SystemExit("no .md files in the current directory (or pass a file: enano scan notes.md)")
    print(f"scanning {len(docs)} markdown file(s) in {Path.cwd()}", flush=True)
    failed = 0
    for doc in docs:
        print(f"\n===== {doc.name} =====", flush=True)
        failed += _run_tool(bundle, "scan", [str(doc)] + json_flag) != 0
    return 1 if failed else 0


SKIP_DIRS = {"node_modules", "__pycache__", ".venv"}


def _walk_docs(root: Path) -> list[Path]:
    docs = []
    for path in sorted(root.rglob("*.md")):
        dirs = path.relative_to(root).parts[:-1]
        if any(part in SKIP_DIRS or part.startswith(".") for part in dirs):
            continue
        docs.append(path)
    return docs


def cmd_walk(args: argparse.Namespace) -> int:
    bundle = _require_bundle(store.default_model())
    tool = bundle / "tools" / "scan.py"
    if not tool.is_file():
        raise SystemExit(f"this bundle ships no scanner ({bundle.name})")
    root = Path(args.directory).expanduser() if args.directory else Path.cwd()
    if not root.is_dir():
        raise SystemExit(f"not a directory: {root}")
    root = root.resolve()
    docs = _walk_docs(root)
    if not docs:
        raise SystemExit(f"no .md files under {root}")
    if args.json:
        results = []
        failed = 0
        for doc in docs:
            out = subprocess.run(
                [sys.executable, str(tool), str(doc), "--json"],
                cwd=str(bundle), capture_output=True, text=True,
            )
            ok = out.returncode == 0
            failed += 0 if ok else 1
            try:
                parsed = jsonlib.loads(out.stdout)
            except jsonlib.JSONDecodeError:
                parsed = out.stdout.strip()
            results.append({"path": str(doc.relative_to(root)), "ok": ok, "result": parsed})
        print(jsonlib.dumps(
            {"root": str(root), "files": len(results), "failed": failed, "results": results}, indent=2
        ))
        return 1 if failed else 0
    print(f"walking {len(docs)} markdown file(s) under {root}", flush=True)
    failed = 0
    for doc in docs:
        print(f"\n===== {doc.relative_to(root)} =====", flush=True)
        failed += _run_tool(bundle, "scan", [str(doc)]) != 0
    return 1 if failed else 0


# ------------------------------------------------------------------- watch


def _watch_docs(path: Path) -> tuple[list[Path], bool]:
    """Docs to watch for a file-or-folder target: ([files], is_folder)."""
    if path.is_file():
        return [path], False
    if path.is_dir():
        docs = _walk_docs(path)
        if not docs:
            raise SystemExit(f"no .md files under {path} (watch a specific file, or cd into your notes)")
        return docs, True
    raise SystemExit(f"path not found: {path}")


def _signature(path: Path) -> tuple[int, int] | None:
    try:
        stat = path.stat()
    except OSError:
        return None
    return (stat.st_mtime_ns, stat.st_size)


def _scan_state(bundle: Path, doc: Path) -> tuple[dict, dict] | None:
    """Run the bundle scanner once; -> (counts, {elevation_id: finding}) or None."""
    tool = bundle / "tools" / "scan.py"
    if not tool.is_file():
        raise SystemExit(f"this bundle ships no scanner: {bundle}")
    out = subprocess.run(
        [sys.executable, str(tool), str(doc), "--json"],
        cwd=str(bundle), capture_output=True, text=True,
    )
    try:
        payload = jsonlib.loads(out.stdout)
    except jsonlib.JSONDecodeError:
        return None
    counts = payload.get("counts") or {}
    state = {
        f["elevation_id"]: f
        for f in payload.get("findings") or []
        if isinstance(f, dict) and f.get("elevation_id")
    }
    return counts, state


def _diff_states(prev: dict, curr: dict) -> tuple[list, list, list]:
    added = [curr[key] for key in curr.keys() - prev.keys()]
    removed = [prev[key] for key in prev.keys() - curr.keys()]
    changed = [
        curr[key]
        for key in curr.keys() & prev.keys()
        if curr[key].get("status") != prev[key].get("status")
    ]
    return added, changed, removed


def _counts_line(counts: dict) -> str:
    return ", ".join(f"{counts.get(key, 0)} {key}" for key in ("documented", "partial", "topic_only", "absence"))


def cmd_watch(args: argparse.Namespace) -> int:
    """`enano watch`: re-scan on every save and print only what moved."""
    bundle = _require_bundle(store.default_model())
    root = (Path(args.path).expanduser() if args.path else Path.cwd()).resolve()
    docs, is_folder = _watch_docs(root)

    def shown(doc: Path) -> str:
        return str(doc.relative_to(root)) if is_folder else str(doc)

    if args.json:
        print(jsonlib.dumps({"event": "start", "model": bundle.name, "files": [shown(d) for d in docs]}), flush=True)
    else:
        label = f"{len(docs)} markdown file(s) under {root}" if is_folder else str(docs[0])
        print(f"watching {label} with {bundle.name} (Ctrl-C to stop)", flush=True)

    states: dict[Path, dict] = {}
    sigs = {doc: _signature(doc) for doc in docs}

    def scan_doc(doc: Path) -> bool:
        first = doc not in states
        name = shown(doc)
        result = _scan_state(bundle, doc)
        if result is None:
            message = "scan failed (scanner exited without JSON)"
            if args.json:
                print(jsonlib.dumps({"event": "error", "file": name, "message": message}), flush=True)
            else:
                print(f"! {name}: {message}", flush=True)
            return False
        counts, state = result
        prev = states.get(doc, {})
        added, changed, removed = _diff_states(prev, state) if not first else ([], [], [])
        states[doc] = state
        if args.json:
            event = {"event": "scan", "file": name, "first": first, "counts": counts,
                     "added": added, "changed": changed, "removed": removed}
            if first:
                event["findings"] = list(state.values())
            print(jsonlib.dumps(event, ensure_ascii=False), flush=True)
            return True
        print(f"-> {name}  ({_counts_line(counts)})", flush=True)
        for finding in added:
            print(f"  + {str(finding.get('status', '?')).upper():<10} [{finding.get('elevator', '?')}] {finding.get('title', '')}", flush=True)
        for finding in changed:
            old = prev[finding["elevation_id"]].get("status", "?")
            new = finding.get("status", "?")
            print(f"  ~ {old}->{new} [{finding.get('elevator', '?')}] {finding.get('title', '')}", flush=True)
        for finding in removed:
            print(f"  - lost {str(finding.get('status', '?')).upper():<10} [{finding.get('elevator', '?')}] {finding.get('title', '')}", flush=True)
        return True

    failed = sum(not scan_doc(doc) for doc in docs)
    if args.once:
        return 1 if failed else 0

    pending: set = set()
    last_change = 0.0
    try:
        while True:
            time.sleep(args.interval)
            if is_folder:
                current = set(_walk_docs(root))
                for doc in sorted(current - set(sigs)):
                    sigs[doc] = _signature(doc)
                    states.pop(doc, None)
                    pending.add(doc)
                    last_change = time.monotonic()
                    if args.json:
                        print(jsonlib.dumps({"event": "new", "file": shown(doc)}), flush=True)
                    else:
                        print(f"+ new file: {shown(doc)}", flush=True)
                for doc in sorted(set(sigs) - current):
                    del sigs[doc]
                    states.pop(doc, None)
                    pending.discard(doc)
                    if args.json:
                        print(jsonlib.dumps({"event": "gone", "file": shown(doc)}), flush=True)
                    else:
                        print(f"- gone: {shown(doc)}", flush=True)
            for doc, sig in list(sigs.items()):
                fresh = _signature(doc)
                if fresh != sig:
                    sigs[doc] = fresh
                    pending.add(doc)
                    last_change = time.monotonic()
            if pending and time.monotonic() - last_change >= args.debounce:
                for doc in sorted(pending):
                    scan_doc(doc)
                pending.clear()
    except KeyboardInterrupt:
        if not args.json:
            print("\nstopped", flush=True)
        return 0


def cmd_elevators(args: argparse.Namespace) -> int:
    bundle = _require_bundle(store.default_model())
    forward = list(args.forward)
    if args.json:
        forward.append("--json")
    return _run_tool(bundle, "elevators", forward)


def cmd_elevations(args: argparse.Namespace) -> int:
    bundle = _require_bundle(store.default_model())
    forward = list(args.forward)
    if args.query and not any(a in forward for a in ("--search", "--id", "--elevator")):
        forward = ["--search", args.query, *forward]
    if args.json:
        forward.append("--json")
    return _run_tool(bundle, "elevations", forward)


def cmd_doctor(args: argparse.Namespace) -> int:
    checks = []

    def line(label: str, detail: str, good: bool) -> None:
        checks.append({"check": label, "detail": detail, "ok": good})

    import importlib.util

    line("python", sys.version.split()[0], sys.version_info >= (3, 9))
    root = store.store_root()
    try:
        root.mkdir(parents=True, exist_ok=True)
        probe = root / ".write-test"
        probe.write_text("x")
        probe.unlink()
        line("store", str(root), True)
    except OSError as exc:
        line("store", f"{root}: {exc}", False)
    line("disk free", f"{shutil.disk_usage(root).free / 1e9:.1f} GB", shutil.disk_usage(root).free > 500e6)
    try:
        registry = reg.fetch_registry(refresh=True)
        line("registry", f"{len(reg.registry_models(registry))} model(s) indexed", True)
    except SystemExit as exc:
        line("registry", str(exc), False)
    line("default model", store.default_model(), True)
    runtime_path = store.resolve_runtime()
    line("runtime", str(runtime_path) if runtime_path else "absent (engine assets pull with the first model)", True)
    line("onnxruntime", "installed (semantic on)" if importlib.util.find_spec("onnxruntime") else "absent (regex-only fallback)", True)
    for m in store.local_models():
        doc = m.version_doc
        line(
            f"{m.model}@{m.version}",
            f"verified manifest, runnable={m.runnable}" if doc else "VERSION.json unreadable",
            bool(doc),
        )
    ok = all(c["ok"] for c in checks)
    if args.json:
        print(jsonlib.dumps({"ok": ok, "checks": checks}, indent=2))
    else:
        for c in checks:
            print(f"  [{'ok' if c['ok'] else 'FAIL'}] {c['check']:<20} {c['detail']}")
        print("doctor:", "healthy" if ok else "problems found")
    return 0 if ok else 1


# ------------------------------------------------------------------- parser


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="enano",
        description="Elevation models on your machine: pull versioned bundles, scan documents deterministically.",
    )
    parser.add_argument("--version", action="version", version=f"enano {__version__}")
    parser.add_argument("--no-color", action="store_true", help=argparse.SUPPRESS)
    sub = parser.add_subparsers(dest="command", metavar="<command>")

    p = sub.add_parser("pull", help="download and install a model bundle")
    p.add_argument("selectors", nargs="*", help="model[@version] … or 'all' (default version: latest)")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_pull)

    p = sub.add_parser("import", help="install bundles from a local pipeline build (no download)")
    p.add_argument("path", help="a .ena.zip file, a dated build folder, or the ena-zips root (newest build wins)")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_import)

    p = sub.add_parser("list", help="list registry models (what you can pull)")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_list)

    p = sub.add_parser("search", help="search registry models by name, description, or kind")
    p.add_argument("query", nargs="+", help="search term(s)")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_search)

    p = sub.add_parser("models", help="list installed models")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_models)

    p = sub.add_parser("update", help="check for newer versions of local models")
    p.add_argument("model", nargs="?", help="limit to one model")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_update)

    p = sub.add_parser("upgrade", help="fetch newer versions and re-point latest")
    p.add_argument("model", nargs="?", help="limit to one model")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_upgrade)

    p = sub.add_parser("use", help="show or set the default model")
    p.add_argument("model", nargs="?", help="model name (omit to just show)")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_use)

    p = sub.add_parser("info", help="manifest + counts + path for an installed model")
    p.add_argument("model", help="model[@version]")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_info)

    p = sub.add_parser("rm", help="remove an installed version")
    p.add_argument("model", help="model[@version]")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_rm)

    p = sub.add_parser("prune", help="remove non-latest local versions ('all': empty the store)")
    p.add_argument("target", nargs="?", help="'all' to remove everything")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_prune)

    p = sub.add_parser("verify", help="verify bundle checksums against VERSION.json")
    p.add_argument("model", nargs="?", help="model[@version]; omit to verify everything local")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_verify)

    p = sub.add_parser("scan", help="scan a document with the default model (enano use switches it); no file: every .md in the current folder")
    p.add_argument("--json", action="store_true")
    p.add_argument("forward", nargs=argparse.REMAINDER, help=argparse.SUPPRESS)
    p.set_defaults(func=cmd_scan)

    p = sub.add_parser("walk", help="scan every .md under a folder, recursively")
    p.add_argument("directory", nargs="?", help="folder to walk (default: the current one)")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_walk)

    p = sub.add_parser("watch", help="watch a file or folder and re-scan on every change, printing only what moved")
    p.add_argument("path", nargs="?", help="file or folder to watch (default: the current folder)")
    p.add_argument("--interval", type=float, default=0.25, help="poll interval in seconds (default: 0.25)")
    p.add_argument("--debounce", type=float, default=0.5, help="seconds of quiet before a changed file is re-scanned (default: 0.5)")
    p.add_argument("--once", action="store_true", help="scan every watched file once, then exit (no watching)")
    p.add_argument("--json", action="store_true", help="emit JSONL events instead of human output")
    p.set_defaults(func=cmd_watch)

    p = sub.add_parser("elevators", help="list the default model's source works (enano use switches it)")
    p.add_argument("--json", action="store_true")
    p.add_argument("forward", nargs=argparse.REMAINDER, help=argparse.SUPPRESS)
    p.set_defaults(func=cmd_elevators)

    p = sub.add_parser("elevations", help="search the default model's rule corpus (enano use switches it)")
    p.add_argument("query", nargs="?", help="search text (positional)")
    p.add_argument("--json", action="store_true")
    p.add_argument("forward", nargs=argparse.REMAINDER, help=argparse.SUPPRESS)
    p.set_defaults(func=cmd_elevations)

    p = sub.add_parser("doctor", help="environment + store diagnostics")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_doctor)

    p = sub.add_parser("web", help="serve the local web app (localhost API + GUI) and open it in a browser")
    p.add_argument("--port", type=int, default=web.DEFAULT_PORT, help="port to serve on (0 picks a free one)")
    p.add_argument("--no-open", action="store_true", help="start the server without opening a browser")
    p.add_argument("--dir", default=None, help="serve a web app build from this folder (default: the store's web bundle)")
    p.add_argument("--json", action="store_true", help="print the server info as JSON, then serve")
    p.set_defaults(func=cmd_web)

    p = sub.add_parser("help", help="show help (for one command: enano help scan)")
    p.add_argument("topic", nargs="?", help="command name (default: top-level help)")
    p.set_defaults(func=cmd_help)

    # elevators/elevations stay registered + dispatchable but never appear in help
    for hidden in ("elevators", "elevations"):
        sub._choices_actions = [a for a in sub._choices_actions if a.dest != hidden]

    return parser


def cmd_web(args: argparse.Namespace) -> int:
    """`enano web`: localhost backend (JSON API + GUI), browser front end."""
    return web.serve(port=args.port, open_browser=not args.no_open, json_mode=args.json, web_dir=args.dir)


def cmd_help(args: argparse.Namespace) -> int:
    parser = build_parser()
    if not args.topic:
        parser.print_help()
        return 0
    subaction = next((a for a in parser._actions if isinstance(a, argparse._SubParsersAction)), None)
    target = subaction.choices.get(args.topic) if subaction else None
    if target is None:
        raise SystemExit(f"unknown command {args.topic!r} — try: enano help")
    target.print_help()
    return 0


def cmd_bare() -> int:
    """Bare `enano`: show the shortest path to a first scan. Nothing ever
    downloads here — `enano pull` is the only command that fetches models."""
    model = store.default_model()
    path = store.resolve_version(model, None)
    if path:
        print(f"ready: {model} is installed ({path.name})")
    else:
        print(f"nothing installed yet — start with: enano pull {model}")
    print()
    print("  enano pull <model>        install a model (enano list shows what exists)")
    print("  enano scan notes.md      scan one document")
    print("  enano scan                scan every .md in the current folder")
    print("  enano walk                scan every .md in every subfolder")
    print("  enano web                 the same models in your browser")
    print(f"  enano use <model>         switch the default (now: {model})")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "command", None):
        return cmd_bare()
    forward = getattr(args, "forward", None)
    if forward and forward[:1] == ["--"]:
        args.forward = forward[1:]
    return args.func(args) or 0


if __name__ == "__main__":
    raise SystemExit(main())
