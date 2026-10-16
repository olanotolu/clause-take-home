import { motion, useTransform, type MotionValue } from "motion/react";
import type { ReactNode } from "react";
import { BONE } from "./content.ts";

/**
 * Plain API receipts, one per beat: the actual shape of what the service answers, set in monospace on the scene. Lines
 * appear in step with the scroll. The ids and offsets are an example, and the panel says so.
 */
const MONO = 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace';

function Line({ p, at, children, strong = false }: { p: MotionValue<number>; at: number; children: ReactNode; strong?: boolean }) {
  const o = useTransform(p, [at, at + 0.012], [0, 1], { clamp: true });
  const x = useTransform(o, [0, 1], [-6, 0]);
  return (
    <motion.div style={{ opacity: o, x, fontWeight: strong ? 600 : 400 }} className="whitespace-pre-wrap break-words">
      {children}
    </motion.div>
  );
}

function Receipt({ label, children }: { label: string; children: ReactNode }) {
  return (
    <figure
      aria-label={label}
      className="w-full max-w-[470px] rounded-[10px] border px-4 py-3.5 text-[12.5px] leading-[1.7] max-[640px]:px-3 max-[640px]:text-[11.5px]"
      style={{ fontFamily: MONO, color: BONE, background: "rgb(18 9 4 / .58)", borderColor: "rgb(246 234 210 / .26)", backdropFilter: "blur(6px)" }}
    >
      {children}
      <figcaption className="mt-2 text-[10.5px] uppercase tracking-[0.14em]" style={{ color: "rgb(246 234 210 / .62)" }}>example response</figcaption>
    </figure>
  );
}

const dim = { color: "rgb(246 234 210 / .66)" } as const;

export function ResolvePanel({ p, s }: { p: MotionValue<number>; s: number }) {
  const t = s + 0.04;
  return (
    <Receipt label="An example response: a replace whose target text matches three places is refused with 409 AMBIGUOUS_TARGET and the three candidates">
      <Line p={p} at={t}>PATCH /documents/doc_8f2a1c</Line>
      <Line p={p} at={t + 0.012}><span style={dim}>replace</span> “shall not disclose”</Line>
      <Line p={p} at={t + 0.035} strong>409 AMBIGUOUS_TARGET</Line>
      <Line p={p} at={t + 0.05}><span style={dim}>[0]</span> 412–430 …Receiving Party shall not disclose Confidential…</Line>
      <Line p={p} at={t + 0.062}><span style={dim}>[1]</span> 988–1006 …Disclosing Party shall not disclose Trade…</Line>
      <Line p={p} at={t + 0.074}><span style={dim}>[2]</span> 1534–1552 …Neither party shall not disclose the Term.</Line>
      <Line p={p} at={t + 0.092}><span style={dim}>choose with</span> occurrence, prefix or an offset range</Line>
    </Receipt>
  );
}

export function VersionPanel({ p, s }: { p: MotionValue<number>; s: number }) {
  const t = s + 0.04;
  return (
    <Receipt label="An example response: an edit made against version 2 of a document that is now at version 3 is refused with 409 VERSION_CONFLICT">
      <Line p={p} at={t}>PATCH /documents/doc_8f2a1c</Line>
      <Line p={p} at={t + 0.012}><span style={dim}>expectedVersion</span> 2</Line>
      <Line p={p} at={t + 0.035} strong>409 VERSION_CONFLICT</Line>
      <Line p={p} at={t + 0.05}><span style={dim}>expectedVersion</span> 2</Line>
      <Line p={p} at={t + 0.062}><span style={dim}>currentVersion </span> 3</Line>
      <Line p={p} at={t + 0.08}><span style={dim}>nothing written. no merge. reload and retry.</span></Line>
    </Receipt>
  );
}

export function CheckPanel({ p, s }: { p: MotionValue<number>; s: number }) {
  const t = s + 0.04;
  return (
    <Receipt label="An example response: Clause CI checks an edit against three rules; one holds, one fails, one needs review">
      <Line p={p} at={t}>POST /documents/doc_8f2a1c/changes/check</Line>
      <Line p={p} at={t + 0.03} strong>200 · 3 rules</Line>
      <Line p={p} at={t + 0.045}><span style={dim}>holds        </span> Mutual confidentiality</Line>
      <Line p={p} at={t + 0.06} strong><span style={{ color: "#ffb59a" }}>FAILS        </span> No perpetual term</Line>
      <Line p={p} at={t + 0.075}><span style={dim}>needs review </span> Survival period stated</Line>
      <Line p={p} at={t + 0.092}><span style={dim}>nothing is saved until the PATCH.</span></Line>
    </Receipt>
  );
}
