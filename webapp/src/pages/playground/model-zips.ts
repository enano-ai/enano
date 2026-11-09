import outputs from "../../endpoints.json";

const base =
  (outputs as { custom?: { modelZipsBaseUrl?: string } }).custom?.modelZipsBaseUrl ?? "";

/** Public download URL for a model-bundle zip (stable "latest" key), or
 * undefined when the backend has not been deployed with the output yet. */
export function modelZipUrl(filename: string): string | undefined {
  return base ? `${base}/${filename}` : undefined;
}
