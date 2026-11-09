/** URL debug switches: ?debug=<name>[,<name>...] — e.g. /enano/?debug=fallback.
 * Reads the page URL once per call; prod-safe no-op when the param is absent.
 * Shared affordance for test-only UI: gates stay out of component state so
 * flags can drive any pane or dialog without new plumbing. */
export function hasDebugFlag(name: string): boolean {
  if (typeof window === "undefined") return false;
  const raw = new URLSearchParams(window.location.search).get("debug");
  if (!raw) return false;
  return raw
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .includes(name.toLowerCase());
}
