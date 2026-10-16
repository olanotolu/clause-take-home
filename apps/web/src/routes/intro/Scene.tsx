import { motion, useTransform, type MotionValue } from "motion/react";
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { DUNES, H, MESAS, ridge, SUN, W } from "./scene.ts";

interface SceneProps {
  /** Smoothed scroll progress, 0 to 1. */
  p: MotionValue<number>;
  /** Pointer position, -0.5 to 0.5 on each axis (springs). */
  px: MotionValue<number>;
  py: MotionValue<number>;
  reduce: boolean;
}

const EASE = [0.23, 1, 0.32, 1] as const;

/** One depth layer: rises into place on load (outer), then follows scroll and pointer by its depth (inner). */
function Layer({ p, px, py, reduce, depth, index, children }: SceneProps & { depth: number; index: number; children: ReactNode }) {
  const y = useTransform(p, [0, 1], [0, reduce ? 0 : -depth * 260]);
  const x = useTransform(px, (v) => (reduce ? 0 : v * depth * -70));
  const yp = useTransform(py, (v) => (reduce ? 0 : v * depth * -26));
  return (
    <motion.g initial={reduce ? false : { y: 190, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ duration: 1.7, delay: 0.25 + index * 0.13, ease: EASE }}>
      <motion.g style={{ x, y: useTransform([y, yp], ([a, b]: number[]) => (a ?? 0) + (b ?? 0)) }}>{children}</motion.g>
    </motion.g>
  );
}

