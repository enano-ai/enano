/**
 * s60 advice lookup: maps obligation fingerprints to document-type-aware
 * gap_actions and self_check_questions. Compiled by
 * scripts/import_fund_docs_advice.py and fetched at runtime via
 * `/fund-docs-packs?file=advice` — never statically imported (multi-MB).
 */

interface AdviceAction {
  text: string;
}

interface TypeAdvice {
  gap_actions: AdviceAction[];
  self_check_questions: string[];
}

interface AdviceEntry {
  fingerprint: string;
  duty_label?: string;
  advice_by_type: Record<string, TypeAdvice>;
}

export interface AdviceFile {
  schema: string;
  fingerprint_count: number;
  advice: AdviceEntry[];
}

const adviceByFingerprint = new Map<string, AdviceEntry>();

/** Replace the advice store (called by fund-docs-pack-loader). */
export function registerAdvicePack(file: AdviceFile): void {
  adviceByFingerprint.clear();
  for (const entry of file.advice) {
    adviceByFingerprint.set(entry.fingerprint, entry);
  }
}

export interface ResolvedAdvice {
  gap_actions: AdviceAction[];
  self_check_questions: string[];
  duty_label?: string;
}

/**
 * Resolve advice for a finding. Falls back through document types:
 * exact match (e.g. "factsheet" for a factsheet) → any available type.
 * Returns null until `registerAdvicePack` / `loadFundDocsPacks` has run.
 */
export function resolveAdvice(fingerprint: string | null, documentType: string | null): ResolvedAdvice | null {
  if (!fingerprint) return null;
  const entry = adviceByFingerprint.get(fingerprint);
  if (!entry) return null;
  if (documentType && entry.advice_by_type[documentType]) {
    return { ...entry.advice_by_type[documentType], duty_label: entry.duty_label };
  }
  const first = Object.values(entry.advice_by_type)[0];
  return first ? { ...first, duty_label: entry.duty_label } : null;
}
