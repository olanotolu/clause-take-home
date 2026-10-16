import { motion, useMotionValueEvent, useReducedMotion, useScroll, useTransform, type MotionValue } from "motion/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowRight } from "../ui/icons.tsx";

/**
 * The first thing a new visitor sees: a low sun over layered sandstone dunes, scrolled through in four beats (what it
 * is, three things it refuses to do) and ending on one button. The scene is plain SVG moved by scroll position, so
 * it costs no dependency beyond `motion`, which the app already ships.
 */

const W = 1600;
const H = 900;
const INK = "#2a180d";
const BONE = "#f6ead2";

/** A smooth, deterministic ridge line: a few summed sines, so every load draws the same dunes. */
function ridge(base: number, amp: number, phase: number, close = true) {
  const pts: string[] = [];
  for (let x = 0; x <= W; x += 20) {
    const y = base + amp * Math.sin(x / 210 + phase) + amp * 0.45 * Math.sin(x / 83 + phase * 2.1) + amp * 0.2 * Math.sin(x / 31 + phase * 3.7);
    pts.push(`${x === 0 ? "M" : "L"}${x} ${y.toFixed(1)}`);
  }
  return close ? `${pts.join(" ")} L${W} ${H + 200} L0 ${H + 200} Z` : pts.join(" ");
}

/** Far to near: how fast each layer moves, how dark it is, and where its crest sits. */
const DUNES = [
  { fill: "#dba86e", base: 520, amp: 26, phase: 0.4, speed: 0.04 },
  { fill: "#c68a52", base: 575, amp: 34, phase: 1.9, speed: 0.09 },
  { fill: "#a96a3b", base: 640, amp: 40, phase: 3.1, speed: 0.16 },
  { fill: "#7e4a2b", base: 720, amp: 46, phase: 4.6, speed: 0.26 },
  { fill: "#4d2c1b", base: 810, amp: 38, phase: 5.8, speed: 0.4 },
] as const;

const BEATS = [
  { n: "01", title: "Resolve", text: "A target that matches three places is refused, with every candidate listed. Never the first match." },
  { n: "02", title: "Version", text: "Every save is a new version. A stale edit is a conflict, never a silent merge." },
  { n: "03", title: "Check", text: "Clause CI shows which of your rules an edit would break, before anything is saved." },
] as const;

function Dunes({ p, still }: { p: MotionValue<number>; still: boolean }) {
  const paths = useMemo(() => DUNES.map((d) => ridge(d.base, d.amp, d.phase)), []);
  const strata = useMemo(() => Array.from({ length: 7 }, (_, k) => ridge(838 + k * 26, 30 - k * 2, 5.8 + k * 0.05, false)), []);
  return (
    <>
      {DUNES.map((d, i) => (
        <Layer key={d.fill} p={p} still={still} rise={d.speed * 240}>
          <path d={paths[i]} fill={d.fill} />
          {i === DUNES.length - 1 && strata.map((s, k) => <path key={s} d={s} fill="none" stroke={BONE} strokeOpacity={0.1 - k * 0.008} strokeWidth="1.2" />)}
        </Layer>
      ))}
    </>
  );
}

function Layer({ p, still, rise, children }: { p: MotionValue<number>; still: boolean; rise: number; children: ReactNode }) {
  const y = useTransform(p, [0, 1], [0, still ? 0 : -rise]);
  return <motion.g style={{ y }}>{children}</motion.g>;
}

/** Fades a block in and out over a window of scroll progress. Out of window it is not announced and not clickable. */
function Beat({ p, at, children, className = "", hold = false }: { p: MotionValue<number>; at: [number, number, number, number]; children: ReactNode; className?: string; hold?: boolean }) {
  // `hold` keeps the last beat on screen at the end of the scroll instead of fading it back out.
  const opacity = useTransform(p, at, [0, 1, 1, hold ? 1 : 0]);
  const y = useTransform(p, at, [28, 0, 0, hold ? 0 : -28]);
  const [live, setLive] = useState(false);
  useMotionValueEvent(opacity, "change", (v) => setLive(v > 0.4));
  return (
    <motion.div style={{ opacity, y }} aria-hidden={!live} className={`absolute inset-x-0 ${className}`}>
      {children}
    </motion.div>
  );
}

