import { useEffect, useState } from "react";
import { api, type Revision } from "../lib/api.ts";

const describe = (r: Revision) => {
  if (r.summary[0]?.created) return "Created";
  if (r.summary[0]?.revertedTo) return `Restored the text of v${r.summary[0].revertedTo}`;
  return r.summary
    .map((s) => `“${(s.before ?? "").slice(0, 28)}${(s.before ?? "").length > 28 ? "…" : ""}” → ${s.after ? `“${s.after.slice(0, 28)}${s.after.length > 28 ? "…" : ""}”` : "(deleted)"}`)
    .join("; ");
};

export function HistoryPanel({ docId, version, onRestore }: { docId: string; version: number; onRestore: (toVersion: number) => void }) {
  const [items, setItems] = useState<Revision[]>([]);
  useEffect(() => {
    let live = true;
    api.revisions(docId).then((r) => live && r.ok && setItems(r.data.items));
    return () => {
      live = false;
    };
  }, [docId, version]);
  const download = (from: number) => `/api/documents/${docId}/export.docx?from=${from}&to=${version}`;
  return (
    <div className="flex h-full flex-col gap-3">
      {version > 1 && (
        <a href={download(1)} download className="rounded-md border border-line bg-paper px-3 py-2 text-center text-[13px] font-semibold hover:bg-canvas">
          Download Word redline vs the original (v1 → v{version})
        </a>
      )}
    <ol className="relative min-h-0 flex-1 space-y-2 overflow-y-auto">
      {items.map((r) => (
        <li key={r.version} className="rounded-lg border border-line bg-paper p-3 text-sm">
          <div className="flex justify-between"><span className="font-semibold">v{r.version}</span><span className="text-xs text-muted">{new Date(r.createdAt).toLocaleTimeString()}</span></div>
          <p className="mt-1 text-[13px] text-ink/80">{describe(r)}</p>
          <div className="mt-1 flex items-center justify-between">
            <p className="font-mono text-[11px] text-muted">sha256 {r.contentHash.slice(0, 12)}</p>
            {r.version === version ? (
              <span className="text-[11px] font-semibold text-accent">current</span>
            ) : (
              <span className="flex items-center gap-1.5">
              <a href={download(r.version)} download aria-label={`Download Word redline since v${r.version}`} title={`Word file showing what changed since v${r.version} as tracked changes`} className="rounded border border-line px-2 py-0.5 text-[11px] font-semibold hover:bg-canvas">.docx</a>
              <button
                onClick={() => onRestore(r.version)}
                aria-label={`Restore v${r.version}`}
                title={`Make the text of v${r.version} current again, as a new version. History is kept.`}
                className="rounded border border-line px-2 py-0.5 text-[11px] font-semibold hover:bg-canvas"
              >
                Restore v{r.version}
              </button>
              </span>
            )}
          </div>
        </li>
      ))}
    </ol>
    </div>
  );
}
