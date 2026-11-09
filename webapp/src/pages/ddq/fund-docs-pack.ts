/**
 * Fund-docs starter detection pack - REAL regex detectors (prototype scale).
 *
 * Schema-compatible with the ml-regex detector packs the document-pipeline
 * factory will emit for the fintech/fund-docs cell: when the full pack lands
 * (~3,000 obligations / 6,000+ patterns across ILPA DDQ 2.0, GIPS 2020,
 * ESMA34-45-1272, FCA COBS 4, UCITS 583/2010 and SFDR) it replaces this
 * module's data wholesale - the engine (engine.ts) and UI stay unchanged.
 *
 * Every detector below cites a real provision and is tuned against the
 * synthetic sample corpora in document-pipeline/quality/samples/: Tier 1
 * (Whitfield & Marsh) must produce ZERO findings.
 *
 * Instrument counts / corpus totals come from the slim fund-docs-manifest.json.
 * The multi-MB detectors blob is API-loaded (see fund-docs-pack-loader.ts) —
 * never statically imported here.
 */
import type { DdqIssueCategory, DdqSeverity } from "./ddq-mock-data";
import { FUND_DOCS_MANIFEST } from "./pack-v2";

export type DdqInstrumentId =
  | "ilpa_ddq_2_0"
  | "aima_ddq"
  | "gips_2020"
  | "ucits_583_2010"
  | "esma_34_45_1272"
  | "fca_cobs_4"
  | "sfdr_2019_2088"
  | "corpus";

export type DdqPackCategory = DdqIssueCategory | "data_quality";

export interface SpanDetector {
  scope: "span";
  id: string;
  obligation_id: string;
  instrument: DdqInstrumentId;
  provision_id: string;
  title: string;
  category: DdqPackCategory;
  severity: DdqSeverity;
  strength: "strong" | "specific" | "loose";
  pattern: string;
  flags: string;
  /** "$0" is replaced by the matched text; a fixed string replaces it outright. */
  replacement: string | null;
  guidance: {
    match_display: string;
    gap_actions: { text: string; vessel_types: string[] }[];
    self_check_questions: string[];
  };
}

export interface DocumentRule {
  scope: "document";
  id: string;
  obligation_id: string;
  instrument: DdqInstrumentId;
  provision_id: string;
  title: string;
  category: DdqPackCategory;
  severity: DdqSeverity;
  strength: "strong" | "specific" | "loose";
  /** Finding fires when every `requires` pattern is present and every `forbids` pattern is absent. */
  requires: { pattern: string; flags: string }[];
  forbids: { pattern: string; flags: string }[];
  /** Finding anchors on the first span matching this pattern (required). */
  anchor: { pattern: string; flags: string };
  replacement: string | null;
  guidance: {
    match_display: string;
    gap_actions: { text: string; vessel_types: string[] }[];
    self_check_questions: string[];
  };
}





