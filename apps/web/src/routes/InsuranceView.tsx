import { useState } from "react";
import { applyChanges } from "@clause/engine";
import { DocPane } from "../components/DocPane.tsx";
import { Button } from "../ui/Button.tsx";
import { agreement, agreementRequirement, email, factsFor, playbook, review, schedule, type Check, type Source } from "../insurance/review.ts";

const oldText = "$2,000,000 per occurrence";
const newText = "$1,000,000 per occurrence";
const instruction = "Change the required liability limit from $2,000,000 per occurrence to $1,000,000 per occurrence so it matches the vendor's current schedule. Preserve all other wording and show which approved requirements this edit would affect.";
const edit = { operation: "replace" as const, target: { quote: { exact: oldText } }, replacement: newText };

export function InsuranceView() {
  const [revised, setRevised] = useState(false);
  const [selected, setSelected] = useState("agreement");
  const [quote, setQuote] = useState("");
  const [report, setReport] = useState<ReturnType<typeof review> | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [staged, setStaged] = useState(false);
  const [request, setRequest] = useState(false);
  const [task, setTask] = useState(false);
  const [replay, setReplay] = useState(false);
  const currentSchedule = schedule(revised);
  const sources = [agreement, currentSchedule, email];
  const availableSources = revised ? [...sources, schedule()] : sources;
  const selectedSource = availableSources.find(s => `${s.id}-${s.version}` === selected) ?? sources.find(s => s.id === selected) ?? agreement;
  const preview = applyChanges(agreement.text, [edit]);
  const stale = report !== null && report.provenance !== review(sources, factsFor(currentSchedule)).provenance;
  function runReview() {
    const next = review(sources, factsFor(currentSchedule));
    setReport(next);
    setHistory(h => [...new Set([...h, `${next.provenance} · ${next.checks.map(c => `${c.label}: ${c.status}`).join("; ")}`])]);
  }
  function openEvidence(source: Source, passage: string) { setSelected(`${source.id}-${source.version}`); setQuote(passage); }
  function showCheck(c: Check) {
    return <div key={c.label} className="border-b border-line py-3"><div className="flex justify-between gap-2"><strong>{c.label}</strong><span className={c.status === "Match" ? "text-pass" : "text-fail"}>{c.status}</span></div><p className="mt-1 text-muted">{c.reason}</p><div className="mt-1 flex flex-wrap gap-2">{c.evidence.map((e) => { const source = availableSources.find(s => s.id === e.source && s.version === e.version); return source ? <button className="underline" type="button" key={`${e.source}-${e.version}-${e.quote}`} onClick={() => openEvidence(source, e.quote)}>View {source.title} v{e.version}</button> : <span key={`${e.source}-${e.version}-${e.quote}`}>Source unavailable</span>; })}</div></div>;
  }
  function reset() { setRevised(false); setSelected("agreement"); setQuote(""); setReport(null); setHistory([]); setStaged(false); setRequest(false); setTask(false); setReplay(false); }
  const replaySources = [agreement, schedule(), email];
  const uncertain = factsFor(schedule());
  delete uncertain.entity;
  uncertain.limits = (uncertain.limits ?? []).map(x => ({ ...x, value: { ...x.value, basis: "unknown" as const } }));
  const cases = [
    { name: "Mismatch", docs: replaySources, facts: factsFor(schedule()) },
    { name: "Match", docs: [agreement, schedule(true), email], facts: factsFor(schedule(true)) },
    { name: "Uncertain", docs: replaySources, facts: uncertain },
  ];
  return <main className="h-full overflow-auto bg-canvas text-ink">
    <header className="border-b border-line bg-paper px-6 py-5"><div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-wider text-muted">Clause · Insurance Review / Synthetic demo</p><h1 className="font-display mt-1 text-2xl">Northline — Annual Vendor Insurance Review</h1><p className="mt-1 text-sm text-muted">Harborlight Hospitality · Scenario date: October 26, 2026 · Needs review</p></div><div className="flex gap-2"><Button onClick={reset}>Reset demo</Button><Button variant="primary" onClick={runReview}>Review evidence</Button></div></div><p className="mt-3 text-xs text-muted">Fictional data only. This public demo has no production tenancy or sign-in. Findings describe supplied records and are not a coverage, legal or underwriting determination.</p></header>
    <div className="grid h-[calc(100vh-180px)] min-h-[560px] grid-cols-[220px_minmax(300px,1fr)_360px] max-[1100px]:h-auto max-[1100px]:grid-cols-1">
      <aside className="overflow-y-auto border-r border-line bg-paper p-4"><h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">Case documents</h2>{sources.map(s => <button type="button" key={s.id} onClick={() => { setSelected(s.id); setQuote(""); }} className={`mb-1 block w-full rounded-control p-3 text-left text-sm ${(selected === s.id || selected === `${s.id}-${s.version}`) ? "bg-accent-soft" : "hover:bg-canvas"}`}><strong>{s.title}</strong><span className="mt-1 block text-xs text-muted">Synthetic · v{s.version}</span></button>)}{revised && <button type="button" className="block w-full rounded-control p-3 text-left text-sm underline" onClick={() => { setSelected("schedule-1"); setQuote(""); }}>Prior synthetic schedule · v1</button>}<div className="mt-5 border-t border-line pt-4 text-sm"><strong>Approved playbook · v{playbook.version}</strong><p className="mt-2 text-muted">Northline Facilities LLC · Commercial General Liability · $2,000,000 per occurrence · covers October 1–December 31, 2026.</p></div></aside>
      <section className="min-w-0 overflow-y-auto p-4" aria-label="Source viewer"><div className="flex flex-wrap justify-between gap-2 px-2"><div><h2 className="font-semibold">{selectedSource.title}</h2><p className="text-xs text-muted">Synthetic source · immutable fixture v{selectedSource.version}{selectedSource.id === "agreement" ? " · awaiting final review" : ""}</p></div>{quote && <button type="button" className="text-sm underline" onClick={() => setQuote("")}>Clear passage</button>}</div>{quote && <p role="status" className="mt-3 rounded-control bg-accent-soft p-3 text-sm">Verified passage · {selectedSource.title} v{selectedSource.version} · characters {selectedSource.text.indexOf(quote) + 1}–{selectedSource.text.indexOf(quote) + quote.length}: “{quote}”</p>}{staged && selectedSource.id === "agreement" && <p className="mt-3 rounded-control bg-pass-bg p-3 text-sm">Redline preview. Original v1 remains unchanged until a valid edit is applied.</p>}<DocPane content={selectedSource.text} hits={quote ? [{ start: selectedSource.text.indexOf(quote), end: selectedSource.text.indexOf(quote) + quote.length, kind: "hit" }] : []} selection={null} redline={staged && selectedSource.id === "agreement" && preview.ok ? preview.value.applied : null} onSelect={() => {}} /></section>
      <aside className="overflow-y-auto border-l border-line bg-paper p-5 text-sm"><h2 className="font-display text-xl">Review & actions</h2><p className="mt-1 text-muted">Deterministic checks from labeled synthetic facts. No AI provider is used.</p>{report ? <><p className={`mt-4 rounded-control p-3 font-semibold ${stale ? "bg-canvas" : "bg-fail-bg"}`}>{stale ? "Review is stale: new evidence requires re-review." : revised ? "The supplied schedule's stated per-occurrence limit now matches the demo playbook." : "The $2M aggregate limit does not satisfy this playbook's $2M per-occurrence requirement."}</p>{report.checks.map(showCheck)}<button type="button" className="mt-2 underline" onClick={() => openEvidence(currentSchedule, "General aggregate: $2,000,000.")}>View aggregate limit · v{currentSchedule.version}</button><br /><button type="button" className="mt-2 underline" onClick={() => openEvidence(agreement, "Northline Facilities LLC shall maintain commercial general liability insurance with a limit of not less than $2,000,000 per occurrence throughout the service period.")}>View agreement requirement · v1</button><details className="mt-3"><summary>Review details and history</summary><p className="mt-2 break-words text-xs text-muted">{report.provenance}</p>{history.map((h) => <p className="mt-2 break-words text-xs text-muted" key={h}>{h}</p>)}</details></> : <p className="mt-4 rounded-control bg-canvas p-3">Review the supplied evidence to compare it with the approved playbook.</p>}
      <div className="mt-5 border-t border-line pt-4"><h3 className="font-semibold">Reviewer actions</h3><div className="mt-2 flex flex-wrap gap-2"><Button onClick={() => setRequest(true)}>Prepare clarification</Button><Button onClick={() => setTask(true)}>Record task</Button></div>{request && <p className="mt-3 rounded-control bg-canvas p-3">Draft only · Please provide an updated policy schedule showing commercial general liability coverage of at least $2,000,000 per occurrence for Northline Facilities LLC throughout October 1–December 31, 2026. Please clarify the discrepancy with the current schedule. <strong>Not sent.</strong></p>}{task && <p className="mt-2 rounded-control bg-canvas p-3">Task recorded in this demo session: follow up on the schedule and review the supplied evidence.</p>}</div>
      <div className="mt-5 border-t border-line pt-4"><h3 className="font-semibold">Document assistant · suggested instruction</h3><p className="mt-2 text-muted">{instruction}</p><div className="mt-3 flex flex-wrap gap-2"><Button onClick={() => { setStaged(true); setSelected("agreement"); setQuote(""); }}>Stage suggestion</Button>{staged && <Button onClick={() => setStaged(false)}>Discard proposal</Button>}</div>{staged && <p role="status" className="mt-3 rounded-control bg-fail-bg p-3">{preview.ok ? `Valid text replacement. ${agreementRequirement(preview.value.content).reason} Insurance evidence remains unchanged. Human authorization is required; Clause CI is advisory.` : "The edit could not be resolved."}</p>}</div>
      <div className="mt-5 border-t border-line pt-4"><h3 className="font-semibold">Incoming evidence</h3><p className="mt-2 text-muted">A synthetic revised schedule received from the issuer states $2,000,000 per occurrence.</p><Button className="mt-3" onClick={() => { setRevised(true); setSelected("schedule"); setQuote(""); }} disabled={revised}>Introduce revised schedule</Button></div>
      <div className="mt-5 border-t border-line pt-4"><Button onClick={() => setReplay(!replay)}>{replay ? "Hide replay" : "Replay scenarios"}</Button>{replay && <div className="mt-3 space-y-3">{cases.map(c => { const result = review(c.docs, c.facts); return <div key={c.name} className="rounded-control bg-canvas p-3"><strong>{c.name}</strong><p className="mt-1 text-xs">{result.provenance}</p>{result.checks.map(x => <p key={x.label} className="mt-1 text-xs">{x.label}: {x.status} — {x.reason}</p>)}</div>; })}<p className="text-xs text-muted">3 scenarios evaluated. Three illustrative examples; no reliability claim.</p></div>}</div></aside>
    </div><footer className="border-t border-line px-6 py-4 text-xs text-muted">Independent proposed demonstration inspired by Sequence’s public operating thesis. Not an official Sequence or Atlas product or a replica of internal systems. Session data resets on reload.</footer>
  </main>;
}
