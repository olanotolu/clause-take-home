import { ArrowRight, Sparkles, TriangleAlert } from "../ui/icons.tsx";
import { useState } from "react";
import { api, type ApiError, type Evidence, type SuggestResponse } from "../lib/api.ts";
import { shortModel } from "../lib/confidence.ts";
import type { Staged } from "../lib/workspace.tsx";
import { Button } from "../ui/Button.tsx";
import { EmptyState, StatusPill } from "../ui/bits.tsx";
import { TextShimmer } from "../ui/motion/text-shimmer.tsx";

type State = { status: "idle" } | { status: "loading" } | { status: "error"; error: ApiError } | { status: "done"; data: SuggestResponse };

interface Props {
  docId: string;
  docVersion: number;
  /** Hands validated proposal changes to the normal staging flow. The AI never writes anything itself. */
  onStage: (items: Omit<Staged, "id">[], ci?: SuggestResponse["ci"]) => void;
  onShowEvidence: (e: Evidence) => void;
  onOpenCi: () => void;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function SuggestPanel({ docId, docVersion, onStage, onOpenCi }: Props) {
  const [instruction, setInstruction] = useState("");
  const [state, setState] = useState<State>({ status: "idle" });

  const ask = async () => {
    if (!instruction.trim() || state.status === "loading") return;
    setState({ status: "loading" });
    const r = await api.suggest(docId, instruction.trim());
    setState(r.ok ? { status: "done", data: r.data } : { status: "error", error: r.error });
  };

  const data = state.status === "done" ? state.data : null;
  const stale = data !== null && data.documentVersion !== docVersion;

  const stage = () => {
    if (!data || !data.validation.valid) return;
    onStage(
      data.validation.applied.flatMap((a) => {
        const change = data.changes[a.index];
        return change ? [{ target: change.target, replacement: change.replacement, start: a.start, end: a.end, text: a.before }] : [];
      }),
      stale ? null : data.ci,
    );
  };

  const verified = data?.ci ? data.ci.requirements.flatMap((r) => [...r.before.evidence, ...r.after.evidence]) : [];
  const verifiedCount = verified.filter((e) => e.verified).length;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto">
      <div>
        <label htmlFor="instr" className="text-sm font-semibold">Ask for an edit</label>
        <textarea
          id="instr"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void ask(); } }}
          rows={3}
          placeholder="e.g. Change the notice period from thirty (30) days to sixty (60) days"
          className="mt-1.5 w-full rounded-control border border-line-strong bg-paper px-3 py-2 text-sm"
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <p className="text-xs text-muted">The model proposes. The engine validates. Nothing saves until you Apply.</p>
          <Button variant="primary" size="sm" icon={<Sparkles size={14} aria-hidden />} loading={state.status === "loading"} disabled={!instruction.trim()} onClick={() => void ask()} title="⌘↵">
            {state.status === "loading" ? "Asking…" : "Suggest"}
          </Button>
        </div>
      </div>

      <div aria-live="polite" className="flex flex-col gap-3">
        {state.status === "idle" && <EmptyState icon={<Sparkles size={22} aria-hidden />} title="Describe the change you want">The assistant turns it into exact, validated edits and checks them against your requirements before you stage anything.</EmptyState>}
        {state.status === "loading" && <TextShimmer as="p" className="px-1 text-sm">Reading the document and drafting an edit…</TextShimmer>}
        {state.status === "error" && (
          <p role="alert" className="flex gap-2 rounded-control bg-fail-bg px-3 py-2 text-sm text-fail">
            <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden />
            {state.error.type === "AI_UNAVAILABLE" ? "AI suggestions aren't configured on this server. Add OPENROUTER_API_KEY to .env.local and restart the API." : state.error.error}
          </p>
        )}

        {data && (
          <section className="rise rounded-control border border-line bg-paper p-3 text-sm">
            <p className="text-[13px]">{data.rationale}</p>

            {data.validation.valid ? (
              <>
                <ul className="mt-3 space-y-1.5">
                  {data.validation.applied.map((a) => (
                    <li key={a.index} className="rounded-md border border-line bg-canvas px-2.5 py-1.5 text-[13px] leading-snug">
                      <span className="del px-0.5">{clip(a.before, 90)}</span>
                      <ArrowRight size={12} className="mx-1.5 inline text-muted" aria-hidden />
                      {a.after ? <span className="ins px-0.5">{clip(a.after, 90)}</span> : <em className="text-muted">deleted</em>}
                    </li>
                  ))}
                </ul>
                {data.ci && !stale && (
                  <p className="mt-3 flex flex-wrap items-center gap-2 text-[13px]">
                    {data.ci.summary.regressed > 0 ? <StatusPill tone="fail">{data.ci.summary.regressed} requirement{data.ci.summary.regressed === 1 ? "" : "s"} would break</StatusPill> : data.ci.requirements.length > 0 ? <StatusPill tone="pass">No requirement breaks</StatusPill> : <StatusPill tone="neutral">No requirements to check</StatusPill>}
                    {data.ci.requirements.length > 0 && <button onClick={() => { stage(); onOpenCi(); }} className="font-medium text-accent underline underline-offset-2">Stage and open the report</button>}
                  </p>
                )}
                {stale && <p role="alert" className="mt-2 text-[13px] text-fail">The document changed since this was checked (v{data.documentVersion} → v{docVersion}). Ask again.</p>}
                <Button variant="primary" className="mt-3 w-full" disabled={stale} onClick={stage}>
                  Stage {data.validation.applied.length} change{data.validation.applied.length === 1 ? "" : "s"} for review
                </Button>
              </>
            ) : (
              <div className="mt-3 flex gap-2 rounded-md bg-fail-bg px-3 py-2 text-[13px] text-fail">
                <TriangleAlert size={15} className="mt-0.5 shrink-0" aria-hidden />
                <div><p className="font-semibold">{data.validation.error.type.replaceAll("_", " ").toLowerCase()}</p><p>{data.validation.error.error}</p></div>
              </div>
            )}

            <p className="mt-3 border-t border-line pt-2 text-xs text-muted">
              {data.provider === "live" ? "Live model" : <strong className="text-review">FIXTURE, not a live model</strong>} · {shortModel(data.model)} · checked against v{data.documentVersion}
              {verified.length > 0 && <> · evidence verified {verifiedCount}/{verified.length}</>}
            </p>
          </section>
        )}
      </div>
    </div>
  );
}
