/** Pure statistics for the benchmark. Kept separate (and unit-tested) so the numbers in the report can't be a math slip. */

/** Wilson score interval for a proportion k/n (default 95%). Sensible at small n and at 0% / 100%, unlike the normal approximation. */
export function wilson(k: number, n: number, z = 1.96): { p: number; lo: number; hi: number } {
  if (n === 0) return { p: NaN, lo: NaN, hi: NaN };
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

export const pct = (x: number) => (Number.isNaN(x) ? "n/a" : `${(x * 100).toFixed(1)}%`);
export const fmtCi = (k: number, n: number) => {
  const w = wilson(k, n);
  return n === 0 ? "n/a" : `${pct(w.p)} [${pct(w.lo)}, ${pct(w.hi)}] (${k}/${n})`;
};

/** Nearest-rank percentile. */
export function percentile(xs: readonly number[], q: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!;
}

/** Brier score of probabilities against 0/1 outcomes (lower is better; always predicting 0.5 scores 0.25). */
export function brier(pairs: readonly { p: number; outcome: boolean }[]): number {
  if (pairs.length === 0) return NaN;
  return pairs.reduce((s, { p, outcome }) => s + (p - (outcome ? 1 : 0)) ** 2, 0) / pairs.length;
}

export type Matrix<L extends string> = Record<L, Record<L, number>>;

export function confusion<L extends string>(labels: readonly L[], rows: readonly { truth: L; pred: L }[]): Matrix<L> {
  const m = Object.fromEntries(labels.map((t) => [t, Object.fromEntries(labels.map((p) => [p, 0]))])) as Matrix<L>;
  for (const r of rows) m[r.truth][r.pred]++;
  return m;
}

/** Per-class precision / recall / F1 and the macro average over classes that have any true examples. */
export function classReport<L extends string>(labels: readonly L[], m: Matrix<L>) {
  const per = Object.fromEntries(
    labels.map((l) => {
      const tp = m[l][l];
      const support = labels.reduce((s, p) => s + m[l][p], 0);
      const predicted = labels.reduce((s, t) => s + m[t][l], 0);
      const precision = predicted ? tp / predicted : 0;
      const recall = support ? tp / support : NaN;
      const f1 = precision + recall > 0 && !Number.isNaN(recall) ? (2 * precision * recall) / (precision + recall) : 0;
      return [l, { tp, support, predicted, precision, recall, f1 }];
    }),
  ) as Record<L, { tp: number; support: number; predicted: number; precision: number; recall: number; f1: number }>;
  const withSupport = labels.filter((l) => per[l].support > 0);
  const macroF1 = withSupport.length ? withSupport.reduce((s, l) => s + per[l].f1, 0) / withSupport.length : NaN;
  const total = labels.reduce((s, t) => s + labels.reduce((u, p) => u + m[t][p], 0), 0);
  const correct = labels.reduce((s, l) => s + m[l][l], 0);
  return { per, macroF1, accuracy: total ? correct / total : NaN, correct, total };
}

/** Deterministic PRNG so the sampled cases are reproducible from the seed alone. */
export function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates with an injected RNG (never mutates the input). */
export function shuffle<T>(xs: readonly T[], rnd: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}
