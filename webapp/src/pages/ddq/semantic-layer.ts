/**
 * Semantic layer for the fund-docs workspace (/prototype). Two capabilities,
 * fused with the deterministic regex engine by confidence (the workspace merge
 * keeps the stronger finding per obligation and unions their evidence):
 *
 * 1. Facts model (field location): locates which block of each document holds
 *    each question-matrix datapoint, and proposes values the strict extraction
 *    regex missed via generic value patterns inside located blocks.
 * 2. Cross-check model (obligation matching): ranks blocks by meaning against
 *    EVERY detector anchor — not just zero-regex-hit ones — so the model
 *    competes with regex instead of only rescuing its leftovers. Strong
 *    cosine matches graduate to evidenced findings; the rest stay capped as
 *    review candidates.
 *
 * Embedders are injected (loadNanoModel in production, fakes in tests). Vector
 * cache is optional and injected. Every appended finding carries
 * weak_signal: "semantic".
 */
import type { DdqDocument, DdqFinding, DdqSeverity } from "@/pages/ddq/ddq-mock-data";
import { FUND_DOCS_PACK } from "@/pages/ddq/fund-docs-pack";
import { RELEASE_PACK } from "@/pages/ddq/pack-v2";
import goalsCatalogFile from "@/pages/ddq/packs/goals-catalog.json";
import {
  extractDatapoints,
  QUESTION_MATRIX,
  type DatapointGroup,
} from "@/pages/ddq/question-matrix";

interface CatalogObligation {
  instrument: string;
  obligation_id: string;
  title: string;
  description: string;
  obligation_text: string;
  provision_id: string;
  /** Verbatim passage behind the rule — the importer includes these only for
   * public-domain instruments; in-copyright quotes stay pipeline-internal. */
  source_quote?: string;
  /** The same passage with surrounding context (also public-domain only). */
  expanded_source_quote?: string;
  /** Pipeline trigger classification (low/medium/high; absent when none). */
  trigger_level?: string;
}

/** The full book-obligations corpus (s30 extraction, one entry per obligation,
 * every instrument across the bundled verticals — personal-goals books and
 * startup pitch-deck canons) — the semantic matching anchor set, scoped per
 * scan by instrument. Release-pack detectors stay the only regex layer; the
 * catalog is meaning-matched. */
export const GOALS_CATALOG = goalsCatalogFile as unknown as {
  schema: string;
  version: string;
  obligation_count: number;
  obligations: CatalogObligation[];
  /** Per-instrument rights metadata from the pipeline manifests, written by
   * import_goals_catalog.py — drives the per-elevation disclaimer wording. */
  sources?: Record<
    string,
    {
      rights_status?: string;
      license?: string;
      title?: string;
      author?: string;
      author_domain?: string;
      source_url?: string;
    }
  >;
};

/** Pre-built anchor embeddings (embed_goals_catalog.py, index-aligned with
 * the catalog): fetched once as an immutable asset so the browser never
 * embeds obligations at scan time — the only realtime embedding is the
 * user's own document. Float16 halves decoded to float32. */
const CATALOG_VECTOR_DIMS = 384;

/** One prebuilt index per semantic model (embed_goals_catalog.py emits all
 * three, row-aligned with the catalog). The vectors are ~20 MB binaries and
 * ship from the enanoPacks bucket — NOT the SPA bundle — with the catalog
 * version stamped into the file name: the app can only ever fetch the index
 * that matches its bundled catalog, and a missing version simply 404s into
 * the runtime-embedding fallback instead of matching against a wrong-space
 * index. */
import outputs from "../../endpoints.json";

const storage = (outputs as { storage?: { bucket_name?: string; aws_region?: string } }).storage;
const VECTORS_BASE =
  storage?.bucket_name && storage?.aws_region
    ? `https://${storage.bucket_name}.s3.${storage.aws_region}.amazonaws.com/builtin-data/models/catalog-vectors`
    : "";

const VECTOR_STEMS: Record<string, string> = {
  "enano/pg-mnrl-47845708": "goals",
  "enano/spd-mnrl-48127877": "pitch",
  "Xenova/bge-small-en-v1.5": "base",
};

const VECTOR_URL_LOADERS: Record<string, () => Promise<string>> = Object.fromEntries(
  Object.entries(VECTOR_STEMS).map(([modelId, stem]) => [
    modelId,
    async () => `${VECTORS_BASE}/${stem}-catalog-vectors-${GOALS_CATALOG.version}.f16`,
  ])
);

const catalogVectorsByModel = new Map<string, Promise<Float32Array>>();

/** Load the prebuilt vector index for a model. There is NO runtime-embedding
 * fallback: without these vectors the semantic pass CANNOT run correctly
 * (silently re-embedding 26k anchors in-browser was a minutes-long crawl
 * that looked like a hang), so a load failure THROWS and the scan pipeline
 * degrades to the regex-only result with a visible notice. The failed
 * promise is uncached so the next scan retries the fetch (transient network). */
