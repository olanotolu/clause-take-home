/**
 * Turns the document text plus highlight ranges into renderable pieces.
 * Text is rendered as React text nodes, never as HTML, so document content
 * (or a search snippet) can never inject markup.
 */
export interface Piece {
  text: string;
  /** Offset of this piece in the ORIGINAL text; undefined for inserted text, which has none. */
  start?: number;
  kind: "plain" | "hit" | "sel" | "del" | "ins";
}

export interface Range { start: number; end: number; kind: "hit" | "sel" }

/** Plain text with non-overlapping highlight ranges. On a tie the selection beats a search hit. */
export function highlightPieces(text: string, ranges: Range[]): Piece[] {
  const rank = (r: Range) => (r.kind === "sel" ? 0 : 1);
  const sorted = [...ranges].sort((a, b) => a.start - b.start || rank(a) - rank(b) || b.end - a.end);
  const pieces: Piece[] = [];
  let cursor = 0;
  for (const r of sorted) {
    if (r.start < cursor) continue;
    if (r.start > cursor) pieces.push({ text: text.slice(cursor, r.start), start: cursor, kind: "plain" });
    pieces.push({ text: text.slice(r.start, r.end), start: r.start, kind: r.kind });
    cursor = r.end;
  }
  if (cursor < text.length) pieces.push({ text: text.slice(cursor), start: cursor, kind: "plain" });
  return pieces;
}

/** Inline redline built from the server's applied spans: deletions struck red, insertions green. */
export function redlinePieces(text: string, applied: { start: number; end: number; before: string; after: string }[]): Piece[] {
  const pieces: Piece[] = [];
  let cursor = 0;
  for (const a of [...applied].sort((x, y) => x.start - y.start || x.end - y.end)) {
    if (a.start > cursor) pieces.push({ text: text.slice(cursor, a.start), start: cursor, kind: "plain" });
    if (a.before) pieces.push({ text: a.before, start: a.start, kind: "del" });
    if (a.after) pieces.push({ text: a.after, kind: "ins" });
    cursor = a.end;
  }
  if (cursor < text.length) pieces.push({ text: text.slice(cursor), start: cursor, kind: "plain" });
  return pieces;
}

/** Number of non-overlapping literal occurrences (same rule as the engine). */
export function countOccurrences(text: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) n++;
  return n;
}
