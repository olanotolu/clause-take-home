import { motion, useTransform, type MotionValue } from "motion/react";
import { useTilt } from "./Motion.tsx";
import type { ReactNode } from "react";
import { BONE } from "./content.ts";

/**
 * One example of what the service answers per beat, set as a designed table in the page's own typeface (tabular
 * numerals keep the figures aligned). Rows arrive with the scroll. The ids and offsets are an example, and it says so.
 */
const DIM = "rgb(246 234 210 / .62)";
const HAIR = "rgb(246 234 210 / .13)";

function Row({ p, at, k, children, strong = false, warn = false }: { p: MotionValue<number>; at: number; k: string; children: ReactNode; strong?: boolean; warn?: boolean }) {
  const o = useTransform(p, [at, at + 0.012], [0, 1], { clamp: true });
  const x = useTransform(o, [0, 1], [-8, 0]);
  return (
    <motion.div style={{ opacity: o, x, borderColor: HAIR }} className="grid grid-cols-[88px_minmax(0,1fr)] items-baseline gap-3 border-t py-[7px] first:border-t-0 max-[640px]:grid-cols-[72px_minmax(0,1fr)]" >
      <dt className="text-[10.5px] font-semibold uppercase tracking-[0.16em]" style={{ color: DIM }}>{k || <span className="sr-only">Also</span>}</dt>
      <dd className="text-[14px] leading-snug max-[640px]:text-[12.5px]" style={{ fontWeight: strong ? 650 : 420, color: warn ? "#ffbfa6" : BONE }}>{children}</dd>
    </motion.div>
  );
}

function Receipt({ p, at, code, name, label, children, reduce }: { p: MotionValue<number>; at: number; code: string; name: string; label: string; children: ReactNode; reduce: boolean }) {
  const head = useTransform(p, [at, at + 0.012], [0, 1], { clamp: true });
  const { rx, ry, glare, handlers } = useTilt(reduce);
  return (
    <motion.figure aria-label={label} {...handlers} className="relative w-full max-w-[480px] rounded-[16px] border px-5 pb-3 pt-4 max-[640px]:px-4" style={{ rotateX: rx, rotateY: ry, transformPerspective: 900, color: BONE, background: "rgb(20 10 5 / .74)", borderColor: "rgb(246 234 210 / .24)", fontVariantNumeric: "tabular-nums" }}>
      <motion.div style={{ opacity: head, borderColor: "rgb(246 234 210 / .3)" }} className="flex items-baseline gap-3 border-b pb-3">
        <span className="text-[44px] font-light leading-none tracking-[-0.03em] max-[640px]:text-[34px]">{code}</span>
        <span className="text-[13px] font-bold uppercase tracking-[0.14em]">{name}</span>
      </motion.div>
      <dl className="mt-2" style={{ borderColor: "rgb(246 234 210 / .14)" }}>{children}</dl>
      <figcaption className="mt-1 pb-0.5 text-[10px] uppercase tracking-[0.16em]" style={{ color: "rgb(246 234 210 / .5)" }}>Example response</figcaption>
      <motion.span aria-hidden className="pointer-events-none absolute inset-0 rounded-[16px]" style={{ background: glare }} />
    </motion.figure>
  );
}

export function ResolvePanel({ p, s, reduce }: { p: MotionValue<number>; s: number; reduce: boolean }) {
  const t = s + 0.04;
  return (
    <Receipt reduce={reduce} p={p} at={t} code="409" name="Ambiguous target" label="An example response: a replace whose target text matches three places is refused with 409 AMBIGUOUS_TARGET and the three candidates">
      <Row p={p} at={t + 0.012} k="Request">PATCH /documents/doc_8f2a1c</Row>
      <Row p={p} at={t + 0.024} k="Target">“shall not disclose”</Row>
      <Row p={p} at={t + 0.04} k="Found at" strong>412–430</Row>
      <Row p={p} at={t + 0.052} k="">988–1006</Row>
      <Row p={p} at={t + 0.064} k="">1534–1552</Row>
      <Row p={p} at={t + 0.082} k="Choose by">occurrence, prefix or an offset range</Row>
    </Receipt>
  );
}

export function VersionPanel({ p, s, reduce }: { p: MotionValue<number>; s: number; reduce: boolean }) {
  const t = s + 0.04;
  return (
    <Receipt reduce={reduce} p={p} at={t} code="409" name="Version conflict" label="An example response: an edit made against version 2 of a document that is now at version 3 is refused with 409 VERSION_CONFLICT">
      <Row p={p} at={t + 0.012} k="Request">PATCH /documents/doc_8f2a1c</Row>
      <Row p={p} at={t + 0.026} k="You edited">version 2</Row>
      <Row p={p} at={t + 0.04} k="Current" strong warn>version 3</Row>
      <Row p={p} at={t + 0.058} k="Result">Nothing written. No merge. Reload and retry.</Row>
    </Receipt>
  );
}

export function CheckPanel({ p, s, reduce }: { p: MotionValue<number>; s: number; reduce: boolean }) {
  const t = s + 0.04;
  return (
    <Receipt reduce={reduce} p={p} at={t} code="200" name="3 rules checked" label="An example response: Clause CI checks an edit against three rules; one holds, one fails, one needs review">
      <Row p={p} at={t + 0.012} k="Request">POST /documents/doc_8f2a1c/changes/check</Row>
      <Row p={p} at={t + 0.03} k="Holds">Mutual confidentiality</Row>
      <Row p={p} at={t + 0.046} k="Fails" strong warn>No perpetual term</Row>
      <Row p={p} at={t + 0.062} k="Review">Survival period stated</Row>
      <Row p={p} at={t + 0.08} k="Saved">Nothing, until you apply.</Row>
    </Receipt>
  );
}