function loadCatalogVectors(modelId: string): Promise<Float32Array> {
  const cached = catalogVectorsByModel.get(modelId);
  if (cached) return cached;
  const load = (async (): Promise<Float32Array> => {
    try {
      const loader = VECTOR_URL_LOADERS[modelId] ?? VECTOR_URL_LOADERS["enano/pg-mnrl-47845708"];
      const url = await loader();
      const response = await fetch(url);
      if (!response.ok) throw new Error(`catalog vectors ${url} -> ${response.status}`);
      const vectors = decodeFloat16(new Uint16Array(await response.arrayBuffer()));
      const expected = GOALS_CATALOG.obligation_count * CATALOG_VECTOR_DIMS;
      if (vectors.length !== expected) {
        // A size mismatch means we got something that is not the vector
        // file — a stale index predating a catalog re-import, or an HTML
        // error page. Fail loudly rather than match against garbage.
        throw new Error(`catalog vectors size mismatch: ${vectors.length}/${expected}`);
      }
      return vectors;
    } catch (err) {
      console.error("[semantic] catalog vectors FAILED - semantic pass aborts (no runtime fallback)", err);
      throw err instanceof Error ? err : new Error(String(err));
    }
  })();
  // Cache successes only: a failed load stays uncached so the next scan
  // retries (transient network), while a good index is fetched once.
  load.then(
    () => catalogVectorsByModel.set(modelId, load),
    () => undefined
  );
  return load;
}

function decodeFloat16(halves: Uint16Array): Float32Array {
  const out = new Float32Array(halves.length);
  for (let i = 0; i < halves.length; i++) {
    const half = halves[i];
    const sign = half & 0x8000 ? -1 : 1;
    const exponent = (half >> 10) & 0x1f;
    const fraction = half & 0x3ff;
    out[i] =
      exponent === 0
        ? sign * 6.1e-5 * (fraction / 1024)
        : sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
  }
  return out;
}

/** Match tiers captured in falling passes: each pair is tagged with the
 * strictest tier it cleared, so users can drill from direct pairs down to
 * loose possibilities. Margins relax as floors drop — ambiguity matters less
 * the further we reach. Floors are calibrated against measured score bands
 * on the goals catalog (q8 bge-small): gibberish/unrelated input tops out
 * around 0.54-0.60 cosine, real paraphrases land 0.62-0.70, and a passage
 * quoting its own obligation scores 0.63+ (p5 0.75). Floors sit above the
 * noise ceiling so keyboard mash cannot pair, while genuine paraphrase
 * still reaches "related". */
export const SEMANTIC_TIERS = [
  { id: "direct", floor: 0.7, margin: 0.06 },
  { id: "related", floor: 0.62, margin: 0.03 },
  { id: "possible", floor: 0.55, margin: 0 },
] as const;
export type SemanticTier = (typeof SEMANTIC_TIERS)[number]["id"];

/** Tier floors are model-specific: the MNRL fine-tunes run on a different
 * cosine scale than base bge. Measured against each fine-tune's own index on
 * the demo docs — pg-mnrl: an unrelated sentence tops out ~0.59 while a real
 * goals doc puts half the catalog above 0.62, so 0.55 admitted 99% of it;
 * spd-mnrl: a 75-anchor catalog with a compressed scale where only margins
 * discriminate. Base bge keeps the legacy calibration above (funds, career). */
const MODEL_SEMANTIC_TIERS: Record<string, { id: SemanticTier; floor: number; margin: number }[]> = {
  "enano/pg-mnrl-47845708": [
    { id: "direct", floor: 0.7, margin: 0.06 },
    { id: "related", floor: 0.66, margin: 0.03 },
    { id: "possible", floor: 0.6, margin: 0 },
  ],
  "enano/spd-mnrl-48127877": [
    { id: "direct", floor: 0.72, margin: 0.06 },
    { id: "related", floor: 0.68, margin: 0.03 },
    { id: "possible", floor: 0.62, margin: 0 },
  ],
};

const tiersFor = (modelId?: string) => MODEL_SEMANTIC_TIERS[modelId ?? ""] ?? SEMANTIC_TIERS;

/** Anchor-pass admission caps: the top ANCHOR_ADMIT_TOP candidates by score
 * join the findings list outright; up to ANCHOR_ADMIT_PD_EXTRA more follow
 * from NON-copyrighted sources only, so in-copyright titles cannot crowd the
 * public-domain books out of the explorable tail. */
const ANCHOR_ADMIT_TOP = 500;
const ANCHOR_ADMIT_PD_EXTRA = 500;

const isCopyrightedInstrument = (instrument: string) =>
  GOALS_CATALOG.sources?.[instrument]?.rights_status === "copyrighted";
export const SEMANTIC_LOCATE_TOP_K = 5;
/** The single shared ladder origin: the semantic baseline cutoff IS the s2
 * filter bracket boundary. Both scales (cosine, confidence) deliberately
 * anchor to this one exported number so the admission funnel and the filter
 * buckets can never drift apart again — change it here and both move. */
