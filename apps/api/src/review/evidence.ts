import type { EvidenceSpan } from "./types.ts";

/** The text with every run of whitespace collapsed to one space, plus a map from each normalised index back to the original. */
function normalise(text: string): { norm: string; toOriginal: number[] } {
  const out: string[] = [];
  const toOriginal: number[] = [];
  let inSpace = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (/\s/.test(c)) {
      if (!inSpace && out.length > 0) {
        out.push(" ");
        toOriginal.push(i);
      }
      inSpace = true;
    } else {
      out.push(c);
      toOriginal.push(i);
      inSpace = false;
    }
  }
  return { norm: out.join(""), toOriginal };
}

const MIN_QUOTE_CHARS = 8;

/**
 * Checks model-supplied quotes against the real text. A quote counts as verified only if it appears VERBATIM, ignoring
 * nothing but differences in whitespace (models often re-wrap line breaks). Verified quotes are returned with the
 * document's own text and exact offsets; everything else comes back flagged `verified: false` and is never trusted.
 *
 * Very short quotes are rejected as evidence: "the" is "found" everywhere and proves nothing.
 */
export function verifyQuotes(text: string, quotes: readonly string[], max = 3): EvidenceSpan[] {
  const { norm, toOriginal } = normalise(text);
  const seen = new Set<string>();
  const out: EvidenceSpan[] = [];
  for (const raw of quotes) {
    const q = raw.replace(/\s+/g, " ").trim();
    if (!q || seen.has(q) || out.length >= max) continue;
    seen.add(q);
    const at = q.length >= MIN_QUOTE_CHARS ? norm.indexOf(q) : -1;
    if (at === -1) {
      out.push({ start: 0, end: 0, quote: raw.trim(), verified: false });
      continue;
    }
    const start = toOriginal[at]!;
    const end = toOriginal[at + q.length - 1]! + 1;
    out.push({ start, end, quote: text.slice(start, end), verified: true });
  }
  return out;
}
