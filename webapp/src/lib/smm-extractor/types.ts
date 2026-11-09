/** Types for the marize-based SMM extractor (Trust Ladder L3). */

export interface PatternEntry {
  key: string;
  category: string;
  ism_element: number | null;
  label: string;
  patterns: string[];
  patterns_es?: string[];
  flags?: string;
  loose?: boolean;
  strong?: boolean;
  semantic_query?: string;
  semantic_query_es?: string;
}

export interface PatternsFile {
  version: string;
  patterns: PatternEntry[];
}

export type MatchStrength = "strong" | "specific" | "loose" | null;

export interface AttributeSource {
  id: string;
  excerpt: string | null;
  char_offset: number;
  page: number | null;
  section: string | null;
  /** True if the match fell inside a TOC / contents / index band. */
  in_toc?: boolean;
}

/** Link from a fired SMM pattern to a marize obligation_id. */
export interface ObligationLink {
  obligation_id: string;
  instrument: string;
  provision_id: string;
  title: string;
  score: number;
  link_method: string;
}

export interface SmmAttribute {
  id: string;
  key: string;
  present: boolean;
  confidence: number;
  /** strong | specific | loose — mirrors patterns.json flags. */
  match_strength: MatchStrength;
  match_engine: "regex" | null;
  sources: AttributeSource[];
  /**
   * Obligations this attribute evidence may satisfy / relate to.
   * Populated from obligation_links.json (seed + auto from marize obligations).
   */
  linked_obligations: ObligationLink[];
}

export type IsmStatus = "documented" | "incidental_mention_only" | "not_found";

export interface IsmCoverageItem {
  element: number;
  status: IsmStatus;
  strong_patterns_matched: number;
  specific_patterns_matched: number;
  loose_patterns_matched: number;
  score: number;
}

/** High-level applicability for gap-analysis routing. */
export type DocDomain =
  | "shipboard_sms"
  | "port_authority_sms"
  | "company_office_sms"
  | "procedure_pack"
  | "mixed"
  | "unknown";

export interface DomainEvidenceHit {
  family: string;
  side: "ship" | "port" | "procedure" | "office";
  source: "regex" | "attribute";
  detail: string;
  weight: number;
}

export interface SmmApplicability {
  doc_domain: DocDomain;
  shipboard: boolean;
  port_ops: boolean;
  frameworks: string[];
  jurisdiction_hints: string[];
  drill_types: string[];
  is_template: boolean;
  template_score: number;
  /** Auditable scores — no black-box domain. */
  ship_score: number;
  port_score: number;
  procedure_score: number;
  ship_families: string[];
  port_families: string[];
  /** Every evidence family that fired (regex or attribute). */
  domain_evidence: DomainEvidenceHit[];
  /**
   * Instruments the obligation matcher actually ran for this document.
   * Scale + correctness gate — see instrument-applicability.ts.
   */
  applicable_instruments?: string[];
  /** Instruments in the pack that were skipped for this SMS (with reason). */
  excluded_instruments?: Array<{
    instrument: string;
    tier: string;
    reason: string;
  }>;
}

export interface SmmProfile {
  doc_type: string;
  evidence_weight: number;
  coverage_score: number;
  weighted_coverage_score: number;
  ism_elements_detected: number[];
  ism_elements_missing: number[];
  ism_coverage: IsmCoverageItem[];
  top_keywords: { word: string; count: number }[];
  top_phrases: Record<string, { phrase: string; count: number }[]>;
  /** Added for gap-analysis routing (v0.6 schema). */
  applicability: SmmApplicability;
  patterns_version: string;
  section_count: number;
  heading_count: number;
  /**
   * Distinct obligation_ids linked from *present* attributes.
   * Enables gap analysis: which obligations have SMM evidence.
   */
  linked_obligation_ids: string[];
  linked_obligation_count: number;
  /**
   * Obligation-first detector hits (regex pack keyed by obligation_id).
   * Primary path for gap analysis: matched IDs vs applicable set.
   */
  obligation_hits: ObligationDetectorHitSummary[];
  obligation_hit_ids: string[];
  obligation_hit_count: number;
  obligation_detectors_version: string;
  obligation_detectors_total: number;
}

