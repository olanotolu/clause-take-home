import { motion, useMotionValue, useMotionValueEvent, useReducedMotion, useScroll, useSpring, useTransform, type MotionValue } from "motion/react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowRight } from "../ui/icons.tsx";
import { BEATS, beatStart, BONE, INK } from "./intro/content.ts";
import { CheckPanel, ResolvePanel, VersionPanel } from "./intro/Panels.tsx";
import { Terrain } from "./intro/Terrain.tsx";

/**
 * The first thing a new visitor sees: a real-time render of a dune field (see intro/shader.ts) with a low sun and long
 * shadows, which the page moves you through as you scroll while the day comes up. The type is set in the lower third, the
 * way a title card is; each beat is one claim and one example of the service saying it. Reduced motion freezes the
 * camera and the light; without WebGL2 the same text sits on a still gradient.
 */

const EASE = [0.23, 1, 0.32, 1] as const;
const HEADLINE = "Edits that land exactly where you point.".split(" ");
const STILL = "linear-gradient(#1b1226 0%, #6d3345 38%, #d98b4f 68%, #4a2a1a 100%)";

/** Fades a block in and out over a window of scroll progress; out of the window it is neither announced nor clickable. */
function Beat({ p, at, children, className = "", hold = false }: { p: MotionValue<number>; at: [number, number, number, number]; children: ReactNode; className?: string; hold?: boolean }) {
  const opacity = useTransform(p, at, [0, 1, 1, hold ? 1 : 0]);
  const y = useTransform(p, at, [26, 0, 0, hold ? 0 : -26]);
  const [live, setLive] = useState(false);
  useMotionValueEvent(opacity, "change", (v) => setLive(v > 0.4));
  return (
    <motion.div style={{ opacity, y, pointerEvents: live ? "auto" : "none" }} aria-hidden={!live} className={`absolute inset-x-0 ${className}`}>
      {children}
    </motion.div>
  );
}