export const FUND_DOCS_PACK = {
  pack: "fund-docs",
  version: "v2026.09-fd1.0-proto",
  instruments: [
    "ilpa_ddq_2_0",
    "aima_ddq",
    "gips_2020",
    "ucits_583_2010",
    "esma_34_45_1272",
    "fca_cobs_4",
    "sfdr_2019_2088",
    "corpus",
  ] as DdqInstrumentId[],
  spanDetectors: [

    {
      scope: "span",
      id: "rx-fd-1001",
      obligation_id: "fd_cobs_4_0001",
      instrument: "fca_cobs_4",
      provision_id: "FCA COBS 4.2.1R - fair, clear and not misleading",
      title: "Capital-protection language for an unprotected fund",
      category: "unsupported_claim",
      severity: "high",
      strength: "strong",
      pattern: "capital[- ]protected|capital protection|protected profile",
      flags: "i",
      replacement: null,
      guidance: {
        match_display: "Risk described accurately without protection claims",
        gap_actions: [
          { text: "Remove capital-protection wording unless a guarantee mechanism exists and is named.", vessel_types: ["marketing", "factsheet", "ddq-response"] },
        ],
        self_check_questions: ["Is any form of capital guarantee contractually provided for this fund?"],
      },
    },
    {
      scope: "span",
      id: "rx-fd-1002",
      obligation_id: "fd_cobs_4_0002",
      instrument: "fca_cobs_4",
      provision_id: "FCA COBS 4.2.1R - fair, clear and not misleading",
      title: "Guaranteed-return or guaranteed-capital claim",
      category: "unsupported_claim",
      severity: "high",
      strength: "strong",
      pattern: "guarantees? (?:to )?(?:return|returns|performance|capital|income|principal)|guaranteed return",
      flags: "i",
      replacement: null,
      guidance: {
        match_display: "Returns described as variable, not guaranteed",
        gap_actions: [
          { text: "Replace guarantee wording with the actual risk outcome unless a guarantee exists.", vessel_types: ["marketing", "factsheet"] },
        ],
        self_check_questions: ["Does the fund or manager contractually guarantee the stated outcome?"],
      },
    },
    {
      scope: "span",
      id: "rx-fd-1003",
      obligation_id: "fd_esma_0003",
      instrument: "esma_34_45_1272",
      provision_id: "ESMA Guidelines on marketing communications ESMA34-45-1272, s.31-32",
      title: "Capital preservation claimed in all conditions",
      category: "unsupported_claim",
      severity: "high",
      strength: "strong",
      pattern: "preserv(?:e|ed|es) capital in all (?:market )?conditions|in all market conditions",
      flags: "i",
      replacement: null,
      guidance: {
        match_display: "Drawdown risk disclosed alongside any stability claim",
        gap_actions: [
          { text: "Qualify the claim with the fund's actual worst outcome (e.g. maximum drawdown).", vessel_types: ["marketing"] },
        ],
        self_check_questions: ["What was the fund's worst drawdown, and is it disclosed next to this claim?"],
      },
    },
    {
      scope: "span",
      id: "rx-fd-1004",
      obligation_id: "fd_esma_0004",
      instrument: "esma_34_45_1272",
      provision_id: "ESMA34-45-1272 s.31-32; FCA COBS 4.5.7R (past performance)",
      title: "Absolute risk claim ('never exceeds…') contradicts published risk statistics",
      category: "unsupported_claim",
      severity: "high",
      strength: "strong",
      pattern: "volatility[^.]{0,50}never exceed(?:s|ed)|(?:has )?never exceed(?:s|ed)[^.]{0,60}(?:volatility|risk|loss)",
      flags: "i",
      replacement: null,
      guidance: {
        match_display: "Risk ranges or statistics quoted with an as-of date",
        gap_actions: [
          { text: "Replace absolutes with the measured statistic and period (e.g. volatility by year, maximum drawdown).", vessel_types: ["marketing", "factsheet"] },
        ],
        self_check_questions: ["Does the fund's own factsheet risk table support this absolute claim for every period?"],
      },
    },
    {
      scope: "span",
      id: "rx-fd-1005",
      obligation_id: "fd_esma_0005",
      instrument: "esma_34_45_1272",
      provision_id: "ESMA34-45-1272 s.25 - identification of risk warnings",
      title: "'Risk-free' or 'safe' framing of a risky investment",
      category: "unsupported_claim",
      severity: "high",
      strength: "strong",
      pattern: "risk[- ]free|totally safe|completely safe|assured returns?",
      flags: "i",
      replacement: null,
      guidance: {
        match_display: "Risk warnings proportional to the product's risk profile",
        gap_actions: [{ text: "Remove risk-free framing; UCITS/AIF units are not risk-free.", vessel_types: ["marketing"] }],
        self_check_questions: ["Would the summary risk indicator in the KID support this wording?"],
      },
    },
    {
      scope: "span",
      id: "rx-fd-1006",
      obligation_id: "fd_esma_0006",
      instrument: "esma_34_45_1272",
      provision_id: "ESMA34-45-1272 s.39-41 - balanced presentation",
      title: "Unqualified superlative performance claim",
      category: "unsupported_claim",
      severity: "low",
      strength: "loose",
      pattern: "outperforms? (?:the market|all markets|every market)|market[- ]leading (?:returns?|performance)|world[- ]class (?:returns?|performance)",
      flags: "i",
      replacement: null,
      guidance: {
        match_display: "Claims tied to a named benchmark and period",
        gap_actions: [{ text: "State the benchmark, period and basis for any relative-performance claim.", vessel_types: ["marketing", "deck"] }],
        self_check_questions: ["Which benchmark, over which period, on which fee basis?"],
      },
    },

    {
      scope: "span",
      id: "rx-fd-1101",
      obligation_id: "fd_ilpa_2_0_0101",
      instrument: "ilpa_ddq_2_0",
      provision_id: "ILPA DDQ 2.0 §1.0 Firm: General Information (data precision)",
      title: "AUM disclosed with approximation instead of a dated figure",
      category: "vague_disclosure",
      severity: "medium",
      strength: "specific",
      pattern: "approximately (?:GBP|EUR|USD|\\$|£|€)\\s?[\\d.,]+\\s?(?:bn|billion|m|million)",
      flags: "i",
      replacement: null,
      guidance: {
        match_display: "AUM stated exactly with an as-of date and breakdown",
        gap_actions: [{ text: "Replace the approximation with the exact figure, as-of date and strategy split.", vessel_types: ["ddq-response", "factsheet"] }],
        self_check_questions: ["Does the response give an as-of date for the AUM figure?"],
      },
    },
    {
      scope: "span",
      id: "rx-fd-1102",
      obligation_id: "fd_ilpa_2_0_0102",
      instrument: "ilpa_ddq_2_0",
      provision_id: "ILPA DDQ 2.0 - completeness of response",
      title: "Standard cited only as 'industry practice' or 'market norms'",
      category: "vague_disclosure",
      severity: "medium",
      strength: "specific",
      pattern: "in line with (?:industry|market) (?:practice|norms|standards?)|consistent with market practice",
      flags: "i",
      replacement: null,
      guidance: {
        match_display: "Named standard, policy or document reference",
        gap_actions: [{ text: "Name the actual standard or internal policy that governs the practice.", vessel_types: ["ddq-response", "policy"] }],
        self_check_questions: ["Which document, standard or rulebook sets the practice being described?"],
      },
    },
    {
      scope: "span",
      id: "rx-fd-1103",
      obligation_id: "fd_ilpa_2_0_0103",
      instrument: "ilpa_ddq_2_0",
      provision_id: "ILPA DDQ 2.0 - completeness of response",
      title: "Fee terms described qualitatively instead of exact rates",
      category: "vague_disclosure",
      severity: "medium",
      strength: "specific",
      pattern: "fees? (?:are|is) competitive|competitive fee structure|fees? aligned with market norms",
      flags: "i",
      replacement: null,
      guidance: {
        match_display: "Exact fee rates quoted from fund documents",
        gap_actions: [{ text: "Quote management and performance fee rates from the fee schedule or LPA.", vessel_types: ["ddq-response", "rfp-response"] }],
        self_check_questions: ["Do the quoted rates match the fee schedule exactly?"],
      },
    },
    {
      scope: "span",
      id: "rx-fd-1104",
      obligation_id: "fd_ilpa_2_0_0104",
      instrument: "ilpa_ddq_2_0",
      provision_id: "ILPA DDQ 2.0 - completeness of response",
      title: "Commitment qualified as 'best efforts'",
      category: "vague_disclosure",
      severity: "low",
      strength: "loose",
      pattern: "best (?:commercial )?efforts",
      flags: "i",
      replacement: null,
      guidance: {
        match_display: "Concrete undertakings with measurable standards",
        gap_actions: [{ text: "Replace best-efforts wording with the specific commitment and standard applied.", vessel_types: ["ddq-response", "policy"] }],
        self_check_questions: ["What would an LP check to confirm this commitment was met?"],
      },
    },
    {
      scope: "span",
      id: "rx-fd-1105",
      obligation_id: "fd_esma_0007",
      instrument: "esma_34_45_1272",
      provision_id: "ESMA34-45-1272 s.13 - statements must be substantiated",
      title: "Unsubstantiated quality superlative ('state-of-the-art', 'world-class')",
      category: "vague_disclosure",
      severity: "low",
      strength: "loose",
      pattern: "state[- ]of[- ]the[- ]art|world[- ]class|best[- ]in[- ]class (?:team|platform|process)",
      flags: "i",
      replacement: null,
      guidance: {
        match_display: "Claims backed by named evidence (certification, ranking, tenure)",
        gap_actions: [{ text: "Substantiate the superlative with a verifiable source or remove it.", vessel_types: ["marketing", "deck"] }],
        self_check_questions: ["What independent source verifies this claim?"],
      },
    },

    {
      scope: "span",
      id: "rx-fd-1201",
      obligation_id: "fd_data_q_0001",
      instrument: "corpus",
      provision_id: "Review quality gate - unresolved editorial markers",
      title: "Unresolved [TODO] marker in issued document",
      category: "data_quality",
      severity: "high",
      strength: "strong",
      pattern: "\\[(?:TODO|TBD)[:,\\]]|\\bTODO:|\\bTBD\\b",
      flags: "",
      replacement: null,
      guidance: {
        match_display: "Document finalised with no editorial markers",
        gap_actions: [{ text: "Resolve the outstanding reviewer note before issuing the document.", vessel_types: ["all"] }],
        self_check_questions: ["Has every reviewer note been actioned and deleted?"],
      },
    },
    {
      scope: "span",
      id: "rx-fd-1202",
      obligation_id: "fd_data_q_0002",
      instrument: "corpus",
      provision_id: "Review quality gate - draft control",
      title: "Draft / not-for-distribution marking present",
      category: "data_quality",
      severity: "medium",
      strength: "strong",
      pattern: "NOT FOR DISTRIBUTION|\\bDRAFT\\b|Draft[- ]",
      flags: "",
      replacement: null,
      guidance: {
        match_display: "Document carries final version control only",
        gap_actions: [{ text: "Confirm the final version was uploaded; drafts should not feed the fact base.", vessel_types: ["all"] }],
        self_check_questions: ["Is this the version actually sent to investors or consultants?"],
      },
    },
  ] as SpanDetector[],

  documentRules: [
    {
      scope: "document",
      id: "rx-fd-1301",
      obligation_id: "fd_gips_2020_0301",
      instrument: "gips_2020",
      provision_id: "GIPS 2020 §4.A.1-4.A.6 (net-of-fees presentation)",
      title: "Gross-of-fees returns presented without any net-of-fees figures",
      category: "presentation_gap",
      severity: "high",
      strength: "strong",
      requires: [{ pattern: "gross (?:of fees|return|returns)", flags: "i" }],
      forbids: [{ pattern: "\\bnet\\b", flags: "i" }],
      anchor: { pattern: "gross (?:of fees|return|returns)", flags: "i" },
      replacement: null,
      guidance: {
        match_display: "Returns presented both gross and net of investment management fees",
        gap_actions: [
          { text: "Add net-of-fees returns wherever gross returns are shown, or state the net equivalents alongside.", vessel_types: ["deck", "factsheet", "rfp-response"] },
        ],
        self_check_questions: ["Can the reader derive the net return from this document alone?"],
      },
    },
    {
      scope: "document",
      id: "rx-fd-1302",
      obligation_id: "fd_esma_0302",
      instrument: "esma_34_45_1272",
      provision_id: "ESMA34-45-1272 s.49-51; FCA COBS 4.5.7R - past-performance warning",
      title: "Performance figures shown without the past-performance warning",
      category: "missing_disclosure",
      severity: "medium",
      strength: "strong",
      requires: [
        { pattern: "\\d+(?:\\.\\d+)?\\s?%", flags: "" },
        { pattern: "(?:return|performance|since inception|p\\.a\\.)", flags: "i" },
      ],
      forbids: [{ pattern: "past performance (?:is|are|should|may)?[^.]{0,30}(?:reliable|guarantee|guide)|not a reliable indicator", flags: "i" }],
      anchor: { pattern: "\\d+(?:\\.\\d+)?\\s?%", flags: "" },
      replacement: null,
      guidance: {
        match_display: "Past-performance warning within the same document as performance figures",
        gap_actions: [{ text: "Add the standard warning: past performance is not a reliable indicator of future results.", vessel_types: ["marketing", "deck", "factsheet"] }],
        self_check_questions: ["Is the warning visible without navigating away from the performance table?"],
      },
    },
    {
      scope: "document",
      id: "rx-fd-1303",
      obligation_id: "fd_sfdr_0303",
      instrument: "sfdr_2019_2088",
      provision_id: "Regulation (EU) 2019/2088 Article 9 - sustainable investment objective",
      title: "Article 9 classification without a stated sustainable investment objective",
      category: "missing_disclosure",
      severity: "medium",
      strength: "specific",
      requires: [{ pattern: "Article 9", flags: "" }],
      forbids: [{ pattern: "sustainable investment", flags: "i" }],
      anchor: { pattern: "Article 9", flags: "" },
      replacement: null,
      guidance: {
        match_display: "Article 9 claims paired with the binding sustainable investment objective",
        gap_actions: [{ text: "State the fund's sustainable investment objective wherever Article 9 is claimed.", vessel_types: ["policy", "factsheet", "esg-report"] }],
        self_check_questions: ["Does the document explain how 100% of investments align to the sustainable objective?"],
      },
    },
    {
      scope: "document",
      id: "rx-fd-1304",
      obligation_id: "fd_gips_2020_0304",
      instrument: "gips_2020",
      provision_id: "GIPS 2020 §4.A.11-4.A.16 (compliance claim and composites)",
      title: "GIPS compliance claimed without reference to a composite",
      category: "presentation_gap",
      severity: "medium",
      strength: "specific",
      requires: [{ pattern: "compliance with the (?:GIPS|Global Investment Performance Standards)", flags: "i" }],
      forbids: [{ pattern: "composite", flags: "i" }],
      anchor: { pattern: "compliance with the (?:GIPS|Global Investment Performance Standards)", flags: "i" },
      replacement: null,
      guidance: {
        match_display: "Compliance claim accompanied by composite definitions and list availability",
        gap_actions: [{ text: "Reference the composite(s) the claim applies to and how the list can be obtained.", vessel_types: ["ddq-response", "deck"] }],
        self_check_questions: ["Which composites does the claim cover, and since when?"],
      },
    },
  ] as DocumentRule[],


};

