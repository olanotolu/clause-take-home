import { useEffect, useMemo, useState } from "react";
import { api, type SettingsStatus } from "../../lib/api.ts";
import { useSettings } from "../../lib/settings.tsx";
import { Card, Fact, Planned, Row, Select, Toggle } from "./parts.tsx";

const SECTIONS = [
  ["general", "General", "Display preferences for this browser."],
  ["ai", "AI & Models", "How the AI checks behave. Models themselves are set on the server."],
  ["editing", "Document & Editing", "How staged changes are reviewed and applied."],
  ["security", "Security & Privacy", "What this deployment does with your documents."],
  ["appearance", "Appearance", "Theme."],
  ["usage", "Usage & Limits", "Live numbers from the server."],
  ["planned", "Planned", "Shown in the product design; not built in this prototype."],
] as const;

type SectionId = (typeof SECTIONS)[number][0];

/** What each section contains, as searchable text (the page filters sections by this). */
const KEYWORDS: Record<SectionId, string> = {
  general: "date format language workspace time zone export",
  ai: "ai model judge risk sensitivity strict balanced suggestions jev claude",
  editing: "apply confirm redline hash sha256 auto",
  security: "privacy retention sso audit open access data stored openrouter",
  appearance: "theme dark light system",
  usage: "limits rate documents storage postgres sqlite caps",
  planned: "integrations slack drive microsoft github sso billing team playbooks templates",
};

export function SettingsView() {
  const { settings, set, reset } = useSettings();
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

  const judges = status?.ai.judges ?? [];
  const num = (n: number) => n.toLocaleString();

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-canvas">
      <header className="flex flex-wrap items-end justify-between gap-3 px-8 pb-4 pt-6 max-[640px]:px-4">
        <div>
          <h1 className="text-2xl font-bold">Settings</h1>
          <p className="text-sm text-muted">Everyone who opens this URL shares one workspace. Preferences below are saved in your browser only.</p>
        </div>
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search settings…"
          aria-label="Search settings"
          className="w-72 max-w-full rounded-lg border border-line bg-paper px-3 py-2 text-sm"
        />
      </header>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 px-8 pb-10 max-[640px]:px-4 min-[900px]:grid-cols-[200px_minmax(0,1fr)]">
        <nav aria-label="Settings sections" className="flex gap-1 overflow-x-auto min-[900px]:sticky min-[900px]:top-0 min-[900px]:flex-col min-[900px]:self-start">
          {visible.map(([id, title]) => (
            <a
              key={id}
              href={`#${id}`}
              aria-current={active === id}
              onClick={() => setActive(id)}
              className={`whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium ${active === id ? "bg-accent/10 text-accent" : "text-muted hover:bg-line/50"}`}
            >
              {title}
            </a>
          ))}
          {visible.length === 0 && <p className="px-3 py-2 text-sm text-muted">No settings match “{q}”.</p>}
        </nav>

        <div className="space-y-5">
          {show("general") && (
            <Card id="general" title="General" subtitle={SECTIONS[0][2]}>
              <Row label="Date format" htmlFor="s-date" note="Used in the History tab.">
                <Select id="s-date" value={settings.dateFormat} onChange={(v) => set("dateFormat", v)} options={[["locale", "Browser default"], ["iso", "2026-10-05 14:07"], ["us", "10/05/2026 14:07"], ["eu", "05/10/2026 14:07"]]} />
              </Row>
              <Planned label="Workspace name, logo and description" note="There are no accounts or workspaces yet." />
              <Planned label="Default language and time zone" />
            </Card>
          )}

          {show("ai") && (
            <Card id="ai" title="AI & Models" subtitle={SECTIONS[1][2]}>
              <Fact
                label="Judges on this server"
                note="Read-only. Chosen by the server's environment so one visitor cannot change the shared AI bill."
                value={failed ? "Unavailable" : !status ? "Loading…" : judges.length ? judges.join(", ") : "None configured"}
              />
              <Fact label="AI edit suggestions" note="Server side." value={failed ? "Unavailable" : !status ? "Loading…" : status.ai.suggestions ? "Available" : "Not configured"} />
              <Row label="Risk sensitivity" htmlFor="s-strict" note="Strict: a semantic PASS needs every judge to be at least 80% sure, otherwise it becomes NEEDS_REVIEW. It never makes a check less cautious.">
                <Select id="s-strict" value={settings.strictness} onChange={(v) => set("strictness", v)} options={[["balanced", "Balanced (default)"], ["strict", "Strict"]]} />
              </Row>
              <Row label="Show the AI tab" htmlFor="s-ai" note="Hides the suggestions tab on this screen. Does not change the server.">
                <Toggle id="s-ai" checked={settings.aiTab} onChange={(v) => set("aiTab", v)} />
              </Row>
              <Planned label="Choose primary and secondary model" note="Model choice stays on the server." />
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
              <Planned label="Templates and playbooks" />
            </Card>
          )}

          {show("security") && (
            <Card id="security" title="Security & Privacy" subtitle={SECTIONS[3][2]}>
              <Fact label="Access" note="No sign-in. Anyone with the link can read and edit." value={status?.access === "open" ? "Open demo" : failed ? "Unavailable" : "Loading…"} />
              <Fact label="What is stored" value="Document text, every version, requirements, content hashes" />
              <Fact label="AI checks send document text to" note="Only when you run a check or ask for a suggestion." value="OpenRouter, then the model provider" />
              <Fact label="Retention" value="Kept until deleted by the operator" />
              <Planned label="SSO / SAML" />
              <Planned label="Audit logs" />
              <Planned label="SOC 2 / GDPR attestations" note="Not claimed; see INFRA.md for the design." />
            </Card>
          )}

          {show("appearance") && (
            <Card id="appearance" title="Appearance" subtitle={SECTIONS[4][2]}>
              <Row label="Theme" htmlFor="s-theme">
                <Select id="s-theme" value={settings.theme} onChange={(v) => set("theme", v)} options={[["system", "Match system"], ["light", "Light"], ["dark", "Dark"]]} />
              </Row>
            </Card>
          )}

          {show("usage") && (
            <Card id="usage" title="Usage & Limits" subtitle={SECTIONS[5][2]}>
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
              <Planned label="Plan, billing and upgrade" />
            </Card>
          )}

          {show("planned") && (
            <Card id="planned" title="Planned" subtitle={SECTIONS[6][2]}>
              <Planned label="Integrations: Google Drive, Microsoft 365, Slack, GitHub" />
              <Planned label="Team members and roles" />
              <Planned label="Playbooks and custom organisation rules" />
            </Card>
          )}

          <div className="flex justify-end">
            <button onClick={reset} className="rounded-md border border-line px-3 py-1.5 text-sm font-medium hover:bg-line/40">Reset my preferences</button>
          </div>
        </div>
      </div>
    </div>
  );
}
