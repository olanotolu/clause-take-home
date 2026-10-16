import { Loader2, Search as SearchIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, type DocResult, type Hit, type SearchPage } from "../lib/api.ts";
import { EmptyState } from "../ui/bits.tsx";

interface Props {
  /** Bumped by the parent after a commit so results never show stale text. */
  refreshKey: number;
  /** Set by "Find" in the selection toolbar: fills the box and searches that exact text. */
  seed: { q: string; n: number } | null;
  onOpen: (result: DocResult) => void;
  onPick: (result: DocResult, hit: Hit) => void;
  onResults: (page: SearchPage | null) => void;
}

function Snippet({ hit }: { hit: Hit }) {
  return (
    <span className="text-[13px] leading-snug text-ink/80">
      {hit.snippet.map((s, i) => (s.match ? <mark key={i} className="rounded-sm bg-hit px-0.5 text-ink">{s.text}</mark> : <span key={i}>{s.text}</span>))}
    </span>
  );
}

export function SearchPanel({ refreshKey, seed, onOpen, onPick, onResults }: Props) {
  const [q, setQ] = useState("");
  const [mode, setMode] = useState<"words" | "exact">("words");
  const [page, setPage] = useState<SearchPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    if (seed) {
      setQ(seed.q);
      setMode("exact");
    }
  }, [seed]);

  useEffect(() => {
    const query = q.trim();
    if (!query) {
      setPage(null);
      setError(null);
      onResults(null);
      return;
    }
    const mine = ++seq.current;
    setLoading(true);
    const t = setTimeout(async () => {
      const r = await api.search(query, mode);
      if (mine !== seq.current) return; // a newer query superseded this one
      setLoading(false);
      if (r.ok) {
        setPage(r.data);
        setError(null);
        onResults(r.data);
      } else {
        setPage(null);
        setError(r.error.error);
        onResults(null);
      }
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, mode, refreshKey]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="relative">
        <SearchIcon size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={mode === "words" ? "Search clauses, e.g. confidentiality" : "Exact text, e.g. shall not disclose"}
          aria-label="Search query"
          className="h-9 w-full rounded-control border border-line-strong bg-paper pl-9 pr-3 text-sm"
        />
      </div>
      <div role="radiogroup" aria-label="Search mode" className="flex gap-1 rounded-control bg-line/60 p-1 text-xs">
        {(["words", "exact"] as const).map((m) => (
          <button key={m} role="radio" aria-checked={mode === m} onClick={() => setMode(m)} className={`h-7 flex-1 rounded-md px-2 font-medium transition-colors ${mode === m ? "bg-paper text-ink shadow-sm" : "text-muted hover:text-ink"}`}>
            {m === "words" ? "Words, ranked" : "Exact, literal"}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted">{mode === "words" ? "Stemmed words, ranked by BM25." : "Case-sensitive text. Every hit has exact offsets."}</p>

      <div aria-live="polite" className="flex items-center gap-1.5 text-xs text-muted">
        {loading ? <><Loader2 size={12} className="animate-spin" aria-hidden /> Searching…</> : page ? `${page.total} document${page.total === 1 ? "" : "s"}` : null}
      </div>
      {error && <p role="alert" className="rounded-control bg-fail-bg px-3 py-2 text-sm text-fail">{error}</p>}

      <ul className="-mx-1 min-h-0 flex-1 space-y-2 overflow-y-auto px-1">
        {page?.results.map((r) => (
          <li key={r.documentId} className="rounded-control border border-line bg-paper">
            <button onClick={() => onOpen(r)} className="block w-full px-3 pt-2 text-left">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-sm font-semibold">{r.title}</span>
                <span className="tnum shrink-0 text-xs text-muted">v{r.version} · {r.matchCount !== undefined ? `${r.matchCount}×` : `score ${r.relevance.toFixed(2)}`}</span>
              </div>
            </button>
            <ul className="divide-y divide-line/70 px-1 pb-1">
              {r.hits.map((h, i) => (
                <li key={i}>
                  <button onClick={() => onPick(r, h)} disabled={h.start === undefined} title={h.start === undefined ? "No verified offset for this hit" : "Select this passage to edit"} className="block w-full rounded px-2 py-1.5 text-left hover:bg-canvas disabled:cursor-default disabled:hover:bg-transparent">
                    <Snippet hit={h} />
                  </button>
                </li>
              ))}
            </ul>
          </li>
        ))}
        {page && page.results.length === 0 && <li className="px-1 text-sm text-muted">No matches.</li>}
        {!page && !loading && !error && <li><EmptyState icon={<SearchIcon size={22} aria-hidden />} title="Search every document">Find a clause by words, or paste exact text. Pick a hit to select that passage for editing.</EmptyState></li>}
      </ul>
    </div>
  );
}
