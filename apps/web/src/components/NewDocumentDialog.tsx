import { useEffect, useRef, useState } from "react";
import { navigate } from "../lib/router.ts";
import { useWorkspace } from "../lib/workspace.tsx";
import { Button } from "../ui/Button.tsx";

export function NewDocumentDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ws = useWorkspace();
  const ref = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);

  const submit = async () => {
    setBusy(true);
    const id = await ws.create(title.trim(), content);
    setBusy(false);
    if (id) {
      setTitle("");
      setContent("");
      onClose();
    }
  };

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
      aria-labelledby="newdoc-h"
      className="m-auto max-h-[calc(100dvh-24px)] w-[min(560px,calc(100vw-24px))] overflow-y-auto rounded-2xl border border-line-strong bg-paper p-0 text-ink shadow-lift backdrop:bg-black/40"
    >
      <form className="space-y-4 p-5" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <div>
          <h2 id="newdoc-h" className="font-display text-xl font-semibold">New document</h2>
          <p className="text-sm text-muted">Paste contract text, or <button type="button" className="font-medium text-accent underline underline-offset-2" onClick={() => { onClose(); navigate({ name: "templates" }); }}>start from a template</button>.</p>
        </div>
        <label className="block text-sm font-medium">Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} placeholder="e.g. Mutual NDA, Acme Corp" className="mt-1 h-10 w-full rounded-control border border-line-strong bg-canvas px-3 text-sm font-normal" />
        </label>
        <label className="block text-sm font-medium">Text
          <textarea value={content} onChange={(e) => setContent(e.target.value)} required rows={9} placeholder="Paste the contract text. Plain text only: formatting is not kept." className="mt-1 max-h-[42dvh] min-h-36 w-full rounded-control border border-line-strong bg-canvas px-3 py-2 font-doc text-[14px] font-normal" />
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" loading={busy} disabled={!title.trim() || !content}>Create document</Button>
        </div>
      </form>
    </dialog>
  );
}
