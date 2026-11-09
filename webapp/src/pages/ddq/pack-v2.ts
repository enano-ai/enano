/**
 * Release-pack interpreter: runs the compiled document-pipeline obligation
 * packs (packs/release, compiled by scripts/import_fund_docs_packs.py)
 * against a document. Same semantics family as the marine Obligation Checker:
 * `match` patterns evidence the obligation, `gate_only` patterns locate the
 * topic, `absence` patterns evidence it is NOT met. An obligation that is
 * located but not evidenced becomes a finding; an evidenced one counts green.
 *
 * The detector blob is NOT bundled — it is fetched via `/fund-docs-packs` and
 * registered with `registerReleasePack()`. Counts/labels come from the slim
 * manifest so CI/Vite never parse the multi-MB JSON.
 */
import type { DdqDocument, DdqFinding, DdqIssueCategory, DdqSeverity } from "./ddq-mock-data";
import manifestRaw from "./packs/fund-docs-manifest.json";

export interface ReleasePattern {
  id: string;
  regex: string;
  flags: string;
  strength: "strong" | "specific" | "loose";
  role: "match" | "gate_only" | "veto" | "absence";
  surface?: string | null;
  priority?: number;
  match_display?: string | null;
  /** document-pipeline Rule S5 — corpus | corpus_mined | authored | … */
  origin?: string;
  /** Join to corpus: flip:real_uploads/… | near-miss:real_uploads/… | instrument/… */
  origin_ref?: string;
  added_at?: string;
  version?: number;
}

export interface ReleaseDetector {
  obligation_id: string;
  content_fingerprint: string;
  /** Pipeline obligation ids this group wraps — the caveat-lookup join key. */
  source_obligation_ids?: string[];
  instrument: string;
  provision_id: string;
  title: string;
  match_display: string;
  evidence_policy: string;
  theme_probes: string[];
  required_surfaces: string[];
  /** Path under packs/release/ — join key back to the duty JSON. */
  pack_relpath?: string;
  /** s65 document-voice rescue queries — embedded instead of the title anchor
   * by the semantic cross-check when present (webapp contract, TODO v13). */
  exemplar_sentences?: string[];
  /** Pre-generated s65 sibling-separation scores (eval-harness data). */
  exemplar_scores?: { pooled: number | null; rank_max: number | null };
  flipping_manual?: string;
  score_merged_corpus_fingerprint?: string;
  corpus?: string;
  corpus_scope?: string;
  method?: string;
  patterns: ReleasePattern[];
}

export interface ReleasePackFile {
  schema: string;
  id: string;
  version: string;
  generated_at: string;
  source: string;
  pack_files: number;
  instruments: { instrument: string; label: string; groups: number; patterns: number }[];
  detectors: ReleaseDetector[];
}

interface FundDocsManifest {
  schema: string;
  id: string;
  version: string;
  generated_at: string;
  source: string;
  detector_count: number;
  pattern_count: number;
  rulebook_count: number;
  pack_files: number;
  instruments: {
    instrument: string;
    label: string;
    groups: number;
    patterns: number;
    corpus_obligations?: number | null;
  }[];
  corpus_obligations: Record<string, number>;
}

export const FUND_DOCS_MANIFEST = manifestRaw as FundDocsManifest;

const emptyPack = (): ReleasePackFile => ({
  schema: "fund_docs_detectors.v1",
  id: FUND_DOCS_MANIFEST.id,
  version: FUND_DOCS_MANIFEST.version,
  generated_at: FUND_DOCS_MANIFEST.generated_at,
  source: FUND_DOCS_MANIFEST.source,
  pack_files: FUND_DOCS_MANIFEST.pack_files,
  instruments: FUND_DOCS_MANIFEST.instruments.map(({ instrument, label, groups, patterns }) => ({
    instrument,
    label,
    groups,
    patterns,
  })),
  detectors: [],
});

/** Live pack — empty until `registerReleasePack` / `loadFundDocsPacks`. */
export let RELEASE_PACK: ReleasePackFile = emptyPack();

/** Swap in detectors fetched from the API (or a test fixture). */
export function registerReleasePack(pack: ReleasePackFile): void {
  RELEASE_PACK = pack;
}

