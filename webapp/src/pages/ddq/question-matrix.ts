/**
 * Cross-document fact consistency: runs the imported s70 question matrix
 * (packs/release/question_matrix) against the document corpus. The pack
 * declares WHAT to extract and HOW to normalise; this module provides the
 * clustering and conflict detection semantics.
 */
import type { DdqDocument, DdqFinding } from "./ddq-mock-data";
import matrixFile from "./packs/question-matrix.json";

interface QmPattern {
  id: string;
  regex: string;
  flags: string;
  capture_groups?: Record<string, number>;
}

interface QmQuestion {
  id: string;
  label: string;
  instrument: string;
  provision_id: string;
  kind: string;
  patterns: QmPattern[];
  normalisation: string;
  tolerance: number;
  temporal: boolean;
  date_patterns?: QmPattern[];
  scope_patterns?: QmPattern[];
  enum_values?: string[];
  conflict_severity: "high" | "medium" | "low";
  description?: string;
}

interface QmFile {
  schema: string;
  id: string;
  seed_version: string;
  generated_at: string;
  questions: QmQuestion[];
  question_count: number;
  pattern_count: number;
}

export const QUESTION_MATRIX = matrixFile as unknown as QmFile;

const regexCache = new Map<string, RegExp>();

function getRegex(pattern: QmPattern): RegExp {
  let re = regexCache.get(pattern.id);
  if (!re) {
    const flags = pattern.flags.includes("i") ? "gi" : "g";
    re = new RegExp(pattern.regex, flags);
    regexCache.set(pattern.id, re);
  }
  re.lastIndex = 0;
  return re;
}

export interface FactOccurrence {
  docId: string;
  docFilename: string;
  blockId: string;
  blockIndex: number;
  scope: string;
  key: string;
  display: string;
  date: string | null;
  matchedText: string;
  excerpt: string;
}

const CURRENCY_MAP: Record<string, string> = { "£": "GBP", "€": "EUR", $: "USD" };

function normaliseValue(question: QmQuestion, match: RegExpMatchArray, groups: Record<string, number>): string {
  const currency = groups.currency ? match[groups.currency] : undefined;
  const amount = groups.amount ? match[groups.amount] : undefined;
  const value = groups.value ? match[groups.value] : undefined;
  const qualifier = groups.qualifier ? match[groups.qualifier] : undefined;

  switch (question.normalisation) {
    case "currency_millions": {
      const cur = currency ? (CURRENCY_MAP[currency] ?? currency) : "GBP";
      const n = parseFloat((amount ?? "0").replace(/,/g, ""));
      const mag = match[groups.magnitude ?? 3] ?? "m";
      const millions = /bn|billion/i.test(mag) ? n * 1000 : n;
      return `${cur} ${Math.round(millions)}`;
    }
    case "integer":
    case "year":
      return value ?? amount ?? "";
    case "enum":
      return value ?? "";
    case "entity_name":
      return (value ?? "").trim().replace(/\s+/g, " ");
    case "rate":
      return value ?? amount ?? "";
    case "rate_with_qualifier":
      return `${value ?? amount}% ${qualifier ? qualifier.toLowerCase() : "unspecified"}`;
    default:
      return value ?? amount ?? match[0];
  }
}

function formatDisplay(question: QmQuestion, match: RegExpMatchArray, groups: Record<string, number>): string {
  const currency = groups.currency ? match[groups.currency] : undefined;
  const amount = groups.amount ? match[groups.amount] : undefined;
  const value = groups.value ? match[groups.value] : undefined;
  const qualifier = groups.qualifier ? match[groups.qualifier] : undefined;
  const magnitude = groups.magnitude ? match[groups.magnitude] : undefined;

  switch (question.normalisation) {
    case "currency_millions": {
      const cur = currency ? (CURRENCY_MAP[currency] ?? currency) : "";
      if (magnitude && /bn|billion/i.test(magnitude)) return `${cur} ${amount}bn`;
      return `${cur} ${amount}m`;
    }
    case "rate_with_qualifier":
      return `${value ?? amount}% ${qualifier ?? ""}`.trim();
    case "enum":
      return question.enum_values?.find((v) => v.includes(value ?? "")) ?? value ?? "";
    default:
      return value ?? amount ?? match[0];
  }
}

