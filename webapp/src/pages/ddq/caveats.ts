/**
 * Caveat lookup for the DDQ review.
 *
 * The s40 document-pipeline enrichment (scope limits, exemptions, supersessions,
 * interpretation clauses governing how the rest of a source instrument applies)
 * compiled to a per-obligation lookup by scripts/import_fund_docs_caveats.py.
 * The pack joins through the pipeline obligation ids stamped on each detector
 * as `source_obligation_ids` (import_fund_docs_packs.py).
 *
 * Caveats are SECONDARY signal by design: they never flip an obligation's
 * evidence verdict, they qualify it — an evidenced obligation may still be
 * narrowed or excluded by a governing clause in the source instrument. The UI
 * therefore surfaces them as a one-line amber hint on cards and the full
 * "Conditions & limitations" block in the detail dialogs, never as findings.
 *
 * The caveats JSON (~40 KB) stays bundled. The join to detectors is rebuilt
 * after `registerReleasePack` — detectors themselves are API-loaded.
 */
import caveatsFile from "./packs/fund-docs-caveats.json";
import { RELEASE_PACK } from "./pack-v2";

/** Trimmed caveat entry (short keys keep the bundled lookup small). */
export interface FundDocsCaveat {
  /** caveat_type — applicability_scope_limit, exemption_or_derogation, … */
  t: string;
  /** title */
  tt: string;
  /** effect from the link — narrows_applicability, excludes_obligation, … */
  e: string;
  /** summary (description/condition prose) */
  s: string;
  /** source_quote — the verbatim governing clause */
  q: string;
  /** confidence_score from the link, 0–1 (may be null) */
  c: number | null;
}

export interface FundDocsCaveatsFile {
  schema: string;
  id: string;
  version: string;
  generated_at: string;
  source: string;
  sidecars: { doc: string; caveats: number; links: number }[];
  pack_obligations_with_caveats: number;
  caveat_items: number;
  by_obligation: Record<string, FundDocsCaveat[]>;
}

export const CAVEATS_PACK = caveatsFile as unknown as FundDocsCaveatsFile;
export const CAVEATS_PACK_VERSION = CAVEATS_PACK.version;

/** Effects that narrow/exclude/supersede an obligation — the "dangerous
 * direction", as opposed to a plain contextual note. Mirrors the marine
 * REDUCING_CAVEAT_EFFECTS set in src/lib/marine-data.ts. */
export const REDUCING_CAVEAT_EFFECTS = new Set([
  "excludes_obligation",
  "narrows_applicability",
  "supersedes_obligation",
  "modifies_requirement",
]);

/** Caveats that reduce the obligation get the amber treatment; contextual
 * notes render muted so the eye is drawn only when it matters. */
export function isReducingCaveat(caveat: FundDocsCaveat): boolean {
  return REDUCING_CAVEAT_EFFECTS.has(caveat.e);
}

/** detector obligation_id (synthetic pack id, e.g. "sysc:18-1:0") -> caveats */
const detectorCaveats = new Map<string, FundDocsCaveat[]>();
const caveatCountByDetector = new Map<string, number>();
let detectorsWithCaveats = 0;

/**
 * Rebuild detector→caveat joins from the currently registered RELEASE_PACK.
 * Called after `registerReleasePack` / `loadFundDocsPacks`.
 */
export function rebuildCaveatIndex(): void {
  detectorCaveats.clear();
  caveatCountByDetector.clear();
  detectorsWithCaveats = 0;
  for (const detector of RELEASE_PACK.detectors) {
    const merged: FundDocsCaveat[] = [];
    const seen = new Set<string>();
    // One pack group can wrap several pipeline obligations; merge their caveat
    // lists, deduped by (effect, title) — the same caveat often governs them all.
    for (const oid of detector.source_obligation_ids ?? []) {
      for (const caveat of CAVEATS_PACK.by_obligation[oid] ?? []) {
        const key = `${caveat.e}|${caveat.tt}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(caveat);
      }
    }
    if (merged.length > 0) {
      detectorsWithCaveats += 1;
      detectorCaveats.set(detector.obligation_id, merged);
    }
    caveatCountByDetector.set(detector.obligation_id, merged.length);
  }
}

/** How many of the pack's detectors carry at least one caveat. */
export function getCaveatDetectorCount(): number {
  return detectorsWithCaveats;
}

/** Caveats attached to a detector (synthetic pack id, e.g. "sysc:18-1:0"). */
export function caveatsForDetectorId(obligationId: string): FundDocsCaveat[] | null {
  return detectorCaveats.get(obligationId) ?? null;
}

/** Caveats for a finding — resolved through its matched detector id. */
export function caveatsForFinding(finding: { matched_detectors?: string[] }): FundDocsCaveat[] | null {
  const id = finding.matched_detectors?.[0];
  return id ? caveatsForDetectorId(id) : null;
}

/** Caveat count for a detector id (0 when none) — for compact chips. */
export function caveatCountForDetectorId(obligationId: string): number {
  return caveatCountByDetector.get(obligationId) ?? 0;
}
