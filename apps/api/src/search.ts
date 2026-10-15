import { selectorFor, type Target } from "@clause/core";
import type { Db } from "./db.ts";

export const MAX_QUERY_LENGTH = 200;
const SNIPPET_RADIUS = 60;
/** FTS5 snippet() markers; chosen because they never appear in sane text. */
const OPEN = "\u0002";
const CLOSE = "\u0003";
const ELLIPSIS = "…";

export type Mode = "words" | "exact";

/** Text is delivered as segments so clients never need to render HTML from document content. */
export interface Segment {
  text: string;
  match: boolean;
}

export interface Hit {
  snippet: Segment[];
  /** Present when the hit maps onto verified offsets in the CURRENT document text. */
  start?: number;
  end?: number;
  /** A selector that resolves to exactly [start, end) in this version: paste it into PATCH. */
  target?: Target;
}

export interface DocumentResult {
  documentId: string;
  title: string;
  version: number;
  /** words: -bm25 (higher is better). exact: number of occurrences in the document. */
  relevance: number;
  matchCount?: number;
  hits: Hit[];
}

export interface SearchPage {
  query: string;
  mode: Mode;
  /** Number of matching documents (not occurrences). */
  total: number;
  limit: number;
  offset: number;
  results: DocumentResult[];
}

export class InvalidQueryError extends Error {}

export interface SearchOptions {
  mode: Mode;
  limit: number;
  offset: number;
  /** Restrict to these document ids. */
  ids?: string[] | undefined;
  /** Exact mode only: maximum hits returned per document. */
  hitsPerDocument?: number;
}

/**
 * Plain text -> FTS5 query. Every term (or "quoted phrase") is emitted as an
 * FTS5 phrase literal, so operators, column filters, NEAR, `*` and `-` in user
 * input are inert. Terms are implicitly ANDed.
 */
export function compileWordsQuery(q: string): string {
  const terms = [...q.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => (m[1] ?? m[2] ?? "").trim()).filter(Boolean);
  if (terms.length === 0) throw new InvalidQueryError("Query is empty");
  return terms.map((t) => `"${t.replaceAll('"', '""')}"`).join(" ");
}

const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(",");

function validate(q: string): string {
  const trimmed = q.trim();
  if (trimmed.length === 0) throw new InvalidQueryError("Query is empty");
  if (trimmed.length > MAX_QUERY_LENGTH) throw new InvalidQueryError(`Query longer than ${MAX_QUERY_LENGTH} characters`);
  return trimmed;
}

export function search(db: Db, rawQuery: string, opts: SearchOptions): SearchPage {
  const query = validate(rawQuery);
  const results = opts.mode === "exact" ? searchExact(db, query, opts) : searchWords(db, query, opts);
  const page = results.all.slice(opts.offset, opts.offset + opts.limit);
  return { query, mode: opts.mode, total: results.all.length, limit: opts.limit, offset: opts.offset, results: page };
}

// ---------------------------------------------------------------- words (FTS5 + BM25)

function searchWords(db: Db, query: string, opts: SearchOptions): { all: DocumentResult[] } {
  const match = compileWordsQuery(query);
  const idFilter = opts.ids?.length ? `AND d.id IN (${placeholders(opts.ids.length)})` : "";
  let rows: { id: string; title: string; version: number; content: string; score: number; snip: string }[];
  try {
    rows = db
      .prepare(
        `SELECT d.id, d.title, d.version, d.content,
                bm25(documents_words, 5.0, 1.0) AS score,
                snippet(documents_words, 1, '${OPEN}', '${CLOSE}', '${ELLIPSIS}', 24) AS snip
         FROM documents_words
         JOIN documents d ON d.seq = documents_words.rowid
         WHERE documents_words MATCH ? ${idFilter}
         ORDER BY score, d.seq`,
      )
      .all(match, ...(opts.ids ?? [])) as unknown as typeof rows;
  } catch (e) {
    if (e instanceof Error && /fts5/i.test(e.message)) throw new InvalidQueryError(`Unsupported query: ${e.message}`);
    throw e;
  }
  return {
    all: rows.map((r) => ({
      documentId: r.id,
      title: r.title,
      version: r.version,
      relevance: -r.score,
      hits: [wordsHit(r.content, r.snip)],
    })),
  };
}

