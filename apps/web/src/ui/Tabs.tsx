import { motion } from "motion/react";
import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "../lib/cn.ts";

export interface TabDef<T extends string> {
  id: T;
  label: string;
  badge?: ReactNode;
  /** A node, or a function of "is this the active tab" so an icon can change weight when selected. */
  icon?: ReactNode | ((active: boolean) => ReactNode);
}

interface Props<T extends string> {
  tabs: readonly TabDef<T>[];
  value: T;
  onChange: (id: T) => void;
  label: string;
  /** Ids of the tab elements are `${idPrefix}-${tab.id}`; the active panel should use `${idPrefix}-panel`. */
  idPrefix: string;
  className?: string;
}

/**
 * WAI-ARIA tabs with roving tabindex: arrow keys, Home and End move between tabs. The underline slides to the active
 * tab on a spring (it retargets from where it is, so quick clicks never queue up behind a finished animation).
 */
export function Tabs<T extends string>({ tabs, value, onChange, label, idPrefix, className }: Props<T>) {
  const refs = useRef(new Map<T, HTMLButtonElement>());
  const onKey = (e: KeyboardEvent) => {
    const i = tabs.findIndex((t) => t.id === value);
    const next = e.key === "ArrowRight" ? (i + 1) % tabs.length : e.key === "ArrowLeft" ? (i - 1 + tabs.length) % tabs.length : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    const t = tabs[next]!;
    onChange(t.id);
    refs.current.get(t.id)?.focus();
  };
  return (
    <div role="tablist" aria-label={label} onKeyDown={onKey} className={cn("flex gap-1 overflow-x-auto", className)}>
      {tabs.map((t) => {
        const active = t.id === value;
        return (
          <button
            type="button"
            key={t.id}
            ref={(el) => { if (el) refs.current.set(t.id, el); }}
            id={`${idPrefix}-${t.id}`}
            role="tab"
            aria-selected={active}
            aria-controls={`${idPrefix}-panel`}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(t.id)}
            className={cn("relative inline-flex h-10 shrink-0 items-center gap-1.5 whitespace-nowrap px-3 text-sm font-medium transition-colors duration-100", active ? "text-ink" : "text-muted hover:text-ink")}
          >
            {t.icon !== undefined && <span className={cn("flex", active && "text-accent")}>{typeof t.icon === "function" ? t.icon(active) : t.icon}</span>}
            {t.label}
            {t.badge}
            {active && <motion.span layoutId={`${idPrefix}-underline`} className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-accent" transition={{ type: "spring", bounce: 0.1, duration: 0.3 }} />}
          </button>
        );
      })}
    </div>
  );
}
