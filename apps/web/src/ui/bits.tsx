import { AlertTriangle, CheckCircle2, CircleHelp, CircleSlash, Info, XCircle } from "./icons.tsx";
import type { ReactNode } from "react";

export type Tone = "pass" | "fail" | "review" | "info" | "neutral";

const TONE: Record<Tone, string> = {
  pass: "bg-pass-bg text-pass",
  fail: "bg-fail-bg text-fail",
  review: "bg-review-bg text-review",
  info: "bg-accent-soft text-accent",
  neutral: "bg-line/70 text-muted",
};
const ICON = { pass: CheckCircle2, fail: XCircle, review: AlertTriangle, info: Info, neutral: CircleHelp } as const;

/** Small status label. Always carries an icon and words, so colour is never the only signal. */
export function StatusPill({ tone, children, icon = true }: { tone: Tone; children: ReactNode; icon?: boolean }) {
  const I = ICON[tone];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${TONE[tone]}`}>
      {icon && <I size={12} aria-hidden />}
      {children}
    </span>
  );
}

export function Pill({ children, className = "", title }: { children: ReactNode; className?: string; title?: string }) {
  return <span title={title} className={`inline-flex items-center gap-1 rounded-md bg-line/60 px-1.5 py-0.5 text-xs font-medium text-muted ${className}`}>{children}</span>;
}

export const Unavailable = CircleSlash;

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line-strong bg-paper px-1.5 py-px font-sans text-[11px] font-medium text-muted">{children}</kbd>;
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden className={`skeleton ${className}`} />;
}

/**
 * An empty state says what is missing and the one thing to do about it: plain text, left-aligned, no illustration and no
 * centred icon (that composition is the signature of generated UI). `icon` is accepted for call sites but not drawn.
 */
export function EmptyState({ title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="max-w-md px-1 py-3">
      <p className="text-sm font-medium">{title}</p>
      {children && <p className="mt-0.5 text-[13px] leading-snug text-muted">{children}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}
