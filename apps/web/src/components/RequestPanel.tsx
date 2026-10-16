import { AlertTriangle, CalendarDays, CheckCircle2, CircleSlash, FileText, Pencil, Play, Trash2, X, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { api, PRIORITIES, REQUEST_STATUSES, REQUEST_TYPES, type Priority, type Requirement, type RequestStatus, type RequestType, type Verdict, type WorkRequest } from "../lib/api.ts";
import { dueLabel, PRIORITY_LABEL, STATUS_LABEL } from "../lib/requests.ts";
import { navigate } from "../lib/router.ts";
import { ago, kb } from "../lib/wordDelta.ts";
import { useWorkspace } from "../lib/workspace.tsx";
import { Button } from "../ui/Button.tsx";
import { StatusPill, type Tone } from "../ui/bits.tsx";

const STATUS_TONE: Record<RequestStatus, Tone> = { inbox: "neutral", in_progress: "info", needs_review: "review", completed: "pass" };
const sel = "h-9 w-full rounded-control border border-line-strong bg-paper px-2.5 text-sm";

function VerdictIcon({ v }: { v: Verdict | null }) {
  if (v === "PASS") return <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-pass" aria-label="Holds" />;
  if (v === "FAIL") return <XCircle size={16} className="mt-0.5 shrink-0 text-fail" aria-label="Fails" />;
  if (v === "NEEDS_REVIEW") return <AlertTriangle size={16} className="mt-0.5 shrink-0 text-review" aria-label="Needs review" />;
  return <CircleSlash size={16} className="mt-0.5 shrink-0 text-muted" aria-label="Not checked" />;
}

/** One request, with everything you need to act on it. Details are saved as you change them. */
export function RequestPanel({ request, onClose }: { request: WorkRequest; onClose: () => void }) {
  const ws = useWorkspace();
  const doc = ws.docs.find((d) => d.id === request.documentId) ?? null;
  const [rules, setRules] = useState<Requirement[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [goal, setGoal] = useState(request.goal);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setGoal(request.goal);
    setEditing(false);
    setConfirmDelete(false);
  }, [request.id, request.goal]);

  useEffect(() => {
    let live = true;
    setRules(null);
    if (request.documentId) void api.requirements(request.documentId).then((r) => live && setRules(r.ok ? r.data.items : []));
    else setRules([]);
    return () => { live = false; };
  }, [request.documentId, request.ci?.checkedAt, ws.rulesKey]);

  const due = dueLabel(request.dueDate, request.status);
  const verdictOf = (text: string): Verdict | null => request.ci?.requirements.find((r) => r.text === text || r.text === `${text.slice(0, 300)}…`)?.verdict ?? null;
  const checking = ws.checkingRequest === request.id;

  return (
    <aside aria-label="Request details" className="flex min-h-0 flex-col border-l border-line bg-paper max-[1279px]:fixed max-[1279px]:inset-y-0 max-[1279px]:right-0 max-[1279px]:z-30 max-[1279px]:w-[min(440px,100vw)] max-[1279px]:shadow-lift">
      <header className="flex items-start gap-3 border-b border-line px-5 py-4">
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-xl font-semibold leading-snug">{request.title}</h2>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
            <StatusPill tone={STATUS_TONE[request.status]} icon={false}>{STATUS_LABEL[request.status]}</StatusPill>
            <span className="tnum">Created {ago(request.createdAt)}</span>
          </p>
        </div>
        <button onClick={onClose} aria-label="Close request" className="rounded-control p-1.5 text-muted hover:bg-line/70 hover:text-ink"><X size={18} aria-hidden /></button>
      </header>

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5">
        <section aria-labelledby="req-outcome">
          <div className="mb-1.5 flex items-center justify-between">
            <h3 id="req-outcome" className="text-sm font-semibold">Requested outcome</h3>
            {!editing && <Button size="sm" variant="ghost" icon={<Pencil size={13} aria-hidden />} onClick={() => setEditing(true)}>Edit</Button>}
          </div>
          {editing ? (
            <div>
              <textarea value={goal} onChange={(e) => setGoal(e.target.value)} rows={4} maxLength={500} aria-label="Requested outcome" className="w-full rounded-control border border-line-strong bg-canvas px-3 py-2 text-sm" />
              <div className="mt-2 flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => { setGoal(request.goal); setEditing(false); }}>Cancel</Button>
                <Button size="sm" variant="primary" disabled={!goal.trim() || goal.trim() === request.goal} onClick={() => { void ws.patchRequest(request.id, { goal: goal.trim() }); setEditing(false); }}>Save</Button>
              </div>
            </div>
          ) : (
            <p className="rounded-control bg-canvas px-3 py-2.5 text-sm leading-relaxed">{request.goal}</p>
          )}
        </section>

        <section aria-label="Details" className="grid grid-cols-2 gap-3">
          <label className="text-xs font-medium text-muted">Status
            <select value={request.status} onChange={(e) => void ws.patchRequest(request.id, { status: e.target.value as RequestStatus })} className={`${sel} mt-1 text-ink`}>{REQUEST_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}</select>
          </label>
          <label className="text-xs font-medium text-muted">Priority
            <select value={request.priority} onChange={(e) => void ws.patchRequest(request.id, { priority: e.target.value as Priority })} className={`${sel} mt-1 text-ink`}>{PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}</select>
          </label>
          <label className="text-xs font-medium text-muted">Type
            <select value={request.type} onChange={(e) => void ws.patchRequest(request.id, { type: e.target.value as RequestType })} className={`${sel} mt-1 text-ink`}>{REQUEST_TYPES.map((t) => <option key={t}>{t}</option>)}</select>
          </label>
          <label className="text-xs font-medium text-muted">Due date
            <input type="date" value={request.dueDate ?? ""} onChange={(e) => void ws.patchRequest(request.id, { dueDate: e.target.value || null })} className={`${sel} mt-1 text-ink`} />
          </label>
          {due && <p className={`col-span-2 flex items-center gap-1.5 text-xs ${due.overdue ? "font-semibold text-fail" : "text-muted"}`}><CalendarDays size={13} aria-hidden />{due.text}</p>}
        </section>

        <section aria-labelledby="req-reqs">
          <h3 id="req-reqs" className="text-sm font-semibold">Requirements</h3>
          <p className="mb-2 text-xs text-muted">
            {request.ci ? `Checked against v${request.ci.version} · ${ago(request.ci.checkedAt)} · ${request.ci.attention === 0 ? "all hold" : `${request.ci.attention} need attention`}` : "Not checked yet. Run Clause CI to audit the current text."}
          </p>
          {rules === null ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : rules.length === 0 && !request.ci?.goal ? (
            <p className="rounded-control border border-dashed border-line-strong px-3 py-3 text-sm text-muted">{request.documentId ? "This document has no requirements. Add them in its Rules tab, or apply a playbook." : "No document is linked."}</p>
          ) : (
            <ul className="space-y-1.5">
              {request.ci?.goal && (
                <li className="flex items-start gap-2.5 rounded-control border border-line px-3 py-2 text-sm"><VerdictIcon v={request.ci.goal} /><span className="min-w-0"><span className="text-xs font-medium text-muted">Requested outcome · {request.ci.goal === "PASS" ? "already true in the current text" : request.ci.goal === "FAIL" ? "not true yet" : request.ci.goal === "NEEDS_REVIEW" ? "a judge was unsure" : "not judged (no AI judge)"}</span><br />{request.goal}</span></li>
              )}
              {rules.map((r) => (
                <li key={r.id} className="flex items-start gap-2.5 rounded-control border border-line px-3 py-2 text-sm"><VerdictIcon v={verdictOf(r.text)} /><span className="min-w-0 break-words">{r.text.length > 140 ? `${r.text.slice(0, 140)}…` : r.text}</span></li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="req-doc">
          <h3 id="req-doc" className="mb-1.5 text-sm font-semibold">Linked document</h3>
          {doc ? (
            <button onClick={() => navigate({ name: "doc", id: doc.id, tab: "edit" })} className="flex w-full items-center gap-3 rounded-control border border-line px-3 py-2.5 text-left hover:bg-canvas">
              <FileText size={18} className="shrink-0 text-muted" aria-hidden />
              <span className="min-w-0 flex-1"><span className="font-display block truncate text-[15px] font-semibold">{doc.title}</span><span className="tnum text-xs text-muted">v{doc.version} · {kb(doc.size)}</span></span>
            </button>
          ) : (
            <p className="rounded-control border border-dashed border-line-strong px-3 py-3 text-sm text-muted">{request.documentId ? "Loading…" : "No document is linked (it may have been deleted)."}</p>
          )}
        </section>
      </div>

      <footer className="space-y-2 border-t border-line px-5 py-4">
        <Button variant="primary" className="w-full" disabled={!doc} onClick={() => doc && navigate({ name: "doc", id: doc.id, tab: "edit" })}>Open in editor</Button>
        <div className="flex gap-2">
          <Button className="flex-1" icon={<Play size={14} aria-hidden />} loading={checking} disabled={!doc} onClick={() => void ws.checkRequest(request.id)} title="Audit the document's current text against its requirements and this request's outcome">Run Clause CI</Button>
          {confirmDelete ? (
            <Button variant="danger" onClick={() => { void ws.removeRequest(request.id); onClose(); }}>Confirm delete</Button>
          ) : (
            <Button variant="ghost" aria-label="Delete request" icon={<Trash2 size={15} aria-hidden />} onClick={() => setConfirmDelete(true)} title="Deletes this request only; the document is untouched" />
          )}
        </div>
      </footer>
    </aside>
  );
}