/** Splits FTS5's marked-up snippet into segments. */
export function parseSnippet(snip: string): Segment[] {
  const segments: Segment[] = [];
  let rest = snip;
  while (rest.length > 0) {
    const open = rest.indexOf(OPEN);
    if (open === -1) {
      segments.push({ text: rest, match: false });
      break;
    }
    if (open > 0) segments.push({ text: rest.slice(0, open), match: false });
    const close = rest.indexOf(CLOSE, open);
    const end = close === -1 ? rest.length : close;
    segments.push({ text: rest.slice(open + 1, end), match: true });
    rest = rest.slice(end + 1);
  }
  return segments;
}

/**
 * FTS5 doesn't report offsets, but snippet() copies document text verbatim.
 * So we locate the fragment in the current content and VERIFY the highlighted
 * span by slicing; if anything doesn't line up we return the snippet without
 * offsets rather than guessing.
 */
function wordsHit(content: string, snip: string): Hit {
  const segments = parseSnippet(snip);
  const hit: Hit = { snippet: segments };
  const firstMatch = segments.findIndex((s) => s.match);
  if (firstMatch === -1) return hit;

  const fragment = segments.map((s) => s.text).join("");
  const before = segments.slice(0, firstMatch).reduce((n, s) => n + s.text.length, 0);
  const matchText = segments[firstMatch]!.text;

  // snippet() may have added a leading/trailing ellipsis that isn't in the document.
  const variants = [fragment, fragment.slice(ELLIPSIS.length), fragment.slice(0, -ELLIPSIS.length), fragment.slice(ELLIPSIS.length, -ELLIPSIS.length)];
  const shifts = [0, ELLIPSIS.length, 0, ELLIPSIS.length];
  for (let i = 0; i < variants.length; i++) {
    const at = content.indexOf(variants[i]!);
    if (at === -1 || variants[i]!.length === 0) continue;
    const start = at + before - shifts[i]!;
    const end = start + matchText.length;
    if (start >= 0 && content.slice(start, end) === matchText) {
      return { ...hit, start, end, target: selectorFor(content, start, end) };
    }
  }
  return hit;
}

// ---------------------------------------------------------------- exact (trigram prefilter + literal scan)

function exactSnippet(content: string, start: number, end: number): Segment[] {
  const from = Math.max(0, start - SNIPPET_RADIUS);
  const to = Math.min(content.length, end + SNIPPET_RADIUS);
  const segs: Segment[] = [];
  const lead = (from > 0 ? ELLIPSIS : "") + content.slice(from, start);
  const trail = content.slice(end, to) + (to < content.length ? ELLIPSIS : "");
  if (lead) segs.push({ text: lead, match: false });
  segs.push({ text: content.slice(start, end), match: true });
  if (trail) segs.push({ text: trail, match: false });
  return segs;
}

/**
 * Exact = literal, case-sensitive substring, the same semantics as a quote
 * selector (non-overlapping, left to right). The trigram index is only a
 * CANDIDATE filter (it is case-insensitive and needs >= 3 characters); every
 * reported offset comes from scanning the real current content.
 */
function searchExact(db: Db, query: string, opts: SearchOptions): { all: DocumentResult[] } {
  const perDoc = opts.hitsPerDocument ?? 3;
  const idFilter = opts.ids?.length ? `AND d.id IN (${placeholders(opts.ids.length)})` : "";
  const ids = opts.ids ?? [];

  const candidates =
    query.length >= 3
      ? db
          .prepare(
            `SELECT d.id, d.title, d.version, d.content FROM documents_trgm
             JOIN documents d ON d.seq = documents_trgm.rowid
             WHERE documents_trgm MATCH ? ${idFilter}`,
          )
          .all(`"${query.replaceAll('"', '""')}"`, ...ids)
      : db
          .prepare(`SELECT d.id, d.title, d.version, d.content FROM documents d WHERE instr(d.content, ?) > 0 ${idFilter}`)
          .all(query, ...ids);

  const out: DocumentResult[] = [];
  for (const row of candidates as unknown as { id: string; title: string; version: number; content: string }[]) {
    const hits: Hit[] = [];
    let matchCount = 0;
    for (let at = row.content.indexOf(query); at !== -1; at = row.content.indexOf(query, at + query.length)) {
      matchCount++;
      if (hits.length < perDoc) {
        const end = at + query.length;
        hits.push({ snippet: exactSnippet(row.content, at, end), start: at, end, target: selectorFor(row.content, at, end) });
      }
    }
    if (matchCount > 0) out.push({ documentId: row.id, title: row.title, version: row.version, relevance: matchCount, matchCount, hits });
  }
  out.sort((a, b) => b.relevance - a.relevance || a.title.localeCompare(b.title));
  return { all: out };
}
