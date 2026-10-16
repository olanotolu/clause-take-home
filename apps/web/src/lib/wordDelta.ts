export const wordCount = (s: string): number => (s.trim() ? s.trim().split(/\s+/).length : 0);

/** Words added and removed by replacing `before` with `after`. Counts are per side, never netted, so a swap reads +4 / -4. */
export function wordDelta(before: string, after: string): { added: number; removed: number } {
  return { added: wordCount(after), removed: wordCount(before) };
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "+3 words" / "-12 words" for a chip; empty when nothing changed. */
export function deltaLabel(n: number, sign: "+" | "-"): string {
  return n === 0 ? "" : `${sign}${plural(n, "word")}`;
}

const UNITS: [number, Intl.RelativeTimeFormatUnit][] = [[60, "second"], [60, "minute"], [24, "hour"], [7, "day"], [4.35, "week"], [12, "month"]];

/** "3 minutes ago". `now` is injectable so tests are deterministic. */
export function ago(iso: string, now = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  let diff = Math.round((t - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [size, unit] of UNITS) {
    if (Math.abs(diff) < size) return rtf.format(diff, unit);
    diff = Math.round(diff / size);
  }
  return rtf.format(diff, "year");
}

export function kb(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
