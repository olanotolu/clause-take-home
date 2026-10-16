import { Activity, BookOpenCheck, CheckCircle2, ChevronRight, FileText, Info, LayoutDashboard, LayoutTemplate, Plus, Search, Settings, X, XCircle } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { api, type SettingsStatus } from "../lib/api.ts";
import { navigate, useRoute, type Route } from "../lib/router.ts";
import { kb } from "../lib/wordDelta.ts";
import { useWorkspace } from "../lib/workspace.tsx";
import { Button } from "../ui/Button.tsx";
import { Kbd } from "../ui/bits.tsx";
import { CommandPalette } from "./CommandPalette.tsx";
import { NewDocumentDialog } from "./NewDocumentDialog.tsx";

function Logo() {
  return (
    <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="8" fill="var(--color-rail-hi)" />
      <path d="M21 11.5A6.5 6.5 0 1021 20.5" fill="none" stroke="var(--color-accent)" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

const NAV: { key: string; label: string; icon: typeof FileText; route?: Route }[] = [
  { key: "home", label: "Workspace", icon: LayoutDashboard, route: { name: "home" } },
  { key: "documents", label: "Documents", icon: FileText, route: { name: "documents" } },
  { key: "search", label: "Search", icon: Search },
  { key: "playbooks", label: "Playbooks", icon: BookOpenCheck, route: { name: "playbooks" } },
  { key: "templates", label: "Templates", icon: LayoutTemplate, route: { name: "templates" } },
  { key: "activity", label: "Activity", icon: Activity, route: { name: "activity" } },
  { key: "settings", label: "Settings", icon: Settings, route: { name: "settings" } },
];

function activeKey(route: Route): string {
  return route.name === "doc" ? "documents" : route.name;
}

const CRUMB: Partial<Record<Route["name"], string>> = { home: "Workspace", documents: "Documents", playbooks: "Playbooks", activity: "Activity", templates: "Templates", settings: "Settings" };

function ToastRegion() {
  const { toasts, dismissToast } = useWorkspace();
  return (
    <div role="status" aria-live="polite" className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(380px,calc(100vw-32px))] flex-col gap-2 max-[899px]:bottom-20">
      {toasts.map((t) => (
        <div key={t.id} className="rise pointer-events-auto flex items-start gap-2.5 rounded-xl border border-line-strong bg-paper p-3 text-sm shadow-lift">
          {t.tone === "pass" ? <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-pass" aria-hidden /> : t.tone === "fail" ? <XCircle size={16} className="mt-0.5 shrink-0 text-fail" aria-hidden /> : <Info size={16} className="mt-0.5 shrink-0 text-accent" aria-hidden />}
          <p className="min-w-0 flex-1">{t.text}</p>
          <button onClick={() => dismissToast(t.id)} aria-label="Dismiss" className="shrink-0 rounded p-0.5 text-muted hover:text-ink"><X size={14} aria-hidden /></button>
        </div>
      ))}
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const route = useRoute();
  const ws = useWorkspace();
  const [palette, setPalette] = useState(false);
  const [status, setStatus] = useState<SettingsStatus | null>(null);

  useEffect(() => {
    void api.settingsStatus().then((r) => r.ok && setStatus(r.data));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const current = activeKey(route);
  const totalBytes = ws.docs.reduce((n, d) => n + d.size, 0);
  const crumbDoc = route.name === "doc" ? ws.doc : null;
  const openRequests = ws.requests.filter((r) => r.status !== "completed").length;

  return (
    <div className="grid h-full grid-cols-[256px_minmax(0,1fr)] max-[1279px]:grid-cols-[64px_minmax(0,1fr)] max-[899px]:grid-cols-1 max-[899px]:grid-rows-[minmax(0,1fr)_auto]">
      <aside className="flex min-h-0 flex-col bg-rail text-rail-ink max-[899px]:hidden" aria-label="Primary">
        <div className="flex h-14 items-center gap-2.5 px-4 max-[1279px]:justify-center max-[1279px]:px-0">
          <Logo />
          <span className="text-[15px] font-bold tracking-wide max-[1279px]:sr-only">CLAUSE</span>
        </div>
        <nav aria-label="Main" className="space-y-0.5 px-2">
          {NAV.map(({ key, label, icon: Icon, route: target }) => (
            <button
              key={key}
              onClick={() => (target ? navigate(target) : setPalette(true))}
              aria-current={current === key ? "page" : undefined}
              title={label}
              className={`flex h-9 w-full items-center gap-3 rounded-control px-3 text-left text-[13px] font-medium transition-colors max-[1279px]:justify-center max-[1279px]:px-0 ${
                current === key ? "bg-rail-hi text-white" : "text-rail-muted hover:bg-rail-hi/70 hover:text-white"
              }`}
            >
              <Icon size={17} aria-hidden />
              <span className="max-[1279px]:sr-only">{label}</span>
              {key === "search" && <span className="ml-auto max-[1279px]:hidden"><Kbd>⌘K</Kbd></span>}
              {key === "home" && openRequests > 0 && <span className="tnum ml-auto rounded-full bg-rail-hi px-1.5 text-xs text-rail-ink max-[1279px]:hidden" aria-label={`${openRequests} open requests`}>{openRequests}</span>}
            </button>
          ))}
        </nav>

        <div className="mt-4 flex min-h-0 flex-1 flex-col max-[1279px]:hidden">
          <p className="px-5 pb-1.5 text-xs font-medium text-rail-muted">Recent</p>
          <nav aria-label="Document list" className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2">
            {ws.docs.map((d) => {
              const on = route.name === "doc" && route.id === d.id;
              return (
                <button
                  key={d.id}
                  onClick={() => navigate({ name: "doc", id: d.id, tab: "edit" })}
                  aria-current={on ? "page" : undefined}
                  className={`block w-full rounded-control px-3 py-1.5 text-left transition-colors ${on ? "bg-rail-hi text-white" : "text-rail-ink/75 hover:bg-rail-hi/70"}`}
                >
                  <span className="block truncate text-[13px] font-medium">{d.title}</span>
                  <span className="tnum text-[11px] text-rail-muted">v{d.version} · {kb(d.size)}</span>
                </button>
              );
            })}
            {ws.docsStatus.kind === "ready" && ws.docs.length === 0 && <p className="px-3 text-[13px] text-rail-muted">No documents yet.</p>}
          </nav>
        </div>

        <div className="mt-auto border-t border-white/10 p-3 text-xs text-rail-muted max-[1279px]:hidden">
          <p className="tnum">{ws.docs.length} document{ws.docs.length === 1 ? "" : "s"} · {kb(totalBytes)}</p>
          <p className="mt-0.5">
            Open workspace{status ? ` · ${status.storage === "postgres" ? "Postgres" : "SQLite"}` : ""}{status && status.version !== "dev" ? ` · ${status.version}` : ""}
          </p>
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-paper px-5 max-[899px]:px-3">
          <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm text-muted max-[1100px]:hidden">
            <button onClick={() => navigate({ name: route.name === "doc" ? "documents" : "home" })} className="rounded px-1 hover:text-ink">{route.name === "doc" ? "Documents" : "Workspace"}</button>
            {route.name !== "doc" && route.name !== "home" && <><ChevronRight size={14} aria-hidden /><span className="font-medium text-ink">{CRUMB[route.name]}</span></>}
            {route.name === "doc" && (
              <>
                <ChevronRight size={14} aria-hidden />
                <span className="truncate font-medium text-ink">{crumbDoc?.title ?? "…"}</span>
                {crumbDoc && <span className="tnum shrink-0 rounded bg-accent-soft px-1.5 py-px text-xs font-semibold text-accent" data-testid="version">v{crumbDoc.version}</span>}
              </>
            )}
          </nav>
          <button
            onClick={() => setPalette(true)}
            className="ml-auto flex h-9 min-w-0 flex-1 items-center gap-2 rounded-control border border-line-strong bg-canvas px-3 text-left text-sm text-muted hover:border-muted max-[1100px]:ml-0 min-[1101px]:max-w-lg min-[1101px]:flex-none min-[1101px]:basis-96"
          >
            <Search size={15} aria-hidden />
            <span className="min-w-0 flex-1 truncate">Search documents and clauses…</span>
            <span className="max-[640px]:hidden"><Kbd>⌘K</Kbd></span>
          </button>
          <Button variant="primary" icon={<Plus size={16} aria-hidden />} onClick={() => ws.setNewRequest({ open: true, ...(crumbDoc && { documentId: crumbDoc.id }) })}>
            <span className="max-[640px]:sr-only">New request</span>
          </Button>
        </header>
        <main className="min-h-0 flex-1">{children}</main>
      </div>

      <nav aria-label="Main (mobile)" className="hidden overflow-x-auto border-t border-line bg-rail text-rail-ink max-[899px]:flex">
        {NAV.map(({ key, label, icon: Icon, route: target }) => (
          <button key={key} onClick={() => (target ? navigate(target) : setPalette(true))} aria-current={current === key ? "page" : undefined} className={`flex h-14 min-w-[76px] flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium ${current === key ? "text-white" : "text-rail-muted"}`}>
            <Icon size={18} aria-hidden />
            {label}
          </button>
        ))}
      </nav>

      <CommandPalette open={palette} onClose={() => setPalette(false)} />
      <NewDocumentDialog open={ws.newDocOpen} onClose={() => ws.setNewDocOpen(false)} />
      <ToastRegion />
    </div>
  );
}
