/**
 * Lazy singleton loader for the semantic models (self-hosted bge-small
 * family, q8). Facts (field location / datapoint proposals) and check
 * (obligation matching) share one instance when they point at the same
 * weights. Each model pair loads once per page session and is reused across
 * documents; progress listeners stay attached for the duration of an
 * in-flight load so later callers (queued docs) still see download progress.
 *
 * Model pairs are per scan scope: the fund-docs DDQ workspace uses the base
 * bge-small; the playground's goals and pitch-decks scopes use their own
 * MNRL fine-tunes (CLS pooling — see the catalog entries in
 * lib/nano/nano-models.json).
 */
import { detectNanoDevice, getModelSpec, loadNanoModel, type EmbedFn, type NanoDevice } from "@/lib/nano/runtime";
import type { SemanticEmbedder } from "@/pages/ddq/semantic-layer";

export const FUND_DOCS_FACTS_MODEL_ID = "Xenova/bge-small-en-v1.5";
export const FUND_DOCS_CHECK_MODEL_ID = "Xenova/bge-small-en-v1.5";

/** Vertical fine-tunes: bge-small MNRL, CLS pooling, 256-token window,
 * self-hosted under builtin-data/models/enano/<id>. */
export const GOALS_SEMANTIC_MODEL_ID = "enano/pg-mnrl-47845708";
export const PITCH_SEMANTIC_MODEL_ID = "enano/spd-mnrl-48127877";

export interface FundDocsSemanticModels {
  facts: SemanticEmbedder;
  check: SemanticEmbedder;
}

export type SemanticModelProgressFn = (which: "facts" | "check", progress: number) => void;

export type CapabilityStatus = "pending" | "checking" | "ready" | "unavailable";

export interface FundDocsCapabilityReport {
  webgpu: CapabilityStatus;
  wasm: CapabilityStatus;
  models: CapabilityStatus;
  device: NanoDevice | null;
}

export type CapabilityProgressFn = (report: FundDocsCapabilityReport) => void;

const cache = new Map<string, Promise<FundDocsSemanticModels | null>>();
const progressListeners = new Map<string, Set<SemanticModelProgressFn>>();

function pairKey(factsId: string, checkId: string): string {
  return `${factsId}|${checkId}`;
}

function asEmbedder(embedQueries: EmbedFn, embedPassages: EmbedFn): SemanticEmbedder {
  return { embedQueries, embedPassages };
}

async function loadPair(factsId: string, checkId: string, key: string): Promise<FundDocsSemanticModels> {
  const listeners = () => progressListeners.get(key);
  const notify = (which: "facts" | "check", progress: number) => {
    for (const listener of listeners() ?? []) listener(which, progress);
  };
  const factsSpec = getModelSpec(factsId);
  const checkSpec = getModelSpec(checkId);
  const factsLoaded = await loadNanoModel(factsSpec, (progress) => notify("facts", progress));
  notify("facts", 100);
  // Same model for both roles: share one instance instead of double-loading
  // the weights — half the memory and load time on low-end machines.
  const checkLoaded =
    factsSpec.id === checkSpec.id
      ? factsLoaded
      : await loadNanoModel(checkSpec, (progress) => notify("check", progress));
  notify("check", 100);
  return {
    facts: asEmbedder(factsLoaded.embedQueries, factsLoaded.embedPassages),
    check: asEmbedder(checkLoaded.embedQueries, checkLoaded.embedPassages),
  };
}

/** Returns null when weights fail to load — regex review still stands alone. */
export function getSemanticModels(
  factsId: string,
  checkId: string,
  onProgress?: SemanticModelProgressFn
): Promise<FundDocsSemanticModels | null> {
  const key = pairKey(factsId, checkId);
  if (onProgress) {
    const listeners = progressListeners.get(key) ?? new Set<SemanticModelProgressFn>();
    listeners.add(onProgress);
    progressListeners.set(key, listeners);
  }
  let cachedPair = cache.get(key);
  if (!cachedPair) {
    cachedPair = loadPair(factsId, checkId, key).catch((error: unknown) => {
      console.warn(`[semantic-models] ${factsId} failed to load`, error);
      return null;
    });
    cache.set(key, cachedPair);
  }
  // Detach this caller's listener when the load settles (per call, so a
  // late subscriber attached mid-download is cleaned up too).
  return cachedPair.finally(() => {
    if (onProgress) progressListeners.get(key)?.delete(onProgress);
  });
}

