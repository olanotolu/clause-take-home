import { Num } from "../ui/Num.tsx";
import { Activity, AlertTriangle, ArrowRight, Ban, Check, CheckCircle2, CircleSlash, Clock, Lock, ListChecks, Play, ShieldAlert, Sparkles, XCircle } from "../ui/icons.tsx";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Applied, CheckOutcome, Delta, Evidence, RequirementKind, RequirementReport, Verdict } from "../lib/api.ts";
import { cn } from "../lib/cn.ts";
import { pct, shortModel } from "../lib/confidence.ts";
import { navigate } from "../lib/router.ts";
import { useSettings } from "../lib/settings.tsx";
import { plural } from "../lib/wordDelta.ts";
import { useWorkspace } from "../lib/workspace.tsx";
import { Button } from "../ui/Button.tsx";
import { TextShimmer } from "../ui/motion/text-shimmer.tsx";
import { EmptyState, Pill, Skeleton, StatusPill, type Tone } from "../ui/bits.tsx";

const VERDICT_TONE: Record<Verdict, Tone> = { PASS: "pass", FAIL: "fail", NEEDS_REVIEW: "review", UNAVAILABLE: "neutral" };
const VERDICT_WORD: Record<Verdict, string> = { PASS: "Holds", FAIL: "Fails", NEEDS_REVIEW: "Needs review", UNAVAILABLE: "Not checked" };
const DELTA_WORD: Record<Delta, string> = { held: "Held", regressed: "Broken by this edit", achieved: "Newly satisfied", still_failing: "Still failing", uncertain: "Uncertain" };
const DELTA_TONE: Record<Delta, Tone> = { held: "neutral", regressed: "fail", achieved: "pass", still_failing: "review", uncertain: "review" };
const KIND_WORD: Record<RequirementKind | "goal", string> = { goal: "Goal for this edit", unchanged: "Keep verbatim", present: "Must contain", absent: "Must not contain", semantic: "Statement (AI-judged)" };
const KIND_ICON: Record<RequirementKind | "goal", ReactNode> = {
  goal: <Sparkles size={13} aria-hidden />, unchanged: <Lock size={13} aria-hidden />, present: <Check size={13} aria-hidden />, absent: <Ban size={13} aria-hidden />, semantic: <Sparkles size={13} aria-hidden />,
};

function VerdictIcon({ v, size = 18 }: { v: Verdict; size?: number }) {
  if (v === "PASS") return <CheckCircle2 size={size} className="shrink-0 text-pass" aria-label="Holds" />;
  if (v === "FAIL") return <XCircle size={size} className="shrink-0 text-fail" aria-label="Fails" />;
  if (v === "NEEDS_REVIEW") return <AlertTriangle size={size} className="shrink-0 text-review" aria-label="Needs review" />;
  return <CircleSlash size={size} className="shrink-0 text-muted" aria-label="Not checked" />;
}

/** A readable window of `text` around an evidence span, with the span itself marked. Defensive: only marks what really matches. */
function Excerpt({ text, evidence, empty }: { text: string; evidence: Evidence[]; empty: string }) {
  const ev = evidence.find((e) => e.verified && text.slice(e.start, e.end) === e.quote);
  if (!ev) {
    const loose = evidence[0];
    return (
      <div>
        <p className="text-sm text-muted">{loose ? "The judge quoted text that is not in this version:" : empty}</p>
        {loose && <p className="doc mt-1 !text-[14px] !leading-snug text-muted line-through">“{loose.quote.slice(0, 200)}”</p>}
      </div>
    );
  }
  const R = 170;
  const from = Math.max(0, ev.start - R);
  const to = Math.min(text.length, ev.end + R);
  return (
    <p className="doc !text-[14.5px] !leading-relaxed">
      {from > 0 && "… "}
      {text.slice(from, ev.start)}
      <span className="ev">{text.slice(ev.start, ev.end)}</span>
      {text.slice(ev.end, to)}
      {to < text.length && " …"}
    </p>
  );
}

