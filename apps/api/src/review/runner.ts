import { abortable, AI_REQUEST_TIMEOUT_MS } from "../ai-deadline.ts";
import type { Result } from "@clause/core";
import { previewOrCurrent, type ChangeRequest } from "../documents.ts";
import type { DomainError } from "../errors.ts";
import type { Store } from "../store/types.ts";
import { applyStrictness, type Strictness } from "./ensemble.ts";
import { deltaOf, summarize } from "./delta.ts";
import { evaluateDeterministic } from "./deterministic.ts";
import type { Check, CiReport, RequirementReport, SemanticEvaluator } from "./types.ts";

export interface CheckRequest extends ChangeRequest {
  /** What the edit is supposed to achieve, in the user's words. Judged like a requirement that should become true. */
  goal?: string | undefined;
  /** `strict` demotes low-confidence semantic PASSes to NEEDS_REVIEW. Default `balanced` changes nothing. */
  strictness?: Strictness | undefined;
  signal?: AbortSignal;
}

/** Used when no model is configured: semantic requirements answer UNAVAILABLE, exact ones still run. */
export const noSemanticEvaluator: SemanticEvaluator = {
  models: [],
  async evaluate() {
    return { verdict: "UNAVAILABLE", detail: "No AI judge is configured on this server.", evidence: [] };
  },
};

/** Enforces the evaluator contract: a judge that throws becomes an UNAVAILABLE check, never an HTTP 500. */
async function safely(semantic: SemanticEvaluator, args: { requirement: string; text: string; isGoal: boolean; signal?: AbortSignal }): Promise<Check> {
  try {
    return await semantic.evaluate(args);
  } catch {
    return { verdict: "UNAVAILABLE", detail: "The AI judge failed to answer.", evidence: [] };
  }
}

/**
 * Runs the document's saved requirements (plus an optional goal) against the CURRENT text and the PROPOSED text.
 *
 * The edit engine goes first and is authoritative: if the edit is not mechanically valid the caller gets the usual
 * error and no requirement is evaluated. Nothing here writes to the store, and an evaluator can only ever add
 * information to the report, never block or change the edit.
 */
export async function runCi(store: Store, id: string, req: CheckRequest, semantic: SemanticEvaluator = noSemanticEvaluator): Promise<Result<CiReport, DomainError>> {
  const started = performance.now();
  const signal = req.signal ?? AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS);
  const p = await previewOrCurrent(store, id, req);
  if (!p.ok) return p;
  const { doc, result } = p.value;
  const requirements = await store.listRequirements(id);

  const items = [
    ...(req.goal ? [{ id: "goal", kind: "goal" as const, text: req.goal }] : []),
    ...requirements.map((r) => ({ id: r.id, kind: r.kind, text: r.text })),
  ];

  const semanticItems = items.filter((item) => item.kind === "semantic" || item.kind === "goal");
  const questions = semanticItems.map((item) => ({ requirement: item.text, isGoal: item.kind === "goal" }));
  const judgeText = async (text: string): Promise<Check[]> => {
    const completed: Check[] = questions.map(() => ({ verdict: "UNAVAILABLE", detail: "The AI request deadline expired.", evidence: [] }));
    const onResult = (index: number, check: Check) => { if (!signal.aborted) completed[index] = check; };
    try {
      signal.throwIfAborted();
      const work = semantic.evaluateBatch ? semantic.evaluateBatch({ text, requirements: questions, signal, onResult }) : Promise.all(questions.map(async (q, index) => { const result = await safely(semantic, { ...q, text, signal }); onResult(index, result); return result; }));
      return await abortable(work, signal);
    } catch { return completed; }
  };
  const [beforeChecks, afterChecks] = questions.length ? await Promise.all([judgeText(doc.content), judgeText(result.content)]) : [[], []];
  const reports = await Promise.all(
    items.map(async (item): Promise<RequirementReport> => {
      if (item.kind === "present" || item.kind === "absent" || item.kind === "unchanged") {
        const d = evaluateDeterministic(item.kind, item.text, doc.content, result.content, result.applied);
        return { id: item.id, kind: item.kind, text: item.text, before: d.before, after: d.after, delta: deltaOf(d.before.verdict, d.after.verdict), touchedBy: d.touchedBy };
      }
      const index = semanticItems.indexOf(item);
      const before = applyStrictness(beforeChecks[index]!, req.strictness);
      const after = applyStrictness(afterChecks[index]!, req.strictness);
      return { id: item.id, kind: item.kind, text: item.text, before, after, delta: deltaOf(before.verdict, after.verdict), touchedBy: [] };
    }),
  );

  return {
    ok: true,
    value: {
      documentId: id,
      version: doc.version,
      mechanical: { valid: true, wouldChange: result.changed, changes: result.applied.length },
      requirements: reports,
      summary: summarize(reports.map((r) => r.delta)),
      judges: semantic.models,
      elapsedMs: Math.round(performance.now() - started),
    },
  };
}
