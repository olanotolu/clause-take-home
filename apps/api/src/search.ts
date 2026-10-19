import { selectorFor, type Target } from "@clause/core";
import { InvalidQueryError, queryTerms, type Store } from "./store/types.ts";

export { InvalidQueryError };

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
  /** words: backend relevance score, higher is better (SQLite -bm25, Postgres ts_rank_cd). exact: number of occurrences. */
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

export interface SearchOptions {
  mode: Mode;
  limit: number;
  offset: number;
  /** Restrict to these document ids. */
  ids?: string[] | undefined;
  /** Exact mode only: maximum hits returned per document. */
  hitsPerDocument?: number;
}

function validate(q: string): string {
  const trimmed = q.trim();
  if (trimmed.length === 0) throw new InvalidQueryError("Query is empty");
  // SQLite treats NUL as end-of-string, which truncates the FTS query mid-quote ("unterminated string").
  if (trimmed.includes("\u0000")) throw new InvalidQueryError("Query must not contain NUL characters");
  if (trimmed.length > MAX_QUERY_LENGTH) throw new InvalidQueryError(`Query longer than ${MAX_QUERY_LENGTH} characters`);
  return trimmed;
}

export async function search(store: Store, rawQuery: string, opts: SearchOptions): Promise<SearchPage> {
  const query = validate(rawQuery);
  if (opts.mode === "words") {
    const { total, results } = await searchWords(store, query, opts);
    return { query, mode: opts.mode, total, limit: opts.limit, offset: opts.offset, results };
  }
  const page = await searchExact(store, query, opts);
  return { query, mode: opts.mode, total: page.total, limit: opts.limit, offset: opts.offset, results: page.results };
}

// ---------------------------------------------------------------- words (ranked, backend-specific)

/**
 * Documents whose size is at most this get FTS5's native snippet() (it picks the
 * best window). snippet() evaluates every match position in the row, which
 * measured at ~8 s on a 10 MB contract for a common phrase, so larger documents
 * locate their highlight with a bounded linear scan instead (see locateTerms).
 */
export { NATIVE_SNIPPET_MAX_CHARS } from "./store/types.ts";

async function searchWords(store: Store, query: string, opts: SearchOptions): Promise<{ total: number; results: DocumentResult[] }> {
  const page = await store.wordsPage(query, { limit: opts.limit, offset: opts.offset, ...(opts.ids && { ids: opts.ids }) });
  return { total: page.total, results: page.items.map((r) => ({
    documentId: r.id, title: r.title, version: r.version, relevance: r.score,
    hits: [r.nativeSnippet !== undefined ? nativeHit(r.content, r.nativeSnippet) : r.contentOffset !== undefined ? boundedChunkHit(r.content,r.contentOffset,query) : locatedHit(r.content, query)],
  })) };
}

function boundedChunkHit(content:string,offset:number,query:string):Hit {
  const span=locateTerms(content,query);
  if(!span) return {snippet:[{text:content.slice(0,SNIPPET_RADIUS*2),match:false}]};
  const [localStart,localEnd]=span;
  const start=offset+localStart,end=offset+localEnd;
  return {snippet:exactSnippet(content,localStart,localEnd),start,end,target:{position:{start,end,expectedText:content.slice(localStart,localEnd)}}};
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
function nativeHit(content: string, snip: string): Hit {
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

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Finds the first place the query's words appear, in ONE linear regex pass.
 * Matching is a heuristic locator, not the matcher: FTS5 already decided the
 * document matches. Each word is shortened to ~70% of its length so inflections
 * (terminate/termination) still land. Quoted phrases match with flexible
 * whitespace. If nothing is found we return an un-highlighted preview.
 * The alternatives are plain literals, so there is no backtracking blow-up.
 */
export function locateTerms(content: string, query: string): [number, number] | undefined {
  const alts = queryTerms(query)
    .map((t) => {
      const words = t.split(/\s+/);
      // Only the LAST word may be shortened: earlier words must be followed by whitespace.
      const stem = (w: string) => (w.length > 4 ? w.slice(0, Math.max(4, Math.ceil(w.length * 0.7))) : w);
      return words.map((w, i) => escapeRegex(i === words.length - 1 ? stem(w) : w)).join("\\s+");
    })
    .filter(Boolean);
  if (alts.length === 0) return undefined;
  const m = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alts.join("|")})[\\p{L}\\p{N}]*`, "iu").exec(content);
  return m ? [m.index, m.index + m[0].length] : undefined;
}

function locatedHit(content: string, query: string): Hit {
  const span = locateTerms(content, query);
  if (!span) return { snippet: [{ text: content.slice(0, SNIPPET_RADIUS * 2) + (content.length > SNIPPET_RADIUS * 2 ? ELLIPSIS : ""), match: false }] };
  const [start, end] = span;
  return { snippet: exactSnippet(content, start, end), start, end, target: selectorFor(content, start, end) };
}

// ---------------------------------------------------------------- exact (index prefilter + literal scan)

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
async function searchExact(store: Store, query: string, opts: SearchOptions): Promise<{total:number;results:DocumentResult[]}> {
  const perDoc = opts.hitsPerDocument ?? 3;
  const page=await store.exactPage(query,{limit:opts.limit,offset:opts.offset,hitsPerDocument:perDoc,...(opts.ids&&{ids:opts.ids})});
  return {total:page.total,results:page.items.map((row)=>({
    documentId:row.id,title:row.title,version:row.version,relevance:row.matchCount,matchCount:row.matchCount,
    hits:row.hits.map((h):Hit=>{
      const before=(h.start>h.before.length?ELLIPSIS:"")+h.before;
      const after=h.after+(h.after.length===60?ELLIPSIS:"");
      return {snippet:[...(before?[{text:before,match:false}]:[]),{text:query,match:true},...(after?[{text:after,match:false}]:[])],start:h.start,end:h.end,target:{position:{start:h.start,end:h.end,expectedText:query}}};
    }),
  }))};
}