export function Intro({ onEnter }: { onEnter: () => void }) {
  const reduce = useReducedMotion() ?? false;
  const scroller = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const { scrollYProgress: p } = useScroll({ container: scroller, target: track, offset: ["start start", "end end"] });
  const skip = useRef<HTMLButtonElement>(null);
  const [atEnd, setAtEnd] = useState(false);
  useMotionValueEvent(p, "change", (v) => setAtEnd(v > 0.82));

  useEffect(() => {
    skip.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || (e.key === "Enter" && !(e.target instanceof HTMLButtonElement))) onEnter();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onEnter]);

  const sunY = useTransform(p, [0, 0.7], [0, reduce ? 0 : -300]);
  const sunScale = useTransform(p, [0, 1], [1, reduce ? 1 : 1.5]);
  const glow = useTransform(p, [0, 1], [0.55, 0.9]);
  const heroOpacity = useTransform(p, [0, 0.14, 0.22], [1, 1, 0]);
  const heroY = useTransform(p, [0, 0.22], [0, reduce ? 0 : -80]);

  return (
    <div ref={scroller} role="dialog" aria-modal="true" aria-label="Welcome to CLAUSE" className="fixed inset-0 z-[60] overflow-y-auto overscroll-contain" style={{ background: INK }}>
      <div ref={track} className="relative h-[460vh]">
        <div className="sticky top-0 h-screen overflow-hidden" style={{ background: "linear-gradient(#f2e5cb 0%, #ecd2a0 34%, #e1a86f 62%, #cc7f4a 100%)" }}>
          <motion.div aria-hidden className="pointer-events-none absolute left-1/2 top-[44%] size-[min(60vw,520px)] -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ opacity: glow, y: sunY, scale: sunScale, background: "radial-gradient(circle, #fff3d6 0%, rgb(255 226 168 / .75) 28%, rgb(255 200 130 / 0) 70%)" }} />
          <svg aria-hidden viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMax slice" className="absolute inset-0 size-full">
            <defs>
              <filter id="intro-grain" x="0" y="0" width="100%" height="100%">
                <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" stitchTiles="stitch" />
                <feColorMatrix type="saturate" values="0" />
              </filter>
            </defs>
            <motion.circle cx={W / 2} cy="470" r="64" fill="#fff4da" style={{ y: sunY, scale: sunScale, transformOrigin: `${W / 2}px 470px` }} />
            <Dunes p={p} still={reduce} />
            <rect width={W} height={H} filter="url(#intro-grain)" opacity="0.2" style={{ mixBlendMode: "multiply" }} />
          </svg>

          <div className="relative mx-auto h-full max-w-[1100px] px-6 max-[640px]:px-5">
            <div className="absolute right-6 top-5 z-10 max-[640px]:right-4">
              <button ref={skip} type="button" onClick={onEnter} className="h-10 rounded-full border px-4 text-sm font-medium transition-colors hover:bg-[rgb(42_24_13/.08)]" style={{ borderColor: "rgb(42 24 13 / .35)", color: INK }}>
                Skip intro
              </button>
            </div>

            <motion.div style={{ opacity: heroOpacity, y: heroY }} className="absolute inset-x-6 top-[11vh] max-[640px]:inset-x-5">
              <p className="text-sm font-semibold tracking-[0.28em]" style={{ color: INK }}>CLAUSE</p>
              <h1 className="mt-5 max-w-[16ch] text-[clamp(2.4rem,7.4vw,6rem)] font-semibold leading-[0.98] tracking-[-0.02em]" style={{ color: INK }}>
                Edits that land exactly where you point.
              </h1>
              <p className="mt-6 max-w-[34ch] text-[clamp(1rem,1.6vw,1.25rem)] leading-snug" style={{ color: "#4a2d1a" }}>
                A contract redlining and search service that refuses to guess.
              </p>
              <p className="mt-10 text-xs font-medium uppercase tracking-[0.22em]" style={{ color: "#5b3a24" }}>Scroll</p>
            </motion.div>

            {BEATS.map((b, i) => {
              const s = 0.2 + i * 0.2;
              return (
                <Beat key={b.n} p={p} at={[s, s + 0.05, s + 0.16, s + 0.2]} className="top-[12vh] px-6 max-[640px]:px-5">
                  <p className="text-sm font-semibold tracking-[0.2em]" style={{ color: "#5b3a24" }}>{b.n} · {b.title.toUpperCase()}</p>
                  <p className="mt-4 max-w-[22ch] text-[clamp(1.7rem,4.6vw,3.6rem)] font-semibold leading-[1.05] tracking-[-0.015em]" style={{ color: INK }}>{b.text}</p>
                </Beat>
              );
            })}

            <Beat p={p} at={[0.8, 0.88, 0.999, 1]} hold className="top-[14vh] px-6 max-[640px]:px-5">
              <h2 className="max-w-[14ch] text-[clamp(2rem,5.6vw,4.6rem)] font-semibold leading-[1] tracking-[-0.02em]" style={{ color: INK }}>See it on a real contract.</h2>
              <button
                type="button"
                onClick={onEnter}
                tabIndex={atEnd ? 0 : -1}
                className="mt-8 inline-flex h-14 items-center gap-3 rounded-full px-7 text-base font-semibold transition-transform duration-150 hover:scale-[1.02] active:scale-[0.98]"
                style={{ background: INK, color: BONE, pointerEvents: atEnd ? "auto" : "none" }}
              >
                Open the workspace <ArrowRight size={18} aria-hidden />
              </button>
              <p className="mt-4 text-sm" style={{ color: "#4a2d1a" }}>Sample contracts, no sign-in.</p>
            </Beat>
          </div>
        </div>
      </div>
    </div>
  );
}