export const FUND_DOCS_OBLIGATION_COUNT =
  FUND_DOCS_PACK.spanDetectors.length + FUND_DOCS_PACK.documentRules.length;

/**
 * The convention registry: every regulatory source the corpus covers, with its
 * verified obligation count from the document-pipeline extraction. "live"
 * sources have detectors in the pack today; "queued" sources are extracted on
 * the backend and wire in as the packs land - the UI renders them greyed.
 */
export interface ConventionSource {
  id: string;
  label: string;
  short: string;
  status: "live" | "queued";
}

const wiredByInstrument = new Map(
  FUND_DOCS_MANIFEST.instruments.map((entry) => [entry.instrument, entry]),
);
const corpusByInstrument: Record<string, number> = FUND_DOCS_MANIFEST.corpus_obligations;

export const CONVENTION_SOURCES: ConventionSource[] = [
  { id: "ilpa_ddq_2_0", label: "ILPA DDQ 2.0", short: "ILPA", status: "live" },
  { id: "fca_cobs_4", label: "FCA COBS 4", short: "COBS 4", status: "live" },
  { id: "gips_2020", label: "GIPS 2020", short: "GIPS", status: "live" },
  { id: "sfdr_2019_2088", label: "SFDR (2019/2088)", short: "SFDR", status: "live" },
  { id: "esma_34_45_1272", label: "ESMA Marketing Guidelines (ESMA34-45-1272)", short: "ESMA", status: "live" },
  { id: "corpus", label: "Cross-document consistency", short: "Consistency", status: "live" },
  { id: "ucits_583_2010", label: "UCITS KIID Regulation (583/2010)", short: "UCITS KIID", status: "live" },
  { id: "sfdr_rts", label: "SFDR RTS (2022/1288)", short: "SFDR RTS", status: "live" },
  { id: "esma_performance_fees", label: "ESMA Guidelines on performance fees (ESMA34-39-992)", short: "Perf. fees", status: "live" },
  { id: "esma_fund_names", label: "ESMA Guidelines on funds' names (ESMA34-472-440)", short: "Fund names", status: "live" },
  { id: "esma_product_governance", label: "ESMA Product Governance Guidelines (ESMA35-43-620)", short: "Prod. gov.", status: "live" },
  { id: "fca_fund", label: "FCA FUND sourcebook", short: "FCA FUND", status: "live" },
  { id: "aifmd", label: "AIFMD / AIFMD II (L1/L2)", short: "AIFMD", status: "live" },
  { id: "mifid_ii", label: "MiFID II (L1 + Org Regulation)", short: "MiFID II", status: "live" },
  { id: "mar", label: "Market Abuse Regulation (596/2014)", short: "MAR", status: "live" },
  { id: "pri_reporting", label: "PRI Reporting Framework", short: "PRI", status: "live" },
  { id: "pri_ri_ddq", label: "PRI RI DDQ for Investors in Funds", short: "PRI DDQ", status: "queued" },
  { id: "priips", label: "PRIIPs Regulation (L1 + KID RTS)", short: "PRIIPs", status: "live" },
  { id: "ilpa_performance_template", label: "ILPA Performance Template Guidance 2025", short: "ILPA PT", status: "live" },
  { id: "consumer_duty", label: "FCA Consumer Duty (PRIN 2A)", short: "Consumer Duty", status: "live" },
  { id: "sysc", label: "FCA SYSC", short: "SYSC", status: "live" },
  { id: "sdr", label: "Sustainability Disclosure Requirements (PS23/16)", short: "SDR", status: "live" },
  { id: "stewardship_code", label: "UK Stewardship Code 2026", short: "Stewardship", status: "live" },
  { id: "ucits_level1", label: "UCITS Directive (2009/65/EC)", short: "UCITS L1", status: "live" },
  { id: "fca_coll", label: "FCA COLL", short: "COLL", status: "live" },
  { id: "mifir", label: "MiFIR (600/2014)", short: "MiFIR", status: "live" },
  { id: "benchmark_reg", label: "EU Benchmarks Regulation (2016/1011)", short: "BMR", status: "live" },
  { id: "eu_taxonomy", label: "EU Taxonomy Regulation (2020/852)", short: "Taxonomy", status: "live" },
  { id: "sbai_ddq", label: "SBAI DDQ Toolkit", short: "SBAI", status: "live" },
  { id: "aima_ddq", label: "AIMA DDQ", short: "AIMA", status: "queued" },
];

