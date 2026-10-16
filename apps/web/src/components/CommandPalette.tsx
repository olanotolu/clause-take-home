import { FileText, Search as SearchIcon, TextSelect } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type DocResult, type DocSummary, type Hit } from "../lib/api.ts";
import { navigate } from "../lib/router.ts";
import { useWorkspace } from "../lib/workspace.tsx";
import { Kbd } from "../ui/bits.tsx";

type Item = { kind: "doc"; doc: DocSummary } | { kind: "hit"; result: DocResult; hit: Hit };

/** ⌘K: jump to a document, or to the exact passage a search hit points at. Uses the real search API. */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ws = useWorkspace();
  const ref = useRef<HTMLDialogElement>(null);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const [hits, setHits] = useState<{ result: DocResult; hit: Hit }[]>([]);
  const [searching, setSearching] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setQ("");
      setActive(0);
      setHits([]);
      d.showModal();
    } else if (!open && d.open) d.close();
  }, [open]);

  useEffect(() => {
    const query = q.trim();
    if (!open || query.length < 2) {
      setHits([]);
      setSearching(false);
      return;
    }
    const mine = ++seq.current;
    setSearching(true);
    const t = setTimeout(async () => {
      const r = await api.search(query, "words");
      if (mine !== seq.current) return;
      setSearching(false);
      setHits(r.ok ? r.data.results.flatMap((res) => res.hits.slice(0, 1).map((hit) => ({ result: res, hit }))).slice(0, 8) : []);
    }, 200);
    return () => clearTimeout(t);
  }, [q, open]);

  const items: Item[] = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const docs = ws.docs.filter((d) => !needle || d.title.toLowerCase().includes(needle)).slice(0, needle ? 5 : 8);
    return [...docs.map((doc): Item => ({ kind: "doc", doc })), ...hits.map(({ result, hit }): Item => ({ kind: "hit", result, hit }))];
  }, [q, ws.docs, hits]);

  useEffect(() => setActive(0), [q]);

  const go = (it: Item) => {
    onClose();
    if (it.kind === "doc") navigate({ name: "doc", id: it.doc.id, tab: "edit" });
    else ws.pickHit(it.result, it.hit);
  };

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
      aria-label="Search documents and clauses"
      className="m-auto mt-[12vh] w-[min(640px,calc(100vw-24px))] rounded-2xl border border-line-strong bg-paper p-0 text-ink shadow-lift backdrop:bg-black/40"
    >
      <div className="flex items-center gap-2.5 border-b border-line px-4">
        <SearchIcon size={16} className="text-muted" aria-hidden />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, items.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
            else if (e.key === "Enter" && items[active]) { e.preventDefault(); go(items[active]!); }
          }}
          role="combobox"
          aria-expanded
          aria-controls="palette-list"
          aria-activedescendant={items[active] ? `palette-${active}` : undefined}
          aria-label="Search documents and clauses"
          placeholder="Search documents and clauses…"
          className="h-12 min-w-0 flex-1 bg-transparent text-[15px] outline-none"
        />
        <Kbd>esc</Kbd>
      </div>
      <ul id="palette-list" role="listbox" className="max-h-[50vh] overflow-y-auto p-2">
        {items.map((it, i) => (
          <li
            key={it.kind === "doc" ? it.doc.id : `${it.result.documentId}-${i}`}
            id={`palette-${i}`}
            role="option"
            aria-selected={i === active}
            onMouseMove={() => setActive(i)}
            onClick={() => go(it)}
            className={`flex cursor-pointer items-start gap-3 rounded-lg px-3 py-2 ${i === active ? "bg-accent-soft" : ""}`}
          >
            {it.kind === "doc" ? <FileText size={16} className="mt-0.5 shrink-0 text-muted" aria-hidden /> : <TextSelect size={16} className="mt-0.5 shrink-0 text-muted" aria-hidden />}
            <div className="min-w-0">
              {it.kind === "doc" ? (
                <>
                  <p className="truncate text-sm font-medium">{it.doc.title}</p>
                  <p className="text-xs text-muted">Open · v{it.doc.version}</p>
                </>
              ) : (
                <>
                  <p className="truncate text-sm font-medium">{it.result.title} <span className="font-normal text-muted">· v{it.result.version}</span></p>
                  <p className="line-clamp-2 text-[13px] text-muted">
                    {it.hit.snippet.map((s, k) => (s.match ? <mark key={k} className="rounded-sm bg-hit px-0.5 text-ink">{s.text}</mark> : <span key={k}>{s.text}</span>))}
                  </p>
                </>
              )}
            </div>
          </li>
        ))}
        {items.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted">{searching ? "Searching…" : q.trim().length < 2 ? "Type at least two characters to search clause text." : "No matches."}</li>}
      </ul>
      <p className="border-t border-line px-4 py-2 text-xs text-muted">Enter opens. Searching words across every document; a result selects the exact passage.</p>
    </dialog>
  );
}
