import { motion, useTransform, type MotionValue } from "motion/react";
import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, XCircle } from "../../ui/icons.tsx";
import { INK } from "./scene.ts";

/**
 * Three small, true pictures of what the product does, one per beat. Each element is driven by the scroll position
 * inside its beat, so scrubbing back and forth plays it both ways. Everything shown is real behaviour: the 409 and 412
 * answers, the version rule, and the three Clause CI verdicts.
 */
const useStep = (p: MotionValue<number>, from: number, to: number) => useTransform(p, [from, to], [0, 1], { clamp: true });

function Glass({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div
      role="img"
      aria-label={label}
      className="w-full max-w-[440px] rounded-[22px] border p-4 backdrop-blur-md max-[640px]:max-w-none max-[640px]:p-3.5"
      style={{ background: "rgb(248 238 216 / .82)", borderColor: "rgb(42 24 13 / .16)", color: INK, boxShadow: "0 30px 80px -30px rgb(60 25 5 / .55), inset 0 1px 0 rgb(255 255 255 / .55)" }}
    >
      {children}
    </div>
  );
}

function Pill({ p, at, tone, children }: { p: MotionValue<number>; at: [number, number]; tone: "fail" | "ok" | "warn"; children: ReactNode }) {
  const s = useStep(p, at[0], at[1]);
  const scale = useTransform(s, [0, 1], [0.86, 1]);
  const colors = { fail: ["#7a1d14", "rgb(179 38 30 / .14)"], ok: ["#1f5d34", "rgb(40 130 70 / .16)"], warn: ["#7a4a05", "rgb(214 140 20 / .2)"] }[tone];
  return (
    <motion.span style={{ opacity: s, scale, color: colors[0], background: colors[1] }} className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold">
      {children}
    </motion.span>
  );
}

/** The matched phrase lights up as the scroll reaches it. */
function Hit({ p, from, to, children }: { p: MotionValue<number>; from: number; to: number; children: ReactNode }) {
  const s = useStep(p, from, to);
  const backgroundColor = useTransform(s, [0, 1], ["rgba(226,150,60,0)", "rgba(226,150,60,.5)"]);
  const boxShadow = useTransform(s, [0, 1], ["inset 0 0 0 1.5px rgba(176,104,30,0)", "inset 0 0 0 1.5px rgba(176,104,30,.9)"]);
  return <motion.mark className="rounded-[4px] px-0.5" style={{ color: INK, backgroundColor, boxShadow }}>{children}</motion.mark>;
}

