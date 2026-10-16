import { Command } from "cmdk";
import { ArrowRight, FileText, Loader2, Search as SearchIcon, TextSelect, X } from "../ui/icons.tsx";
import { useEffect, useRef, useState } from "react";
import { api, type DocResult, type Hit } from "../lib/api.ts";
import { navigate } from "../lib/router.ts";
import { useWorkspace } from "../lib/workspace.tsx";
import { Kbd } from "../ui/bits.tsx";
import { ago } from "../lib/wordDelta.ts";

const item = "group flex min-h-12 cursor-pointer items-center gap-3 rounded-control px-3 py-2.5 transition-[background-color,color] duration-100 data-[selected=true]:bg-canvas max-[520px]:min-h-14 max-[520px]:px-3 max-[520px]:py-3";

/**
 * ⌘K. cmdk owns focus, arrow keys, Enter and the listbox semantics; results come from the real search API, so cmdk's own
 * filtering is off. The CSS motion stays short so repeated keyboard use still feels immediate.
 */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ws = useWorkspace();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<{ result: DocResult; hit: Hit }[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    if (open) {
      setQ("");
      setHits([]);
      setSearchError(null);
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
      seq.current += 1;
      setHits([]);
      setSearching(false);
      setSearchError(null);
      return;
    }
    const mine = ++seq.current;
    setSearching(true);
    setHits([]);
    setSearchError(null);
    const t = setTimeout(async () => {
      const r = await api.search(query, "words");
      if (mine !== seq.current) return;
      setSearching(false);
      if (!r.ok) {
        setSearchError(r.error.error);
        return;
      }
      setHits(r.data.results.flatMap((res) => res.hits.slice(0, 1).map((hit) => ({ result: res, hit }))).slice(0, 8));
    }, 200);
    return () => clearTimeout(t);
  }, [q, open]);

  const needle = q.trim().toLowerCase();
  const docs = [...ws.docs]
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .filter((d) => !needle || d.title.toLowerCase().includes(needle))
    .slice(0, needle ? 5 : 6);

  return (
    <Command.Dialog
      open={open}
      onOpenChange={(o) => { if (!o) onClose(); }}
      label="Search documents and clauses"
      shouldFilter={false}
      overlayClassName="palette-overlay fixed inset-0 z-40 bg-ink/30"
      contentClassName="palette-dialog fixed left-1/2 top-[clamp(72px,12vh,128px)] z-50 flex max-h-[min(640px,calc(100dvh-96px))] w-[min(720px,calc(100vw-32px))] -translate-x-1/2 flex-col overflow-hidden rounded-[18px] border border-line bg-paper text-ink shadow-lift"
    >
      <div className="shrink-0 border-b border-line px-4 pb-3 pt-4 max-[520px]:px-4 max-[520px]:pb-3">
        <div className="flex h-12 items-center gap-3 rounded-control border border-line-strong bg-paper px-3 transition-colors focus-within:border-accent/65 focus-within:ring-2 focus-within:ring-accent/10">
          <SearchIcon size={18} className="shrink-0 text-muted" aria-hidden />
          <Command.Input value={q} onValueChange={setQ} placeholder="Search documents and clauses" className="h-full min-w-0 flex-1 bg-transparent text-[15px] max-[520px]:text-[16px] outline-none placeholder:text-muted/75" />
          {searching && <Loader2 size={16} className="shrink-0 animate-spin text-muted" aria-label="Searching" />}
          <span className="max-[520px]:hidden"><Kbd>esc</Kbd></span>
          <button onClick={onClose} aria-label="Close search" className="hidden size-9 shrink-0 place-items-center rounded-control text-muted transition-colors hover:bg-canvas active:scale-95 max-[520px]:grid"><X size={18} aria-hidden /></button>
        </div>
        {needle.length < 2 && <p className="mt-2 px-1 text-xs text-muted">Search contract titles and clause text across this workspace.</p>}
      </div>
      <Command.List className="min-h-32 flex-1 overflow-y-auto overscroll-contain px-2 py-2.5 max-[520px]:max-h-none max-[520px]:min-h-0 max-[520px]:px-2 max-[520px]:py-2">
        <Command.Empty className="px-4 py-10 text-center text-sm text-muted">
          {searching ? <span className="inline-flex items-center gap-2"><Loader2 size={15} className="animate-spin text-accent" aria-hidden /> Searching clauses…</span> : searchError ? searchError : q.trim().length < 2 ? "No documents yet. Add a document to search this workspace." : "No matches. Try a clause phrase or a shorter search."}
        </Command.Empty>
        {searchError && docs.length > 0 && <p role="alert" className="mx-2 my-2 rounded-control bg-fail-bg px-3 py-2 text-xs text-fail">Clause search failed: {searchError}</p>}
        {docs.length > 0 && (
          <Command.Group heading={needle ? `Documents · ${docs.length}` : "Recent documents"} className="[&_[cmdk-group-heading]]:sticky [&_[cmdk-group-heading]]:top-0 [&_[cmdk-group-heading]]:z-10 [&_[cmdk-group-heading]]:bg-paper [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-1.5 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted">
            {docs.map((d) => (
              <Command.Item key={d.id} value={`doc-${d.id}`} onSelect={() => { onClose(); navigate({ name: "doc", id: d.id, tab: "edit" }); }} className={item}>
                <FileText size={17} className="shrink-0 text-muted group-data-[selected=true]:text-accent" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{d.title}</p>
                  <p className="tnum mt-0.5 text-xs text-muted">v{d.version} <span aria-hidden>·</span> Edited {ago(d.updatedAt)}</p>
                </div>
                <span className="flex shrink-0 items-center gap-1 text-xs text-muted opacity-0 transition-opacity group-data-[selected=true]:opacity-100 group-hover:opacity-100">Open <ArrowRight size={14} aria-hidden /></span>
              </Command.Item>
            ))}
          </Command.Group>
        )}
        {hits.length > 0 && (
          <Command.Group heading={`Clause matches · ${hits.length}`} className="[&_[cmdk-group-heading]]:sticky [&_[cmdk-group-heading]]:top-0 [&_[cmdk-group-heading]]:z-10 [&_[cmdk-group-heading]]:bg-paper [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-1.5 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted">
            {hits.map(({ result, hit }, i) => (
              <Command.Item key={`${result.documentId}-${i}`} value={`hit-${result.documentId}-${i}`} onSelect={() => { onClose(); ws.pickHit(result, hit); }} className={item}>
                <TextSelect size={17} className="mt-0.5 shrink-0 text-muted group-data-[selected=true]:text-accent" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{result.title} <span className="tnum font-normal text-muted">· v{result.version}</span></p>
                  <p className="mt-0.5 line-clamp-2 text-[13px] leading-[1.45] text-muted">
                    {hit.snippet.map((s, k) => (s.match ? <mark key={k} className="rounded-sm bg-hit px-0.5 text-ink">{s.text}</mark> : <span key={k}>{s.text}</span>))}
                  </p>
                </div>
                <ArrowRight size={15} className="shrink-0 text-accent opacity-0 transition-opacity group-data-[selected=true]:opacity-100 group-hover:opacity-100" aria-hidden />
              </Command.Item>
            ))}
          </Command.Group>
        )}
      </Command.List>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-line bg-canvas/65 px-4 py-2.5 pb-[max(10px,env(safe-area-inset-bottom))] text-[11px] text-muted"><span className="max-[520px]:hidden">Clause matches open at the exact passage.</span><span className="hidden max-[520px]:inline">Tap a match to open the exact passage.</span><span className="flex items-center gap-3 max-[520px]:hidden"><span><Kbd>↑↓</Kbd> Navigate</span><span><Kbd>↵</Kbd> Open</span></span></div>
    </Command.Dialog>
  );
}
