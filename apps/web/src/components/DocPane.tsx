import { useEffect, useRef } from "react";
import { Compartment, EditorState, type Extension, type Range as CMRange } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { cn } from "../lib/cn.ts";
import type { Applied } from "../lib/api.ts";
import type { Range } from "../lib/document-range.ts";

interface Props {
  content: string;
  hits: Range[];
  selection: { start: number; end: number } | null;
  redline: Applied[] | null;
  flash?: boolean;
  onSelect: (range: { start: number; end: number } | null) => void;
}

class InsertionWidget extends WidgetType {
  readonly text: string;
  constructor(text: string) { super(); this.text = text; }
  eq(other: InsertionWidget) { return this.text === other.text; }
  toDOM() {
    const span = document.createElement("span");
    span.className = "ins";
    const excerpt=this.text.length>2000?`${this.text.slice(0,2000)}…`:this.text;
    span.setAttribute("aria-label",`inserted: ${excerpt}`);
    span.textContent=excerpt;
    if(this.text.length>2000){span.title="Preview excerpt. The complete replacement is in the staged change.";}
    return span;
  }
}

function makeDecorations(content: string, hits: Range[], selection: Props["selection"], redline: Applied[] | null) {
  const ranges: CMRange<Decoration>[] = [];
  if (redline) {
    for (const change of redline) {
      if (change.before && change.end > change.start) ranges.push(Decoration.mark({ class: "del", attributes: { "aria-label": `deleted: ${change.before.slice(0,2000)}` } }).range(change.start, change.end));
      if (change.after) ranges.push(Decoration.widget({ widget: new InsertionWidget(change.after), side: -1 }).range(change.start));
    }
  } else {
    const candidates = [...hits, ...(selection ? [{ ...selection, kind: "sel" as const }] : [])]
      .filter((r) => r.start >= 0 && r.end > r.start && r.end <= content.length)
      .sort((a, b) => a.start - b.start || (a.kind === "sel" ? -1 : 1) || b.end - a.end);
    let end = -1;
    for (const range of candidates) {
      if (range.start < end) continue;
      ranges.push(Decoration.mark({ class: range.kind, attributes: { "data-kind": range.kind, "data-start": String(range.start), "data-end": String(range.end) } }).range(range.start, range.end));
      end = range.end;
    }
  }
  return Decoration.set(ranges, true);
}

export function DocPane({ content, hits, selection, redline, flash = false, onSelect }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onSelectRef = useRef(onSelect);
  const decorations = useRef(new Compartment());
  onSelectRef.current = onSelect;

  useEffect(() => {
    if (!host.current) return;
    const updateSelection: Extension = EditorView.updateListener.of((update) => {
      if (!update.selectionSet || redline) return;
      const range = update.state.selection.main;
      onSelectRef.current(range.empty ? null : { start: range.from, end: range.to });
    });
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: content,
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ "aria-label": "Document text", "data-testid": "doc-text" }),
          updateSelection,
          decorations.current.of(EditorView.decorations.of(makeDecorations(content, hits, selection, redline))),
        ],
      }),
    });
    viewRef.current = view;
    return () => { view.destroy(); viewRef.current = null; };
    // The editor is created once for this document body; later changes update decorations and selections in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: decorations.current.reconfigure(EditorView.decorations.of(makeDecorations(content, hits, selection, redline))) });
    if (selection && selection.end <= content.length) {
      view.dispatch({ selection: { anchor: selection.start, head: selection.end }, effects: EditorView.scrollIntoView(selection.start, { y: "center" }) });
    } else if (redline?.length) {
      const first = [...redline].sort((a, b) => a.start - b.start)[0];
      if (first) view.dispatch({ effects: EditorView.scrollIntoView(first.start, { y: "center" }) });
    } else if (hits[0]) {
      view.dispatch({ effects: EditorView.scrollIntoView(hits[0].start, { y: "center" }) });
    }
  }, [content, hits, selection, redline]);

  return <article className={cn("doc mx-auto my-6 max-w-[780px] select-text overflow-hidden rounded-card border border-line bg-paper px-12 py-10 max-[640px]:my-3 max-[640px]:px-5 max-[640px]:py-6", redline && "redline", flash && "saved")} aria-label="Document text">
    <div ref={host} />
  </article>;
}
