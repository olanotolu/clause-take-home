import { AlertTriangle, CheckCircle2, CircleHelp, CircleSlash, Info, XCircle } from "lucide-react";
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
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${TONE[tone]}`}>
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

/** An empty state teaches the next step instead of saying "nothing here". */
export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
      {icon && <div className="mb-1 text-muted">{icon}</div>}
      <p className="font-display text-lg font-semibold">{title}</p>
      {children && <p className="max-w-sm text-sm text-muted">{children}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
