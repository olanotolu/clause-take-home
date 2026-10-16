import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/cn.ts";

/**
 * One button vocabulary for the whole app. Press feedback is a 3% scale on :active (instant, 100ms), colour changes are
 * a plain ease, and only the properties that change are transitioned (never `all`).
 */
const button = cva(
  "inline-flex shrink-0 select-none items-center justify-center rounded-control font-medium transition-[transform,background-color,color,border-color] duration-100 ease-out active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100",
  {
    variants: {
      variant: {
        primary: "bg-accent text-accent-ink hover:bg-accent/90",
        secondary: "border border-line-strong bg-paper text-ink hover:bg-ink/[0.04]",
        ghost: "text-muted hover:bg-ink/[0.06] hover:text-ink",
        danger: "bg-fail text-white hover:bg-fail/90",
      },
      size: { sm: "h-8 gap-1.5 px-2.5 text-[13px]", md: "h-9 gap-2 px-3.5 text-sm" },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

interface Props extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof button> {
  loading?: boolean;
  icon?: ReactNode;
}

export function Button({ variant, size, loading = false, icon, disabled, className, children, type = "button", ...rest }: Props) {
  return (
    <button type={type} disabled={disabled || loading} aria-busy={loading || undefined} className={cn(button({ variant, size }), className)} {...rest}>
      {loading ? <Loader2 size={15} className="animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
}

/** For anchors that must look like a secondary button (e.g. file downloads). */
export const buttonClass = (opts?: VariantProps<typeof button>) => button(opts);