export const RELEASE_PACK_VERSION = FUND_DOCS_MANIFEST.version;
export const RELEASE_DETECTOR_COUNT = FUND_DOCS_MANIFEST.detector_count;

/** Marketing/claims numbers — DERIVED from the slim manifest, never hardcoded. */
export const RELEASE_PATTERN_COUNT = FUND_DOCS_MANIFEST.pattern_count;
/** Rulebooks with live detectors in the pack (what actually runs on a document). */
export const RELEASE_RULEBOOK_COUNT = FUND_DOCS_MANIFEST.rulebook_count;

export interface DocumentedObligation {
  obligation_id: string;
  /** Corpus obligation fingerprint — the advice-pack join key. */
  content_fingerprint?: string;
  title: string;
  match_display: string;
  provision_id: string;
  instrument: string;
  /** First strong hit on this block (span is block-relative) so the evidenced
   * finding can show what actually matched instead of the whole line. */
  hit?: { start: number; end: number; matched: string };
}

export interface InstrumentCoverage {
  evaluated: number;
  documented: number;
  findings: number;
  documented_titles?: DocumentedObligation[];
}

export interface DocumentedBlock {
  blockId: string;
  obligations: DocumentedObligation[];
}

export interface ReleasePackResult {
  findings: DdqFinding[];
  coverage: Record<string, InstrumentCoverage>;
  /** Per-block evidence details for green overlays and the detail modal. */
  documentedBlocks: DocumentedBlock[];
}

interface SpanHit {
  blockIndex: number;
  blockId: string;
  blockText: string;
  start: number;
  end: number;
  matched: string;
  page: number | null;
}

/** Cap topic-only weak signals PER convention so early instruments cannot
 * starve later ones (SFDR/Fund names/etc.) out of the issues panel. */
const MAX_TOPIC_ONLY_PER_INSTRUMENT = 15;

/** Cap distinct evidence blocks per evidenced detector: the playground row
 * unions matches anyway, and unbounded entries would balloon the findings
 * list for keyword patterns that fire across a whole document. */
const MAX_EVIDENCED_BLOCKS = 12;

const regexCache = new Map<string, RegExp>();

function patternRegex(pattern: ReleasePattern): RegExp {
  const key = `${pattern.id}::${pattern.regex}`;
  let re = regexCache.get(key);
  if (!re) {
    re = new RegExp(pattern.regex, `${pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g"}`);
    regexCache.set(key, re);
  }
  re.lastIndex = 0;
  return re;
}

function scanDoc(doc: DdqDocument, pattern: ReleasePattern): SpanHit[] {
  const re = patternRegex(pattern);
  const out: SpanHit[] = [];
  doc.blocks.forEach((block, blockIndex) => {
    re.lastIndex = 0;
    let hit: RegExpExecArray | null;
    while ((hit = re.exec(block.text)) !== null) {
      if (hit[0].length === 0) {
        re.lastIndex += 1;
        continue;
      }
      out.push({
        blockIndex,
        blockId: block.id,
        blockText: block.text,
        start: hit.index,
        end: hit.index + hit[0].length,
        matched: hit[0],
        page: block.page ?? null,
      });
      if (out.length >= 8) return;
    }
  });
  return out;
}

function themeHit(doc: DdqDocument, probes: string[]): SpanHit | null {
  for (const probe of probes) {
    if (!probe) continue;
    const needle = probe.toLowerCase();
    for (let blockIndex = 0; blockIndex < doc.blocks.length; blockIndex++) {
      const block = doc.blocks[blockIndex];
      const at = block.text.toLowerCase().indexOf(needle);
      if (at >= 0) {
        return { blockIndex, blockId: block.id, blockText: block.text, start: at, end: at + probe.length, matched: block.text.slice(at, at + probe.length), page: block.page ?? null };
      }
    }
  }
  return null;
}

function clampSpan(text: string, max = 140): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const at = cut.lastIndexOf(" ");
  return (at > 40 ? cut.slice(0, at) : cut).trimEnd();
}

function excerptAround(text: string, start: number, end: number, radius = 70): string {
  const from = Math.max(0, start - radius);
  const to = Math.min(text.length, end + radius);
  return `${from > 0 ? "…" : ""}${text.slice(from, to).replace(/\s+/g, " ").trim()}${to < text.length ? "…" : ""}`;
}

