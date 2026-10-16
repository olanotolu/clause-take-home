import { useRef, type KeyboardEvent, type ReactNode } from "react";

export interface TabDef<T extends string> {
  id: T;
  label: string;
  badge?: ReactNode;
  icon?: ReactNode;
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

/** WAI-ARIA tabs with roving tabindex: arrow keys, Home and End move between tabs. */
export function Tabs<T extends string>({ tabs, value, onChange, label, idPrefix, className = "" }: Props<T>) {
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
    <div role="tablist" aria-label={label} onKeyDown={onKey} className={`flex gap-1 overflow-x-auto ${className}`}>
      {tabs.map((t) => {
        const active = t.id === value;
        return (
          <button
            key={t.id}
            ref={(el) => { if (el) refs.current.set(t.id, el); }}
            id={`${idPrefix}-${t.id}`}
            role="tab"
            aria-selected={active}
            aria-controls={`${idPrefix}-panel`}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(t.id)}
            className={`relative inline-flex h-10 shrink-0 items-center gap-1.5 whitespace-nowrap px-3 text-sm font-medium transition-colors duration-150 after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full ${
              active ? "text-ink after:bg-accent" : "text-muted after:bg-transparent hover:text-ink"
            }`}
          >
            {t.icon}
            {t.label}
            {t.badge}
          </button>
        );
      })}
    </div>
  );
}
