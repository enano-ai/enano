# AGENTS.md

## What this repo is (and is not)

This repo is the **enano client**: a stdlib-only Python CLI that pulls, verifies, and manages versioned "model" bundles (advice corpora from books) from a remote registry, plus `enano web`, a localhost GUI backend, plus `webapp/`, the GUI's own React source (vendored; build with `make webapp`). The bundle scan logic ships inside each downloaded bundle at `tools/*.py` and the CLI subprocess-executes those scripts.

The package has zero runtime dependencies. `onnxruntime` is an optional extra (`pip install .[semantic]`) consumed by bundles, never imported by this package.

## Commands

```bash
pip install -e ".[dev]"     # dev install incl. pytest (hatchling backend)
enano <cmd>                 # run via entry point
python -m enano <cmd>       # equivalent, works without install
python -m build             # build sdist/wheel (creates dist/)
pytest                      # run the test suite in tests/
make install                # venv + editable install + pytest
make test                   # pytest via .venv (falls back to python3)
make release [ARGS="…"]     # scripts/release.py: bump + test + build + twine upload
                            # + git tag + homebrew-tap formula update (--dry-run to rehearsal)
make web ARGS="--no-open"   # serve the local web app (ARGS forwards flags)
make <cmd> [ARGS="…"]       # every CLI subcommand is a make shortcut (make list,
                            # make pull ARGS=meditations, make scan DOC=notes.md,
                            # make elevations QUERY="fear of failure") — latest
                            # code through the repo venv, prod registry by default
make webapp                 # npm install + build webapp/ into webapp/dist
make webapp-dev             # vite dev server for the GUI
```

Zed tasks live in `.zed/tasks.json` and just call these make targets.

`webapp/` is the GUI source (React + Vite + TypeScript, self-contained).
Build output `webapp/dist` is gitignored; `enano web` prefers it when present,
then falls back to the store's `web/` copy, then the built-in status page. The
pack-import and upload pipeline scripts were deliberately not vendored.
`webapp/src/endpoints.json` is inert by default (`{}`): the hosted build
injects real backend endpoints there; when empty, remote features (model-zip
downloads, backend packs, prebuilt catalog vectors) soft-fail to inline data
or runtime embedding.

The suite is hermetic: no network (registry fetch/downloads are patched), every
test runs against a throwaway store via the `ENANO_HOME` fixture in
`tests/conftest.py`. Cover new commands with tests in `tests/test_commands.py`
following the existing `cmd_*` patterns. There is no linter or CI workflow.

Set `ENANO_HOME=/tmp/some-dir` to redirect the store during testing so you never touch real user data. `ENANO_REGISTRY` overrides the registry index URL (default is an S3 bucket).

## Architecture

Five modules plus the vendored GUI (`cli` → `registry` + `store` + `web`; `registry` lazily imports `store` inside functions; `web` → `store` + `registry`; `webapp/` builds standalone via npm):

- **`enano/cli.py`** — argparse front end. Each subcommand is a `cmd_*` function registered via `parser.set_defaults(func=...)`; `main()` dispatches with `return args.func(args) or 0`. Bare `enano` (no subcommand) runs onboarding (`cmd_bare`): prints a cheat sheet and never downloads — `enano pull` is the only command that fetches models. `enano import <path>` installs bundles from a local pipeline build with no registry/download: accepts a `.ena.zip` file, a dated build folder, or the pipeline's `output/ena-zips` root (newest dated subfolder wins); model/version come from each zip's `VERSION.json`, sha256/size are verified against the build folder's `registry.json` when present (and that registry is cached into the store so offline `list`/`web` see it).
- **`enano/store.py`** — the local store. Layout under `store_root()`:
  - `models/<model>/<version>/` — extracted bundles (immutable per version)
  - `models/<model>/latest` — symlink to the current version dir; **falls back to a plain text file containing the version string if symlink creation fails** (Windows). `read_latest()` handles both forms — always resolve through it, never assume a symlink.
  - `runtime/<version>/` (+ `runtime/latest`) — the shared runtime layer: engine assets (embedding weights, ORT wasm) served to the GUI by `enano web` under `/runtime/`, pulled once and shared by all models (`resolve_runtime()`, `install_runtime()`). Registry publishes it as a top-level `"runtime"` entry mirroring a model entry's shape; `enano pull <model>` auto-installs it first, `enano pull runtime` manages it alone, and `update`/`upgrade` treat it like a model.
  - `default-model` — text file holding the `use` selection; falls back to hardcoded `"personal-goals"`.
  - `registry.json` — cached registry index; `archives/` — downloaded zips.
  - Store root resolution order: `ENANO_HOME` env → `ETINY_HOME` env → legacy `~/.etiny` if it exists → `~/.enano`.
