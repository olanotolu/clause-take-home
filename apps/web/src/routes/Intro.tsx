import { motion, useMotionValue, useMotionValueEvent, useReducedMotion, useScroll, useSpring, useTransform, type MotionValue } from "motion/react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowRight } from "../ui/icons.tsx";
import { BEATS, beatStart, BONE, INK } from "./intro/content.ts";
import { Char, Cursor, Magnetic } from "./intro/Motion.tsx";
import { Words } from "./intro/Type.tsx";
import { CheckPanel, ResolvePanel, VersionPanel } from "./intro/Panels.tsx";
import { Terrain } from "./intro/Terrain.tsx";

/**
 * The first thing a new visitor sees: a real-time render of a dune field (see intro/shader.ts) with a low sun and long
 * shadows, which the page moves you through as you scroll while the day comes up. The type is set in the lower third, the
 * way a title card is; each beat is one claim and one example of the service saying it. Reduced motion freezes the
 * camera and the light; without WebGL2 the same text sits on a still gradient.
 */

const EASE = [0.23, 1, 0.32, 1] as const;
// Two weights on purpose: the first line is light, the claim is heavy.
const HEADLINE = [["Edits", "that", "land"], ["exactly", "where", "you", "point."]] as const;
const STILL = "linear-gradient(#18181b 0%, #52525b 38%, #a1a1aa 68%, #27272a 100%)";

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

const STOPS = [
  { at: 0, label: "Opening" },
  { at: 0.3, label: "01 Resolve" },
  { at: 0.5, label: "02 Version" },
  { at: 0.7, label: "03 Check" },
  { at: 1, label: "The way in" },
] as const;

/** Five stops down the right edge: they show where you are and jump there, smoothly. */
function Dots({ p, scroller }: { p: MotionValue<number>; scroller: React.RefObject<HTMLDivElement | null> }) {
  const [at, setAt] = useState(0);
  useMotionValueEvent(p, "change", (v) => setAt(STOPS.reduce((best, s, i) => (Math.abs(v - s.at) < Math.abs(v - STOPS[best]!.at) ? i : best), 0)));
  return (
    <nav aria-label="Intro sections" className="absolute right-4 top-1/2 z-20 flex -translate-y-1/2 flex-col items-center max-[640px]:right-1">
      {STOPS.map((s, i) => (
        <button
          key={s.label}
          type="button"
          aria-label={s.label}
          aria-current={at === i ? "step" : undefined}
          onClick={() => { const el = scroller.current; if (el) el.scrollTo({ top: s.at * (el.scrollHeight - el.clientHeight), behavior: "smooth" }); }}
          className="group grid size-7 place-items-center"
        >
          <span className="block rounded-full transition-all duration-300" style={{ width: at === i ? 8 : 5, height: at === i ? 8 : 5, background: BONE, opacity: at === i ? 1 : 0.45 }} />
          <span aria-hidden className="pointer-events-none absolute right-8 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-semibold opacity-0 transition-opacity duration-200 group-hover:opacity-100 max-[640px]:hidden" style={{ background: "rgb(18 9 4 / .7)", color: BONE }}>{s.label}</span>
        </button>
      ))}
    </nav>
  );
}

/** "01 / 03" while a beat is on screen, in tabular numerals so it does not jitter as it changes. */
function Counter({ p }: { p: MotionValue<number> }) {
  const [n, setN] = useState(0);
  useMotionValueEvent(p, "change", (v) => setN(v < 0.2 || v >= 0.8 ? 0 : Math.floor((v - 0.2) / 0.2) + 1));
  return (
    <div aria-hidden className="pointer-events-none absolute right-7 top-[4.4rem] z-10 text-[12px] font-bold tracking-[0.2em] transition-opacity duration-300 max-[640px]:right-5" style={{ color: BONE, opacity: n ? 0.85 : 0, fontVariantNumeric: "tabular-nums" }}>
      {String(n || 1).padStart(2, "0")} <span style={{ opacity: 0.5 }}>/ 03</span>
    </div>
  );
}

