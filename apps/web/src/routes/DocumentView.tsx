import { Download, GitCompare, Play } from "lucide-react";
import { useEffect } from "react";
import { DOC_TABS, navigate, type DocTab } from "../lib/router.ts";
import { useSettings } from "../lib/settings.tsx";
import { formatDate } from "../lib/settings-core.ts";
import { kb } from "../lib/wordDelta.ts";
import { useWorkspace } from "../lib/workspace.tsx";
import { Button, buttonClass } from "../ui/Button.tsx";
import { Skeleton } from "../ui/bits.tsx";
import { Segmented } from "../ui/Segmented.tsx";
import { Tabs, type TabDef } from "../ui/Tabs.tsx";
import { ActivityTab } from "./ActivityTab.tsx";
import { CiTab } from "./CiTab.tsx";
import { DetailsTab } from "./DetailsTab.tsx";
import { EditTab } from "./EditTab.tsx";

export function DocumentView({ id, tab }: { id: string; tab: DocTab }) {
  const ws = useWorkspace();
  const { settings } = useSettings();
  const doc = ws.doc?.id === id ? ws.doc : null;

  useEffect(() => {
    if (doc) document.title = `${doc.title} · CLAUSE`;
    return () => { document.title = "CLAUSE"; };
  }, [doc]);

  if (!doc) {
    return (
      <div className="space-y-4 p-8" aria-busy="true" aria-label="Loading document">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-4 w-48" />
        <Skeleton className="mt-6 h-[50vh] w-full max-w-3xl" />
      </div>
    );
  }

  const issues = ws.ci.status === "done" ? ws.ci.report.summary.regressed + ws.ci.report.summary.still_failing : 0;
  const tabs: TabDef<DocTab>[] = DOC_TABS.map((t) => ({
    id: t,
    label: { edit: "Edit", ci: "Clause CI", activity: "Activity", details: "Details" }[t],
    badge:
      t === "edit" && ws.staged.length > 0 ? <span className="tnum rounded-full bg-accent-soft px-1.5 text-xs font-semibold text-accent">{ws.staged.length}</span> :
      t === "ci" && issues > 0 ? <span className="tnum rounded-full bg-fail-bg px-1.5 text-xs font-semibold text-fail">{issues}</span> : undefined,
  }));
  const canRedline = ws.preview.status === "valid";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-line bg-paper px-6 pt-4 max-[640px]:px-3">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div className="min-w-0">
            <h1 className="font-display truncate text-2xl font-semibold max-[640px]:text-xl" title={doc.title}>{doc.title}</h1>
            <p className="tnum mt-0.5 text-[13px] text-muted">
              v{doc.version} · {kb(new TextEncoder().encode(doc.content).length)} · updated {formatDate(doc.updatedAt, settings.dateFormat)}
              {settings.showHash && <span className="ml-2 hidden font-mono text-xs sm:inline" title="SHA-256 of the current text">sha256 {doc.contentHash.slice(0, 10)}</span>}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 max-[640px]:gap-1.5">
            {tab === "edit" && (
              <Segmented
                value={ws.redline ? "redline" : "original"}
                onChange={(v) => ws.setRedline(v === "redline")}
                label="View"
                options={[
                  { value: "original", label: "Original" },
                  { value: "redline", label: <><GitCompare size={13} aria-hidden />Redline</>, disabled: !canRedline, title: canRedline ? "Show staged changes as a redline" : "Stage a valid change to preview its redline" },
                ]}
              />
            )}
            {doc.version > 1 ? (
              <a href={`/api/documents/${doc.id}/export.docx?from=1&to=${doc.version}`} download className={buttonClass({ variant: "secondary" })} title={`Word file with every change from v1 to v${doc.version} as tracked changes`}>
                <Download size={15} aria-hidden /><span className="max-[640px]:sr-only">Export .docx</span>
              </a>
            ) : (
              <Button icon={<Download size={15} aria-hidden />} disabled title="Make an edit first: the Word redline shows differences between versions"><span className="max-[640px]:sr-only">Export .docx</span></Button>
            )}
            <Button
              variant="primary"
              icon={<Play size={14} aria-hidden />}
              loading={ws.ci.status === "loading"}
              onClick={() => { navigate({ name: "doc", id: doc.id, tab: "ci" }); void ws.runCi(); }}
              title={ws.staged.length ? `Check ${ws.staged.length} staged change${ws.staged.length === 1 ? "" : "s"} against this document's requirements` : "Check the current text against this document's requirements"}
            >
              Run Clause CI
            </Button>
          </div>
        </div>
        <Tabs tabs={tabs} value={tab} onChange={(t) => navigate({ name: "doc", id: doc.id, tab: t })} label="Document sections" idPrefix="doc" className="-mb-px mt-2" />
      </header>
      <div id="doc-panel" role="tabpanel" aria-labelledby={`doc-${tab}`} className="min-h-0 flex-1">
        {tab === "edit" && <EditTab />}
        {tab === "ci" && <CiTab />}
        {tab === "activity" && <ActivityTab />}
        {tab === "details" && <DetailsTab />}
      </div>
    </div>
  );
}

