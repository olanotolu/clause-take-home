import type { Judge, JudgeAnswer } from "../../apps/api/src/review/judges/types.ts";

/**
 * A deliberately simple, model-free baseline: find the sentence that shares the most distinctive words with the
 * requirement. If it overlaps enough, call it entailed, unless it and the requirement disagree about negation
 * (then contradicted). It exists so the benchmark can show what the AI judges add over plain keyword matching.
 */
const GENERIC = new Set(
  "receiving party disclosing agreement confidential information shall may some any other than that such with from this which case also only their they have been were would will under into upon between both each either neither whether where when while about after before during without within including other another obligations obligation purpose purposes".split(" "),
);
const NEGATION = /\b(not|no|never|neither|nor|without|cannot|shall not|may not)\b/i;

const words = (s: string) => (s.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !GENERIC.has(w));

export function splitSentences(text: string): string[] {
  return text.split(/(?<=[.;:])\s+|\n+/).map((s) => s.trim()).filter((s) => s.length >= 12);
}

/** Best overlap score (0..1) between the requirement's distinctive words and any single sentence, and that sentence. */
export function bestSentence(requirement: string, text: string): { score: number; sentence: string } {
  const need = new Set(words(requirement));
  if (need.size === 0) return { score: 0, sentence: "" };
  let best = { score: 0, sentence: "" };
  for (const sentence of splitSentences(text)) {
    const have = new Set(words(sentence));
    let hit = 0;
    for (const w of need) if (have.has(w) || [...have].some((h) => h.startsWith(w.slice(0, 5)) && w.length >= 5)) hit++;
    const score = hit / need.size;
    if (score > best.score) best = { score, sentence };
  }
  return best;
}

export function createHeuristicJudge(tau: number): Judge {
  return {
    id: "keyword-baseline",
    async judge({ requirement, text }): Promise<JudgeAnswer> {
      const { score, sentence } = bestSentence(requirement, text);
      if (score < tau) return { label: "not_mentioned", pEntailed: score, quotes: [], rationale: "" };
      const label = NEGATION.test(sentence) !== NEGATION.test(requirement) ? "contradicted" : "entailed";
      return { label, pEntailed: label === "entailed" ? score : 0, quotes: [sentence], rationale: "" };
    },
  };
}
