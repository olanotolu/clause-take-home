import { Ban, Check, Lock, ShieldCheck, Sparkles, Trash2 } from "../ui/icons.tsx";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, type PlaybookSummary, type Requirement, type RequirementKind } from "../lib/api.ts";
import { navigate } from "../lib/router.ts";
import { plural } from "../lib/wordDelta.ts";
import { useWorkspace } from "../lib/workspace.tsx";
import { Button } from "../ui/Button.tsx";
import { EmptyState } from "../ui/bits.tsx";

const KINDS: { kind: RequirementKind; label: string; hint: string; icon: ReactNode }[] = [
  { kind: "unchanged", label: "Keep verbatim", hint: "This exact passage must survive every edit word for word.", icon: <Lock size={14} aria-hidden /> },
  { kind: "present", label: "Must contain", hint: "This exact text must appear in the document.", icon: <Check size={14} aria-hidden /> },
  { kind: "absent", label: "Must not contain", hint: "This exact text must never appear.", icon: <Ban size={14} aria-hidden /> },
  { kind: "semantic", label: "Statement (AI-judged)", hint: "A plain-language statement that AI judges decide. Advisory only.", icon: <Sparkles size={14} aria-hidden /> },
];
const BY_KIND = Object.fromEntries(KINDS.map((k) => [k.kind, k])) as Record<RequirementKind, (typeof KINDS)[number]>;

interface Props {
  docId: string;
  /** Text currently selected in the document, offered as a one-click starting point. */
  selectedText: string;
  /** Refetch signal: bumped when requirements change anywhere (e.g. the Protect button). */
  reloadKey: number;
  /** Called whenever the saved set changes, so a stale CI report can be dropped. */
  onChanged: () => void;
}

/** Requirements are the document's test suite: saved conditions that every proposed edit is checked against. */
export function RequirementsPanel({ docId, selectedText, reloadKey, onChanged }: Props) {
  const [items, setItems] = useState<Requirement[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [max, setMax] = useState(8);
  const [kind, setKind] = useState<RequirementKind>("unchanged");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ws = useWorkspace();
  const [playbooks, setPlaybooks] = useState<PlaybookSummary[]>([]);
  const [pick, setPick] = useState("");

  useEffect(() => {
    let live = true;
    void api.playbooks().then((r) => live && r.ok && setPlaybooks(r.data.items));
    return () => { live = false; };
  }, []);

  const applyPlaybook = async () => {
    const r = await api.applyPlaybook(docId, pick);
    if (!r.ok) return ws.toast(r.error.error, "fail");
    const { added, skipped } = r.data;
    ws.toast(added.length ? `Added ${plural(added.length, "requirement")}${skipped.length ? `; skipped ${skipped.length} (${skipped.every((x) => x.reason === "duplicate") ? "already there" : "limit reached"})` : ""}.` : `Nothing added: ${skipped.length ? (skipped.every((x) => x.reason === "duplicate") ? "the document already has these rules" : "the document is at its limit") : "the playbook has no rules"}.`, added.length ? "pass" : "info");
    setPick("");
    await load();
    onChanged();
  };

  const load = useCallback(async () => {
    const r = await api.requirements(docId);
    if (r.ok) {
      setItems(r.data.items);
      setMax(r.data.max);
    }
    setLoaded(true);
  }, [docId]);
  useEffect(() => void load(), [load, reloadKey]);

  const add = async () => {
    setError(null);
    setBusy(true);
    const r = await api.addRequirement(docId, kind, text.trim());
    setBusy(false);
    if (!r.ok) return setError(r.error.error);
    setText("");
    await load();
    onChanged();
  };
  const remove = async (id: string) => {
    await api.deleteRequirement(docId, id);
    await load();
    onChanged();
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto">
      <p className="text-[13px] text-muted">Requirements are this document's test suite. CLAUSE CI checks every proposed edit against them and tells you which an edit keeps, breaks, or newly satisfies.</p>

      {playbooks.length > 0 && (
        <section aria-labelledby="req-pb" className="rounded-control border border-line bg-paper p-3">
          <h3 id="req-pb" className="mb-2 text-sm font-semibold">Start from a playbook</h3>
          <div className="flex gap-2">
            <label htmlFor="req-pb-pick" className="sr-only">Playbook</label>
            <select id="req-pb-pick" value={pick} onChange={(e) => setPick(e.target.value)} className="h-9 min-w-0 flex-1 rounded-control border border-line-strong bg-canvas px-2 text-sm">
              <option value="">Choose a playbook</option>
              {playbooks.map((p) => <option key={p.id} value={p.id}>{p.name} ({plural(p.ruleCount, "rule")})</option>)}
            </select>
            <Button size="sm" variant="primary" disabled={!pick} onClick={() => void applyPlaybook()}>Apply</Button>
          </div>
          <button onClick={() => navigate({ name: "playbooks", ...(pick && { id: pick }) })} className="mt-2 text-xs font-medium text-accent underline underline-offset-2">Manage playbooks</button>
        </section>
      )}

      <section aria-labelledby="req-list">
        <h3 id="req-list" className="mb-2 text-sm font-semibold">Requirements <span className="tnum font-normal text-muted">{items.length}/{max}</span></h3>
        {loaded && items.length === 0 && (
          <EmptyState icon={<ShieldCheck size={22} aria-hidden />} title="No requirements yet">Select a clause in the document and choose Protect, or add one below.</EmptyState>
        )}
        <ul className="space-y-1.5">
          {items.map((r) => (
            <li key={r.id} className="flex items-start gap-2 rounded-control border border-line bg-paper px-3 py-2">
              <div className="min-w-0 flex-1">
                <span className="inline-flex items-center gap-1 text-xs font-medium text-muted">{BY_KIND[r.kind].icon}{BY_KIND[r.kind].label}</span>
                <p className="doc !text-[14px] !leading-snug">{r.text.length > 160 ? `${r.text.slice(0, 160)}…` : r.text}</p>
              </div>
              <button onClick={() => void remove(r.id)} aria-label={`Delete requirement: ${r.text.slice(0, 40)}`} className="mt-0.5 shrink-0 rounded p-1 text-muted hover:bg-line/70 hover:text-fail"><Trash2 size={14} aria-hidden /></button>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="req-add" className="rounded-control border border-line bg-paper p-3">
        <h3 id="req-add" className="mb-2 text-sm font-semibold">Add a requirement</h3>
        <label htmlFor="req-kind" className="sr-only">Kind</label>
        <select id="req-kind" value={kind} onChange={(e) => setKind(e.target.value as RequirementKind)} className="h-9 w-full rounded-control border border-line-strong bg-canvas px-2 text-sm">
          {KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
        </select>
        <p className="mt-1 text-xs text-muted">{BY_KIND[kind].hint}</p>
        <label htmlFor="req-text" className="sr-only">Requirement text</label>
        <textarea id="req-text" value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder={kind === "semantic" ? "e.g. Disclosure required by law is permitted" : "Exact text"} className="mt-2 w-full rounded-control border border-line-strong bg-canvas px-3 py-2 font-doc text-[14px]" />
        <div className="mt-2 flex gap-2">
          <Button size="sm" disabled={!selectedText} onClick={() => setText(selectedText)} aria-label="Use selected text" title="Copy the passage currently selected in the document">Use selection</Button>
          <Button size="sm" variant="primary" className="flex-1" loading={busy} disabled={!text.trim() || items.length >= max} onClick={() => void add()}>Add</Button>
        </div>
        {error && <p role="alert" className="mt-2 text-[13px] text-fail">{error}</p>}
      </section>
    </div>
  );
}
