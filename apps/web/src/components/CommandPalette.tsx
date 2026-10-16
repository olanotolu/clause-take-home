import { Command } from "cmdk";
import { FileText, Search as SearchIcon, TextSelect } from "../ui/icons.tsx";
import { useEffect, useRef, useState } from "react";
import { api, type DocResult, type Hit } from "../lib/api.ts";
import { navigate } from "../lib/router.ts";
import { useWorkspace } from "../lib/workspace.tsx";
import { Kbd } from "../ui/bits.tsx";

const item = "flex cursor-pointer items-start gap-3 rounded-control px-3 py-2 data-[selected=true]:bg-accent-soft";

/**
 * ⌘K. cmdk owns focus, arrow keys, Enter and the listbox semantics; results come from the real search API, so cmdk's own
 * filtering is off. It opens and closes with no animation on purpose: it is a keyboard action people repeat all day.
 */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ws = useWorkspace();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<{ result: DocResult; hit: Hit }[]>([]);
  const [searching, setSearching] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    if (open) {
      setQ("");
      setHits([]);
    }
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

  const needle = q.trim().toLowerCase();
  const docs = ws.docs.filter((d) => !needle || d.title.toLowerCase().includes(needle)).slice(0, needle ? 5 : 8);

  return (
    <Command.Dialog
      open={open}
      onOpenChange={(o) => { if (!o) onClose(); }}
      label="Search documents and clauses"
      shouldFilter={false}
      overlayClassName="fixed inset-0 z-40 bg-black/40"
      contentClassName="fixed left-1/2 top-[12vh] z-50 w-[min(640px,calc(100vw-24px))] -translate-x-1/2 overflow-hidden rounded-[20px] bg-paper text-ink shadow-lift"
    >
      <div className="flex items-center gap-2.5 border-b border-line px-4">
        <SearchIcon size={16} className="text-muted" aria-hidden />
        <Command.Input value={q} onValueChange={setQ} placeholder="Search documents and clauses…" className="h-12 min-w-0 flex-1 bg-transparent text-[15px] outline-none" />
        <Kbd>esc</Kbd>
      </div>
      <Command.List className="max-h-[50vh] overflow-y-auto p-2">
        <Command.Empty className="px-3 py-6 text-center text-sm text-muted">{searching ? "Searching…" : q.trim().length < 2 ? "Type at least two characters to search clause text." : "No matches."}</Command.Empty>
        {docs.length > 0 && (
          <Command.Group heading={needle ? "Documents" : "Recent documents"} className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted">
            {docs.map((d) => (
              <Command.Item key={d.id} value={`doc-${d.id}`} onSelect={() => { onClose(); navigate({ name: "doc", id: d.id, tab: "edit" }); }} className={item}>
                <FileText size={16} className="mt-0.5 shrink-0 text-muted" aria-hidden />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{d.title}</p>
                  <p className="tnum text-xs text-muted">Open · v{d.version}</p>
                </div>
              </Command.Item>
            ))}
          </Command.Group>
        )}
        {hits.length > 0 && (
          <Command.Group heading="Clauses" className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted">
            {hits.map(({ result, hit }, i) => (
              <Command.Item key={`${result.documentId}-${i}`} value={`hit-${result.documentId}-${i}`} onSelect={() => { onClose(); ws.pickHit(result, hit); }} className={item}>
                <TextSelect size={16} className="mt-0.5 shrink-0 text-muted" aria-hidden />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{result.title} <span className="tnum font-normal text-muted">· v{result.version}</span></p>
                  <p className="line-clamp-2 text-[13px] text-muted">
                    {hit.snippet.map((s, k) => (s.match ? <mark key={k} className="rounded-sm bg-hit px-0.5 text-ink">{s.text}</mark> : <span key={k}>{s.text}</span>))}
                  </p>
                </div>
              </Command.Item>
            ))}
          </Command.Group>
        )}
      </Command.List>
      <p className="border-t border-line px-4 py-2 text-xs text-muted">Enter opens. Clause results select the exact passage.</p>
    </Command.Dialog>
  );
}
