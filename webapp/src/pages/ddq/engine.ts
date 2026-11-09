/**
 * Fund-docs review engine - runs the detection pack + cross-document fact
 * ledger entirely in the browser. Mirrors the marine Obligation Checker
 * architecture: detectors are pure data, this module is the only runtime.
 */
import type {
  DdqContentBlock,
  DdqDocument,
  DdqFinding,
  DdqIssueCategory,
  DdqSeverity,
} from "./ddq-mock-data";
import { InstrumentCoverage, RELEASE_DETECTOR_COUNT, RELEASE_PACK, runReleasePack } from "./pack-v2";
import { QUESTION_MATRIX } from "./question-matrix";
import {
  FUND_DOCS_PACK,
  FUND_DOCS_OBLIGATION_COUNT,
  type DocumentRule,
  type SpanDetector,
} from "./fund-docs-pack";

const STRENGTH_CONFIDENCE: Record<SpanDetector["strength"], number> = { strong: 0.9, specific: 0.8, loose: 0.62 };

function fingerprint(seed: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
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

interface BlockMatch {
  blockIndex: number;
  text: string;
  start: number;
  end: number;
  matched: string;
}

function scanBlocks(doc: DdqDocument, pattern: string, flags: string): BlockMatch[] {
  const re = new RegExp(pattern, flags.includes("g") ? flags : `${flags}g`);
  const out: BlockMatch[] = [];
  doc.blocks.forEach((block, blockIndex) => {
    re.lastIndex = 0;
    let hit: RegExpExecArray | null;
    while ((hit = re.exec(block.text)) !== null) {
      if (hit[0].length === 0) {
        re.lastIndex += 1;
        continue;
      }
      out.push({ blockIndex, text: block.text, start: hit.index, end: hit.index + hit[0].length, matched: hit[0] });
      if (!flags.includes("g")) break;
    }
  });
  return out;
}

function applyReplacement(detector: { replacement: string | null }, matched: string): string {
  if (!detector.replacement) return matched;
  return detector.replacement.includes("$0") ? detector.replacement.replace("$0", matched) : detector.replacement;
}

function spanFinding(doc: DdqDocument, detector: SpanDetector): DdqFinding | null {
  const hits = scanBlocks(doc, detector.pattern, detector.flags);
  if (hits.length === 0) return null;
  const anchor = hits[0];
  const block = doc.blocks[anchor.blockIndex];
  const target = clampSpan(anchor.matched);
  const confidence = Math.min(0.98, STRENGTH_CONFIDENCE[detector.strength] + Math.min(0.06, (hits.length - 1) * 0.03));
  return {
    obligation_id: detector.obligation_id,
    content_fingerprint: fingerprint(`${detector.id}:${doc.id}:${anchor.blockIndex}`),
    instrument: detector.instrument,
    provision_id: detector.provision_id,
    title: detector.title,
    match_strength: detector.strength,
    confidence: Math.round(confidence * 100) / 100,
    matched_detectors: [detector.id],
    matched_count: hits.length,
    total_count: 1,
    section: blockSection(doc, anchor.blockIndex),
    page: block.page ?? 1,
    excerpt: excerptAround(anchor.text, anchor.start, anchor.end),
    matches: hits.slice(0, 6).map((hit) => ({
      detector_id: detector.id,
      origin: "pack/span",
      match_display: detector.title,
      strength: detector.strength,
      char_offset: hit.start,
      block_id: doc.blocks[hit.blockIndex].id,
      excerpt: excerptAround(hit.text, hit.start, hit.end),
      matched_text: hit.matched,
      section: blockSection(doc, hit.blockIndex),
      page: doc.blocks[hit.blockIndex].page ?? 1,
      in_reference_section: doc.blocks[hit.blockIndex].kind === "note",
      score: confidence,
    })),
    guidance: detector.guidance,
    severity: detector.severity,
    category: detector.category as DdqIssueCategory,
    block_id: block.id,
    target_text: target,
    replacement_text: applyReplacement(detector, target),
  };
}

function documentFinding(doc: DdqDocument, rule: DocumentRule): DdqFinding | null {
  const fullText = doc.blocks.map((b) => b.text).join("\n");
  for (const req of rule.requires) {
    if (!new RegExp(req.pattern, req.flags).test(fullText)) return null;
  }
  for (const forbid of rule.forbids) {
    if (new RegExp(forbid.pattern, forbid.flags).test(fullText)) return null;
  }
  const anchors = scanBlocks(doc, rule.anchor.pattern, rule.anchor.flags);
  if (anchors.length === 0) return null;
  const anchor = anchors[0];
  const block = doc.blocks[anchor.blockIndex];
  const target = clampSpan(anchor.matched);
  const evidence = rule.requires.flatMap((req) =>
    scanBlocks(doc, req.pattern, req.flags).slice(0, 2).map((hit) => ({
      detector_id: rule.id,
      origin: "pack/document",
      match_display: `Required signal: ${hit.matched}`,
      strength: rule.strength,
      char_offset: hit.start,
      block_id: doc.blocks[hit.blockIndex].id,
      excerpt: excerptAround(hit.text, hit.start, hit.end),
      matched_text: hit.matched,
      section: blockSection(doc, hit.blockIndex),
      page: doc.blocks[hit.blockIndex].page ?? 1,
      in_reference_section: false,
      score: STRENGTH_CONFIDENCE[rule.strength],
    }))
  );
  return {
    obligation_id: rule.obligation_id,
    content_fingerprint: fingerprint(`${rule.id}:${doc.id}:${anchor.blockIndex}`),
    instrument: rule.instrument,
    provision_id: rule.provision_id,
    title: rule.title,
    match_strength: rule.strength,
    confidence: STRENGTH_CONFIDENCE[rule.strength],
    matched_detectors: [rule.id],
    matched_count: rule.requires.length,
    total_count: rule.requires.length + rule.forbids.length,
    section: blockSection(doc, anchor.blockIndex),
    page: block.page ?? 1,
    excerpt: excerptAround(anchor.text, anchor.start, anchor.end),
    matches: evidence,
    guidance: rule.guidance,
    severity: rule.severity,
    category: rule.category as DdqIssueCategory,
    block_id: block.id,
    target_text: target,
    replacement_text: applyReplacement(rule, target),
  };
}


const SEVERITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

/** Drop findings whose anchor span overlaps a stronger finding in the same block.
 * Weak signals (topic_only / partial) are kept — many obligations share a gate
 * span, and collapsing them hides whole conventions from the issues panel. */
export function dedupeBlockOverlaps(doc: DdqDocument, findings: DdqFinding[]): DdqFinding[] {
  const claimed = new Map<string, Array<[number, number]>>();
  const ordered = [...findings].sort(
    (a, b) => (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3) || b.confidence - a.confidence
  );
  return ordered.filter((finding) => {
    if (finding.category === "evidenced") return true;
    if (finding.weak_signal) return true;
    const block = doc.blocks.find((b) => b.id === finding.block_id);
    if (!block) return true;
    const at = block.text.indexOf(finding.target_text);
    if (at < 0) return true;
    const spans = claimed.get(finding.block_id) ?? [];
    const end = at + finding.target_text.length;
    if (spans.some(([s, e]) => at < e && s < end)) return false;
    spans.push([at, end]);
    claimed.set(finding.block_id, spans);
    return true;
  });
}

export interface AnalysisResult {
  findings: DdqFinding[];
  coverage: Record<string, { evaluated: number; documented: number; findings: number }>;
  obligations: number;
  /** Per-block evidence details for green overlays. */
  documentedBlocks: import("./pack-v2").DocumentedBlock[];
}

/**
 * Single-document pass: the imported release packs (coverage semantics) plus
 * the authored layer (violation spans, document rules) and the fact base that
 * feeds the cross-document ledger. `options.instruments` scopes every layer
 * to an instrument allowlist (e.g. the personal-goals rulebooks only).
 */
export function analyzeDocument(doc: DdqDocument, options?: { instruments?: string[] }): AnalysisResult {
  const allow = options?.instruments ? new Set(options.instruments) : null;
  const release = runReleasePack(doc);
  const findings: DdqFinding[] = allow
    ? release.findings.filter((f) => allow.has(f.instrument))
    : [...release.findings];
  if (!allow) {
    for (const detector of FUND_DOCS_PACK.spanDetectors) {
      const finding = spanFinding(doc, detector);
      if (finding) findings.push(finding);
    }
    for (const rule of FUND_DOCS_PACK.documentRules) {
      const finding = documentFinding(doc, rule);
      if (finding) findings.push(finding);
    }
  }
  const coverage: Record<string, InstrumentCoverage> = {};
  for (const [instrument, cov] of Object.entries(release.coverage)) {
    if (!allow || allow.has(instrument)) coverage[instrument] = { ...cov };
  }
  if (!allow) {
    const authored = matchedByInstrument(
      findings.filter((f) => f.instrument === "corpus" || !release.coverage[f.instrument])
    );
    for (const [instrument, count] of Object.entries(authored)) {
      coverage[instrument] = { evaluated: 0, documented: 0, findings: count };
    }
  }
  const documentedBlocks = release.documentedBlocks
    .map((db) =>
      allow
        ? { ...db, obligations: db.obligations.filter((ob) => allow.has(ob.instrument)) }
        : db
    )
    .filter((db) => db.obligations.length > 0);
  const evidencedFindings: DdqFinding[] = documentedBlocks.flatMap((db) => {
    const block = doc.blocks.find((b) => b.id === db.blockId);
    if (!block) return [];
    return db.obligations.slice(0, 10).map((ob) => ({
      obligation_id: ob.obligation_id,
      corpus_fingerprint: ob.content_fingerprint,
      content_fingerprint: `${ob.obligation_id}:${db.blockId}`,
      instrument: ob.instrument,
      provision_id: ob.provision_id,
      title: ob.title,
      match_strength: "strong" as const,
      confidence: 0.95,
      matched_detectors: [ob.obligation_id],
      matched_count: 1,
      total_count: 1,
      section: block.text.slice(0, 60),
      page: block.page ?? 1,
      excerpt: block.text.slice(0, 200),
      matches: [
        {
          detector_id: ob.obligation_id,
          origin: "release-pack/evidence",
          match_display: ob.match_display,
          strength: "strong" as const,
          char_offset: ob.hit?.start ?? 0,
          block_id: db.blockId,
          excerpt: ob.hit
            ? excerptAround(block.text, ob.hit.start, ob.hit.end)
            : block.text.slice(0, 200),
          matched_text: ob.hit ? clampSpan(ob.hit.matched) : block.text.slice(0, 80),
          section: block.text.slice(0, 60),
          page: block.page ?? 1,
          in_reference_section: false,
          score: 0.95,
        },
      ],
      guidance: {
        match_display: ob.match_display,
        gap_actions: [],
        self_check_questions: [],
      },
      severity: "low" as const,
      category: "evidenced" as const,
      block_id: db.blockId,
      target_text: ob.hit ? clampSpan(ob.hit.matched) : block.text.slice(0, 80),
      replacement_text: ob.hit ? clampSpan(ob.hit.matched) : block.text.slice(0, 80),
    }));
  });

  return {
    findings: [...dedupeBlockOverlaps(doc, findings), ...evidencedFindings],
    coverage,
    obligations: allow
      ? RELEASE_PACK.detectors.filter((d) => allow.has(d.instrument)).length
      : RELEASE_DETECTOR_COUNT + FUND_DOCS_OBLIGATION_COUNT,
    documentedBlocks,
  };
}

/** Detectors + facts the pack wires per instrument (what was actually evaluated). */
export function evaluatedByInstrument(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const detector of RELEASE_PACK.detectors) counts[detector.instrument] = (counts[detector.instrument] ?? 0) + 1;
  for (const detector of FUND_DOCS_PACK.spanDetectors) counts[detector.instrument] = (counts[detector.instrument] ?? 0) + 1;
  for (const rule of FUND_DOCS_PACK.documentRules) counts[rule.instrument] = (counts[rule.instrument] ?? 0) + 1;
  for (const question of QUESTION_MATRIX.questions) {
    counts[question.instrument] = (counts[question.instrument] ?? 0) + 1;
  }
  return counts;
}