export const S2_BRACKET_BOUNDARY = 0.45;
/** Cosine floor for cross-check candidates, tied to the s2 bracket boundary
 * above. History: 0.40 sat below the anisotropy baseline (gibberish paired
 * 36% of the catalog), 0.55 sat above it but starved the low buckets;
 * going lower is safe because sub-possible scores classify as the possible
 * tier, which is list-only and never paints or counts in chips. */
export const SEMANTIC_FLOOR = S2_BRACKET_BOUNDARY;
/** At or above this cosine a candidate graduates to an evidenced match. */
export const SEMANTIC_EVIDENCED_SCORE = 0.75;
/**
 * Ceiling on how many detectors the cross-check model ranks. The block
 * vectors are embedded once and cached, so each extra detector costs one
 * short anchor embedding plus free cosine — the cap is effectively
 * unbounded and the real flood protection is the score floor, runner-up
 * margin and confidence band.
 */
export const SEMANTIC_CHECK_CAP = 5000;

export interface SemanticEmbedder {
  embedQueries: (texts: string[]) => Promise<number[][]>;
  embedPassages: (texts: string[]) => Promise<number[][]>;
}

export interface VectorCache {
  get: (key: string) => Promise<Float32Array[] | null>;
  put: (key: string, vectors: Float32Array[]) => Promise<void>;
}

export interface SemanticProposal {
  label: string;
  docId: string;
  blockId: string;
  value: string;
  score: number;
}

export interface SemanticEnrichment {
  findings: DdqFinding[];
  datapointProposals: SemanticProposal[];
}

function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return Math.sqrt(na) * Math.sqrt(nb) === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Both sides of the anchor x block matrix are L2-normalized by construction
 * (the embedder runs normalize:true and the offline vector build normalizes),
 * so their cosine is a plain dot product — one multiply-add per dimension
 * instead of three, which matters across a 12k x 90 matrix. */
function dotNormalized(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) sum += a[i] * b[i];
  return sum;
}

function blockHasRegex(doc: DdqDocument, pattern: string, flags: string): boolean {
  const re = new RegExp(pattern, flags.includes("g") ? flags : `${flags}g`);
  for (const block of doc.blocks) {
    re.lastIndex = 0;
    if (re.test(block.text)) return true;
  }
  return false;
}

/** Question-matrix label -> candidate blocks per document (the locate step). */
export async function locateDatapointFields(
  docs: DdqDocument[],
  labels: string[],
  embedder: SemanticEmbedder,
  cache?: VectorCache
): Promise<{ label: string; docId: string; blockIndex: number; score: number }[]> {
  if (labels.length === 0 || docs.every((doc) => doc.blocks.length === 0)) return [];
  const labelVecs = await embedder.embedQueries(labels);
  const out: { label: string; docId: string; blockIndex: number; score: number }[] = [];
  for (const doc of docs) {
    if (doc.blocks.length === 0) continue;
    const key = `facts:${doc.id}:${doc.blocks.length}:${doc.blocks.reduce((acc, b) => acc + b.text.length, 0)}`;
    let vecs: Float32Array[] | null = cache ? await cache.get(key) : null;
    if (!vecs) {
      const fresh = await embedder.embedPassages(doc.blocks.map((b) => b.text));
      vecs = fresh.map((v) => Float32Array.from(v));
      if (cache) await cache.put(key, vecs);
    }
    for (let li = 0; li < labels.length; li++) {
      let best = -2;
      let bestBlock = -1;
      for (let bi = 0; bi < vecs.length; bi++) {
        const s = cosine(labelVecs[li], vecs[bi]);
        if (s > best) {
          best = s;
          bestBlock = bi;
        }
      }
      if (bestBlock >= 0) out.push({ label: labels[li], docId: doc.id, blockIndex: bestBlock, score: Math.round(best * 1000) / 1000 });
    }
  }
  return out;
}

const GENERIC_VALUE = /\b(?:GBP|EUR|USD|£|€|\$)\s?([\d.,]+)\s?(bn|billion|m|million)?\b|\b(\d{1,4})\s+(?:people|employees|staff)\b|\b((?:19|20)\d{2})\b/gi;

/** Propose values inside located blocks the strict regex did not capture. */
export function proposeSemanticValues(
  doc: DdqDocument,
  located: { label: string; docId: string; blockIndex: number; score: number }[],
  alreadyExtracted: (docId: string, label: string) => boolean,
  minScore = 0.5
): SemanticProposal[] {
  const out: SemanticProposal[] = [];
  for (const loc of located) {
    if (loc.docId !== doc.id || loc.score < minScore) continue;
    if (alreadyExtracted(doc.id, loc.label)) continue;
    const block = doc.blocks[loc.blockIndex];
    if (!block) continue;
    GENERIC_VALUE.lastIndex = 0;
    const match = GENERIC_VALUE.exec(block.text);
    if (match && match[0]) {
      out.push({ label: loc.label, docId: doc.id, blockId: block.id, value: match[0], score: loc.score });
    }
  }
  return out;
}

