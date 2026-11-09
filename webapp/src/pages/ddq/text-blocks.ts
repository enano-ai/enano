/**
 * Pure plain-text -> block builder shared by the browser workspace, the web
 * pipeline and the enano CLI. Lives apart from pipeline.ts (which pulls the
 * browser-only pdf/docx decoders) so non-browser consumers can load it
 * without mammoth/pdfjs/mupdf.
 */
import type { DdqContentBlock } from "./ddq-mock-data";

export const CAPS_SECTION = /^[A-Z0-9][A-Z0-9 &\-()/.,:'’]{3,68}$/;

export function textToBlocks(text: string, id: string): DdqContentBlock[] {
  const out: DdqContentBlock[] = [];
  const lines = text.split("\n");
  let page = 1;
  let index = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    const next = (lines[i + 1] ?? "").trim();
    if (raw === "---") {
      page += 1;
      continue;
    }
    // Markdown structure is never matchable text: ATX titles (# ...) and
    // setext titles (text underlined by === / ---) are scaffolding, so a
    // topic/gate regex must not fire on words inside them (e.g. "phone" in
    // "Notes (phone, no date)"). The setext marker line itself falls through
    // to the empty/--- handling above or below.
    if (/^#{1,6}(\s|$)/.test(raw)) continue;
    if (raw && (/^=+$/.test(next) || /^-{3,}$/.test(next))) continue;
    if (/^=+$/.test(raw)) continue;
    if (raw.length === 0) continue;
    index += 1;
    let body = raw;
    let kind: DdqContentBlock["kind"] = "answer";
    if (CAPS_SECTION.test(body) && (body.match(/[A-Z]/g) ?? []).length >= 3) {
      kind = "section";
    } else if (body.endsWith("?")) {
      kind = "question";
    } else if (/^(note|important information|disclaimer)/i.test(body) && body.length < 220) {
      kind = "note";
    }
    if (body.startsWith("- ")) body = body.slice(2);
    if (body.startsWith("|")) body = body.replace(/^\|\s?/, "").replace(/\s?\|$/, "").replace(/\s?\|\s?/g, "  |  ");
    out.push({ id: `${id}-b${index}`, kind, text: body, page });
  }
  return out;
}

/** Char range of each emitted block inside the raw text, keyed by block id
 * (`${id}-b${index}`). Mirrors textToBlocks' line skipping exactly, so a
 * finding's block_id maps to the line it came from — highlight painting and
 * click drill-down locate evidence by block, never by re-searching the
 * needle from position 0. */
export function blockCharRanges(text: string, id: string): Map<string, [number, number]> {
  const ranges = new Map<string, [number, number]>();
  const lines = text.split("\n");
  let index = 0;
  let pos = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const raw = line.trim();
    const next = (lines[i + 1] ?? "").trim();
    const start = pos + (line.length - line.trimStart().length);
    pos += line.length + 1;
    if (raw === "---") continue;
    if (/^#{1,6}(\s|$)/.test(raw)) continue;
    if (raw && (/^=+$/.test(next) || /^-{3,}$/.test(next))) continue;
    if (/^=+$/.test(raw)) continue;
    if (raw.length === 0) continue;
    index += 1;
    ranges.set(`${id}-b${index}`, [start, start + raw.length]);
  }
  return ranges;
}

/** Char ranges (into the raw text) of markdown structural lines: ATX titles
 * (# ...), setext titles plus their === / --- markers, and --- rules.
 * Matching never fires on these (see textToBlocks) and highlight painting
 * must skip them too — otherwise a body finding's needle ("phone") paints
 * the first occurrence, which can be an earlier title ("Notes (phone, ...)"). */
export function markdownStructureRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const lines = text.split("\n");
  let pos = 0;
  const starts: number[] = [];
  for (const line of lines) {
    starts.push(pos + (line.length - line.trimStart().length));
    pos += line.length + 1;
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const next = (lines[i + 1] ?? "").trim();
    const isStructure =
      /^#{1,6}(\s|$)/.test(line) ||
      /^=+$/.test(line) ||
      /^-{3,}$/.test(line) ||
      /^=+$/.test(next) ||
      /^-{3,}$/.test(next);
    if (isStructure) ranges.push([starts[i], starts[i] + line.length]);
  }
  return ranges;
}