export function Intro({ onEnter }: { onEnter: () => void }) {
  const reduce = useReducedMotion() ?? false;
  const scroller = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ container: scroller, target: track, offset: ["start start", "end end"] });
  // Smoothing the raw scroll lets the camera glide instead of stepping with the wheel.
  const p = useSpring(scrollYProgress, { stiffness: 210, damping: 30, mass: 0.6 });
  const px = useSpring(useMotionValue(0), { stiffness: 90, damping: 20 });
  const py = useSpring(useMotionValue(0), { stiffness: 90, damping: 20 });
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
      <Cursor reduce={reduce} />
      <div ref={track} className="relative h-[440vh]">
        <div className="sticky top-0 h-screen overflow-hidden" style={{ background: STILL }}>
          {!still && <Terrain p={p} px={px} py={py} reduce={reduce} onFail={failed} />}
          {/* Keeps the type readable whatever the light is doing behind it. */}
          <div aria-hidden className="pointer-events-none absolute inset-0" style={{ background: "linear-gradient(to top, rgb(0 0 0 / .8) 0%, rgb(0 0 0 / .5) 34%, rgb(0 0 0 / 0) 70%), linear-gradient(to bottom, rgb(0 0 0 / .4), rgb(0 0 0 / 0) 20%)" }} />

          <div className="relative mx-auto h-full max-w-[1240px] px-7 max-[640px]:px-5">
            <div className="absolute inset-x-7 top-6 z-20 flex items-center justify-between max-[640px]:inset-x-5">
              <motion.span initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.8, delay: 0.3 }} className="flex items-center gap-3 text-[13px] font-extrabold tracking-[0.34em]" style={{ color: BONE }}>
                <span aria-hidden className="block size-[15px] rounded-[4px] border-2" style={{ borderColor: BONE, borderRightColor: "transparent" }} />
                CLAUSE
              </motion.span>
              <Magnetic reduce={reduce} strength={0.25}>
              <button ref={skip} type="button" data-cursor="Skip" onClick={onEnter} className="flex h-9 items-center gap-2.5 rounded-full border pl-4 pr-2 text-[13px] font-semibold transition-colors hover:bg-[rgb(245_245_245/.14)]" style={{ borderColor: "rgb(245 245 245 / .5)", color: BONE }}>
                Skip intro
                <kbd className="rounded-md border px-1.5 py-px text-[10px] font-semibold tracking-wide max-[640px]:hidden" style={{ borderColor: "rgb(245 245 245 / .4)", color: "rgb(245 245 245 / .75)" }}>Esc</kbd>
              </button>
              </Magnetic>
            </div>

            <motion.div style={{ opacity: heroOpacity, y: heroY }} className="absolute inset-x-7 bottom-[11vh] max-[640px]:inset-x-5 max-[640px]:bottom-[9vh]">
              <h1 aria-label="Edits that land exactly where you point." className="text-[clamp(2.6rem,7.2vw,6.4rem)] leading-[0.96] tracking-[-0.04em]" style={{ color: BONE, textShadow: "0 2px 40px rgb(0 0 0 / .5)", textWrap: "balance" }}>
                {HEADLINE.map((line, li) => (
                  <span key={line[0]} aria-hidden className="block" style={{ fontWeight: li === 0 ? 300 : 700 }}>
                    {line.map((w, wi) => {
                      const before = HEADLINE.slice(0, li).flat().length + wi;
                      return (
                        <span key={w} className="mr-[0.2em] inline-block overflow-hidden align-bottom pb-[0.14em] pr-[0.04em]">
                          {w.split("").map((c, ci) => <Char key={`${ci}-${c}`} reduce={reduce} delay={0.3 + before * 0.07 + ci * 0.02}>{c}</Char>)}
                        </span>
                      );
                    })}
                  </span>
                ))}
              </h1>
              <motion.div initial={reduce ? false : { opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.8, delay: 1.05, ease: EASE }} className="mt-6 flex flex-wrap items-center gap-x-8 gap-y-4">
                <p className="max-w-[36ch] text-[clamp(0.95rem,1.4vw,1.15rem)] leading-snug" style={{ color: "rgb(245 245 245 / .86)" }}>
                  A contract redlining and search service that refuses to guess.
                </p>
                <motion.span style={{ opacity: cueOpacity, color: "rgb(245 245 245 / .72)" }} className="flex items-center gap-3 text-[11px] font-medium uppercase tracking-[0.24em]">
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
                      <p className="flex items-baseline gap-4" style={{ color: BONE }}>
                        <span className="text-[clamp(3.4rem,7vw,6.2rem)] font-extralight leading-[0.8] tracking-[-0.05em]" style={{ fontVariantNumeric: "tabular-nums" }}>{b.n}</span>
                        <span className="text-[13px] font-bold uppercase tracking-[0.28em]" style={{ color: "rgb(245 245 245 / .78)" }}>{b.title}</span>
                      </p>
                      <p className="mt-5 max-w-[23ch] text-[clamp(1.55rem,3.3vw,2.9rem)] leading-[1.1] tracking-[-0.025em]" style={{ color: BONE, textShadow: "0 2px 30px rgb(0 0 0 / .5)", textWrap: "balance" }}>
                        <Words p={p} from={s + 0.012} to={s + 0.1} runs={b.runs} />
                      </p>
                    </div>
                    <Panel p={p} s={s} reduce={reduce} />
                  </div>
                </Beat>
              );
            })}

            <Beat p={p} at={[0.8, 0.88, 0.999, 1]} hold className="bottom-[11vh] px-7 max-[640px]:bottom-[9vh] max-[640px]:px-5">
              <h2 className="max-w-[13ch] text-[clamp(2.3rem,5.8vw,5rem)] leading-[0.98] tracking-[-0.04em]" style={{ color: BONE, textShadow: "0 2px 40px rgb(0 0 0 / .5)" }}><span style={{ fontWeight: 300 }}>See it on a</span> <span style={{ fontWeight: 700 }}>real contract.</span></h2>
              <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
                <Magnetic reduce={reduce} strength={0.3}>
                <button
                  type="button"
                  data-cursor="Enter"
                  onClick={onEnter}
                  tabIndex={atEnd ? 0 : -1}
                  className="group inline-flex h-[60px] items-center gap-4 rounded-full pl-8 pr-2 text-[17px] font-bold tracking-[-0.01em] transition-transform duration-150 active:scale-[0.97]"
                  style={{ background: BONE, color: INK, pointerEvents: atEnd ? "auto" : "none" }}
                >
                  Open the workspace
                  <span className="grid size-11 place-items-center rounded-full transition-transform duration-300 group-hover:translate-x-1" style={{ background: INK, color: BONE }}><ArrowRight size={18} aria-hidden /></span>
                </button>
                </Magnetic>
                <p className="text-sm" style={{ color: "rgb(245 245 245 / .8)" }}>Sample contracts, no sign-in.</p>
              </div>
            </Beat>
          </div>

          <Counter p={p} />
          <Dots p={p} scroller={scroller} />
          <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-[2px]" style={{ background: "rgb(245 245 245 / .18)" }}>
            <motion.div className="h-full" style={{ width: fill, background: BONE }} />
          </div>
        </div>
      </div>
    </div>
  );
}