/** 01: the same phrase three times, each one found, then the refusal that lists them. */
export function ResolveCard({ p, s }: { p: MotionValue<number>; s: number }) {
  const lines = [
    ["The Receiving Party ", "shall not disclose", " Confidential Information."],
    ["The Disclosing Party ", "shall not disclose", " Trade Secrets."],
    ["Neither party ", "shall not disclose", " the Term."],
  ] as const;
  return (
    <Glass label="An edit whose target text matches three places is refused with a 409 that lists all three candidates">
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em]" style={{ color: "#6b4528" }}>replace “shall not disclose”</p>
      <div className="mt-3 space-y-2 font-doc text-[15px] leading-snug max-[640px]:text-[13.5px]">
        {lines.map(([a, hit, b], i) => (
          <p key={hit + a}>
            <span className="mr-2 inline-grid size-5 place-items-center rounded-full text-[11px] font-semibold" style={{ background: INK, color: "#f6ead2" }}>{i + 1}</span>
            {a}
            <Hit p={p} from={s + 0.045 + i * 0.015} to={s + 0.06 + i * 0.015}>{hit}</Hit>
            {b}
          </p>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Pill p={p} at={[s + 0.095, s + 0.108]} tone="fail"><XCircle size={14} aria-hidden /> 409 · 3 candidates</Pill>
        <Pill p={p} at={[s + 0.11, s + 0.123]} tone="ok"><CheckCircle2 size={14} aria-hidden /> pick occurrence 2</Pill>
      </div>
    </Glass>
  );
}

/** 02: you edit version 2; someone saves version 3 first; yours is refused, not merged. */
export function VersionCard({ p, s }: { p: MotionValue<number>; s: number }) {
  const rows = [
    { v: "v1", note: "Created", at: 0.04 },
    { v: "v2", note: "You open this one", at: 0.06 },
    { v: "v3", note: "Someone else saves first", at: 0.08 },
  ] as const;
  const line = useStep(p, s + 0.04, s + 0.095);
  return (
    <Glass label="You edit version 2, but someone saved version 3 first, so your edit is refused as a conflict instead of being merged">
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em]" style={{ color: "#6b4528" }}>history</p>
      <ol className="relative mt-3 space-y-3 pl-6">
        <motion.span aria-hidden className="absolute left-[7px] top-2 w-px origin-top" style={{ background: "rgb(42 24 13 / .35)", height: "calc(100% - 28px)", scaleY: line }} />
        {rows.map((r) => <VersionRow key={r.v} p={p} at={s + r.at} v={r.v} note={r.note} />)}
      </ol>
      <div className="mt-4 flex flex-wrap gap-2">
        <Pill p={p} at={[s + 0.1, s + 0.113]} tone="fail"><XCircle size={14} aria-hidden /> your edit to v2: refused</Pill>
        <Pill p={p} at={[s + 0.115, s + 0.128]} tone="warn"><AlertTriangle size={14} aria-hidden /> current is v3</Pill>
      </div>
    </Glass>
  );
}

/** 03: the three Clause CI verdicts, each with an icon and words, never colour alone. */
export function CheckCard({ p, s }: { p: MotionValue<number>; s: number }) {
  const rules = [
    { name: "Mutual confidentiality", icon: <CheckCircle2 size={18} aria-hidden style={{ color: "#1f5d34" }} />, word: "Holds", at: 0.045 },
    { name: "No perpetual term", icon: <XCircle size={18} aria-hidden style={{ color: "#b3261e" }} />, word: "Fails", at: 0.07 },
    { name: "Survival period stated", icon: <AlertTriangle size={18} aria-hidden style={{ color: "#8a5a06" }} />, word: "Needs review", at: 0.095 },
  ] as const;
  return (
    <Glass label="Clause CI checks an edit against your rules: one holds, one fails, one needs review">
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em]" style={{ color: "#6b4528" }}>rules checked against this edit</p>
      <ul className="mt-3 divide-y" style={{ borderColor: "rgb(42 24 13 / .14)" }}>
        {rules.map((r) => <RuleRow key={r.name} p={p} at={s + r.at} name={r.name} icon={r.icon} word={r.word} />)}
      </ul>
      <p className="mt-3 text-xs" style={{ color: "#5b3a24" }}>Nothing is saved until you apply.</p>
    </Glass>
  );
}

function VersionRow({ p, at, v, note }: { p: MotionValue<number>; at: number; v: string; note: string }) {
  const o = useStep(p, at, at + 0.015);
  const x = useTransform(o, [0, 1], [-10, 0]);
  return (
    <motion.li style={{ opacity: o, x }} className="relative flex items-baseline gap-3">
      <span aria-hidden className="absolute -left-6 top-1.5 size-3.5 rounded-full border-2" style={{ background: "#f6ead2", borderColor: INK }} />
      <span className="w-8 text-sm font-semibold tabular-nums">{v}</span>
      <span className="text-sm" style={{ color: "#4a2d1a" }}>{note}</span>
    </motion.li>
  );
}

function RuleRow({ p, at, name, icon, word }: { p: MotionValue<number>; at: number; name: string; icon: ReactNode; word: string }) {
  const o = useStep(p, at, at + 0.015);
  const y = useTransform(o, [0, 1], [8, 0]);
  return (
    <motion.li style={{ opacity: o, y, borderColor: "rgb(42 24 13 / .14)" }} className="flex items-center gap-3 py-2.5">
      {icon}
      <span className="flex-1 text-sm font-medium">{name}</span>
      <span className="text-xs font-semibold" style={{ color: "#4a2d1a" }}>{word}</span>
    </motion.li>
  );
}
