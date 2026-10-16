import { useCallback, useEffect, useState } from "react";
import { api, type Requirement, type RequirementKind } from "../lib/api.ts";

const KINDS: { kind: RequirementKind; label: string; hint: string }[] = [
  { kind: "unchanged", label: "Keep verbatim", hint: "This exact passage must survive every edit word for word." },
  { kind: "present", label: "Must contain", hint: "This exact text must appear in the document." },
  { kind: "absent", label: "Must not contain", hint: "This exact text must never appear." },
  { kind: "semantic", label: "Statement (AI-judged)", hint: "A plain-language statement that AI judges decide. Advisory only." },
];
const LABEL = Object.fromEntries(KINDS.map((k) => [k.kind, k.label])) as Record<RequirementKind, string>;

interface Props {
  docId: string;
  /** Text currently selected in the document, offered as a one-click starting point. */
  selectedText: string;
  /** Called whenever the saved set changes, so a stale CI report can be dropped. */
  onChanged: () => void;
}

/** Requirements are the document's test suite: saved conditions that every proposed edit is checked against. */
export function RequirementsPanel({ docId, selectedText, onChanged }: Props) {
  const [items, setItems] = useState<Requirement[]>([]);
  const [max, setMax] = useState(8);
  const [kind, setKind] = useState<RequirementKind>("unchanged");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await api.requirements(docId);
    if (r.ok) {
      setItems(r.data.items);
      setMax(r.data.max);
    }
  }, [docId]);
  useEffect(() => void load(), [load]);

  const add = async () => {
    setError(null);
    const r = await api.addRequirement(docId, kind, text.trim());
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

  const hint = KINDS.find((k) => k.kind === kind)!.hint;
  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto">
      <p className="text-[13px] text-ink/80">
        Requirements are this document's test suite. Run <strong>CLAUSE CI</strong> on a staged change to see which ones the edit keeps, breaks, or newly satisfies.
      </p>

      <section aria-labelledby="req-add" className="rounded-lg border border-line bg-paper p-3">
        <h3 id="req-add" className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Add a requirement</h3>
        <label htmlFor="req-kind" className="sr-only">Kind</label>
        <select id="req-kind" value={kind} onChange={(e) => setKind(e.target.value as RequirementKind)} className="w-full rounded-md border border-line bg-canvas px-2 py-2 text-sm">
          {KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
        </select>
        <p className="mt-1 text-[12px] text-muted">{hint}</p>
        <label htmlFor="req-text" className="sr-only">Requirement text</label>
        <textarea id="req-text" value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder={kind === "semantic" ? "e.g. Disclosure required by law is permitted" : "Exact text"} className="mt-2 w-full rounded-md border border-line bg-canvas px-3 py-2 font-doc text-[14px]" />
        <div className="mt-2 flex gap-2">
          <button disabled={!selectedText} onClick={() => setText(selectedText)} aria-label="Use selected text" title="Copy the passage currently selected in the document" className="rounded-md border border-line px-3 py-1.5 text-xs font-semibold disabled:opacity-40">
            Use selected text
          </button>
          <button disabled={!text.trim() || items.length >= max} onClick={() => void add()} className="flex-1 rounded-md bg-ink px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-30">Add</button>
        </div>
        {error && <p role="alert" className="mt-2 text-[13px] text-del">{error}</p>}
      </section>

      <section aria-labelledby="req-list">
        <h3 id="req-list" className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Requirements ({items.length}/{max})</h3>
        {items.length === 0 && <p className="text-sm text-muted">None yet. A good first one: select a clause in the document, open this tab, and choose "Keep verbatim".</p>}
        <ul className="space-y-2">
          {items.map((r) => (
            <li key={r.id} className="flex items-start gap-2 rounded-lg border border-line bg-paper p-3 text-sm">
              <div className="min-w-0 flex-1">
                <span className="rounded bg-canvas px-1.5 py-0.5 text-[11px] font-semibold text-muted">{LABEL[r.kind]}</span>
                <p className="doc mt-1 !text-[14px] !leading-snug">{r.text.length > 160 ? `${r.text.slice(0, 160)}…` : r.text}</p>
              </div>
              <button onClick={() => void remove(r.id)} aria-label={`Delete requirement: ${r.text.slice(0, 40)}`} className="shrink-0 text-muted hover:text-del">✕</button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
