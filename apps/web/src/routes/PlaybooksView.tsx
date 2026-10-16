import { Ban, BookOpenCheck, Check, Lock, Plus, Sparkles, Trash2 } from "../ui/icons.tsx";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, type ApplyResult, type PlaybookDetail, type PlaybookSummary, type RequirementKind } from "../lib/api.ts";
import { navigate } from "../lib/router.ts";
import { plural } from "../lib/wordDelta.ts";
import { useWorkspace } from "../lib/workspace.tsx";
import { Button } from "../ui/Button.tsx";
import { EmptyState, Skeleton } from "../ui/bits.tsx";

const KIND: Record<RequirementKind, { label: string; icon: ReactNode }> = {
  unchanged: { label: "Keep verbatim", icon: <Lock size={13} aria-hidden /> },
  present: { label: "Must contain", icon: <Check size={13} aria-hidden /> },
  absent: { label: "Must not contain", icon: <Ban size={13} aria-hidden /> },
  semantic: { label: "Statement (AI-judged)", icon: <Sparkles size={13} aria-hidden /> },
};
const field = "h-9 w-full rounded-control border border-line-strong bg-paper px-2.5 text-sm";

/** Playbooks: named sets of rules that become requirements on any document you apply them to. */
export function PlaybooksView({ id }: { id: string | undefined }) {
  const ws = useWorkspace();
  const [list, setList] = useState<PlaybookSummary[] | null>(null);
  const [detail, setDetail] = useState<PlaybookDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState(false);

  const loadList = useCallback(async () => {
    const r = await api.playbooks();
    if (r.ok) setList(r.data.items);
    else ws.toast(r.error.error, "fail");
  }, [ws]);
  useEffect(() => void loadList(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedId = id ?? list?.[0]?.id ?? null;
  const loadDetail = useCallback(async (pid: string) => {
    const r = await api.playbook(pid);
    if (r.ok) setDetail(r.data);
    else {
      setDetail(null);
      ws.toast(r.error.error, "fail");
    }
    setLoadingDetail(false);
  }, [ws]);
  useEffect(() => {
    if (!selectedId) return setDetail(null);
    setLoadingDetail(true);
    void loadDetail(selectedId);
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async () => {
    const r = await api.createPlaybook(newName.trim(), "");
    if (!r.ok) return ws.toast(r.error.error, "fail");
    setNewName("");
    setAdding(false);
    await loadList();
    navigate({ name: "playbooks", id: r.data.id });
  };

  return (
    <div className="grid h-full min-h-0 grid-cols-[300px_minmax(0,1fr)] max-[899px]:grid-cols-1 max-[899px]:overflow-y-auto">
      <aside aria-label="Playbooks" className={`flex min-h-0 flex-col border-r border-line bg-canvas max-[899px]:border-b max-[899px]:border-r-0 ${id ? "max-[899px]:hidden" : ""}`}>
        <div className="flex items-center justify-between px-5 pb-2 pt-6">
          <h1 className="font-display text-2xl">Playbooks</h1>
          <Button size="sm" icon={<Plus size={14} aria-hidden />} onClick={() => setAdding(true)}>New</Button>
        </div>
        {adding && (
          <form className="mx-4 mb-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); void create(); }}>
            {/* biome-ignore lint/a11y/noAutofocus: the field appears because the user just chose "new playbook", so focus belongs there */}
            <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={120} placeholder="Playbook name" aria-label="Playbook name" className={field} />
            <Button type="submit" variant="primary" size="sm" disabled={!newName.trim()}>Create</Button>
          </form>
        )}
        <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3 pb-4">
          {list === null && [0, 1, 2].map((i) => <li key={i}><Skeleton className="h-16 w-full" /></li>)}
          {list?.map((p) => (
            <li key={p.id}>
              <button type="button" onClick={() => navigate({ name: "playbooks", id: p.id })} aria-current={selectedId === p.id} className={`w-full rounded-control border px-3.5 py-3 text-left transition-colors ${selectedId === p.id ? "border-accent bg-accent-soft" : "border-line bg-paper hover:bg-canvas"}`}>
                <span className="font-display block text-[15px] font-semibold leading-snug">{p.name}</span>
                {p.description && <span className="mt-0.5 line-clamp-2 block text-xs text-muted">{p.description}</span>}
                <span className="tnum mt-1 block text-xs text-muted">{plural(p.ruleCount, "rule")}</span>
              </button>
            </li>
          ))}
          {list?.length === 0 && <li><EmptyState icon={<BookOpenCheck size={24} aria-hidden />} title="No playbooks yet">Create one, then add the rules your documents should always satisfy.</EmptyState></li>}
        </ul>
      </aside>

      <div className={`min-h-0 min-w-0 overflow-y-auto ${id ? "" : "max-[899px]:hidden"}`}>
        {id && <div className="hidden max-[899px]:block border-b border-line bg-paper px-4 py-2"><button type="button" onClick={() => navigate({ name: "playbooks" })} className="h-10 text-sm font-medium text-accent">← All playbooks</button></div>}
        {loadingDetail && !detail && <div className="space-y-3 p-8"><Skeleton className="h-8 w-64" /><Skeleton className="h-24 w-full" /></div>}
        {!selectedId && list && list.length === 0 && <EmptyState icon={<BookOpenCheck size={26} aria-hidden />} title="Select or create a playbook" />}
        {detail && selectedId === detail.id && <PlaybookEditor key={detail.id} pb={detail} onChanged={() => { void loadDetail(detail.id); void loadList(); }} onDeleted={() => { void loadList(); navigate({ name: "playbooks" }); }} />}
      </div>
    </div>
  );
}

function PlaybookEditor({ pb, onChanged, onDeleted }: { pb: PlaybookDetail; onChanged: () => void; onDeleted: () => void }) {
  const ws = useWorkspace();
  const [name, setName] = useState(pb.name);
  const [description, setDescription] = useState(pb.description);
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<RequirementKind>("semantic");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState("");
  const [applied, setApplied] = useState<{ doc: string; result: ApplyResult } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const dirty = name.trim() !== pb.name || description.trim() !== pb.description;

  const save = async () => {
    const r = await api.patchPlaybook(pb.id, { name: name.trim(), description: description.trim() });
    if (!r.ok) return ws.toast(r.error.error, "fail");
    onChanged();
  };
  const addRule = async () => {
    setBusy(true);
    const r = await api.addRule(pb.id, { title: title.trim(), kind, text });
    setBusy(false);
    if (!r.ok) return ws.toast(r.error.error, "fail");
    setTitle("");
    setText("");
    onChanged();
  };
  const apply = async () => {
    const r = await api.applyPlaybook(target, pb.id);
    if (!r.ok) return ws.toast(r.error.error, "fail");
    setApplied({ doc: ws.docs.find((d) => d.id === target)?.title ?? target, result: r.data });
    ws.bumpRules();
  };

  return (
    <div className="mx-auto grid max-w-5xl gap-8 p-8 max-[640px]:p-4 min-[1180px]:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0 space-y-6">
        <header className="space-y-2">
          <label className="block text-xs font-medium text-muted" htmlFor="pb-name">Name</label>
          <input id="pb-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} className="font-display h-11 w-full rounded-control border border-transparent bg-transparent px-2 text-2xl font-semibold hover:border-line-strong focus:border-line-strong" />
          <label className="block text-xs font-medium text-muted" htmlFor="pb-desc">Description</label>
          <textarea id="pb-desc" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} rows={2} placeholder="What is this playbook for?" className="w-full rounded-control border border-transparent bg-transparent px-2 py-1.5 text-sm hover:border-line-strong focus:border-line-strong" />
          {dirty && <div className="flex gap-2"><Button size="sm" variant="primary" disabled={!name.trim()} onClick={() => void save()}>Save changes</Button><Button size="sm" variant="ghost" onClick={() => { setName(pb.name); setDescription(pb.description); }}>Discard</Button></div>}
        </header>

        <section aria-labelledby="pb-rules">
          <h2 id="pb-rules" className="mb-2 text-sm font-semibold">Rules <span className="tnum font-normal text-muted">{pb.rules.length}</span></h2>
          {pb.rules.length === 0 && <p className="text-[13px] text-muted">No rules yet. Add the first one below.</p>}
          <ul className="space-y-2">
            {pb.rules.map((r) => (
              <li key={r.id} className="flex items-start gap-3 rounded-control border border-line bg-paper px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-xs text-muted"><span className="inline-flex items-center gap-1 font-medium">{KIND[r.kind].icon}{KIND[r.kind].label}</span></p>
                  <h3 className="font-display mt-0.5 text-[15px] font-semibold leading-snug">{r.title}</h3>
                  <p className="mt-1 text-[13px] leading-snug text-ink/80">{r.text}</p>
                </div>
                <button type="button" onClick={async () => { const x = await api.deleteRule(pb.id, r.id); if (x.ok) onChanged(); else ws.toast(x.error.error, "fail"); }} aria-label={`Delete rule: ${r.title}`} className="mt-0.5 shrink-0 rounded p-1.5 text-muted hover:bg-line/70 hover:text-fail"><Trash2 size={14} aria-hidden /></button>
              </li>
            ))}
          </ul>

          <form className="mt-4 space-y-2 rounded-control border border-line bg-paper p-4" onSubmit={(e) => { e.preventDefault(); void addRule(); }}>
            <h3 className="text-sm font-semibold">Add a rule</h3>
            <div className="grid gap-2 min-[560px]:grid-cols-[1fr_200px]">
              <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} placeholder="Short title, e.g. Compelled-disclosure exception" aria-label="Rule title" className={field} />
              <select value={kind} onChange={(e) => setKind(e.target.value as RequirementKind)} aria-label="Rule kind" className={field}>
                {(Object.keys(KIND) as RequirementKind[]).map((k) => <option key={k} value={k}>{KIND[k].label}</option>)}
              </select>
            </div>
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={2000} placeholder={kind === "semantic" ? "A plain-language statement the document should satisfy" : "Exact text"} aria-label="Rule text" className="w-full rounded-control border border-line-strong bg-paper px-3 py-2 text-sm" />
            <div className="flex justify-end"><Button type="submit" variant="primary" size="sm" loading={busy} disabled={!title.trim() || !text.trim()}>Add rule</Button></div>
          </form>
        </section>
      </div>

      <aside aria-label="Apply" className="space-y-3 min-[1180px]:sticky min-[1180px]:top-0 min-[1180px]:self-start">
        <section className="rounded-card border border-line bg-paper p-4">
          <h2 className="text-sm font-semibold">Apply to a document</h2>
          <p className="mt-1 text-xs text-muted">Copies these rules onto the document as requirements. Rules it already has are skipped, and a document holds at most 8.</p>
          <label className="mt-3 block text-xs font-medium text-muted" htmlFor="pb-target">Document</label>
          <select id="pb-target" value={target} onChange={(e) => { setTarget(e.target.value); setApplied(null); }} className={`${field} mt-1`}>
            <option value="">Choose a document</option>
            {ws.docs.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}
          </select>
          <Button variant="primary" className="mt-3 w-full" disabled={!target || pb.rules.length === 0} onClick={() => void apply()}>Apply playbook</Button>
          {applied && (
            <div role="status" className="mt-3 space-y-1.5 text-[13px]">
              <p><strong className="font-semibold">{applied.result.added.length === 0 ? "Nothing added" : `Added ${plural(applied.result.added.length, "requirement")}`}</strong> to {applied.doc}.</p>
              {applied.result.skipped.length > 0 && (
                <ul className="space-y-0.5 text-muted">{applied.result.skipped.map((s) => <li key={s.title}>Skipped “{s.title}”: {s.reason === "duplicate" ? "already a requirement" : "the document is at its limit"}</li>)}</ul>
              )}
              <button type="button" className="font-medium text-accent underline underline-offset-2" onClick={() => navigate({ name: "doc", id: target, tab: "ci" })}>Open Clause CI for this document</button>
            </div>
          )}
        </section>
        <section className="rounded-card border border-line bg-paper p-4">
          <h2 className="text-sm font-semibold">Delete playbook</h2>
          <p className="mt-1 text-xs text-muted">Documents keep any requirements they already got from it.</p>
          {confirmDelete ? (
            <Button variant="danger" className="mt-2" onClick={async () => { const r = await api.deletePlaybook(pb.id); if (r.ok) onDeleted(); else ws.toast(r.error.error, "fail"); }}>Confirm delete</Button>
          ) : (
            <Button className="mt-2" icon={<Trash2 size={14} aria-hidden />} onClick={() => setConfirmDelete(true)}>Delete…</Button>
          )}
        </section>
      </aside>
    </div>
  );
}
