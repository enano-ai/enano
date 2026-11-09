# enano: Explorable nano models for your second brain

28,000+ pieces of advice distilled from key books on the topics of personal goals, career advice and startup pitch decks.

Each model package comes with an ONNX model, JSON source attributes, excerpts, custom advice, regex detectors, a vector index, and neural scoring engine.

Use cli tools to explore your own .md and .txt files via command or use Claude Cowork, OpenAI Chat GPT directly with the JSON files and Python scripts.

**WEB APP & DEMO**
https://enano.ai
Web app is private and runs entirely in frontend, no user data or text is sent, models designed to run entirely in-browser.
<p align="center">
  <a href="docs/screens/screen-1.png"><img src="docs/screens/screen-1.jpg" width="49%"></a>
  <a href="docs/screens/screen-2.png"><img src="docs/screens/screen-2.jpg" width="49%"></a>
</p>

## Install

```bash
pipx install enano
```

## Quickstart

Scan the .md files in the folder against the default model:

```bash
enano scan
```

| Model | Default | Sources | Corpus | Rules | Detectors | Advice | Pull |
|---|---|---|---|---|---|---|---|
| **personal-goals** | yes | 21 | 2.3 GB | 15,833 | 31 | 391 | 35.8 MB |
| **career-advice** | | 5 | 91 MB | 5,026 | 142 | 1,877 | 25 MB |
| **pitch-decks** | | 5 | 2.2 GB | 75 | 75 | 1,132 | 22.5 MB |


## Usage
You can use the packages via the cli tools OR you can use with Claude Cowork et. al.

Fetch the personal-goals bundle (~36 MB, sha-verified):

```bash
enano pull personal-goals
```

Scan a document (regex plus the optional neural pass):

```bash
enano scan notes.md
```

Scan every .md in the current folder (stdin when piped):

```bash
enano scan
```

Scan every .md in every subfolder:

```bash
enano walk
```

Watch a file or folder and re-scan on every change, printing only what moved
(edit your notes in Obsidian and keep this running in a terminal):

```bash
enano watch notes.md
```

Call the bundle's scanner directly (no CLI wrapper, no model switching —
regex-only on bare python3, neural needs `pip install onnxruntime numpy`):

```bash
python3 ~/.enano/models/personal-goals/latest/tools/scan.py notes.md
```

Open the enano web app in your browser (localhost backend + GUI):

```bash
enano web
```

List the source works with their counts:

```bash
enano elevators
```

Search the rule corpus, any word or phrase:

```bash
enano elevations "fear of failure"
```

See every model you can pull:

```bash
enano list
```

See what's installed:

```bash
enano models
```

Switch the default model:

```bash
enano use pitch-decks
```

Check for newer bundles:

```bash
enano update
```

Fetch newer bundles:

```bash
enano upgrade
```

Run environment and store diagnostics:

```bash
enano doctor
```

**Global Parameters**
Every command takes `--json`; there are no other flags to learn. Bare `enano`
onboards: it pulls the default model and shows the shortest path to a first scan.

## Local development

No build step and no runtime dependencies, stdlib Python 3.9+. A Makefile wraps
the common flows, and Zed picks the targets up as tasks (.zed/tasks.json).

One-time setup (venv, editable install, pytest):

```bash
make install
```

Run the test suite (hermetic: no network, throwaway store):

```bash
make test
```

Build the GUI from source (webapp/, React + Vite):

```bash
make webapp
```

Serve the local web app at http://localhost:8599 (auto-opens the browser):

```bash
make web
```

Forward flags with ARGS:

```bash
make web ARGS="--no-open --port 0 --json"
```

The port is fixed at 8599 (IANA-unassigned) so the URL is stable and documentable; a busy port is an error, not a silent port change.

Environment and store diagnostics:

```bash
make doctor
```

Commands also work straight from the checkout without installing:

```bash
python3 -m enano <cmd>
```

Set `ENANO_HOME=/tmp/some-dir` to point the store at a disposable folder so local
runs never touch your real one. `enano help` lists every command.

## Contact

Found a bug or have a question? [Open an issue](https://github.com/enano-ai/enano/issues)
or visit [enano.ai](https://enano.ai).