/** Findings fired per instrument for one document. */
export function matchedByInstrument(findings: DdqFinding[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const finding of findings) counts[finding.instrument] = (counts[finding.instrument] ?? 0) + 1;
  return counts;
}

export { crossCheckCorpus } from "./question-matrix";

/** Findings the extraction layer itself produces (scans, unsupported formats). */
export function qualityFinding(
  doc: DdqDocument,
  blockId: string,
  title: string,
  detail: string
): DdqFinding {
  return {
    obligation_id: "fd_data_q_extract",
    content_fingerprint: fingerprint(`extract:${doc.id}:${title}`),
    instrument: "corpus",
    provision_id: "Ingestion quality gate",
    title,
    match_strength: "strong",
    confidence: 0.99,
    matched_detectors: ["ingest"],
    matched_count: 1,
    total_count: 1,
    section: "Ingestion",
    page: 1,
    excerpt: detail,
    matches: [
      {
        detector_id: "ingest",
        origin: "pack/ingest",
        match_display: title,
        strength: "strong",
        char_offset: 0,
        excerpt: detail,
        matched_text: detail.slice(0, 80),
        section: "Ingestion",
        page: 1,
        in_reference_section: false,
        score: 0.99,
      },
    ],
    guidance: {
      match_display: title,
      gap_actions: [],
      self_check_questions: [],
    },
    severity: "high",
    category: "data_quality",
    block_id: blockId,
    target_text: detail.slice(0, 80),
    replacement_text: detail.slice(0, 80),
  };
}

export { FUND_DOCS_PACK, FUND_DOCS_OBLIGATION_COUNT };
