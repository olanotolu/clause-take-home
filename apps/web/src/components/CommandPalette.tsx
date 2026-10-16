import { Command } from "cmdk";
import { FileText, Loader2, Search as SearchIcon, TextSelect, X } from "../ui/icons.tsx";
import { useEffect, useRef, useState } from "react";
import { api, type DocResult, type Hit } from "../lib/api.ts";
import { navigate } from "../lib/router.ts";
import { useWorkspace } from "../lib/workspace.tsx";
import { Kbd } from "../ui/bits.tsx";

const item = "palette-result flex min-h-11 cursor-pointer items-start gap-3 rounded-control px-3 py-2.5 transition-colors duration-150 data-[selected=true]:bg-accent-soft data-[selected=true]:shadow-[inset_2px_0_0_var(--color-accent)] max-[520px]:min-h-14 max-[520px]:px-3 max-[520px]:py-3";

/**
 * ⌘K. cmdk owns focus, arrow keys, Enter and the listbox semantics; results come from the real search API, so cmdk's own
 * filtering is off. The CSS motion stays short so repeated keyboard use still feels immediate.
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
    if (!open) return;
    const viewport = window.visualViewport;
    const syncViewport = () => {
      if (!window.matchMedia("(max-width: 520px)").matches) {
        document.documentElement.style.removeProperty("--palette-viewport-height");
        document.documentElement.style.removeProperty("--palette-viewport-top");
        return;
      }
      document.documentElement.style.setProperty("--palette-viewport-height", `${viewport?.height ?? window.innerHeight}px`);
      document.documentElement.style.setProperty("--palette-viewport-top", `${viewport?.offsetTop ?? 0}px`);
    };
    syncViewport();
    viewport?.addEventListener("resize", syncViewport);
    viewport?.addEventListener("scroll", syncViewport);
    window.addEventListener("resize", syncViewport);
    return () => {
      viewport?.removeEventListener("resize", syncViewport);
      viewport?.removeEventListener("scroll", syncViewport);
      window.removeEventListener("resize", syncViewport);
      document.documentElement.style.removeProperty("--palette-viewport-height");
      document.documentElement.style.removeProperty("--palette-viewport-top");
    };
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
      overlayClassName="palette-overlay fixed inset-0 z-40 bg-black/40 backdrop-blur-[3px]"
      contentClassName="palette-dialog fixed left-1/2 top-1/2 z-50 w-[min(760px,calc(100vw-28px))] overflow-hidden rounded-[22px] border border-line bg-paper text-ink shadow-lift"
    >
      <div className="flex shrink-0 items-center gap-3 border-b border-line bg-paper px-5 py-4 max-[520px]:px-4 max-[520px]:pb-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent"><SearchIcon size={18} aria-hidden /></span>
        <Command.Input value={q} onValueChange={setQ} placeholder="Search documents and clauses…" className="h-11 min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-muted/75" />
        <span className="max-[520px]:hidden"><Kbd>esc</Kbd></span>
        <button onClick={onClose} aria-label="Close search" className="hidden size-11 shrink-0 place-items-center rounded-full text-muted transition-colors hover:bg-canvas active:scale-95 max-[520px]:grid"><X size={19} aria-hidden /></button>
      </div>
      <Command.List className="min-h-28 flex-1 overflow-y-auto overscroll-contain p-3 max-[520px]:max-h-none max-[520px]:min-h-0 max-[520px]:px-3 max-[520px]:py-2">
        <Command.Empty className="px-3 py-8 text-center text-sm text-muted">{searching ? <span className="inline-flex items-center gap-2"><Loader2 size={15} className="animate-spin text-accent" aria-hidden /> Searching clauses…</span> : q.trim().length < 2 ? "Type at least two characters to search clause text." : "No matches. Try different wording."}</Command.Empty>
        {docs.length > 0 && (
          <Command.Group heading={needle ? "Documents" : "Recent documents"} className="[&_[cmdk-group-heading]]:sticky [&_[cmdk-group-heading]]:top-0 [&_[cmdk-group-heading]]:z-10 [&_[cmdk-group-heading]]:bg-paper [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-2 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted">
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
          <Command.Group heading="Clauses" className="[&_[cmdk-group-heading]]:sticky [&_[cmdk-group-heading]]:top-0 [&_[cmdk-group-heading]]:z-10 [&_[cmdk-group-heading]]:bg-paper [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-2 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted">
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
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-line bg-canvas/70 px-4 py-2.5 pb-[max(10px,env(safe-area-inset-bottom))] text-[11px] text-muted"><span className="max-[520px]:hidden">Clause results jump to the exact passage.</span><span className="hidden max-[520px]:inline">Tap a result to open the exact passage.</span><span className="flex items-center gap-3 max-[520px]:hidden"><span><Kbd>↑↓</Kbd> Navigate</span><span><Kbd>↵</Kbd> Open</span></span></div>
    </Command.Dialog>
  );
}
