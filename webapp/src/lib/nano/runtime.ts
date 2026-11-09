/**
 * Nano model runtime for the /nano-demo experiment bench: a lazy transformers.js
 * (v4) feature-extraction pipeline with WebGPU detection and a WASM fallback,
 * plus the pure vector maths the experiments run on. The heavy library is only
 * imported inside loadNanoModel so the page (and its tests) render without it.
 */
import modelsFile from "./nano-models.json";

/**
 * Per-model runtime attributes. Everything that changes embedding behaviour
 * (input cap, dtype, batch size, instruction prefixes) comes from the catalog
 * (nano-models.json), so trialling another model is a JSON edit, not a code
 * change.
 */
export interface NanoModelSpec {
  id: string;
  label: string;
  size: string;
  dimensions: number;
  /** Pre-tokenisation character cap aligned to the tokenizer window (~4 chars/token). */
  maxInputChars: number;
  dtype: string;
  batchSize: number;
  /** Prefix prepended to query-side texts ("" except instruction-style models, e.g. e5). */
  queryPrefix: string;
  /** Prefix prepended to document-side texts ("" except instruction-style models, e.g. e5). */
  passagePrefix: string;
  /** Pooling applied to token embeddings: "mean" (default, base bge usage) or
   * "cls" (models fine-tuned with CLS pooling, e.g. the enano verticals). */
  pooling?: "mean" | "cls";
  /** true = weights are self-hosted under public/models/<id>, not fetched from the HF hub. */
  local?: boolean;
  notes: string;
}

function validateCatalog(raw: unknown): NanoModelSpec[] {
  const models = (raw as { models?: unknown }).models;
  if (!Array.isArray(models) || models.length === 0) throw new Error("nano-models.json: models[] missing");
  const seen = new Set<string>();
  for (const spec of models as NanoModelSpec[]) {
    for (const key of ["id", "label", "size", "dtype", "notes"] as const) {
      if (typeof spec[key] !== "string" || spec[key].length === 0) throw new Error(`nano-models.json: ${key} invalid for ${spec.id ?? "?"}`);
    }
    if (!Number.isInteger(spec.dimensions) || spec.dimensions <= 0) throw new Error(`nano-models.json: dimensions invalid for ${spec.id}`);
    if (!Number.isInteger(spec.maxInputChars) || spec.maxInputChars < 100) throw new Error(`nano-models.json: maxInputChars invalid for ${spec.id}`);
    if (!Number.isInteger(spec.batchSize) || spec.batchSize < 1) throw new Error(`nano-models.json: batchSize invalid for ${spec.id}`);
    if (typeof spec.queryPrefix !== "string" || typeof spec.passagePrefix !== "string") throw new Error(`nano-models.json: prefixes invalid for ${spec.id}`);
    if (spec.pooling !== undefined && spec.pooling !== "mean" && spec.pooling !== "cls") throw new Error(`nano-models.json: pooling invalid for ${spec.id}`);
    if (seen.has(spec.id)) throw new Error(`nano-models.json: duplicate id ${spec.id}`);
    seen.add(spec.id);
  }
  return models;
}

export const NANO_MODEL_CATALOG: NanoModelSpec[] = validateCatalog(modelsFile);

export function getModelSpec(id: string): NanoModelSpec {
  const spec = NANO_MODEL_CATALOG.find((model) => model.id === id);
  if (!spec) throw new Error(`model ${id} is not in nano-models.json`);
  return spec;
}

export type NanoDevice = "webgpu" | "wasm";

export type EmbedFn = (texts: string[]) => Promise<number[][]>;

interface WebGpuNavigator extends Navigator {
  gpu?: { requestAdapter(): Promise<unknown> };
}

export async function detectNanoDevice(): Promise<NanoDevice> {
  const gpu = (navigator as WebGpuNavigator).gpu;
  if (gpu) {
    try {
      if (await gpu.requestAdapter()) return "webgpu";
    } catch {
      // adapter request failed, fall back to WASM
    }
  }
  return "wasm";
}

