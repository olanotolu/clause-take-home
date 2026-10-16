import { Pencil, ShieldCheck, Search, X } from "../ui/icons.tsx";
import { useEffect, useRef, useState, type RefObject } from "react";
import { countOccurrences } from "../lib/segments.ts";
import { plural } from "../lib/wordDelta.ts";
import { Button } from "../ui/Button.tsx";

interface Props {
  container: RefObject<HTMLElement | null>;
  content: string;
  selection: { start: number; end: number };
  onStage: (replacement: string) => void;
  onProtect: (text: string) => void;
  onFind: (text: string) => void;
  onClear: () => void;
}

/**
 * Appears next to the selected passage. Positioned from the highlighted span itself (not the native selection, which
 * is cleared when the highlight re-renders), inside the scroll container so it moves with the text.
 */
export function SelectionToolbar({ container, content, selection, onStage, onProtect, onFind, onClear }: Props) {
  const selected = content.slice(selection.start, selection.end);
  const [pos, setPos] = useState<{ top: number; bottom: number; left: number } | null>(null);
  const [composing, setComposing] = useState(false);
  const [text, setText] = useState(selected);
  const area = useRef<HTMLTextAreaElement>(null);

  // A new selection starts fresh.
  useEffect(() => {
    setComposing(false);
    setText(selected);
  }, [selection.start, selection.end, selected]);

  // A search selection may exist on mount; passive effects see the parent's attached scroll ref.
  useEffect(() => {
    const c = container.current;
    const span = c?.querySelector<HTMLElement>('[data-kind="sel"]');
    if (!c || !span) return setPos(null);
    const place = () => {
      const rects = span.getClientRects();
      const first = rects[0] ?? span.getBoundingClientRect();
      const last = rects[rects.length - 1] ?? first;
      const cr = c.getBoundingClientRect();
      const left = Math.max(8, Math.min(first.left - cr.left, c.clientWidth - 320));
      setPos({ top: first.top - cr.top + c.scrollTop, bottom: last.bottom - cr.top + c.scrollTop, left });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [container, selection.start, selection.end, content]);

  useEffect(() => {
    if (composing) area.current?.focus();
  }, [composing]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClear();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClear]);

  if (!pos) return null;
  const occurrences = countOccurrences(content, selected);
  const unchanged = text === selected;

  return (
    <div className="absolute z-20 w-[min(320px,calc(100%-16px))]" style={composing ? { top: pos.bottom + 8, left: pos.left } : { top: pos.top, left: pos.left, transform: "translateY(calc(-100% - 8px))" }}>
      {composing ? (
        // biome-ignore lint/a11y/useSemanticElements: a styled popover composer; a fieldset would bring browser borders and legend layout
        <div className="pop rounded-card bg-paper p-3 shadow-lift [--origin:top_left]" role="group" aria-label="Replace selected passage">
          <label htmlFor="replace-text" className="mb-1 block text-xs font-medium text-muted">
            Replace with <span className="font-normal">· {occurrences === 1 ? "unique in this version" : `appears ${plural(occurrences, "time")}, anchored by its context`}</span>
          </label>
          <textarea
            id="replace-text"
            ref={area}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !unchanged) { e.preventDefault(); onStage(text); }
            }}
            rows={4}
            placeholder="Leave empty to delete the passage"
            className="w-full resize-y rounded-control border border-line-strong bg-canvas px-2.5 py-2 font-doc text-[14px]"
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            <Button size="sm" variant="ghost" onClick={() => setComposing(false)}>Cancel</Button>
            <Button size="sm" variant="primary" disabled={unchanged} onClick={() => onStage(text)} title={unchanged ? "The text is identical, so nothing would change" : "Add to proposed changes (⌘↵)"}>
              {text === "" ? "Stage deletion" : "Stage change"}
            </Button>
          </div>
        </div>
      ) : (
        <div role="toolbar" aria-label="Selected passage" className="pop inline-flex items-center gap-0.5 rounded-card bg-paper p-1 shadow-lift [--origin:bottom_left]">
          <Button size="sm" variant="ghost" icon={<Pencil size={14} aria-hidden />} onClick={() => setComposing(true)}>Replace</Button>
          <Button size="sm" variant="ghost" icon={<ShieldCheck size={14} aria-hidden />} onClick={() => onProtect(selected)} title="Add a requirement that this exact passage must survive every edit">Protect</Button>
          <Button size="sm" variant="ghost" icon={<Search size={14} aria-hidden />} onClick={() => onFind(selected)} title="Find every occurrence">Find</Button>
          <Button size="sm" variant="ghost" aria-label="Clear selection" onClick={onClear}><X size={14} aria-hidden /></Button>
        </div>
      )}
    </div>
  );
}
