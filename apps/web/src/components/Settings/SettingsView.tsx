import { useEffect, useMemo, useState } from "react";
import { api, type SettingsStatus } from "../../lib/api.ts";
import { useSettings } from "../../lib/settings.tsx";
import { Card, Fact, Row, Select, SettingsSectionIcon, Toggle } from "./parts.tsx";
import { motion } from "motion/react";
import { SiAnthropic, SiGoogle } from "@icons-pack/react-simple-icons";
import { Brain, MagnifyingGlass } from "../../ui/icons.tsx";
import { navigate, useRoute } from "../../lib/router.ts";
import { shortModel } from "../../lib/confidence.ts";

const SECTIONS = [
  ["general", "General", "Display preferences for this browser."],
  ["ai", "AI & Models", "How the AI checks behave. Models themselves are set on the server."],
  ["editing", "Document & Editing", "How staged changes are reviewed and applied."],
  ["security", "Security & Privacy", "What this deployment does with your documents."],
  ["usage", "Usage & Limits", "Live numbers from the server."],
] as const;

type SectionId = (typeof SECTIONS)[number][0];

function ModelProviderIcon({ model }: { model: string }) {
  const provider = model.split("/")[0]?.toLowerCase() ?? "";
  if (provider === "anthropic") return <SiAnthropic size={19} color="#d97757" aria-hidden="true" title="" />;
  if (provider === "openai") return <span aria-hidden="true" className="grid size-[22px] place-items-center rounded-md bg-emerald-50 text-emerald-700"><Brain size={16} weight="duotone" /></span>;
  if (provider === "google") return <SiGoogle size={18} color="#4285f4" aria-hidden="true" title="" />;
  return <span aria-hidden="true" className="grid size-[22px] place-items-center rounded-md bg-accent-soft text-accent"><Brain size={16} weight="duotone" /></span>;
}

function modelProviderName(model: string) {
  const provider = model.split("/")[0]?.toLowerCase() ?? "";
  if (provider === "anthropic") return "Anthropic";
  if (provider === "openai") return "OpenAI";
  if (provider === "google") return "Google";
  return provider ? provider[0]!.toUpperCase() + provider.slice(1) : "Model provider";
}

function ModelList({ judges, suggestionModel }: { judges: string[]; suggestionModel: string | null }) {
  const models = new Map<string, Set<string>>();
  for (const model of judges) models.set(model, new Set([...(models.get(model) ?? []), "Judge"]));
  if (suggestionModel) models.set(suggestionModel, new Set([...(models.get(suggestionModel) ?? []), "Suggestions"]));
  const entries = [...models.entries()];
  return (
    <div className="py-3.5">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <p className="text-sm font-medium">Models in use</p>
        <span className="text-xs text-muted">Configured on this server</span>
      </div>
      {entries.length ? <ul className="space-y-1.5">
        {entries.map(([model, roles]) => (
          <li key={model} className="flex min-w-0 items-center gap-2.5 rounded-xl border border-line bg-canvas/60 px-3 py-2">
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-paper ring-1 ring-line"><ModelProviderIcon model={model} /></span>
            <span className="min-w-0 flex-1 truncate" title={model}><span className="block truncate text-[13px] font-medium">{shortModel(model)}</span><span className="block text-[11px] text-muted">{modelProviderName(model)}</span></span>
            <span className="flex shrink-0 gap-1">{[...roles].map((role) => <span key={role} className="rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-medium text-accent">{role}</span>)}</span>
          </li>
        ))}
      </ul> : <p className="rounded-xl border border-dashed border-line-strong px-3 py-3 text-[13px] text-muted">No AI models are configured on this server.</p>}
      {!suggestionModel && <p className="mt-2 text-xs text-muted">AI suggestions are not configured.</p>}
    </div>
  );
}

function scrollToSection(id: SectionId, behavior: ScrollBehavior) {
  const page = document.querySelector<HTMLElement>(".settings-page");
  const target = document.getElementById(id);
  if (!page || !target) return;
  const header = page.querySelector<HTMLElement>(".settings-header");
  const top = page.scrollTop + target.getBoundingClientRect().top - page.getBoundingClientRect().top - (header?.offsetHeight ?? 0) - 12;
  page.scrollTo({ top: Math.max(0, top), behavior });
}

/** What each section contains, as searchable text (the page filters sections by this). */
const KEYWORDS: Record<SectionId, string> = {
  general: "date format language workspace time zone export",
  ai: "ai model judge risk sensitivity strict balanced suggestions claude",
  editing: "apply confirm redline hash sha256 auto",
  security: "privacy retention sso audit open access data stored openrouter",
  usage: "limits rate documents storage postgres sqlite caps",
};