- **`enano/registry.py`** — fetches the index and streams bundle zips with size + sha256 verification (fail-hard `SystemExit` on mismatch; partial `.part` temp file is unlinked on sha failure).
- **`enano/web.py`** — `enano web`: the GUI backend (Ollama pattern: localhost server + JSON API; the browser is the front end today, a native app could speak the same API later). `ThreadingHTTPServer` bound to **127.0.0.1 only** (the URL shown/opened is `http://localhost:<port>/`). Serves the GUI build under `/enano/` (primary; `/` redirects there) with `/etiny/` kept as a legacy alias because the public build's asset URLs are `/etiny/assets/...`; JSON API lives alongside at `/api/version`, `/api/models`, `/api/registry[?refresh=1]`. The GUI folder is resolved by `resolve_web_root()`: `--dir` flag → `ENANO_WEB_DIR` env → the checkout's `webapp/dist` (so dev serves what the repo builds) → `<store>/web` (a build copied into a user's store). No GUI anywhere → the built-in status page at `/` and everything else 404s. `make_server(port, web_root)` binds (port 0 = kernel-picked), `serve()` runs until Ctrl-C, opens the browser, prints startup info flushed immediately (includes `web_root`). Default port **8599** (fixed, IANA-unassigned, no known tool default; a busy port errors, never silently changes); a future native app can rely on the documented URL. Static serving resolves paths and rejects traversal; handler errors return JSON (404/502/500), never tracebacks; per-request logging is silenced.

### Bundle execution flow

`scan`/`walk`/`elevators`/`elevations` resolve the default (or selected) bundle locally, then `subprocess.call([sys.executable, <bundle>/tools/<tool>.py, ...], cwd=<bundle>)`. Flags are forwarded raw via `nargs=argparse.REMAINDER` (`args.forward`); `main()` strips a leading `--` separator. Not every bundle ships tools — check `tools/scan.py` existence (`LocalModel.runnable`) before assuming a scanner exists. **`elevators`/`elevations` are hidden** (`help=argparse.SUPPRESS`, absent from README) but still registered and functional — power commands kept for compatibility. `search` shares `_catalog_rows`/`_print_catalog` with `list` and filters by slug/description/kind (case-insensitive substring).

`_require_bundle()` is the gatekeeper: resolves locally, and if missing prints a pull hint and exits with code 2. No command outside `pull`/`upgrade` ever downloads a model (and `update`/`upgrade` only pull when the registry version is strictly newer than local — `_is_newer()`; a local build ahead of the registry is reported as `ahead-of-registry` and skipped, never downgraded).

## Conventions

- **Every subcommand takes `--json`** and prints `json.dumps(..., indent=2)`. Human output is the default path; when adding a command, wire both. JSON mode also suppresses progress noise (e.g. `quiet=args.json` on pulls).
- Model selectors are `model` or `model@version` — parse with `_parse_selector()` (partition on `@`).
- Errors are raised as `SystemExit(<message>)` with exit codes: `2` for user-declined/missing-model, `1` for failures (`verify`/`scan`/`walk`/`doctor` return 1 on failure), `0` on success. No tracebacks should leak to users.
- Downloads show a tty progress bar but a single plain line when piped — keep that distinction when touching `download_archive`.
- **Artifact naming (`.ena`)**: the pipeline emits `output/ena-zips/<YYYY-MM-DD>/<slug>.ena.zip` plus a `registry.json` (schema `enano.registry.v2`; entries carry `kind: book|bundle`, `latest`, `versions`) inside each dated folder — every build folder is a self-contained snapshot. Each zip has a single `<slug>.ena/` root whose `VERSION.json` (`enano.ena.v2`) carries `slug`, `kind`, and `built_at` (the install version).
- `install_bundle()` extracts the zip into a `.<version>.tmp` staging dir and **lifts the single top-level directory** (today `<slug>.ena/`; older artifacts were named `enano-<model>-model-<date>` or `etiny-...`) into `models/<model>/<version>/`. Store paths use clean names regardless of artifact naming.
- Version is single-sourced in `pyproject.toml`; `enano/__init__.py` reads it via `importlib.metadata` with a `0.0.0.dev0` fallback when the package is not installed (e.g. running from a source checkout without `pip install -e .`).
- Python floor is 3.9: modules use `from __future__ import annotations` so `str | None` annotations are safe, but do not use 3.10+ syntax at runtime (no match statements, no `X | Y` in non-annotation positions).
- Store-level `remove_version()` refuses to delete the version `latest` points at unless `force=True`; the CLI (`cmd_rm`) performs its own interactive confirmation (requires a tty) and then calls with `force=True`.

## Gotchas

- **Rename complete (etiny → enano):** the package, entry point, module dir, and store are all `enano`; the `etiny` console-script alias is **removed**. Kept as silent read-only fallbacks so existing installs keep their data: `ETINY_HOME` env, legacy `~/.etiny` store dir, `ETINY_REGISTRY` env (each shadowed by its `ENANO_*` equivalent). Do not remove them without a data-migration story.
- Most commands fetch the registry with `refresh=True` — **every `list`, `pull`, `use`, `update` run hits the network**. The cache is only used when `refresh=False`.
- `cmd_rm` without a version fails if more than one version is installed — require `model@version` in that case.
- `cmd_prune all` empties the entire store (`shutil.rmtree(models_root())`); plain `prune` keeps whatever `latest` points at.
- `walk` skips hidden dirs, `node_modules`, `__pycache__`, `.venv` (`SKIP_DIRS`) when recursing for `.md` files.
- Piped stdin into `scan` (no file args) forwards `-` to the bundle scanner instead of scanning the folder.
- The remote is `https://github.com/enano-ai/enano.git` (org is `enano-ai`, repo `enano`).