function Summary({ reqs, ms, judges, version, strict, hasEdit }: { reqs: RequirementReport[]; ms: number; judges: string[]; version: number; strict: boolean; hasEdit: boolean }) {
  const holding = reqs.filter((r) => r.after.verdict === "PASS").length;
  const broken = reqs.filter((r) => r.delta === "regressed").length;
  const attention = reqs.length - holding;
  const failed = reqs.filter((r) => r.after.verdict === "FAIL").length;
  const needsReview = reqs.filter((r) => r.after.verdict === "NEEDS_REVIEW").length;
  const unavailable = reqs.filter((r) => r.after.verdict === "UNAVAILABLE").length;
  const statusTone: Tone = reqs.length === 0 ? "neutral" : attention === 0 ? "pass" : failed > 0 ? "fail" : "review";
  const statusLabel = reqs.length === 0 ? "No requirements configured" : attention === 0 ? "All requirements hold" : broken > 0 ? `${broken} broken by this edit` : failed > 0 ? `${failed} requirements fail` : "Review needed";
  const segs: { n: number; cls: string; label: string }[] = [
    { n: holding, cls: "bg-pass", label: "hold" },
    { n: reqs.filter((r) => r.after.verdict === "NEEDS_REVIEW").length, cls: "bg-review", label: "need review" },
    { n: reqs.filter((r) => r.after.verdict === "FAIL").length, cls: "bg-fail", label: "fail" },
    { n: reqs.filter((r) => r.after.verdict === "UNAVAILABLE").length, cls: "bg-line-strong", label: "not checked" },
  ];
  return (
    <section aria-label="Clause CI results summary" className="overflow-hidden rounded-card border border-line bg-paper">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3.5 sm:px-5">
        <div className="flex min-w-0 items-center gap-3">
          {reqs.length === 0 ? <ListChecks size={21} className="shrink-0 text-muted" aria-hidden /> : attention === 0 ? <CheckCircle2 size={21} className="shrink-0 text-pass" aria-hidden /> : failed > 0 ? <ShieldAlert size={21} className="shrink-0 text-fail" aria-hidden /> : <AlertTriangle size={21} className="shrink-0 text-review" aria-hidden />}
          <div className="min-w-0">
            <h2 className="text-[16px] font-semibold tracking-[-0.02em]">Clause CI results</h2>
            <p className="text-xs text-muted">Checked {hasEdit ? "the proposed changes" : "current text"} against v{version}{strict ? " · strict sensitivity" : ""}</p>
          </div>
        </div>
        <StatusPill tone={statusTone}>{statusLabel}</StatusPill>
      </header>

      <div className="grid grid-cols-2 divide-x divide-y divide-line sm:grid-cols-4 sm:divide-y-0">
        <div className="px-4 py-3.5 sm:px-5">
          <p className="flex items-center gap-1.5 text-[11px] font-medium text-muted"><CheckCircle2 size={13} aria-hidden />Requirements hold</p>
          <p className="tnum mt-1 text-[20px] font-semibold leading-none"><Num value={holding} /><span className="ml-1 text-[13px] font-normal text-muted">/ {reqs.length}</span></p>
        </div>
        <div className="px-4 py-3.5 sm:px-5">
          <p className="flex items-center gap-1.5 text-[11px] font-medium text-muted"><AlertTriangle size={13} aria-hidden />Need attention</p>
          <p className="tnum mt-1 text-[20px] font-semibold leading-none">{attention}</p>
          {(needsReview > 0 || unavailable > 0) && <p className="mt-1 text-[10px] text-muted">{[needsReview && `${needsReview} review`, unavailable && `${unavailable} not checked`].filter(Boolean).join(" · ")}</p>}
        </div>
        <div className="px-4 py-3.5 sm:px-5">
          <p className="flex items-center gap-1.5 text-[11px] font-medium text-muted"><ListChecks size={13} aria-hidden />Requirements checked</p>
          <p className="tnum mt-1 text-[20px] font-semibold leading-none">{reqs.length}</p>
        </div>
        <div className="px-4 py-3.5 sm:px-5">
          <p className="flex items-center gap-1.5 text-[11px] font-medium text-muted"><Clock size={13} aria-hidden />Analysis time</p>
          <p className="tnum mt-1 text-[20px] font-semibold leading-none">{(ms / 1000).toFixed(1)}<span className="ml-1 text-[13px] font-normal text-muted">s</span></p>
        </div>
      </div>

      <div className="border-t border-line px-4 py-3 sm:px-5">
        <div role="img" aria-label={segs.filter((s) => s.n).map((s) => `${s.n} ${s.label}`).join(", ") || "No requirements were checked"} className="flex h-1.5 overflow-hidden rounded-full bg-line">
        {segs.filter((s) => s.n).map((s, i) => <div key={s.label} className={cn("grow-x", s.cls)} style={{ flex: s.n, animationDelay: `${i * 90}ms` }} />)}
        </div>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <p className="text-[11px] text-muted">{reqs.length === 0 ? "Add requirements to check this document." : "Exact checks use literal matching. AI judgments are advisory and cite document evidence."}</p>
          <p className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted"><Activity size={13} aria-hidden />Configured judges: {judges.length ? judges.map((j) => <Pill key={j}>{shortModel(j)}</Pill>) : "none · exact checks only"}</p>
        </div>
      </div>
    </section>
  );
}