/** One action the user can take to close a gap. vessel_types lets future packs scope an action to specific vessel types ("all" today — no pack differentiates yet). */
export interface ObligationGapAction {
  text: string;
  vessel_types: string[];
}

/** End-user-facing "why this matched" / "what to do if it didn't" content for one curated obligation group — see scripts/obligation_pattern_packs/**\/*.json. */
export interface ObligationGuidance {
  /** User-facing summary shown when this obligation IS considered documented, e.g. "Written procedures exist for key shipboard operations". */
  match_display: string;
  gap_actions: ObligationGapAction[];
  /** Plain-language questions the user can ask themselves while reviewing their own document. */
  self_check_questions: string[];
}

export interface ObligationEvidenceMatchSummary {
  /** Stable curated slug (e.g. "standing_orders_named") or positional ("d4") for algorithmic detectors. */
  detector_id: string;
  /** "curated" | "derived" | "pattern:<key>" — which detector tier fired. */
  origin?: string;
  /** User-facing checklist phrase for this specific fired pattern, e.g. "Responsible role identified". Curated detectors only. */
  match_display?: string;
  strength: "strong" | "specific" | "loose";
  char_offset: number;
  excerpt: string | null;
  /** Literal matched substring — lets the UI highlight the exact span inside `excerpt`. */
  matched_text?: string | null;
  section: string | null;
  page: number | null;
  in_reference_section: boolean;
  score: number;
  /** Block the evidence was found in; groups drill-down per document block. */
  block_id?: string;
}

/** Compact hit from obligation-first detectors (full excerpt on attribute-level optional). */
export interface ObligationDetectorHitSummary {
  obligation_id: string;
  content_fingerprint: string;
  instrument: string;
  provision_id: string;
  title: string;
  /**
   * Weak-signal hit — the document discusses the obligation's area but the
   * engine could not confirm it is addressed. "topic_only" (gate locator
   * fired, no confirming evidence) or "partial" (evidence fired, match_rule
   * gate failed). Always confidence < 0.75 → counted as "uncertain".
   */
  weak_signal?: "topic_only" | "partial" | "semantic";
  match_strength: "strong" | "specific" | "loose";
  /** 0..1 — see obligation-detectors.ts scoreMatch(); penalizes glossary/cross-reference-only matches. */
  confidence: number;
  matched_detectors: string[];
  /**
   * Coverage ratio — how many of this obligation's detectors fired, out of
   * how many exist. Separate signal from match_strength/confidence (which
   * already gate whether this counts as a hit): 5/6 is well-corroborated,
   * 1/10 cleared the bar but is thin evidence worth double-checking.
   */
  matched_count: number;
  total_count: number;
  /** Present only for obligations covered by a curated pack. */
  guidance?: ObligationGuidance;
  section: string | null;
  page: number | null;
  excerpt: string | null;
  /** All located evidence occurrences, best-scoring first. */
  matches: ObligationEvidenceMatchSummary[];
}

export interface SmmParagraph {
  id: string;
  char_offset: number;
  page: number | null;
  text: string | null;
}

export interface SmmSection {
  id?: string;
  heading: string | null;
  level: number | null;
  rule: string | null;
  char_offset: number;
  page: number | null;
  paragraphs: SmmParagraph[];
}

/** Full parse result (source JSON — excerpts/text populated). */
export interface SmmDocumentResult {
  filename: string;
  parsed_at: string;
  language: string;
  total_pages: number;
  paragraph_count: number;
  schema_version: string;
  profile: SmmProfile;
  attributes: SmmAttribute[];
  sections: SmmSection[];
}

export type DecodeStatus =
  | "parsed"
  | "scanned_image_pdf_skipped"
  | "unsupported_extension"
  | "decode_error";

export interface FileProcessResult {
  filename: string;
  status: DecodeStatus;
  error?: string | null;
  result?: SmmDocumentResult;
}
