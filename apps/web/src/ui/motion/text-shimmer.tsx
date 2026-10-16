/*
 * Adapted from Motion Primitives (https://motion-primitives.com), MIT License, Copyright (c) 2024 ibelick.
 * Changes: colours come from our tokens (muted text with an ink highlight sweeping across), our `cn`, the motion component
 * is created once per element type instead of on every render, and it stops moving under prefers-reduced-motion.
 */
import { motion, useReducedMotion } from "motion/react";
import { memo, useMemo, type CSSProperties, type ElementType } from "react";
import { cn } from "../../lib/cn.ts";

export type TextShimmerProps = {
  children: string;
  as?: "p" | "span" | "div";
  className?: string;
  duration?: number;
  spread?: number;
};

const MotionP = motion.create("p");
const MotionSpan = motion.create("span");
const MotionDiv = motion.create("div");
const BY_TAG: Record<NonNullable<TextShimmerProps["as"]>, ElementType> = { p: MotionP, span: MotionSpan, div: MotionDiv };

function TextShimmerComponent({ children, as = "p", className, duration = 2, spread = 2 }: TextShimmerProps) {
  const reduce = useReducedMotion();
  const Tag = BY_TAG[as];
  const dynamicSpread = useMemo(() => children.length * spread, [children, spread]);

  if (reduce) return <Tag className={cn("text-muted", className)}>{children}</Tag>;

  return (
    <Tag
      className={cn(
        "relative inline-block bg-[length:250%_100%,auto] bg-clip-text text-transparent",
        "[--base-color:var(--color-muted)] [--base-gradient-color:var(--color-ink)]",
        "[background-repeat:no-repeat,padding-box] [--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--base-gradient-color),#0000_calc(50%+var(--spread)))]",
        className,
      )}
      initial={{ backgroundPosition: "100% center" }}
      animate={{ backgroundPosition: "0% center" }}
      transition={{ repeat: Infinity, duration, ease: "linear" }}
      style={{ "--spread": `${dynamicSpread}px`, backgroundImage: "var(--bg), linear-gradient(var(--base-color), var(--base-color))" } as CSSProperties}
    >
      {children}
    </Tag>
  );
}

export const TextShimmer = memo(TextShimmerComponent);
