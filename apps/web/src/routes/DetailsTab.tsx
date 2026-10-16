import { useEffect, useState } from "react";
import { api, type SettingsStatus } from "../lib/api.ts";
import { useSettings } from "../lib/settings.tsx";
import { formatDate } from "../lib/settings-core.ts";
import { kb, wordCount } from "../lib/wordDelta.ts";
import { useWorkspace } from "../lib/workspace.tsx";

export function DetailsTab() {
  const ws = useWorkspace();
  const { settings } = useSettings();
  const doc = ws.doc!;
  const [rules, setRules] = useState<number | null>(null);
  const [status, setStatus] = useState<SettingsStatus | null>(null);

  useEffect(() => {
    let live = true;
    void api.requirements(doc.id).then((r) => live && r.ok && setRules(r.data.items.length));
    void api.settingsStatus().then((r) => live && r.ok && setStatus(r.data));
    return () => { live = false; };
  }, [doc.id, ws.rulesKey]);

  const rows: [string, string][] = [
    ["Title", doc.title],
    ["Current version", `v${doc.version}`],
    ["Characters", doc.content.length.toLocaleString()],
    ["Words", wordCount(doc.content).toLocaleString()],
    ["Size", kb(new TextEncoder().encode(doc.content).length)],
    ["Created", formatDate(doc.createdAt, settings.dateFormat)],
    ["Last updated", formatDate(doc.updatedAt, settings.dateFormat)],
    ["SHA-256 of the text", doc.contentHash],
    ["Requirements", rules === null ? "…" : `${rules} of ${status?.limits.maxRequirementsPerDocument ?? 8}`],
    ["Stored in", status ? (status.storage === "postgres" ? "Postgres" : "SQLite") : "…"],
    ["Document id", doc.id],
  ];
  return (
    <div className="h-full min-h-0 overflow-y-auto bg-canvas">
      <div className="mx-auto max-w-3xl p-6 max-[640px]:p-3">
        <h2 className="font-display mb-4 text-xl font-semibold">Details</h2>
        <dl className="divide-y divide-line rounded-card border border-line bg-paper">
          {rows.map(([k, v]) => (
            <div key={k} className="grid grid-cols-[180px_minmax(0,1fr)] gap-4 px-4 py-2.5 text-sm max-[640px]:grid-cols-1 max-[640px]:gap-0.5">
              <dt className="text-muted">{k}</dt>
              <dd className={`tnum min-w-0 break-all ${k.startsWith("SHA") || k === "Document id" ? "font-mono text-[13px]" : ""}`}>{v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
