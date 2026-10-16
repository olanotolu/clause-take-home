import { FilePlus2 } from "../ui/icons.tsx";
import { useEffect, useMemo, useState } from "react";
import { api, type Template } from "../lib/api.ts";
import { useWorkspace } from "../lib/workspace.tsx";
import { Button } from "../ui/Button.tsx";
import { EmptyState, Pill, Skeleton } from "../ui/bits.tsx";
import { Tabs, type TabDef } from "../ui/Tabs.tsx";

type Cat = "all" | Template["category"];

/** The sample contracts as starting points. "Use" is an ordinary create: the copy is yours to edit and nothing links back. */
export function TemplatesView() {
  const ws = useWorkspace();
  const [items, setItems] = useState<Template[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [cat, setCat] = useState<Cat>("all");
  const [pick, setPick] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void api.templates().then((r) => {
      if (!live) return;
      if (r.ok) setItems(r.data.items);
      else setFailed(true);
    });
    return () => { live = false; };
  }, []);

  const categories = useMemo(() => ["all" as const, ...Array.from(new Set((items ?? []).map((t) => t.category)))], [items]);
  const tabs: TabDef<Cat>[] = categories.map((c) => ({ id: c, label: c === "all" ? `All${items ? ` (${items.length})` : ""}` : `${c} (${(items ?? []).filter((t) => t.category === c).length})` }));
  const shown = (items ?? []).filter((t) => cat === "all" || t.category === cat);
  const selected = shown.find((t) => t.id === pick) ?? shown[0] ?? null;

  const use = async (t: Template) => {
    setBusy(true);
    await ws.create(`${t.title} (copy)`, t.content);
    setBusy(false);
  };

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-canvas">
      <div className="mx-auto max-w-6xl p-8 max-[640px]:p-4">
        <h1 className="font-display text-2xl">Templates</h1>
        <Tabs tabs={tabs} value={cat} onChange={(c) => { setCat(c); setPick(null); }} label="Template categories" idPrefix="tpl" className="-ml-3 mt-3 border-b border-line" />
        <div id="tpl-panel" role="tabpanel" aria-labelledby={`tpl-${cat}`} className="mt-5 grid items-start gap-5 min-[900px]:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
          {failed && <p role="alert" className="rounded-control bg-fail-bg px-4 py-3 text-sm text-fail">Could not load templates.</p>}
          {!items && !failed && <><Skeleton className="h-64" /><Skeleton className="h-64" /></>}
          {items && shown.length === 0 && <EmptyState title="No templates in this category" />}
          {items && shown.length > 0 && selected && (
            <>
              <ul className="space-y-1.5" aria-label="Templates">
                {shown.map((t) => (
                  <li key={t.id}>
                    <button onClick={() => setPick(t.id)} aria-current={selected.id === t.id} className={`w-full rounded-control border px-3.5 py-3 text-left transition-colors ${selected.id === t.id ? "border-accent bg-accent-soft" : "border-line bg-paper hover:bg-canvas"}`}>
                      <span className="font-display block text-base font-semibold leading-snug">{t.title}</span>
                      <span className="mt-1 flex items-center gap-2 text-xs text-muted"><Pill>{t.category}</Pill><span className="tnum">{t.content.length.toLocaleString()} characters</span></span>
                    </button>
                  </li>
                ))}
              </ul>
              <section aria-label="Preview" className="min-w-0 rounded-card border border-line bg-paper">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
                  <div className="min-w-0"><h2 className="font-display truncate text-lg font-semibold">{selected.title}</h2><p className="text-xs text-muted">Preview of the first part of the text</p></div>
                  <Button variant="primary" icon={<FilePlus2 size={15} aria-hidden />} loading={busy} onClick={() => void use(selected)}>Use template</Button>
                </div>
                <p className="doc max-h-[60vh] overflow-y-auto px-8 py-6 !text-[15px] max-[640px]:px-4">{selected.content.slice(0, 2400)}{selected.content.length > 2400 ? "\n…" : ""}</p>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
