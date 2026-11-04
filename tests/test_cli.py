"""Tests for the CLI surface: parser, helpers, dispatch, bare onboarding, help."""

from __future__ import annotations

import argparse

import pytest

from enano import cli, store


ALL_COMMANDS = {
    "pull", "list", "models", "update", "upgrade", "use", "info",
    "rm", "prune", "verify", "scan", "walk", "elevators", "elevations",
    "doctor", "web", "help",
}


def _subcommands(parser):
    action = next(a for a in parser._actions if isinstance(a, argparse._SubParsersAction))
    return action.choices


# ------------------------------------------------------------------ parser


def test_prog_is_enano():
    assert cli.build_parser().prog == "enano"


def test_every_command_registered():
    assert set(_subcommands(cli.build_parser())) == ALL_COMMANDS


def test_every_command_takes_json():
    for name, subparser in _subcommands(cli.build_parser()).items():
        if name == "help":
            continue
        opts = [opt for action in subparser._actions for opt in action.option_strings]
        assert "--json" in opts, name


# ----------------------------------------------------------------- helpers


@pytest.mark.parametrize(
    "selector,expected",
    [
        ("model", ("model", None)),
        ("model@1.2", ("model", "1.2")),
        (" model @ 1.2 ", ("model", "1.2")),
        ("model@", ("model", None)),
    ],
)
def test_parse_selector(selector, expected):
    assert cli._parse_selector(selector) == expected


@pytest.mark.parametrize(
    "size,expected",
    [
        (0, "0 B"),
        (500, "500 B"),
        (1_500, "1.5 KB"),
        (1_500_000, "1.5 MB"),
        (1_500_000_000, "1.5 GB"),
        (1.5e12, "1.5 TB"),
    ],
)
def test_human_bytes(size, expected):
    assert cli._human_bytes(size) == expected


def test_clip():
    assert cli._clip("short", 10) == "short"
    assert cli._clip("truncated", 6) == "trunc…"
    assert len(cli._clip("x" * 100, 20)) == 20


# ---------------------------------------------------------------- dispatch


def test_version_flag(capsys):
    with pytest.raises(SystemExit) as exc:
        cli.main(["--version"])
    assert exc.value.code == 0
    assert capsys.readouterr().out.startswith("enano ")


def test_unknown_command_exits_2(capsys):
    with pytest.raises(SystemExit) as exc:
        cli.main(["nope"])
    assert exc.value.code == 2


def test_double_dash_stripped_from_forward(monkeypatch, tmp_path, store_home):
    calls = []
    monkeypatch.setattr(cli, "_require_bundle", lambda selector, auto_pull, quiet=False: tmp_path)
    monkeypatch.setattr(cli, "_run_tool", lambda b, t, f: calls.append(list(f)) or 0)
    assert cli.main(["scan", "--", "--raw-flag", "x"]) == 0
    assert calls == [["--raw-flag", "x"]]


# -------------------------------------------------------------------- help


def test_help_prints_usage(capsys):
    assert cli.main(["help"]) == 0
    assert "usage: enano" in capsys.readouterr().out


def test_help_for_one_command(capsys):
    assert cli.main(["help", "pull"]) == 0
    assert "usage: enano pull" in capsys.readouterr().out


def test_help_unknown_topic():
    with pytest.raises(SystemExit, match="unknown command 'bogus'"):
        cli.main(["help", "bogus"])


# ------------------------------------------------------------- bare command


def test_bare_onboarding_pulls_default(store_home, registry, downloads, capsys):
    assert cli.main([]) == 0
    out = capsys.readouterr().out
    assert "ready: personal-goals is installed" in out
    assert "enano scan notes.md" in out
    assert store.resolve_version("personal-goals", None) is not None


def test_bare_with_model_installed_skips_pull(store_home, bundle_factory, capsys):
    bundle_factory()
    assert cli.main([]) == 0
    out = capsys.readouterr().out
    assert "ready:" in out
    assert "pulling" not in out
