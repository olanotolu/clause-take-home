import { ArrowRight, ChevronDown, ChevronUp, Download, FilePlus2, Pencil, Undo2 } from "../ui/icons.tsx";
import { useState } from "react";
import type { Revision } from "../lib/api.ts";
import { navigate } from "../lib/router.ts";
import { deltaLabel, wordCount } from "../lib/wordDelta.ts";
import { Button } from "../ui/Button.tsx";
import { Pill } from "../ui/bits.tsx";
import { ExportButton } from "./ExportButton.tsx";

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function kindOf(r: Pick<Revision, "summary">): "created" | "restored" | "edited" {
  if (r.summary[0]?.created) return "created";
  if (r.summary[0]?.revertedTo) return "restored";
  return "edited";
}

interface EntryProps {
  r: Pick<Revision, "version" | "contentHash" | "createdAt" | "summary">;
  current: boolean;
  docId: string;
  /** The document's current version; the .docx and Restore actions compare against it. */
  currentVersion: number;
  /** Set on the cross-document feed: names the document and links to it instead of offering Restore. */
  docTitle?: string;
  onRestore?: (version: number) => void;
}

export function ActivityEntry({ r, current, docId, currentVersion, docTitle, onRestore }: EntryProps) {
  const [open, setOpen] = useState(false);
  const kind = kindOf(r);
  const edits = kind === "edited" ? r.summary : [];
  const added = edits.reduce((n, s) => n + wordCount(s.after ?? ""), 0);
  const removed = edits.reduce((n, s) => n + wordCount(s.before ?? ""), 0);
  const Icon = kind === "created" ? FilePlus2 : kind === "restored" ? Undo2 : Pencil;
  const title = kind === "created" ? "Document created" : kind === "restored" ? `Restored the text of v${r.summary[0]?.revertedTo}` : `Edited ${edits.length} passage${edits.length === 1 ? "" : "s"}`;
  const shown = open ? edits : edits.slice(0, 2);

  return (
    <li className="relative flex gap-4 pb-5 last:pb-0">
      <span className="relative z-10 mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-line-strong bg-paper text-muted"><Icon size={15} aria-hidden /></span>
      <div className="min-w-0 flex-1 rounded-card border border-line bg-paper p-3.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {docTitle && <button type="button" onClick={() => navigate({ name: "doc", id: docId, tab: "edit" })} className="font-display text-[15px] font-semibold underline-offset-2 hover:text-accent hover:underline">{docTitle}</button>}
          <h3 className={`text-sm ${docTitle ? "text-muted" : "font-semibold"}`}>{title}</h3>
          <Pill>v{r.version}</Pill>
          {current && <Pill className="bg-accent-soft text-accent">current</Pill>}
          {(added > 0 || removed > 0) && <span className="tnum text-xs text-muted">{[deltaLabel(removed, "-"), deltaLabel(added, "+")].filter(Boolean).join(" ")}</span>}
          <span className="tnum ml-auto text-xs text-muted">{new Date(r.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
        </div>
        {edits.length > 0 && (
          <ul className="mt-2 space-y-1">
            {shown.map((s) => (
              <li key={"index" in s && "start" in s && "end" in s ? `${s.index}-${s.start}-${s.end}` : `${r.version}-${shown.indexOf(s)}`} className="text-[13px] leading-snug">
                <span className="del px-0.5">{open ? s.before : clip(s.before ?? "", 70)}</span>
                <ArrowRight size={12} className="mx-1.5 inline text-muted" aria-hidden />
                {s.after ? <span className="ins px-0.5">{open ? s.after : clip(s.after, 70)}</span> : <em className="text-muted">deleted</em>}
              </li>
            ))}
          </ul>
        )}
        {edits.length > 2 && (
          <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-accent">
            {open ? <><ChevronUp size={13} aria-hidden />Show less</> : <><ChevronDown size={13} aria-hidden />Show all {edits.length}</>}
          </button>
        )}
        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
          <p className="font-mono text-xs text-muted" title="SHA-256 of this version's text">sha256 {r.contentHash.slice(0, 12)}</p>
          {!current && onRestore && (
            <span className="flex items-center gap-1.5">
              <ExportButton href={`/api/documents/${docId}/export.docx?from=${r.version}&to=${currentVersion}`} aria-label={`Download Word redline since v${r.version}`} title={`Word file showing what changed since v${r.version} as tracked changes`} className="inline-flex h-8 items-center gap-1.5 rounded-control border border-line-strong bg-paper px-2.5 text-[13px] font-semibold hover:bg-canvas"><Download size={13} aria-hidden />.docx</ExportButton>
              <Button size="sm" icon={<Undo2 size={13} aria-hidden />} aria-label={`Restore v${r.version}`} title={`Make the text of v${r.version} current again, as a new version. History is kept.`} onClick={() => onRestore(r.version)}>Restore</Button>
            </span>
          )}
        </div>
      </div>
    </li>
  );
}

