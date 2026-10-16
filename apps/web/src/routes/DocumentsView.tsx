import { FilePlus2, LayoutTemplate, Search } from "../ui/icons.tsx";
import { useMemo, useState } from "react";
import { navigate } from "../lib/router.ts";
import { ago, kb } from "../lib/wordDelta.ts";
import { useWorkspace } from "../lib/workspace.tsx";
import { Button } from "../ui/Button.tsx";
import { EmptyState, Skeleton } from "../ui/bits.tsx";

export function DocumentsView({ onNew }: { onNew: () => void }) {
  const ws = useWorkspace();
  const [q, setQ] = useState("");
  const rows = useMemo(() => {
    const n = q.trim().toLowerCase();
    return [...ws.docs].filter((d) => !n || d.title.toLowerCase().includes(n)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [ws.docs, q]);

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-canvas">
      <div className="mx-auto max-w-5xl p-8 max-[640px]:p-4">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
          <h1 className="font-display text-2xl">Documents</h1>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-56 max-w-full">
              <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
              <input value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter documents by title" placeholder="Filter" className="h-9 w-full rounded-control border border-line-strong bg-paper pl-9 pr-3 text-sm" />
            </div>
            <Button icon={<LayoutTemplate size={15} aria-hidden />} onClick={() => navigate({ name: "templates" })}>Templates</Button>
            <Button variant="primary" icon={<FilePlus2 size={15} aria-hidden />} onClick={onNew}>New document</Button>
          </div>
        </div>

        <div className="mt-6">
          {ws.docsStatus.kind === "loading" && <div className="space-y-2" aria-busy="true" aria-label="Loading documents">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-14 w-full" />)}</div>}
          {ws.docsStatus.kind === "error" && <p role="alert" className="rounded-control bg-fail-bg px-4 py-3 text-sm text-fail">{ws.docsStatus.message}</p>}
          {ws.docsStatus.kind === "ready" && ws.docs.length === 0 && (
            <div className="py-2">
              <EmptyState icon={<FilePlus2 size={26} aria-hidden />} title="No documents yet" action={<div className="flex gap-2"><Button variant="primary" onClick={onNew}>New document</Button><Button icon={<LayoutTemplate size={15} aria-hidden />} onClick={() => navigate({ name: "templates" })}>Browse templates</Button></div>}>
                Paste a contract, or start from one of the sample templates.
              </EmptyState>
            </div>
          )}
          {ws.docsStatus.kind === "ready" && ws.docs.length > 0 && (
            <div className="overflow-hidden rounded-card border border-line bg-paper">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-line text-xs text-muted">
                  <tr><th scope="col" className="px-4 py-2.5 font-medium">Title</th><th scope="col" className="px-3 py-2.5 font-medium">Version</th><th scope="col" className="px-3 py-2.5 font-medium max-[640px]:hidden">Size</th><th scope="col" className="px-4 py-2.5 font-medium">Updated</th></tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {rows.map((d) => (
                    <tr key={d.id} className="group cursor-pointer hover:bg-canvas" onClick={() => navigate({ name: "doc", id: d.id, tab: "edit" })}>
                      <td className="max-w-[48vw] px-4 py-3 max-[640px]:px-3"><a href={`#/doc/${encodeURIComponent(d.id)}/edit`} className="block truncate font-medium group-hover:text-accent" onClick={(e) => e.stopPropagation()}>{d.title}</a></td>
                      <td className="tnum px-3 py-3 text-muted">v{d.version}</td>
                      <td className="tnum px-3 py-3 text-muted max-[640px]:hidden">{kb(d.size)}</td>
                      <td className="tnum whitespace-nowrap px-4 py-3 text-muted max-[640px]:px-3">{ago(d.updatedAt)}</td>
                    </tr>
                  ))}
                  {rows.length === 0 && <tr><td colSpan={4} className="px-4 py-6 text-center text-muted">No document titled “{q}”.</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
