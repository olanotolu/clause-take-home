import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Template, type TemplateCategory } from "../lib/api.ts";
import { useWorkspace } from "../lib/workspace.tsx";
import { navigate } from "../lib/router.ts";
import { Button } from "../ui/Button.tsx";
import { Pill, Skeleton } from "../ui/bits.tsx";
import { Tabs, type TabDef } from "../ui/Tabs.tsx";
import { ArrowRight, FileText, MagnifyingGlass, Sparkles } from "../ui/icons.tsx";

type Category = "All" | TemplateCategory;
type DetailTab = "Preview" | "Clause CI" | "Variables" | "Settings";
const CATEGORIES: Category[] = ["All", "NDA", "Commercial", "Data & Privacy", "Vendor & Services", "Employment"];
const DETAIL_TABS: TabDef<DetailTab>[] = (["Preview", "Clause CI", "Variables", "Settings"] as DetailTab[]).map((id) => ({ id, label: id }));

export function TemplatesView() {
  const ws = useWorkspace();
  const [items, setItems] = useState<Template[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<Category>("All");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<DetailTab>("Preview");
  const [values, setValues] = useState<Record<string, string>>({});
  const [pickedRules, setPickedRules] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState("");
  const detailRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let live = true;
    void api.templates().then((r) => {
      if (!live) return;
      if (r.ok) setItems(r.data.items);
      else setFailed(true);
    });
    return () => { live = false; };
  }, []);

  const matches = useMemo(() => (items ?? []).filter((t) => {
    const q = query.trim().toLowerCase();
    const textHit = !q || `${t.title} ${t.category} ${t.description} ${t.source}`.toLowerCase().includes(q);
    return textHit && (category === "All" || t.category === category);
  }), [items, query, category]);
  const featured = matches.filter((t) => t.featured && !t.id.startsWith("clause-sample-"));
  const selected = matches.find((t) => t.id === selectedId) ?? matches[0] ?? null;

  const [texts, setTexts] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!selected || texts[selected.id] !== undefined) return;
    let live = true;
    void api.template(selected.id).then((r) => { if (live && r.ok) setTexts((t) => ({ ...t, [selected.id]: r.data.content })); });
    return () => { live = false; };
  }, [selected?.id]);
  const text = selected ? texts[selected.id] : undefined;

  useEffect(() => {
    if (!selected) return;
    setValues(Object.fromEntries(selected.variables.map((v) => [v.id, ""])));
    setPickedRules(selected.suggestedRequirements.map((r) => r.id));
    setTitle("");
    setActiveTab("Preview");
  }, [selected?.id]);

  const create = async () => {
    if (!selected || busy) return;
    const missing = selected.variables.filter((v) => v.required && !values[v.id]?.trim());
    if (missing.length) {
      setActiveTab("Variables");
      ws.toast(`Fill in required fields: ${missing.map((v) => v.label).join(", ")}`, "info");
      return;
    }
    setBusy(true);
    const r = await api.createFromTemplate(selected.id, values, pickedRules, title || undefined);
    setBusy(false);
    if (!r.ok) { ws.toast(r.error.error, "fail"); return; }
    await ws.refreshDocs();
    if (r.data.attachmentError) ws.toast(r.data.attachmentError, "info");
    else ws.toast(`Created ${r.data.document.title}; ${r.data.attachedRequirements.length} Clause CI requirements attached.`, "pass");
    navigate({ name: "doc", id: r.data.document.id, tab: "edit" });
  };

  const setField = (id: string, value: string) => setValues((current) => ({ ...current, [id]: value }));
  const fillPlaceholder = (text: string) => text.replace(/\{\{([a-z0-9_]+)\}\}/g, (_match, id: string) => values[id]?.trim() || selected?.variables.find((v) => v.id === id)?.placeholder || `[${id}]`);
  const setTemplate = (t: Template) => {
    setSelectedId(t.id);
    if (window.matchMedia("(max-width: 1279px)").matches) {
      requestAnimationFrame(() => detailRef.current?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" }));
    }
  };

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-canvas">
      <div className="mx-auto max-w-[1500px] space-y-6 p-6 max-[640px]:p-4">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div><p className="mb-1 text-xs font-semibold uppercase tracking-[.12em] text-accent">CLAUSE library</p><h1 className="font-display text-3xl font-semibold tracking-tight">Templates</h1><p className="mt-1 text-sm text-muted">A source-backed starting point for your commercial work.</p></div>
          <div className="flex w-full gap-2 sm:w-auto">
            <label className="relative min-w-0 flex-1 sm:w-[290px]"><span className="sr-only">Search templates</span><MagnifyingGlass size={16} aria-hidden className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search templates…" className="h-10 w-full rounded-control border border-line bg-paper pl-9 pr-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/15" /></label>
            <Button variant="primary" icon={<FileText size={15} aria-hidden />} onClick={() => void create()} loading={busy} disabled={!selected}>Create copy</Button>
          </div>
        </header>

        <div className="flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Template categories">
          {CATEGORIES.map((c) => <button type="button" key={c} role="tab" aria-selected={category === c} onClick={() => setCategory(c)} className={`shrink-0 rounded-full border px-3 py-1.5 text-[13px] transition-colors ${category === c ? "border-accent bg-accent text-accent-ink" : "border-line bg-paper text-muted hover:text-ink"}`}>{c}{items && <span className="ml-1 opacity-70">{c === "All" ? items.length : items.filter((t) => t.category === c).length}</span>}</button>)}
        </div>

        {failed && <p role="alert" className="rounded-control bg-fail-bg px-4 py-3 text-sm text-fail">Could not load templates. Refresh to try again.</p>}
        {!items && !failed && <div className="grid gap-4 md:grid-cols-3"><Skeleton className="h-48" /><Skeleton className="h-48" /><Skeleton className="h-48" /></div>}

        {items && category === "All" && !query && featured.length > 0 && <section aria-labelledby="featured-title">
          <div className="mb-3 flex items-center gap-2"><Sparkles size={17} className="text-accent" aria-hidden /><h2 id="featured-title" className="font-display text-lg font-semibold">Featured</h2><span className="text-xs text-muted">Common starting points for in-house teams</span></div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {featured.slice(0, 4).map((t) => <button type="button" key={t.id} onClick={() => setTemplate(t)} className={`group rounded-card border bg-paper p-4 text-left transition-[border-color,transform,box-shadow] duration-150 hover:-translate-y-0.5 hover:border-accent/50 hover:shadow-sm motion-reduce:transform-none motion-reduce:transition-none ${selected?.id === t.id ? "border-accent ring-1 ring-accent/20" : "border-line"}`}>
              <span className="mb-4 flex h-9 w-9 items-center justify-center rounded-control bg-accent-soft text-accent"><FileText size={18} aria-hidden /></span><Pill>{t.category}</Pill><strong className="mt-2 block font-display text-base font-semibold">{t.title}</strong><span className="mt-1 line-clamp-2 block text-[13px] leading-relaxed text-muted">{t.description}</span><span className="mt-4 flex items-center justify-between text-xs text-muted"><span>{t.source === "CLAUSE sample" ? "CLAUSE sample" : `Version ${t.sourceVersion}`}</span><ArrowRight size={15} className="transition-transform group-hover:translate-x-1 motion-reduce:transform-none" aria-hidden /></span>
            </button>)}
          </div>
        </section>}

        {items && <section aria-labelledby="catalog-title" className="grid min-h-[620px] items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(380px,460px)]">
          <div className="min-w-0 rounded-card border border-line bg-paper">
            <div className="flex items-end justify-between border-b border-line px-4 py-3"><div><h2 id="catalog-title" className="font-display text-lg font-semibold">All templates</h2><p className="text-xs text-muted">{matches.length} templates · filter by category or search</p></div><span className="hidden text-xs text-muted sm:inline">Click a row to preview</span></div>
            {matches.length === 0 ? <div className="p-5 text-sm text-muted">No templates match that search.</div> : <ul className="divide-y divide-line">
              {matches.map((t) => <li key={t.id}><button type="button" onClick={() => setTemplate(t)} aria-current={selected?.id === t.id} className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-canvas ${selected?.id === t.id ? "bg-accent-soft/60" : ""}`}>
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-control border border-line bg-paper text-accent"><FileText size={17} aria-hidden /></span><span className="min-w-0 flex-1"><strong className="block truncate text-sm font-semibold">{t.title}</strong><span className="mt-0.5 block truncate text-xs text-muted">{t.description}</span></span><span className="hidden sm:block"><Pill>{t.category}</Pill></span><span className="hidden w-[110px] shrink-0 text-right text-[11px] text-muted md:block">{t.source === "CLAUSE sample" ? "Sample" : t.sourceVersion}</span>
              </button></li>)}
            </ul>}
          </div>

          {selected && <aside ref={detailRef} aria-label={`${selected.title} template details`} className="min-w-0 scroll-mt-3 overflow-hidden rounded-card border border-line bg-paper xl:sticky xl:top-3">
            <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-4"><div className="min-w-0"><div className="mb-1 flex flex-wrap items-center gap-2"><Pill>{selected.category}</Pill><span className="text-[11px] text-muted">{selected.source} · {selected.sourceVersion}</span></div><h2 className="font-display text-lg font-semibold leading-snug">{selected.title}</h2><p className="mt-1 text-xs leading-relaxed text-muted">{selected.description}</p></div><Button size="sm" variant="primary" onClick={() => void create()} loading={busy}>Create copy</Button></div>
            <Tabs tabs={DETAIL_TABS} value={activeTab} onChange={setActiveTab} label="Template details" idPrefix="template-detail" className="border-b border-line px-2" />
            <div id="template-detail-panel" role="tabpanel" aria-labelledby={`template-detail-${activeTab}`} className="max-h-[min(68vh,680px)] min-h-[360px] overflow-y-auto p-4">
              {activeTab === "Preview" && <div><p className="mb-3 text-xs text-muted">Preview · required fields appear in the Variables tab.</p><pre className="whitespace-pre-wrap font-sans text-[13px] leading-6 text-ink">{text === undefined ? "Loading the template text…" : fillPlaceholder(text.slice(0, 6500))}{(text?.length ?? 0) > 6500 ? "\n\n… Preview shortened. The full source text is included in the created copy." : ""}</pre></div>}
              {activeTab === "Clause CI" && <div><div className="mb-4"><h3 className="font-display font-semibold">Suggested requirements</h3><p className="mt-1 text-xs leading-relaxed text-muted">Review these before creating the copy. Selected items are attached as document requirements; no check runs automatically.</p></div>{selected.suggestedRequirements.length === 0 ? <p className="text-sm text-muted">No suggestions for this sample.</p> : <ul className="space-y-2">{selected.suggestedRequirements.map((r) => <li key={r.id}><label className="flex cursor-pointer gap-3 rounded-control border border-line p-3 hover:bg-canvas"><input type="checkbox" checked={pickedRules.includes(r.id)} onChange={(e) => setPickedRules((current) => e.target.checked ? [...current, r.id] : current.filter((id) => id !== r.id))} className="mt-0.5 accent-[var(--accent)]" /><span><strong className="block text-sm font-medium">{r.title}</strong><span className="mt-1 block text-xs leading-relaxed text-muted">{r.text}</span><span className="mt-2 block text-[10px] uppercase tracking-wide text-muted">{r.kind}</span></span></label></li>)}</ul>}</div>}
              {activeTab === "Variables" && <div><div className="mb-4"><h3 className="font-display font-semibold">Deal details</h3><p className="mt-1 text-xs leading-relaxed text-muted">Required fields are marked. Optional fields retain a visible prompt if left blank.</p></div><label className="mb-4 block"><span className="mb-1 block text-sm font-medium">Document title <span className="text-xs font-normal text-muted">optional</span></span><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={`${selected.title} — Draft`} className="h-9 w-full rounded-control border border-line bg-paper px-3 text-sm outline-none focus:border-accent" /></label>{selected.variables.length === 0 ? <p className="text-sm text-muted">This CLAUSE sample has no fillable fields.</p> : <div className="space-y-3">{selected.variables.map((v) => <label key={v.id} className="block"><span className="mb-1 block text-sm font-medium">{v.label}{v.required ? <span className="ml-1 text-fail">*</span> : <span className="ml-1 text-xs font-normal text-muted">optional</span>}</span><input value={values[v.id] ?? ""} onChange={(e) => setField(v.id, e.target.value)} placeholder={v.placeholder} required={v.required} className="h-9 w-full rounded-control border border-line bg-paper px-3 text-sm outline-none focus:border-accent" /><span className="mt-1 block text-[11px] leading-relaxed text-muted">{v.helpText}</span></label>)}</div>}</div>}
              {activeTab === "Settings" && <div className="space-y-4"><div><h3 className="font-display font-semibold">Source and license</h3><dl className="mt-3 divide-y divide-line rounded-control border border-line">{[["Source", selected.source], ["Attribution", selected.attribution], ["Source version", selected.sourceVersion], ["License", selected.license], ["Jurisdiction", selected.jurisdictionNote]].map(([k, v]) => <div key={k} className="px-3 py-2.5"><dt className="text-[11px] font-medium text-muted">{k}</dt><dd className="mt-0.5 break-words text-xs leading-relaxed">{v}</dd></div>)}</dl>{selected.sourceUrl && <a href={selected.sourceUrl} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-accent underline underline-offset-2">Open published source <ArrowRight size={13} aria-hidden /></a>}</div><p className="rounded-control bg-review-bg px-3 py-2.5 text-xs leading-relaxed text-review">US-first drafting resource. Fill governing law and review state-specific requirements with counsel. This template is an editable starting point, not legal advice.</p></div>}
            </div>
          </aside>}
        </section>}
      </div>
    </div>
  );
}
