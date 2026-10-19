import { diffArrays, diffWordsWithSpace } from "diff";
import { DeletedTextRun, Document, InsertedTextRun, Packer, Paragraph, TextRun } from "docx";

/** Diffing is super-linear in the worst case (one huge changed paragraph); refuse rather than hang the server on a huge pair of versions. */
export const MAX_EXPORT_CHARS = 25 * 1024 * 1024;

export interface RedlineInput {
  title: string;
  from: { version: number; content: string };
  to: { version: number; content: string; createdAt: string };
}

type Kind = "same" | "ins" | "del";

type Block = { kind: Kind; value: string };

/** Above this many line pairs, a gap with no anchor is paired in order rather than searched (Myers is O(N·D)). */
const MAX_MYERS_CELLS = 250_000;

/** Appends text to the last block when it has the same kind, so runs stay as few and as long as possible. */
const push = (out: Block[], kind: Kind, value: string) => {
  if (!value) return;
  const last = out.at(-1);
  if (last?.kind === kind) last.value += value;
  else out.push({ kind, value });
};

/**
 * Line-level diff, patience style. Lines that occur exactly once in both versions are anchors; their longest
 * increasing run (in both orders) fixes the alignment, and only the gaps between anchors are diffed further. Contracts
 * are mostly unique paragraphs, so the gaps are tiny and the whole thing is close to linear. A gap with no unique
 * line (repeated boilerplate) falls back to Myers on just that gap.
 */
function diffLineRange(a: string[], aLo: number, aHi: number, b: string[], bLo: number, bHi: number, out: Block[]): void {
  while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) {
    push(out, "same", a[aLo]!);
    aLo++;
    bLo++;
  }
  let aEnd = aHi;
  let bEnd = bHi;
  while (aEnd > aLo && bEnd > bLo && a[aEnd - 1] === b[bEnd - 1]) {
    aEnd--;
    bEnd--;
  }

  if (aLo === aEnd) push(out, "ins", b.slice(bLo, bEnd).join(""));
  else if (bLo === bEnd) push(out, "del", a.slice(aLo, aEnd).join(""));
  else {
    const seen = new Map<string, { inA: number; inB: number; ia: number; ib: number }>();
    for (let i = aLo; i < aEnd; i++) {
      const e = seen.get(a[i]!);
      if (e) e.inA++;
      else seen.set(a[i]!, { inA: 1, inB: 0, ia: i, ib: -1 });
    }
    for (let j = bLo; j < bEnd; j++) {
      const e = seen.get(b[j]!);
      if (e) {
        e.inB++;
        e.ib = j;
      }
    }
    // Anchors in A order, then the longest run whose B positions also increase (patience sorting, O(k log k)).
    const anchors = [...seen.values()].filter((e) => e.inA === 1 && e.inB === 1).sort((x, y) => x.ia - y.ia);
    const tails: number[] = [];
    const prev: number[] = new Array(anchors.length).fill(-1);
    for (let k = 0; k < anchors.length; k++) {
      let lo = 0;
      let hi = tails.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (anchors[tails[mid]!]!.ib < anchors[k]!.ib) lo = mid + 1;
        else hi = mid;
      }
      if (lo > 0) prev[k] = tails[lo - 1]!;
      tails[lo] = k;
    }
    const chain: number[] = [];
    for (let k = tails.length ? tails[tails.length - 1]! : -1; k !== -1; k = prev[k]!) chain.push(k);
    chain.reverse();

    if (chain.length === 0 && (aEnd - aLo) * (bEnd - bLo) <= MAX_MYERS_CELLS) {
      for (const c of diffArrays(a.slice(aLo, aEnd), b.slice(bLo, bEnd))) push(out, c.added ? "ins" : c.removed ? "del" : "same", c.value.join(""));
    } else if (chain.length === 0) {
      // A big gap with no line to anchor on (say, every paragraph rewritten): pair paragraphs in order instead of an
      // O(N·D) search. Still exact for Accept/Reject, just not a minimal diff.
      const n = Math.min(aEnd - aLo, bEnd - bLo);
      for (let k = 0; k < n; k++) {
        push(out, "del", a[aLo + k]!);
        push(out, "ins", b[bLo + k]!);
      }
      push(out, "del", a.slice(aLo + n, aEnd).join(""));
      push(out, "ins", b.slice(bLo + n, bEnd).join(""));
    } else {
      let pa = aLo;
      let pb = bLo;
      for (const k of chain) {
        const { ia, ib } = anchors[k]!;
        diffLineRange(a, pa, ia, b, pb, ib, out);
        push(out, "same", a[ia]!);
        pa = ia + 1;
        pb = ib + 1;
      }
      diffLineRange(a, pa, aEnd, b, pb, bEnd, out);
    }
  }
  push(out, "same", a.slice(aEnd, aHi).join(""));
}