/**
 * Cache-busting version for self-hosted model weights — bump whenever files
 * under public/models/ change. transformers.js stores downloads in the Cache
 * API keyed by URL and never revalidates, so a poisoned entry (e.g. the SPA
 * rewrite serving index.html for *.onnx) fails forever. Routing every load
 * through a version-named cache makes each bump a clean slate, and stale
 * transformers caches are deleted so existing sessions self-heal.
 */
export const MODEL_CACHE_VERSION = "2026-10-29";

const MODEL_CACHE_PREFIX = "transformers-cache";

export type TransformersModule = typeof import("@huggingface/transformers");

/** Self-hosted model weights: served with public read from the enanoPacks S3
 * bucket under a VERSIONED prefix (HF repo layout under
 * builtin-data/models/v<CACHE_VERSION>/<id>). The version in the URL is the
 * cache-buster: model files are uploaded with `Cache-Control: immutable`, so
 * replacing a file under the SAME url leaves browsers serving the stale bytes
 * from HTTP cache for a year — a bad upload can only be healed by a new URL.
 * Bumping MODEL_CACHE_VERSION therefore requires re-uploading (or S3-copying)
 * the weights under the new prefix; upload_models.py reads the version from
 * this file and refuses to upload to an unversioned prefix. */
export const MODEL_HOST_BASE =
  "https://amplify-ddcl74bt0u5nd-mai-enanopacksbucket30a8cb47-dzorvtabphoz.s3.us-east-2.amazonaws.com/builtin-data/models/v" +
  MODEL_CACHE_VERSION +
  "/";

let modelHostBasePromise: Promise<string> | null = null;

/** Local-first model host: `enano web` serves the shared runtime layer
 * (engine weights + ORT wasm) from the user's store under /runtime/, so a
 * local install never touches a CDN. When that route is absent (hosted
 * deployment, vite dev server) the probe falls back to the self-hosted S3
 * prefix. The content-type check keeps SPA fallbacks (vite serves
 * index.html for unknown paths) from reading as a local runtime. Probed
 * once per session. */
export function resolveModelHostBase(): Promise<string> {
  if (!modelHostBasePromise) {
    modelHostBasePromise = fetch("/runtime/manifest.json", { method: "HEAD" })
      .then((response) => {
        const ctype = response.headers.get("content-type") ?? "";
        return response.ok && ctype.includes("json")
          ? `/runtime/models/v${MODEL_CACHE_VERSION}/`
          : MODEL_HOST_BASE;
      })
      .catch(() => MODEL_HOST_BASE);
  }
  return modelHostBasePromise;
}

export async function useSelfHostedModels(mod: TransformersModule): Promise<void> {
  const base = await resolveModelHostBase();
  mod.env.allowLocalModels = true;
  mod.env.allowRemoteModels = false;
  mod.env.localModelPath = base;
  if (base.startsWith("/runtime/")) {
    // The ORT WASM binaries ship inside the runtime layer as well; left
    // unset, transformers.js would fetch them from the jsDelivr CDN.
    (mod.env as { wasmPaths?: string }).wasmPaths = "/runtime/ort/";
  }
}

/** Drop every cached model/tokenizer file (all versions) so the next load
 * re-downloads weights from the host. The Help menu's reset uses this. */
export async function resetModelCaches(): Promise<void> {
  if (typeof caches === "undefined") return;
  const names = await caches.keys();
  await Promise.all(
    names
      .filter((name) => name.startsWith(MODEL_CACHE_PREFIX))
      .map((name) => caches.delete(name))
  );
}

export function applyVersionedModelCache(mod: TransformersModule): void {  // The onnxruntime WASM binaries are not bundled (the asyncify build alone is
  // ~27 MB) and deliberately NOT overridden here: left unset, transformers.js
  // points wasmPaths at the jsDelivr CDN build of the exact bundled
  // onnxruntime-web version (ONNX_ENV.versions.web) on its own. Pointing at
  // the @huggingface/transformers package dist instead 404s — that package
  // ships no .wasm/.asyncify loader files. Must run before any pipeline is
  // created.
  if (typeof caches === "undefined") return;
  const cacheName = `${MODEL_CACHE_PREFIX}-v${MODEL_CACHE_VERSION}`;
  mod.env.useCustomCache = true;
  mod.env.customCache = {
    match: (key) => caches.open(cacheName).then((cache) => cache.match(key)),
    put: (key, response) => caches.open(cacheName).then((cache) => cache.put(key, response)),
  };
  caches
    .keys()
    .then((names) =>
      Promise.all(
        names
          .filter((name) => name.startsWith(MODEL_CACHE_PREFIX) && name !== cacheName)
          .map((name) => caches.delete(name))
      )
    )
    .catch(() => undefined);
}

