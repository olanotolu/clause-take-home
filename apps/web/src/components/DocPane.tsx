import { useEffect, useMemo, useRef } from "react";
import { cn } from "../lib/cn.ts";
import { highlightPieces, redlinePieces, type Piece, type Range } from "../lib/segments.ts";
import type { Applied } from "../lib/api.ts";

interface Props {
  content: string;
  hits: Range[];
  selection: { start: number; end: number } | null;
  /** When set, render an inline redline of these spans instead of the plain document. */
  redline: Applied[] | null;
  /** Plays the one-off "saved" ring around the sheet. */
  flash?: boolean;
  onSelect: (range: { start: number; end: number } | null) => void;
}

const CLASS: Record<Piece["kind"], string> = { plain: "", hit: "hit", sel: "sel", del: "del", ins: "ins" };

/**
 * Maps a DOM selection boundary back to an offset in the ORIGINAL text. Every
 * piece of original text is its own <span data-start>, so offset = span.start +
 * offset within that text node. Both sides are UTF-16 code units.
 */
function boundary(node: Node, offset: number, isEnd: boolean): number | null {
  if (node.nodeType === Node.TEXT_NODE) {
    const span = node.parentElement?.closest<HTMLElement>("[data-start]");
    return span?.dataset.start === undefined ? null : Number(span.dataset.start) + offset;
  }
  const child = node.childNodes[isEnd ? offset - 1 : offset] as HTMLElement | undefined;
  const span = child?.closest?.<HTMLElement>("[data-start]") ?? child?.querySelector?.<HTMLElement>("[data-start]");
  if (!span?.dataset.start) return null;
  return Number(span.dataset.start) + (isEnd ? (span.textContent?.length ?? 0) : 0);
}

export function DocPane({ content, hits, selection, redline, flash = false, onSelect }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const pieces = useMemo(
    () => (redline ? redlinePieces(content, redline) : highlightPieces(content, [...hits, ...(selection ? [{ ...selection, kind: "sel" as const }] : [])])),
    [content, hits, selection, redline],
  );

  // Bring the focused highlight (selection first, else first search hit) into view.
  useEffect(() => {
    ref.current?.querySelector("[data-focus]")?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [selection, hits, redline]);

  const handleMouseUp = () => {
    if (redline || !ref.current) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    const r = sel.getRangeAt(0);
    if (!ref.current.contains(r.startContainer) || !ref.current.contains(r.endContainer)) return;
    const start = boundary(r.startContainer, r.startOffset, false);
    const end = boundary(r.endContainer, r.endOffset, true);
    if (start === null || end === null || end <= start) return;
    onSelect({ start, end });
  };

  let focused = false;
  return (
    <article
      ref={ref}
      onMouseUp={handleMouseUp}
      className={cn("doc mx-auto my-6 max-w-[780px] select-text rounded-card border border-line bg-paper px-12 py-10 max-[640px]:my-3 max-[640px]:px-5 max-[640px]:py-6", redline && "redline", flash && "saved")}
      aria-label="Document text"
      data-testid="doc-text"
    >
      {pieces.map((p, i) => {
        // In redline mode, jump to the first change; otherwise to the selection, else the first search hit.
        const focus = !focused && (redline ? p.kind === "del" || p.kind === "ins" : p.kind === "sel" || (p.kind === "hit" && !selection));
        if (focus) focused = true;
        return (
          <span key={i} className={CLASS[p.kind]} data-start={p.start} data-focus={focus ? "" : undefined} data-kind={p.kind}>
            {p.kind === "del" && <span className="sr-only">deleted: </span>}
            {p.kind === "ins" && <span className="sr-only">inserted: </span>}
            {p.text}
          </span>
        );
      })}
    </article>
  );
}
