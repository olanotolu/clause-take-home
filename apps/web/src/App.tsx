import { selectorFor } from "@clause/engine";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChangePanel, type PreviewState, type Staged } from "./components/ChangePanel.tsx";
import { DocPane } from "./components/DocPane.tsx";
import { HistoryPanel } from "./components/HistoryPanel.tsx";
import { RequirementsPanel } from "./components/RequirementsPanel.tsx";
import { SearchPanel } from "./components/SearchPanel.tsx";
import { SuggestPanel } from "./components/SuggestPanel.tsx";
import { api, type CiReport, type Doc, type DocResult, type DocSummary, type Evidence, type Hit, type SearchPage } from "./lib/api.ts";
import type { Range } from "./lib/segments.ts";

type Tab = "search" | "change" | "rules" | "ai" | "history";

export default function App() {
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [status, setStatus] = useState<{ kind: "loading" | "error" | "ready"; message?: string }>({ kind: "loading" });
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const [staged, setStaged] = useState<Staged[]>([]);
  const [preview, setPreview] = useState<PreviewState>({ status: "idle" });
  const [tab, setTab] = useState<Tab>("search");
  const [redline, setRedline] = useState(false);
  const [searchPage, setSearchPage] = useState<SearchPage | null>(null);
  const [conflict, setConflict] = useState<{ currentVersion?: number | undefined } | null>(null);
  const [applying, setApplying] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [ci, setCi] = useState<{ status: "idle" } | { status: "loading" } | { status: "done"; report: CiReport } | { status: "error"; message: string }>({ status: "idle" });
  const [goal, setGoal] = useState("");
  const nextId = useRef(1);

  const refreshDocs = useCallback(async () => {
    const r = await api.list();
    if (r.ok) {
      setDocs(r.data.items);
      setStatus({ kind: "ready" });
      return r.data.items;
    }
    setStatus({ kind: "error", message: r.error.error });
    return [];
  }, []);

  const openDoc = useCallback(async (id: string) => {
    const r = await api.get(id);
    if (!r.ok) return setNotice(r.error.error);
    setDoc(r.data);
    setSelection(null);
    setStaged([]);
    setConflict(null);
    setPreview({ status: "idle" });
    setRedline(false);
  }, []);

  useEffect(() => {
    void refreshDocs().then((items) => items[0] && openDoc(items[0].id));
  }, [refreshDocs, openDoc]);

  // Validate the staged batch against the version on screen (the same engine call PATCH uses).
  const previewSeq = useRef(0);
  useEffect(() => {
    if (!doc || staged.length === 0) return setPreview({ status: "idle" });
    const mine = ++previewSeq.current;
    setPreview({ status: "loading" });
    void api.preview(doc.id, doc.version, staged.map((s) => ({ operation: "replace" as const, target: s.target, replacement: s.replacement }))).then((r) => {
      if (mine !== previewSeq.current) return;
      if (r.ok) setPreview({ status: "valid", data: r.data });
      else {
        setPreview({ status: "invalid", error: r.error });
        if (r.error.type === "VERSION_CONFLICT" || r.error.type === "PRECONDITION_FAILED") setConflict({ currentVersion: r.error.details?.currentVersion });
      }
    });
  }, [doc, staged]);

  // A report describes one exact (document version, staged batch, requirements) combination; any change makes it stale.
  useEffect(() => setCi({ status: "idle" }), [doc, staged]);

  const runCi = async () => {
    if (!doc || staged.length === 0) return;
    setCi({ status: "loading" });
    const r = await api.check(doc.id, doc.version, staged.map((s) => ({ operation: "replace" as const, target: s.target, replacement: s.replacement })), goal.trim() || undefined);
    setCi(r.ok ? { status: "done", report: r.data } : { status: "error", message: r.error.error });
  };
  const showEvidence = (e: Evidence) => setSelection({ start: e.start, end: e.end });

  // Search highlights are only valid for the exact version they were computed against.
  const hits: Range[] = useMemo(() => {
    const r = searchPage?.results.find((x) => x.documentId === doc?.id);
    if (!r || r.version !== doc?.version) return [];
    return r.hits.flatMap((h) => (h.start !== undefined && h.end !== undefined ? [{ start: h.start, end: h.end, kind: "hit" as const }] : []));
  }, [searchPage, doc]);

  const pick = (result: DocResult, hit: Hit) => {
    void (async () => {
      if (result.documentId !== doc?.id) await openDoc(result.documentId);
      if (hit.start !== undefined && hit.end !== undefined) {
        setSelection({ start: hit.start, end: hit.end });
        setTab("change");
      }
    })();
  };

  const stage = (replacement: string) => {
    if (!doc || !selection) return;
    const text = doc.content.slice(selection.start, selection.end);
    setStaged((s) => [...s, { id: nextId.current++, target: selectorFor(doc.content, selection.start, selection.end), replacement, ...selection, text }]);
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  };

  const apply = async () => {
    if (!doc || staged.length === 0) return;
    setApplying(true);
    const r = await api.apply(doc.id, doc.version, staged.map((s) => ({ operation: "replace" as const, target: s.target, replacement: s.replacement })));
    setApplying(false);
    if (r.ok) {
      setDoc({ ...doc, content: r.data.content, version: r.data.version, contentHash: r.data.afterHash });
      setStaged([]);
      setSelection(null);
      setRedline(false);
      setNotice(`Applied → v${r.data.version} (sha256 ${r.data.afterHash.slice(0, 10)}…)`);
      setRefreshKey((k) => k + 1);
      void refreshDocs();
    } else if (r.error.type === "VERSION_CONFLICT" || r.error.type === "PRECONDITION_FAILED") {
      setConflict({ currentVersion: r.error.details?.currentVersion });
    } else {
      setPreview({ status: "invalid", error: r.error });
    }
  };

  const reload = async () => {
    if (!doc) return;
    const r = await api.get(doc.id);
    if (!r.ok) return setNotice(r.error.error);
    setDoc(r.data); // staged changes are kept; the effect above re-validates them
    setConflict(null);
    setRefreshKey((k) => k + 1);
    void refreshDocs();
  };

  const stageSuggested = (items: Omit<Staged, "id">[]) => {
    setStaged((s) => [...s, ...items.map((i) => ({ ...i, id: nextId.current++ }))]);
    setTab("change");
  };

  // Undo: restore an old version's text as a NEW version (history is only ever appended to).
  const restore = async (toVersion: number) => {
    if (!doc) return;
    const r = await api.revert(doc.id, doc.version, toVersion);
    if (r.ok) {
      if (r.data.changed) {
        setDoc({ ...doc, content: r.data.content, version: r.data.version, contentHash: r.data.afterHash });
        setSelection(null);
        setRedline(false);
        setNotice(`Restored the text of v${toVersion} as v${r.data.version}. Nothing was deleted.`);
        setRefreshKey((k) => k + 1);
        void refreshDocs();
      } else {
        setNotice(`The document already has the text of v${toVersion}; no new version was created.`);
      }
    } else if (r.error.type === "VERSION_CONFLICT" || r.error.type === "PRECONDITION_FAILED") {
      setConflict({ currentVersion: r.error.details?.currentVersion });
      setTab("change");
    } else {
      setNotice(r.error.error);
    }
  };

  const create = async (title: string, content: string) => {
    const r = await api.create(title, content);
    if (!r.ok) return setNotice(r.error.error);
    await refreshDocs();
    await openDoc(r.data.id);
  };

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(t);
  }, [notice]);

  const redlineSpans = redline && preview.status === "valid" ? preview.data.applied : null;

  return (
    <div className="relative grid h-full overflow-hidden grid-cols-[250px_minmax(0,1fr)_380px] max-[1100px]:grid-cols-[200px_minmax(0,1fr)] max-[1100px]:grid-rows-[minmax(0,1fr)_minmax(0,46vh)] max-[640px]:grid-cols-1 max-[640px]:grid-rows-[auto_minmax(0,1fr)_minmax(0,46vh)]">
      <aside className="flex min-h-0 flex-col bg-rail text-white/90 max-[640px]:max-h-40" aria-label="Documents">
        <div className="flex items-center gap-2 px-4 py-4 text-[15px] font-bold tracking-wide">
          <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden><rect width="32" height="32" rx="8" fill="#2a2f3a" /><path d="M9 22V10h9a4 4 0 010 8h-5" fill="none" stroke="#60a5fa" strokeWidth="3" strokeLinecap="round" /></svg>
          CLAUSE
        </div>
        <nav className="min-h-0 flex-1 overflow-y-auto px-2" aria-label="Document list">
          {docs.map((d) => (
            <button
              key={d.id}
              onClick={() => void openDoc(d.id)}
              aria-current={doc?.id === d.id}
              className={`mb-0.5 block w-full rounded-md px-3 py-2 text-left text-[13px] ${doc?.id === d.id ? "bg-rail-hi text-white" : "text-white/70 hover:bg-rail-hi/60"}`}
            >
              <span className="block truncate font-medium">{d.title}</span>
              <span className="text-[11px] text-white/40">v{d.version} · {(d.size / 1024).toFixed(1)} KB</span>
            </button>
          ))}
          {status.kind === "ready" && docs.length === 0 && <p className="px-3 text-[13px] text-white/50">No documents yet. Add one below, or run <code>pnpm seed</code>.</p>}
        </nav>
        <NewDocument onCreate={create} />
      </aside>

      <main className="flex min-h-0 flex-col">
        {status.kind === "error" && <p role="alert" className="m-6 rounded-lg bg-del-bg p-4 text-del">{status.message}</p>}
        {status.kind === "loading" && <p className="m-6 text-muted">Loading…</p>}
        {doc && (
          <>
            <header className="flex items-center gap-3 border-b border-line bg-paper px-6 py-3">
              <h1 className="min-w-0 truncate text-lg font-bold">{doc.title}</h1>
              <span className="rounded bg-accent/10 px-2 py-0.5 text-xs font-semibold text-accent" data-testid="version">v{doc.version}</span>
              <span className="hidden font-mono text-[11px] text-muted sm:inline" title="SHA-256 of the current text">sha256 {doc.contentHash.slice(0, 10)}</span>
              <div className="flex-1" />
              <div role="radiogroup" aria-label="View" className="flex gap-1 rounded-md bg-line/50 p-1 text-xs">
                <button role="radio" aria-checked={!redline} onClick={() => setRedline(false)} className={`rounded px-3 py-1 font-medium ${!redline ? "bg-paper shadow-sm" : "text-muted"}`}>Original</button>
                <button
                  role="radio"
                  aria-checked={redline}
                  disabled={preview.status !== "valid"}
                  title={preview.status === "valid" ? "Show staged changes as a redline" : "Stage a valid change to preview its redline"}
                  onClick={() => setRedline(true)}
                  className={`rounded px-3 py-1 font-medium disabled:opacity-40 ${redline ? "bg-paper shadow-sm" : "text-muted"}`}
                >
                  Redline
                </button>
              </div>
            </header>
            {redlineSpans && (
              <p role="status" className="border-b border-line bg-ins-bg/60 px-6 py-2 text-sm text-ink/80">
                Redline preview of {redlineSpans.length} staged change{redlineSpans.length === 1 ? "" : "s"} — <span className="del px-0.5">removed</span> <span className="ins px-0.5">added</span>. Nothing is saved until you click Apply.
              </p>
            )}
            {notice && <p role="status" className="border-b border-ins/20 bg-ins-bg px-6 py-2 text-sm text-ins">{notice}</p>}
            <div className="relative min-h-0 flex-1 overflow-y-auto bg-canvas">
              <DocPane content={doc.content} hits={hits} selection={selection} redline={redlineSpans} onSelect={(r) => { setSelection(r); setTab("change"); }} />
            </div>
          </>
        )}
      </main>

      <aside className="flex min-h-0 flex-col border-l border-line bg-canvas max-[1100px]:col-span-2 max-[1100px]:border-l-0 max-[1100px]:border-t max-[640px]:col-span-1" aria-label="Inspector">
        <div role="tablist" className="flex border-b border-line bg-paper px-2 text-sm">
          {([["search", "Search"], ["change", `Changes${staged.length ? ` ${staged.length}` : ""}`], ["rules", "Rules"], ["ai", "AI"], ["history", "History"]] as const).map(([k, label]) => (
            <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`border-b-2 px-3 py-2.5 font-medium ${tab === k ? "border-accent text-accent" : "border-transparent text-muted"}`}>
              {label}
            </button>
          ))}
        </div>
        <div className="relative min-h-0 flex-1 overflow-y-auto p-4">
          <div className={tab === "search" ? "h-full" : "hidden"}>
            <SearchPanel refreshKey={refreshKey} onResults={setSearchPage} onOpen={(r) => void openDoc(r.documentId)} onPick={pick} />
          </div>
          {tab === "change" && doc && (
            <ChangePanel
              content={doc.content}
              version={doc.version}
              selection={selection}
              staged={staged}
              preview={preview}
              conflict={conflict}
              applying={applying}
              ci={ci}
              goal={goal}
              onGoal={setGoal}
              onRunCi={() => void runCi()}
              onShowEvidence={showEvidence}
              onStage={stage}
              onRemove={(id) => setStaged((s) => s.filter((x) => x.id !== id))}
              onApply={() => void apply()}
              onReload={() => void reload()}
              onClear={() => setStaged([])}
            />
          )}
          {tab === "rules" && doc && <RequirementsPanel key={doc.id} docId={doc.id} selectedText={selection ? doc.content.slice(selection.start, selection.end) : ""} onChanged={() => setCi({ status: "idle" })} />}
          {tab === "ai" && doc && <SuggestPanel key={doc.id} docId={doc.id} docVersion={doc.version} onStage={stageSuggested} onShowEvidence={showEvidence} />}
          {tab === "history" && doc && <HistoryPanel docId={doc.id} version={doc.version} onRestore={(v) => void restore(v)} />}
        </div>
      </aside>
    </div>
  );
}

function NewDocument({ onCreate }: { onCreate: (title: string, content: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  return (
    <div className="border-t border-white/10 p-3">
      {!open ? (
        <button onClick={() => setOpen(true)} className="w-full rounded-md bg-rail-hi px-3 py-2 text-[13px] font-medium hover:bg-white/10">＋ New document</button>
      ) : (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void onCreate(title.trim(), content).then(() => { setOpen(false); setTitle(""); setContent(""); });
          }}
        >
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" aria-label="New document title" required className="w-full rounded bg-rail-hi px-2 py-1.5 text-[13px] placeholder:text-white/40" />
          <textarea value={content} onChange={(e) => setContent(e.target.value)} placeholder="Paste contract text" aria-label="New document text" rows={5} required className="w-full rounded bg-rail-hi px-2 py-1.5 text-[13px] placeholder:text-white/40" />
          <div className="flex gap-2">
            <button type="submit" className="flex-1 rounded bg-accent px-2 py-1.5 text-[13px] font-semibold">Create</button>
            <button type="button" onClick={() => setOpen(false)} className="rounded px-2 py-1.5 text-[13px] text-white/60">Cancel</button>
          </div>
        </form>
      )}
    </div>
  );
}