function JudgeList({ outcome, label }: { outcome: CheckOutcome; label: string }) {
  if (!outcome.judges || outcome.judges.length === 0) return null;
  return (
    <div>
      <h4 className="mb-1 text-xs font-medium text-muted">{label}</h4>
      <ul className="space-y-1.5">
        {outcome.judges.map((j) => (
          <li key={j.id} className="rounded-control border border-line bg-canvas px-3 py-2 text-[13px]">
            <p className="flex flex-wrap items-center gap-x-2"><strong className="font-semibold">{shortModel(j.id)}</strong><span className="text-muted">{j.label.replaceAll("_", " ")}</span>{j.probability !== undefined && <span className="tnum text-muted">· {pct(j.probability)} says it holds</span>}</p>
            {j.rationale && <p className="mt-0.5 text-ink/80">{j.rationale}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Detail({ r, original, proposed, hasEdit, version, applied, onJump }: { r: RequirementReport; original: string; proposed: string; hasEdit: boolean; version: number; applied: Applied[]; onJump: (e: Evidence) => void }) {
  const jumpable = r.before.evidence.find((e) => e.verified);
  const p0 = r.before.judges?.find((j) => j.probability !== undefined)?.probability;
  const p1 = r.after.judges?.find((j) => j.probability !== undefined)?.probability;
  const callout = r.after.verdict === "PASS" ? "bg-pass-bg text-ink" : r.after.verdict === "FAIL" ? "bg-fail-bg text-ink" : r.after.verdict === "NEEDS_REVIEW" ? "bg-review-bg text-ink" : "bg-line/60 text-ink";
  return (
    <article key={r.id} aria-labelledby="ci-detail-h" className="fade-up min-w-0 space-y-4 rounded-card border border-line bg-paper p-4 sm:p-5">
      <header className="border-b border-line pb-3">
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <span className="inline-flex items-center gap-1 font-medium">{KIND_ICON[r.kind]}{KIND_WORD[r.kind]}</span>
          <StatusPill tone={VERDICT_TONE[r.after.verdict]}>{VERDICT_WORD[r.after.verdict]}</StatusPill>
          <StatusPill tone={DELTA_TONE[r.delta]} icon={false}>{DELTA_WORD[r.delta]}</StatusPill>
        </p>
        <h3 id="ci-detail-h" className="font-display mt-2 text-xl font-semibold leading-snug">{r.text.length > 240 ? `${r.text.slice(0, 240)}…` : r.text}</h3>
      </header>

      <div className={`rounded-control px-4 py-3 text-sm ${callout}`}>
        <p className="font-semibold">{r.delta === "regressed" ? "What changed" : "Result"}</p>
        <p className="mt-0.5">{r.after.detail}</p>
        {r.before.verdict !== "PASS" && r.before.detail !== r.after.detail && <p className="mt-1 text-xs text-muted">Before the edit: {r.before.detail}</p>}
        {r.touchedBy.length > 0 && <p className="mt-1 text-xs text-muted">Overlapped by {r.touchedBy.length === 1 ? "change" : "changes"} {r.touchedBy.map((i) => `#${i + 1}`).join(", ")}.</p>}
      </div>

      <section aria-label="Evidence comparison" className="grid gap-3 min-[760px]:grid-cols-2">
        <div className="min-w-0 rounded-control border border-line bg-canvas p-3.5">
          <h4 className="mb-2 flex items-center justify-between gap-2 text-xs font-semibold">
            <span>Original <span className="font-normal text-muted">· v{version}</span></span>
            {jumpable && <button onClick={() => onJump(jumpable)} className="font-medium text-accent underline underline-offset-2">Show in document</button>}
          </h4>
          <Excerpt text={original} evidence={r.before.evidence} empty={r.kind === "absent" ? "Nothing matched, as required." : "No passage found that addresses this."} />
        </div>
        <div className="min-w-0 rounded-control border border-line bg-canvas p-3.5">
          <h4 className="mb-2 text-xs font-semibold">{hasEdit ? <>Proposed <span className="font-normal text-muted">· v{version + 1}</span></> : "Current text"}</h4>
          {hasEdit ? (
            <>
              <Excerpt text={proposed} evidence={r.after.evidence} empty={r.kind === "absent" ? "Nothing matched, as required." : "No passage found that addresses this."} />
              {r.touchedBy.length > 0 && r.after.evidence.length === 0 && (
                <p className="mt-2 text-[13px] text-muted">
                  It was replaced by{" "}
                  {r.touchedBy.map((i, k) => <span key={i}>{k > 0 && ", "}{applied[i]?.after ? <span className="ins px-0.5">{applied[i]!.after}</span> : <em>nothing (deleted)</em>}</span>)}.
                </p>
              )}
            </>
          ) : <p className="text-sm text-muted">Stage a change to compare it against the original.</p>}
        </div>
      </section>

      {(p0 !== undefined || p1 !== undefined) && (
        <section aria-label="Model confidence">
          <h4 className="text-xs font-medium text-muted">What the model reported</h4>
          <p className="tnum mt-1 flex flex-wrap items-center gap-2 text-sm">
            <span>{p0 !== undefined ? pct(p0) : "n/a"} that it holds in the original</span>
            <ArrowRight size={13} className="text-muted" aria-hidden />
            <span>{p1 !== undefined ? pct(p1) : "n/a"} {hasEdit ? "after the edit" : "now"}</span>
          </p>
          <p className="mt-1 text-xs text-muted">These are the model's own numbers, not calibrated probabilities. In the benchmark (60 NDA items) the model's probabilities scored a Brier of 0.069, which says little about other contract types.</p>
        </section>
      )}

      <JudgeList outcome={r.after} label={hasEdit ? "Judges, after the edit" : "Judges"} />
      {hasEdit && r.before.judges && r.before.judges.length > 0 && <JudgeList outcome={r.before} label="Judges, before the edit" />}
    </article>
  );
}

export function CiTab() {
  const ws = useWorkspace();
  const { settings } = useSettings();
  const doc = ws.doc!;
  const [selected, setSelected] = useState<string | null>(null);
  const [onlyIssues, setOnlyIssues] = useState(false);
  const hasEdit = ws.staged.length > 0;
  const report = ws.ci.status === "done" ? ws.ci.report : null;

  const list = useMemo(() => (report ? report.requirements.filter((r) => !onlyIssues || r.after.verdict !== "PASS" || r.delta === "regressed") : []), [report, onlyIssues]);
  useEffect(() => {
    if (!report) return;
    const worst = report.requirements.find((r) => r.delta === "regressed") ?? report.requirements.find((r) => r.after.verdict !== "PASS") ?? report.requirements[0];
    setSelected((cur) => (cur && report.requirements.some((r) => r.id === cur) ? cur : (worst?.id ?? null)));
  }, [report]);
  const current = report?.requirements.find((r) => r.id === selected) ?? null;

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-canvas">
      <div className="mx-auto max-w-[1440px] space-y-4 p-6 max-[640px]:p-3">
        <section aria-label="Run" className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="min-w-0 flex-1 basis-80">
            <p className="mb-0.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">Document review</p>
            <h2 className="font-display text-[21px] font-semibold">Clause CI</h2>
            <p className="text-sm text-muted">
              {hasEdit ? `Checks this document's requirements against your ${plural(ws.staged.length, "staged change")}.` : "Checks this document's requirements against the current text. Stage a change to see what it would break."}
            </p>
          </div>
          {hasEdit && (
            <div className="min-w-0 basis-72">
              <label htmlFor="goal" className="text-xs font-medium text-muted">What should this edit achieve? (optional)</label>
              <input id="goal" value={ws.goal} onChange={(e) => ws.setGoal(e.target.value)} placeholder="e.g. Make confidentiality mutual" className="mt-1 h-9 w-full rounded-control border border-line-strong bg-paper px-3 text-sm" />
            </div>
          )}
          <Button variant="primary" icon={<Play size={14} aria-hidden />} loading={ws.ci.status === "loading"} onClick={() => void ws.runCi()}>
            {report ? "Re-run" : "Run Clause CI"}
          </Button>
        </section>

        {ws.ci.status === "idle" && (
          <div className="grid min-h-[48vh] place-items-center py-5">
            <section className="w-full max-w-xl rounded-card border border-line bg-paper p-5 sm:p-6">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">Ready to review</p>
              <EmptyState icon={<ListChecks size={26} aria-hidden />} title="No report for this version yet" action={<Button variant="secondary" onClick={() => navigate({ name: "doc", id: doc.id, tab: "edit" })}>Back to the document</Button>}>
                Add requirements from the Rules tab (select a clause and choose Protect), then run Clause CI. A report only describes the exact text and edit it ran on, so it disappears when either changes.
              </EmptyState>
            </section>
          </div>
        )}
        {ws.ci.status === "loading" && (
          <div className="space-y-3" aria-busy="true" aria-label="Running Clause CI">
            <Skeleton className="h-28 w-full" />
            <div className="grid gap-4 min-[900px]:grid-cols-[320px_minmax(0,1fr)]"><Skeleton className="h-64" /><Skeleton className="h-64" /></div>
            <TextShimmer as="p" className="text-sm">Running exact checks, then asking the judges. Usually a few seconds.</TextShimmer>
          </div>
        )}
        {ws.ci.status === "error" && <p role="alert" className="flex gap-2 rounded-control bg-fail-bg px-4 py-3 text-sm text-fail"><XCircle size={16} className="mt-0.5 shrink-0" aria-hidden />{ws.ci.message}</p>}

        {report && (
          <>
            <div className="flex items-start gap-2 rounded-control border border-line bg-paper px-3.5 py-2.5 text-[12px] text-muted"><CheckCircle2 size={15} className="mt-0.5 shrink-0 text-pass" aria-hidden /><p><span className="font-semibold text-ink">Edit mechanics:</span> {report.mechanical.changes === 0 ? "no edit proposed" : `${plural(report.mechanical.changes, "change")} validated by the engine (target, version, no overlaps). Proven, not judged.`}</p></div>
            <Summary reqs={report.requirements} ms={report.elapsedMs} judges={report.judges} version={report.version} strict={settings.strictness === "strict"} hasEdit={hasEdit} />
            {report.requirements.length === 0 ? (
              <div className="py-2"><EmptyState icon={<ListChecks size={26} aria-hidden />} title="This document has no requirements yet">Select a clause in the document and choose Protect, or add a statement in the Rules tab, then run again.</EmptyState></div>
            ) : (
                <div className="grid items-start gap-4 min-[900px]:grid-cols-[minmax(280px,340px)_minmax(0,1fr)] min-[1280px]:gap-5">
                  <section aria-label="Requirements" className="space-y-2">
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-semibold">Requirements <span className="tnum font-normal text-muted">{report.requirements.length}</span></h3>
                      <label className="flex cursor-pointer items-center gap-2 text-xs text-muted">
                        <input type="checkbox" checked={onlyIssues} onChange={(e) => setOnlyIssues(e.target.checked)} /> Only issues
                      </label>
                    </div>
                    <ul className="space-y-1.5">
                      {list.map((r, i) => (
                        <li key={r.id} className="stagger" style={{ "--i": i } as React.CSSProperties}>
                          <button onClick={() => setSelected(r.id)} aria-current={selected === r.id} className={`flex w-full items-start gap-3 rounded-control border px-3 py-2.5 text-left transition-colors ${selected === r.id ? "border-accent bg-accent-soft" : "border-line bg-paper hover:bg-canvas"}`}>
                            <span className="mt-0.5"><VerdictIcon v={r.after.verdict} /></span>
                            <span className="min-w-0 flex-1">
                              <span className="line-clamp-2 text-sm font-medium leading-snug">{r.text}</span>
                              <span className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted"><span className="inline-flex items-center gap-1">{KIND_ICON[r.kind]}{KIND_WORD[r.kind]}</span><span className={r.delta === "regressed" ? "font-semibold text-fail" : ""}>{DELTA_WORD[r.delta]}</span></span>
                            </span>
                          </button>
                        </li>
                      ))}
                      {list.length === 0 && <li className="px-1 text-sm text-muted">No issues. Every requirement holds.</li>}
                    </ul>
                  </section>
                  {current && <Detail r={current} original={doc.content} proposed={ws.proposedText} hasEdit={hasEdit} version={report.version} applied={ws.preview.status === "valid" ? ws.preview.data.applied : []} onJump={(e) => { ws.showEvidence(e); navigate({ name: "doc", id: doc.id, tab: "edit" }); }} />}
                </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
