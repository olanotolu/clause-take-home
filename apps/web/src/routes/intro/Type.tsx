import { motion, useTransform, type MotionValue } from "motion/react";
import type { Run } from "./content.ts";

/** One word, which arrives (rises and fades in) at its own point of the scroll. */
function Word({ p, at, strong, children }: { p: MotionValue<number>; at: number; strong: boolean; children: string }) {
  const opacity = useTransform(p, [at, at + 0.014], [0, 1], { clamp: true });
  const y = useTransform(opacity, [0, 1], [14, 0]);
  return (
    <motion.span style={{ opacity, y, fontWeight: strong ? 700 : 340 }} className="inline-block whitespace-pre">
      {children}
    </motion.span>
  );
}

/**
 * A sentence that writes itself in word by word as its beat scrolls in. The words are split from the runs once, so
 * the markup stays one paragraph for a screen reader (the span order is the reading order).
 */
export function Words({ p, from, to, runs }: { p: MotionValue<number>; from: number; to: number; runs: readonly Run[] }) {
  const words = runs.flatMap(([text, strong]) => text.split(/(?<=\s)/).filter(Boolean).map((w) => ({ w, strong: strong === true })));
  return (
    <>
      {words.map(({ w, strong }, i) => (
        <Word key={`${i}-${w}`} p={p} at={from + (i / words.length) * (to - from)} strong={strong}>
          {w}
        </Word>
      ))}
    </>
  );
}