/**
 * Load the embedding pipeline per the model spec: dtype, batch size, and the
 * input cap all come from the catalog. Returns role-aware embeds so
 * instruction-style models (e5) get their query/passage prefixes, plus the ORT
 * WASM thread count actually in effect (transformers.js forces 1 thread unless
 * the page is cross-origin isolated).
 */
export interface LoadedNanoEmbedder {
  embedQueries: EmbedFn;
  embedPassages: EmbedFn;
}

/**
 * Role-aware embed functions around a transformers.js feature-extraction
 * pipeline: batches by the spec batch size, applies query/passage prefixes
 * (instruction-style models like e5) and caps each text at maxInputChars.
 * Shared by the browser loader and the enano CLI (node), which builds the
 * extractor itself (device "cpu" via onnxruntime-node, local model dirs).
 */
export function makeEmbedderFromExtractor(
  extractor: (texts: string[], options: { pooling: "mean" | "cls"; normalize: true }) => Promise<{ dims: number[]; data: Float32Array }>,
  spec: NanoModelSpec
): LoadedNanoEmbedder {
  const makeEmbed = (prefix: string): EmbedFn => async (texts) => {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += spec.batchSize) {
      const batch = texts.slice(i, i + spec.batchSize).map((text) => `${prefix}${text}`.slice(0, spec.maxInputChars));
      const output = (await extractor(batch, { pooling: spec.pooling ?? "mean", normalize: true })) as {
        dims: number[];
        data: Float32Array;
      };
      const dim = output.dims[output.dims.length - 1];
      for (let j = 0; j < batch.length; j++) {
        out.push(Array.from(output.data.subarray(j * dim, (j + 1) * dim)));
      }
    }
    return out;
  };
  return {
    embedQueries: makeEmbed(spec.queryPrefix),
    embedPassages: makeEmbed(spec.passagePrefix),
  };
}

/**
 * transformers.js v4 decides whether to load a tokenizer by probing that
 * tokenizer_config.json exists — a probe that can see neither a
 * localModelPath URL (skipped because it is a URL) nor the disabled remote
 * hub. Every self-hosted pipeline therefore loads tokenizer-less and dies on
 * the first call with "this.tokenizer is not a function"; and
 * AutoTokenizer.from_pretrained hits the same probe, returning undefined
 * files. Load both files straight from the model host and construct the
 * tokenizer class that tokenizer_config names, mirroring AutoTokenizer's own
 * selection.
 */
export async function loadSelfHostedTokenizer(mod: TransformersModule, modelId: string): Promise<unknown> {
  const base = `${await resolveModelHostBase()}${modelId}/`;
  const load = async (file: string) => {
    const response = await fetch(`${base}${file}`);
    if (!response.ok) throw new Error(`self-hosted ${file} for ${modelId}: ${response.status}`);
    return response.json();
  };
  const [tokenizerJSON, tokenizerConfig] = await Promise.all([load("tokenizer.json"), load("tokenizer_config.json")]);
  const className = String(tokenizerConfig.tokenizer_class ?? "").replace(/Fast$/, "");
  const classes = mod as unknown as Record<string, unknown>;
  const TokenizerClass = classes[className] as
    | (new (tokenizerJSON: unknown, tokenizerConfig: unknown) => unknown)
    | undefined;
  if (!TokenizerClass) throw new Error(`unknown tokenizer_class ${className} for ${modelId}`);
  return new TokenizerClass(tokenizerJSON, tokenizerConfig);
}

// Pipeline preference: the (device, dtype) that last worked, persisted so
// reloads skip the fp16 → fp32 → q8 ladder (each rung fetches different
// weight files and re-fires progress from 0 — the "double download" the
// Models icon used to show on every hard reload).
const PIPELINE_PREF_KEY = "nano:pipeline-pref";

