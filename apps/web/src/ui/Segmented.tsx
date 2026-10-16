import type { ReactNode } from "react";
import { cn } from "../lib/cn.ts";
import { AnimatedBackground } from "./motion/animated-background.tsx";

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
  title?: string;
}

/**
 * A radiogroup whose highlight slides to the chosen option (a spring from the current position, so it stays
 * interruptible if you click quickly). Native buttons keep keyboard and screen-reader behaviour.
 */
export function Segmented<T extends string>({ value, onChange, options, label, className }: { value: T; onChange: (v: T) => void; options: readonly SegmentOption<T>[]; label: string; className?: string }) {
  return (
    <div role="radiogroup" aria-label={label} className={cn("inline-flex rounded-control bg-ink/[0.06] p-0.5 text-[13px]", className)}>
      <AnimatedBackground defaultValue={value} onValueChange={(id) => { if (id) onChange(id as T); }} className="rounded-md bg-paper shadow-[0_0_0_1px_var(--color-line),0_1px_2px_rgb(0_0_0/0.06)]" transition={{ type: "spring", bounce: 0.1, duration: 0.3 }}>
        {options.map((o) => (
          <button
            key={o.value}
            data-id={o.value}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            disabled={o.disabled}
            title={o.title}
            className={cn("h-8 rounded-md px-3 font-medium transition-colors duration-100 disabled:cursor-not-allowed disabled:opacity-40", value === o.value ? "text-ink" : "text-muted hover:text-ink")}
          >
            {o.label}
          </button>
        ))}
      </AnimatedBackground>
    </div>
  );
}