export function getFundDocsSemanticModels(
  onProgress?: SemanticModelProgressFn
): Promise<FundDocsSemanticModels | null> {
  return getSemanticModels(FUND_DOCS_FACTS_MODEL_ID, FUND_DOCS_CHECK_MODEL_ID, onProgress);
}

/** Model pair for a playground scan scope. Scopes without a fine-tune
 * (funds, career-advice) fall back to the fund-docs base model. */
export function scanScopeModelIds(scope: string): { facts: string; check: string } {
  if (scope === "goals") return { facts: GOALS_SEMANTIC_MODEL_ID, check: GOALS_SEMANTIC_MODEL_ID };
  if (scope === "pitch-decks") return { facts: PITCH_SEMANTIC_MODEL_ID, check: PITCH_SEMANTIC_MODEL_ID };
  return { facts: FUND_DOCS_FACTS_MODEL_ID, check: FUND_DOCS_CHECK_MODEL_ID };
}

export function getScanScopeSemanticModels(
  scope: string,
  onProgress?: SemanticModelProgressFn
): Promise<FundDocsSemanticModels | null> {
  const { facts, check } = scanScopeModelIds(scope);
  return getSemanticModels(facts, check, onProgress);
}

/** Download the fund-docs model weights (single-flight, shared with every
 * later caller). Maps the facts/check load to one MONOTONIC 0–100 value
 * (facts 0–50, check 50–100): the loader's dtype ladder (fp16 → fp32 → q8
 * fallbacks) re-fires progress from 0 on every retry, and the Models icon
 * must never run backwards. Resolves null on failure. */
export function loadFundDocsModelWeights(
  onOverallProgress?: (pct: number) => void
): Promise<FundDocsSemanticModels | null> {
  let shown = 0;
  return getFundDocsSemanticModels((which, progress) => {
    const overall = which === "facts" ? progress * 0.5 : 50 + progress * 0.5;
    const pct = Math.min(100, Math.round(overall));
    if (pct > shown) {
      shown = pct;
      onOverallProgress?.(pct);
    }
  });
}

/** Same as loadFundDocsModelWeights, for a playground scan scope's model. */
export function loadScanScopeModelWeights(
  scope: string,
  onOverallProgress?: (pct: number) => void
): Promise<FundDocsSemanticModels | null> {
  let shown = 0;
  return getScanScopeSemanticModels(scope, (which, progress) => {
    const overall = which === "facts" ? progress * 0.5 : 50 + progress * 0.5;
    const pct = Math.min(100, Math.round(overall));
    if (pct > shown) {
      shown = pct;
      onOverallProgress?.(pct);
    }
  });
}


/**
 * Probe the three gates that matter for /prototype: WebGPU (optional), WASM
 * (CPU fallback), and whether the semantic model specs resolve — a pure
 * system check. It never downloads weights; the download runs separately
 * (loadScanScopeModelWeights) and surfaces on the Models capability icon.
 * Regex review does not depend on any of these — models failing is
 * informative, not blocking.
 */
export async function probeFundDocsCapabilities(onUpdate?: CapabilityProgressFn): Promise<FundDocsCapabilityReport> {
  const report: FundDocsCapabilityReport = {
    webgpu: "checking",
    wasm: "pending",
    models: "pending",
    device: null,
  };
  onUpdate?.({ ...report });

  const device = await detectNanoDevice();
  report.device = device;
  report.webgpu = device === "webgpu" ? "ready" : "unavailable";
  report.wasm = "checking";
  onUpdate?.({ ...report });

  const wasmOk = typeof WebAssembly !== "undefined";
  report.wasm = wasmOk ? "ready" : "unavailable";
  report.models = "checking";
  onUpdate?.({ ...report });

  let modelsOk = wasmOk;
  try {
    getModelSpec(FUND_DOCS_FACTS_MODEL_ID);
    getModelSpec(FUND_DOCS_CHECK_MODEL_ID);
  } catch {
    modelsOk = false;
  }
  report.models = modelsOk ? "ready" : "unavailable";
  onUpdate?.({ ...report });
  return report;
}

/** Test hook: replace or clear every cached pair. */
export function __resetFundDocsSemanticModelsForTests(): void {
  cache.clear();
  for (const listeners of progressListeners.values()) listeners.clear();
  progressListeners.clear();
}

export function __setFundDocsSemanticModelsForTests(models: FundDocsSemanticModels | null): void {
  cache.set(pairKey(FUND_DOCS_FACTS_MODEL_ID, FUND_DOCS_CHECK_MODEL_ID), Promise.resolve(models));
}