function extractDate(text: string, at: number, question: QmQuestion): string | null {
  if (!question.temporal || !question.date_patterns) return null;
  const window = text.slice(Math.max(0, at - 120), Math.min(text.length, at + 160));
  for (const dp of question.date_patterns) {
    const re = getRegex(dp);
    re.lastIndex = 0;
    const match = re.exec(window);
    if (match && match[1]) return match[1];
  }
  return null;
}

function extractScope(text: string, question: QmQuestion): string {
  if (!question.scope_patterns) return "firm";
  for (const sp of question.scope_patterns) {
    const re = getRegex(sp);
    re.lastIndex = 0;
    const match = re.exec(text);
    if (match && match[1]) return match[1];
  }
  return "firm";
}

function extractQuestion(doc: DdqDocument, question: QmQuestion): FactOccurrence[] {
  const out: FactOccurrence[] = [];
  const docText = doc.blocks.map((b) => b.text).join("\n");
  const docScope = extractScope(docText, question);
  doc.blocks.forEach((block, blockIndex) => {
    const scope = extractScope(block.text, question) === 'firm' ? docScope : extractScope(block.text, question);
    for (const pattern of question.patterns) {
      const re = getRegex(pattern);
      re.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = re.exec(block.text)) !== null) {
        if (!match[0]) {
          re.lastIndex += 1;
          continue;
        }
        const key = normaliseValue(question, match, pattern.capture_groups ?? {});
        if (!key) continue;
        const display = formatDisplay(question, match, pattern.capture_groups ?? {});
        out.push({
          docId: doc.id,
          docFilename: doc.filename,
          blockId: block.id,
          blockIndex,
          scope,
          key,
          display,
          date: extractDate(block.text, match.index, question),
          matchedText: match[0],
          excerpt: excerptAround(block.text, match.index, match.index + match[0].length),
        });
      }
    }
  });
  return out;
}

function excerptAround(text: string, start: number, end: number, radius = 70): string {
  const from = Math.max(0, start - radius);
  const to = Math.min(text.length, end + radius);
  return `${from > 0 ? "…" : ""}${text.slice(from, to).replace(/\s+/g, " ").trim()}${to < text.length ? "…" : ""}`;
}

/** Union-find clustering for tolerance-based grouping. */
function clusterWithTolerance(values: Map<string, FactOccurrence[]>, tolerance: number): Map<string, FactOccurrence[]> {
  const keys = [...values.keys()];
  const parent = new Map(keys.map((k) => [k, k] as const));
  const find = (k: string): string => {
    while (parent.get(k) !== k) k = parent.get(k)!;
    return k;
  };
  const union = (a: string, b: string) => parent.set(find(a), find(b));
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const a = parseFloat(keys[i].split(" ").pop() ?? "0");
      const b = parseFloat(keys[j].split(" ").pop() ?? "0");
      if (isNaN(a) || isNaN(b)) continue;
      if (!keys[i].split(" ")[0].startsWith(keys[j].split(" ")[0])) continue;
      const tol = tolerance * Math.max(Math.abs(a), Math.abs(b));
      if (Math.abs(a - b) <= tol) union(keys[i], keys[j]);
    }
  }
  const out = new Map<string, FactOccurrence[]>();
  for (const key of keys) {
    const root = find(key);
    const list = out.get(root) ?? [];
    list.push(...values.get(key)!);
    out.set(root, list);
  }
  return out;
}

