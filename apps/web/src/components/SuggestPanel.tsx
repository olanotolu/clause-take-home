import { useState } from "react";
import { api, type ApiError, type SuggestResponse } from "../lib/api.ts";
import type { Staged } from "./ChangePanel.tsx";

type State = { status: "idle" } | { status: "loading" } | { status: "error"; error: ApiError } | { status: "done"; data: SuggestResponse };

interface Props {
  docId: string;
  docVersion: number;
  /** Hands validated proposal changes to the normal staging flow. The AI never writes anything itself. */
  onStage: (items: Omit<Staged, "id">[]) => void;
}

export function SuggestPanel({ docId, docVersion, onStage }: Props) {
  const [instruction, setInstruction] = useState("");
  const [state, setState] = useState<State>({ status: "idle" });

  const ask = async () => {
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
    );
  };

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto">
      <label htmlFor="instr" className="text-xs font-semibold uppercase tracking-wide text-muted">Ask for an edit</label>
      <textarea
        id="instr"
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        rows={3}
        placeholder="e.g. Change the notice period from thirty (30) days to sixty (60) days"
        className="w-full rounded-md border border-line bg-paper px-3 py-2 text-sm"
      />
      <button
        disabled={!instruction.trim() || state.status === "loading"}
        onClick={() => void ask()}
        className="rounded-md bg-ink px-3 py-2 text-sm font-semibold text-white disabled:opacity-30"
      >
        {state.status === "loading" ? "Asking…" : "Suggest a change"}
      </button>
      <p className="text-xs text-muted">The model only proposes. The same engine that checks your own edits validates it, and nothing is saved until you stage it and click Apply.</p>

      <div aria-live="polite" className="flex flex-col gap-3">
        {state.status === "error" && (
          <p role="alert" className="rounded-md bg-del-bg px-3 py-2 text-sm text-del">
            {state.error.type === "AI_UNAVAILABLE"
              ? "AI suggestions aren't configured on this server. Add OPENROUTER_API_KEY to .env.local and restart the API."
              : state.error.error}
          </p>
        )}

        {data && (
          <section className="rounded-lg border border-line bg-paper p-3 text-sm">
            <p className="mb-2 flex items-center gap-2 text-[11px] text-muted">
              <span className={`rounded px-1.5 py-0.5 font-semibold ${data.provider === "live" ? "bg-ins-bg text-ins" : "bg-hit text-ink"}`}>
                {data.provider === "live" ? "live model" : "FIXTURE · not a live model"}
              </span>
              {data.model} · checked against v{data.documentVersion}
            </p>
            <p className="text-[13px] text-ink/80">{data.rationale}</p>

            {data.validation.valid ? (
              <>
                <ul className="mt-3 space-y-2">
                  {data.validation.applied.map((a) => (
                    <li key={a.index} className="rounded border border-line p-2">
                      <span className="del px-0.5">{a.before.length > 90 ? `${a.before.slice(0, 90)}…` : a.before}</span>
                      <span className="mx-1 text-muted">→</span>
                      {a.after ? <span className="ins px-0.5">{a.after.length > 90 ? `${a.after.slice(0, 90)}…` : a.after}</span> : <em className="text-muted">delete</em>}
                    </li>
                  ))}
                </ul>
                {stale && <p role="alert" className="mt-2 text-[13px] text-del">The document changed since this was checked (v{data.documentVersion} → v{docVersion}). Ask again.</p>}
                <button disabled={stale} onClick={stage} className="mt-3 w-full rounded-md bg-accent px-3 py-2 text-sm font-semibold text-white disabled:opacity-30">
                  Stage {data.validation.applied.length} change{data.validation.applied.length === 1 ? "" : "s"} for review
                </button>
              </>
            ) : (
              <div className="mt-3 text-del">
                <p className="font-semibold">✗ {data.validation.error.type.replaceAll("_", " ").toLowerCase()}</p>
                <p className="mt-1 text-[13px] text-ink/80">{data.validation.error.error}</p>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
