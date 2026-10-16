import { AlertTriangle, ArrowRight, ChevronDown, ChevronUp, Trash2, XCircle } from "../ui/icons.tsx";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import { Num } from "../ui/Num.tsx";
import { useState } from "react";
import { deltaLabel, wordDelta } from "../lib/wordDelta.ts";
import { useWorkspace } from "../lib/workspace.tsx";
import { Button } from "../ui/Button.tsx";
import { StatusPill } from "../ui/bits.tsx";
import { TextShimmer } from "../ui/motion/text-shimmer.tsx";

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** The batch you are about to apply: every change, whether the engine accepts it, and the one button that saves. */
export function ChangesTray() {
  const ws = useWorkspace();
  const [list] = useAutoAnimate<HTMLUListElement>({ duration: 180, easing: "ease-out" });
  const [open, setOpen] = useState(() => typeof window === "undefined" || window.matchMedia("(min-width: 700px)").matches);
  const { staged, preview, conflict, doc } = ws;
  if (!doc) return null;
  const validNow = preview.status === "valid" && preview.data.wouldChange && !conflict;

  // Nothing staged, nothing on screen: the tray rises in when the first change arrives.
  if (staged.length === 0) return null;

  const status = conflict ? (
    <StatusPill tone="review">Out of date</StatusPill>
  ) : preview.status === "loading" ? (
    <TextShimmer as="span" className="text-xs">{`Validating against v${doc.version}…`}</TextShimmer>
  ) : preview.status === "valid" ? (
    preview.data.wouldChange ? <StatusPill tone="pass">Valid · v{doc.version} → v{doc.version + 1}</StatusPill> : <StatusPill tone="neutral">Identical text, nothing would change</StatusPill>
  ) : preview.status === "invalid" ? (
    <StatusPill tone="fail">{preview.error.type.replaceAll("_", " ").toLowerCase()}</StatusPill>
  ) : null;

  return (
    <section aria-label="Proposed changes" className="fade-up shrink-0 border-t border-line-strong bg-paper max-[899px]:sticky max-[899px]:bottom-0">
      {conflict && (
        <div role="alert" className="flex flex-wrap items-center gap-3 border-b border-line bg-fail-bg px-5 py-2.5 text-sm text-fail max-[640px]:px-3">
          <AlertTriangle size={16} aria-hidden />
          <p className="min-w-0 flex-1">
            <strong>Document changed underneath you.</strong> Prepared against v{doc.version}{conflict.currentVersion ? `, now at v${conflict.currentVersion}` : ""}. CLAUSE won't guess a merge; your staged changes are kept and re-validated after reload.
          </p>
          <Button size="sm" variant="danger" onClick={() => void ws.reload()}>Reload and re-validate</Button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-2.5 max-[640px]:px-3">
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex items-center gap-1.5 text-sm font-semibold">
          {open ? <ChevronDown size={15} aria-hidden /> : <ChevronUp size={15} aria-hidden />}
          Proposed changes <span className="tnum rounded-full bg-accent-soft px-1.5 text-xs text-accent"><Num value={staged.length} /></span>
        </button>
        <div aria-live="polite" className="min-w-0">{status}</div>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={ws.clearStaged}>Discard</Button>
          <Button variant="primary" size="sm" disabled={!validNow} loading={ws.applying} onClick={() => void ws.apply()}>
            {ws.applying ? "Applying…" : `Apply ${staged.length === 1 ? "change" : `all ${staged.length}`}`}
          </Button>
        </div>
      </div>

      {open && (
        <ul ref={list} className="max-h-[34vh] space-y-1.5 overflow-y-auto px-5 pb-3 max-[640px]:px-3">
          {staged.map((s) => {
            const d = wordDelta(s.text, s.replacement);
            const quote = "quote" in s.target ? s.target.quote : null;
            return (
              <li key={s.id} className="rise flex items-start gap-3 rounded-control border border-line bg-canvas px-3 py-2">
                <p className="min-w-0 flex-1 break-words text-[13px] leading-snug">
                  <span className="del px-0.5">{clip(s.text, 90)}</span>
                  <ArrowRight size={13} className="mx-1.5 inline text-muted" aria-hidden />
                  {s.replacement ? <span className="ins px-0.5">{clip(s.replacement, 90)}</span> : <em className="text-muted">deleted</em>}
                  <span className="mt-1 block text-xs text-muted">
                    {[deltaLabel(d.removed, "-"), deltaLabel(d.added, "+")].filter(Boolean).join(" ")} · anchored by {quote ? (quote.prefix || quote.suffix ? "quote and context" : "quote") : "position and expected text"}
                  </span>
                </p>
                <button type="button" onClick={() => ws.removeStaged(s.id)} aria-label={`Remove change: ${clip(s.text, 30)}`} className="mt-0.5 shrink-0 rounded p-1 text-muted hover:bg-line/70 hover:text-fail"><Trash2 size={14} aria-hidden /></button>
              </li>
            );
          })}
        </ul>
      )}

      {open && preview.status === "invalid" && !conflict && (
        <div role="alert" className="mx-5 mb-3 flex gap-2 rounded-control bg-fail-bg px-3 py-2 text-[13px] text-fail max-[640px]:mx-3">
          <XCircle size={15} className="mt-0.5 shrink-0" aria-hidden />
          <div className="min-w-0">
            <p>{preview.error.error}</p>
            {preview.error.details?.candidates && (
              <ul className="mt-1 space-y-0.5 text-xs text-ink/70">
                {preview.error.details.candidates.map((c) => <li key={c.start} className="truncate"><code>{c.start}</code> … {c.context.replaceAll("\n", " ")}</li>)}
              </ul>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
