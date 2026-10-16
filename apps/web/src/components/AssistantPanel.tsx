import { ListChecks, Search, Sparkles } from "lucide-react";
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
    <aside aria-label="Assistant" className="flex min-h-0 flex-col border-l border-line bg-canvas max-[899px]:border-l-0 max-[899px]:border-t">
      <Tabs tabs={tabs} value={current} onChange={onTab} label="Assistant sections" idPrefix="asst" className="shrink-0 border-b border-line bg-paper px-2" />
      <div id="asst-panel" role="tabpanel" aria-labelledby={`asst-${current}`} className="min-h-0 flex-1 p-4">
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
