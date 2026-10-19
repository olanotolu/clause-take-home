import { abortable, AI_REQUEST_TIMEOUT_MS } from "../ai-deadline.ts";
import { sha256 } from "@clause/core";
import { combineJudges, type JudgeOutcome } from "./ensemble.ts";
import { createLlmJudge, MAX_JUDGED_CHARS, openRouterGenerate } from "./judges/llm.ts";
import type { Judge } from "./judges/types.ts";
import type { Check, SemanticEvaluator } from "./types.ts";
import { recordAi, recordAiError } from "../telemetry.ts";

export interface EvaluatorOptions {
  judges: Judge[];
  /** Overall evaluation deadline, including queue time. Expiration produces advisory UNAVAILABLE results. */
  timeoutMs?: number;
  /** Most judge calls in flight at once, across all requests (protects provider rate limits and our bill). */
  concurrency?: number;
  /** Remembered answers, keyed by (requirement, text). Unchanged text is never judged twice. */
  cacheSize?: number;
}

const UNAVAILABLE = (detail: string): Check => ({ verdict: "UNAVAILABLE", detail, evidence: [], judges: [] });

/** Pending calls are removed when their request expires, before they can spend provider tokens. */
function limiter(limit: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  const next = () => { while (active < limit && queue.length) queue.shift()!(); };
  return <T>(task: () => Promise<T>, signal: AbortSignal): Promise<T> => new Promise((resolve, reject) => {
    const cancel = () => { const at = queue.indexOf(start); if (at >= 0) queue.splice(at, 1); reject(signal.reason); };
    const start = () => {
      signal.removeEventListener("abort", cancel);
      if (signal.aborted) { reject(signal.reason); return; }
      active++;
      const work = Promise.resolve().then(task);
      const release = () => { active--; next(); };
      void work.then(release, release);
      void abortable(work, signal).then(resolve, reject);
    };
    if (signal.aborted) { reject(signal.reason); return; }
    signal.addEventListener("abort", cancel, { once: true });
    queue.push(start);
    next();
  });
}

export function createSemanticEvaluator(opts: EvaluatorOptions): SemanticEvaluator {
  const run = limiter(opts.concurrency ?? 6);
  const cache = new Map<string, Check>();
  const pendingDefault = new Map<string, Promise<Check>>();
  const pendingRequests = new WeakMap<AbortSignal, Map<string, Promise<Check>>>();
  const evaluateBatch: NonNullable<SemanticEvaluator["evaluateBatch"]> = async ({ text, requirements, signal, onResult }) => {
    const deadline = AbortSignal.timeout(opts.timeoutMs ?? AI_REQUEST_TIMEOUT_MS);
    const budget = signal ? AbortSignal.any([deadline, signal]) : deadline;
    if (!opts.judges.length || text.length > MAX_JUDGED_CHARS) return requirements.map(() => UNAVAILABLE(`AI judging is limited to ${MAX_JUDGED_CHARS} characters and requires a configured judge.`));
    let pendingCache = signal ? pendingRequests.get(signal) : pendingDefault;
    if (!pendingCache) { pendingCache = new Map(); pendingRequests.set(signal!, pendingCache); }
    const textHash = sha256(text);
    const keys = requirements.map((r) => `${r.isGoal ? "goal" : "req"}\u0000${r.requirement}\u0000${textHash}`);
    const missing = [...new Set(keys.filter((key) => !cache.has(key) && !pendingCache.has(key)))];
    if (missing.length) {
      const inputs = missing.map((key) => { const r = requirements[keys.indexOf(key)]!; return { ...r, text, signal: budget }; });
      const jobs = opts.judges.map((judge) => {
        if (judge.judgeBatch) {
          const batch = run(() => judge.judgeBatch!(inputs), budget).catch(() => []);
          return inputs.map((_, i) => batch.then((answers) => answers[i]));
        }
        return inputs.map((input) => run(() => judge.judge(input), budget).catch(() => undefined));
      });
      missing.forEach((key, i) => {
        const pending = Promise.all(jobs.map((answers) => answers[i]!)).then((answers) => combineJudges(text, opts.judges.map((judge, j): JudgeOutcome => ({ judgeId: judge.id, ...(answers[j] && { answer: answers[j]! }) }))));
        pendingCache.set(key, pending);
        void pending.then((result) => {
          pendingCache.delete(key);
          if (result.verdict !== "UNAVAILABLE") cache.set(key, result);
          while (cache.size > (opts.cacheSize ?? 200)) cache.delete(cache.keys().next().value!);
        });
      });
    }
    const pending = keys.map((key) => {
      const cached = cache.get(key);
      if (!cached) return pendingCache.get(key)!;
      cache.delete(key);
      cache.set(key, cached);
      return Promise.resolve(cached);
    });
    return Promise.all(pending.map(async (work, index) => {
      let result: Check;
      try { result = await abortable(work, budget); } catch { result = UNAVAILABLE("The AI request deadline expired."); }
      onResult?.(index, result);
      return result;
    }));
  };
  return { models: opts.judges.map((j) => j.id), evaluateBatch, async evaluate({ requirement, text, isGoal, signal }) { return (await evaluateBatch({ text, requirements: [{ requirement, isGoal }], ...(signal && { signal }) }))[0]!; } };
}

/**
 * Judges available from the environment:
 *  - An LLM through OpenRouter when OPENROUTER_API_KEY is set. (A second judge, Jev, was tried and removed: its provider
 *    returned HTTP 403, so it never produced a measurement.) Configured judges run concurrently.
 * Returns undefined when none are configured, which leaves only the exact requirement kinds.
 */
export function evaluatorFromEnv(env: Record<string, string | undefined>): SemanticEvaluator | undefined {
  const judges: Judge[] = [];
  if (env.OPENROUTER_API_KEY) {
    const model = env.CLAUSE_JUDGE_MODEL ?? "anthropic/claude-sonnet-5.5";
    const rates = (() => { try { return JSON.parse(env.CLAUSE_AI_COST_PER_MILLION_TOKENS ?? "{}") as Record<string, { input: number; output: number }>; } catch { return {}; } })();
    const rate = rates[model];
    const generate = openRouterGenerate(env.OPENROUTER_API_KEY, model, (usage) => recordAi(model, usage, rate ? (usage.inputTokens * rate.input + usage.outputTokens * rate.output) / 1_000_000 : undefined));
    judges.push(createLlmJudge({ id: model, generate: async (input) => {
      try { return await generate(input); }
      catch (error) { recordAiError(model); throw error; }
    } }));
  }
  return judges.length ? createSemanticEvaluator({ judges }) : undefined;
}