export interface SemanticCandidate {
  detectorId: string;
  obligationId: string;
  title: string;
  instrument: string;
  provisionId: string;
  blockIndex: number;
  score: number;
  margin: number;
  /** Tier whose floor+margin this pair cleared at capture. */
  tier: SemanticTier;
  /** anchor = obligation found its best block; block = paragraph surfaced this obligation. */
  direction: "anchor" | "block";
  /** exemplar-set query vs plain title anchor. */
  method: "exemplar" | "anchor";
  /** The obligation's own recommendation text (catalog obligation_text or
   * description); shown to the user instead of match narration. */
  advice?: string;
}

/** Map a cosine score above the floor onto a 0.35-0.95 confidence band, so a
 * strong semantic match can outrank a loose regex hit instead of being capped
 * below every regex finding. */
export function calibrateSemanticConfidence(score: number, floor: number): number {
  if (score <= floor) return 0.35;
  const t = Math.min(1, (score - floor) / (1 - floor));
  return Math.round((0.35 + 0.6 * t) * 100) / 100;
}

/**
 * Cross-check pass: ranks blocks against EVERY detector query (the merge in
 * the workspace fuses these with regex findings by confidence). Detectors with
 * an s65 exemplar set use the document-voice sentences as queries (rank-max
 * by default — the mode the nano harness should confirm); the rest fall back
 * to the title anchor. A candidate requires the top score to clear the floor
 * AND a margin over the runner-up.
 */
const EXEMPLAR_SCORING: "rank-max" | "pooled" = "rank-max";

/** Query vectors are pack-static (anchors + exemplar sets): embed once per
 * pack version, reuse across scans and documents. */
const queryVecCache = new Map<string, Float32Array[]>();

export interface SemanticProgress {
  phase: "index" | "match";
  done: number;
  total: number;
}

export interface SemanticAnchor {
  detectorId: string;
  obligationId: string;
  title: string;
  instrument: string;
  provisionId: string;
  anchor: string;
  exemplars?: string[];
  /** Precomputed anchor embedding (import-time build); skips runtime embedding. */
  vector?: Float32Array;
  /** Recommendation text carried through to the finding's guidance. */
  advice?: string;
}