export function SettingsView() {
  const { settings, set, reset } = useSettings();
  const route = useRoute();
  const [status, setStatus] = useState<SettingsStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState<SectionId>("general");

  useEffect(() => {
    let live = true;
    void api.settingsStatus().then((r) => {
      if (!live) return;
      if (r.ok) setStatus(r.data);
      else setFailed(true);
    });
    return () => { live = false; };
  }, []);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return SECTIONS.filter(([id, title, sub]) => !needle || `${title} ${sub} ${KEYWORDS[id]}`.toLowerCase().includes(needle));
  }, [q]);
  const show = (id: SectionId) => visible.some(([v]) => v === id);

  useEffect(() => {
    if (route.name !== "settings" || !route.section) return;
    setActive(route.section);
    const frame = requestAnimationFrame(() => {
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      scrollToSection(route.section!, reduced ? "auto" : "smooth");
    });
    return () => cancelAnimationFrame(frame);
  }, [route.name, route.name === "settings" ? route.section : undefined]);

  const judges = status?.ai.judges ?? [];
  const num = (n: number) => n.toLocaleString();

  return (
    <div className="settings-page flex h-full min-h-0 flex-col overflow-y-auto bg-canvas">
      <header className="settings-header sticky top-0 z-10 flex flex-wrap items-end justify-between gap-4 border-b border-line bg-canvas/90 px-6 pb-4 pt-6 backdrop-blur-xl sm:px-8">
        <div className="min-w-0">
          <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted"><span className="size-1.5 rounded-full bg-accent" /> Preferences</div>
          <h1 className="text-[28px] font-semibold tracking-[-0.045em]">Settings</h1>
          <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-muted">Tune how CLAUSE looks and works. Preferences are saved in this browser.</p>
        </div>
        <label className="settings-search group relative w-full sm:w-72">
          <MagnifyingGlass size={17} aria-hidden className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted transition-colors group-focus-within:text-accent" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search settings…"
            aria-label="Search settings"
            className="w-full rounded-xl border border-line-strong bg-paper py-2.5 pl-10 pr-3 text-[13px] shadow-[0_1px_2px_rgb(20_20_22/0.03)] transition-[border,box-shadow] placeholder:text-muted/80 focus:border-accent/50 focus:shadow-[0_0_0_3px_var(--color-accent-soft)]"
          />
        </label>
      </header>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-5 px-4 pb-10 pt-5 sm:px-8 min-[900px]:grid-cols-[210px_minmax(0,1fr)] min-[1200px]:gap-8">
        <nav aria-label="Settings sections" className="settings-nav flex gap-1.5 overflow-x-auto pb-1 min-[900px]:sticky min-[900px]:top-[118px] min-[900px]:flex-col min-[900px]:self-start min-[900px]:overflow-visible min-[900px]:pb-0">
          {visible.map(([id, title]) => (
            <a
              key={id}
              href={`#/settings/${id}`}
              aria-current={active === id ? "location" : undefined}
              onClick={(event) => {
                event.preventDefault();
                setActive(id);
                if (route.name === "settings" && route.section === id) {
                  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
                  scrollToSection(id, reduced ? "auto" : "smooth");
                } else {
                  navigate({ name: "settings", section: id });
                }
              }}
              className={`settings-nav-item relative isolate flex shrink-0 items-center gap-2.5 whitespace-nowrap rounded-xl px-3 py-2.5 text-[13px] font-medium transition-colors ${active === id ? "text-accent" : "text-muted hover:bg-line/60 hover:text-ink"}`}
            >
              {active === id && <motion.span layoutId="settings-active" className="absolute inset-0 z-0 rounded-xl bg-accent-soft" transition={{ type: "spring", bounce: 0.12, duration: 0.35 }} />}
              <span className="relative z-10 inline-flex items-center gap-2.5">
                <motion.span
                  key={`${id}-${active === id ? "active" : "idle"}`}
                  className="inline-flex"
                  initial={active === id ? { scale: 0.82, rotate: -10 } : false}
                  animate={{ scale: 1, rotate: 0 }}
                  transition={{ type: "spring", stiffness: 440, damping: 20 }}
                ><SettingsSectionIcon id={id} size={19} weight={active === id ? "duotone" : "regular"} aria-hidden /></motion.span>
                {title}
              </span>
            </a>
          ))}
          {visible.length === 0 && <p className="px-3 py-2 text-sm text-muted">No settings match “{q}”.</p>}
        </nav>

        <div className="settings-columns min-w-0">
        <div className="settings-primary min-w-0 space-y-4">
          {show("general") && (
            <Card id="general" title="General" subtitle={SECTIONS[0][2]}>
              <Row label="Date format" htmlFor="s-date" note="Used in the document header and the Activity tab.">
                <Select id="s-date" value={settings.dateFormat} onChange={(v) => set("dateFormat", v)} options={[["locale", "Browser default"], ["iso", "2026-10-05 14:07"], ["us", "10/05/2026 14:07"], ["eu", "05/10/2026 14:07"]]} />
              </Row>
            </Card>
          )}

          {show("ai") && (
            <Card id="ai" title="AI & Models" subtitle={SECTIONS[1][2]}>
              {failed ? <p className="py-3 text-sm text-muted">Couldn’t load server model settings.</p> : !status ? <p className="py-3 text-sm text-muted">Loading configured models…</p> : <ModelList judges={judges} suggestionModel={status.ai.suggestionModel} />}
              <Row label="Risk sensitivity" htmlFor="s-strict" note="Strict: a semantic PASS needs every judge to be at least 80% sure, otherwise it becomes NEEDS_REVIEW. It never makes a check less cautious.">
                <Select id="s-strict" value={settings.strictness} onChange={(v) => set("strictness", v)} options={[["balanced", "Balanced (default)"], ["strict", "Strict"]]} />
              </Row>
              <Row label="Show the AI tab" htmlFor="s-ai" note="Hides the suggestions tab on this screen. Does not change the server.">
                <Toggle id="s-ai" checked={settings.aiTab} onChange={(v) => set("aiTab", v)} />
              </Row>
            </Card>
          )}

          {show("editing") && (
            <Card id="editing" title="Document & Editing" subtitle={SECTIONS[2][2]}>
              <Row label="Confirm before applying" htmlFor="s-confirm" note="Asks once more before a staged change becomes a new version.">
                <Toggle id="s-confirm" checked={settings.confirmApply} onChange={(v) => set("confirmApply", v)} />
              </Row>
              <Row label="Open the redline automatically" htmlFor="s-redline" note="Switches to Redline as soon as a staged change validates.">
                <Toggle id="s-redline" checked={settings.autoRedline} onChange={(v) => set("autoRedline", v)} />
              </Row>
              <Row label="Show SHA-256 in the document header" htmlFor="s-hash">
                <Toggle id="s-hash" checked={settings.showHash} onChange={(v) => set("showHash", v)} />
              </Row>
            </Card>
          )}

          {show("security") && (
            <Card id="security" title="Security & Privacy" subtitle={SECTIONS[3][2]}>
              <Fact label="Access" note="No sign-in. Anyone with the link can read, and edit or delete their own documents. The five sample contracts are read-only; copy one to edit it." value={status?.access === "open" ? "Open demo" : failed ? "Unavailable" : "Loading…"} />
              <Fact label="What is stored" value="Document text, every version, requirements, content hashes" />
              <Fact label="AI checks send document text to" note="Only when you run a check or ask for a suggestion." value="OpenRouter, then the model provider" />
              <Fact label="Retention" value="Kept until deleted by the operator" />
              <Fact label="Compliance attestations" note="See INFRA.md for the design." value="None claimed" />
            </Card>
          )}

          {show("usage") && (
            <Card id="usage" title="Usage & Limits" subtitle={SECTIONS[4][2]}>
              {failed && <p role="alert" className="py-3 text-sm text-del">Could not reach the server for its status.</p>}
              {status && (
                <>
                  <Fact label="Storage" value={status.storage === "postgres" ? "Postgres" : "SQLite"} />
                  <Fact label="Largest document" value={status.limits.maxDocumentChars === null ? "No cap (tested to 10 MB)" : `${num(status.limits.maxDocumentChars)} characters`} />
                  <Fact label="Largest text an AI judge reads" value={`${num(status.limits.maxJudgedChars)} characters`} />
                  <Fact label="Requirements per document" value={status.limits.maxRequirementsPerDocument} />
                  <Fact label="AI checks per IP" value={`${status.limits.checkPerHour} / hour`} />
                  <Fact label="AI suggestions per IP" value={`${status.limits.suggestPerHour} / hour`} />
                  <Fact label="Build" value={<code>{status.version}</code>} />
                </>
              )}
            </Card>
          )}

          <div className="flex justify-end pt-1">
            <button type="button" onClick={reset} className="rounded-lg border border-line-strong bg-paper px-3.5 py-2 text-[13px] font-medium text-muted transition-colors hover:border-fail/30 hover:bg-fail-bg hover:text-fail">Reset my preferences</button>
          </div>
        </div>
        <aside className="settings-secondary min-w-0" aria-label="Workspace and server settings">
          <section className="settings-note-card overflow-hidden rounded-[20px] border border-line bg-paper p-5 sm:p-6">
            <div className="flex items-start gap-3.5">
              <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-accent-soft text-accent"><SettingsSectionIcon id="general" size={22} weight="duotone" aria-hidden /></span>
              <div className="min-w-0 pt-0.5">
                <h2 className="text-[16px] font-semibold tracking-[-0.02em]">How settings apply</h2>
                <p className="mt-0.5 text-[13px] leading-relaxed text-muted">Know where each preference takes effect.</p>
              </div>
            </div>
            <div className="mt-4 space-y-3 border-t border-line pt-4">
              <div className="flex gap-3">
                <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-[10px] bg-accent-soft text-accent"><SettingsSectionIcon id="appearance" size={17} weight="duotone" aria-hidden /></span>
                <p className="text-[12px] leading-relaxed text-muted"><strong className="font-medium text-ink">Browser preferences</strong><br />Theme, date format, and editing choices stay on this device.</p>
              </div>
              <div className="flex gap-3">
                <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-[10px] bg-accent-soft text-accent"><SettingsSectionIcon id="ai" size={17} weight="duotone" aria-hidden /></span>
                <p className="text-[12px] leading-relaxed text-muted"><strong className="font-medium text-ink">Server configuration</strong><br />Model and storage details are shared and read-only here.</p>
              </div>
            </div>
          </section>
        </aside>
        </div>
      </div>
    </div>
  );
}
