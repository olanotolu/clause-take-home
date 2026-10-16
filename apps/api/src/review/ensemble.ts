import { verifyQuotes } from "./evidence.ts";
import type { JudgeAnswer, JudgeLabel } from "./judges/types.ts";
import type { Check, EvidenceSpan, Verdict } from "./types.ts";

export interface JudgeOutcome {
  judgeId: string;
  /** Absent when the judge failed (timeout, provider error, ...). */
  answer?: JudgeAnswer;
}

const toVerdict = (label: JudgeLabel): Verdict => (label === "entailed" ? "PASS" : label === "unclear" ? "NEEDS_REVIEW" : "FAIL");

const WORDS: Record<JudgeLabel, string> = {
  entailed: "the document satisfies it",
  contradicted: "the document says the opposite",
  not_mentioned: "the document does not address it",
  unclear: "it is unclear",
};

/**
 * Turns judges' answers about ONE text into a single, honest Check. Pure and deterministic (the model calls are already done).
 *
 *  - All judges agree        -> that verdict.
 *  - They disagree           -> NEEDS_REVIEW, and both opinions are shown. No tie-breaking, no averaging.
 *  - A judge failed          -> the remaining judge(s) decide, flagged as such. None left -> UNAVAILABLE.
 *  - PASS requires evidence  -> at least one quote that was VERIFIED verbatim in the text; otherwise NEEDS_REVIEW.
 *    (A FAIL needs none: absence has no passage to point at.)
 */
export function combineJudges(text: string, outcomes: readonly JudgeOutcome[]): Check {
  const answered = outcomes.filter((o): o is Required<JudgeOutcome> => o.answer !== undefined);
  const judges = answered.map((o) => ({ id: o.judgeId, label: o.answer.label, ...(o.answer.pEntailed !== undefined && { probability: o.answer.pEntailed }), rationale: o.answer.rationale }));

  if (answered.length === 0) {
    return { verdict: "UNAVAILABLE", detail: "No AI judge could answer (unavailable, timed out, or the text was too long to send).", evidence: [], judges: [] };
  }

  const evidence: EvidenceSpan[] = verifyQuotes(
    text,
    answered.flatMap((o) => o.answer.quotes),
  );
  const verifiedAny = evidence.some((e) => e.verified);
  const verdicts = new Set(answered.map((o) => toVerdict(o.answer.label)));
  const partial = answered.length < outcomes.length ? ` Only ${answered.map((o) => o.judgeId).join(", ")} answered.` : "";

  if (verdicts.size > 1) {
    const detail = answered.map((o) => `${o.judgeId}: ${WORDS[o.answer.label]}`).join("; ");
    return { verdict: "NEEDS_REVIEW", detail: `The judges disagree (${detail}). A person should decide.`, evidence, judges };
  }

  const verdict = [...verdicts][0]!;
  const lead = answered[0]!.answer;
  if (verdict === "PASS" && !verifiedAny) {
    return { verdict: "NEEDS_REVIEW", detail: `The judge${answered.length > 1 ? "s say" : " says"} this holds but cited nothing that can be found in the document, so it cannot be confirmed.${partial}`, evidence, judges };
  }
  const prefix = verdict === "PASS" ? "Holds" : verdict === "FAIL" ? (lead.label === "contradicted" ? "Contradicted" : "Not stated") : "Unclear";
  return { verdict, detail: `${prefix}: ${lead.rationale}${partial}`, evidence, judges };
}