export async function semanticCandidates(
  doc: DdqDocument,
  anchors: SemanticAnchor[],
  embedder: SemanticEmbedder,
  cache?: VectorCache,
  floor = SEMANTIC_FLOOR,
  onProgress?: (progress: SemanticProgress) => void,
  tiers: { id: SemanticTier; floor: number; margin: number }[] = [...SEMANTIC_TIERS]
): Promise<SemanticCandidate[]> {
  if (anchors.length === 0 || doc.blocks.length === 0) return [];
  const key = `check:${doc.id}:${doc.blocks.length}:${doc.blocks.reduce((acc, b) => acc + b.text.length, 0)}`;
  let blockVecs: Float32Array[] | null = cache ? await cache.get(key) : null;
  if (!blockVecs) {
    // Embed blocks in slices so the match-phase progress reflects the real
    // (slow) work — a single embedPassages call is opaque for its full
    // duration and the note sat motionless for the whole embedding.
    const texts = doc.blocks.map((b) => b.text);
    const EMBED_SLICE = 8;
    const embedded: number[][] = [];
    for (let start = 0; start < texts.length; start += EMBED_SLICE) {
      const fresh = await embedder.embedPassages(texts.slice(start, start + EMBED_SLICE));
      embedded.push(...fresh);
      onProgress?.({ phase: "match", done: Math.min(texts.length, start + EMBED_SLICE), total: texts.length });
    }
    blockVecs = embedded.map((v) => Float32Array.from(v));
    if (cache) await cache.put(key, blockVecs);
  }

  const queries: string[][] = anchors.map((a) =>
    a.exemplars && a.exemplars.length > 0 ? a.exemplars : [a.anchor]
  );
  const cacheKeyFor = (i: number) => `${RELEASE_PACK.version}::${anchors[i].detectorId}::${queries[i].length}`;
  const queryVecs: (Float32Array[] | null)[] = anchors.map((anchor, i) =>
    anchor.vector ? [anchor.vector] : (queryVecCache.get(cacheKeyFor(i)) ?? null)
  );
  const missIdx: number[] = [];
  queries.forEach((qs, i) => {
    if (!queryVecs[i]) missIdx.push(i);
  });
  if (missIdx.length > 0) {
    // Anchor embeddings are the expensive one-time cost (12k+ texts): embed
    // in slices so the caller can surface live progress to the user.
    const SLICE = 256;
    const alreadyIndexed = anchors.length - missIdx.length;
    for (let start = 0; start < missIdx.length; start += SLICE) {
      const slice = missIdx.slice(start, start + SLICE);
      const texts = slice.flatMap((i) => queries[i]);
      const fresh = await embedder.embedQueries(texts);
      let cursor = 0;
      for (const i of slice) {
        const vecs = fresh.slice(cursor, cursor + queries[i].length).map((v) => Float32Array.from(v));
        queryVecCache.set(cacheKeyFor(i), vecs);
        queryVecs[i] = vecs;
        cursor += queries[i].length;
      }
      onProgress?.({ phase: "index", done: alreadyIndexed + start + slice.length, total: anchors.length });
    }
  }
  onProgress?.({ phase: "match", done: 0, total: anchors.length });

  // Full anchor x block cosine matrix: one pass feeds both directions —
  // tiered anchor capture below, and the transposed block-direction pass.
  const blockCount = blockVecs.length;
  const matrix: Float64Array[] = [];
  const PROGRESS_EVERY = 2048;
  for (let ai = 0; ai < anchors.length; ai++) {
    const vecs = queryVecs[ai] ?? [];
    const row = new Float64Array(blockCount);
    if (vecs.length === 1 || EXEMPLAR_SCORING === "pooled") {
      for (let bi = 0; bi < blockCount; bi++) row[bi] = dotNormalized(vecs[0], blockVecs[bi]);
    } else if (vecs.length > 1) {
      for (const query of vecs) {
        for (let bi = 0; bi < blockCount; bi++) {
          const s = dotNormalized(query, blockVecs[bi]);
          if (s > row[bi]) row[bi] = s;
        }
      }
    }
    matrix.push(row);
    if ((ai + 1) % PROGRESS_EVERY === 0) {
      onProgress?.({ phase: "match", done: ai + 1, total: anchors.length });
    }
  }
  onProgress?.({ phase: "match", done: anchors.length, total: anchors.length });

  const round3 = (n: number) => Math.round(n * 1000) / 1000;
  const methodOf = (a: (typeof anchors)[number]): "exemplar" | "anchor" =>
    a.exemplars && a.exemplars.length > 0 ? "exemplar" : "anchor";
  const tierFor = (score: number): SemanticTier =>
    tiers.find((tier) => score >= tier.floor)?.id ?? "possible";

  const out: SemanticCandidate[] = [];
  const paired = new Set<string>();

  // Anchor direction: each obligation captures its best block, admitted at
  // the model's possible floor — then rank-capped, because a real document
  // pairs nearly the whole catalog at these floors (measured: 99% of the
  // goals catalog cleared the legacy 0.55). Top ANCHOR_ADMIT_TOP by score
  // join outright; after that only non-copyrighted sources keep filling so
  // the public-domain books stay explorable when in-copyright titles
  // dominate the head of the ranking.
  const tierFloor = tiers[tiers.length - 1].floor;
  const hits: { ai: number; bestBi: number; best: number; margin: number }[] = [];
  for (let ai = 0; ai < anchors.length; ai++) {
    const row = matrix[ai];
    let best = -Infinity;
    let runnerUp = -Infinity;
    let bestBi = -1;
    for (let bi = 0; bi < blockCount; bi++) {
      const s = row[bi];
      if (s > best) {
        runnerUp = best;
        best = s;
        bestBi = bi;
      } else if (s > runnerUp) {
        runnerUp = s;
      }
    }
    if (bestBi < 0 || best < tierFloor) continue;
    hits.push({ ai, bestBi, best, margin: best - (blockCount > 1 ? runnerUp : 0) });
  }
  hits.sort((a, b) => b.best - a.best);
  const admitted: typeof hits = [];
  let publicDomainExtra = 0;
  for (const hit of hits) {
    if (admitted.length < ANCHOR_ADMIT_TOP) {
      admitted.push(hit);
    } else if (
      publicDomainExtra < ANCHOR_ADMIT_PD_EXTRA &&
      !isCopyrightedInstrument(anchors[hit.ai].instrument)
    ) {
      admitted.push(hit);
      publicDomainExtra++;
    }
  }
  for (const hit of admitted) {
    const tier = tiers.find((t) => hit.best >= t.floor && hit.margin >= t.margin) ?? tiers[tiers.length - 1];
    paired.add(`${hit.ai}:${hit.bestBi}`);
    out.push({
      detectorId: anchors[hit.ai].detectorId,
      obligationId: anchors[hit.ai].obligationId,
      title: anchors[hit.ai].title,
      instrument: anchors[hit.ai].instrument,
      provisionId: anchors[hit.ai].provisionId,
      blockIndex: hit.bestBi,
      score: round3(hit.best),
      margin: round3(hit.margin),
      tier: tier.id,
      direction: "anchor",
      method: methodOf(anchors[hit.ai]),
      advice: anchors[hit.ai].advice,
    });
  }

  // Block direction: each vectorized paragraph surfaces its closest
  // obligations (top three above the loosest floor) that the anchor pass did
  // not already pair with that block. Over-pairs on purpose — the user
  // filters by tier, direction and method tags on each finding.
  for (let bi = 0; bi < blockCount; bi++) {
    const column: { ai: number; score: number }[] = [];
    for (let ai = 0; ai < anchors.length; ai++) {
      const s = matrix[ai][bi];
      if (s >= Math.max(floor, tierFloor)) column.push({ ai, score: s });
    }
    column.sort((a, b) => b.score - a.score);
    for (let rank = 0; rank < Math.min(3, column.length); rank++) {
      const { ai, score } = column[rank];
      if (paired.has(`${ai}:${bi}`)) continue;
      paired.add(`${ai}:${bi}`);
      // Real runner-up gap for block-direction picks (was hardcoded 0):
      // the distance to the next-best obligation for this block is the
      // selectivity signal the blended confidence uses.
      const nextScore = column[rank + 1]?.score ?? score;
      out.push({
        detectorId: anchors[ai].detectorId,
        obligationId: anchors[ai].obligationId,
        title: anchors[ai].title,
        instrument: anchors[ai].instrument,
        provisionId: anchors[ai].provisionId,
        blockIndex: bi,
        score: round3(score),
        margin: round3(Math.max(0, score - nextScore)),
        tier: tierFor(score),
        direction: "block",
        method: methodOf(anchors[ai]),
        advice: anchors[ai].advice,
      });
    }
  }
  return out;
}

