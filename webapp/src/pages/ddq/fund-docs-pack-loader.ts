/**
 * Runtime loader for fund-docs detectors + advice.
 *
 * Packs live on S3 (dedicated enanoPacks bucket), served via the public
 * /fund-docs-packs Lambda (presigned URL) — the same architecture as
 * amendize.com. They are NEVER statically imported or committed to git, so
 * the static site stays small and pack updates never require a site deploy.
 *
 * Local / CI without the API configured: amplify_outputs.json carries no
 * apiBaseUrl, the fetch throws, and the UI soft-fails to the inline authored
 * pack (it still boots).
 */
import { registerReleasePack, type ReleasePackFile } from "./pack-v2";
import { registerAdvicePack, type AdviceFile } from "./advice";
import { rebuildCaveatIndex } from "./caveats";
import { rebuildRegulatoryUpdateIndex } from "./regulatory-updates";

let _loadPromise: Promise<void> | null = null;
let _loaded = false;

export function fundDocsPacksLoaded(): boolean {
  return _loaded;
}

async function apiBase(): Promise<string> {
  const outputs = await import("../../endpoints.json");
  const base = (outputs as { custom?: { apiBaseUrl?: string } }).custom?.apiBaseUrl;
  if (!base) throw new Error("API base URL not configured");
  return base;
}

async function fetchPackJson<T>(file: "detectors" | "advice"): Promise<T> {
  const base = await apiBase();
  const meta = await fetch(`${base}/fund-docs-packs?file=${file}`);
  if (!meta.ok) {
    throw new Error(`fund-docs-packs ${file}: ${meta.status} ${await meta.text()}`);
  }
  const { url } = (await meta.json()) as { url: string };
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`fund-docs-packs S3 ${file}: ${resp.status}`);
  }
  return (await resp.json()) as T;
}

/** Apply detectors (+ rebuild secondary indexes) and advice into the runtime stores. */
export function applyFundDocsPacks(detectors: ReleasePackFile, advice: AdviceFile): void {
  registerReleasePack(detectors);
  rebuildCaveatIndex();
  rebuildRegulatoryUpdateIndex();
  registerAdvicePack(advice);
  _loaded = true;
}

/**
 * Fetch detectors + advice from the public API and register them.
 * Idempotent — concurrent callers share one in-flight promise.
 */
export function loadFundDocsPacks(): Promise<void> {
  if (_loaded) return Promise.resolve();
  if (_loadPromise) return _loadPromise;
  _loadPromise = (async () => {
    const [detectors, advice] = await Promise.all([
      fetchPackJson<ReleasePackFile>("detectors"),
      fetchPackJson<AdviceFile>("advice"),
    ]);
    applyFundDocsPacks(detectors, advice);
  })().catch((err) => {
    _loadPromise = null;
    throw err;
  });
  return _loadPromise;
}
