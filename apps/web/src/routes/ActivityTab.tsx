import { useEffect, useMemo, useState } from "react";
import { api, type Revision } from "../lib/api.ts";
import { useSettings } from "../lib/settings.tsx";
import { ActivityEntry } from "../components/ActivityEntry.tsx";
import { useWorkspace } from "../lib/workspace.tsx";
import { EmptyState, Skeleton } from "../ui/bits.tsx";

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
          <h2 className="font-display text-lg">Activity</h2>
          <p className="text-[13px] text-muted">Newest first. Restoring makes a new version; nothing is deleted. CI runs and AI suggestions are not recorded.</p>
        </div>
        {items === null && <div className="space-y-3" aria-busy="true"><Skeleton className="h-24 w-full" /><Skeleton className="h-24 w-full" /></div>}
        {items && items.length === 0 && <EmptyState title="No history yet">Versions appear here as the document changes.</EmptyState>}
        {groups.map((g) => (
          <section key={g.day} aria-label={g.day} className="mb-6">
            <h3 className="mb-3 text-xs font-medium text-muted">{g.day}</h3>
            <ol className="relative before:absolute before:bottom-4 before:left-4 before:top-4 before:w-px before:bg-line-strong">
              {g.items.map((r) => <ActivityEntry key={r.version} r={r} current={r.version === doc.version} docId={doc.id} currentVersion={doc.version} onRestore={(v) => void ws.restore(v)} />)}
            </ol>
          </section>
        ))}
      </div>
    </div>
  );
}
