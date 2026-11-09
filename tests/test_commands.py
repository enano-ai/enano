"""Tests for every subcommand: pull/list/models/use/info/rm/prune/verify/
scan/walk/elevators/elevations/update/upgrade/doctor."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from enano import cli, store


def out_json(capsys):
    return json.loads(capsys.readouterr().out)


@pytest.fixture
def tool_calls(monkeypatch, tmp_path, store_home):
    """Patch bundle resolution + tool execution; record what gets forwarded."""
    calls = []
    monkeypatch.setattr(cli, "_require_bundle", lambda selector, auto_pull, quiet=False: tmp_path / "bundle")
    monkeypatch.setattr(cli, "_run_tool", lambda bundle, tool, forward: calls.append((tool, list(forward))) or 0)
    return calls


# --------------------------------------------------------------------- pull


def test_pull_installs_bundle(store_home, registry, downloads, capsys):
    assert cli.main(["pull", "personal-goals"]) == 0
    assert "installed personal-goals@2026-01-01" in capsys.readouterr().out
    assert store.resolve_version("personal-goals", "2026-01-01") is not None


def test_pull_specific_version(store_home, registry, downloads):
    assert cli.main(["pull", "personal-goals@2025-06-01"]) == 0
    assert store.resolve_version("personal-goals", "2025-06-01") is not None


def test_pull_already_installed_reports_status(store_home, registry, downloads, capsys):
    cli.main(["pull", "personal-goals", "--json"])
    capsys.readouterr()
    assert cli.main(["pull", "personal-goals", "--json"]) == 0
    assert out_json(capsys) == [
        {"model": "personal-goals", "version": "2026-01-01", "status": "already-installed"}
    ]


def test_pull_all_installs_every_registry_model(store_home, registry, downloads):
    assert cli.main(["pull", "all", "--json"]) == 0
    for model in ("career-advice", "personal-goals"):
        assert store.resolve_version(model, None) is not None


def test_pull_without_selector_fails():
    with pytest.raises(SystemExit, match="nothing to pull"):
        cli.main(["pull"])


def test_pull_unknown_model_fails(store_home, registry, downloads):
    with pytest.raises(SystemExit, match="unknown model 'ghost'"):
        cli.main(["pull", "ghost"])


# --------------------------------------------------------------------- list


def test_list_json_states(store_home, registry, bundle_factory, capsys):
    bundle_factory(model="career-advice", version="2026-02-02")
    bundle_factory(version="2025-06-01")
    assert cli.main(["list", "--json"]) == 0
    rows = out_json(capsys)
    by_model = {r["model"]: r for r in rows}
    assert by_model["career-advice"]["state"] == "installed"
    assert by_model["personal-goals"]["state"] == "update (2025-06-01)"


def test_list_json_fresh_store(store_home, registry, capsys):
    assert cli.main(["list", "--json"]) == 0
    rows = out_json(capsys)
    assert [r["model"] for r in rows] == ["career-advice", "personal-goals"]
    assert all(r["state"] == "-" for r in rows)
    assert rows[1]["version"] == "2026-01-01"


def test_list_human_prints_header(store_home, registry, capsys):
    assert cli.main(["list"]) == 0
    assert capsys.readouterr().out.startswith("NAME")


# ------------------------------------------------------------------- models


def test_models_empty_store(store_home, capsys):
    assert cli.main(["models"]) == 0
    assert "nothing installed" in capsys.readouterr().out


def test_models_json(store_home, bundle_factory, capsys):
    bundle_factory(version="2025-06-01")
    bundle_factory(version="2026-01-01")
    assert cli.main(["models", "--json"]) == 0
    rows = out_json(capsys)
    names = {r["name"]: r["state"] for r in rows}
    assert names == {
        "personal-goals@2025-06-01": "old",
        "personal-goals@2026-01-01": "latest",
    }
    assert all("pulled" in r for r in rows)


# ---------------------------------------------------------------------- use


def test_use_shows_default(store_home, registry, capsys):
    assert cli.main(["use"]) == 0
    assert "default model: personal-goals" in capsys.readouterr().out


def test_use_switches_default(store_home, registry, capsys):
    assert cli.main(["use", "career-advice"]) == 0
    assert "default model: career-advice" in capsys.readouterr().out
    assert store.default_model() == "career-advice"


def test_use_json(store_home, registry, capsys):
    assert cli.main(["use", "--json"]) == 0
    assert out_json(capsys) == {"default_model": "personal-goals"}


def test_use_unknown_model_fails(store_home, registry):
    with pytest.raises(SystemExit, match="unknown model 'ghost'"):
        cli.main(["use", "ghost"])


# --------------------------------------------------------------------- info


def test_info_json(store_home, bundle_factory, capsys):
    bundle_factory()
    assert cli.main(["info", "personal-goals", "--json"]) == 0
    info = out_json(capsys)
    assert info["model"] == "personal-goals"
    assert info["version"] == "2026-01-01"
    assert info["runnable"] is True
    assert info["counts"] == {"rules": 4, "detectors": 2}


def test_info_without_tools_not_runnable(store_home, bundle_factory, capsys):
    bundle_factory(tools=False)
    assert cli.main(["info", "personal-goals", "--json"]) == 0
    assert out_json(capsys)["runnable"] is False


def test_info_not_installed_fails(store_home, registry):
    with pytest.raises(SystemExit, match="is not installed"):
        cli.main(["info", "personal-goals"])


# ----------------------------------------------------------------------- rm


def test_rm_removes_non_latest_version(store_home, bundle_factory, capsys):
    bundle_factory(version="2025-06-01")
    bundle_factory(version="2026-01-01")
    assert cli.main(["rm", "personal-goals@2025-06-01"]) == 0
    assert "removed personal-goals@2025-06-01" in capsys.readouterr().out
    assert store.resolve_version("personal-goals", "2025-06-01") is None
    assert store.resolve_version("personal-goals", "2026-01-01") is not None


def test_rm_latest_version_needs_tty_confirmation(store_home, bundle_factory):
    bundle_factory()
    with pytest.raises(SystemExit, match="refusing to remove"):
        cli.main(["rm", "personal-goals"])


def test_rm_latest_version_with_tty_confirmation(store_home, bundle_factory, tty, capsys):
    bundle_factory()
    assert cli.main(["rm", "personal-goals", "--json"]) == 0
    assert out_json(capsys) == {"removed": "personal-goals@2026-01-01"}
    assert store.resolve_version("personal-goals", "2026-01-01") is None


def test_rm_declined_confirmation_exits_2(store_home, bundle_factory, tty, monkeypatch):
    bundle_factory()
    monkeypatch.setattr("builtins.input", lambda prompt="": "n")
    with pytest.raises(SystemExit) as exc:
        cli.main(["rm", "personal-goals"])
    assert exc.value.code == 2
    assert store.resolve_version("personal-goals", "2026-01-01") is not None


def test_rm_ambiguous_version_fails(store_home, bundle_factory):
    bundle_factory(version="2025-06-01")
    bundle_factory(version="2026-01-01")
    with pytest.raises(SystemExit, match="multiple versions installed"):
        cli.main(["rm", "personal-goals"])


def test_rm_not_installed_fails(store_home):
    with pytest.raises(SystemExit, match="refusing to remove"):
        cli.main(["rm", "personal-goals"])


# -------------------------------------------------------------------- prune


def test_prune_removes_only_non_latest(store_home, bundle_factory, capsys):
    bundle_factory(version="2025-06-01")
    bundle_factory(version="2026-01-01")
    assert cli.main(["prune"]) == 0
    assert "removed personal-goals@2025-06-01" in capsys.readouterr().out
    assert store.resolve_version("personal-goals", "2026-01-01") is not None


def test_prune_all_empties_store(store_home, bundle_factory, capsys):
    bundle_factory()
    assert cli.main(["prune", "all", "--json"]) == 0
    assert out_json(capsys) == {"removed": ["personal-goals@2026-01-01"], "store_emptied": True}
    assert not store.models_root().exists()


def test_prune_nothing_to_do(store_home, capsys):
    assert cli.main(["prune"]) == 0
    assert "nothing to prune" in capsys.readouterr().out


# ------------------------------------------------------------------- verify


def test_verify_ok(store_home, bundle_factory, capsys):
    bundle_factory()
    assert cli.main(["verify"]) == 0
    assert "[ok] personal-goals@2026-01-01" in capsys.readouterr().out


def test_verify_failure_exits_1(store_home, bundle_factory, capsys):
    bundle_factory(verify_exit=3)
    assert cli.main(["verify", "--json"]) == 1
    report = out_json(capsys)
    assert report["ok"] is False
    assert report["results"][0]["output"] == "broken"


def test_verify_bundle_without_tool_marks_na(store_home, bundle_factory, capsys):
    bundle_factory(tools=False)
    assert cli.main(["verify", "--json"]) == 1
    report = out_json(capsys)
    assert report["results"][0]["ok"] is None
    assert report["results"][0]["note"] == "no verify tool in bundle"


def test_verify_uninstalled_model_exits_2(store_home, registry):
    with pytest.raises(SystemExit) as exc:
        cli.main(["verify", "personal-goals"])
    assert exc.value.code == 2


# --------------------------------------------------------------------- scan


def test_scan_forwards_file_args(tool_calls, store_home):
    assert cli.main(["scan", "notes.md", "--extra"]) == 0
    assert tool_calls == [("scan", ["notes.md", "--extra"])]


def test_scan_json_flag_reaches_tool(tool_calls, store_home):
    assert cli.main(["scan", "--json", "notes.md"]) == 0
    assert tool_calls == [("scan", ["notes.md", "--json"])]


def test_scan_existing_relative_file_is_absolutized(tool_calls, store_home, tmp_path, monkeypatch):
    (tmp_path / "notes.md").write_text("x")
    monkeypatch.chdir(tmp_path)
    assert cli.main(["scan", "notes.md", "--status", "partial"]) == 0
    assert tool_calls == [
        ("scan", [str(tmp_path / "notes.md"), "--status", "partial"])
    ]


def test_scan_piped_stdin_forwards_dash(tool_calls, store_home):
    assert cli.main(["scan", "--json"]) == 0
    assert tool_calls == [("scan", ["-", "--json"])]


def test_scan_folder_mode_scans_every_md(tool_calls, store_home, tty, tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "a.md").write_text("a")
    (tmp_path / "b.md").write_text("b")
    assert cli.main(["scan"]) == 0
    assert sorted(Path(call[1][0]).name for call in tool_calls) == ["a.md", "b.md"]
    out = capsys.readouterr().out
    assert "scanning 2 markdown file(s)" in out
    assert "===== a.md =====" in out


def test_scan_folder_mode_without_md_files_fails(tool_calls, store_home, tty, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    with pytest.raises(SystemExit, match="no .md files"):
        cli.main(["scan"])


def test_scan_failure_propagates_exit_1(monkeypatch, tmp_path, store_home, tty):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "a.md").write_text("a")
    monkeypatch.setattr(cli, "_require_bundle", lambda selector, auto_pull, quiet=False: tmp_path / "bundle")
    monkeypatch.setattr(cli, "_run_tool", lambda bundle, tool, forward: 1)
    assert cli.main(["scan"]) == 1


def test_scan_auto_pulls_default_model(store_home, registry, downloads, capfd):
    assert cli.main(["scan", "--json"]) == 0
    assert store.resolve_version("personal-goals", None) is not None
    lines = capfd.readouterr().out.strip().splitlines()
    assert "installed personal-goals@2026-01-01" in lines[0]
    assert json.loads(lines[-1])["scanned"] == ["-"]


# ------------------------------------------------------------------ runtime


def test_pull_runtime_installs_shared_layer(store_home, registry, downloads, capsys):
    assert cli.main(["pull", "runtime"]) == 0
    out = capsys.readouterr().out
    assert "installed runtime@2026-03-03" in out
    assert store.resolve_runtime() is not None
    assert (store.resolve_runtime() / "manifest.json").is_file()


def test_pull_runtime_again_reports_already_installed(store_home, registry, downloads, capsys):
    cli.main(["pull", "runtime"])
    capsys.readouterr()
    assert cli.main(["pull", "runtime", "--json"]) == 0
    assert json.loads(capsys.readouterr().out) == [
        {"model": "runtime", "version": "2026-03-03", "status": "already-installed"}
    ]


def test_pull_model_auto_installs_runtime(store_home, registry, downloads, capfd):
    assert cli.main(["pull", "personal-goals", "--json"]) == 0
    assert store.resolve_version("personal-goals", None) is not None
    assert store.resolve_runtime() is not None
    assert (store.resolve_runtime() / "manifest.json").is_file()


def test_models_lists_runtime_row(store_home, registry, downloads, capsys):
    cli.main(["pull", "personal-goals", "--json"])
    capsys.readouterr()
    assert cli.main(["models", "--json"]) == 0
    rows = json.loads(capsys.readouterr().out)
    runtime_rows = [row for row in rows if row["name"].startswith("runtime@")]
    assert len(runtime_rows) == 1
    assert runtime_rows[0]["state"] == "shared engine assets"


def test_upgrade_updates_runtime(store_home, registry, downloads, capsys):
    import shutil as _shutil

    from enano import store as store_mod

    cli.main(["pull", "runtime", "--json"])
    capsys.readouterr()
    _shutil.rmtree(store_mod.runtime_root())
    old = store_mod.runtime_root() / "2025-01-01"
    old.mkdir(parents=True)
    (old / "manifest.json").write_text("{}")
    store_mod.write_runtime_latest("2025-01-01")
    assert cli.main(["upgrade", "--json"]) == 0
    rows = json.loads(capsys.readouterr().out)
    runtime_rows = [row for row in rows if row["model"] == "runtime"]
    assert runtime_rows and runtime_rows[0]["status"] == "update-available"
    assert store_mod.read_runtime_latest() == "2026-03-03"


# ------------------------------------------------------------------- watch


WATCH_TOOL = (
    "import json, sys\n"
    "from pathlib import Path\n"
    "text = Path(sys.argv[1]).read_text().lower()\n"
    "findings = []\n"
    "if 'spanish' in text:\n"
    "    findings.append({'elevation_id': 'e1', 'elevator': 'aurelius_meditations',\n"
    "                     'title': 'Study a little every day', 'status': 'documented'})\n"
    "if '10k' in text:\n"
    "    findings.append({'elevation_id': 'e2', 'elevator': 'wattles',\n"
    "                     'title': 'Act on a realistic scale', 'status': 'partial'})\n"
    "counts = {s: 0 for s in ('documented', 'partial', 'topic_only', 'absence', 'none')}\n"
    "for f in findings:\n"
    "    counts[f['status']] += 1\n"
    "print(json.dumps({'document': sys.argv[1], 'counts': counts, 'findings': findings}))\n"
)


@pytest.fixture
def watch_bundle(bundle_factory):
    root = bundle_factory()
    (root / "tools" / "scan.py").write_text(WATCH_TOOL)
    return root


def test_watch_once_json_events(watch_bundle, tmp_path, capsys):
    (tmp_path / "notes.md").write_text("learn spanish this year\n")
    (tmp_path / "other.md").write_text("nothing relevant\n")
    assert cli.main(["watch", "--once", "--json", str(tmp_path)]) == 0
    events = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert events[0]["event"] == "start"
    assert sorted(events[0]["files"]) == ["notes.md", "other.md"]
    scans = {event["file"]: event for event in events if event["event"] == "scan"}
    assert scans["notes.md"]["first"] is True
    assert scans["notes.md"]["counts"]["documented"] == 1
    assert scans["notes.md"]["findings"][0]["elevation_id"] == "e1"
    assert scans["other.md"]["counts"]["documented"] == 0


def test_watch_once_human_output(watch_bundle, tmp_path, capsys):
    (tmp_path / "notes.md").write_text("learn spanish\n")
    assert cli.main(["watch", "--once", str(tmp_path)]) == 0
    out = capsys.readouterr().out
    assert "watching 1 markdown file(s) under" in out
    assert "-> notes.md" in out
    assert "1 documented" in out


def test_watch_state_diff_detects_removal(watch_bundle, tmp_path):
    doc = tmp_path / "notes.md"
    doc.write_text("learn spanish\nrun the 10k\n")
    _, first = cli._scan_state(watch_bundle, doc)
    assert set(first) == {"e1", "e2"}
    doc.write_text("learn spanish only now\n")
    _, second = cli._scan_state(watch_bundle, doc)
    added, changed, removed = cli._diff_states(first, second)
    assert added == [] and changed == []
    assert [finding["elevation_id"] for finding in removed] == ["e2"]


def test_diff_states_marks_status_changes():
    prev = {"e1": {"elevation_id": "e1", "status": "partial"}}
    curr = {"e1": {"elevation_id": "e1", "status": "documented"}}
    added, changed, removed = cli._diff_states(prev, curr)
    assert added == [] and removed == []
    assert changed[0]["status"] == "documented"


def test_watch_missing_path_fails(watch_bundle):
    with pytest.raises(SystemExit, match="path not found"):
        cli.main(["watch", "--once", "/definitely/not/here.md"])


def test_watch_folder_without_md_fails(watch_bundle, tmp_path):
    with pytest.raises(SystemExit, match="no .md files"):
        cli.main(["watch", "--once", str(tmp_path)])


def test_watch_scan_failure_is_an_error_event(bundle_factory, tmp_path, capsys):
    bundle_factory(scan_exit=3)
    (tmp_path / "notes.md").write_text("x")
    assert cli.main(["watch", "--once", "--json", str(tmp_path)]) == 1
    events = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert events[-1]["event"] == "error"


# --------------------------------------------------------------------- walk


def test_walk_json_skips_hidden_and_vendor_dirs(store_home, bundle_factory, tmp_path, capsys):
    bundle_factory()
    (tmp_path / "a.md").write_text("a")
    (tmp_path / "sub").mkdir()
    (tmp_path / "sub" / "b.md").write_text("b")
    for skip in (".hidden", "node_modules", "__pycache__", ".venv"):
        d = tmp_path / skip
        d.mkdir()
        (d / "skip.md").write_text("skip")
    assert cli.main(["walk", str(tmp_path), "--json"]) == 0
    report = out_json(capsys)
    assert report["files"] == 2
    assert [r["path"] for r in report["results"]] == ["a.md", "sub/b.md"]
    assert report["failed"] == 0


def test_walk_human_prints_headers(store_home, bundle_factory, tmp_path, capsys):
    bundle_factory()
    (tmp_path / "a.md").write_text("a")
    assert cli.main(["walk", str(tmp_path)]) == 0
    out = capsys.readouterr().out
    assert "walking 1 markdown file(s)" in out
    assert "===== a.md =====" in out


def test_walk_failing_tool_exits_1(store_home, bundle_factory, tmp_path, capsys):
    bundle_factory(scan_exit=1)
    (tmp_path / "a.md").write_text("a")
    assert cli.main(["walk", str(tmp_path), "--json"]) == 1
    assert out_json(capsys)["failed"] == 1


def test_walk_not_a_directory_fails(store_home, bundle_factory, tmp_path):
    bundle_factory()
    with pytest.raises(SystemExit, match="not a directory"):
        cli.main(["walk", str(tmp_path / "missing")])


def test_walk_bundle_without_scanner_fails(store_home, bundle_factory):
    bundle_factory(tools=False)
    with pytest.raises(SystemExit, match="no scanner"):
        cli.main(["walk"])


# ------------------------------------------------------- elevators/elevations


def test_elevators_forwards(tool_calls, store_home):
    assert cli.main(["elevators"]) == 0
    assert tool_calls == [("elevators", [])]


def test_elevators_json_forwards(tool_calls, store_home):
    assert cli.main(["elevators", "--json"]) == 0
    assert tool_calls == [("elevators", ["--json"])]


def test_elevations_positional_becomes_search(tool_calls, store_home):
    assert cli.main(["elevations", "fear of failure"]) == 0
    assert tool_calls == [("elevations", ["--search", "fear of failure"])]


def test_elevations_query_and_json(tool_calls, store_home):
    assert cli.main(["elevations", "fear of failure", "--json"]) == 0
    assert tool_calls == [("elevations", ["--search", "fear of failure", "--json"])]


def test_elevations_existing_flag_prevents_search_injection(tool_calls, store_home):
    assert cli.main(["elevations", "fear of failure", "--id", "7"]) == 0
    assert tool_calls == [("elevations", ["--id", "7"])]


# ------------------------------------------------------------ update/upgrade


def test_update_up_to_date(store_home, registry, bundle_factory, capsys):
    bundle_factory(version="2026-01-01")
    assert cli.main(["update", "--json"]) == 0
    rows = out_json(capsys)
    assert rows[0]["status"] == "up-to-date"
    assert rows[0]["current"] == rows[0]["latest"] == "2026-01-01"


def test_update_available(store_home, registry, bundle_factory, capsys):
    bundle_factory(version="2025-06-01")
    assert cli.main(["update"]) == 0
    assert "2025-06-01 -> 2026-01-01" in capsys.readouterr().out
    assert store.resolve_version("personal-goals", "2026-01-01") is None


def test_update_model_not_in_registry(store_home, registry, bundle_factory, capsys):
    bundle_factory(model="ghost-model")
    assert cli.main(["update", "--json"]) == 0
    rows = out_json(capsys)
    assert {"model": "ghost-model", "status": "not-in-registry"} in rows
    assert {"model": "runtime", "current": None, "latest": "2026-03-03", "status": "update-available"} in rows


def test_upgrade_fetches_newer_bundle(store_home, registry, downloads, bundle_factory, capsys):
    bundle_factory(version="2025-06-01")
    assert cli.main(["upgrade", "--json"]) == 0
    rows = out_json(capsys)
    assert rows[0] == {
        "model": "personal-goals",
        "current": "2025-06-01",
        "latest": "2026-01-01",
        "status": "update-available",
    }
    assert store.read_latest("personal-goals") == "2026-01-01"
    assert store.resolve_version("personal-goals", "2025-06-01") is not None


# ------------------------------------------------------------------- doctor


def test_doctor_healthy(store_home, registry, capsys):
    assert cli.main(["doctor", "--json"]) == 0
    report = out_json(capsys)
    assert report["ok"] is True
    labels = {c["check"] for c in report["checks"]}
    assert {"python", "store", "registry", "default model"} <= labels


def test_doctor_registry_down_exits_1(store_home, monkeypatch, capsys):
    from enano import registry as reg

    def unreachable(refresh=False, cache_path=None):
        raise SystemExit("registry fetch failed: offline")

    monkeypatch.setattr(reg, "fetch_registry", unreachable)
    assert cli.main(["doctor", "--json"]) == 1
    report = out_json(capsys)
    assert report["ok"] is False
    assert any("offline" in c["detail"] for c in report["checks"])
