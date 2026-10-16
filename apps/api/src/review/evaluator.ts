import { sha256 } from "@clause/core";
import { combineJudges, type JudgeOutcome } from "./ensemble.ts";
import { createLlmJudge, MAX_JUDGED_CHARS, openRouterGenerate } from "./judges/llm.ts";
import type { Judge } from "./judges/types.ts";
import type { Check, SemanticEvaluator } from "./types.ts";

export interface EvaluatorOptions {
  judges: Judge[];
  /** Per judge call. A judge that overruns is treated as unavailable; it never holds up the report. */
  timeoutMs?: number;
  /** Most judge calls in flight at once, across all requests (protects provider rate limits and our bill). */
  concurrency?: number;
  /** Remembered answers, keyed by (requirement, text). Unchanged text is never judged twice. */
  cacheSize?: number;
}

const UNAVAILABLE = (detail: string): Check => ({ verdict: "UNAVAILABLE", detail, evidence: [], judges: [] });

/** At most `limit` tasks run at once; the rest wait their turn. */
function limiter(limit: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  const next = () => {
    while (active < limit && queue.length) {
      active++;
      queue.shift()!();
    }
  };
  return <T>(task: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        task().then(resolve, reject).finally(() => {
          active--;
          next();
        });
      });
      next();
    });
}

/** Rejects if `p` hasn't settled in `ms`, and aborts `controller` so a well-behaved judge stops working. */
function withTimeout<T>(p: Promise<T>, ms: number, controller: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("judge timed out"));
    }, ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Runs every configured judge on (requirement, text) and combines them with `combineJudges`. It never throws: any
 * failure becomes an UNAVAILABLE or partial result, because a model outage must not be able to break the report.
 */
export function createSemanticEvaluator(opts: EvaluatorOptions): SemanticEvaluator {
  const timeoutMs = opts.timeoutMs ?? 25_000;
  const run = limiter(opts.concurrency ?? 6);
  const max = opts.cacheSize ?? 200;
  const cache = new Map<string, Promise<Check>>();

  const compute = async (requirement: string, text: string, isGoal: boolean): Promise<Check> => {
    const outcomes: JudgeOutcome[] = await Promise.all(
      opts.judges.map(async (j): Promise<JudgeOutcome> => {
        const controller = new AbortController();
        try {
          const answer = await run(() => withTimeout(j.judge({ requirement, text, isGoal, signal: controller.signal }), timeoutMs, controller));
          return { judgeId: j.id, answer };
        } catch {
          return { judgeId: j.id };
        }
      }),
    );
    return combineJudges(text, outcomes);
  };

  return {
    models: opts.judges.map((j) => j.id),
    async evaluate({ requirement, text, isGoal }) {
      if (opts.judges.length === 0) return UNAVAILABLE("No AI judge is configured on this server.");
      if (text.length > MAX_JUDGED_CHARS) return UNAVAILABLE(`This document is ${text.length} characters; AI judging is limited to ${MAX_JUDGED_CHARS}.`);
      const key = `${isGoal ? "goal" : "req"}\u0000${requirement}\u0000${sha256(text)}`;
      const hit = cache.get(key);
      if (hit) {
        cache.delete(key); // refresh recency
        cache.set(key, hit);
        return hit;
      }
      const pending = compute(requirement, text, isGoal);
      cache.set(key, pending);
      if (cache.size > max) cache.delete(cache.keys().next().value!);
      const result = await pending;
      if (result.verdict === "UNAVAILABLE") cache.delete(key); // never remember an outage
      return result;
    },
  };
}

/** Judges available from the environment. Today: one LLM through OpenRouter. Returns undefined when none are configured. */
export function evaluatorFromEnv(env: Record<string, string | undefined>): SemanticEvaluator | undefined {
  const judges: Judge[] = [];
  if (env.OPENROUTER_API_KEY) {
    const model = env.CLAUSE_JUDGE_MODEL ?? "anthropic/claude-sonnet-5.5";
    judges.push(createLlmJudge({ id: model, generate: openRouterGenerate(env.OPENROUTER_API_KEY, model) }));
  }
  return judges.length ? createSemanticEvaluator({ judges }) : undefined;
}
