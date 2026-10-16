import { motion, useMotionValue, useMotionValueEvent, useReducedMotion, useScroll, useSpring, useTransform, type MotionValue } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowRight } from "../ui/icons.tsx";
import { CheckCard, ResolveCard, VersionCard } from "./intro/Cards.tsx";
import { Scene } from "./intro/Scene.tsx";
import { BEATS, beatStart, BONE, INK } from "./intro/scene.ts";

/**
 * The first thing a new visitor sees. It opens on a timed sequence (dawn, the sun climbing, ridges rising into place,
 * the headline unmasking word by word), then scrolling moves the day on and walks through three things CLAUSE
 * refuses to do, each with a small true picture, ending on one button. Plain SVG, one canvas and `motion`, which the
 * app already ships; it is its own chunk, so the app's first load does not grow.
 */

const EASE = [0.23, 1, 0.32, 1] as const;
const HEADLINE = "Edits that land exactly where you point.".split(" ");

/** Fades a block in and out over a window of scroll progress; out of the window it is neither announced nor clickable. */
function Beat({ p, at, children, className = "", hold = false }: { p: MotionValue<number>; at: [number, number, number, number]; children: ReactNode; className?: string; hold?: boolean }) {
  const opacity = useTransform(p, at, [0, 1, 1, hold ? 1 : 0]);
  const y = useTransform(p, at, [34, 0, 0, hold ? 0 : -34]);
  const [live, setLive] = useState(false);
  useMotionValueEvent(opacity, "change", (v) => setLive(v > 0.4));
  return (
    <motion.div style={{ opacity, y, pointerEvents: live ? "auto" : "none" }} aria-hidden={!live} className={`absolute inset-x-0 ${className}`}>
      {children}
    </motion.div>
  );
}

/** A short rule that draws itself in as its beat arrives. */
function Rule({ p, from }: { p: MotionValue<number>; from: number }) {
  const scaleX = useTransform(p, [from, from + 0.05], [0, 1]);
  return <motion.span aria-hidden className="block h-px w-12" style={{ background: INK, transformOrigin: "left", scaleX }} />;
}

function Tick({ p, at }: { p: MotionValue<number>; at: [number, number, number, number] }) {
  const on = useTransform(p, at, [0, 1, 1, at[3] >= 1 ? 1 : 0]);
  const height = useTransform(on, [0, 1], [8, 26]);
  const opacity = useTransform(on, [0, 1], [0.35, 1]);
  return <motion.span style={{ height, opacity, background: BONE, boxShadow: "0 0 0 1px rgb(42 24 13 / .45)" }} className="block w-[3px] rounded-full" />;
}

/** Five marks down the right edge: the opening, the three beats, the way in. */
function Progress({ p }: { p: MotionValue<number> }) {
  const windows: [number, number, number, number][] = [
    [0, 0.001, 0.14, 0.2],
    [0.2, 0.24, 0.38, 0.4],
    [0.4, 0.44, 0.58, 0.6],
    [0.6, 0.64, 0.78, 0.8],
    [0.8, 0.88, 0.999, 1],
  ];
  return (
    <div aria-hidden className="pointer-events-none absolute right-5 top-1/2 z-10 flex -translate-y-1/2 flex-col gap-3 max-[640px]:right-3">
      {windows.map((w) => <Tick key={w[0]} p={p} at={w} />)}
    </div>
  );
}

