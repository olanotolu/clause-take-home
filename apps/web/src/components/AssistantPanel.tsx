import { ListChecks, Search, Sparkles } from "../ui/icons.tsx";
import { api } from "../lib/api.ts";
import { useWorkspace } from "../lib/workspace.tsx";
import { navigate } from "../lib/router.ts";
import { Tabs, type TabDef } from "../ui/Tabs.tsx";
import { RequirementsPanel } from "./RequirementsPanel.tsx";
import { SearchPanel } from "./SearchPanel.tsx";
import { SuggestPanel } from "./SuggestPanel.tsx";
import { useSettings } from "../lib/settings.tsx";
import { useEffect, useState } from "react";

export type AssistantTab = "assistant" | "search" | "rules";

interface Props {
  tab: AssistantTab;
  onTab: (t: AssistantTab) => void;
  searchSeed: { q: string; n: number } | null;
}

export function AssistantPanel({ tab, onTab, searchSeed }: Props) {
  const ws = useWorkspace();
  const { settings } = useSettings();
  const doc = ws.doc!;
  const [ruleCount, setRuleCount] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    void api.requirements(doc.id).then((r) => live && r.ok && setRuleCount(r.data.items.length));
    return () => { live = false; };
  }, [doc.id, ws.rulesKey]);

  const tabs: TabDef<AssistantTab>[] = [
    ...(settings.aiTab ? [{ id: "assistant" as const, label: "Assistant", icon: <Sparkles size={14} aria-hidden /> }] : []),
    { id: "search", label: "Search", icon: <Search size={14} aria-hidden /> },
    { id: "rules", label: "Rules", icon: <ListChecks size={14} aria-hidden />, badge: ruleCount ? <span className="tnum rounded-full bg-line px-1.5 text-xs text-muted">{ruleCount}</span> : undefined },
  ];
  const current = tabs.some((t) => t.id === tab) ? tab : "search";

  return (
    <aside aria-label="Document assistant" className="flex min-h-0 flex-col border-l border-line bg-paper max-[899px]:border-l-0 max-[899px]:border-t">
      <div className="shrink-0 border-b border-line px-4 pb-3 pt-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">Document tools</p>
            <h2 className="mt-0.5 truncate text-[16px] font-semibold tracking-[-0.02em]">{current === "assistant" ? "AI assistant" : current === "search" ? "Find in documents" : "Requirements & playbooks"}</h2>
          </div>
        </div>
        {current === "assistant" && <p className="mt-1 text-[12px] text-muted">Stage suggestions, then review before applying.</p>}
      </div>
      <Tabs tabs={tabs} value={current} onChange={onTab} label="Document tools" idPrefix="asst" className="shrink-0 border-b border-line bg-paper px-2" />
      <div id="asst-panel" role="tabpanel" aria-labelledby={`asst-${current}`} className="min-h-0 flex-1 overflow-y-auto bg-canvas p-3.5">
        <div className={current === "search" ? "h-full" : "hidden"}>
          <SearchPanel refreshKey={ws.refreshKey} seed={searchSeed} onResults={ws.setSearchPage} onOpen={(r) => navigate({ name: "doc", id: r.documentId, tab: "edit" })} onPick={ws.pickHit} />
        </div>
        {current === "assistant" && (
          <SuggestPanel key={doc.id} docId={doc.id} docVersion={doc.version} onStage={ws.stageSuggested} onShowEvidence={ws.showEvidence} onOpenCi={() => navigate({ name: "doc", id: doc.id, tab: "ci" })} />
        )}
        {current === "rules" && (
          <RequirementsPanel key={doc.id} docId={doc.id} selectedText={ws.selection ? doc.content.slice(ws.selection.start, ws.selection.end) : ""} reloadKey={ws.rulesKey} onChanged={ws.bumpRules} />
        )}
      </div>
    </aside>
  );
}