function fingerprint(seed: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

const SEVERITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

function dedupeBlockOverlaps(doc: DdqDocument, findings: DdqFinding[]): DdqFinding[] {
  const claimed = new Map<string, Array<[number, number]>>();
  const ordered = [...findings].sort(
    (a, b) => (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3) || b.confidence - a.confidence
  );
  return ordered.filter((finding) => {
    if (finding.category === "evidenced") return true;
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

function mergeScopes(byScope: Map<string, FactOccurrence[]>): Map<string, FactOccurrence[]> {
  const scopes = [...byScope.keys()].sort((a, b) => b.length - a.length);
  const merged = new Map<string, FactOccurrence[]>();
  for (const scope of scopes) {
    const target = [...merged.keys()].find((existing) => existing.endsWith(scope) || scope.endsWith(existing));
    if (target) merged.get(target)!.push(...byScope.get(scope)!);
    else merged.set(scope, [...byScope.get(scope)!]);
  }
  return merged;
}

/** One normalised value of one question, with every place it was stated. */
export interface DatapointHit {
  docId: string;
  docFilename: string;
  blockId: string;
  matchedText: string;
  excerpt: string;
  date: string | null;
  /** regex = question-matrix pattern; facts = semantic facts-model proposal. */
  method: "regex" | "facts";
}

export interface DatapointValue {
  key: string;
  display: string;
  date: string | null;
  docFilenames: string[];
  occurrences: number;
  excerpt: string;
  /** Every place this value was stated — used by the datapoint detail modal. */
  hits: DatapointHit[];
}

/** The name/value pair collection for one question (one card in the datapoints tab). */
export interface DatapointGroup {
  questionId: string;
  label: string;
  instrument: string;
  scope: string;
  values: DatapointValue[];
  /** Single tolerance-cluster (or temporal-only spread) = values agree. */
  consistent: boolean;
}

function valuesConsistent(question: QmQuestion, clusters: Map<string, FactOccurrence[]>): boolean {
  if (clusters.size <= 1) return true;
  if (question.tolerance > 0 && question.temporal) {
    const clusterList = [...clusters.values()];
    const allDated = clusterList.every((group) => group.some((occ) => occ.date));
    const sharedDate = clusterList.some((groupA, i) =>
      clusterList.some((groupB, j) => i !== j && groupA.some((a) => a.date && groupB.some((b) => b.date === a.date)))
    );
    if (allDated && !sharedDate) return true;
  }
  return false;
}

/**
 * The name/value pair collection the question matrix has built for a document
 * set: every question label with every distinct value stated across the
 * corpus, plus whether the values agree (tolerance + temporal aware, the same
 * semantics as crossCheckCorpus).
 */
export function extractDatapoints(docs: DdqDocument[]): DatapointGroup[] {
  const groups: DatapointGroup[] = [];
  for (const question of QUESTION_MATRIX.questions) {
    const occurrences = docs.flatMap((doc) => extractQuestion(doc, question));
    if (occurrences.length === 0) continue;
    const byScope = new Map<string, FactOccurrence[]>();
    for (const occ of occurrences) {
      const list = byScope.get(occ.scope) ?? [];
      list.push(occ);
      byScope.set(occ.scope, list);
    }
    for (const [scope, scoped] of mergeScopes(byScope)) {
      const byKey = new Map<string, FactOccurrence[]>();
      for (const occ of scoped) {
        const list = byKey.get(occ.key) ?? [];
        list.push(occ);
        byKey.set(occ.key, list);
      }
      const clusters = question.tolerance > 0 ? clusterWithTolerance(byKey, question.tolerance) : byKey;
      const values: DatapointValue[] = [...byKey.entries()]
        .map(([key, occs]) => ({
          key,
          display: occs[0].display,
          date: occs.find((occ) => occ.date)?.date ?? null,
          docFilenames: [...new Set(occs.map((occ) => occ.docFilename))],
          occurrences: occs.length,
          excerpt: occs[0].excerpt,
          hits: occs.map((occ) => ({
            docId: occ.docId,
            docFilename: occ.docFilename,
            blockId: occ.blockId,
            matchedText: occ.matchedText,
            excerpt: occ.excerpt,
            date: occ.date,
            method: "regex" as const,
          })),
        }))
        .sort((a, b) => b.occurrences - a.occurrences || a.display.localeCompare(b.display));
      groups.push({
        questionId: question.id,
        label: question.label,
        instrument: question.instrument,
        scope,
        values,
        consistent: valuesConsistent(question, clusters),
      });
    }
  }
  return groups;
}

/**
 * Cross-document consistency pass driven by the question matrix.
 * Returns findings to APPEND per document.
 */
export function crossCheckCorpus(docs: DdqDocument[]): Record<string, DdqFinding[]> {
  const byDoc: Record<string, DdqFinding[]> = {};
  if (docs.length < 2) return byDoc;
  const docById = new Map(docs.map((doc) => [doc.id, doc]));

  for (const question of QUESTION_MATRIX.questions) {
    const occurrences: FactOccurrence[] = docs.flatMap((doc) => extractQuestion(doc, question));
    const byScope = new Map<string, FactOccurrence[]>();
    for (const occ of occurrences) {
      const list = byScope.get(occ.scope) ?? [];
      list.push(occ);
      byScope.set(occ.scope, list);
    }

    for (const scoped of mergeScopes(byScope).values()) {
      const byKey = new Map<string, FactOccurrence[]>();
      for (const occ of scoped) {
        const list = byKey.get(occ.key) ?? [];
        list.push(occ);
        byKey.set(occ.key, list);
      }
      if (byKey.size < 2) continue;

      let clusters: Map<string, FactOccurrence[]>;
      if (question.tolerance > 0) {
        clusters = clusterWithTolerance(byKey, question.tolerance);
      } else {
        clusters = byKey;
      }

      if (question.tolerance > 0 && question.temporal) {
        const clusterList = [...clusters.values()];
        const allDated = clusterList.every((group) => group.some((occ) => occ.date));
        const sharedDate = clusterList.some((groupA, i) =>
          clusterList.some((groupB, j) => i !== j && groupA.some((a) => a.date && groupB.some((b) => b.date === a.date)))
        );
        if (allDated && !sharedDate) continue;
      }

      const maxSize = Math.max(...[...clusters.values()].map((group) => group.length));
      const conflicting = new Map<string, FactOccurrence[]>();
      for (const [root, group] of clusters) {
        if (group.length >= maxSize && maxSize > 1) continue;
        const undatedShared = group.some(
          (a) =>
            a.date &&
            [...clusters.values()].some((gb) => gb !== group && gb.some((b) => b.date === a.date))
        );
        const suspects = undatedShared ? group : group.filter((occ) => !occ.date);
        if (suspects.length > 0) conflicting.set(root, suspects);
      }
      if (conflicting.size === 0) continue;

      const suspectSet = new Set([...conflicting.values()].flat());
      const others = scoped.filter((occ) => !suspectSet.has(occ));
      const otherDisplay = [...new Set(others.map((occ) => occ.display))].slice(0, 3).join(", ");
      const otherDocs = [...new Set(others.map((occ) => occ.docFilename))].length;

      for (const group of conflicting.values()) {
        for (const occ of group) {
          const doc = docById.get(occ.docId);
          if (!doc) continue;
          const block = doc.blocks.find((b) => b.id === occ.blockId);
          if (!block) continue;
          const target = occ.matchedText.slice(0, 140).trim();
          const finding: DdqFinding = {
            obligation_id: `question_matrix_${question.id}`,
            content_fingerprint: fingerprint(`${question.id}:${occ.docId}:${occ.blockId}:${occ.key}`),
            instrument: question.instrument,
            provision_id: `${question.provision_id} — differs from the rest of the document set`,
            title:
              question.id === "sfdr_article"
                ? `${occ.scope}: classified ${occ.display} here but ${otherDisplay} elsewhere`
                : `${question.label}: ${occ.display} here vs ${otherDisplay} in ${otherDocs} other document${otherDocs === 1 ? "" : "s"}`,
            match_strength: "strong",
            confidence: 0.92,
            matched_detectors: [`question/${question.id}`],
            matched_count: group.length,
            total_count: scoped.length,
            section: block.text.slice(0, 60),
            page: block.page ?? 1,
            excerpt: occ.excerpt,
            matches: [
              {
                detector_id: `question/${question.id}`,
                origin: "question-matrix",
                match_display: `${question.label} stated as ${occ.display}`,
                strength: "strong",
                char_offset: block.text.indexOf(occ.matchedText),
                excerpt: occ.excerpt,
                matched_text: occ.matchedText,
                section: block.text.slice(0, 60),
                page: block.page ?? 1,
                in_reference_section: false,
                score: 0.92,
              },
              ...others.slice(0, 5).map((other) => ({
                detector_id: `question/${question.id}`,
                origin: "question-matrix",
                match_display: `${other.display} — ${other.docFilename}`,
                strength: "strong" as const,
                char_offset: 0,
                excerpt: other.excerpt,
                matched_text: other.matchedText,
                section: other.docFilename,
                page: null,
                in_reference_section: false,
                score: 0.92,
              })),
            ],
            guidance: {
              match_display: `${question.label} consistent across every document in the set`,
              gap_actions: [
                {
                  text: `Confirm the correct ${question.label.toLowerCase()} and update the documents that disagree${question.temporal ? " (values that only appear under different as-of dates are treated as temporal and ignored)" : ""}.`,
                  vessel_types: ["all"],
                },
              ],
              self_check_questions: [
                `Which ${question.label.toLowerCase()} is correct, and which document is stale? Decide which document to fix — no text is changed for you.`,
              ],
            },
            severity: question.conflict_severity,
            category: "inconsistency",
            block_id: block.id,
            target_text: target,
            replacement_text: target,
          };
          if (!byDoc[occ.docId]) byDoc[occ.docId] = [];
          byDoc[occ.docId].push(finding);
        }
      }
    }
  }
  return byDoc;
}