function blockSection(doc: DdqDocument, blockIndex: number): string {
  for (let i = blockIndex; i >= 0; i--) {
    if (doc.blocks[i].kind === "section") return doc.blocks[i].text.slice(0, 60);
  }
  return doc.blocks[0]?.text.slice(0, 60) ?? "Document";
}

function fingerprint(seed: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function finding(
  doc: DdqDocument,
  detector: ReleaseDetector,
  anchor: SpanHit,
  kind: "absence" | "topic_only" | "partial",
  evidence: SpanHit[]
): DdqFinding {
  const severity: DdqSeverity = kind === "absence" ? "high" : kind === "topic_only" ? "medium" : "low";
  const category: DdqIssueCategory = "missing_disclosure";
  const target = clampSpan(anchor.matched);
  const confidence = kind === "absence" ? 0.74 : kind === "topic_only" ? 0.6 : 0.55;
  return {
    obligation_id: detector.obligation_id,
    corpus_fingerprint: detector.content_fingerprint,
    content_fingerprint: fingerprint(`${detector.obligation_id}:${doc.id}:${anchor.blockId}`),
    instrument: detector.instrument,
    provision_id: detector.provision_id,
    title: detector.title,
    weak_signal: kind === "topic_only" ? "topic_only" : "partial",
    match_strength: kind === "absence" ? "strong" : "loose",
    confidence,
    matched_detectors: [detector.obligation_id],
    matched_count: evidence.length || 1,
    total_count: detector.patterns.length,
    section: blockSection(doc, anchor.blockIndex),
    page: anchor.page ?? 1,
    excerpt: excerptAround(anchor.blockText, anchor.start, anchor.end),
    matches: [anchor, ...evidence].slice(0, 6).map((hit) => ({
      detector_id: detector.obligation_id,
      origin: "release-pack",
      match_display: detector.match_display || detector.title,
      strength: kind === "absence" ? ("strong" as const) : ("loose" as const),
      char_offset: hit.start,
      block_id: hit.blockId,
      excerpt: excerptAround(hit.blockText, hit.start, hit.end),
      matched_text: hit.matched,
      section: blockSection(doc, hit.blockIndex),
      page: hit.page ?? 1,
      in_reference_section: false,
      score: confidence,
    })),
    guidance: {
      match_display: detector.match_display || detector.title,
      gap_actions: [],
      self_check_questions: [],
    },
    severity,
    category,
    block_id: anchor.blockId,
    target_text: target,
    replacement_text: target,
  };
}


const KV_NEGATION = /not\s+applicable|\bn\.?a\.?\b|does\s+not\s+apply|not\s+classified|no\s+sustainability|outside\s+the\s+scope|does\s+not\s+currently/i;

/**
 * Deterministic key-value negation check: if any gate/theme pattern fires
 * on a block that is a detected key-value pair, and the VALUE column
 * contains a negation phrase, the obligation is considered explicitly
 * addressed (the document answered the question with "not applicable").
 */
function kvNegatedBlock(doc: DdqDocument, detector: ReleaseDetector): string | null {
  const gatePatterns = [
    ...detector.patterns.filter((p) => p.role === "gate_only").map((p) => new RegExp(p.regex, p.flags)),
    ...detector.theme_probes.map((probe) => new RegExp(probe.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")),
  ];
  if (gatePatterns.length === 0) return null;
  for (const block of doc.blocks) {
    if (!block.kv) continue;
    const labelMatch = gatePatterns.some((re) => re.test(block.kv!.label));
    if (labelMatch && KV_NEGATION.test(block.kv.value)) {
      return block.id;
    }
  }
  return null;
}

export function runReleasePack(doc: DdqDocument): ReleasePackResult {
  const findings: DdqFinding[] = [];
  const coverage: Record<string, InstrumentCoverage> = {};
  const documentedBlocksMap = new Map<string, DocumentedBlock>();
  const topicOnlyByInstrument = new Map<string, number>();

  for (const detector of RELEASE_PACK.detectors) {
    const cov = (coverage[detector.instrument] ??= { evaluated: 0, documented: 0, findings: 0 });
    cov.evaluated += 1;

    const evidence: SpanHit[] = [];
    const loose: SpanHit[] = [];
    const gates: SpanHit[] = [];
    const absence: SpanHit[] = [];

    for (const pattern of detector.patterns) {
      const hits = scanDoc(doc, pattern);
      if (hits.length === 0) continue;
      if (pattern.role === "absence") absence.push(...hits);
      else if (pattern.role === "match") {
        if (pattern.strength === "loose") loose.push(...hits);
        else evidence.push(...hits);
      } else if (pattern.role === "gate_only") gates.push(...hits);
    }

    if (absence.length > 0) {
      cov.findings += 1;
      findings.push(finding(doc, detector, absence[0], "absence", absence.slice(1)));
      continue;
    }
    if (evidence.length > 0) {
      cov.documented += 1;
      // Every distinct hit block is documented, not just the first: keeping
      // only evidence[0] threw away real matches (a detector firing on five
      // lines showed one evidence item and hid the other four hits from the
      // drill-down). One span per block — the first hit on it.
      const seenBlocks = new Set<string>();
      for (const hit of evidence) {
        if (seenBlocks.has(hit.blockId)) continue;
        if (seenBlocks.size >= MAX_EVIDENCED_BLOCKS) break;
        seenBlocks.add(hit.blockId);
        const entry = documentedBlocksMap.get(hit.blockId) ?? { blockId: hit.blockId, obligations: [] };
        if (entry.obligations.length < 10) {
          entry.obligations.push({
            obligation_id: detector.obligation_id,
            content_fingerprint: detector.content_fingerprint,
            title: detector.title,
            match_display: detector.match_display || detector.title,
            provision_id: detector.provision_id,
            instrument: detector.instrument,
            hit: { start: hit.start, end: hit.end, matched: hit.matched },
          });
        }
        documentedBlocksMap.set(hit.blockId, entry);
      }
      if ((cov.documented_titles?.length ?? 0) < 60) {
        cov.documented_titles = [
          ...(cov.documented_titles ?? []),
          {
            obligation_id: detector.obligation_id,
            content_fingerprint: detector.content_fingerprint,
            title: detector.title,
            match_display: detector.match_display || detector.title,
            provision_id: detector.provision_id,
            instrument: detector.instrument,
          },
        ];
      }
      continue;
    }
    if (evidence.length === 0) {
      const negatedBlockId = kvNegatedBlock(doc, detector);
      if (negatedBlockId !== null) {
        cov.documented += 1;
        const entry = documentedBlocksMap.get(negatedBlockId) ?? { blockId: negatedBlockId, obligations: [] };
        if (entry.obligations.length < 10) {
          entry.obligations.push({
            obligation_id: detector.obligation_id,
            content_fingerprint: detector.content_fingerprint,
            title: detector.title + " (explicitly addressed)",
            match_display: detector.match_display || detector.title,
            provision_id: detector.provision_id,
            instrument: detector.instrument,
          });
        }
        documentedBlocksMap.set(negatedBlockId, entry);
        if ((cov.documented_titles?.length ?? 0) < 60) {
          cov.documented_titles = [
            ...(cov.documented_titles ?? []),
            {
              obligation_id: detector.obligation_id,
              content_fingerprint: detector.content_fingerprint,
              title: detector.title + " (explicitly addressed)",
              match_display: detector.match_display || detector.title,
              provision_id: detector.provision_id,
              instrument: detector.instrument,
            },
          ];
        }
        continue;
      }
    }
    const themed = gates.length > 0 ? gates[0] : themeHit(doc, detector.theme_probes);
    if (loose.length > 0) {
      cov.findings += 1;
      findings.push(finding(doc, detector, loose[0], "partial", loose.slice(1)));
      continue;
    }
    if (themed && kvNegatedBlock(doc, detector) === null) {
      cov.findings += 1;
      const used = topicOnlyByInstrument.get(detector.instrument) ?? 0;
      if (used < MAX_TOPIC_ONLY_PER_INSTRUMENT) {
        topicOnlyByInstrument.set(detector.instrument, used + 1);
        findings.push(finding(doc, detector, themed, "topic_only", []));
      }
    }
  }

  return { findings, coverage, documentedBlocks: [...documentedBlocksMap.values()] };
}
