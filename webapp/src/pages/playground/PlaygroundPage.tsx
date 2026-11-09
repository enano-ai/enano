/**
 * /playground — three-pane obligation workspace styled after files.md
 * (app.files.md). Left: editable markdown source of the document. Middle:
 * live obligation matches (matched / not matched) from the same in-browser
 * engine /prototype runs. Right: obligation detail pane that slides in like
 * files.md's split editor — no modals. Nothing is uploaded.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { installPageMeta } from "@/lib/page-meta";
import { hasDebugFlag } from "@/lib/debug-flags";
import { analyzeDocument, type AnalysisResult } from "../ddq/engine";
import { blockCharRanges, textToBlocks } from "../ddq/text-blocks";
import { resolveAdvice } from "../ddq/advice";
import {
  DDQ_INSTRUMENT_LABELS,
  type DdqDocument,
  type DdqFinding,
  type DdqIssueCategory,
  type DdqSeverity,
} from "../ddq/ddq-mock-data";
import { FUND_DOCS_INSTRUMENT_LABELS } from "../ddq/fund-docs-pack";
import { loadFundDocsPacks } from "../ddq/fund-docs-pack-loader";
import {
  probeFundDocsCapabilities,
  loadScanScopeModelWeights,
  getScanScopeSemanticModels,
  scanScopeModelIds,
  type CapabilityStatus,
  type FundDocsCapabilityReport,
} from "../ddq/semantic-models";
import { enrichDocumentSemantics, GOALS_CATALOG, S2_BRACKET_BOUNDARY } from "../ddq/semantic-layer";
import { RELEASE_PACK, RELEASE_PACK_VERSION, FUND_DOCS_MANIFEST, type ReleaseDetector } from "../ddq/pack-v2";
import { subjectProfile } from "./profile-images";
import hnPdCatalogFile from "./hn-pd-catalog.json";
import CodeMirror from "@uiw/react-codemirror";
import { EditorView, Decoration, lineNumbers, type DecorationSet } from "@codemirror/view";
import { Compartment, RangeSetBuilder, StateEffect, StateField, type EditorState, type Range, type Text } from "@codemirror/state";
import { undo, redo, selectAll } from "@codemirror/commands";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FileText, ListChecks, Info, ExternalLink } from "lucide-react";
import { resetModelCaches } from "@/lib/nano/runtime";
import { ModelSelect, type ModelOption } from "@/components/ui/model-select";
import { modelZipUrl } from "./model-zips";
import modelZipSizes from "./model-zip-sizes.json";
import { panelsAfterElevationSelect, panelsAfterHighlightDrill, type PanelOpenState } from "./panel-state";
import modelZipCountsRaw from "./model-zip-counts.json";
import sampleGoalsDemo from "../ddq/samples/Goals_Demo_Personal.md?raw";
import samplePitchDeck from "../ddq/samples/Pitch_Deck_PreSeed_Demo.md?raw";
import sampleCareerAdvice from "../ddq/samples/Career_Advice_Demo.md?raw";
import "./playground.css";

const INSTRUMENT_LABELS: Record<string, string> = {
  ...DDQ_INSTRUMENT_LABELS,
  ...FUND_DOCS_INSTRUMENT_LABELS,
  aurelius_meditations: "Meditations",
  allen_as_a_man_thinketh_1903: "As a Man Thinketh",
  allen_getting_things_done: "Getting Things Done",
  atomic_habits_clear_2018: "Atomic Habits",
  bennett_how_to_live_1908: "How to Live on 24 Hours a Day",
  covey_7_habits_1989: "The 7 Habits of Highly Effective People",
  doerr_measure_what_matters: "Measure What Matters",
  epictetus_enchiridion: "Enchiridion",
  franklin_autobiography_13_virtues: "The Autobiography: 13 Virtues",
  hill_law_of_success_1928: "The Law of Success",
  james_habit_ch4_1890: "The Principles of Psychology",
  rubin_happiness_project: "The Happiness Project",
  seneca_shortness_of_life: "On the Shortness of Life",
  smiles_self_help_1859: "Self-Help",
  wattles_science_of_getting_rich_1910: "The Science of Getting Rich",
  carnegie_art_of_public_speaking: "The Art of Public Speaking",
  plato_republic: "The Republic",
  thoreau_walden_1854: "Walden",
  sequoia_business_plan: "Sequoia Business Plan",
  yc_seed_deck: "YC Seed Deck",
  kawasaki_102030: "Kawasaki 10/20/30",
  mcclure_pitch_vc: "McClure Pitch to VC",
  jarvis_seed_template: "Jarvis Seed Template",
  lorimer_self_made_merchant_1902: "Letters from a Self-Made Merchant",
  parsons_choosing_a_vocation_1909: "Choosing a Vocation",
  atkinson_power_of_concentration: "The Power of Concentration",
  boethius_consolation_of_philosophy: "The Consolation of Philosophy",
  conwell_acres_of_diamonds: "Acres of Diamonds",
  coue_self_mastery_autosuggestion: "Self Mastery Through Conscious Autosuggestion",
  emerson_conduct_of_life_1860: "The Conduct of Life",
  emerson_essays_first_series_1841: "Essays, First Series",
  marden_iron_will_1901: "Iron Will",
  plato_apology: "Apology",
  russell_conquest_of_happiness: "The Conquest of Happiness",
  braddy_business_etiquette_1922: "The Book of Business Etiquette",
  crowther_how_to_write_letters_1922: "How to Write Letters",
  scott_efficiency_in_business_1911: "Increasing Human Efficiency in Business",
};

const INSTRUMENT_AUTHORS: Record<string, string> = {
  aurelius_meditations: "Marcus Aurelius",
  allen_as_a_man_thinketh_1903: "James Allen",
  allen_getting_things_done: "David Allen",
  atomic_habits_clear_2018: "James Clear",
  bennett_how_to_live_1908: "Arnold Bennett",
  covey_7_habits_1989: "Stephen R. Covey",
  doerr_measure_what_matters: "John Doerr",
  epictetus_enchiridion: "Epictetus",
  franklin_autobiography_13_virtues: "Benjamin Franklin",
  hill_law_of_success_1928: "Napoleon Hill",
  james_habit_ch4_1890: "William James",
  rubin_happiness_project: "Gretchen Rubin",
  seneca_shortness_of_life: "Seneca",
  smiles_self_help_1859: "Samuel Smiles",
  wattles_science_of_getting_rich_1910: "Wallace D. Wattles",
  carnegie_art_of_public_speaking: "Dale Carnegie",
  plato_republic: "Plato",
  thoreau_walden_1854: "Henry David Thoreau",
  sequoia_business_plan: "Sequoia Capital",
  yc_seed_deck: "Y Combinator",
  kawasaki_102030: "Guy Kawasaki",
  mcclure_pitch_vc: "Dave McClure",
  jarvis_seed_template: "Jarvis",
  lorimer_self_made_merchant_1902: "George Horace Lorimer",
  parsons_choosing_a_vocation_1909: "Frank Parsons",
  atkinson_power_of_concentration: "Theron Q. Dumont (William Walker Atkinson)",
  boethius_consolation_of_philosophy: "Boethius",
  conwell_acres_of_diamonds: "Russell H. Conwell",
  coue_self_mastery_autosuggestion: "Émile Coué",
  emerson_conduct_of_life_1860: "Ralph Waldo Emerson",
  emerson_essays_first_series_1841: "Ralph Waldo Emerson",
  marden_iron_will_1901: "Orison Swett Marden",
  plato_apology: "Plato",
  russell_conquest_of_happiness: "Bertrand Russell",
  braddy_business_etiquette_1922: "Nella Braddy",
  crowther_how_to_write_letters_1922: "Mary Owens Crowther",
  scott_efficiency_in_business_1911: "Walter Dill Scott",
};

const SEVERITY_ORDER: Record<DdqSeverity, number> = { high: 0, medium: 1, low: 2 };

/** In-copyright books (per the pipeline manifest, bundled as catalog source
 * metadata) — flagged with the blue rights tint in the match list. */
const isCopyrighted = (instrument: string) =>
  GOALS_CATALOG.sources?.[instrument]?.rights_status === "copyrighted";

const SEVERITY_KEY: Record<DdqSeverity, string> = {
  high: "severityHigh",
  medium: "severityMedium",
  low: "severityLow",
};

/** Pipeline trigger_level → chip label (absent/none renders nothing). */
const TRIGGER_KEY: Record<string, string> = {
  high: "triggerHigh",
  medium: "triggerMedium",
  low: "triggerLow",
};

const CATEGORY_KEY: Record<DdqIssueCategory, string> = {
  evidenced: "categoryEvidenced",
  unsupported_claim: "categoryUnsupportedClaim",
  vague_disclosure: "categoryVagueDisclosure",
  missing_disclosure: "categoryMissingDisclosure",
  inconsistency: "categoryInconsistency",
  presentation_gap: "categoryPresentationGap",
  data_quality: "categoryDataQuality",
};

const CAP_STATUS_KEY: Record<CapabilityStatus, string> = {
  pending: "capStatusPending",
  checking: "capStatusChecking",
  ready: "capStatusReady",
  unavailable: "capStatusUnavailable",
};

/** CapabilityStatus plus the local-only "downloading" state the Models icon
 * shows while weights stream in (not part of the shared probe report). */
type CapIconStatus = CapabilityStatus | "downloading";

/** Runtime-gate glyphs for the toolbar status strip (WebGPU / WASM / models). */const CAP_GLYPHS: Record<string, React.ReactNode> = {
  webgpu: (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
      <rect x="7" y="7" width="10" height="10" rx="1.2" />
      <path d="M10 7V4M14 7V4M10 20v-3M14 20v-3M7 10H4M7 14H4M20 10h-3M20 14h-3" />
    </svg>
  ),
  wasm: (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3l8 4.5-8 4.5-8-4.5L12 3z" />
      <path d="M4 12.2l8 4.5 8-4.5" />
      <path d="M4 16.6l8 4.5 8-4.5" />
    </svg>
  ),
  models: (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3l8 4v10l-8 4-8-4V7l8-4z" />
      <path d="M12 11l8-4M12 11L4 7M12 11v10" />
    </svg>
  ),
};

const CAP_SPINNER = (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" className="pg-cap-spin" aria-hidden="true">
    <path d="M12 3a9 9 0 0 1 9 9" />
  </svg>
);

/** One toolbar status indicator: glyph (or spinner while checking /
 * downloading), green on ready, muted otherwise. Non-interactive; the
 * label rides a pure-CSS data-tooltip (files.md's own pattern) so it
 * appears with zero delay. Weight-download progress lives on the Models
 * icon here — the subbar progress bar is scan progress only. */
function CapabilityIcon({
  gate,
  status,
  label,
  statusText,
}: {
  gate: "webgpu" | "wasm" | "models";
  status: CapIconStatus;
  label: string;
  statusText: string;
}) {
  const cls =
    status === "ready"
      ? "pg-cap pg-cap-ready"
      : status === "checking" || status === "downloading"
        ? "pg-cap pg-cap-checking"
        : status === "unavailable"
          ? "pg-cap pg-cap-unavailable"
          : "pg-cap";
  return (
    <span
      className={cls}
      data-tooltip={`${label} · ${statusText}`}
      role="img"
      aria-label={`${label} · ${statusText}`}
    >
      {status === "checking" || status === "downloading" ? CAP_SPINNER : CAP_GLYPHS[gate]}
    </span>
  );
}

