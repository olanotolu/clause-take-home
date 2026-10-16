import { useRef, useState } from "react";
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
  const [tab, setTab] = useState<AssistantTab>("search");
  const [seed, setSeed] = useState<{ q: string; n: number } | null>(null);
  const redlineSpans = ws.redline && ws.preview.status === "valid" ? ws.preview.data.applied : null;

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_360px] max-[899px]:grid-cols-1 max-[899px]:overflow-y-auto min-[900px]:overflow-hidden">
      <div className="flex min-h-0 min-w-0 flex-col max-[899px]:min-h-[75vh]">
        {redlineSpans && (
          <p role="status" className="shrink-0 border-b border-line bg-pass-bg px-6 py-2 text-sm text-ink/80 max-[640px]:px-3">
            Redline preview of {redlineSpans.length} staged change{redlineSpans.length === 1 ? "" : "s"}: <span className="del px-0.5">removed</span> <span className="ins px-0.5">added</span>. Nothing is saved until you Apply.
          </p>
        )}
        <div ref={scroller} className="relative min-h-0 flex-1 overflow-y-auto bg-canvas px-4 max-[640px]:px-2">
          <DocPane content={doc.content} hits={ws.hits} selection={ws.selection} redline={redlineSpans} onSelect={ws.setSelection} />
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
      <AssistantPanel tab={tab} onTab={setTab} searchSeed={seed} />
    </div>
  );
}
