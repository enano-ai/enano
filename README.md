# enano: Explorable nano models for your second brain

28,000+ pieces of advice distilled from key books on the topics of personal goals, career advice and startup pitch decks.

Each model package comes with an ONNX model, JSON source attributes, excerpts, custom advice, regex detectors, a vector index, and neural scoring engine.

Use cli tools to explore your own .md and .txt files via command or use Claude Cowork, OpenAI Chat GPT directly with the JSON fies and Python scripts.

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

```bash
enano scan                   # checks .md in the folder against the  default model
```

| Model | Default | Sources | Corpus | Rules | Detectors | Advice | Pull |
|---|---|---|---|---|---|---|---|
| **personal-goals** | yes | 21 | 2.3 GB | 15,833 | 31 | 391 | 35.8 MB |
| **career-advice** | | 5 | 91 MB | 5,026 | 142 | 1,877 | 25 MB |
| **pitch-decks** | | 5 | 2.2 GB | 75 | 75 | 1,132 | 22.5 MB |


## Usage
You can use the packages via the cli toos OR you can use with Claude Cowork et. al.

```bash
enano pull personal-goals         # fetch the personal-goals bundle (~36 MB, sha-verified)
enano scan notes.md               # scan a document (regex plus the optional neural pass)
enano scan                        # every .md in the current folder (stdin when piped)
enano walk                        # every .md in every subfolder
enano elevators                   # list the source works with their counts
enano elevations "fear of failure"  # search the rule corpus, any word or phrase
enano list                        # every model you can pull
enano models                      # what's installed
enano use pitch-decks             # switch the default model
enano update                      # check for newer bundles
enano upgrade                     # fetch newer bundles
enano doctor                      # environment and store diagnostics
```

**Global Parameters**
Every command takes `--json`; there are no other flags to learn. Bare `enano`
onboards: it pulls the default model and shows the shortest path to a first scan.

## Contact

Found a bug or have a question? [Open an issue](https://github.com/enano-ai/enano/issues)
or visit [enano.ai](https://enano.ai).
