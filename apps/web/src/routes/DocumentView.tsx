import { Num } from "../ui/Num.tsx";
import { Activity, Download, GitCompare, Info, Pencil, Play, ShieldCheck } from "../ui/icons.tsx";
import { useEffect } from "react";
import { DOC_TABS, navigate, type DocTab } from "../lib/router.ts";
import { useSettings } from "../lib/settings.tsx";
import { formatDate } from "../lib/settings-core.ts";
import { ago, kb } from "../lib/wordDelta.ts";
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
      <div className="space-y-4 p-8" role="status" aria-busy="true" aria-label="Loading document">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-4 w-48" />
        <Skeleton className="mt-6 h-[50vh] w-full max-w-3xl" />
      </div>
    );
  }

  const issues = ws.ci.status === "done" ? ws.ci.report.summary.regressed + ws.ci.report.summary.still_failing : 0;
  const tabIcon: Record<DocTab, (on: boolean) => React.ReactNode> = {
    edit: (on) => <Pencil size={18} weight={on ? "fill" : "regular"} aria-hidden />,
    ci: (on) => <ShieldCheck size={18} weight={on ? "fill" : "regular"} aria-hidden />,
    activity: (on) => <Activity size={18} weight={on ? "fill" : "regular"} aria-hidden />,
    details: (on) => <Info size={18} weight={on ? "fill" : "regular"} aria-hidden />,
  };
  const tabs: TabDef<DocTab>[] = DOC_TABS.map((t) => ({
    id: t,
    icon: tabIcon[t],
    label: { edit: "Edit", ci: "Clause CI", activity: "Activity", details: "Details" }[t],
    badge:
      t === "edit" && ws.staged.length > 0 ? <span className="tnum rounded-full bg-accent-soft px-1.5 text-xs font-medium text-accent"><Num value={ws.staged.length} /></span> :
      t === "ci" && issues > 0 ? <span className="tnum rounded-full bg-fail-bg px-1.5 text-xs font-medium text-fail"><Num value={issues} /></span> : undefined,
  }));
  const canRedline = ws.preview.status === "valid";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="relative z-10 shrink-0 border-b border-line bg-paper px-6 pt-4 max-[640px]:px-3">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2.5">
              <h1 className="font-display truncate text-[23px] leading-tight max-[640px]:text-xl" title={doc.title}>{doc.title}</h1>
              <span className="tnum inline-flex shrink-0 items-center rounded-md border border-line bg-canvas px-2 py-0.5 text-xs font-semibold text-muted">v<Num value={doc.version} /></span>
              {doc.sample && <span className="inline-flex shrink-0 items-center rounded-md bg-accent-soft px-2 py-0.5 text-xs font-semibold text-accent" title="A shared sample contract. It cannot be changed; make a copy to edit it.">Sample · read-only</span>}
            </div>
            <p className="tnum mt-1 flex flex-wrap items-center gap-x-2 text-[12px] text-muted">
              <span>{kb(new TextEncoder().encode(doc.content).length)}</span>
              <span aria-hidden="true" className="text-line-strong">·</span>
              <span title={formatDate(doc.updatedAt, settings.dateFormat)}>Updated {ago(doc.updatedAt)}</span>
              {settings.showHash && <span className="ml-2 hidden font-mono text-xs sm:inline" title="SHA-256 of the current text">sha256 {doc.contentHash.slice(0, 10)}</span>}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 max-[640px]:gap-1.5">
            {doc.sample && <Button variant="secondary" onClick={() => void ws.copyDoc()} title="Make your own editable copy of this sample">Make a copy</Button>}
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
        <Tabs tabs={tabs} value={tab} onChange={(t) => navigate({ name: "doc", id: doc.id, tab: t })} label="Document sections" idPrefix="doc" className="-mb-px mt-3" />
      </header>
      <div id="doc-panel" role="tabpanel" aria-labelledby={`doc-${tab}`} className="min-h-0 flex-1">
        <div key={tab} className="fade-up h-full">
          {tab === "edit" && <EditTab />}
          {tab === "ci" && <CiTab />}
          {tab === "activity" && <ActivityTab />}
          {tab === "details" && <DetailsTab />}
        </div>
      </div>
    </div>
  );
}

