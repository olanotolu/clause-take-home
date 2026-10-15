import { useEffect, useState } from "react";
import { api, type Revision } from "../lib/api.ts";

const describe = (r: Revision) => {
  if (r.summary[0]?.created) return "Created";
  return r.summary
    .map((s) => `“${(s.before ?? "").slice(0, 28)}${(s.before ?? "").length > 28 ? "…" : ""}” → ${s.after ? `“${s.after.slice(0, 28)}${s.after.length > 28 ? "…" : ""}”` : "(deleted)"}`)
    .join("; ");
};

export function HistoryPanel({ docId, version }: { docId: string; version: number }) {
  const [items, setItems] = useState<Revision[]>([]);
  useEffect(() => {
    let live = true;
    api.revisions(docId).then((r) => live && r.ok && setItems(r.data.items));
    return () => {
      live = false;
    };
  }, [docId, version]);
  return (
    <ol className="space-y-2 overflow-y-auto">
      {items.map((r) => (
        <li key={r.version} className="rounded-lg border border-line bg-paper p-3 text-sm">
          <div className="flex justify-between"><span className="font-semibold">v{r.version}</span><span className="text-xs text-muted">{new Date(r.createdAt).toLocaleTimeString()}</span></div>
          <p className="mt-1 text-[13px] text-ink/80">{describe(r)}</p>
          <p className="mt-1 font-mono text-[11px] text-muted">sha256 {r.contentHash.slice(0, 12)}</p>
        </li>
      ))}
    </ol>
  );
}
