import type { CheckOutcome, CiReport as Report, Delta, Evidence, RequirementReport, Verdict } from "../lib/api.ts";

const VERDICT: Record<Verdict, { icon: string; label: string; cls: string }> = {
  PASS: { icon: "✓", label: "Pass", cls: "bg-canvas text-ink border-line" },
  FAIL: { icon: "✗", label: "Fail", cls: "bg-del-bg text-del border-del/30" },
  NEEDS_REVIEW: { icon: "?", label: "Review", cls: "bg-hit text-ink border-yellow-400/60" },
  UNAVAILABLE: { icon: "–", label: "N/A", cls: "bg-canvas text-muted border-line" },
};
const DELTA: Record<Delta, { text: string; cls: string }> = {
  held: { text: "Held", cls: "text-ink/70" },
  regressed: { text: "Regressed", cls: "font-semibold text-del" },
  achieved: { text: "Achieved", cls: "font-semibold text-ins" },
  still_failing: { text: "Still failing", cls: "font-semibold text-amber-700" },
  uncertain: { text: "Uncertain", cls: "font-semibold text-amber-700" },
};
const KIND: Record<string, string> = { goal: "Goal", unchanged: "Keep verbatim", present: "Must contain", absent: "Must not contain", semantic: "Statement" };

function Chip({ verdict }: { verdict: Verdict }) {
  const v = VERDICT[verdict];
  return <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-semibold ${v.cls}`}><span aria-hidden>{v.icon}</span>{v.label}</span>;
}

function EvidenceList({ outcome, onShow }: { outcome: CheckOutcome; onShow?: (e: Evidence) => void }) {
  if (outcome.evidence.length === 0) return null;
  return (
    <ul className="mt-1 space-y-1">
      {outcome.evidence.slice(0, 3).map((e, i) => (
        <li key={i} className="text-[12px]">
          {e.verified ? (
            onShow ? (
              <button onClick={() => onShow(e)} className="doc text-left !text-[12.5px] !leading-snug underline decoration-dotted underline-offset-2 hover:bg-hit" title="Show in the document">“{e.quote.length > 120 ? `${e.quote.slice(0, 120)}…` : e.quote}”</button>
            ) : (
              <span className="doc !text-[12.5px] !leading-snug">“{e.quote.length > 120 ? `${e.quote.slice(0, 120)}…` : e.quote}”</span>
            )
          ) : (
            <span className="doc !text-[12.5px] text-muted line-through" title="The model quoted this, but it does not appear in the document">“{e.quote.slice(0, 120)}”</span>
          )}
          {!e.verified && <span className="ml-1 text-[11px] text-muted">not found in the text</span>}
        </li>
      ))}
    </ul>
  );
}

function Row({ r, onShow }: { r: RequirementReport; onShow: (e: Evidence) => void }) {
  const d = DELTA[r.delta];
  return (
    <li className="rounded-lg border border-line bg-paper p-3 text-sm">
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">{KIND[r.kind]}</span>
          <span className="doc mt-0.5 block !text-[14px] !leading-snug">{r.text.length > 140 ? `${r.text.slice(0, 140)}…` : r.text}</span>
        </p>
        <span className={`shrink-0 text-[12px] ${d.cls}`}>{d.text}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
        <span>Now</span><Chip verdict={r.before.verdict} /><span aria-hidden>→</span><span>After edit</span><Chip verdict={r.after.verdict} />
      </div>
      <p className="mt-1.5 text-[13px] text-ink/80">{r.after.detail}</p>
      {/* A passing "after" needs no quote (it is the same passage shown below); show it only when it points at a problem. */}
      {r.after.verdict !== "PASS" && <EvidenceList outcome={r.after} />}
      {r.before.verdict !== "PASS" && r.before.detail !== r.after.detail && <p className="mt-1 text-[12px] text-muted">Before: {r.before.detail}</p>}
      <EvidenceList outcome={r.before} onShow={onShow} />
      {r.after.judges && r.after.judges.length > 0 && (
        <p className="mt-1.5 text-[11.5px] text-muted">
          Judged by {r.after.judges.map((j) => `${j.id.split("/").pop()} (${j.label.replace("_", " ")})`).join(" · ")}
        </p>
      )}
    </li>
  );
}

interface Props {
  report: Report;
  onShowEvidence: (e: Evidence) => void;
}

/** The mechanical verdict and the requirement results are separate on purpose: one is proven, the other is checked. */
export function CiReportCard({ report, onShowEvidence }: Props) {
  const s = report.summary;
  const parts = [
    s.held && `${s.held} held`,
    s.achieved && `${s.achieved} achieved`,
    s.regressed && `${s.regressed} regressed`,
    s.still_failing && `${s.still_failing} still failing`,
    s.uncertain && `${s.uncertain} uncertain`,
  ].filter(Boolean);
  return (
    <section aria-labelledby="ci-h" className="space-y-2">
      <h3 id="ci-h" className="text-xs font-semibold uppercase tracking-wide text-muted">CLAUSE CI · checked against v{report.version}</h3>
      <div className="rounded-lg border border-line bg-paper p-3 text-sm">
        <p className="font-semibold">Edit mechanics: ✓ valid</p>
        <p className="text-[12px] text-muted">The engine confirmed the target, the version and that nothing overlaps ({report.mechanical.changes} change{report.mechanical.changes === 1 ? "" : "s"}). This is proven, not judged.</p>
      </div>
      {report.requirements.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line p-3 text-sm text-muted">No requirements yet. Add some in the Rules tab to test this edit against them.</p>
      ) : (
        <>
          <p aria-live="polite" className={`text-sm ${s.regressed ? "font-semibold text-del" : "text-ink/80"}`}>{parts.join(" · ")}</p>
          <ul className="space-y-2">{report.requirements.map((r) => <Row key={r.id} r={r} onShow={onShowEvidence} />)}</ul>
        </>
      )}
      <p className="text-[11.5px] leading-snug text-muted">
        Exact checks are decided by literal matching. Statements judged by AI are advisory, not legal conclusions, and a clean report is not a review.
        {report.judges.length > 0 && <> Judges: {report.judges.join(", ")}.</>} {report.elapsedMs} ms.
      </p>
    </section>
  );
}