/** Highlight the matched span inside an evidence excerpt. */
function Highlighted({ text, needle }: { text: string; needle?: string | null }) {
  if (!needle || needle.length === 0 || !text.includes(needle)) return <>{text}</>;
  const parts = text.split(needle);
  return (
    <>
      {parts.map((part, index) => (
        <span key={index}>
          {part}
          {index < parts.length - 1 && <mark>{needle}</mark>}
        </span>
      ))}
    </>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Drill-down order for a clicked highlight: evidenced over candidates,
 * regex over semantic, then confidence and title. The strongest match on a
 * block is what the detail pane opens by default. */
function byBestMatch(a: DdqFinding, b: DdqFinding): number {
  return (
    Number(b.category === "evidenced") - Number(a.category === "evidenced") ||
    Number(a.weak_signal === "semantic") - Number(b.weak_signal === "semantic") ||
    b.confidence - a.confidence ||
    a.title.localeCompare(b.title)
  );
}

/** One demo document per model — the File/Load demo sample menu item and the
 * auto-swap on model switch both resolve through this mapping. */
function demoSampleForScope(id: string): string {
  return id === "pitch-decks"
    ? samplePitchDeck
    : id === "career-advice"
      ? sampleCareerAdvice
      : sampleGoalsDemo;
}

const SAMPLE_TEXTS = [sampleGoalsDemo, samplePitchDeck, sampleCareerAdvice];

/** Instruments of the personal-goals vertical (default scan scope). */
const GOALS_INSTRUMENTS = [
  "aurelius_meditations",
  "allen_as_a_man_thinketh_1903",
  "allen_getting_things_done",
  "atomic_habits_clear_2018",
  "bennett_how_to_live_1908",
  "covey_7_habits_1989",
  "doerr_measure_what_matters",
  "epictetus_enchiridion",
  "franklin_autobiography_13_virtues",
  "hill_law_of_success_1928",
  "james_habit_ch4_1890",
  "rubin_happiness_project",
  "seneca_shortness_of_life",
  "smiles_self_help_1859",
  "wattles_science_of_getting_rich_1910",
  "atkinson_power_of_concentration",
  "boethius_consolation_of_philosophy",
  "conwell_acres_of_diamonds",
  "coue_self_mastery_autosuggestion",
  "emerson_conduct_of_life_1860",
  "emerson_essays_first_series_1841",
  "marden_iron_will_1901",
  "plato_apology",
  "russell_conquest_of_happiness",
];

/** Instruments of the startup pitch-decks vertical. */
const PITCH_INSTRUMENTS = [
  "sequoia_business_plan",
  "yc_seed_deck",
  "kawasaki_102030",
  "mcclure_pitch_vc",
  "jarvis_seed_template",
];

/** Instruments of the career-advice vertical (extraction pending in the
 * pipeline — the scan scope is wired and returns results as soon as the
 * release pack lands). */
const CAREER_INSTRUMENTS = [
  "lorimer_self_made_merchant_1902",
  "parsons_choosing_a_vocation_1909",
  "braddy_business_etiquette_1922",
  "crowther_how_to_write_letters_1922",
  "scott_efficiency_in_business_1911",
];
type ScanScope = "goals" | "funds" | "pitch-decks" | "career-advice";

const goalsPackStats = FUND_DOCS_MANIFEST.instruments
  .filter((instrument) => GOALS_INSTRUMENTS.includes(instrument.instrument))
  .reduce(
    (sums, instrument) => ({
      detectors: sums.detectors + instrument.groups,
      patterns: sums.patterns + instrument.patterns,
    }),
    { detectors: 0, patterns: 0 }
  );

const pitchPackStats = FUND_DOCS_MANIFEST.instruments
  .filter((instrument) => PITCH_INSTRUMENTS.includes(instrument.instrument))
  .reduce(
    (sums, instrument) => ({
      detectors: sums.detectors + instrument.groups,
      patterns: sums.patterns + instrument.patterns,
    }),
    { detectors: 0, patterns: 0 }
  );

const careerPackStats = FUND_DOCS_MANIFEST.instruments
  .filter((instrument) => CAREER_INSTRUMENTS.includes(instrument.instrument))
  .reduce(
    (sums, instrument) => ({
      detectors: sums.detectors + instrument.groups,
      patterns: sums.patterns + instrument.patterns,
    }),
    { detectors: 0, patterns: 0 }
  );

/** Brand models exposed in the toolbar select. ids map to scan scopes; only
 * live models are listed — roadmap entries stay out until they scan. */
const NANO_MODEL_STATS = [
  { label: "parameters", value: "33M" },
  // Placeholder — replaced at render with the size of the file the runtime
  // will ACTUALLY fetch on this device (67 MB fp16 on WebGPU, 34 MB q8 on
  // WASM/CPU). One model, one download — never both.
  { label: "download size", value: "" },
  { label: "embeddings", value: "384-d" },
];

const BRAND_MODELS: ModelOption[] = [
  {
    id: "goals",
    title: "Personal Goals Nano Model",
    shortTitle: "Personal Goals",
    model: "etiny-per-goals",
    description: "Scans personal goals and plans for milestones, tasks and review dates.",
    packageUrl: modelZipUrl("enano-personal-goals-model.zip"),
    stats: [
      ...NANO_MODEL_STATS,
      {
        label: "rule pack",
        value: `${goalsPackStats.detectors} detectors · ${goalsPackStats.patterns} patterns`,
      },
    ],
  },
  {
    id: "pitch-decks",
    title: "Startup Pitch Decks Nano Model",
    shortTitle: "Startup Pitch Decks",
    model: "etiny-ent-startup-pitch",
    description: "Reviews startup pitch decks for commitments, traction and metrics claims, and fundraising milestones.",
    packageUrl: modelZipUrl("enano-pitch-decks-model.zip"),
    stats: [
      ...NANO_MODEL_STATS,
      {
        label: "rule pack",
        value: `${pitchPackStats.detectors} detectors · ${pitchPackStats.patterns} patterns`,
      },
    ],
  },
  {
    id: "career-advice",
    title: "Career Advice Nano Model",
    shortTitle: "Career Advice",
    model: "etiny-career-advice",
    description: "Reviews career plans, job searches and interview prep for concrete next steps, preparation and follow-through.",
    stats: [
      ...NANO_MODEL_STATS,
      {
        label: "rule pack",
        value: `${careerPackStats.detectors} detectors · ${careerPackStats.patterns} patterns`,
      },
    ],
  },
];

/** Download-dialog copy per packaged model — same format, different mix:
 * headline stats plus the rows of the contents list (locale keys). The
 * headline counts come from model-zip-counts.json (written by the bundle
 * builder) so the dialog always describes the ACTUAL zip contents, never
 * the live in-app scan pack. */
const modelZipCounts = modelZipCountsRaw as Record<
  string,
  { elevators?: number; detectors?: number; patterns?: number; elevations?: number; advice?: number; models?: number }
>;
const goalsZipCounts = modelZipCounts["enano-personal-goals-model.zip"];
const MODEL_PACKAGES: Record<string, { zip: string; headline: string; rows: string[] }> = {
  goals: {
    zip: "enano-personal-goals-model.zip",
    headline: goalsZipCounts
      ? `${goalsZipCounts.elevators?.toLocaleString("en-US") ?? 0} source works · ${goalsZipCounts.patterns?.toLocaleString("en-US") ?? 0} rules · ${goalsZipCounts.advice?.toLocaleString("en-US") ?? 0} coaching notes`
      : "counts update after the next bundle rebuild",
    rows: [
      "pkgDetectors",
      "pkgElevations",
      "pkgAdvice",
      "pkgElevators",
      "pkgWeights",
      "pkgTools",
      "pkgSkill",
      "pkgDocs",
    ],
  },
  "pitch-decks": {
    zip: "enano-pitch-decks-model.zip",
    headline: "Weights only · deck rules not included yet",
    rows: ["pkgWeights", "pkgTools", "pkgDocs"],
  },
};

/** Hacker News public-domain book census (non-fiction): every classic HN
 * recommends whose original is out of copyright, ranked by HN popularity. */
const hnPdCatalog = hnPdCatalogFile as unknown as {
  schema: string;
  book_count: number;
  books: {
    title: string;
    author: string;
    year: number;
    hn_rank: number;
    hn_mentions: number;
    topics: string[];
    url: string;
  }[];
};
const HN_PD_CATALOG = hnPdCatalog;

type HighlightClass = "s5" | "s4" | "s3" | "s2" | "s1";

interface HighlightSpan {
  start: number;
  end: number;
  cls: HighlightClass;
  finding: DdqFinding;
  /** Evidence provenance: "re" = regex pack, "sem" = embedder. */
  src: "re" | "sem";
}

const HIGHLIGHT_PRIORITY: Record<HighlightClass, number> = { s1: 0, s2: 1, s3: 2, s4: 3, s5: 4 };

/** Five confidence bands cut at the engine's own landmarks: 0.90 = strong
 * regex strength, 0.75 = semantic evidenced graduation / weak-signal ceiling,
 * 0.60 = loose strength and topic-only deriveds, and the s2 boundary is
 * S2_BRACKET_BOUNDARY — the same constant SEMANTIC_FLOOR anchors to, so the
 * baseline cutoff and this bracket are one number, not two that can drift. */
const SCORE_TIERS: { id: HighlightClass; min: number; labelKey: string }[] = [
  { id: "s5", min: 0.9, labelKey: "filterS5" },
  { id: "s4", min: 0.75, labelKey: "filterS4" },
  { id: "s3", min: 0.6, labelKey: "filterS3" },
  { id: "s2", min: S2_BRACKET_BOUNDARY, labelKey: "filterS2" },
  { id: "s1", min: 0, labelKey: "filterS1" },
];

function scoreTier(confidence: number): HighlightClass {
  for (const tier of SCORE_TIERS) {
    if (confidence >= tier.min) return tier.id;
  }
  return "s1";
}

/** Dedupe evidence rows within ONE obligation's match list on (block,
 * offset, matched text) — identical quotes arriving via both the regex and
 * semantic paths collapse to one. Scoped per call by design: identical
 * spans belonging to DIFFERENT obligations are distinct evidence and must
 * all survive. */
function dedupeMatches(matches: DdqFinding["matches"]): DdqFinding["matches"] {
  const seen = new Set<string>();
  const out: DdqFinding["matches"] = [];
  for (const match of matches) {
    const key = `${match.block_id ?? ""}|${match.char_offset}|${(match.matched_text ?? "").trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(match);
  }
  return out;
}

/** CodeMirror plumbing for the obligation highlights: marks are decocorations
 * driven through a state field, so they survive typing (ranges map through
 * changes) instead of being re-rendered by React. */
const addHighlights = StateEffect.define<Range<Decoration>[]>();

const highlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    let next = value.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(addHighlights)) next = Decoration.set(effect.value, true);
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** Markdown presentation: ATX headers 1-4 (#..####) and setext headers (a
 * text line underlined by === / ---) render as headings; standalone ---
 * rules render as a divider line. Cursor-sensitive: putting the caret on
 * a collapsed line reveals its raw text so it can be edited or deleted. */
const MD_ATX = /^(#{1,4})(?=\s|$)/;
const MD_SETEXT_H1 = /^=+\s*$/;
const MD_SETEXT_H2 = /^-{3,}\s*$/;
const MD_EMPHASIS = /\*\*(?=\S)([\s\S]*?\S)\*\*|\*(?=[^\s*])([^*]*?[^\s*])\*/g;

/** Hide the ** / * markers and style the inner text (bold/italic). */
function addEmphasis(
  marks: RangeSetBuilder<Decoration>,
  replaces: RangeSetBuilder<Decoration>,
  line: { from: number; text: string }
): void {
  MD_EMPHASIS.lastIndex = 0;
  for (let m = MD_EMPHASIS.exec(line.text); m; m = MD_EMPHASIS.exec(line.text)) {
    const from = line.from + m.index;
    const to = line.from + m.index + m[0].length;
    if (m[1] !== undefined) {
      replaces.add(from, from + 2, Decoration.replace({}));
      marks.add(from + 2, to - 2, Decoration.mark({ class: "pg-md-bold" }));
      replaces.add(to - 2, to, Decoration.replace({}));
    } else {
      replaces.add(from, from + 1, Decoration.replace({}));
      marks.add(from + 1, to - 1, Decoration.mark({ class: "pg-md-italic" }));
      replaces.add(to - 1, to, Decoration.replace({}));
    }
  }
}

function mdLineClass(text: string): string | null {
  const atx = MD_ATX.exec(text);
  if (atx) return `pg-md-h${atx[1].length}`;
  return null;
}

/** A standalone --- rule renders as a drawn divider; the dashes stay in the
 * layout (transparent) so the caret can land on the line, which reveals them
 * for editing or deletion. Hidden ranges (heading prefixes, emphasis
 * markers) land in a separate replace set: it is registered as atomic ranges
 * so vertical caret motion never lands inside hidden text (which used to
 * catapult the caret to the document start on ArrowUp). */
function buildMdDecorations(state: EditorState): { marks: DecorationSet; replaces: DecorationSet } {
  const doc = state.doc;
  const cursorLines = new Set<number>();
  for (const range of state.selection.ranges) {
    cursorLines.add(doc.lineAt(range.from).number);
    cursorLines.add(doc.lineAt(range.to).number);
  }
  const builder = new RangeSetBuilder<Decoration>();
  const hidden = new RangeSetBuilder<Decoration>();
  const addLine = (pos: number, cls: string) => builder.add(pos, pos, Decoration.line({ class: cls }));
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const atx = mdLineClass(line.text);
    if (atx) {
      addLine(line.from, atx);
      const prefix = /^#{1,4}[ \t]+/.exec(line.text);
      if (prefix) hidden.add(line.from, line.from + prefix[0].length, Decoration.replace({}));
      continue;
    }
    if (line.text.trim() && MD_SETEXT_H2.test(line.text) && (i === 1 || !doc.line(i - 1).text.trim())) {
      addLine(line.from, cursorLines.has(i) ? "pg-md-hr pg-md-hr-open" : "pg-md-hr");
      continue;
    }
    if (i < doc.lines && line.text.trim()) {
      const next = doc.line(i + 1);
      if (MD_SETEXT_H1.test(next.text)) {
        addLine(line.from, "pg-md-h1");
        addLine(next.from, cursorLines.has(i + 1) ? "pg-md-marker pg-md-marker-open" : "pg-md-marker");
      } else if (MD_SETEXT_H2.test(next.text) && !MD_SETEXT_H2.test(line.text)) {
        addLine(line.from, "pg-md-h2");
        addLine(next.from, cursorLines.has(i + 1) ? "pg-md-marker pg-md-marker-open" : "pg-md-marker");
      } else {
        addEmphasis(builder, hidden, line);
      }
      continue;
    }
    if (line.text.trim()) {
      addEmphasis(builder, hidden, line);
    }
  }
  return { marks: builder.finish(), replaces: hidden.finish() };
}

const mdDecorationsField = StateField.define<DecorationSet>({
  create: (state) => buildMdDecorations(state).marks,
  update: (value, transaction) =>
    transaction.docChanged || transaction.selection ? buildMdDecorations(transaction.state).marks : value,
  provide: (field) => EditorView.decorations.from(field),
});

const mdHiddenField = StateField.define<DecorationSet>({
  create: (state) => buildMdDecorations(state).replaces,
  update: (value, transaction) =>
    transaction.docChanged || transaction.selection ? buildMdDecorations(transaction.state).replaces : value,
  provide: (field) => [
    EditorView.decorations.from(field),
    EditorView.atomicRanges.of((view) => view.state.field(field)),
  ],
});

/** Compartments let the View menu toggle wrap + line numbers live. */
const wrapCompartment = new Compartment();
const gutterCompartment = new Compartment();

/** Paper theme via .pg-root variables (the editor lives inside .pg-root, so
 * the custom properties resolve) — matches files.md metrics. */
const pgEditorTheme = EditorView.theme({
  "&": { backgroundColor: "var(--pg-bg)", color: "var(--pg-tx)", fontSize: "15px" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--pg-font)",
    lineHeight: "1.55",
  },
  ".cm-content": { paddingBottom: "40vh", paddingTop: "20px" },
  ".cm-gutters": {
    backgroundColor: "var(--pg-bg)",
    color: "var(--pg-tx-alt)",
    opacity: 0.7,
    border: "none",
    fontFamily: "var(--pg-font)",
    fontSize: "10.5px",
    lineHeight: "1.55",
    paddingLeft: "14px",
    paddingRight: "6px",
  },
  ".cm-activeLine": { backgroundColor: "transparent" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--pg-accent)", opacity: 1 },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "currentColor" },
  "&.cm-focused .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "var(--pg-selection)",
  },
  ".cm-content .pg-hl": { cursor: "pointer", borderRadius: "2px" },
  ".cm-content .pg-hl-s5": { backgroundColor: "rgba(63, 122, 68, 0.30)" },
  ".cm-content .pg-hl-s4": { backgroundColor: "rgba(139, 161, 74, 0.30)" },
  ".cm-content .pg-hl-s3": { backgroundColor: "rgba(164, 125, 31, 0.26)" },
  ".cm-content .pg-hl-s2": { backgroundColor: "rgba(184, 100, 31, 0.26)" },
  ".cm-content .pg-hl-s1": { backgroundColor: "rgba(165, 66, 60, 0.26)" },
});

const LIST_MIN = 240;
const DETAIL_MIN = 320;
const DETAIL_MAX = 720;

/**
 * Column boundary handle (files.md .resize pattern): 11px hit area over the
 * border, orange accent line on hover/focus, drag with pointer capture and
 * Arrow keys (Shift = coarse step). The handle tracks the DIVIDER: dragging
 * right always moves the divider right. `reverse` is required when the bound
 * pane sits right of its divider with a flex pane to its left (both panes
 * here), because its width must then SHRINK as the divider moves right:
 * divider position = viewport - paneWidth - (panes to its right).
 */
function ResizeHandle({
  label,
  value,
  min,
  max,
  reverse,
  onChange,
  onActiveChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  reverse?: boolean;
  onChange: (next: number) => void;
  onActiveChange: (active: boolean) => void;
}) {
  const dragStart = useRef<{ x: number; value: number } | null>(null);
  const [active, setActive] = useState(false);

  const apply = (clientX: number) => {
    const start = dragStart.current;
    if (!start) return;
    const delta = reverse ? start.x - clientX : clientX - start.x;
    onChange(clamp(start.value + delta, min, max));
  };

  const step = (direction: 1 | -1, coarse: boolean) => {
    const px = coarse ? 48 : 16;
    onChange(clamp(value + (reverse ? -direction : direction) * px, min, max));
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title={label}
      tabIndex={0}
      className={active ? "pg-resize pg-resize-active" : "pg-resize"}
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        dragStart.current = { x: event.clientX, value };
        setActive(true);
        onActiveChange(true);
      }}
      onPointerMove={(event) => {
        if (dragStart.current) apply(event.clientX);
      }}
      onPointerUp={() => {
        dragStart.current = null;
        setActive(false);
        onActiveChange(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          step(-1, event.shiftKey);
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          step(1, event.shiftKey);
        }
      }}
    />
  );
}

/** Vertical variant of ResizeHandle: drags the matches/elevators split as a
 * percentage of the pane height (Arrow keys grow/shrink the top half). */
function SplitHandle({
  label,
  value,
  min,
  max,
  containerRef,
  onChange,
  onActiveChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  containerRef: RefObject<HTMLElement | null>;
  onChange: (next: number) => void;
  onActiveChange: (active: boolean) => void;
}) {
  const [active, setActive] = useState(false);

  const apply = (clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.height === 0) return;
    const pct = ((clientY - rect.top) / rect.height) * 100;
    onChange(Math.round(clamp(pct, min, max) * 10) / 10);
  };

  const step = (direction: 1 | -1, coarse: boolean) => {
    onChange(clamp(value + direction * (coarse ? 6 : 2), min, max));
  };

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={label}
      title={label}
      tabIndex={0}
      className={active ? "pg-list-split pg-list-split-active" : "pg-list-split"}
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        setActive(true);
        onActiveChange(true);
      }}
      onPointerMove={(event) => {
        if (active) apply(event.clientY);
      }}
      onPointerUp={() => {
        setActive(false);
        onActiveChange(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowUp") {
          event.preventDefault();
          step(1, event.shiftKey);
        } else if (event.key === "ArrowDown") {
          event.preventDefault();
          step(-1, event.shiftKey);
        }
      }}
    />
  );
}

export default function PlaygroundPage() {
  const { t } = useTranslation("playground");
  const [text, setText] = useState("");
  const [scope, setScope] = useState<ScanScope>("goals");
  /** Store integration (enano web only): models installed in the local store
   * and the source works inside the active one. Null = no local backend
   * (public deploy), which keeps every model and book visible. */
  const [installedModels, setInstalledModels] = useState<string[] | null>(null);
  const [storeElevators, setStoreElevators] = useState<string[] | null>(null);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<DdqFinding | null>(null);
  const [packsReady, setPacksReady] = useState(false);
  const [search, setSearch] = useState("");
  /** Highlight drill-down: the block whose findings fill the matches pane.
   * Null shows every obligation; set by clicking a highlight in the editor. */
  const [blockFilterId, setBlockFilterId] = useState<string | null>(null);
  const [expandedBooks, setExpandedBooks] = useState<Set<string>>(() => new Set());
  const [modelPending, setModelPending] = useState(false);
  const [modelStage, setModelStage] = useState<{ phase: "download" | "index" | "match"; pct: number } | null>(null);
  const [mobileTab, setMobileTab] = useState<"editor" | "list" | "detail">("editor");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [fallbackNoticeOpen, setFallbackNoticeOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [librarySearch, setLibrarySearch] = useState("");
  const [listWidth, setListWidth] = useState(340);
  const [detailWidth, setDetailWidth] = useState(() =>
    clamp(Math.round(window.innerWidth * 0.45), DETAIL_MIN, 560)
  );
  const [resizing, setResizing] = useState(false);
  const [hiddenTiers, setHiddenTiers] = useState<Set<HighlightClass>>(() => new Set());
  const savedVisibleTiers = useRef<Set<HighlightClass> | null>(null);
  const filtersOn = hiddenTiers.size < SCORE_TIERS.length;
  /** Master switch off also pauses the scan pipeline: no regex, no model,
   * no state churn on edits — the published elevations stay frozen. */
  const [scanningPaused, setScanningPaused] = useState(false);
  const scanningPausedRef = useRef(false);
  scanningPausedRef.current = scanningPaused;

  /** Master switch: off hides every tier, pauses the scan pipeline and
   * remembers which were visible; on restores exactly that selection
   * (all tiers when nothing was saved) and re-runs the scan. */
  const toggleAllFilters = useCallback(() => {
    const allHidden = hiddenTiers.size >= SCORE_TIERS.length;
    if (!allHidden) {
      savedVisibleTiers.current = new Set(
        SCORE_TIERS.filter((tier) => !hiddenTiers.has(tier.id)).map((tier) => tier.id)
      );
      setHiddenTiers(new Set(SCORE_TIERS.map((tier) => tier.id)));
      setScanningPaused(true);
      return;
    }
    const saved = savedVisibleTiers.current;
    setHiddenTiers(new Set(SCORE_TIERS.filter((tier) => !saved?.has(tier.id)).map((tier) => tier.id)));
    setScanningPaused(false);
  }, [hiddenTiers]);
  const [showLineNumbers, setShowLineNumbers] = useState(true);
  const [softWrap, setSoftWrap] = useState(true);
  const [listOpen, setListOpen] = useState(true);
  const [detailsOpen, setDetailsOpen] = useState(false);
  /** Applies a panel-visibility rule (see panel-state.ts) — the single
   * funnel every selection path uses so a closed pane can never swallow
   * a click. */
  const revealPanels = useCallback((next: PanelOpenState) => {
    setListOpen(next.list);
    setDetailsOpen(next.details);
  }, []);
  const [matchesPct, setMatchesPct] = useState(50);
  const [splitDragging, setSplitDragging] = useState(false);
  const listPaneRef = useRef<HTMLElement | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [capability, setCapability] = useState<FundDocsCapabilityReport | null>(null);
  /** Weight-download gate: the toolbar Models icon is a system check only;
   * this says whether the weights are actually fetched and usable. */
  const [weightsGate, setWeightsGate] = useState<CapabilityStatus>("pending");
  const weightsGateRef = useRef<CapabilityStatus>("pending");
  /** Weight-download percentage while the Models icon shows its downloading
   * state; null when idle. Monotonic — the loader's dtype ladder retries
   * (fp16 → fp32 → q8) each re-fire progress from 0, and the icon must never
   * run backwards. */
  const [weightsPct, setWeightsPct] = useState<number | null>(null);
  /** Result surfaces (rows, highlights, chips) stay empty until the scan
   * pipeline publishes ONCE with both passes fused. No intermediate
   * regex-only state exists, so nothing can flicker or jump mid-scan. */
  const [resultsPending, setResultsPending] = useState(true);
  useEffect(() => {
    weightsGateRef.current = weightsGate;
  }, [weightsGate]);
  /** Scan pipelines started while weights are still downloading await this
   * settle promise, so a scan that begins mid-download still publishes once,
   * complete. Resolved by the watcher below on ready/unavailable. */
  const weightsSettleRef = useRef<{
    promise: Promise<"ready" | "unavailable">;
    resolve: (gate: "ready" | "unavailable") => void;
  } | null>(null);
  if (!weightsSettleRef.current) {
    let resolve!: (gate: "ready" | "unavailable") => void;
    const promise = new Promise<"ready" | "unavailable">((res) => {
      resolve = res;
    });
    weightsSettleRef.current = { promise, resolve };
  }
  useEffect(() => {
    if (weightsGate === "ready") weightsSettleRef.current?.resolve("ready");
    else if (weightsGate === "unavailable") weightsSettleRef.current?.resolve("unavailable");
  }, [weightsGate]);
  const scanGeneration = useRef(0);
  /** Per-scan performance record; printed once when the last pass finishes. */
  const perfRef = useRef<{
    gen: number;
    blocks: number;
    regexMs?: number;
    indexMs?: number;
    matchMs?: number;
    semanticMs?: number;
    anchors?: number;
    findings?: number;
    tiers?: Record<string, number>;
    indexStart?: number;
    matchStart?: number;
    printed?: boolean;
  }>({ gen: -1, blocks: 0 });

  const printPerf = () => {
    const perf = perfRef.current;
    if (perf.printed || perf.gen < 0) return;
    perf.printed = true;
    console.info("[playground] performance (ms)", {
      blocks: perf.blocks,
      regex: perf.regexMs,
      indexLoad: perf.indexMs,
      match: perf.matchMs,
      semanticTotal: perf.semanticMs,
      anchors: perf.anchors,
      findings: perf.findings,
      tiers: perf.tiers,
    });
  };
  const editorViewRef = useRef<EditorView | null>(null);
  const blockRangesRef = useRef<Map<string, [number, number]>>(new Map());
  const blockFilterRef = useRef<string | null>(null);
  /** Last emitted [highlight-debug] payload — dedupes identical recomputes. */
  const lastHlDebugRef = useRef("");

  /** Detectors + advice are API-fetched (same as /prototype). Soft-fail: the
   * inline authored pack still runs without them. */
  useEffect(() => {
    let cancelled = false;
    void loadFundDocsPacks()
      .then(() => {
        if (!cancelled) setPacksReady(true);
      })
      .catch((err: unknown) => {
        console.warn("[playground] pack load failed", err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(
    () =>
      installPageMeta({
        title: t("metaTitle"),
        description: t("metaDescription"),
        url: "https://enano.ai",
      }),
    [t]
  );

  /** ?debug=fallback — force-open the neural-fallback notice so the copy
   * can be reviewed on any device without failing a model load. */
  useEffect(() => {
    if (hasDebugFlag("fallback")) setFallbackNoticeOpen(true);
  }, []);

  /**
   * Auto-run the /prototype capability gates on load (no modal): WebGPU, WASM
   * and the model specs — system checks only, no weight downloads. The
   * download itself is kicked right after and is showcased in the subbar
   * progress bar (first column, second bar), so the scan's semantic pass is
   * warm by the time the user pastes text. It is staggered past first paint:
   * the model download/WASM compile can jank the main thread, and the first
   * paste must scan before that starts.
   */
  useEffect(() => {
    let cancelled = false;
    setCapability({ webgpu: "checking", wasm: "pending", models: "pending", device: null });
    // Each scan scope ships its own fine-tuned weights: re-gate on switch and
    // re-arm the settle promise so scans started mid-download wait for THIS
    // scope's model. Stragglers from the previous scope settle regex-only.
    setWeightsGate("pending");
    weightsSettleRef.current?.resolve("unavailable");
    let rearm!: (gate: "ready" | "unavailable") => void;
    const settlePromise = new Promise<"ready" | "unavailable">((res) => {
      rearm = res;
    });
    weightsSettleRef.current = { promise: settlePromise, resolve: rearm };
    const kick = window.setTimeout(() => {
      void probeFundDocsCapabilities((report) => {
        if (!cancelled) setCapability({ ...report });
      }).then((report) => {
        if (cancelled) return;
        if (report.models !== "ready") {
          setWeightsGate("unavailable");
          return;
        }
        void loadScanScopeModelWeights(scope, (pct) => {
          if (!cancelled) setWeightsPct(pct);
        }).then((models) => {
          if (cancelled) return;
          setWeightsPct(null);
          setModelStage(null);
          setWeightsGate(models ? "ready" : "unavailable");
          if (!models) setCapability((prev) => (prev ? { ...prev, models: "unavailable" } : prev));
        });
      });
    }, 1200);
    return () => {
      cancelled = true;
      window.clearTimeout(kick);
    };
  }, [scope]);

  /** One scan pipeline per document state: debounced text -> blocks ->
   * regex pass -> (await weights if still downloading) -> semantic pass ->
   * ONE publication. Result surfaces render nothing until the pipeline
   * publishes, so rows, highlights, chips and stats always appear together
   * in their final merged state — the regex-only intermediate that used to
   * repaint the screen mid-scan no longer exists. Models unavailable: regex
   * is the whole result and publishes immediately. Generation-guarded so a
   * stale pipeline can never publish over newer text. */
  /** Scan instruments: the scope's works narrowed to what the downloaded
   * bundle actually ships (store gate — same rule as the book accordion).
   * Null store list (no backend / public deploy) scans the full scope. */
  const scanInstruments = useMemo(() => {
    const base =
      scope === "goals"
        ? GOALS_INSTRUMENTS
        : scope === "pitch-decks"
          ? PITCH_INSTRUMENTS
          : scope === "career-advice"
            ? CAREER_INSTRUMENTS
            : null;
    if (!base) return null;
    if (!storeElevators) return base;
    const filtered = base.filter((instrument) => storeElevators.includes(instrument));
    return filtered.length ? filtered : base;
  }, [scope, storeElevators]);

  useEffect(() => {
    if (scanningPausedRef.current) return;
    const trimmed = text.trim();
    const generation = scanGeneration.current;
    if (!trimmed) {
      setResult(null);
      setScanning(false);
      setError(null);
      setModelPending(false);
      setModelStage(null);
      setResultsPending(false);
      return;
    }
    setScanning(true);
    setResultsPending(true);
    // The previous document's rows/highlights are stale the moment the text
    // changes: clear them so every surface (including the chips) shows the
    // same nothing-until-final state instead of a mix of old and new.
    setResult(null);
    setSelected(null);
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const id = "playground-doc";
          const words = trimmed.split(/\s+/).filter(Boolean).length;
          const doc: DdqDocument = {
            id,
            filename: "playground.txt",
            kind: "txt",
            pages: Math.max(1, Math.round(words / 400)),
            words,
            pack_version: RELEASE_PACK_VERSION,
            detectors_version: "fd-oc-3",
            obligations_evaluated: 0,
            reviewed_at: new Date().toISOString(),
            blocks: textToBlocks(text, id),
            findings: [],
          };
          const regexStart = performance.now();
          const analyzed = analyzeDocument(
            doc,
            scanInstruments ? { instruments: scanInstruments } : undefined
          );
          perfRef.current = {
            gen: generation,
            blocks: doc.blocks.length,
            regexMs: Math.round(performance.now() - regexStart),
          };
          if (cancelled || scanGeneration.current !== generation) return;

          const gate =
            weightsGateRef.current === "ready" || weightsGateRef.current === "unavailable"
              ? weightsGateRef.current
              : await weightsSettleRef.current!.promise;
          if (cancelled || scanGeneration.current !== generation) return;
          // Master switch flipped off while the pipeline was in flight:
          // discard instead of repainting after the freeze.
          if (scanningPausedRef.current) return;

          let semantic: DdqFinding[] = [];
          if (gate === "ready") {
            // A failed semantic pass degrades to the regex-only result — it
            // never blanks the screen.
            try {
              const started = performance.now();
              console.debug("[playground] semantic pass start", {
                generation,
                blocks: doc.blocks.length,
              });
              // modelPending BEFORE the session init: WASM compile of the
              // embedder can take tens of seconds and used to run with no
              // status at all ("Scanning..." the whole time). The pending
              // flag drives the "Matching your document..." note from here.
              setModelPending(true);
              const models = await getScanScopeSemanticModels(scope);
              if (!models) {
                // Weight load or session init failed (typical on phones and
                // tablets: no WebGPU, and the single-threaded WASM tier
                // cannot sustain the session). The scan continues regex-only
                // — tell the user what that means instead of failing silent.
                setFallbackNoticeOpen(true);
                return;
              }
              if (cancelled || scanGeneration.current !== generation) return;
              const enriched = await enrichDocumentSemantics(doc, models.facts, models.check, {
                modelId: scanScopeModelIds(scope).facts,
                instruments: scanInstruments ? new Set(scanInstruments) : undefined,
                skipFacts: true,
                onProgress: (progress) => {
                  const now = performance.now();
                  const perf = perfRef.current;
                  if (perf.gen === generation) {
                    perf.anchors = progress.total;
                    if (progress.phase === "index") {
                      perf.indexStart ??= now;
                    } else {
                      if (perf.indexStart != null && perf.indexMs == null)
                        perf.indexMs = Math.round(now - perf.indexStart);
                      perf.matchStart ??= now;
                      if (progress.done >= progress.total)
                        perf.matchMs = Math.round(now - perf.matchStart);
                    }
                  }
                  console.debug(
                    `[playground] model ${progress.phase} ${progress.done}/${progress.total}`
                  );
                  if (cancelled) return;
                  setModelStage({
                    phase: progress.phase === "index" ? "index" : "match",
                    pct: Math.round((progress.done / Math.max(1, progress.total)) * 100),
                  });
                },
              });
              if (cancelled || scanGeneration.current !== generation) return;
              semantic = enriched.findings;
              const tiers = semantic.reduce<Record<string, number>>((acc, finding) => {
                const key = finding.match_tier ?? "regex";
                acc[key] = (acc[key] ?? 0) + 1;
                return acc;
              }, {});
              console.debug(
                `[playground] semantic pass done in ${Math.round(performance.now() - started)}ms`,
                { findings: semantic.length, tiers }
              );
              if (perfRef.current.gen === generation) {
                perfRef.current.semanticMs = Math.round(performance.now() - started);
                perfRef.current.findings = semantic.length;
                perfRef.current.tiers = tiers;
                printPerf();
              }
            } catch (err) {
              // Hard fail for the semantic pass (e.g. catalog vectors could
              // not load — there is no runtime-embedding fallback): degrade
              // to the regex-only result and tell the user visibly.
              console.error("[playground] semantic pass failed", err);
              setFallbackNoticeOpen(true);
            }
          }

          if (cancelled || scanGeneration.current !== generation) return;
          setResult({ ...analyzed, findings: [...analyzed.findings, ...semantic] });
          setError(null);
        } catch (err) {
          if (cancelled || scanGeneration.current !== generation) return;
          console.warn("[playground] scan pipeline failed", err);
          setResult(null);
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          if (!cancelled && scanGeneration.current === generation) {
            setScanning(false);
            setModelPending(false);
            setModelStage(null);
            setResultsPending(false);
          }
        }
      })();
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      scanGeneration.current += 1;
    };
  }, [text, scope, packsReady, scanningPaused, scanInstruments]);

  /** Esc closes the detail pane (keyboard parity with files.md's split view). */
  useEffect(() => {
    if (!selected) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSelected(null);
        setMobileTab("list");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  /** Regex + semantic findings, fused at publication time by the scan
   * pipeline — the two-pass split (and its intermediate state) is gone. */
  const allFindings = useMemo(() => result?.findings ?? [], [result]);

  /** Deduped, matched-first inspection list: regex + the embedder,
   * collapsed per obligation (highest confidence wins, evidence unions).
   * Match evidence is deduped on (block, offset, matched text) WITHIN one
   * obligation's union — the same block can arrive via regex AND semantic
   * paths with identical excerpts for the SAME obligation, which used to
   * render the same evidence quote several times. The set resets per
   * obligation: identical spans on DIFFERENT obligations are distinct
   * evidence and must all keep painting. */
  const inspections = useMemo(() => {
    const byKey = new Map<string, DdqFinding>();
    for (const finding of allFindings) {
      const key = `${finding.instrument}:${finding.obligation_id}`;
      const prev = byKey.get(key);
      if (!prev) {
        byKey.set(key, { ...finding, matches: dedupeMatches(finding.matches) });
        continue;
      }
      const [keep, drop] =
        finding.confidence >= prev.confidence ? [finding, prev] : [prev, finding];
      byKey.set(key, {
        ...keep,
        matches: dedupeMatches([...keep.matches, ...drop.matches]).slice(0, 12),
      });
    }
    const all = [...byKey.values()];
    return [
      ...all.filter((finding) => finding.category === "evidenced"),
      ...all
        .filter((finding) => finding.category !== "evidenced")
        .sort(
          (a, b) =>
            (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3) ||
            b.confidence - a.confidence
        ),
    ];
  }, [allFindings]);

  const listMax = Math.max(LIST_MIN + 40, Math.min(820, Math.round(window.innerWidth * 0.6)));

  /** Raw-text char range of every block (blockCharRanges mirrors
   * textToBlocks), so evidence is painted and grouped at the line it came
   * from. Edits or scope switches rebuild blocks, which drops the filter. */
  const blockRanges = useMemo(() => blockCharRanges(text, "playground-doc"), [text]);
  blockRangesRef.current = blockRanges;
  blockFilterRef.current = blockFilterId;
  useEffect(() => {
    setBlockFilterId(null);
  }, [text, scope]);

  /** Character spans in the editor text, painted from each match's own block
   * (block_id + offset). Never re-search the needle from position 0: that
   * paints its first occurrence anywhere in the document, which is the wrong
   * line whenever the needle occurs earlier than its evidence block. */
  const highlights = useMemo(() => {
    if (!text) return [] as HighlightSpan[];
    const spans: HighlightSpan[] = [];
    for (const finding of inspections) {
      // Possible-tier model findings are review-only: they stay queryable in
      // the elevations list but never paint in the editor or count in the
      // filter chips (they used to flood s1 with whole-line spans that
      // swallowed regex evidence).
      if (finding.match_tier === "possible") continue;
      const cls: HighlightClass = scoreTier(finding.confidence);
      const src: "re" | "sem" = finding.weak_signal === "semantic" ? "sem" : "re";
      for (const match of finding.matches) {
        const needle = match.matched_text?.trim();
        if (!needle || needle.length < 4) continue;
        const range = blockRanges.get(match.block_id ?? finding.block_id);
        if (!range) continue;
        const lineText = text.slice(range[0], range[1]);
        // block.text is the trimmed, normalized line ("- " stripped, pipes
        // re-spaced): locate the needle inside the raw line, falling back to
        // the block-relative offset when normalization moved it.
        let at = lineText.indexOf(needle);
        if (at < 0 && match.char_offset < lineText.length) at = match.char_offset;
        if (at < 0) continue;
        spans.push({ start: range[0] + at, end: range[0] + at + needle.length, cls, finding, src });
      }
    }
    // Bucket spread for model evidence: regex keeps absolute tiers (s5 =
    // regex-confirmed green), while direct/related model spans are re-tiered
    // by rank within their own confidence distribution (quantiles across
    // s4..s1). The raw semantic confidence is bimodal — absolute thresholds
    // left s2/s3 empty — rank-based buckets guarantee every filter carries
    // real members on any document.
    const semNatural: Record<HighlightClass, number> = { s5: 0, s4: 0, s3: 0, s2: 0, s1: 0 };
    for (const span of spans) if (span.src === "sem") semNatural[span.cls] += 1;
    const ranked = spans
      .filter((span) => span.src === "sem")
      .sort((a, b) => b.finding.confidence - a.finding.confidence);
    if (ranked.length >= 4) {
      const ladder: HighlightClass[] = ["s1", "s2", "s3", "s4"];
      ranked.forEach((span, index) => {
        span.cls = ladder[Math.min(3, Math.floor((index / ranked.length) * 4))];
      });
    }
    spans.sort((a, b) => a.start - b.start || HIGHLIGHT_PRIORITY[a.cls] - HIGHLIGHT_PRIORITY[b.cls]);
    const merged: HighlightSpan[] = [];
    // Paint-pipeline debug counters: what each source contributed per tier
    // before the interval merge, and what the merge consumed. The chips show
    // the POST-merge numbers, so this log is the ground truth for deciding
    // bucket-spread changes.
    const preTiers: Record<HighlightClass, [number, number]> = { s5: [0, 0], s4: [0, 0], s3: [0, 0], s2: [0, 0], s1: [0, 0] };
    for (const span of spans) preTiers[span.cls][span.src === "re" ? 0 : 1] += 1;
    let absorbed = 0;
    const absorbedFrom: Record<HighlightClass, number> = { s5: 0, s4: 0, s3: 0, s2: 0, s1: 0 };
    for (const span of spans) {
      const last = merged[merged.length - 1];
      if (last && span.start < last.end) {
        last.end = Math.max(last.end, span.end);
        // Strongest tier wins the merged interval: overlapping intervals
        // union geometrically but keep the highest class present, so regex
        // green evidence is never recolored by an overlapping model span.
        if (HIGHLIGHT_PRIORITY[span.cls] > HIGHLIGHT_PRIORITY[last.cls]) {
          last.cls = span.cls;
        }
        absorbed += 1;
        absorbedFrom[span.cls] += 1;
      } else {
        merged.push({ ...span });
      }
    }
    const kept = merged.slice(0, 3000);
    const postTiers: Record<HighlightClass, number> = { s5: 0, s4: 0, s3: 0, s2: 0, s1: 0 };
    for (const span of kept) postTiers[span.cls] += 1;
    const rows = {
      re: inspections.filter((f) => f.weak_signal !== "semantic").length,
      sem: inspections.filter((f) => f.weak_signal === "semantic").length,
    };
    const summary = JSON.stringify({
      spans: spans.length,
      rows,
      // per tier: [regexCount, modelCount] BEFORE the interval merge
      pre: preTiers,
      // model spans by their NATURAL (absolute) tier, before the quantile
      // remap — shows whether the blended confidence fills s2/s3 on its own
      semNatural,
      absorbed,
      // tiers whose spans were consumed into an overlapping interval
      absorbedFrom,
      // what the filter chips actually display
      post: postTiers,
      cappedOut: Math.max(0, merged.length - kept.length),
    });
    if (lastHlDebugRef.current !== summary) {
      lastHlDebugRef.current = summary;
      console.debug("[highlight-debug] " + summary);
    }
    return kept;
  }, [inspections, text, blockRanges]);

  /** Per-tier counts of the highlight marks actually painted in the editor
   * (post-merge, pre-visibility): the chips must never claim more highlights
   * than the document shows. Findings whose evidence merged into another
   * span (or had no locatable needle) are not counted — they stay in the
   * elevations list, they just do not paint. */
  const classCounts = useMemo(() => {
    const counts: Record<HighlightClass, number> = { s5: 0, s4: 0, s3: 0, s2: 0, s1: 0 };
    for (const span of highlights) counts[span.cls] += 1;
    return counts;
  }, [highlights]);

  const visibleHighlights = useMemo(
    () => highlights.filter((span) => !hiddenTiers.has(span.cls)),
    [highlights, hiddenTiers]
  );

  /** Push the visible spans into the CodeMirror decorations field. */
  useEffect(() => {
    const view = editorViewRef.current;
    if (!view) return;
    const docLength = view.state.doc.length;
    const ranges = visibleHighlights
      .filter((span) => span.start < docLength)
      .map((span) =>
        Decoration.mark({ class: `pg-hl pg-hl-${span.cls}` }).range(
          Math.min(span.start, docLength),
          Math.min(span.end, docLength)
        )
      );
    view.dispatch({ effects: addHighlights.of(ranges) });
  }, [visibleHighlights]);

  useEffect(() => {
    editorViewRef.current?.dispatch({
      effects: wrapCompartment.reconfigure(softWrap ? EditorView.lineWrapping : []),
    });
  }, [softWrap]);

  useEffect(() => {
    editorViewRef.current?.dispatch({
      effects: gutterCompartment.reconfigure(showLineNumbers ? lineNumbers() : []),
    });
  }, [showLineNumbers]);

  const editorExtensions = useMemo(
    () => [
      highlightField,
      pgEditorTheme,
      mdDecorationsField,
      mdHiddenField,
      wrapCompartment.of(EditorView.lineWrapping),
      gutterCompartment.of(lineNumbers()),
      EditorView.domEventHandlers({
        mousedown(event) {
          // The mark element is exactly the painted text, so the DOM target is
          // the only reliable "did the highlight get clicked" test: mapped
          // positions bleed past the match onto end-of-line blank space and
          // would steal the caret.
          const onHighlight = event.target instanceof Element && Boolean(event.target.closest(".pg-hl"));
          if (!onHighlight) {
            if (blockFilterRef.current !== null) setBlockFilterId(null);
            return false;
          }
          const position = editorViewRef.current?.posAtCoords({ x: event.clientX, y: event.clientY });
          if (position == null) return false;
          const block = [...blockRangesRef.current.entries()].find(
            ([, [start, end]]) => position >= start && position <= end
          );
          if (!block) return false;
          setBlockFilterId(block[0]);
          // Drill-down from the text must be visible: reopen the panels if
          // the user had closed them, or the click appears to do nothing.
          revealPanels(panelsAfterHighlightDrill({ list: listOpen, details: detailsOpen }));
          return true;
        },
      }),
    ],
    []
  );

  const instrumentLabel = useCallback(
    (instrument: string) => INSTRUMENT_LABELS[instrument] ?? instrument,
    []
  );

  // modelPending alone gates the fallback phase: the two-pass era also
  // required a published result here, but the single-publish pipeline holds
  // result null until BOTH passes finish — gating on it left the notes as
  // static "Matching your document..." text with no live percentage.
  const modelProcessing = modelPending;
  const modelStageView = modelStage ?? (modelProcessing ? { phase: "match" as const, pct: 0 } : null);
  const MODEL_PHASE_KEY = {
    download: "modelPhaseDownload",
    index: "modelPhaseIndex",
    match: "modelPhaseMatch",
  } as const;

  const searchNeedle = search.trim().toLowerCase();

  /** Obligations with any evidence on the drill-down block (regex anchor,
   * regex hit, or semantic capture). */
  const blockMatchKeys = useMemo(() => {
    if (!blockFilterId) return null;
    const keys = new Set<string>();
    for (const finding of allFindings) {
      const onBlock =
        finding.block_id === blockFilterId ||
        finding.matches.some((match) => (match.block_id ?? finding.block_id) === blockFilterId);
      if (onBlock) keys.add(`${finding.instrument}:${finding.obligation_id}`);
    }
    return keys;
  }, [blockFilterId, allFindings]);

  const drillRows = useMemo(
    () =>
      blockMatchKeys
        ? inspections
            .filter((finding) => blockMatchKeys.has(`${finding.instrument}:${finding.obligation_id}`))
            .sort(byBestMatch)
        : [],
    [inspections, blockMatchKeys]
  );

  /** A fresh drill-down opens the strongest match on the block; later finding
   * updates (semantic pass landing) never steal an open detail pane. */
  const prevFilterRef = useRef<string | null>(null);
  useEffect(() => {
    if (blockFilterId === prevFilterRef.current) return;
    prevFilterRef.current = blockFilterId;
    if (!blockFilterId) return;
    setSelected(drillRows[0] ?? null);
    setMobileTab("detail");
  }, [blockFilterId, drillRows]);

  const visibleInspections = useMemo(() => {
    const base = blockMatchKeys ? drillRows : inspections;
    if (!searchNeedle) return base;
    return base.filter(
      (finding) =>
        finding.title.toLowerCase().includes(searchNeedle) ||
        instrumentLabel(finding.instrument).toLowerCase().includes(searchNeedle)
    );
  }, [inspections, drillRows, blockMatchKeys, searchNeedle, instrumentLabel]);

  /** Match-row count shown in the filter placeholder — the full current list
   * (drill-down scope when a highlight filter is active), not narrowed by the
   * typed search, so the number stays stable while typing. */
  const matchRowCount = blockMatchKeys ? drillRows.length : inspections.length;

  /** Book accordion: every rulebook in scope as a card, its full obligation
   * list, and the finding to open for each hit. The list is the STATIC
   * catalog only — counts must never move when packs load or scans run. */
  const books = useMemo(() => {
    /** Findings by accordion key. Semantic findings join directly on the
     * catalog obligation id; detector findings carry the pack's synthetic id
     * and are indexed under the catalog obligations they were compiled from
     * (source_obligation_ids), so their source rows still light up. */
    const detectorById = new Map(
      RELEASE_PACK.detectors.map((detector) => [detector.obligation_id, detector] as const)
    );
    const catalogIdsByInstrument = new Map<string, Set<string>>();
    for (const entry of GOALS_CATALOG.obligations) {
      let ids = catalogIdsByInstrument.get(entry.instrument);
      if (!ids) catalogIdsByInstrument.set(entry.instrument, (ids = new Set()));
      ids.add(entry.obligation_id);
    }
    const findingByKey = new Map<string, DdqFinding>();
    for (const finding of inspections) {
      const detector = detectorById.get(finding.obligation_id);
      if (detector) {
        const ids = catalogIdsByInstrument.get(finding.instrument);
        if (!ids) continue;
        for (const oid of detector.source_obligation_ids ?? []) {
          const key = `${finding.instrument}:${oid}`;
          if (ids.has(oid) && !findingByKey.has(key)) findingByKey.set(key, finding);
        }
      } else {
        findingByKey.set(`${finding.instrument}:${finding.obligation_id}`, finding);
      }
    }
    const scopeInstruments = (
      scope === "goals"
        ? GOALS_INSTRUMENTS
        : scope === "pitch-decks"
          ? PITCH_INSTRUMENTS
        : scope === "career-advice"
          ? CAREER_INSTRUMENTS
          : [...new Set(RELEASE_PACK.detectors.map((detector) => detector.instrument))]
    ).filter((instrument) => !storeElevators || storeElevators.includes(instrument));
    return scopeInstruments.map((instrument) => {
      const obligations =
        scope === "funds"
          ? RELEASE_PACK.detectors
              .filter((detector) => detector.instrument === instrument)
              .map((detector) => ({
                obligation_id: detector.obligation_id,
                title: detector.title,
                provision_id: detector.provision_id,
                description: detector.match_display || detector.title,
              }))
          : GOALS_CATALOG.obligations
              .filter((entry) => entry.instrument === instrument)
              .map((entry) => ({
                obligation_id: entry.obligation_id,
                title: entry.title,
                provision_id: entry.provision_id,
                description: entry.obligation_text || entry.description,
              }));
      return { instrument, label: instrumentLabel(instrument), obligations, findingByKey };
    });
  }, [scope, inspections, instrumentLabel, storeElevators]);

  /** Catalog extras (source passages, trigger level) by
   * instrument:obligation_id — quotes exist only for public-domain books
   * (importer policy); trigger levels ship for all rights. */
  const catalogMetaByKey = useMemo(() => {
    const map = new Map<string, { source_quote?: string; expanded_source_quote?: string; trigger_level?: string }>();
    for (const entry of GOALS_CATALOG.obligations) {
      if (entry.source_quote || entry.expanded_source_quote || entry.trigger_level) {
        map.set(`${entry.instrument}:${entry.obligation_id}`, entry);
      }
    }
    return map;
  }, []);

  /** Library dialog rows: the Hacker News public-domain census, filtered by
   * the dialog's search box over title, author, and topic tags. */
  const libraryResults = useMemo(() => {
    const q = librarySearch.trim().toLowerCase();
    if (!q) return HN_PD_CATALOG.books;
    return HN_PD_CATALOG.books.filter((book) =>
      `${book.title} ${book.author} ${book.topics.join(" ")}`.toLowerCase().includes(q)
    );
  }, [librarySearch]);

  /** Rulebook-entry view for obligations the scan did NOT match: every item in
   * the accordions opens the detail panel — matched items open their finding,
   * unmatched ones open this synthetic entry (shape mirrors the semantic
   * candidate findings, so the panel renders without special cases). */
  const catalogFinding = useCallback(
    (
      instrument: string,
      obligation: { obligation_id: string; title: string; provision_id: string; description?: string }
    ): DdqFinding => ({
      obligation_id: obligation.obligation_id,
      content_fingerprint: `ob:${instrument}:${obligation.obligation_id}`,
      instrument,
      provision_id: obligation.provision_id,
      title: obligation.title,
      match_strength: "loose",
      confidence: 0,
      matched_detectors: [],
      matched_count: 0,
      total_count: 0,
      section: "",
      page: 1,
      excerpt: "",
      matches: [],
      guidance: {
        match_display: obligation.title,
        gap_actions: [],
        self_check_questions: [],
      },
      severity: "low",
      category: "missing_disclosure",
      block_id: "",
      target_text: "",
      replacement_text: "",
    }),
    []
  );

  const closeDetail = useCallback(() => {
    setSelected(null);
    setDetailsOpen(false);
    setMobileTab("list");
  }, []);

  const profile = selected ? subjectProfile(selected.instrument) : undefined;

  const packAdvice = selected ? resolveAdvice(selected.corpus_fingerprint ?? selected.obligation_id, null) : null;
  const detailGapActions = [
    ...(packAdvice?.gap_actions ?? []),
    ...(selected?.guidance?.gap_actions ?? []),
  ];
  /** One-line summary of the rule itself — match_display, minus the
   * pipeline's "Carrier document evidences:" scaffolding prefix. No fallback:
   * items without one render the not-generated note so the template is
   * identical everywhere. */
  const detailRuleSummary = (selected?.guidance?.match_display || "").replace(
    /^Carrier document evidences:\s*/i,
    ""
  );

  /** The download stat shows the ONE file this device will actually fetch:
   * the device ladder picks fp16 (~67 MB) when WebGPU is present and q8
   * (~34 MB) on the WASM/CPU path. Until the probe reports, q8 is the
   * safe default (it is also the bottom ladder rung). */
  const downloadSizeStat =
    capability?.device === "webgpu" ? "67 MB fp16" : "34 MB q8";
  const STORE_MODEL_BY_SCOPE: Record<string, string> = {
    goals: "personal-goals",
    "pitch-decks": "pitch-decks",
    "career-advice": "career-advice",
  };

  useEffect(() => {
    let cancelled = false;
    fetch("/api/models")
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("no api"))))
      .then((doc: { models?: { model: string }[] }) => {
        if (!cancelled) setInstalledModels(doc.models?.map((m) => m.model) ?? []);
      })
      .catch(() => {
        /* no local backend: public-deploy behaviour, everything visible */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const activeStoreModel = STORE_MODEL_BY_SCOPE[scope];
  useEffect(() => {
    if (!activeStoreModel) {
      setStoreElevators(null);
      return;
    }
    let cancelled = false;
    setStoreElevators(null);
    fetch(`/api/models/${activeStoreModel}/elevators`)
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("no api"))))
      .then((doc: { elevators?: { id: string }[] }) => {
        if (!cancelled) setStoreElevators(doc.elevators?.map((e) => e.id) ?? []);
      })
      .catch(() => {
        /* model not installed or no backend: unfiltered */
      });
    return () => {
      cancelled = true;
    };
  }, [activeStoreModel]);

  const brandModels = useMemo(
    () => {
      const base = BRAND_MODELS.map((model) => ({
        ...model,
        stats: (model.stats ?? []).map((stat) =>
          stat.label === "download size" ? { ...stat, value: downloadSizeStat } : stat
        ),
      }));
      if (!installedModels) return base;
      const installed = base.filter((model) =>
        installedModels.includes(STORE_MODEL_BY_SCOPE[model.id] ?? model.id)
      );
      return installed.length ? installed : base;
    },
    [downloadSizeStat, installedModels]
  );

  const activeModel = brandModels.find((option) => option.id === scope) ?? brandModels[0];

  /** Regex-detector count for the fallback notice — the scan still runs
   * regex-only when the neural models cannot start (phones/tablets). */
  const scopePackStats =
    scope === "goals"
      ? goalsPackStats
      : scope === "pitch-decks"
        ? pitchPackStats
        : scope === "career-advice"
          ? careerPackStats
          : null;
  const regexFallbackCount = scopePackStats
    ? scopePackStats.patterns
    : RELEASE_PACK.detectors.reduce((total, detector) => total + detector.patterns.length, 0);

  /** Live status text beside the capability icons: plain words, no bar.
   * resultsPending gates the whole note: it spans the pipeline start to its
   * single publication, so the text CANNOT vanish mid-processing — every
   * intermediate flag race falls through to "Scanning…". */
  const weightsSizeMb = capability?.device === "webgpu" ? 67 : 34;
  const capNote = !resultsPending
    ? ""
    : modelStageView || modelPending
      ? modelStageView
        ? t(MODEL_PHASE_KEY[modelStageView.phase]) +
          (modelStageView.pct > 0 && modelStageView.pct < 100 ? ` · ${modelStageView.pct}%` : "")
        : t("modelPhaseMatch")
      : weightsPct != null
        ? t("capStatusDownloading", { pct: weightsPct, size: `${weightsSizeMb} MB` })
        : t("scanning");

  /** Shared by the Help menu and the mobile offcanvas: wipe caches and
   * storage, then reload. */
  const resetEverything = useCallback(() => {
    void (async () => {
      await resetModelCaches();
      try {
        localStorage.clear();
      } catch {
        // storage unavailable (private mode) - nothing to clear
      }
      window.location.reload();
    })();
  }, []);

  /** Contents dialog for the selected model's download bundle. */
  const activePackage = activeModel.packageUrl ? MODEL_PACKAGES[activeModel.id] : undefined;
  const packageMb = activePackage
    ? Math.max(1, Math.round(((modelZipSizes as Record<string, number>)[activePackage.zip] ?? 0) / 1e6))
    : 0;


  const rightsStatus = selected
    ? GOALS_CATALOG.sources?.[selected.instrument]?.rights_status
    : undefined;

  /** Source passage and trigger level for the open item. Direct catalog hits
   * (semantic findings and rulebook entries) join on
   * instrument:obligation_id; detector findings carry the pack's synthetic
   * id, so they resolve through the matched detector's pipeline obligation
   * ids instead. */
  const detailSource = useMemo(() => {
    if (!selected) return undefined;
    const direct = catalogMetaByKey.get(`${selected.instrument}:${selected.obligation_id}`);
    if (direct) return direct;
    const detectorId = selected.matched_detectors?.[0];
    if (!detectorId) return undefined;
    const detector = RELEASE_PACK.detectors.find((d) => d.obligation_id === detectorId);
    for (const oid of detector?.source_obligation_ids ?? []) {
      const hit = catalogMetaByKey.get(`${selected.instrument}:${oid}`);
      if (hit) return hit;
    }
    return undefined;
  }, [selected, catalogMetaByKey]);

  const authorDomain = selected
    ? GOALS_CATALOG.sources?.[selected.instrument]?.author_domain
    : undefined;
  /** Bare-hostname guard — the pipeline manifest validates this, the render
   * gate just keeps a malformed value out of the href. */
  const authorDomainHref =
    authorDomain && /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(authorDomain)
      ? `https://${authorDomain}/`
      : null;
  /** Where the source book itself lives (Gutenberg page, archive.org, or the
   * publisher for in-copyright works) — same render gate as the domain. */
  const sourceBookUrl = selected ? GOALS_CATALOG.sources?.[selected.instrument]?.source_url : undefined;
  const sourceBookHref = sourceBookUrl && /^https?:\/\//i.test(sourceBookUrl) ? sourceBookUrl : null;
  let sourceBookDomain: string | null = null;
  if (sourceBookHref) {
    try {
      sourceBookDomain = new URL(sourceBookHref).hostname.replace(/^www\./, "");
    } catch {
      sourceBookDomain = null;
    }
  }
  /** Byline link — one or the other, never both: the author's own domain
   * when the manifest has one, else the source book page. Always labeled
   * with the bare domain of wherever it points. */
  const bylineHref = authorDomainHref ?? sourceBookHref;
  const bylineLabel = authorDomainHref ? authorDomain : sourceBookDomain;
  /** Copyrighted sources: no verbatim passages exist in the catalog, so the
   * Source passage section falls back to the unavailability note. */
  const adviceRestricted = rightsStatus === "copyrighted";

  const loadDemoSample = useCallback(() => {
    setText(demoSampleForScope(scope));
    setSelected(null);
  }, [scope]);

  /** Drag-and-drop: a dropped text file (.md/.txt, sane size) replaces the
   * editor contents. Paste and typing work through CodeMirror natively. */
  const [dropping, setDropping] = useState(false);
  const handleDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDropping(false);
    const file = event.dataTransfer.files?.[0];
    if (!file) return;
    const textLike =
      file.type.startsWith("text/") || /\.(md|txt|markdown)$/i.test(file.name);
    if (!textLike || file.size > 2_000_000) return;
    void file.text().then((content) => {
      setText(content);
      setSelected(null);
      editorViewRef.current?.focus();
    });
  }, []);

  const resetFilters = useCallback(() => {
    setBlockFilterId(null);
    setSearch("");
  }, []);

  /** Prev/next pager flanking the profile image: steps the visible match rows
   * (drill-down rows during a highlight filter, all rows otherwise, both
   * narrowed by an active search). An open item the filters hide steps back
   * into the list from its ends. */
  const detailNav = useMemo(() => {
    if (!selected || visibleInspections.length === 0) return null;
    const index = visibleInspections.findIndex(
      (finding) =>
        finding.instrument === selected.instrument && finding.obligation_id === selected.obligation_id
    );
    if (index < 0) {
      return {
        prev: visibleInspections[0] ?? null,
        next: visibleInspections[visibleInspections.length - 1] ?? null,
      };
    }
    return {
      prev: visibleInspections[index - 1] ?? null,
      next: visibleInspections[index + 1] ?? null,
    };
  }, [visibleInspections, selected]);

  /** Switching vertical swaps the demo document in, but only while the editor
   * still holds a stock sample: user-written text is never replaced. */
  const selectModel = useCallback(
    (id: string) => {
      if (id !== "goals" && id !== "pitch-decks" && id !== "career-advice") return;
      if (id === scope) return;
      setScope(id);
      if (SAMPLE_TEXTS.includes(text)) {
        setText(demoSampleForScope(id));
      }
    },
    [scope, text]
  );

  /** A new document opens as a full blank page: 100 empty lines, gutter 1-100. */
  const newDocument = useCallback(() => {
    setText("\n".repeat(99));
    setSelected(null);
  }, []);

  const runEditorCommand = useCallback((command: "undo" | "redo") => {
    const view = editorViewRef.current;
    if (!view) return;
    view.focus();
    if (command === "undo") undo(view);
    else redo(view);
  }, []);

  const selectAllEditor = useCallback(() => {
    const view = editorViewRef.current;
    if (!view) return;
    view.focus();
    selectAll(view);
  }, []);

  const row = (finding: DdqFinding, isMatched: boolean) => {
    const active = selected?.content_fingerprint === finding.content_fingerprint;
    const rowProfile = subjectProfile(finding.instrument);
    return (
      <button
        key={finding.content_fingerprint}
        type="button"
        className={[
          "pg-row",
          isMatched ? "pg-row-matched" : "",
          active ? "pg-row-selected" : "",
          isCopyrighted(finding.instrument) ? "pg-row-rights" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        onClick={() => {
          setSelected(finding);
          revealPanels(panelsAfterElevationSelect({ list: listOpen, details: detailsOpen }));
          setMobileTab("detail");
        }}
      >
        <span className="pg-row-avatar">
          <img
            className="pg-row-avatar-img"
            src={rowProfile.src}
            alt=""
            aria-hidden="true"
            title={rowProfile.name}
            loading="lazy"
          />
        </span>
        <span className="pg-row-text">
          <span className="pg-row-title" title={finding.title}>
            {finding.title}
          </span>
          <span className="pg-row-sub">
            {instrumentLabel(finding.instrument)}
            {finding.section ? (
              <>
                {" · "}
                <em>&ldquo;{finding.section}&rdquo;</em>
              </>
            ) : null}
          </span>
        </span>
      </button>
    );
  };

  return (
    <div className={`pg-root${resizing ? " pg-dragging" : ""}${splitDragging ? " pg-vdragging" : ""}`} data-tab={mobileTab}>
      {/* ---------- left pane: markdown editor ---------- */}
      <section className="pg-editor-pane" aria-label={t("documentPane")}>
        <div className="pg-toolbar">
          <button
            type="button"
            className="pg-burger"
            onClick={() => setMobileMenuOpen(true)}
            aria-label={t("openMenuLabel")}
            aria-expanded={mobileMenuOpen}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <path d="M3 6h18M3 12h18M3 18h18" />
            </svg>
          </button>
          <span className="pg-brand">{t("brandTitle")} <span className="pg-brand-version">{__APP_VERSION__}</span></span>
          <div className="pg-menubar" role="menubar">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className="pg-menu-btn">{t("menuFile")}</button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="pg-menu-content">
                <DropdownMenuItem onSelect={newDocument}>{t("menuNew")}</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={loadDemoSample}>{t("menuLoadSample")}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className="pg-menu-btn">{t("menuEdit")}</button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="pg-menu-content">
                <DropdownMenuItem onSelect={() => runEditorCommand("undo")}>{t("menuUndo")}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => runEditorCommand("redo")}>{t("menuRedo")}</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={selectAllEditor}>{t("menuSelectAll")}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className="pg-menu-btn">{t("menuView")}</button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="pg-menu-content">
                <DropdownMenuCheckboxItem
                  checked={showLineNumbers}
                  onCheckedChange={() => setShowLineNumbers((v) => !v)}
                  onSelect={(event) => event.preventDefault()}
                >
                  {t("menuLineNumbers")}
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  checked={softWrap}
                  onCheckedChange={() => setSoftWrap((v) => !v)}
                  onSelect={(event) => event.preventDefault()}
                >
                  {t("menuSoftWrap")}
                </DropdownMenuCheckboxItem>
                <DropdownMenuSeparator />
                <DropdownMenuCheckboxItem
                  checked={listOpen}
                  onCheckedChange={() => setListOpen((v) => !v)}
                  onSelect={(event) => event.preventDefault()}
                >
                  {t("menuElevations")}
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  checked={detailsOpen}
                  onCheckedChange={() => setDetailsOpen((v) => !v)}
                  onSelect={(event) => event.preventDefault()}
                >
                  {t("menuDetails")}
                </DropdownMenuCheckboxItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className="pg-menu-btn">{t("menuHelp")}</button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="pg-menu-content">
                <DropdownMenuItem onSelect={() => setAboutOpen(true)}>{t("menuAbout")}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setLibraryOpen(true)}>{t("menuLibrary")}</DropdownMenuItem>
                <DropdownMenuItem onSelect={resetEverything}>{t("menuReset")}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <span className="pg-caps" aria-label={t("capsLabel")}>
            {capNote && (
              <span className="pg-cap-note" role="status" aria-live="polite">
                {capNote}
              </span>
            )}
            {(["webgpu", "wasm", "models"] as const).map((gate) => {
              const downloading = gate === "models" && weightsPct != null;
              const status: CapIconStatus = downloading ? "downloading" : (capability?.[gate] ?? "pending");
              const statusText = downloading
                ? t("capStatusDownloading", { pct: weightsPct ?? 0, size: `${weightsSizeMb} MB` })
                : t(CAP_STATUS_KEY[status as CapabilityStatus]);
              return (
                <CapabilityIcon
                  key={gate}
                  gate={gate}
                  status={status}
                  label={t(`cap${gate.charAt(0).toUpperCase()}${gate.slice(1)}`)}
                  statusText={statusText}
                />
              );
            })}
          </span>
          <button
            type="button"
            className={listOpen ? "pg-col-toggle pg-col-on" : "pg-col-toggle"}
            onClick={() => setListOpen((v) => !v)}
            aria-pressed={listOpen}
            data-tooltip={t("menuElevations")}
            aria-label={t("menuElevations")}
          >
            <ListChecks size={15} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={detailsOpen ? "pg-col-toggle pg-col-on" : "pg-col-toggle"}
            onClick={() => setDetailsOpen((v) => !v)}
            aria-pressed={detailsOpen}
            data-tooltip={t("menuDetails")}
            aria-label={t("menuDetails")}
          >
            <Info size={15} aria-hidden="true" />
          </button>
        </div>
        <div className="pg-subbar">
          <span className="pg-model-label">{t("modelSelectLabel")}</span>
          <ModelSelect
            options={brandModels}
            value={scope}
            onChange={selectModel}
            label={t("modelSelectLabel")}
          />
          {(modelStageView || resultsPending) && (
            <div className="pg-model-note pg-model-note-sub" aria-live="polite">
              {CAP_SPINNER}
              <span className="pg-model-note-text">
                <span className="pg-model-note-phase">
                  {modelStageView
                    ? t(MODEL_PHASE_KEY[modelStageView.phase]) +
                      (modelStageView.pct > 0 && modelStageView.pct < 100
                        ? ` · ${modelStageView.pct}%`
                        : "")
                    : t(modelPending ? "modelPhaseMatch" : "scanning")}
                </span>
                {modelStageView && (
                  <span className="pg-model-bar" aria-hidden="true">
                    <span
                      className="pg-model-bar-fill"
                      style={{ width: `${Math.min(100, Math.max(3, modelStageView.pct))}%` }}
                    />
                  </span>
                )}
              </span>
            </div>
          )}
          <span className="pg-filters" role="group" aria-label={t("filtersLabel")}>
            <span className="pg-model-label">{t("realtimeChecksLabel")}</span>
            <button
              type="button"
              className="pg-filter-switch"
              role="switch"
              aria-checked={filtersOn}
              aria-label={t("filtersToggleAll")}
              onClick={toggleAllFilters}
            />
            <span className="pg-model-label">{t("highlightsLabel")}</span>
            {[...SCORE_TIERS].reverse().map((tier) => {
              const on = !hiddenTiers.has(tier.id);
              return (
                <button
                  key={tier.id}
                  type="button"
                  className={on ? "pg-filter" : "pg-filter pg-filter-off"}
                  onClick={() =>
                    setHiddenTiers((prev) => {
                      const next = new Set(prev);
                      if (next.has(tier.id)) next.delete(tier.id);
                      else next.add(tier.id);
                      return next;
                    })
                  }
                  aria-pressed={on}
                  data-tooltip={t(tier.labelKey)}
                  aria-label={t(tier.labelKey)}
                >
                  <span className={`pg-filter-dot pg-dot-${tier.id}`}>
                    {resultsPending ? "\u2013" : Math.min(classCounts[tier.id], 999)}
                  </span>
                </button>
              );
            })}
          </span>
        </div>
        <div
          className={
            (softWrap ? "pg-editor-wrap pg-cm-wrap" : "pg-editor-wrap pg-cm-wrap pg-nowrap-cm") +
            (dropping ? " pg-dropping" : "")
          }
          onDragOver={(event) => {
            event.preventDefault();
            setDropping(true);
          }}
          onDragLeave={() => setDropping(false)}
          onDrop={handleDrop}
        >
          <CodeMirror
            className="pg-cm"
            value={text}
            onChange={setText}
            onCreateEditor={(view) => {
              editorViewRef.current = view;
              // Apply the current View-menu settings immediately: the mount
              // effects dispatch too, but this guarantees the very first
              // paint has the right gutter + wrap configuration.
              view.dispatch({
                effects: [
                  wrapCompartment.reconfigure(softWrap ? EditorView.lineWrapping : []),
                  gutterCompartment.reconfigure(showLineNumbers ? lineNumbers() : []),
                ],
              });
            }}
            extensions={editorExtensions}
            placeholder={t("editorPlaceholder")}
            basicSetup={{
              lineNumbers: false,
              foldGutter: false,
              highlightActiveLine: false,
              highlightActiveLineGutter: false,
              bracketMatching: false,
              closeBrackets: false,
              autocompletion: false,
              highlightSelectionMatches: false,
              searchKeymap: false,
            }}
            aria-label={t("documentPane")}
          />
        </div>
      </section>

      {/* ---------- middle pane: obligation matches ---------- */}
      <section
        ref={listPaneRef}
        className={`pg-list-pane${listOpen ? " pg-open" : " pg-closed"}`}
        style={{ width: listOpen ? listWidth : 0, flex: "0 0 auto" }}
        aria-hidden={!listOpen}
        aria-label={t("listPane")}
      >
        {listOpen && (
          <ResizeHandle
            label={t("resizeList")}
            value={listWidth}
            min={LIST_MIN}
            max={listMax}
            reverse
            onChange={setListWidth}
            onActiveChange={setResizing}
          />
        )}
        <div className="pg-list-head">
          <h1 className="pg-list-title">{t("listTitle")}</h1>
          <button
            type="button"
            className="pg-list-close"
            onClick={() => setListOpen(false)}
            aria-label={t("closeList")}
            title={t("closeList")}
          >
            ×
          </button>
        </div>
        <div className="pg-list-half" style={{ flex: `0 0 ${matchesPct}%` }}>
          <div className="pg-list-scroll">
          <div className="pg-search-row">
            <input
              className="pg-search"
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("searchObligations", { count: matchRowCount })}
              aria-label={t("searchObligations", { count: matchRowCount })}
            />
            <button
              type="button"
              className="pg-search-reset"
              onClick={resetFilters}
              disabled={!blockFilterId && !search}
              aria-label={t("filterReset")}
              data-tooltip={t("filterReset")}
            >
              {t("filterResetShort")}
            </button>
          </div>
          {blockFilterId && (
            <p className="pg-filter-note" aria-live="polite">
              {t("filterActiveLine", { count: drillRows.length })}
            </p>
          )}
          {error ? (
            <div className="pg-state" role="alert">
              <h2 className="pg-state-title">{t("errorTitle")}</h2>
              <p className="pg-state-body">{error}</p>
            </div>
          ) : scanning ? (
            <div className="pg-state" aria-live="polite">
              <p className="pg-state-body">
                <span className="pg-blink" aria-hidden="true" />{" "}
                {capNote || t("scanning")}
              </p>
            </div>
          ) : !result ? (
            <div className="pg-state">
              <h2 className="pg-state-title">{t("emptyTitle")}</h2>
              <p className="pg-state-body">{t("emptyBody")}</p>
            </div>
          ) : (
            <>
              {visibleInspections.map((finding) => row(finding, finding.category === "evidenced"))}
              {visibleInspections.length === 0 && (
                <div className="pg-state">
                  <h2 className="pg-state-title">{t("noFindingsTitle")}</h2>
                  <p className="pg-state-body">
                    {blockFilterId
                      ? t("noBlockMatchesBody")
                      : searchNeedle
                        ? t("noSearchResults")
                        : t("noFindingsBody")}
                  </p>
                </div>
              )}
            </>
          )}
        </div>
        </div>
        <SplitHandle
          label={t("resizeSplit")}
          value={matchesPct}
          min={20}
          max={80}
          containerRef={listPaneRef}
          onChange={setMatchesPct}
          onActiveChange={setSplitDragging}
        />
        <div className="pg-list-half" style={{ flex: "1 1 auto" }}>
          <div className="pg-list-scroll">
              {books.map((book) => {
                const open = expandedBooks.has(book.instrument);
                return (
                  <div key={book.instrument} className={open ? "pg-acc pg-acc-open" : "pg-acc"}>
                    <button
                      type="button"
                      className={
                        isCopyrighted(book.instrument)
                          ? "pg-acc-head pg-acc-head-rights"
                          : "pg-acc-head"
                      }
                      aria-expanded={open}
                      onClick={() =>
                        setExpandedBooks((prev) => {
                          const next = new Set(prev);
                          if (next.has(book.instrument)) next.delete(book.instrument);
                          else next.add(book.instrument);
                          return next;
                        })
                      }
                    >
                      <span
                        className={open ? "pg-acc-caret pg-acc-caret-open" : "pg-acc-caret"}
                        aria-hidden="true"
                      >
                        ▸
                      </span>
                      <span className="pg-acc-label">
                        {book.label}
                        {isCopyrighted(book.instrument) && (
                          <span className="pg-acc-rights" title={t("rightsFlagTitle")}>
                            ©
                          </span>
                        )}
                      </span>
                      {book.obligations.length > 0 && (
                        <span className="pg-acc-count">
                          {t("bookMatches", { total: book.obligations.length })}
                        </span>
                      )}
                    </button>
                    {open && (
                      <div className="pg-acc-body">
                        {book.obligations.length > 0 ? (
                          book.obligations.map((obligation) => {
                          const finding = book.findingByKey.get(
                            `${book.instrument}:${obligation.obligation_id}`
                          );
                          return (
                            <button
                              key={obligation.obligation_id}
                              type="button"
                              className={[
                                "pg-acc-item",
                                finding ? "pg-acc-item-hit" : "",
                                isCopyrighted(book.instrument) ? "pg-acc-item-rights" : "",
                              ]
                                .filter(Boolean)
                                .join(" ")}
                              onClick={() => {
                                setSelected(finding ?? catalogFinding(book.instrument, obligation));
                                revealPanels(panelsAfterElevationSelect({ list: listOpen, details: detailsOpen }));
                                setMobileTab("detail");
                              }}
                            >
                              <span className={finding ? "pg-acc-dot pg-acc-dot-hit" : "pg-acc-dot"} aria-hidden="true" />
                              <span className="pg-acc-item-title">{obligation.title}</span>
                              <span className="pg-acc-item-prov">{obligation.provision_id}</span>
                            </button>
                          );
                          })
                        ) : (
                          <p className="pg-acc-unavailable">{t("obligationsUnavailableNote")}</p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        </div>
      </section>

      {/* ---------- right pane: detail, slides in like files.md's split editor ---------- */}
      <div
        className={`pg-detail-pane${detailsOpen ? " pg-open" : ""}`}
        style={{ width: detailsOpen ? detailWidth : 0 }}
        aria-hidden={!detailsOpen}
      >
        <div
          className={`pg-detail-inner${adviceRestricted ? " pg-detail-rights" : ""}`}
          style={{ width: detailWidth }}
        >
        <ResizeHandle
          label={t("resizeDetail")}
          value={detailWidth}
          min={DETAIL_MIN}
          max={DETAIL_MAX}
          reverse
          onChange={setDetailWidth}
          onActiveChange={setResizing}
        />
        <div className="pg-detail-head">
          <span className="pg-detail-instrument">
            {selected ? instrumentLabel(selected.instrument) : t("menuDetails")}
          </span>
          <button
            type="button"
            className="pg-detail-close"
            onClick={closeDetail}
            aria-label={t("closeDetail")}
            title={t("closeDetail")}
          >
            ×
          </button>
        </div>
        <div className="pg-detail-scroll">
          {!selected ? (
            <div className="pg-state">
              <h2 className="pg-state-title">{t("detailsEmptyTitle")}</h2>
              <p className="pg-state-body">{t("detailsEmptyBody")}</p>
            </div>
          ) : (
          <>
              <div className="pg-detail-profile">
                <button
                  type="button"
                  className="pg-detail-nav"
                  onClick={() => detailNav?.prev && setSelected(detailNav.prev)}
                  disabled={!detailNav?.prev}
                  aria-label={t("detailPrev")}
                  data-tooltip={t("detailPrev")}
                >
                  <span className="pg-detail-nav-circle" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14 6l-6 6 6 6" />
                    </svg>
                  </span>
                  <span className="pg-detail-nav-label">{t("detailPrevLabel")}</span>
                </button>
                {profile && (
                  <img
                    src={profile.src}
                    alt={profile.name}
                    title={t("disclaimerIllustration")}
                    width={115}
                    height={115}
                  />
                )}
                <button
                  type="button"
                  className="pg-detail-nav"
                  onClick={() => detailNav?.next && setSelected(detailNav.next)}
                  disabled={!detailNav?.next}
                  aria-label={t("detailNext")}
                  data-tooltip={t("detailNext")}
                >
                  <span className="pg-detail-nav-label">{t("detailNextLabel")}</span>
                  <span className="pg-detail-nav-circle" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M10 6l6 6-6 6" />
                    </svg>
                  </span>
                </button>
              </div>
              <h2 className="pg-detail-title">{packAdvice?.duty_label || selected.title}</h2>
            {selected.provision_id && (
              <p className="pg-detail-provision">{selected.provision_id}</p>
            )}
            {(INSTRUMENT_AUTHORS[selected.instrument] || bylineHref) && (
              <div className="pg-detail-byline">
                {INSTRUMENT_AUTHORS[selected.instrument] && (
                  <p className="pg-detail-author">
                    {t("bookBy", { author: INSTRUMENT_AUTHORS[selected.instrument] })}
                  </p>
                )}
                {bylineHref && bylineLabel && (
                  <a
                    className="pg-detail-domain"
                    href={bylineHref}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <ExternalLink size={11} aria-hidden="true" />
                    {bylineLabel}
                  </a>
                )}
              </div>
            )}

            <section className="pg-detail-guidance">
              <div
                className={
                  adviceRestricted
                    ? "pg-detail-disclaimer pg-detail-disclaimer-rights"
                    : "pg-detail-disclaimer"
                }
              >
                {rightsStatus === "public_domain" ? (
                  <p>
                    {t("disclaimerPublicDomain", {
                      source: instrumentLabel(selected.instrument),
                    })}
                  </p>
                ) : (
                  <p>
                    {profile
                      ? t("disclaimerAiSource", { source: instrumentLabel(selected.instrument) })
                      : t("disclaimerGeneric")}
                    {profile && ` ${t("disclaimerNotAffiliated", { name: profile.name })}`}
                    {authorDomainHref && (
                      <>
                        {` ${t("disclaimerBuyBook")} `}
                        <a href={authorDomainHref} target="_blank" rel="noopener noreferrer">
                          {authorDomain}
                        </a>
                      </>
                    )}
                  </p>
                )}
              </div>

              <p className="pg-body pg-tldr">
                <strong className="pg-h2-inline">{t("sectionMatchDisplay")}:</strong>{" "}
                {detailRuleSummary ? (
                  detailRuleSummary
                ) : (
                  <span className="pg-muted">{t("summaryEmptyNote")}</span>
                )}
              </p>

              <h3 className="pg-h2">{t("sectionGapActions")}</h3>
              {detailGapActions.length > 0 ? (
                <ul className="pg-list">
                  {detailGapActions.map((action, index) => (
                    <li key={index}>{action.text}</li>
                  ))}
                </ul>
              ) : (
                <p className="pg-body pg-muted">{t("actionsEmptyNote")}</p>
              )}
            </section>

            {selected.matches.length > 0 && (
              <>
                <h3 className="pg-h2">{t("sectionEvidence")}</h3>
                {selected.matches.map((match, index) => (
                  <blockquote key={`${match.detector_id}-${index}`} className="pg-evidence">
                    <Highlighted text={match.excerpt ?? ""} needle={match.matched_text} />
                  </blockquote>
                ))}
              </>
            )}

            {detailSource?.source_quote ? (
              <>
                <h3 className="pg-h2">{t("sectionSource")}</h3>
                <blockquote className="pg-source">&ldquo;&hellip;{detailSource.source_quote}&hellip;&rdquo;</blockquote>
              </>
            ) : adviceRestricted ? (
              <>
                <h3 className="pg-h2">{t("sectionSource")}</h3>
                <p className="pg-body pg-muted">{t("sourceUnavailableNote")}</p>
              </>
            ) : null}

            {detailSource?.expanded_source_quote &&
            detailSource.expanded_source_quote !== detailSource.source_quote ? (
              <>
                <h3 className="pg-h2">{t("sectionSourceExpanded")}</h3>
                <blockquote className="pg-source">&ldquo;&hellip;{detailSource.expanded_source_quote}&hellip;&rdquo;</blockquote>
              </>
            ) : adviceRestricted ? (
              <>
                <h3 className="pg-h2">{t("sectionSourceExpanded")}</h3>
                <p className="pg-body pg-muted">{t("sourceUnavailableNote")}</p>
              </>
            ) : null}

            <div className="pg-detail-meta">
              {selected.category === "evidenced" ? (
                <span className="pg-chip pg-chip-ok">{t(CATEGORY_KEY[selected.category])}</span>
              ) : (
                <>
                  <span className={`pg-chip${selected.severity === "high" ? " pg-chip-high" : ""}`}>
                    {t(SEVERITY_KEY[selected.severity])}
                  </span>
                  <span className="pg-chip">{t(CATEGORY_KEY[selected.category])}</span>
                </>
              )}
              {selected.match_tier && (
                <span className="pg-chip">{t(`matchTier${selected.match_tier === "direct" ? "Direct" : selected.match_tier === "related" ? "Related" : "Possible"}`)}</span>
              )}
              {selected.weak_signal === "topic_only" && <span className="pg-chip">{t("matchDiscussed")}</span>}
              {selected.weak_signal === "partial" && <span className="pg-chip">{t("matchPartial")}</span>}
              {detailSource?.trigger_level && TRIGGER_KEY[detailSource.trigger_level] && (
                <span className="pg-chip">{t(TRIGGER_KEY[detailSource.trigger_level])}</span>
              )}
              <span className="pg-chip">
                {t("confidence", { value: Math.round(selected.confidence * 100) })}
              </span>
              <span className="pg-chip">
                {t("detectorsFired", { matched: selected.matched_count, total: selected.total_count })}
              </span>
            </div>
          </>
          )}
        </div>
        </div>
      </div>

      <Dialog open={aboutOpen} onOpenChange={setAboutOpen}>
        <DialogContent className="max-w-sm pg-dialog">
          <DialogHeader>
            <DialogTitle>{t("aboutTitle")}</DialogTitle>
          </DialogHeader>
          <p className="pg-body">{t("aboutBody")}</p>
        </DialogContent>
      </Dialog>
      <Dialog open={libraryOpen} onOpenChange={setLibraryOpen}>
        <DialogContent className="max-w-lg pg-dialog pg-library-sheet">
          <DialogHeader>
            <DialogTitle>{t("libraryTitle")}</DialogTitle>
            <DialogDescription>{t("libraryDescription")}</DialogDescription>
          </DialogHeader>
          <div className="pg-library-controls">
            <input
              type="search"
              className="pg-library-search"
              value={librarySearch}
              onChange={(event) => setLibrarySearch(event.target.value)}
              placeholder={t("librarySearchPlaceholder")}
              aria-label={t("librarySearchPlaceholder")}
            />
            <span className="pg-library-count">{t("libraryCount", { count: libraryResults.length })}</span>
          </div>
          <ul className="pg-library-list">
            {libraryResults.map((book) => (
              <li key={book.hn_rank} className="pg-library-row">
                <span className="pg-library-rank" title={t("libraryRankBadge", { rank: book.hn_rank })}>
                  #{book.hn_rank}
                </span>
                <span className="pg-library-main">
                  <a className="pg-library-title" href={book.url} target="_blank" rel="noopener noreferrer">
                    {book.title}
                  </a>
                  <span className="pg-library-author">
                    {book.author} · {book.year}
                    {book.topics.length > 0 && ` · ${book.topics.join(", ")}`}
                  </span>
                </span>
                <span className="pg-library-mentions" aria-hidden="true">
                  {book.hn_mentions}
                </span>
              </li>
            ))}
            {libraryResults.length === 0 && (
              <li className="pg-library-empty">{t("libraryNoResults")}</li>
            )}
          </ul>
        </DialogContent>
      </Dialog>
      <Dialog open={fallbackNoticeOpen} onOpenChange={setFallbackNoticeOpen}>
        <DialogContent className="max-w-sm pg-dialog">
          <DialogHeader>
            <DialogTitle>{t("fallbackTitle")}</DialogTitle>
            <DialogDescription>
              {t("fallbackBody", { count: regexFallbackCount.toLocaleString() })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <button
                type="button"
                className="inline-flex h-10 items-center justify-center whitespace-nowrap rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
              >
                {t("fallbackAction")}
              </button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {mobileMenuOpen && (
        <>
          <div className="pg-offcanvas-backdrop" onClick={() => setMobileMenuOpen(false)} />
          <aside className="pg-offcanvas" aria-label={t("menuLabel")}>
            <div className="pg-offcanvas-head">
              <span className="pg-brand">{t("brandTitle")} <span className="pg-brand-version">{__APP_VERSION__}</span></span>
              <button
                type="button"
                className="pg-offcanvas-close"
                onClick={() => setMobileMenuOpen(false)}
                aria-label={t("closeDetail")}
              >
                ×
              </button>
            </div>
            <nav>
              {(["editor", "list", "detail"] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  className="pg-offcanvas-item"
                  onClick={() => {
                    setMobileTab(tab);
                    setMobileMenuOpen(false);
                  }}
                >
                  {t(tab === "editor" ? "tabEditor" : tab === "list" ? "tabMatches" : "tabDetail")}
                </button>
              ))}
              <div className="pg-offcanvas-sep" />
              <button type="button" className="pg-offcanvas-item" onClick={() => { newDocument(); setMobileMenuOpen(false); }}>
                {t("menuNew")}
              </button>
              <button type="button" className="pg-offcanvas-item" onClick={() => { loadDemoSample(); setMobileMenuOpen(false); }}>
                {t("menuLoadSample")}
              </button>
              <button type="button" className="pg-offcanvas-item" onClick={() => { setAboutOpen(true); setMobileMenuOpen(false); }}>
                {t("menuAbout")}
              </button>
              <button type="button" className="pg-offcanvas-item" onClick={resetEverything}>
                {t("menuReset")}
              </button>
            </nav>
          </aside>
        </>
      )}
      <nav className="pg-tabbar" aria-label={t("tabsLabel")}>
        <button
          type="button"
          className={mobileTab === "editor" ? "pg-tab pg-tab-on" : "pg-tab"}
          onClick={() => setMobileTab("editor")}
          aria-current={mobileTab === "editor"}
        >
          <FileText size={19} aria-hidden="true" />
          {t("tabEditor")}
        </button>
        <button
          type="button"
          className={mobileTab === "list" ? "pg-tab pg-tab-on" : "pg-tab"}
          onClick={() => setMobileTab("list")}
          aria-current={mobileTab === "list"}
        >
          <ListChecks size={19} aria-hidden="true" />
          {t("tabMatches")}
        </button>
        <button
          type="button"
          className={mobileTab === "detail" ? "pg-tab pg-tab-on" : "pg-tab"}
          onClick={() => setMobileTab("detail")}
          aria-current={mobileTab === "detail"}
          disabled={!selected}
        >
          <Info size={19} aria-hidden="true" />
          {t("tabDetail")}
        </button>
      </nav>
    </div>
  );
}
