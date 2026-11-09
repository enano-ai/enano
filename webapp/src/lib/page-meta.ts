/**
 * Set / restore document title + Open Graph / Twitter meta for the page,
 * without leaving stale tags after navigation.
 */

export interface PageMeta {
  title: string;
  description: string;
  /** Absolute production image URL for the social card; omit for none */
  image?: string;
  /** Absolute canonical page URL */
  url: string;
}

interface Snapshot {
  title: string;
  description: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  ogUrl: string | null;
  ogImage: string | null;
  twitterTitle: string | null;
  twitterDescription: string | null;
  twitterImage: string | null;
}

function read(selector: string): string | null {
  return document.head.querySelector(selector)?.getAttribute("content") ?? null;
}

function write(selector: string, content: string) {
  let el = document.head.querySelector(selector);
  if (!el) {
    // Boot HTML may omit og:url on purpose (so crawlers don't inherit a wrong
    // static canonical). Create the tag when a page installs its own meta.
    const attrMatch = selector.match(/^meta\[(property|name)="([^"]+)"\]$/);
    if (!attrMatch) return;
    el = document.createElement("meta");
    el.setAttribute(attrMatch[1], attrMatch[2]);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

function snapshot(): Snapshot {
  return {
    title: document.title,
    description: read('meta[name="description"]'),
    ogTitle: read('meta[property="og:title"]'),
    ogDescription: read('meta[property="og:description"]'),
    ogUrl: read('meta[property="og:url"]'),
    ogImage: read('meta[property="og:image"]'),
    twitterTitle: read('meta[name="twitter:title"]'),
    twitterDescription: read('meta[name="twitter:description"]'),
    twitterImage: read('meta[name="twitter:image"]'),
  };
}

function apply(meta: PageMeta) {
  document.title = meta.title;
  write('meta[name="description"]', meta.description);
  write('meta[property="og:title"]', meta.title);
  write('meta[property="og:description"]', meta.description);
  write('meta[property="og:url"]', meta.url);
  write('meta[name="twitter:title"]', meta.title);
  write('meta[name="twitter:description"]', meta.description);
  if (meta.image != null) {
    write('meta[property="og:image"]', meta.image);
    write('meta[name="twitter:image"]', meta.image);
  }
}

function restore(prev: Snapshot) {
  document.title = prev.title;
  if (prev.description != null) write('meta[name="description"]', prev.description);
  if (prev.ogTitle != null) write('meta[property="og:title"]', prev.ogTitle);
  if (prev.ogDescription != null) write('meta[property="og:description"]', prev.ogDescription);
  if (prev.ogUrl != null) write('meta[property="og:url"]', prev.ogUrl);
  if (prev.ogImage != null) write('meta[property="og:image"]', prev.ogImage);
  if (prev.twitterTitle != null) write('meta[name="twitter:title"]', prev.twitterTitle);
  if (prev.twitterDescription != null) {
    write('meta[name="twitter:description"]', prev.twitterDescription);
  }
  if (prev.twitterImage != null) write('meta[name="twitter:image"]', prev.twitterImage);
}

/** Apply page meta; return a cleanup that restores the previous tags. */
export function installPageMeta(meta: PageMeta): () => void {
  const prev = snapshot();
  apply(meta);
  return () => restore(prev);
}
