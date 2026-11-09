# TODO

## Now — runtime layer (shared engine assets, Ollama-style)

The CLI, store, and web server are done: `runtime/<version>/` in the store,
`enano pull runtime`, auto-install on model pulls, update/upgrade support,
`enano web` serving `/runtime/*` + `/api/runtime`, and the webapp probing
`/runtime/manifest.json` local-first (falls back to the S3 host when absent).

Remaining (pipeline side, outside this repo):

- Build the runtime artifact zip: `manifest.json`, `models/v<MODEL_CACHE_VERSION>/<model-id>/`
  weights, and `ort/` wasm binaries (layout must match
  `webapp/src/lib/nano/runtime.ts` — base `/runtime/models/v<version>/`,
  wasm at `/runtime/ort/`).
- Publish it and add a top-level `"runtime"` entry to the registry
  (`{"latest": v, "versions": {v: {bytes, sha256, url, mirrorUrl}}}`).
- After that, drop the S3 fallback in `resolveModelHostBase()` and the
  jsDelivr wasm path — the GUI becomes fully offline after `enano pull`.

## Later — Obsidian plugin: real-time checking while editing

Goal: while a user edits goal notes in Obsidian (or any editor), enano
matches obligations in real time — the playground experience, inside the
editor. One-shot `enano scan` stays exactly as is.

Research conclusions (2026-11):

- **Port the webapp engine, don't rewrite it.** The playground matching
  engine is already pure TypeScript in Chromium: regex detectors as data
  (`webapp/src/pages/ddq/pack-v2.ts`) + semantic via
  `@huggingface/transformers` q8 ONNX (`semantic-layer.ts`), and the
  editor highlights already target CodeMirror 6 — the same editor
  Obsidian uses. Obsidian is Electron (Chromium + Node), so the engine
  ports nearly verbatim. Precedent: Smart Connections runs transformers.js
  inside Obsidian today.
- **Data source, hybrid:** read the local enano store when the CLI is
  installed (`~/.enano/models/personal-goals/latest` already holds
  `detectors.jsonl`, elevations, vectors — no re-download); else fetch
  from the hosted zips. The hosted personal-goals zip is ~204 MB, so ship
  a slim "plugin pack" artifact from the pipeline (detectors + elevation
  vectors only) instead of the full zip.
- **UX, standard plugin APIs:** `workspace.on("editor-change")` debounced
  ~300 ms for instant regex re-score; semantic pass on idle (same
  two-phase pattern as the playground's `pg-model-note`); CM6 decorations
  via `registerEditorExtension` to underline matched spans spellcheck-style;
  `registerView` sidebar leaf for the obligations book accordion;
  `addStatusBarItem` for live counts.
- **Avoid engine fork drift:** extract the playground engine into a shared
  package consumed by both webapp and plugin.
- **Rejected for real-time:** shelling out to `enano scan` per keystroke
  (~0.9 s/invocation + model reload); fine only as a desktop fallback.
- **Possible follow-up for other editors:** add `POST /api/scan` to
  `enano web` (port 8599) so vim/VS Code tooling can POST text.
- **Distribution:** community store review is slow; beta via BRAT /
  manual install (manifest.json + main.js + styles.css, GitHub releases).
- **Test doc:** `dev/sample-goal-notes.txt` (gitignored, copied from
  `webapp/src/pages/ddq/samples/Goals_Demo_Personal.md`).