/** Convert a candidate into a workspace finding. Confidence blends two
 * signals the pass already computes — cosine distance to the anchor and the
 * runner-up margin (0.06 = the direct-tier margin saturates it):
 * near-floor candidates with no margin (generic topical overlap) stay low,
 * mid-cosine candidates that actually discriminate climb the middle tiers.
 * Candidates at or above SEMANTIC_EVIDENCED_SCORE still graduate to
 * evidenced matches; weaker ones stay review-only candidates. */
export function candidateToFinding(
  doc: DdqDocument,
  candidate: SemanticCandidate,
  matchDisplay: string,
  floor = SEMANTIC_FLOOR
): DdqFinding {
  const block = doc.blocks[candidate.blockIndex];
  const t = Math.max(0, Math.min(1, (candidate.score - floor) / (1 - floor)));
  const marginFactor = Math.max(0, Math.min(1, candidate.margin / SEMANTIC_TIERS[0].margin));
  const confidence =
    candidate.score <= floor
      ? 0.35
      : Math.round((0.35 + 0.6 * (0.7 * t + 0.3 * marginFactor)) * 100) / 100;
  const evidenced = candidate.score >= SEMANTIC_EVIDENCED_SCORE;
  return {
    obligation_id: candidate.obligationId,
    content_fingerprint: `sem:${candidate.detectorId}:${doc.id}:${block?.id ?? candidate.blockIndex}`,
    instrument: candidate.instrument,
    provision_id: candidate.provisionId,
    title: candidate.title,
    weak_signal: "semantic",
    match_strength: evidenced ? "specific" : "loose",
    confidence,
    matched_detectors: [candidate.detectorId],
    matched_count: 1,
    total_count: 1,
    match_tier: candidate.tier,
    capture_score: candidate.score,
    match_direction: candidate.direction,
    match_method: candidate.method,
    section: block?.text.slice(0, 60) ?? "Document",
    page: block?.page ?? 1,
    excerpt: block?.text.slice(0, 200) ?? "",
    matches: [
      {
        detector_id: candidate.detectorId,
        origin: "semantic",
        match_display: matchDisplay,
        strength: "loose",
        char_offset: 0,
        block_id: block?.id ?? "",
        excerpt: block?.text.slice(0, 200) ?? "",
        matched_text: block?.text.slice(0, 80) ?? "",
        section: block?.text.slice(0, 60) ?? "Document",
        page: block?.page ?? 1,
        in_reference_section: false,
        score: confidence,
      },
    ],
    guidance: {
      match_display: matchDisplay,
      gap_actions: candidate.advice
        ? [{ text: candidate.advice, vessel_types: ["all"] }]
        : [],
      self_check_questions: [],
    },
    severity: "low" as DdqSeverity,
    category: evidenced ? "evidenced" : "missing_disclosure",
    block_id: block?.id ?? "",
    target_text: block?.text.slice(0, 80) ?? "",
    replacement_text: block?.text.slice(0, 80) ?? "",
  };
}

interface CheckTarget {
  detectorId: string;
  obligationId: string;
  title: string;
  instrument: string;
  provisionId: string;
  anchor: string;
  /** s65 document-voice rescue queries; absent -> fall back to `anchor`. */
  exemplars?: string[];
  matchDisplay: string;
  patterns: { regex: string; flags: string }[];
  /** Prefer detectors whose gate/theme fired but match-role did not. */
  priority: number;
}

