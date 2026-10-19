import { queryTerms } from "./store/types.ts";

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Finds the first likely FTS match in bounded source text for snippet generation. */
export function locateTerms(content: string, query: string): [number, number] | undefined {
  const alts = queryTerms(query)
    .map((t) => {
      const words = t.split(/\s+/);
      const stem = (w: string) => (w.length > 4 ? w.slice(0, Math.max(4, Math.ceil(w.length * 0.7))) : w);
      return words.map((w, i) => escapeRegex(i === words.length - 1 ? stem(w) : w)).join("\\s+");
    })
    .filter(Boolean);
  if (alts.length === 0) return undefined;
  const m = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alts.join("|")})[\\p{L}\\p{N}]*`, "iu").exec(content);
  return m ? [m.index, m.index + m[0].length] : undefined;
}
