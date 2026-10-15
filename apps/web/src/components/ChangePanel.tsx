import { useState } from "react";
import type { Target } from "@clause/engine";
import { countOccurrences } from "../lib/segments.ts";
import type { ApiError, Preview } from "../lib/api.ts";

export interface Staged {
  id: number;
  target: Target;
  replacement: string;
  start: number;
  end: number;
  text: string;
}

export type PreviewState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "valid"; data: Preview }
  | { status: "invalid"; error: ApiError };

interface Props {
  content: string;
  version: number;
  selection: { start: number; end: number } | null;
  staged: Staged[];
  preview: PreviewState;
  conflict: { currentVersion?: number | undefined } | null;
  applying: boolean;
  onStage: (replacement: string) => void;
  onRemove: (id: number) => void;
  onApply: () => void;
  onReload: () => void;
  onClear: () => void;
}

const quoteOf = (t: Target) => ("quote" in t ? t.quote : null);

export function ChangePanel(p: Props) {
  const [replacement, setReplacement] = useState("");
  const selected = p.selection ? p.content.slice(p.selection.start, p.selection.end) : "";
  const occurrences = countOccurrences(p.content, selected);
  const valid = p.preview.status === "valid" && p.preview.data.wouldChange;

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="relative flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
      {p.conflict && (
        <div role="alert" className="rounded-lg border border-del/30 bg-del-bg p-3 text-sm text-del">
          <p className="font-semibold">Document changed underneath you</p>
          <p className="mt-1 text-[13px]">
            This edit was prepared against v{p.version}
            {p.conflict.currentVersion ? `, but the document is now at v${p.conflict.currentVersion}` : ""}. CLAUSE won't guess how to merge it. Your staged changes are kept — reload and they will be re-validated against the new text.
          </p>
          <button onClick={p.onReload} className="mt-2 rounded-md bg-del px-3 py-1.5 text-xs font-semibold text-white">Reload latest &amp; re-validate</button>
        </div>
      )}

      <section aria-labelledby="sel-h">
        <h3 id="sel-h" className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">Selected passage</h3>
        {p.selection ? (
          <div className="rounded-lg border border-line bg-paper p-3">
            <p className="doc !text-[14px] !leading-snug">“{selected.length > 220 ? `${selected.slice(0, 220)}…` : selected}”</p>
            <p className="mt-2 text-xs text-muted">
              chars {p.selection.start}–{p.selection.end} · {occurrences === 1 ? "unique in this version" : `appears ${occurrences}× — will be anchored by surrounding context`}
            </p>
          </div>
        ) : (
          <p className="rounded-lg border border-dashed border-line p-3 text-sm text-muted">Select text in the document, or pick a search hit, to propose a replacement.</p>
        )}
        <label className="mt-3 block text-xs font-semibold uppercase tracking-wide text-muted" htmlFor="repl">Replacement</label>
        <textarea
          id="repl"
          value={replacement}
          onChange={(e) => setReplacement(e.target.value)}
          rows={3}
          placeholder="Leave empty to delete the passage"
          className="mt-1 w-full rounded-md border border-line bg-paper px-3 py-2 font-doc text-[14px]"
        />
        <button
          disabled={!p.selection}
          onClick={() => {
            p.onStage(replacement);
            setReplacement("");
          }}
          className="mt-2 w-full rounded-md bg-ink px-3 py-2 text-sm font-semibold text-white disabled:opacity-30"
        >
          Stage change
        </button>
      </section>

      <section aria-labelledby="pend-h" className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h3 id="pend-h" className="text-xs font-semibold uppercase tracking-wide text-muted">Pending changes ({p.staged.length})</h3>
          {p.staged.length > 0 && <button onClick={p.onClear} className="text-xs text-muted underline">Clear</button>}
        </div>
        {p.staged.length === 0 && <p className="text-sm text-muted">Nothing staged. Changes are validated as one atomic batch.</p>}
        {p.staged.map((s) => {
          const qt = quoteOf(s.target);
          return (
            <div key={s.id} className="rounded-lg border border-line bg-paper p-3 text-sm">
              <div className="flex items-start justify-between gap-2">
                <p className="min-w-0 break-words">
                  <span className="del px-0.5">{s.text.length > 80 ? `${s.text.slice(0, 80)}…` : s.text}</span>
                  <span className="mx-1 text-muted">→</span>
                  {s.replacement ? <span className="ins px-0.5">{s.replacement.length > 80 ? `${s.replacement.slice(0, 80)}…` : s.replacement}</span> : <em className="text-muted">delete</em>}
                </p>
                <button onClick={() => p.onRemove(s.id)} aria-label="Remove change" className="shrink-0 text-muted hover:text-del">✕</button>
              </div>
              <p className="mt-1.5 text-[11px] text-muted">
                anchor: {qt ? `quote${qt.prefix || qt.suffix ? " + context" : ""}` : "position (+ expected text)"}
              </p>
            </div>
          );
        })}
      </section>

      {p.staged.length > 0 && (
        <section aria-labelledby="val-h" aria-live="polite" className="rounded-lg border border-line bg-paper p-3 text-sm">
          <h3 id="val-h" className="sr-only">Validation</h3>
          {p.preview.status === "loading" && <p className="text-muted">Validating against v{p.version}…</p>}
          {p.preview.status === "valid" && (
            <div className="text-ins">
              <p className="font-semibold">✓ Valid · v{p.version} → v{p.version + 1}</p>
              <ul className="mt-1 list-disc pl-5 text-[13px] text-ink/80">
                <li>every target resolves to exactly one span</li>
                <li>no overlapping changes</li>
                <li>version {p.version} is still current</li>
                {!p.preview.data.wouldChange && <li className="text-muted">but nothing would change (identical text)</li>}
              </ul>
            </div>
          )}
          {p.preview.status === "invalid" && (
            <div className="text-del">
              <p className="font-semibold">✗ {p.preview.error.type.replaceAll("_", " ").toLowerCase()}</p>
              <p className="mt-1 text-[13px] text-ink/80">{p.preview.error.error}</p>
              {p.preview.error.details?.candidates && (
                <ul className="mt-2 space-y-1 text-[12px] text-ink/70">
                  {p.preview.error.details.candidates.map((c) => (
                    <li key={c.start} className="truncate"><code>{c.start}</code> … {c.context.replaceAll("\n", " ")}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>
      )}

      </div>
      <button
        disabled={!valid || p.applying || !!p.conflict}
        onClick={p.onApply}
        className="shrink-0 rounded-md bg-accent px-3 py-2.5 text-sm font-semibold text-white shadow disabled:opacity-30"
      >
        {p.applying ? "Applying…" : `Apply ${p.staged.length || ""} change${p.staged.length === 1 ? "" : "s"}`}
      </button>
    </div>
  );
}