export function Intro({ onEnter }: { onEnter: () => void }) {
  const reduce = useReducedMotion() ?? false;
  const scroller = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ container: scroller, target: track, offset: ["start start", "end end"] });
  // Smoothing the raw scroll makes the whole scene glide instead of tracking the wheel in steps.
  const p = useSpring(scrollYProgress, { stiffness: 120, damping: 26, mass: 0.7 });
  const px = useSpring(useMotionValue(0), { stiffness: 60, damping: 18 });
  const py = useSpring(useMotionValue(0), { stiffness: 60, damping: 18 });
  const skip = useRef<HTMLButtonElement>(null);
  const [atEnd, setAtEnd] = useState(false);
  useMotionValueEvent(scrollYProgress, "change", (v) => setAtEnd(v > 0.82));

  useEffect(() => {
    skip.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || (e.key === "Enter" && !(e.target instanceof HTMLButtonElement))) onEnter();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onEnter]);

  const dawn = useTransform(p, [0, 0.2], [1, 0]);
  const heroOpacity = useTransform(p, [0, 0.1, 0.19], [1, 1, 0]);
  const heroY = useTransform(p, [0, 0.19], [0, reduce ? 0 : -90]);
  const cueOpacity = useTransform(p, [0, 0.05], [1, 0]);

  const bx = useMotionValue(0);
  const by = useMotionValue(0);
  const sbx = useSpring(bx, { stiffness: 200, damping: 16 });
  const sby = useSpring(by, { stiffness: 200, damping: 16 });

  const cards = [ResolveCard, VersionCard, CheckCard] as const;

  return (
    <div
      ref={scroller}
      role="dialog"
      aria-modal="true"
      aria-label="Welcome to CLAUSE"
      onPointerMove={(e) => {
        px.set(e.clientX / window.innerWidth - 0.5);
        py.set(e.clientY / window.innerHeight - 0.5);
      }}
      className="fixed inset-0 z-[60] overflow-y-auto overscroll-contain"
      style={{ background: INK }}
    >
      <div ref={track} className="relative h-[560vh]">
        <div className="sticky top-0 h-screen overflow-hidden" style={{ background: "linear-gradient(#f4e8cf 0%, #efd6a6 32%, #e3ac72 62%, #cf8450 100%)" }}>
          {/* Dawn sits over the day sky and clears as you scroll, so the day comes up with the page. */}
          <motion.div aria-hidden className="absolute inset-0" style={{ opacity: dawn, background: "linear-gradient(#271a30 0%, #6d3345 30%, #b9573d 56%, #ee9d58 80%, #ffd596 100%)" }} />
          <Scene p={p} px={px} py={py} reduce={reduce} />

          <div className="relative mx-auto h-full max-w-[1180px] px-6 max-[640px]:px-5">
            <div className="absolute right-6 top-5 z-20 max-[640px]:right-4">
              <button ref={skip} type="button" onClick={onEnter} className="h-10 rounded-full px-4 text-sm font-medium backdrop-blur-sm transition-colors hover:bg-[rgb(42_24_13/.7)]" style={{ background: "rgb(42 24 13 / .55)", color: BONE }}>
                Skip intro
              </button>
            </div>

            <motion.div style={{ opacity: heroOpacity, y: heroY }} className="absolute inset-x-6 top-[11vh] max-[640px]:inset-x-5">
              <motion.p initial={reduce ? false : { opacity: 0, letterSpacing: "0.6em" }} animate={{ opacity: 1, letterSpacing: "0.28em" }} transition={{ duration: 1.4, delay: 0.5, ease: EASE }} className="text-sm font-semibold" style={{ color: BONE }}>
                CLAUSE
              </motion.p>
              <h1 className="mt-5 max-w-[15ch] text-[clamp(2.5rem,7.6vw,6.3rem)] font-semibold leading-[0.98] tracking-[-0.025em]" style={{ color: BONE, textShadow: "0 2px 30px rgb(40 12 20 / .35)" }}>
                {HEADLINE.map((w, i) => (
                  <span key={`${w}-${i}`} className="mr-[0.22em] inline-block overflow-hidden align-bottom pb-[0.08em]">
                    <motion.span className="inline-block" initial={reduce ? false : { y: "112%", rotate: 4 }} animate={{ y: 0, rotate: 0 }} transition={{ duration: 1.1, delay: 0.7 + i * 0.09, ease: EASE }}>
                      {w}
                    </motion.span>
                  </span>
                ))}
              </h1>
              <motion.p initial={reduce ? false : { opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 1, delay: 1.7, ease: EASE }} className="mt-6 max-w-[34ch] text-[clamp(1rem,1.6vw,1.3rem)] leading-snug" style={{ color: "#fbeedc" }}>
                A contract redlining and search service that refuses to guess.
              </motion.p>
              <motion.div style={{ opacity: cueOpacity }} className="mt-10 flex items-center gap-3">
                <motion.span
                  aria-hidden
                  className="block h-10 w-px"
                  style={{ background: BONE, transformOrigin: "top" }}
                  initial={reduce ? false : { scaleY: 0 }}
                  animate={reduce ? { scaleY: 1 } : { scaleY: [0, 1, 1], opacity: [1, 1, 0] }}
                  transition={{ duration: reduce ? 0 : 1.8, delay: 2.1, repeat: reduce ? 0 : Infinity, ease: "easeInOut" }}
                />
                <span className="text-xs font-medium uppercase tracking-[0.22em]" style={{ color: "#fbeedc" }}>Scroll</span>
              </motion.div>
            </motion.div>

            {BEATS.map((b, i) => {
              const s = beatStart(i);
              const Card = cards[i]!;
              return (
                <Beat key={b.n} p={p} at={[s, s + 0.04, s + 0.18, s + 0.2]} className="top-[11vh] px-6 max-[640px]:px-5">
                  <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,440px)] items-start gap-10 max-[900px]:grid-cols-1 max-[900px]:gap-5">
                    <div>
                      <p className="flex items-center gap-3 text-sm font-semibold tracking-[0.2em]" style={{ color: "#5b3a24" }}>
                        <Rule p={p} from={s} />
                        {b.n} · {b.title.toUpperCase()}
                      </p>
                      <p className="mt-4 max-w-[22ch] text-[clamp(1.55rem,3.8vw,3.2rem)] font-semibold leading-[1.06] tracking-[-0.015em]" style={{ color: INK }}>{b.text}</p>
                    </div>
                    <Card p={p} s={s} />
                  </div>
                </Beat>
              );
            })}

            <Beat p={p} at={[0.8, 0.88, 0.999, 1]} hold className="top-[14vh] px-6 max-[640px]:px-5">
              <h2 className="max-w-[14ch] text-[clamp(2.1rem,5.8vw,4.8rem)] font-semibold leading-[1] tracking-[-0.02em]" style={{ color: INK }}>See it on a real contract.</h2>
              <motion.div
                className="mt-8 inline-block"
                style={{ x: sbx, y: sby }}
                onPointerMove={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  bx.set((e.clientX - (r.left + r.width / 2)) * 0.25);
                  by.set((e.clientY - (r.top + r.height / 2)) * 0.25);
                }}
                onPointerLeave={() => { bx.set(0); by.set(0); }}
              >
                <button
                  type="button"
                  onClick={onEnter}
                  tabIndex={atEnd ? 0 : -1}
                  className="group inline-flex h-14 items-center gap-3 rounded-full px-7 text-base font-semibold transition-transform duration-150 active:scale-[0.97]"
                  style={{ background: INK, color: BONE, pointerEvents: atEnd ? "auto" : "none", boxShadow: "0 18px 40px -16px rgb(40 12 5 / .6)" }}
                >
                  Open the workspace <ArrowRight size={18} aria-hidden className="transition-transform duration-200 group-hover:translate-x-1" />
                </button>
              </motion.div>
              <p className="mt-4 text-sm" style={{ color: "#4a2d1a" }}>Sample contracts, no sign-in.</p>
            </Beat>
          </div>
          <Progress p={p} />
          {/* The opening curtain: the scene starts in the dark and the light comes up. */}
          <motion.div aria-hidden className="pointer-events-none absolute inset-0" style={{ background: INK }} initial={{ opacity: reduce ? 0 : 1 }} animate={{ opacity: 0 }} transition={{ duration: 1.3, ease: "easeOut" }} />
        </div>
      </div>
    </div>
  );
}
