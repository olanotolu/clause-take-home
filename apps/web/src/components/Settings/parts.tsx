import type { ReactNode } from "react";
import { motion } from "motion/react";
import { Activity, BookOpenCheck, Brain, FileText, GearSix, Lock, type IconProps } from "../../ui/icons.tsx";

const SECTION_ICONS: Record<string, (props: IconProps) => ReactNode> = {
  general: GearSix,
  ai: Brain,
  editing: FileText,
  security: Lock,
  usage: Activity,
  planned: BookOpenCheck,
};

export function SettingsSectionIcon({ id, ...props }: { id: string } & IconProps) {
  const Icon = SECTION_ICONS[id] ?? GearSix;
  return <Icon {...props} />;
}

/** A card of related rows, matching the Settings mockup. */
export function Card({ id, title, subtitle, children }: { id: string; title: string; subtitle: string; children: ReactNode }) {
  return (
    <motion.section
      id={id}
      aria-labelledby={`${id}-h`}
      initial={{ opacity: 0, y: 10 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.08 }}
      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      className="settings-card scroll-mt-5 rounded-[20px] border border-line bg-paper p-5 sm:p-6"
    >
      <div className="mb-4 flex items-start gap-3.5">
        <motion.span
          key={`${id}-icon`}
          className="settings-card-icon grid size-12 shrink-0 place-items-center rounded-[17px] bg-accent-soft text-accent"
          whileTap={{ scale: 0.92, rotate: -5 }}
          transition={{ type: "spring", stiffness: 420, damping: 18 }}
        ><SettingsSectionIcon id={id} size={24} weight="duotone" aria-hidden /></motion.span>
        <div className="min-w-0 pt-0.5">
          <h2 id={`${id}-h`} className="text-[16px] font-semibold tracking-[-0.02em]">{title}</h2>
          <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{subtitle}</p>
        </div>
      </div>
      <div className="divide-y divide-line">{children}</div>
    </motion.section>
  );
}

/** One labelled setting. `control` is the live widget; `note` is small print under the label. */
export function Row({ label, note, htmlFor, children }: { label: string; note?: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="settings-row flex flex-wrap items-center justify-between gap-x-5 gap-y-2.5 py-3.5">
      <div className="min-w-[11rem] flex-1">
        <label htmlFor={htmlFor} className="block text-sm font-medium">{label}</label>
        {note && <p className="text-xs text-muted">{note}</p>}
      </div>
      <div className="settings-control shrink-0">{children}</div>
    </div>
  );
}

export function Toggle({ id, checked, onChange }: { id: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`settings-toggle relative h-6 w-11 rounded-full transition-colors duration-200 focus-visible:outline-offset-4 ${checked ? "bg-accent" : "bg-line-strong"}`}
    >
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-all duration-200 ${checked ? "left-[22px]" : "left-0.5"}`} />
    </button>
  );
}

export function Select<T extends string>({ id, value, options, onChange }: { id: string; value: T; options: readonly (readonly [T, string])[]; onChange: (v: T) => void }) {
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value as T)} className="min-w-[150px] rounded-[10px] border border-line-strong bg-paper px-3 py-2 text-[13px] shadow-[0_1px_2px_rgb(20_20_22/0.03)] transition-colors hover:border-accent/40 focus:border-accent">
      {options.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
    </select>
  );
}

/** A read-only fact from the server (or a fixed property of this deployment). */
export function Fact({ label, note, value }: { label: string; note?: string; value: ReactNode }) {
  return (
    <Row label={label} {...(note ? { note } : {})}>
      <span className="max-w-[min(28rem,60vw)] text-right text-[13px] leading-relaxed text-ink/80">{value}</span>
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