const linesOf = (text: string) => text.split(/(?<=\n)/).filter((l) => l !== "");

/**
 * The changes between two texts as runs of unchanged, inserted and deleted text. Concatenating the "same" and "del"
 * runs gives `from`; the "same" and "ins" runs give `to` (property-tested), which is what makes Word's Reject-all and
 * Accept-all exact.
 *
 * Two levels, because a word diff over a whole contract is O(N·D) in words: it measured 5.8 s for a 1M-character pair
 * with a fifth of its lines changed. Paragraphs are lines here, so: align the lines first (patience, near-linear for
 * contracts), then word-diff only each block where deleted lines meet inserted ones.
 */
export function redlineParts(from: string, to: string): Block[] {
  const a = linesOf(from);
  const b = linesOf(to);
  const lines: Block[] = [];
  diffLineRange(a, 0, a.length, b, 0, b.length, lines);
  const parts: Block[] = [];
  for (let i = 0; i < lines.length; i++) {
    const block = lines[i]!;
    const next = lines[i + 1];
    if (block.kind !== "same" && next && next.kind !== "same") {
      // A modified block: word-level detail inside it only.
      const [del, ins] = block.kind === "del" ? [block, next] : [next, block];
      for (const w of diffWordsWithSpace(del.value, ins.value)) push(parts, w.added ? "ins" : w.removed ? "del" : "same", w.value);
      i++;
    } else {
      push(parts, block.kind, block.value);
    }
  }
  return parts;
}

/**
 * Builds a .docx whose differences between two versions are NATIVE Word tracked changes (<w:ins>/<w:del>), so Word's
 * Review pane lists them and Accept/Reject work. Plain text only: no styles, tables or numbering from an original
 * Word file exist here, so none are produced.
 *
 * Paragraph structure follows the text: every "\\n" ends a paragraph, whether it sits in unchanged, inserted or
 * deleted text, and inserted/deleted breaks are tracked as changes to the paragraph mark.
 */
export async function redlineDocx(input: RedlineInput): Promise<Buffer> {
  const author = "CLAUSE";
  const date = input.to.createdAt;
  let nextId = 1;

  const run = (kind: Kind, text: string) => {
    if (kind === "ins") return new InsertedTextRun({ text, id: nextId++, author, date });
    if (kind === "del") return new DeletedTextRun({ text, id: nextId++, author, date });
    return new TextRun(text);
  };

  const change = () => ({ id: nextId++, author, date });
  const paragraphs: Paragraph[] = [];
  let current: (TextRun | InsertedTextRun | DeletedTextRun)[] = [];
  // The line break that ENDS a paragraph is a "paragraph mark". If that break was inserted (or deleted) the mark itself
  // is a tracked change, so Reject-all (or Accept-all) merges the paragraphs back exactly as Word would.
  const endParagraph = (mark: Kind) => {
    const run = mark === "ins" ? { insertion: change() } : mark === "del" ? { deletion: change() } : undefined;
    paragraphs.push(new Paragraph({ children: current, ...(run && { run }) }));
    current = [];
  };

  for (const { kind, value } of redlineParts(input.from.content, input.to.content)) {
    value.split("\n").forEach((piece, i) => {
      if (i > 0) endParagraph(kind);
      if (piece) current.push(run(kind, piece));
    });
  }
  endParagraph("same"); // the last paragraph has no ending break

  const doc = new Document({
    creator: author,
    title: `${input.title}: redline v${input.from.version} to v${input.to.version}`,
    description: `Tracked changes from version ${input.from.version} to version ${input.to.version}, generated by CLAUSE.`,
    styles: { default: { document: { run: { font: "Times New Roman", size: 24 } } } },
    sections: [{ children: paragraphs }],
  });
  return Packer.toBuffer(doc);
}
