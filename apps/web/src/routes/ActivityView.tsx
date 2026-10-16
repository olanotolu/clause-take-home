import { useEffect, useMemo, useState } from "react";
import { ActivityEntry, kindOf } from "../components/ActivityEntry.tsx";
import { api, type ActivityItem } from "../lib/api.ts";
import { useWorkspace } from "../lib/workspace.tsx";
import { EmptyState, Skeleton } from "../ui/bits.tsx";

type Filter = "all" | "edited" | "restored" | "created";

/** Recent versions across every document. Only edits are recorded, so CI runs and AI suggestions do not appear. */
export function ActivityView() {
  const ws = useWorkspace();
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    let live = true;
    void api.activity(80).then((r) => {
      if (!live) return;
      if (r.ok) setItems(r.data.items);
      else setFailed(true);
    });
    return () => { live = false; };
  }, [ws.refreshKey]);

  const groups = useMemo(() => {
    const out: { day: string; items: ActivityItem[] }[] = [];
    for (const r of (items ?? []).filter((i) => filter === "all" || kindOf(i) === filter)) {
      const day = new Date(r.createdAt).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
      const last = out[out.length - 1];
      if (last?.day === day) last.items.push(r);
      else out.push({ day, items: [r] });
    }
    return out;
  }, [items, filter]);
  const currentOf = (id: string) => ws.docs.find((d) => d.id === id)?.version ?? 0;

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-canvas">
      <div className="mx-auto max-w-3xl p-8 max-[640px]:p-4">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-display text-3xl font-semibold">Activity</h1>
            <p className="mt-1 max-w-xl text-sm text-muted">The most recent versions across all documents. Only edits are recorded here: Clause CI runs and AI suggestions leave no trace yet.</p>
          </div>
          <select aria-label="Filter activity" value={filter} onChange={(e) => setFilter(e.target.value as Filter)} className="h-9 rounded-control border border-line-strong bg-paper px-2.5 text-sm">
            <option value="all">All activity</option><option value="edited">Edits</option><option value="restored">Restores</option><option value="created">New documents</option>
          </select>
        </div>
        {items === null && !failed && <div className="space-y-3" aria-busy="true"><Skeleton className="h-24 w-full" /><Skeleton className="h-24 w-full" /><Skeleton className="h-24 w-full" /></div>}
        {failed && <p role="alert" className="rounded-control bg-fail-bg px-4 py-3 text-sm text-fail">Could not load activity.</p>}
        {items && groups.length === 0 && <EmptyState title="Nothing matches">{filter === "all" ? "Versions appear here as documents change." : "No activity of that kind yet."}</EmptyState>}
        {groups.map((g) => (
          <section key={g.day} aria-label={g.day} className="mb-6">
            <h2 className="mb-3 text-xs font-medium text-muted">{g.day}</h2>
            <ol className="relative before:absolute before:bottom-4 before:left-4 before:top-4 before:w-px before:bg-line-strong">
              {g.items.map((r) => <ActivityEntry key={`${r.documentId}-${r.version}`} r={r} current={r.version === currentOf(r.documentId)} docId={r.documentId} currentVersion={currentOf(r.documentId)} docTitle={r.title} />)}
            </ol>
          </section>
        ))}
      </div>
    </div>
  );
}
