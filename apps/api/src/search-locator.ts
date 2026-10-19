const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Finds the first likely FTS match in bounded source text for snippet generation. */
export function locateTerms(content: string, query: string): [number, number] | undefined {
  const alts = [...query.matchAll(/"([^"]*)"|(\S+)/g)]
    .map((m) => {
      const term=m[1]??m[2]??"";
      // FTS treats punctuation inside a query token (for example TAIL_EVIDENCE)
      // as a token boundary. Mirror that behavior so the bounded locator can map
      // the database hit back to source text without falling back to snippet().
      const words = term.match(/[\p{L}\p{N}]+/gu) ?? [];
      const stem = (w: string) => (w.length > 4 ? w.slice(0, Math.max(4, Math.ceil(w.length * 0.7))) : w);
      return words.map((w) => `${escapeRegex(stem(w))}[\\p{L}\\p{N}]*`).join("[^\\p{L}\\p{N}]+");
    })
    .filter(Boolean);
  if (alts.length === 0) return undefined;
  const m = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alts.join("|")})`, "iu").exec(content);
  return m ? [m.index, m.index + m[0].length] : undefined;
}