/** Checkable obligation groups wired in the runtime pack (what actually runs). */
export function wiredGroups(instrument: string): number {
  return wiredByInstrument.get(instrument)?.groups ?? 0;
}

/** Verified obligations extracted from the official source (backend s30), when counted. */
export function corpusObligations(instrument: string): number | null {
  return corpusByInstrument[instrument] ?? wiredByInstrument.get(instrument)?.corpus_obligations ?? null;
}

export const CONVENTION_TOTAL_OBLIGATIONS = Object.values(corpusByInstrument).reduce((sum, n) => sum + n, 0);

export const FUND_DOCS_INSTRUMENT_LABELS: Record<string, string> = {
  ilpa_ddq_2_0: "ILPA DDQ 2.0",
  aima_ddq: "AIMA DDQ",
  gips_2020: "GIPS 2020",
  ucits_583_2010: "UCITS 583/2010",
  esma_34_45_1272: "ESMA Marketing",
  fca_cobs_4: "FCA COBS 4",
  sfdr_2019_2088: "SFDR",
  corpus: "Consistency",
  esma_performance_fees: "ESMA Perf. Fees",
  esma_product_governance: "ESMA Prod. Gov.",
  ilpa_performance_template: "ILPA Perf. Template",
  fca_fund: "FCA FUND",
  pri_reporting: "PRI",
  pri_ri_ddq: "PRI DDQ",
  sfdr_rts: "SFDR RTS",
  aifmd: "AIFMD",
  mifid_ii: "MiFID II",
  ucits_level1: "UCITS Directive",
  fca_coll: "FCA COLL",
  mifir: "MiFIR",
  benchmark_reg: "Benchmarks Regulation",
  eu_taxonomy: "EU Taxonomy",
  sbai_ddq: "SBAI DDQ",
};
