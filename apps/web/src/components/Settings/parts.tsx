import type { ReactNode } from "react";

/** A card of related rows, matching the Settings mockup. */
export function Card({ id, title, subtitle, children }: { id: string; title: string; subtitle: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="scroll-mt-4 rounded-xl border border-line bg-paper p-5">
      <h2 id={`${id}-h`} className="text-base font-bold">{title}</h2>
      <p className="mb-3 text-[13px] text-muted">{subtitle}</p>
      <div className="divide-y divide-line">{children}</div>
    </section>
  );
}

/** One labelled setting. `control` is the live widget; `note` is small print under the label. */
export function Row({ label, note, htmlFor, children }: { label: string; note?: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
      <div className="min-w-[11rem] flex-1">
        <label htmlFor={htmlFor} className="block text-sm font-medium">{label}</label>
        {note && <p className="text-xs text-muted">{note}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function Toggle({ id, checked, onChange }: { id: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      id={id}
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 rounded-full transition-colors ${checked ? "bg-accent" : "bg-line"}`}
    >
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${checked ? "left-[22px]" : "left-0.5"}`} />
    </button>
  );
}

export function Select<T extends string>({ id, value, options, onChange }: { id: string; value: T; options: readonly (readonly [T, string])[]; onChange: (v: T) => void }) {
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value as T)} className="rounded-md border border-line bg-paper px-2.5 py-1.5 text-sm">
      {options.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
    </select>
  );
}

/** A read-only fact from the server (or a fixed property of this deployment). */
export function Fact({ label, note, value }: { label: string; note?: string; value: ReactNode }) {
  return (
    <Row label={label} {...(note ? { note } : {})}>
      <span className="text-sm text-ink/80">{value}</span>
    </Row>
  );
}

/**
 * A feature the mockup shows but this prototype does not have. It is visibly disabled and says so in words,
 * so nobody can mistake it for a working control.
 */
export function Planned({ label, note }: { label: string; note?: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3 opacity-60" aria-disabled="true">
      <div className="min-w-[11rem] flex-1">
        <p className="text-sm font-medium">{label}</p>
        {note && <p className="text-xs text-muted">{note}</p>}
      </div>
      <span className="shrink-0 rounded-full border border-line px-2.5 py-0.5 text-[11px] font-semibold text-muted">Not in this prototype</span>
    </div>
  );
}
