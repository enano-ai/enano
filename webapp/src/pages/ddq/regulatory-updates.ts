/**
 * Regulatory updates lookup for the DDQ review.
 *
 * s90 document-pipeline enrichments (`enrichments/regulatory_updates/`) compiled
 * by scripts/import_fund_docs_regulatory_updates.py. Join order for a finding:
 *   1. affected pipeline obligation ids (source_obligation_ids)
 *   2. normalized provision id
 *   3. instrument alias fallback
 *
 * Updates are SECONDARY signal — they never flip an evidence verdict. They tell
 * the reviewer the instrument/provision has recent official developments.
 */
import updatesFile from "./packs/fund-docs-regulatory-updates.json";
import { RELEASE_PACK } from "./pack-v2";
import type { DdqFinding } from "./ddq-mock-data";

export type UpdateClass =
  | "legal_text_change"
  | "chapter_signal"
  | "proposed_rules"
  | "soft_law"
  | "publisher_notice"
  | "event"
  | "unclassified"
  | string;

export type UpdateMatchLevel = "obligation" | "provision" | "instrument";

export interface FundDocsRegulatoryAction {
  action: string;
  deadline: string | null;
}

export interface FundDocsRegulatoryUpdate {
  id: string;
  title: string;
  publisher: string;
  published_at: string;
  url: string;
  class: UpdateClass;
  summary: string;
  deadline: string | null;
  effective_date: string | null;
  provision: string | null;
  instrument: string;
  pipeline_instrument: string;
  publisher_item_type: string;
  feed: string;
  topics: string[];
  pdf_urls: string[];
  action_items: FundDocsRegulatoryAction[];
  affected_obligation_ids: string[];
  match_method: string;
  match_terms: string[];
}

export interface MatchedRegulatoryUpdate extends FundDocsRegulatoryUpdate {
  match_level: UpdateMatchLevel;
}

export interface FundDocsRegulatoryUpdatesFile {
  schema: string;
  id: string;
  version: string;
  generated_at: string;
  source: string;
  window_days: number | null;
  pipeline_generated_at?: string;
  sidecars: { pipeline_instrument: string; instrument: string; items: number }[];
  update_items: number;
  instruments_with_updates: number;
  by_instrument: Record<string, FundDocsRegulatoryUpdate[]>;
  by_obligation: Record<string, string[]>;
  by_provision: Record<string, string[]>;
}

export const REGULATORY_UPDATES_PACK = updatesFile as unknown as FundDocsRegulatoryUpdatesFile;
export const REGULATORY_UPDATES_PACK_VERSION = REGULATORY_UPDATES_PACK.version;

const updateById = new Map<string, FundDocsRegulatoryUpdate>();
for (const items of Object.values(REGULATORY_UPDATES_PACK.by_instrument)) {
  for (const item of items) {
    updateById.set(item.id, item);
  }
}

/** detector pack id → matched updates (premerged for card hints) */
const detectorUpdates = new Map<string, MatchedRegulatoryUpdate[]>();

function normalizeProvision(prov: string | null | undefined): string {
  if (!prov) return "";
  let s = prov.trim();
  s = s.replace(/\s*\([^)]*\)\s*$/, "");
  s = s.replace(/\s+[RGED]$/i, "");
  // Strip trailing descriptive labels after the citation, e.g.
  // "COBS 4.1.1D G: ESG Naming…" → "COBS 4.1.1D G" → then R/G strip → "COBS 4.1.1D"
  const colon = s.indexOf(":");
  if (colon > 0 && /^[A-Z0-9 .]+$/i.test(s.slice(0, colon).trim())) {
    s = s.slice(0, colon).trim();
    s = s.replace(/\s+[RGED]$/i, "");
  }
  return s.replace(/\s+/g, " ").trim();
}

function resolveIds(ids: string[], level: UpdateMatchLevel): MatchedRegulatoryUpdate[] {
  const out: MatchedRegulatoryUpdate[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    const item = updateById.get(id);
    if (!item) continue;
    seen.add(id);
    out.push({ ...item, match_level: level });
  }
  return out;
}

function mergeMatched(parts: MatchedRegulatoryUpdate[][]): MatchedRegulatoryUpdate[] {
  const best = new Map<string, MatchedRegulatoryUpdate>();
  const rank: Record<UpdateMatchLevel, number> = { obligation: 0, provision: 1, instrument: 2 };
  for (const list of parts) {
    for (const item of list) {
      const prev = best.get(item.id);
      if (!prev || rank[item.match_level] < rank[prev.match_level]) {
        best.set(item.id, item);
      }
    }
  }
  return [...best.values()].sort((a, b) => b.published_at.localeCompare(a.published_at));
}

export function updatesForInstrument(instrument: string): MatchedRegulatoryUpdate[] {
  return (REGULATORY_UPDATES_PACK.by_instrument[instrument] ?? []).map((item) => ({
    ...item,
    match_level: "instrument" as const,
  }));
}

export function updatesForInstruments(instruments: Iterable<string>): MatchedRegulatoryUpdate[] {
  const parts: MatchedRegulatoryUpdate[][] = [];
  for (const instrument of instruments) {
    parts.push(updatesForInstrument(instrument));
  }
  return mergeMatched(parts);
}

/** Resolve updates for a finding via obligation → provision → instrument. */
export function updatesForFinding(finding: {
  instrument: string;
  provision_id?: string;
  obligation_id?: string;
  source_obligation_ids?: string[];
  matched_detectors?: string[];
}): MatchedRegulatoryUpdate[] {
  if (finding.obligation_id) {
    const cached = detectorUpdates.get(finding.obligation_id);
    if (cached) return cached;
  }

  const pipelineOids = finding.source_obligation_ids ?? [];
  // Detectors carry source_obligation_ids; findings from pack-v2 usually expose
  // them via the detector id lookup below when missing on the finding itself.
  let oids = pipelineOids;
  if (oids.length === 0 && finding.obligation_id) {
    const detector = RELEASE_PACK.detectors.find((d) => d.obligation_id === finding.obligation_id);
    oids = detector?.source_obligation_ids ?? [];
  }

  const fromObligation: MatchedRegulatoryUpdate[] = [];
  for (const oid of oids) {
    fromObligation.push(...resolveIds(REGULATORY_UPDATES_PACK.by_obligation[oid] ?? [], "obligation"));
  }

  const prov = normalizeProvision(finding.provision_id);
  const fromProvision =
    prov.length > 0
      ? resolveIds(
          REGULATORY_UPDATES_PACK.by_provision[`${finding.instrument}|${prov}`] ?? [],
          "provision"
        )
      : [];

  const fromInstrument = updatesForInstrument(finding.instrument);
  return mergeMatched([fromObligation, fromProvision, fromInstrument]);
}

export function updatesForFindingCount(finding: Parameters<typeof updatesForFinding>[0]): number {
  return updatesForFinding(finding).length;
}

/**
 * Precompute per-detector update hints from the currently registered RELEASE_PACK.
 * Called after `registerReleasePack` / `loadFundDocsPacks`.
 */
export function rebuildRegulatoryUpdateIndex(): void {
  detectorUpdates.clear();
  for (const detector of RELEASE_PACK.detectors) {
    const matched = updatesForFinding({
      instrument: detector.instrument,
      provision_id: detector.provision_id,
      obligation_id: detector.obligation_id,
      source_obligation_ids: detector.source_obligation_ids,
    });
    detectorUpdates.set(detector.obligation_id, matched);
  }
}

export function updatesForDetectorId(obligationId: string): MatchedRegulatoryUpdate[] {
  return detectorUpdates.get(obligationId) ?? [];
}
