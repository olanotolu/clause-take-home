import { Loader2 } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

const VARIANT: Record<Variant, string> = {
  primary: "bg-accent text-accent-ink hover:brightness-110 active:brightness-95 disabled:hover:brightness-100",
  secondary: "border border-line-strong bg-paper text-ink hover:bg-canvas active:bg-line/60",
  ghost: "text-muted hover:bg-line/60 hover:text-ink active:bg-line",
  danger: "bg-fail text-white hover:brightness-110 active:brightness-95",
};
const SIZE: Record<Size, string> = { sm: "h-8 gap-1.5 px-2.5 text-[13px]", md: "h-9 gap-2 px-3.5 text-sm" };

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
}

/** One button vocabulary for the whole app: same radius, focus ring, disabled and loading behaviour everywhere. */
export function Button({ variant = "secondary", size = "md", loading = false, icon, disabled, className = "", children, type = "button", ...rest }: Props) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`inline-flex shrink-0 items-center justify-center rounded-control font-semibold transition-[background-color,filter,color] duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${VARIANT[variant]} ${SIZE[size]} ${className}`}
      {...rest}
    >
      {loading ? <Loader2 size={15} className="animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
}
