import manifestRaw from "./profiles/profile-images.json";
import defaultPersonUrl from "./profiles/default-person.png";

interface ProfileEntry {
  image: string;
  name: string;
}

interface ProfileManifest {
  profiles: Record<string, ProfileEntry>;
}

const manifest = manifestRaw as ProfileManifest;

const imageUrls = import.meta.glob("./profiles/*.png", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

export interface SubjectProfile {
  src: string;
  name: string;
}

/** Resolves an instrument's portrait; instruments without a sourced photo get
 * the neutral person-silhouette placeholder instead of nothing. */
export function subjectProfile(key: string): SubjectProfile {
  const entry = manifest.profiles[key];
  const found = entry
    ? Object.entries(imageUrls).find(([path]) => path.endsWith(`/${entry.image}`))
    : undefined;
  if (found) return { src: found[1], name: entry.name };
  return { src: defaultPersonUrl, name: "" };
}
