import { useEffect, useRef, useState } from "react";
import { PRIORITIES, REQUEST_STATUSES, REQUEST_TYPES, type Priority, type RequestStatus, type RequestType } from "../lib/api.ts";
import { navigate } from "../lib/router.ts";
import { PRIORITY_LABEL, STATUS_LABEL, typeFromTitle } from "../lib/requests.ts";
import { useWorkspace } from "../lib/workspace.tsx";
import { Button } from "../ui/Button.tsx";

const field = "mt-1 h-10 w-full rounded-control border border-line-strong bg-canvas px-3 text-sm font-normal";

export function RequestDialog() {
  const ws = useWorkspace();
  const { open, status: presetStatus, documentId: presetDoc } = ws.newRequest;
  const ref = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [documentId, setDocumentId] = useState("");
  const [type, setType] = useState<RequestType>("Other");
  const [typeTouched, setTypeTouched] = useState(false);
  const [priority, setPriority] = useState<Priority>("medium");
  const [status, setStatus] = useState<RequestStatus>("inbox");
  const [dueDate, setDueDate] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setTitle("");
      setGoal("");
      setDocumentId(presetDoc ?? "");
      setType(presetDoc ? typeFromTitle(ws.docs.find((x) => x.id === presetDoc)?.title ?? "") : "Other");
      setTypeTouched(false);
      setPriority("medium");
      setStatus(presetStatus ?? "inbox");
      setDueDate("");
      d.showModal();
    } else if (!open && d.open) d.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const close = () => ws.setNewRequest({ open: false });

  const submit = async () => {
    setBusy(true);
    const r = await ws.createRequest({ ...(documentId && { documentId }), title: title.trim(), goal: goal.trim(), status, priority, type, dueDate: dueDate || null });
    setBusy(false);
    if (r) {
      close();
      navigate({ name: "home", request: r.id });
    }
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: a backdrop click is a pointer shortcut; Esc already closes a native dialog
    <dialog ref={ref} onClose={close} onClick={(e) => { if (e.target === ref.current) close(); }} aria-labelledby="newreq-h" className="m-auto w-[min(560px,calc(100vw-24px))] rounded-2xl border border-line-strong bg-paper p-0 text-ink shadow-lift backdrop:bg-black/40">
      <form className="space-y-4 p-5" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <div>
          <h2 id="newreq-h" className="font-display text-xl font-semibold">New request</h2>
          <p className="text-sm text-muted">A request tracks one piece of legal work on a document. Nothing is edited until you open the document.</p>
        </div>
        <label className="block text-sm font-medium">Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} placeholder="e.g. Mutual confidentiality for Acme" className={field} />
        </label>
        <label className="block text-sm font-medium">Requested outcome
          <textarea value={goal} onChange={(e) => setGoal(e.target.value)} required maxLength={500} rows={3} placeholder="Make the confidentiality obligations mutual and keep the existing exceptions." className="mt-1 w-full rounded-control border border-line-strong bg-canvas px-3 py-2 text-sm font-normal" />
          <span className="mt-0.5 block text-xs font-normal text-muted">Clause CI also judges this sentence against the document, so write it as something that should be true.</span>
        </label>
        <label className="block text-sm font-medium">Document
          <select value={documentId} onChange={(e) => { setDocumentId(e.target.value); if (!typeTouched) setType(typeFromTitle(ws.docs.find((x) => x.id === e.target.value)?.title ?? "")); }} className={field}>
            <option value="">No document yet</option>
            {ws.docs.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-3 max-[480px]:grid-cols-1">
          <label className="block text-sm font-medium">Type
            <select value={type} onChange={(e) => { setType(e.target.value as RequestType); setTypeTouched(true); }} className={field}>{REQUEST_TYPES.map((t) => <option key={t}>{t}</option>)}</select>
          </label>
          <label className="block text-sm font-medium">Priority
            <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)} className={field}>{PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}</select>
          </label>
          <label className="block text-sm font-medium">Status
            <select value={status} onChange={(e) => setStatus(e.target.value as RequestStatus)} className={field}>{REQUEST_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}</select>
          </label>
          <label className="block text-sm font-medium">Due date (optional)
            <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={field} />
          </label>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="primary" type="submit" loading={busy} disabled={!title.trim() || !goal.trim()}>Create request</Button>
        </div>
      </form>
    </dialog>
  );
}
