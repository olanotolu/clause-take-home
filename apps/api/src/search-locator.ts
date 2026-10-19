const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function foldDiacritics(value: string) {
  return value.normalize("NFD").replace(/\p{M}/gu, "");
}

/** Returns a one-based UTF-16 source offset, matching SQLite unicode61's diacritic folding. */
export function foldedIndexOf(content: string, needle: string): number {
  const target = foldDiacritics(needle).toLowerCase();
  if (!target) return 0;
  const prefix = new Uint32Array(target.length);
  for (let i = 1, matched = 0; i < target.length; i += 1) {
    while (matched > 0 && target[i] !== target[matched]) matched = prefix[matched - 1]!;
    if (target[i] === target[matched]) matched += 1;
    prefix[i] = matched;
  }
  const ringSize = target.length;
  const sourceStarts = new Array<number>(ringSize);
  let matched = 0;
  let foldedOffset = 0;
  let result: { start: number; end: number } | undefined;
  for (let offset = 0; offset < content.length;) {
    const source = String.fromCodePoint(content.codePointAt(offset)!);
    const folded = source.codePointAt(0)! < 128 ? source.toLowerCase() : foldDiacritics(source).toLowerCase();
    if (result) {
      if (!folded) result.end = offset + source.length;
      else return result.start + 1;
    }
    for (let i = 0; i < folded.length; i += 1) {
      const unit = folded[i]!;
      while (matched > 0 && unit !== target[matched]) matched = prefix[matched - 1]!;
      if (unit === target[matched]) matched += 1;
      sourceStarts[foldedOffset % ringSize] = offset;
      foldedOffset += 1;
      if (matched === target.length) {
        result = { start: sourceStarts[(foldedOffset - target.length) % ringSize]!, end: offset + source.length };
        break;
      }
    }
    offset += source.length;
  }
  return result ? result.start + 1 : 0;
}

/** Finds the first likely FTS match in bounded source text for snippet generation. */
export function locateTerms(content: string, query: string): [number, number] | undefined {
  let foldedContent = "";
  const sourceStarts: number[] = [];
  const sourceEnds: number[] = [];
  for (let offset = 0; offset < content.length;) {
    const point = content.codePointAt(offset)!;
    const source = String.fromCodePoint(point);
    const folded = foldDiacritics(source);
    foldedContent += folded;
    for (let i = 0; i < folded.length; i += 1) {
      sourceStarts.push(offset);
      sourceEnds.push(offset + source.length);
    }
    offset += source.length;
  }
  const alts = [...query.matchAll(/"([^"]*)"|(\S+)/g)]
    .map((m) => {
      const term=m[1]??m[2]??"";
      // FTS splits underscores inside a query token (for example TAIL_EVIDENCE).
      // Mirror that separator while preserving literal punctuation elsewhere.
      const words = m[1] !== undefined ? (term.match(/[\p{L}\p{N}]+/gu) ?? []) : term.includes("_") ? (term.match(/[\p{L}\p{N}]+/gu) ?? []) : [term];
      const stem = (w: string) => (w.length > 4 ? w.slice(0, Math.max(4, Math.ceil(w.length * 0.7))) : w);
      return words.map((w) => `${escapeRegex(foldDiacritics(stem(w)))}[\\p{L}\\p{N}]*`).join("[^\\p{L}\\p{N}]+");
    })
    .filter(Boolean);
  if (alts.length === 0) return undefined;
  const m = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alts.join("|")})`, "iu").exec(foldedContent);
  return m ? [sourceStarts[m.index]!, sourceEnds[m.index + m[0].length - 1]!] : undefined;
}