/**
 * Build the cross-check target list: every in-scope detector, authored span
 * detectors first, then release detectors whose gate/theme fired, then the
 * rest — the merge fuses results with regex by confidence, so detectors the
 * regex pack already hit still get a semantic vote.
 */export function buildCheckTargets(
  doc: DdqDocument,
  cap = SEMANTIC_CHECK_CAP,
  instruments?: Set<string>
): CheckTarget[] {
  const targets: CheckTarget[] = [];

  if (!instruments) {
    for (const detector of FUND_DOCS_PACK.spanDetectors) {
      targets.push({
        detectorId: detector.id,
        obligationId: detector.obligation_id,
        title: detector.title,
        instrument: detector.instrument,
        provisionId: detector.provision_id,
        anchor: `${detector.title}: ${detector.guidance.match_display}`,
        matchDisplay: detector.guidance.match_display,
        patterns: [{ regex: detector.pattern, flags: detector.flags }],
        priority: 0,
      });
    }
  }

  for (const detector of RELEASE_PACK.detectors) {
    if (instruments && !instruments.has(detector.instrument)) continue;
    const matchPatterns = detector.patterns
      .filter((pattern) => pattern.role === "match")
      .map((pattern) => ({ regex: pattern.regex, flags: pattern.flags }));
    const gatePatterns = detector.patterns
      .filter((pattern) => pattern.role === "gate_only")
      .map((pattern) => ({ regex: pattern.regex, flags: pattern.flags }));
    const gateHit =
      gatePatterns.some((pattern) => blockHasRegex(doc, pattern.regex, pattern.flags)) ||
      detector.theme_probes.some((probe) => blockHasRegex(doc, probe.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
    const matchDisplay = detector.match_display || detector.title;
    targets.push({
      detectorId: detector.obligation_id,
      obligationId: detector.obligation_id,
      title: detector.title,
      instrument: detector.instrument,
      provisionId: detector.provision_id,
      anchor: `${detector.title}: ${matchDisplay}`,
      exemplars:
        detector.exemplar_sentences && detector.exemplar_sentences.length > 0
          ? detector.exemplar_sentences
          : undefined,
      matchDisplay,
      patterns: matchPatterns,
      priority: gateHit ? 1 : 2,
    });
  }

  targets.sort((a, b) => a.priority - b.priority || a.detectorId.localeCompare(b.detectorId));

  // Round-robin by instrument within the remaining budget so one rulebook cannot dominate.
  const selected: CheckTarget[] = [];
  const byInstrument = new Map<string, CheckTarget[]>();
  for (const target of targets) {
    const list = byInstrument.get(target.instrument) ?? [];
    list.push(target);
    byInstrument.set(target.instrument, list);
  }
  const queues = [...byInstrument.values()];
  let guard = 0;
  while (selected.length < cap && queues.some((queue) => queue.length > 0) && guard < cap * 4) {
    for (const queue of queues) {
      if (selected.length >= cap) break;
      const next = queue.shift();
      if (next) selected.push(next);
    }
    guard += 1;
  }
  return selected;
}

/**
 * Run both models after the regex engine. Regex findings are never modified —
 * this only APPENDS semantic candidates and datapoint proposals.
 */
export async function enrichDocumentSemantics(
  doc: DdqDocument,
  facts: SemanticEmbedder,
  check: SemanticEmbedder,
  options?: {
    cache?: VectorCache;
    checkCap?: number;
    instruments?: Set<string>;
    /** Which semantic model the scan loaded — selects the matching prebuilt
     * anchor index (see VECTOR_URL_LOADERS). Anchors and queries must be
     * embedded by the same model. */
    modelId?: string;
    onProgress?: (progress: SemanticProgress) => void;
    /** Skip the facts (question-matrix) pass: saves embedding every question
     * label plus the document a second time. Consumers that ignore
     * datapointProposals (the playground) should set this. */
    skipFacts?: boolean;
  }
): Promise<SemanticEnrichment> {
  if (doc.blocks.length === 0) return { findings: [], datapointProposals: [] };

  let datapointProposals: SemanticProposal[] = [];
  if (!options?.skipFacts) {
    const queryLabels = QUESTION_MATRIX.questions.map((question) =>
      question.description ? `${question.label}: ${question.description}` : question.label
    );
    const located = await locateDatapointFields([doc], queryLabels, facts, options?.cache);
    const locatedByLabel = located.map((loc, i) => ({
      ...loc,
      label: QUESTION_MATRIX.questions[i].label,
    }));

    const regexGroups = extractDatapoints([doc]);
    const extractedLabels = new Set(regexGroups.map((group) => group.label));
    datapointProposals = proposeSemanticValues(
      doc,
      locatedByLabel,
      (docId, label) => docId === doc.id && extractedLabels.has(label),
      0.5
    );
  }

  const targets = buildCheckTargets(doc, options?.checkCap ?? SEMANTIC_CHECK_CAP, options?.instruments);
  const anchors: SemanticAnchor[] = targets.map(({ detectorId, obligationId, title, instrument, provisionId, anchor, exemplars }) => ({
    detectorId,
    obligationId,
    title,
    instrument,
    provisionId,
    anchor,
    exemplars,
  }));
  const displayByDetector = new Map(targets.map((target) => [target.detectorId, target.matchDisplay]));
  const catalogVectors = await loadCatalogVectors(
    options?.modelId ?? "enano/pg-mnrl-47845708"
  );
  if (options?.instruments) {
    for (let index = 0; index < GOALS_CATALOG.obligations.length; index++) {
      const entry = GOALS_CATALOG.obligations[index];
      if (!options.instruments.has(entry.instrument)) continue;
      const detectorId = `cat:${entry.obligation_id}`;
      anchors.push({
        detectorId,
        obligationId: entry.obligation_id,
        title: entry.title,
        instrument: entry.instrument,
        provisionId: entry.provision_id,
        anchor: `${entry.title}: ${entry.description}`,
        exemplars: undefined,
        advice: entry.obligation_text || entry.description,
        vector: catalogVectors.subarray(index * CATALOG_VECTOR_DIMS, (index + 1) * CATALOG_VECTOR_DIMS),
      });
      displayByDetector.set(detectorId, entry.description);
    }
  }
  const candidates = await semanticCandidates(
    doc,
    anchors,
    check,
    options?.cache,
    SEMANTIC_FLOOR,
    options?.onProgress,
    tiersFor(options?.modelId)
  );
  const findings = candidates.map((candidate) =>
    candidateToFinding(doc, candidate, displayByDetector.get(candidate.detectorId) ?? candidate.title)
  );

  return { findings, datapointProposals };
}

export type DetectionMethod = "regex" | "cross_check" | "both";

/** Which layer produced this finding — regex pack, cross-check model, or both (sibling hits). */
export function detectionMethodFor(finding: DdqFinding, siblings: DdqFinding[] = []): DetectionMethod {
  const isSemantic =
    finding.weak_signal === "semantic" || finding.matches?.some((match) => match.origin === "semantic") === true;
  const sameObligation = siblings.filter(
    (sibling) =>
      sibling.obligation_id === finding.obligation_id &&
      sibling.content_fingerprint !== finding.content_fingerprint
  );
  const hasRegexSibling = sameObligation.some((sibling) => sibling.weak_signal !== "semantic");
  const hasSemanticSibling = sameObligation.some(
    (sibling) => sibling.weak_signal === "semantic" || sibling.matches?.some((match) => match.origin === "semantic")
  );
  if (isSemantic && hasRegexSibling) return "both";
  if (!isSemantic && hasSemanticSibling) return "both";
  if (isSemantic) return "cross_check";
  return "regex";
}

/** Merge semantic proposals into regex datapoint groups without changing the group schema. */
export function mergeSemanticDatapoints(groups: DatapointGroup[], proposals: SemanticProposal[], docs: DdqDocument[]): DatapointGroup[] {
  if (proposals.length === 0) return groups;
  const docName = new Map(docs.map((doc) => [doc.id, doc.filename]));
  const docBlocks = new Map(docs.map((doc) => [doc.id, new Map(doc.blocks.map((block) => [block.id, block.text]))]));
  const out = groups.map((group) => ({ ...group, values: group.values.map((value) => ({ ...value, hits: [...value.hits] })) }));
  const byLabel = new Map(out.map((group) => [group.label, group]));

  for (const proposal of proposals) {
    const existing = byLabel.get(proposal.label);
    const key = `sem:${proposal.value.toLowerCase()}`;
    const filename = docName.get(proposal.docId) ?? proposal.docId;
    const blockText = docBlocks.get(proposal.docId)?.get(proposal.blockId) ?? proposal.value;
    const excerpt =
      blockText.length <= 180
        ? blockText
        : (() => {
            const at = blockText.toLowerCase().indexOf(proposal.value.toLowerCase().slice(0, 12));
            if (at < 0) return `${blockText.slice(0, 160).trim()}…`;
            const from = Math.max(0, at - 50);
            const to = Math.min(blockText.length, at + proposal.value.length + 50);
            return `${from > 0 ? "…" : ""}${blockText.slice(from, to).replace(/\s+/g, " ").trim()}${to < blockText.length ? "…" : ""}`;
          })();
    const hit = {
      docId: proposal.docId,
      docFilename: filename,
      blockId: proposal.blockId,
      matchedText: proposal.value,
      excerpt,
      date: null as string | null,
      method: "facts" as const,
    };
    if (existing) {
      if (existing.values.some((value) => value.display === proposal.value || value.key === key)) continue;
      existing.values.push({
        key,
        display: proposal.value,
        date: null,
        docFilenames: [filename],
        occurrences: 1,
        excerpt,
        hits: [hit],
      });
      continue;
    }
    const question = QUESTION_MATRIX.questions.find((entry) => entry.label === proposal.label);
    if (!question) continue;
    const group: DatapointGroup = {
      questionId: question.id,
      label: question.label,
      instrument: question.instrument,
      scope: "semantic",
      values: [
        {
          key,
          display: proposal.value,
          date: null,
          docFilenames: [filename],
          occurrences: 1,
          excerpt,
          hits: [hit],
        },
      ],
      consistent: true,
    };
    out.push(group);
    byLabel.set(group.label, group);
  }
  return out;
}
