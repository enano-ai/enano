# About Enano

**Enano** is a fully client-side "elevation playground" (shipped at [enano.ai](https://enano.ai)). This file is the product ABOUT for the app under `webapp/`.

## What Enano is

Enano scans a document the user pastes into the browser and matches it against a corpus of distilled self-improvement rulebooks ("elevators") and startup pitch-deck templates. In the project's domain language:

- **Elevator** — a source work (a book, or a canonical deck template such as the Sequoia business plan).
- **Elevation** — an individual rule, commitment or obligation extracted from that work ("Never miss a habit twice in a row").
- **Instrument** — the identifier for one elevator inside the packs.

Nothing is uploaded: the regex engine, the embedding model, and the elevation corpus all run in the browser. The only network calls are fetching the compiled detector/advice packs (presigned S3 URLs) and the model weights (Cache-API-persisted).

## System architecture

```
document-pipeline (sister repo, source of truth)
    obligations/  advice/  packs/release/  exemplars/
        │
        ▼  npm run enano:import  (enano/scripts/*.py)
┌────────────────────────────────────────────────────────────┐
│ S3 (enanoPacks bucket, via /fund-docs-packs Lambda)        │
│   detectors.json   advice.json        (never in git)       │
│   model-zips/*     (downloadable model bundles)            │
└────────────────────────────────────────────────────────────┘
        │
        ▼  runtime fetch (presigned URLs, gzip)
┌────────────────────────────────────────────────────────────┐
│ Enano app (Vite + React 18 + TypeScript)                   │
│                                                            │
│  ONE scan pipeline per document state:                     │
│    text → blocks → regex pass → (await weights) →          │
│    semantic pass → single publication                      │
│                                                            │
│  Regex engine      pack-v2.ts — interprets compiled        │
│                    detector groups (match / gate_only /    │
│                    absence patterns, evidence policies)    │
│  Semantic layer    semantic-layer.ts — cosine cross-check  │
│                    of every in-scope anchor vs every       │
│                    block, tiered direct/related/possible   │
│                    with runner-up margin gating            │
│  Confidence        70% cosine + 30% margin blend;          │
│                    regex evidence is an authored 0.95      │
│  Paint pipeline    interval merge with strongest-tier-     │
│                    wins; possible-tier findings never      │
│                    paint; model evidence quantile-spread   │
│                    across the lower filter tiers           │
└────────────────────────────────────────────────────────────┘
```

### Single-publication guarantee

The scan pipeline publishes its result exactly once, after both passes have fused. Rows, editor highlights, filter chips and stats appear together in their final state — there is no intermediate regex-only UI state that could flicker or jump mid-scan. If the models are unavailable (no WebGPU/WASM), the regex result is the final result and publishes immediately.

### The scoring ladder (one shared constant)

The semantic baseline cutoff and the s2 filter bracket both derive from `S2_BRACKET_BOUNDARY` (semantic-layer.ts) — one number anchors the admission funnel and the five confidence buckets (s5 ≥ 90%, s4 ≥ 75%, s3 ≥ 60%, s2 ≥ 45%, s1 below). Changing the constant moves both together by construction.

## Models

### Embedders

| Model | Role | Notes |
|---|---|---|
| `Xenova/bge-small-en-v1.5` | facts + check embedder for the fund-docs scope | one shared instance for both roles; 384-d |
| `enano/pg-mnrl-47845708` | goals vertical | bge-small MNRL fine-tune, CLS pooling, 256-token window |
| `enano/spd-mnrl-48127877` | pitch-decks vertical | bge-small MNRL fine-tune, CLS pooling, 256-token window |

Each embedder is a bge-small-class model: ~33M parameters, ~34 MB as q8. The vertical fine-tunes are self-hosted under `builtin-data/models/enano/<id>`; the catalog anchor vectors are a little-endian **float16** matrix, index-aligned with `goals-catalog.json`, rebuilt at import time with identical maths to the browser embedder.

### Quantizations and the device ladder

Every self-hosted model carries three ONNX quantizations (`onnx/` directory):

| File | Precision | Where it runs |
|---|---|---|
| `model_quantized.onnx` | q8 (int8) | **WASM/CPU fast path** — int8 is the fast path on CPU |
| `model_fp16.onnx` | fp16 | **WebGPU** — native GPU dtype, whole graph on-chip |
| `model.onnx` | fp32 | WebGPU fallback for older drivers; also the bucket-only reference copy |

Selection is a persisted ladder: the (device, dtype) that last worked is stored in localStorage and tried first; fresh machines try **fp16 GPU → fp32 GPU → q8 WASM**. q8 is deliberately *not* run on GPU — int8 ops force per-op CPU fallbacks around every kernel, which measured slower than plain CPU. Download progress is monotonic and surfaces on the **Models capability icon**, never as a subbar progress bar — the subbar shows scan progress only.

### Determinism and subjectivity

What is fully deterministic: the **regex layer** (compiled patterns, fixed evaluation), the **anchor index bytes** (immutable, version-pinned f16 matrices), and every scoring formula given fixed inputs. What is not:

**Non-deterministic (same input, different output by environment):**

- **Cross-precision comparison.** The pre-compiled anchor vectors are built offline from the q8 ONNX weights, but query-side embeddings run fp16/fp32 on WebGPU machines and q8 on WASM machines. The same rule–text pair can score differently across device classes — enough to flip a borderline tier (e.g. 0.6995 vs a 0.70 direct floor).
- **GPU/driver variance.** WebGPU reductions are not guaranteed bit-stable across vendors or drivers; the WASM tier's thread count varies with cross-origin isolation and core count. Tiny wobbles that matter only because tier floors turn wobble into label flips.
- **Batch-shape wobble (minor).** q8 kernels tile differently by batch shape, so a block embedded in a full batch vs a remainder batch can differ in the last decimals.

**Deterministic but subjective (fixed judgment calls baked into code):**

- **Tier floors and margins** (per-model `SEMANTIC_TIERS`: direct/related/possible) and the `SEMANTIC_EVIDENCED_SCORE = 0.75` badge threshold — hand-calibrated constants, not measured probabilities.
- **Admission caps** — top-500 by score plus up to 500 more from public-domain sources: policy constants, and the public-domain fill is deliberate curation that changes results.
- **Highlight re-bucketing** — model evidence spans are re-tiered by rank quantiles relative to the document's own score distribution, so the same pair can land in different filter buckets on different documents (subjective by design).
- **The confidence blend** (cosine + margin) is an authored formula, not a calibrated likelihood.
- **spd-mnrl floors are provisional** — measured noise overlaps signal in that fine-tune (an unrelated sentence can outscore the related floor), so only the margin gates discriminate until it is retrained.
- **The fine-tunes themselves** encode a learned, corpus-relative notion of similarity — deterministic at inference, but the judgment was made upstream in training-data curation.

If reproducibility ever matters for a claim, the cheap mitigations are: round scores to three decimals before thresholding (absorbs device wobble), tier on a pinned precision (q8 anchors vs q8 queries), and calibrate floors against the pipeline evalset rather than a single sample document.

### Downloadable model bundles

The toolbar's Download button serves self-contained zips from the bucket: the personal-goals bundle (detector pack + compiled elevations + a ready-to-install agent skill) and the pitch-decks bundle (elevation corpus + scan tools; no detector pack exists for that vertical yet). Both bundles carry the vertical's q8 weights **plus the neural matcher**: `tools/semantic.py` (stdlib WordPiece tokenizer + onnxruntime inference, CLS pooling, the webapp's tier floors) and `data/elevations-vectors.f16`, a little-endian float16 index row-aligned with `data/elevations.jsonl` and rebuilt at bundle-build time by `enano/scripts/embed_bundle_vectors.py` under the project venv. `tools/scan.py` scores a document two ways with the same maths as the browser: regex detector statuses and per-line semantic matches (`--semantic auto|on|off`; regex runs stdlib-only, neural matching adds `pip install onnxruntime numpy`). Bundles ship **q8 weights only** — fp32/fp16 variants stay bucket-only. Sizes live in `enano/src/pages/playground/model-zip-sizes.json` so the UI label always matches the served artifact.

## Copyright & licensing

The corpus mixes **public-domain classics** (the Stoics, Plato, Thoreau, Emerson, Smiles, Allen, Bennett, Wattles, James, Marden, Coué, Atkinson, Conwell, Boethius, Russell, Parsons, Lorimer, Braddy, Crowther, Scott, and other pre-1929 works) with **modern, in-copyright titles** (Atomic Habits, Getting Things Done, The 7 Habits, Measure What Matters, The Happiness Project, and others) and **canonical pitch-deck templates** (Sequoia, Y Combinator, Kawasaki, McClure) whose names and structures belong to their authors and firms.

The project's standing policy (enforced by the export tooling and restated in every downloadable bundle's `DISCLAIMER.md`):

- **No source texts ship anywhere** — not in the app bundle, not in the git repo, not in the downloadable zips. The PDFs live only in the private `document-pipeline` sister repo.
- **No verbatim passages** — `source_quote` and `expanded_source_quote` fields are stripped from elevations on export. What ships are machine-generated distillations: rules, regex detectors, and advice produced by automated analysis.
- **Attribution is identification-only** — titles and authors appear solely to identify the source work; all rights in the underlying works remain with their respective authors, publishers, and other rights holders. Nothing here is affiliated with, sponsored by, or endorsed by any of them.
- **Derived data is interpretation, not replacement** — the machine-generated rules may be incomplete or inaccurate and are not a substitute for the original works or professional advice; bundles are provided as-is with no warranty, and redistribution compliance is the downloader's responsibility.
- **Model weights** bundled for download are redistribution copies of publicly released open models; their licenses and terms live with the original model releases.

## Features

- Three-pane playground: document editor (CodeMirror, markdown-aware rendering with cursor-reveal), obligation/elevation list with book accordion and search, and a detail pane per finding.
- Detail pane per finding: **TL;DR** (the rule's one-line summary), **What to do** (gap actions), self-check questions, and evidence excerpts quoted from the user's document with page references.
- Advice system: per-obligation gap actions and self-check questions keyed by document type (goal notes, pitch deck, DDQ, factsheet, policy), joined by corpus fingerprint.
- Five-tier highlight filters with live counts (counts gate on scan completion), tier visibility toggles, per-block drill-down from any highlight.
- Capability strip: WebGPU / WASM / Models icons with live status text beside them (checking → downloading → ready), plus scan-phase narration.
- Two live verticals: **Personal Goals** (self-improvement rulebooks) and **Startup Pitch Decks** (canonical deck templates), each with its own sample document; more rulebooks land by importing from the pipeline.
- Elevator portraits: consistent illustrated author art, resized to a uniform 256×256 set.

## Source material — counts (as of `fd-release-2026-10-28`)

### Compiled packs

| Metric | Count |
|---|---|
| Detector groups (all verticals) | 1,645 |
| Regex patterns | 29,995 |
| Rulebooks with live detectors | 59 |
| Instruments | 59 |
| Detectors with exemplar anchor sets | 878 |
| Advice fingerprints (gap-action entries) | 2,523 |

Advice coverage by document type: DDQ 1,812 · factsheet 1,298 · policy 1,297 · pitch deck 1,132 · goal notes 636.

Personal-goals cell (pipeline SoT, same release): **47** release detector packs with GOAL_NOTES advice rows, and **47/47** detectors covered by s65 exemplar sentence sets (`exemplars/exemplar_sentences.json`).

### Elevation catalog (bundled for semantic matching)

**36 elevators / 26,720 elevations.** The largest by elevation count:

| Elevator | Elevations |
|---|---|
| Seneca — On the Shortness of Life | 1,981 |
| Plato — Republic | 1,974 |
| Marcus Aurelius — Meditations | 1,649 |
| David Allen — Getting Things Done | 1,615 |
| Carnegie — Art of Public Speaking | 1,606 |
| Covey — The 7 Habits | 1,566 |
| Parsons — Choosing a Vocation (1909) | 1,421 |
| Emerson — Essays, First Series | 1,225 |

…plus Smiles, Atkinson, Braddy, Crowther, Rubin, Scott, Doerr, Boethius, Emerson (Conduct of Life), Clear (Atomic Habits), Thoreau, Russell, Lorimer, Wattles, Coué, Epictetus, James, Bennett, Conwell, Allen, Franklin, Marden, Plato (Apology), and the five deck templates (Kawasaki 10/20/30, Jarvis seed, McClure, Sequoia, YC seed = 75 combined).

### Model bundles

| Bundle | Size |
|---|---|
| `enano-personal-goals-model.zip` | 24.9 MB |
| `enano-pitch-decks-model.zip` | 22.4 MB |

## Development

```bash
npm run setup          # venv + npm install
npm run enano:import   # import latest packs from document-pipeline (see AGENTS.md)
npm run enano:upload   # push packs to the enanoPacks S3 bucket (AWS_PROFILE=introize)
npm run enano:model-zip  # build downloadable model bundles
npm run enano:build    # tsc + vite build → content/enano/
```

`AGENTS.md` (repo root) documents site-wide conventions; the `enano/secure/` staging directory (packs, zips, model weights) is intentionally never committed.
