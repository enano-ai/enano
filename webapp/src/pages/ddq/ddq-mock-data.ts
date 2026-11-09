/**
 * DDQ shared types and labels. The mocked sample documents and factories
 * that used to live here are gone: the workspace now runs the imported
 * release packs and bundled real sample texts (samples/, pipeline.ts).
 */
import type { ObligationDetectorHitSummary } from "@/lib/smm-extractor/types";

export type DdqSeverity = "high" | "medium" | "low";

export type DdqIssueCategory =
  | "unsupported_claim"
  | "vague_disclosure"
  | "missing_disclosure"
  | "inconsistency"
  | "presentation_gap"
  | "data_quality"
  | "evidenced";

export interface DdqContentBlock {
  id: string;
  kind: "section" | "question" | "answer" | "note";
  text: string;
  /** 1-based page number when the source format has pages (PDF). */
  page?: number;
  /** Key-value pair detected from table layout (x-gap between label and value). */
  kv?: { label: string; value: string };
}

/**
 * A pipeline finding, ml-regex schema (ObligationDetectorHitSummary) extended
 * with the redline layer this editor derives from the hit: the exact span to
 * rewrite and the suggested replacement.
 */
export interface DdqFinding extends ObligationDetectorHitSummary {
  severity: DdqSeverity;
  category: DdqIssueCategory;
  /** Exact substring of the anchor block's text that the change targets. */
  target_text: string;
  /** Suggested replacement rendered as a tracked insertion. */
  replacement_text: string;
  /** Anchor block id within the document. */
  block_id: string;
  /** Semantic capture provenance for drill-down: tier cleared at capture,
   * cosine at capture, matching direction, and query method. */
  match_tier?: "direct" | "related" | "possible";
  capture_score?: number;
  match_direction?: "anchor" | "block";
  match_method?: "exemplar" | "anchor";
  /** Corpus obligation fingerprint — the advice-pack join key. The group
   * obligation_id is a pack-local id that never matches advice keys. */
  corpus_fingerprint?: string;
}

export interface DocClassification {
  primary: string;
  label: string;
  confidence: number;
  also: { type: string; label: string; score: number }[];
}

export interface DdqDocument {
  /** Document-type classification from the s80 pack (primary + ranked secondaries). */
  classification?: DocClassification;
  /** Per-block source positioning for overlay rendering (PDF: page + y in page units). */
  blockPositions?: { blockId: string; page: number; y: number; size: number }[];
  id: string;
  filename: string;
  kind: "docx" | "pdf" | "pptx" | "txt" | "xlsx";
  pages: number;
  words: number;
  pack_version: string;
  detectors_version: string;
  obligations_evaluated: number;
  reviewed_at: string;
  blocks: DdqContentBlock[];
  findings: DdqFinding[];
}

export const DDQ_INSTRUMENT_LABELS: Record<string, string> = {
  ilpa_ddq_2_0: "ILPA DDQ 2.0",
  aima_ddq: "AIMA DDQ",
  gips_2020: "GIPS 2020",
  ucits_583_2010: "UCITS 583/2010",
};

export const PACK_VERSION = "v2026.09-fd0.3";

export type DdqRedlineSegment = { kind: "same" | "change"; text: string; finding?: DdqFinding };