function readPipelinePref(): { device: NanoDevice; dtype: string } | null {
  try {
    const raw = localStorage.getItem(PIPELINE_PREF_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { device?: unknown; dtype?: unknown };
    if (
      (parsed.device === "webgpu" || parsed.device === "wasm") &&
      typeof parsed.dtype === "string"
    ) {
      return { device: parsed.device, dtype: parsed.dtype };
    }
  } catch {
    // Private mode / disabled storage: the ladder just runs fresh each load.
  }
  return null;
}

function writePipelinePref(pref: { device: NanoDevice; dtype: string }): void {
  try {
    localStorage.setItem(PIPELINE_PREF_KEY, JSON.stringify(pref));
  } catch {
    // Best effort only.
  }
}

export async function loadNanoModel(
  spec: NanoModelSpec,
  onProgress: (progress: number) => void
): Promise<{
  device: NanoDevice;
  numThreads: number;
  embedQueries: EmbedFn;
  embedPassages: EmbedFn;
}> {
  const device = await detectNanoDevice();
  const mod = await import("@huggingface/transformers");
  applyVersionedModelCache(mod);
  await useSelfHostedModels(mod);
  // fp16 is a native GPU dtype: WebGPU runs the whole graph on-chip. The q8
  // file's int8 ops force per-op CPU fallbacks on WebGPU (GPU<->CPU copies
  // around every op), which is why q8-on-GPU measured slower than CPU. q8
  // stays the WASM fallback, where int8 is the fast path.
  const makePipeline = (pipelineDevice: NanoDevice, dtype: string) =>
    mod.pipeline("feature-extraction", spec.id, {
      device: pipelineDevice,
      dtype: dtype as "q8",
      progress_callback: (data: { status?: string; progress?: number }) => {
        if (data.status === "progress" && typeof data.progress === "number") onProgress(data.progress);
      },
    });
  // Ladder: saved preference first (skips known-failed rungs on reloads),
  // then fp16 GPU -> fp32 GPU (older drivers) -> q8 WASM. The first rung
  // that succeeds is persisted for the next load.
  const ladder: { device: NanoDevice; dtype: string; why: string }[] = [];
  const pref = readPipelinePref();
  if (pref) ladder.push({ ...pref, why: `${pref.device}:${pref.dtype} (saved preference)` });
  if (device === "webgpu") {
    ladder.push({ device: "webgpu", dtype: "fp16", why: "fp16 on webgpu" });
    ladder.push({ device: "webgpu", dtype: "fp32", why: "fp32 on webgpu" });
  }
  ladder.push({ device: "wasm", dtype: spec.dtype, why: `${spec.dtype} on wasm` });
  const attempted = new Set<string>();
  let usedDevice = ladder[ladder.length - 1].device;
  let usedDtype = ladder[ladder.length - 1].dtype;
  let extractor;
  let lastError: unknown;
  for (const rung of ladder) {
    const key = `${rung.device}:${rung.dtype}`;
    if (attempted.has(key)) continue;
    attempted.add(key);
    try {
      extractor = await makePipeline(rung.device, rung.dtype);
      usedDevice = rung.device;
      usedDtype = rung.dtype;
      writePipelinePref({ device: rung.device, dtype: rung.dtype });
      break;
    } catch (err) {
      lastError = err;
      console.warn(`[nano] ${rung.why} failed`, err);
    }
  }
  if (!extractor) throw lastError ?? new Error(`nano pipeline failed for ${spec.id}`);
  // transformers.js v4 skips the tokenizer when its existence probe cannot see
  // tokenizer_config.json — with self-hosted models (allowRemoteModels off,
  // localModelPath as an https URL) the probe checks neither location, so
  // fresh-cache loads build a tokenizer-less pipeline that dies with
  // "this.tokenizer is not a function" on the first call. Attach one loaded
  // straight from the self-hosted files (see loadSelfHostedTokenizer).
  const pipelineWithTokenizer = extractor as unknown as { tokenizer?: unknown };
  if (!pipelineWithTokenizer.tokenizer) {
    pipelineWithTokenizer.tokenizer = await loadSelfHostedTokenizer(mod, spec.id);
  }
  const embedder = makeEmbedderFromExtractor(extractor as Parameters<typeof makeEmbedderFromExtractor>[0], spec);
  const numThreads = mod.env.backends.onnx.wasm?.numThreads ?? 1;
  console.info(
    `[nano] ${spec.id} loaded on ${usedDevice} · ${numThreads} wasm thread${numThreads === 1 ? "" : "s"} · dtype ${usedDtype}`
  );
  return {
    device: usedDevice,
    numThreads,
    embedQueries: embedder.embedQueries,
    embedPassages: embedder.embedPassages,
  };
}

/* ------------------------------------------------------- pure vector maths */

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export interface ScoredIndex {
  index: number;
  score: number;
}

export function topKMatches(query: number[], corpus: number[][], k: number): ScoredIndex[] {
  return corpus
    .map((vec, index) => ({ index, score: cosineSimilarity(query, vec) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

export interface PromptProbe {
  id: string;
  title: string;
  regex: string;
  description: string;
}

export interface PromptProbeResult {
  id: string;
  title: string;
  regexScore: number;
  descriptionScore: number;
  bestIndex: number;
}

/** A/B a detector's raw regex string against its human description as the embedded prompt. */
export function comparePromptProbe(
  probe: PromptProbe,
  regexVec: number[],
  descriptionVec: number[],
  blockVecs: number[][]
): PromptProbeResult {
  const regexBest = topKMatches(regexVec, blockVecs, 1)[0];
  const descBest = topKMatches(descriptionVec, blockVecs, 1)[0];
  return {
    id: probe.id,
    title: probe.title,
    regexScore: regexBest.score,
    descriptionScore: descBest.score,
    bestIndex: descBest.index,
  };
}

export interface GapRow {
  id: string;
  title: string;
  bestScore: number;
  bestIndex: number;
}

/** Obligations whose best semantic score never reaches the threshold. */
export function semanticGaps<T extends { id: string; title: string; vec: number[] }>(
  probes: T[],
  blockVecs: number[][],
  threshold: number
): (GapRow & T)[] {
  return probes
    .map((probe) => {
      const best = topKMatches(probe.vec, blockVecs, 1)[0];
      return { ...probe, bestScore: best.score, bestIndex: best.index };
    })
    .filter((row) => row.bestScore < threshold)
    .sort((a, b) => a.bestScore - b.bestScore);
}

export interface ParaphrasePair {
  aIndex: number;
  bIndex: number;
  score: number;
}

/** Most similar block pairs across different documents (consistency-check candidates). */
export function crossDocParaphrases(
  docOf: number[],
  blockVecs: number[][],
  minScore: number,
  limit: number
): ParaphrasePair[] {
  const pairs: ParaphrasePair[] = [];
  for (let i = 0; i < blockVecs.length; i++) {
    for (let j = i + 1; j < blockVecs.length; j++) {
      if (docOf[i] === docOf[j]) continue;
      const score = cosineSimilarity(blockVecs[i], blockVecs[j]);
      if (score >= minScore) pairs.push({ aIndex: i, bIndex: j, score });
    }
  }
  return pairs.sort((a, b) => b.score - a.score).slice(0, limit);
}

export interface NanoBlock {
  docIndex: number;
  docName: string;
  kind: string;
  text: string;
}

/** Flatten decoded docs into one embeddable corpus, dropping tiny header-ish lines. */
export function buildCorpus(
  docs: { name: string; blocks: { kind: string; text: string }[] }[],
  minLength = 14
): NanoBlock[] {
  const out: NanoBlock[] = [];
  docs.forEach((doc, docIndex) => {
    for (const block of doc.blocks) {
      if (block.text.trim().length < minLength) continue;
      out.push({ docIndex, docName: doc.name, kind: block.kind, text: block.text.trim() });
    }
  });
  return out;
}

/** Cosine similarity of every row vector against every column vector. */
export function similarityMatrix(rows: number[][], cols: number[][]): number[][] {
  return rows.map((row) => cols.map((col) => cosineSimilarity(row, col)));
}

export interface RowMatch {
  /** Column the model ranked first. */
  argmax: number;
  /** 1-based rank of the correct column (row index). */
  rank: number;
  /** Score against the correct column. */
  score: number;
}

export interface MatchMetrics {
  top1: number;
  top3: number;
  medianRank: number;
  perRow: RowMatch[];
}

/**
 * Ground truth is the identity: row i must match column i. Reports how many
 * paraphrases the model maps back to their own obligation and how far off the
 * misses land.
 */
export function matchMetrics(matrix: number[][]): MatchMetrics {
  const perRow = matrix.map((row, i) => {
    const ranked = row
      .map((score, j) => ({ score, j }))
      .sort((a, b) => b.score - a.score);
    return { argmax: ranked[0].j, rank: ranked.findIndex((entry) => entry.j === i) + 1, score: row[i] };
  });
  const ranks = perRow.map((row) => row.rank).sort((a, b) => a - b);
  const mid = Math.floor(ranks.length / 2);
  const medianRank =
    ranks.length % 2 === 1 ? ranks[mid] : (ranks[mid - 1] + ranks[mid]) / 2;
  return {
    top1: perRow.filter((row) => row.rank === 1).length,
    top3: perRow.filter((row) => row.rank <= 3).length,
    medianRank,
    perRow,
  };
}

/** Deterministic shuffle so the display order of matrix columns is not the diagonal. */
export function shuffledOrder(count: number, seed = 20260912): number[] {
  const order = Array.from({ length: count }, (_, i) => i);
  let state = seed >>> 0;
  for (let i = order.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

export interface RegexHit {
  index: number;
  matched: string;
}

/** Where the pattern actually fires over the corpus texts (the deterministic twin of the semantic ranking). */
export function regexHits(texts: string[], pattern: string, flags: string, limit = 6): RegexHit[] {
  const re = new RegExp(pattern, flags.includes("g") ? flags : `${flags}g`);
  const out: RegexHit[] = [];
  for (let index = 0; index < texts.length && out.length < limit; index++) {
    re.lastIndex = 0;
    const match = re.exec(texts[index]);
    if (match && match[0].length > 0) out.push({ index, matched: match[0] });
  }
  return out;
}

/**
 * 1-based position of the best-ranked evidence block inside a full ranking
 * (topKMatches with k = corpus length). Lower is better; 1 means the model's
 * first pick is exactly the block the deterministic evidence points at.
 */
export function bestEvidenceRank(evidence: number[], fullRanking: ScoredIndex[]): number {
  const positionOf = new Map(fullRanking.map((entry, position) => [entry.index, position + 1] as const));
  let best = Number.POSITIVE_INFINITY;
  for (const blockIndex of evidence) {
    const at = positionOf.get(blockIndex);
    if (at !== undefined && at < best) best = at;
  }
  return Number.isFinite(best) ? best : -1;
}

export interface RuntimeFacts {
  crossOriginIsolated: boolean;
  sharedArrayBuffer: boolean;
  cores: number | null;
  deviceMemoryGb: number | null;
  adapterInfo: string | null;
  userAgent: string;
}

/** Everything that decides which execution path this device can take. */
export async function inspectRuntime(): Promise<RuntimeFacts> {
  const gpu = (navigator as WebGpuNavigator).gpu;
  let adapterInfo: string | null = null;
  if (gpu) {
    try {
      const adapter = (await gpu.requestAdapter()) as
        | ({ info?: { vendor?: string; architecture?: string; device?: string; description?: string } } | null)
        | null;
      if (adapter) {
        const info = adapter.info;
        adapterInfo =
          [info?.vendor, info?.architecture || info?.device || info?.description].filter(Boolean).join(" ") ||
          "adapter (no info)";
      } else {
        adapterInfo = "no adapter";
      }
    } catch {
      adapterInfo = "adapter request failed";
    }
  } else {
    adapterInfo = "navigator.gpu absent";
  }
  const selfGlobal = self as { crossOriginIsolated?: boolean };
  return {
    crossOriginIsolated: selfGlobal.crossOriginIsolated === true,
    sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
    cores: typeof navigator !== "undefined" ? navigator.hardwareConcurrency ?? null : null,
    deviceMemoryGb: (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null,
    adapterInfo,
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
  };
}
