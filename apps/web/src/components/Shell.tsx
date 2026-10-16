import { useAutoAnimate } from "@formkit/auto-animate/react";
import { Num } from "../ui/Num.tsx";
import { motion } from "motion/react";
import { Activity, BookOpenCheck, ChevronDown, ChevronRight, FileText, LayoutDashboard, LayoutTemplate, Plus, PlugIcon, Search, Settings } from "../ui/icons.tsx";
import { useEffect, useState, type ReactNode } from "react";
import { Toaster } from "sonner";
import { api, type SettingsStatus } from "../lib/api.ts";
import { cn } from "../lib/cn.ts";
import { navigate, useRoute, type Route } from "../lib/router.ts";
import { useSettings } from "../lib/settings.tsx";
import { kb } from "../lib/wordDelta.ts";
import { useWorkspace } from "../lib/workspace.tsx";
import { useAuth } from "../lib/auth.tsx";
import { Button } from "../ui/Button.tsx";
import { Kbd } from "../ui/bits.tsx";
import { CommandPalette } from "./CommandPalette.tsx";
import { NewDocumentDialog } from "./NewDocumentDialog.tsx";

function Logo() {
  return (
    <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="8" fill="var(--color-ink)" />
      <path d="M21 11.5A6.5 6.5 0 1021 20.5" fill="none" stroke="var(--color-paper)" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

interface NavItem { key: string; label: string; icon: typeof FileText; route?: Route }
const NAV_GROUPS: { label?: string; items: NavItem[] }[] = [
  {
    items: [
      { key: "home", label: "Workspace", icon: LayoutDashboard, route: { name: "home" } },
      { key: "documents", label: "Documents", icon: FileText, route: { name: "documents" } },
      { key: "search", label: "Search", icon: Search },
    ],
  },
  { label: "Library", items: [{ key: "playbooks", label: "Playbooks", icon: BookOpenCheck, route: { name: "playbooks" } }, { key: "templates", label: "Templates", icon: LayoutTemplate, route: { name: "templates" } }] },
  { label: "System", items: [{ key: "activity", label: "Activity", icon: Activity, route: { name: "activity" } }, { key: "integrations", label: "Integrations", icon: PlugIcon, route: { name: "integrations" } }, { key: "settings", label: "Settings", icon: Settings, route: { name: "settings" } }] },
];
const NAV = NAV_GROUPS.flatMap((g) => g.items);

function activeKey(route: Route): string {
  return route.name === "doc" ? "documents" : route.name;
}

const CRUMB: Partial<Record<Route["name"], string>> = { home: "Workspace", documents: "Documents", playbooks: "Playbooks", activity: "Activity", integrations: "Integrations", templates: "Templates", settings: "Settings" };

export function Shell({ children }: { children: ReactNode }) {
  const route = useRoute();
  const ws = useWorkspace();
  const auth = useAuth();
  const { settings } = useSettings();
  const [palette, setPalette] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [status, setStatus] = useState<SettingsStatus | null>(null);
  const [docList] = useAutoAnimate<HTMLElement>({ duration: 180, easing: "ease-out" });

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
    <>
    {/* One explicit row: stray siblings can never claim a share of the height (that left a blank band under the sidebar). */}
    <div className="grid h-full grid-cols-[264px_minmax(0,1fr)] grid-rows-[minmax(0,1fr)] bg-shell max-[1279px]:grid-cols-[72px_minmax(0,1fr)] max-[899px]:grid-cols-1 max-[899px]:grid-rows-[minmax(0,1fr)_auto]">
      <aside className="flex min-h-0 flex-col text-rail-ink max-[899px]:hidden" aria-label="Primary">
        <div className="flex h-16 items-center gap-2.5 px-6 max-[1279px]:justify-center max-[1279px]:px-0">
          <Logo />
          <span className="text-[17px] font-semibold max-[1279px]:sr-only">CLAUSE</span>
        </div>
        <nav aria-label="Main" className="px-3">
          {NAV_GROUPS.map((g, gi) => (
            <div key={gi} className={cn("space-y-1", gi > 0 && "mt-4 max-[1279px]:mt-3 max-[1279px]:border-t max-[1279px]:border-ink/[0.06] max-[1279px]:pt-3")}>
              {g.label && <p className="px-3 pb-1 text-xs font-medium text-rail-muted max-[1279px]:hidden">{g.label}</p>}
              {g.items.map(({ key, label, icon: Icon, route: target }) => {
                const on = current === key;
                return (
                  <button
                    key={key}
                    onClick={() => (target ? navigate(target) : setPalette(true))}
                    aria-current={on ? "page" : undefined}
                    title={label}
                    className={cn(
                      "relative flex h-10 w-full items-center gap-3 rounded-[12px] px-3 text-left text-[14px] font-medium transition-colors duration-100 focus-visible:outline-offset-[-2px] max-[1279px]:justify-center max-[1279px]:px-0",
                      on ? "text-ink" : "text-rail-muted hover:bg-ink/[0.045] hover:text-rail-ink",
                    )}
                  >
                    {/* One white pill that glides to whichever item is current, so navigation has a direction. */}
                    {on && <motion.span layoutId="rail-active" className="absolute inset-0 rounded-[12px] bg-paper shadow-soft" transition={{ type: "spring", bounce: 0.1, duration: 0.32 }} />}
                    <Icon size={20} weight={on ? "fill" : "regular"} aria-hidden className="relative" />
                    <span className="relative max-[1279px]:sr-only">{label}</span>
                    {key === "search" && <span className="relative ml-auto max-[1279px]:hidden"><Kbd>⌘K</Kbd></span>}
                    {key === "home" && openRequests > 0 && (
                      <span className="tnum relative ml-auto rounded-full bg-ink/[0.07] px-2 py-px text-xs text-rail-ink max-[1279px]:hidden" aria-label={`${openRequests} open requests`}>
                        <Num value={openRequests} />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="mt-4 flex min-h-0 flex-1 flex-col max-[1279px]:hidden">
          <p className="px-5 pb-1.5 text-xs font-medium text-rail-muted">Recent</p>
          <nav aria-label="Document list" ref={docList} className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2">
            {ws.docs.map((d) => {
              const on = route.name === "doc" && route.id === d.id;
              return (
                <button
                  key={d.id}
                  onClick={() => navigate({ name: "doc", id: d.id, tab: "edit" })}
                  aria-current={on ? "page" : undefined}
                  className={cn("block w-full rounded-[12px] px-3 py-1.5 text-left transition-colors duration-100", on ? "bg-paper text-ink shadow-soft" : "text-rail-ink/80 hover:bg-ink/[0.045]")}
                >
                  <span className="block truncate text-[13px] font-medium">{d.title}</span>
                  <span className="tnum text-[11px] text-rail-muted">v{d.version} · {kb(d.size)}</span>
                </button>
              );
            })}
            {ws.docsStatus.kind === "ready" && ws.docs.length === 0 && <p className="px-3 text-[13px] text-rail-muted">No documents yet.</p>}
          </nav>
        </div>

        <div className="mt-auto space-y-2 border-t border-line px-3 py-3 max-[1279px]:hidden">
          <div className="relative">
            <button aria-expanded={accountOpen} onClick={() => setAccountOpen((v) => !v)} className="flex w-full items-center gap-2.5 rounded-[12px] bg-paper/70 px-2.5 py-2 text-left hover:bg-paper">
              <span className="grid size-8 shrink-0 place-items-center rounded-full bg-ink text-[11px] font-semibold text-paper">AC</span>
              <span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-semibold text-rail-ink">Acme Inc.</span><span className="block truncate text-xs text-rail-muted">Legal Team</span></span>
              <ChevronDown size={15} aria-hidden className="text-rail-muted" />
            </button>
            {accountOpen && <div className="absolute bottom-full left-0 right-0 mb-2 rounded-[12px] border border-line bg-paper p-3 shadow-soft">
              <p className="truncate text-xs font-medium text-rail-ink">{auth.user?.name || auth.user?.email || "Workspace profile"}</p>
              {auth.user?.email && <p className="mt-0.5 truncate text-[11px] text-rail-muted">{auth.user.email}</p>}
              {auth.user && <button onClick={() => { void auth.signOut(); setAccountOpen(false); }} className="mt-2 w-full rounded-control px-2 py-1.5 text-left text-xs text-rail-muted hover:bg-rail-hi hover:text-rail-ink">Sign out</button>}
            </div>}
          </div>
          <div className="rounded-[12px] bg-paper/70 px-3 py-2.5">
            <div className="flex items-center justify-between text-xs"><span className="font-medium text-rail-ink">Usage</span><span className="text-[10px] text-rail-muted">Sample</span></div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink/15"><div className="h-full w-[24%] rounded-full bg-accent" /></div>
            <p className="tnum mt-1.5 text-xs text-rail-ink">2.4 GB <span className="text-rail-muted">/ 10 GB</span></p>
          </div>
          <p className="px-1 text-[10px] text-rail-muted">{ws.docs.length} document{ws.docs.length === 1 ? "" : "s"} · {kb(totalBytes)} · {status ? (status.storage === "postgres" ? "Postgres" : "SQLite") : "Workspace"}</p>
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-col pr-3 max-[899px]:pr-0">
        <header className="flex h-16 shrink-0 items-center gap-3 px-3 max-[899px]:bg-paper max-[899px]:px-3">
          <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm text-muted max-[1100px]:hidden">
            <button onClick={() => navigate({ name: route.name === "doc" ? "documents" : "home" })} className="rounded px-1 hover:text-ink">{route.name === "doc" ? "Documents" : "Workspace"}</button>
            {route.name !== "doc" && route.name !== "home" && <><ChevronRight size={14} aria-hidden /><span className="font-medium text-ink">{CRUMB[route.name]}</span></>}
            {route.name === "doc" && (
              <>
                <ChevronRight size={14} aria-hidden />
                <span className="truncate font-medium text-ink">{crumbDoc?.title ?? "…"}</span>
                {crumbDoc && <span className="tnum shrink-0 rounded-md bg-accent-soft px-1.5 py-px text-xs font-medium text-accent" data-testid="version">v{crumbDoc.version}</span>}
              </>
            )}
          </nav>
          <button
            onClick={() => setPalette(true)}
            className="ml-auto flex h-10 min-w-0 flex-1 items-center gap-2 rounded-full bg-paper px-4 text-left text-sm text-muted shadow-soft transition-shadow duration-100 hover:shadow-[0_1px_3px_rgb(20_20_22/0.1),0_0_0_1px_rgb(20_20_22/0.06)] max-[1100px]:ml-0 min-[1101px]:max-w-md min-[1101px]:flex-none min-[1101px]:basis-96"
          >
            <Search size={15} aria-hidden />
            <span className="min-w-0 flex-1 truncate">Search documents and clauses…</span>
            <span className="max-[640px]:hidden"><Kbd>⌘K</Kbd></span>
          </button>
          <Button variant="primary" icon={<Plus size={16} aria-hidden />} onClick={() => ws.setNewRequest({ open: true, ...(crumbDoc && { documentId: crumbDoc.id }) })}>
            <span className="max-[640px]:sr-only">New request</span>
          </Button>
        </header>
        <main className="mb-3 min-h-0 flex-1 overflow-hidden rounded-panel bg-paper shadow-soft max-[899px]:mb-0 max-[899px]:rounded-none max-[899px]:shadow-none">{children}</main>
      </div>

      <nav aria-label="Main (mobile)" className="hidden overflow-x-auto border-t border-line bg-rail text-rail-ink max-[899px]:flex">
        {NAV.map(({ key, label, icon: Icon, route: target }) => (
          <button key={key} onClick={() => (target ? navigate(target) : setPalette(true))} aria-current={current === key ? "page" : undefined} className={cn("flex h-14 min-w-[76px] flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium", current === key ? "text-rail-ink" : "text-rail-muted")}>
            <Icon size={18} aria-hidden />
            {label}
          </button>
        ))}
      </nav>
    </div>
    <CommandPalette open={palette} onClose={() => setPalette(false)} />
    <NewDocumentDialog open={ws.newDocOpen} onClose={() => ws.setNewDocOpen(false)} />
    <Toaster position="bottom-right" theme={settings.theme} offset={16} mobileOffset={{ bottom: 76, left: 12, right: 12 }} closeButton />
    </>
  );
}