export function Intro({ onEnter }: { onEnter: () => void }) {
  const reduce = useReducedMotion() ?? false;
  const scroller = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ container: scroller, target: track, offset: ["start start", "end end"] });
  // Smoothing the raw scroll lets the camera glide instead of stepping with the wheel.
  const p = useSpring(scrollYProgress, { stiffness: 90, damping: 24, mass: 0.8 });
  const px = useSpring(useMotionValue(0), { stiffness: 40, damping: 16 });
  const py = useSpring(useMotionValue(0), { stiffness: 40, damping: 16 });
  const skip = useRef<HTMLButtonElement>(null);
  const [atEnd, setAtEnd] = useState(false);
  const [still, setStill] = useState(false);
  const failed = useCallback(() => setStill(true), []);
  useMotionValueEvent(scrollYProgress, "change", (v) => setAtEnd(v > 0.82));

  useEffect(() => {
    skip.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || (e.key === "Enter" && !(e.target instanceof HTMLButtonElement))) onEnter();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onEnter]);

  const heroOpacity = useTransform(p, [0, 0.1, 0.19], [1, 1, 0]);
  const heroY = useTransform(p, [0, 0.19], [0, reduce ? 0 : -60]);
  const cueOpacity = useTransform(p, [0, 0.05], [1, 0]);
  const fill = useTransform(p, [0, 1], ["0%", "100%"]);

  const cards = [ResolvePanel, VersionPanel, CheckPanel] as const;

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
        <div className="sticky top-0 h-screen overflow-hidden" style={{ background: STILL }}>
          {!still && <Terrain p={p} px={px} py={py} reduce={reduce} onFail={failed} />}
          {/* Keeps the type readable whatever the light is doing behind it. */}
          <div aria-hidden className="pointer-events-none absolute inset-0" style={{ background: "linear-gradient(to top, rgb(14 7 3 / .8) 0%, rgb(14 7 3 / .5) 34%, rgb(14 7 3 / 0) 70%), linear-gradient(to bottom, rgb(14 7 3 / .4), rgb(14 7 3 / 0) 20%)" }} />

          <div className="relative mx-auto h-full max-w-[1240px] px-7 max-[640px]:px-5">
            <div className="absolute inset-x-7 top-6 z-20 flex items-center justify-between max-[640px]:inset-x-5">
              <motion.span initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 1.2, delay: 0.8 }} className="text-[13px] font-semibold tracking-[0.3em]" style={{ color: BONE }}>
                CLAUSE
              </motion.span>
              <button ref={skip} type="button" onClick={onEnter} className="h-9 rounded-full border px-4 text-[13px] font-medium transition-colors hover:bg-[rgb(246_234_210/.14)]" style={{ borderColor: "rgb(246 234 210 / .5)", color: BONE }}>
                Skip intro
              </button>
            </div>

            <motion.div style={{ opacity: heroOpacity, y: heroY }} className="absolute inset-x-7 bottom-[11vh] max-[640px]:inset-x-5 max-[640px]:bottom-[9vh]">
              <h1 className="max-w-[14ch] text-[clamp(2.5rem,6.8vw,6rem)] font-medium leading-[0.98] tracking-[-0.035em]" style={{ color: BONE, textShadow: "0 2px 40px rgb(10 4 2 / .5)" }}>
                {HEADLINE.map((w, i) => (
                  <span key={`${w}-${i}`} className="mr-[0.2em] inline-block overflow-hidden align-bottom pb-[0.1em]">
                    <motion.span className="inline-block" initial={reduce ? false : { y: "115%" }} animate={{ y: 0 }} transition={{ duration: 1.3, delay: 1.0 + i * 0.1, ease: EASE }}>
                      {w}
                    </motion.span>
                  </span>
                ))}
              </h1>
              <motion.div initial={reduce ? false : { opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 1.1, delay: 2.1, ease: EASE }} className="mt-6 flex flex-wrap items-center gap-x-8 gap-y-4">
                <p className="max-w-[36ch] text-[clamp(0.95rem,1.4vw,1.15rem)] leading-snug" style={{ color: "rgb(246 234 210 / .86)" }}>
                  A contract redlining and search service that refuses to guess.
                </p>
                <motion.span style={{ opacity: cueOpacity, color: "rgb(246 234 210 / .72)" }} className="flex items-center gap-3 text-[11px] font-medium uppercase tracking-[0.24em]">
                  <span aria-hidden className="block h-px w-10" style={{ background: "currentColor" }} /> Scroll
                </motion.span>
              </motion.div>
            </motion.div>

            {BEATS.map((b, i) => {
              const s = beatStart(i);
              const Panel = cards[i]!;
              return (
                <Beat key={b.n} p={p} at={[s, s + 0.04, s + 0.18, s + 0.2]} className="bottom-[10vh] px-7 max-[640px]:bottom-[7vh] max-[640px]:px-5">
                  <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,470px)] items-end gap-12 max-[900px]:grid-cols-1 max-[900px]:gap-4">
                    <div>
                      <p className="text-[12px] font-semibold uppercase tracking-[0.26em]" style={{ color: "rgb(246 234 210 / .72)" }}>{b.n} — {b.title}</p>
                      <p className="mt-3 max-w-[24ch] text-[clamp(1.5rem,3.3vw,2.9rem)] font-medium leading-[1.08] tracking-[-0.02em]" style={{ color: BONE, textShadow: "0 2px 30px rgb(10 4 2 / .5)" }}>{b.text}</p>
                    </div>
                    <Panel p={p} s={s} />
                  </div>
                </Beat>
              );
            })}

            <Beat p={p} at={[0.8, 0.88, 0.999, 1]} hold className="bottom-[11vh] px-7 max-[640px]:bottom-[9vh] max-[640px]:px-5">
              <h2 className="max-w-[13ch] text-[clamp(2.2rem,5.6vw,4.8rem)] font-medium leading-[1] tracking-[-0.03em]" style={{ color: BONE, textShadow: "0 2px 40px rgb(10 4 2 / .5)" }}>See it on a real contract.</h2>
              <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
                <button
                  type="button"
                  onClick={onEnter}
                  tabIndex={atEnd ? 0 : -1}
                  className="group inline-flex h-14 items-center gap-3 rounded-full px-7 text-base font-semibold transition-transform duration-150 active:scale-[0.97]"
                  style={{ background: BONE, color: INK, pointerEvents: atEnd ? "auto" : "none" }}
                >
                  Open the workspace <ArrowRight size={18} aria-hidden className="transition-transform duration-200 group-hover:translate-x-1" />
                </button>
                <p className="text-sm" style={{ color: "rgb(246 234 210 / .8)" }}>Sample contracts, no sign-in.</p>
              </div>
            </Beat>
          </div>

          <div aria-hidden className="pointer-events-none absolute bottom-0 right-7 top-0 z-10 flex items-center max-[640px]:right-3">
            <div className="relative h-[28vh] w-px" style={{ background: "rgb(246 234 210 / .28)" }}>
              <motion.div className="absolute left-0 top-0 w-px" style={{ height: fill, background: BONE }} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