export function Scene(props: SceneProps) {
  const { p, px, reduce } = props;
  const paths = useMemo(() => DUNES.map((d) => ({ fill: ridge(d.base, d.amp, d.phase), crest: ridge(d.base, d.amp, d.phase, false) })), []);
  const strata = useMemo(() => Array.from({ length: 8 }, (_, k) => ridge(836 + k * 24, 30 - k * 2, 5.8 + k * 0.05, false)), []);

  const sunY = useTransform(p, [0, 0.7], [0, reduce ? 0 : -300]);
  const sunScale = useTransform(p, [0, 1], [1, reduce ? 1 : 1.45]);
  const sunX = useTransform(px, (v) => (reduce ? 0 : v * -30));
  const glow = useTransform(p, [0, 0.25, 1], [0.95, 0.6, 0.85]);
  const raysTurn = useTransform(p, [0, 1], [0, reduce ? 0 : 50]);

  return (
    <>
      <svg aria-hidden viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMax slice" className="absolute inset-0 size-full">
        <defs>
          <radialGradient id="i-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0" stopColor="#fff3d0" stopOpacity="0.95" />
            <stop offset="0.25" stopColor="#ffd592" stopOpacity="0.6" />
            <stop offset="0.6" stopColor="#ff9e5c" stopOpacity="0.18" />
            <stop offset="1" stopColor="#ff9e5c" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="i-ray" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#fff0c8" stopOpacity="0.5" />
            <stop offset="1" stopColor="#fff0c8" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="i-fog" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#f6d9a6" stopOpacity="0" />
            <stop offset="1" stopColor="#f6d9a6" stopOpacity="1" />
          </linearGradient>
          {DUNES.map((d, i) => (
            <linearGradient key={d.lit} id={`i-dune-${i}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={d.lit} />
              <stop offset="0.55" stopColor={d.shade} />
              <stop offset="1" stopColor={d.shade} />
            </linearGradient>
          ))}
          <filter id="i-grain" x="0" y="0" width="100%" height="100%">
            <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" stitchTiles="stitch" />
            <feColorMatrix type="saturate" values="0" />
          </filter>
          {/* Heat shimmer over the far ridges: a slowly drifting displacement. */}
          <filter id="i-heat" x="-2%" y="-10%" width="104%" height="120%">
            <feTurbulence type="turbulence" baseFrequency="0.004 0.03" numOctaves="1" seed="4" result="n">
              {!reduce && <animate attributeName="baseFrequency" values="0.004 0.03;0.006 0.04;0.004 0.03" dur="11s" repeatCount="indefinite" />}
            </feTurbulence>
            <feDisplacementMap in="SourceGraphic" in2="n" scale={reduce ? 0 : 9} xChannelSelector="R" yChannelSelector="G" />
          </filter>
        </defs>

        {/* Sun: glow, slow rays, disc. */}
        <motion.g style={{ x: sunX, y: sunY, scale: sunScale, transformOrigin: `${SUN.x}px ${SUN.y}px`, opacity: glow }}>
          <circle cx={SUN.x} cy={SUN.y} r="520" fill="url(#i-glow)" />
          <motion.g style={{ rotate: raysTurn, transformOrigin: `${SUN.x}px ${SUN.y}px` }} initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 2.4, delay: 0.9 }}>
            {Array.from({ length: 16 }, (_, k) => (
              <polygon key={k} points={`${SUN.x},${SUN.y - 3} ${SUN.x + 1500},${SUN.y - 26} ${SUN.x + 1500},${SUN.y + 26} ${SUN.x},${SUN.y + 3}`} fill="url(#i-ray)" opacity={k % 2 ? 0.22 : 0.42} transform={`rotate(${k * 22.5} ${SUN.x} ${SUN.y})`} />
            ))}
          </motion.g>
        </motion.g>
        <motion.circle
          cx={SUN.x}
          cy={SUN.y}
          r="66"
          fill="#fff6dc"
          style={{ x: sunX, y: sunY, scale: sunScale, transformOrigin: `${SUN.x}px ${SUN.y}px` }}
          initial={reduce ? false : { y: 260 }}
          animate={{ y: 0 }}
          transition={{ duration: 2.6, delay: 0.2, ease: EASE }}
        />

        {/* Buttes and the first two ridges share the heat shimmer. */}
        <g filter="url(#i-heat)">
          <Layer {...props} depth={0.06} index={0}>
            {MESAS.map((m) => (
              <g key={m.x}>
                <path d={`M${m.x - 14} ${m.y + 120} L${m.x + 8} ${m.y - m.h + 6} L${m.x + 18} ${m.y - m.h} L${m.x + m.w - 18} ${m.y - m.h} L${m.x + m.w - 6} ${m.y - m.h + 8} L${m.x + m.w + 16} ${m.y + 120} Z`} fill="#c98a55" opacity="0.9" />
                {[0.3, 0.55, 0.8].map((f) => (
                  <line key={f} x1={m.x + 4} x2={m.x + m.w - 4} y1={m.y - m.h + m.h * f} y2={m.y - m.h + m.h * f} stroke="#f0c690" strokeOpacity="0.25" strokeWidth="1.4" />
                ))}
              </g>
            ))}
          </Layer>
          {DUNES.slice(0, 2).map((d, i) => (
            <Layer key={d.lit} {...props} depth={d.depth} index={i + 1}>
              <path d={paths[i]!.fill} fill={`url(#i-dune-${i})`} />
              <path d={paths[i]!.crest} fill="none" stroke="#ffe7b8" strokeOpacity={d.rim} strokeWidth="1.8" />
              <rect x="0" y={d.base - 10} width={W} height="260" fill="url(#i-fog)" opacity={d.haze} />
            </Layer>
          ))}
        </g>
        {DUNES.slice(2).map((d, k) => {
          const i = k + 2;
          return (
            <Layer key={d.lit} {...props} depth={d.depth} index={i + 1}>
              <path d={paths[i]!.fill} fill={`url(#i-dune-${i})`} />
              <path d={paths[i]!.crest} fill="none" stroke="#ffe0a8" strokeOpacity={d.rim} strokeWidth="1.8" />
              {d.haze > 0 && <rect x="0" y={d.base - 10} width={W} height="260" fill="url(#i-fog)" opacity={d.haze} />}
              {i === DUNES.length - 1 && strata.map((s, j) => <path key={s} d={s} fill="none" stroke="#f6ead2" strokeOpacity={0.11 - j * 0.01} strokeWidth="1.2" />)}
            </Layer>
          );
        })}
        <rect width={W} height={H} filter="url(#i-grain)" opacity="0.2" style={{ mixBlendMode: "multiply" }} />
      </svg>
      <Dust reduce={reduce} />
    </>
  );
}

/** Warm motes drifting up through the light. Pauses when the tab is hidden; absent under reduced motion. */
function Dust({ reduce }: { reduce: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || reduce) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let w = 0;
    let h = 0;
    const fit = () => {
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    fit();
    window.addEventListener("resize", fit);
    // A fixed seed keeps the field the same on every load.
    let seed = 7;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };
    const motes = Array.from({ length: 70 }, () => ({ x: rnd(), y: rnd(), r: 0.6 + rnd() * 1.9, v: 0.012 + rnd() * 0.03, drift: 0.004 + rnd() * 0.012, tw: rnd() * 6.28 }));
    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      const dt = Math.min(now - last, 64) / 1000;
      last = now;
      ctx.clearRect(0, 0, w, h);
      for (const m of motes) {
        m.y -= m.v * dt;
        m.x += m.drift * dt;
        if (m.y < -0.02) { m.y = 1.02; m.x = rnd(); }
        if (m.x > 1.02) m.x = -0.02;
        const a = 0.25 + 0.35 * Math.sin(now / 900 + m.tw);
        ctx.fillStyle = `rgba(255, 233, 190, ${Math.max(a, 0.05)})`;
        ctx.beginPath();
        ctx.arc(m.x * w, m.y * h, m.r, 0, 6.2832);
        ctx.fill();
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", fit);
    };
  }, [reduce]);
  return <canvas ref={ref} aria-hidden className="pointer-events-none absolute inset-0 size-full" />;
}
