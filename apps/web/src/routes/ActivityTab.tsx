import { ArrowRight, ChevronDown, ChevronUp, Download, FilePlus2, Pencil, Undo2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, type Revision } from "../lib/api.ts";
import { useSettings } from "../lib/settings.tsx";
import { deltaLabel, wordCount } from "../lib/wordDelta.ts";
import { useWorkspace } from "../lib/workspace.tsx";
import { Button } from "../ui/Button.tsx";
import { EmptyState, Pill, Skeleton } from "../ui/bits.tsx";

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

function kindOf(r: Revision): "created" | "restored" | "edited" {
  if (r.summary[0]?.created) return "created";
  if (r.summary[0]?.revertedTo) return "restored";
  return "edited";
}

function Entry({ r, current, docId, version }: { r: Revision; current: boolean; docId: string; version: number }) {
  const ws = useWorkspace();
  const [open, setOpen] = useState(false);
  const kind = kindOf(r);
  const edits = kind === "edited" ? r.summary : [];
  const added = edits.reduce((n, s) => n + wordCount(s.after ?? ""), 0);
  const removed = edits.reduce((n, s) => n + wordCount(s.before ?? ""), 0);
  const Icon = kind === "created" ? FilePlus2 : kind === "restored" ? Undo2 : Pencil;
  const title = kind === "created" ? "Document created" : kind === "restored" ? `Restored the text of v${r.summary[0]?.revertedTo}` : `Edited ${edits.length} passage${edits.length === 1 ? "" : "s"}`;
  const shown = open ? edits : edits.slice(0, 2);

  return (
    <li className="relative flex gap-4 pb-5 last:pb-0">
      <span className="relative z-10 mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-line-strong bg-paper text-muted"><Icon size={15} aria-hidden /></span>
      <div className="min-w-0 flex-1 rounded-card border border-line bg-paper p-3.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h3 className="text-sm font-semibold">{title}</h3>
          <Pill>v{r.version}</Pill>
          {current && <Pill className="bg-accent-soft text-accent">current</Pill>}
          {(added > 0 || removed > 0) && <span className="tnum text-xs text-muted">{[deltaLabel(removed, "-"), deltaLabel(added, "+")].filter(Boolean).join(" ")}</span>}
          <span className="tnum ml-auto text-xs text-muted">{new Date(r.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
        </div>
        {edits.length > 0 && (
          <ul className="mt-2 space-y-1">
            {shown.map((s, i) => (
              <li key={i} className="text-[13px] leading-snug">
                <span className="del px-0.5">{open ? s.before : clip(s.before ?? "", 70)}</span>
                <ArrowRight size={12} className="mx-1.5 inline text-muted" aria-hidden />
                {s.after ? <span className="ins px-0.5">{open ? s.after : clip(s.after, 70)}</span> : <em className="text-muted">deleted</em>}
              </li>
            ))}
          </ul>
        )}
        {edits.length > 2 && (
          <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-accent">
            {open ? <><ChevronUp size={13} aria-hidden />Show less</> : <><ChevronDown size={13} aria-hidden />Show all {edits.length}</>}
          </button>
        )}
        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
          <p className="font-mono text-xs text-muted" title="SHA-256 of this version's text">sha256 {r.contentHash.slice(0, 12)}</p>
          {!current && (
            <span className="flex items-center gap-1.5">
              <a href={`/api/documents/${docId}/export.docx?from=${r.version}&to=${version}`} download aria-label={`Download Word redline since v${r.version}`} title={`Word file showing what changed since v${r.version} as tracked changes`} className="inline-flex h-8 items-center gap-1.5 rounded-control border border-line-strong bg-paper px-2.5 text-[13px] font-semibold hover:bg-canvas"><Download size={13} aria-hidden />.docx</a>
              <Button size="sm" icon={<Undo2 size={13} aria-hidden />} aria-label={`Restore v${r.version}`} title={`Make the text of v${r.version} current again, as a new version. History is kept.`} onClick={() => void ws.restore(r.version)}>Restore</Button>
            </span>
          )}
        </div>
      </div>
    </li>
  );
}

/** Version history as a timeline. Built only from real revisions: CLAUSE CI runs and AI suggestions are not recorded yet. */
export function ActivityTab() {
  const ws = useWorkspace();
  const { settings } = useSettings();
  const doc = ws.doc!;
  const [items, setItems] = useState<Revision[] | null>(null);

  useEffect(() => {
    let live = true;
    void api.revisions(doc.id).then((r) => live && r.ok && setItems([...r.data.items].sort((a, b) => b.version - a.version)));
    return () => { live = false; };
  }, [doc.id, doc.version]);

  const groups = useMemo(() => {
    const out: { day: string; items: Revision[] }[] = [];
    for (const r of items ?? []) {
      const day = settings.dateFormat === "locale" ? new Date(r.createdAt).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }) : new Date(r.createdAt).toLocaleDateString();
      const last = out[out.length - 1];
      if (last?.day === day) last.items.push(r);
      else out.push({ day, items: [r] });
    }
    return out;
  }, [items, settings.dateFormat]);

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-canvas">
      <div className="mx-auto max-w-3xl p-6 max-[640px]:p-3">
        <div className="mb-5">
          <h2 className="font-display text-xl font-semibold">Activity</h2>
          <p className="text-sm text-muted">Every version of this document, newest first. History is append-only: restoring creates a new version and nothing is ever deleted. CLAUSE CI runs and AI suggestions are not recorded here yet.</p>
        </div>
        {items === null && <div className="space-y-3" aria-busy="true"><Skeleton className="h-24 w-full" /><Skeleton className="h-24 w-full" /></div>}
        {items && items.length === 0 && <EmptyState title="No history yet">Versions appear here as the document changes.</EmptyState>}
        {groups.map((g) => (
          <section key={g.day} aria-label={g.day} className="mb-6">
            <h3 className="mb-3 text-xs font-medium text-muted">{g.day}</h3>
            <ol className="relative before:absolute before:bottom-4 before:left-4 before:top-4 before:w-px before:bg-line-strong">
              {g.items.map((r) => <Entry key={r.version} r={r} current={r.version === doc.version} docId={doc.id} version={doc.version} />)}
            </ol>
          </section>
        ))}
      </div>
    </div>
  );
}
