import { useEffect, useRef, useState } from "react";
import { useSettings } from "../lib/settings.tsx";
import { AssistantPanel, type AssistantTab } from "../components/AssistantPanel.tsx";
import { ChangesTray } from "../components/ChangesTray.tsx";
import { DocPane } from "../components/DocPane.tsx";
import { SelectionToolbar } from "../components/SelectionToolbar.tsx";
import { useWorkspace } from "../lib/workspace.tsx";

/** The working view: the document in the middle, the proposed-changes tray under it, the assistant beside it. */
export function EditTab() {
  const ws = useWorkspace();
  const doc = ws.doc!;
  const scroller = useRef<HTMLDivElement>(null);
  const { settings } = useSettings();
  const [tab, setTab] = useState<AssistantTab>(settings.aiTab ? "assistant" : "search");
  const [mobilePane, setMobilePane] = useState<"document" | "tools">("document");
  const [seed, setSeed] = useState<{ q: string; n: number } | null>(null);
  const redlineSpans = ws.redline && ws.preview.status === "valid" ? ws.preview.data.applied : null;

  // A new version (applied, restored) gives the sheet one soft ring, so the change is felt rather than just announced.
  const lastVersion = useRef(doc.version);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (doc.version === lastVersion.current) return;
    lastVersion.current = doc.version;
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 1000);
    return () => clearTimeout(t);
  }, [doc.version]);

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_minmax(320px,360px)] max-[899px]:grid-cols-1 max-[899px]:grid-rows-[auto_minmax(0,1fr)] min-[900px]:overflow-hidden min-[1280px]:grid-cols-[minmax(0,1fr)_390px]">
      <div role="tablist" aria-label="Document view" className="hidden max-[899px]:flex border-b border-line bg-paper p-1.5">
        {(["document", "tools"] as const).map((pane) => <button key={pane} role="tab" aria-selected={mobilePane === pane} onClick={() => setMobilePane(pane)} className={`h-10 flex-1 rounded-control text-sm font-medium capitalize transition-colors ${mobilePane === pane ? "bg-accent-soft text-ink" : "text-muted hover:bg-canvas"}`}>{pane === "tools" ? "Search & tools" : "Document"}</button>)}
      </div>
      <div className={`flex min-h-0 min-w-0 flex-col ${mobilePane === "document" ? "max-[899px]:flex" : "max-[899px]:hidden"}`}>
        {redlineSpans && (
          <p role="status" className="shrink-0 border-b border-line bg-pass-bg px-6 py-2 text-sm text-ink/80 max-[640px]:px-3">
            Redline preview of {redlineSpans.length} staged change{redlineSpans.length === 1 ? "" : "s"}: <span className="del px-0.5">removed</span> <span className="ins px-0.5">added</span>. Nothing is saved until you Apply.
          </p>
        )}
        <div ref={scroller} className="relative min-h-0 flex-1 overflow-y-auto bg-canvas px-5 py-1 max-[640px]:px-2">
          <DocPane content={doc.content} hits={ws.hits} selection={ws.selection} redline={redlineSpans} flash={flash} onSelect={ws.setSelection} />
          {ws.selection && !redlineSpans && (
            <SelectionToolbar
              container={scroller}
              content={doc.content}
              selection={ws.selection}
              onStage={ws.stage}
              onProtect={(t) => { void ws.protect(t); ws.setSelection(null); setTab("rules"); }}
              onFind={(t) => { setSeed({ q: t.slice(0, 120), n: (seed?.n ?? 0) + 1 }); setTab("search"); }}
              onClear={() => ws.setSelection(null)}
            />
          )}
        </div>
        <ChangesTray />
      </div>
      <div className={`min-h-0 ${mobilePane === "tools" ? "max-[899px]:block" : "max-[899px]:hidden"}`}><AssistantPanel tab={tab} onTab={setTab} searchSeed={seed} /></div>
    </div>
  );
}
