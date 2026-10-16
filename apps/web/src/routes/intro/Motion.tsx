import { motion, useMotionTemplate, useMotionValue, useSpring } from "motion/react";
import { useEffect, useState, type PointerEvent, type ReactNode } from "react";
import { BONE, INK } from "./content.ts";

const SPRING = { stiffness: 180, damping: 16, mass: 0.6 } as const;

/** Pulls its child toward the pointer when it is near, and lets go with a spring. Off under reduced motion. */
export function Magnetic({ children, strength = 0.35, reduce, className = "" }: { children: ReactNode; strength?: number; reduce: boolean; className?: string }) {
  const x = useSpring(useMotionValue(0), SPRING);
  const y = useSpring(useMotionValue(0), SPRING);
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (reduce) return;
    const r = e.currentTarget.getBoundingClientRect();
    x.set((e.clientX - (r.left + r.width / 2)) * strength);
    y.set((e.clientY - (r.top + r.height / 2)) * strength);
  };
  const leave = () => { x.set(0); y.set(0); };
  return (
    <motion.div style={{ x, y }} onPointerMove={move} onPointerLeave={leave} className={className}>
      {children}
    </motion.div>
  );
}

/**
 * A cursor that follows with a spring, and swells into a labelled disc over anything marked `data-cursor="Label"`.
 * Only on devices with a real pointer; absent under reduced motion; the system cursor stays visible.
 */
export function Cursor({ reduce }: { reduce: boolean }) {
  const [label, setLabel] = useState("");
  const [fine, setFine] = useState(false);
  const x = useMotionValue(-100);
  const y = useMotionValue(-100);
  const sx = useSpring(x, { stiffness: 420, damping: 34, mass: 0.4 });
  const sy = useSpring(y, { stiffness: 420, damping: 34, mass: 0.4 });
  useEffect(() => {
    const mq = window.matchMedia("(pointer: fine)");
    setFine(mq.matches);
    const move = (e: globalThis.PointerEvent) => {
      x.set(e.clientX);
      y.set(e.clientY);
      const t = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-cursor]") : null;
      setLabel(t?.dataset.cursor ?? "");
    };
    window.addEventListener("pointermove", move);
    return () => window.removeEventListener("pointermove", move);
  }, [x, y]);
  if (reduce || !fine) return null;
  const size = label ? 84 : 14;
  return (
    <motion.div aria-hidden className="pointer-events-none fixed left-0 top-0 z-[80]" style={{ x: sx, y: sy }}>
      <motion.div
        className="-translate-x-1/2 -translate-y-1/2 grid place-items-center overflow-hidden rounded-full text-[12px] font-bold tracking-[0.04em]"
        animate={{ width: size, height: size, backgroundColor: label ? BONE : "rgba(246,234,210,0.0)", borderColor: "rgba(246,234,210,0.9)" }}
        transition={{ type: "spring", stiffness: 320, damping: 26 }}
        style={{ borderWidth: label ? 0 : 1.5, borderStyle: "solid", color: INK, mixBlendMode: label ? "normal" : "difference" }}
      >
        <motion.span animate={{ opacity: label ? 1 : 0, scale: label ? 1 : 0.6 }} transition={{ duration: 0.18 }}>{label}</motion.span>
      </motion.div>
    </motion.div>
  );
}

/** Tilts toward the pointer in 3D, with a soft glare that follows it. Flat under reduced motion. */
export function useTilt(reduce: boolean) {
  const rx = useSpring(useMotionValue(0), { stiffness: 140, damping: 16 });
  const ry = useSpring(useMotionValue(0), { stiffness: 140, damping: 16 });
  const gx = useMotionValue(50);
  const gy = useMotionValue(0);
  const glare = useMotionTemplate`radial-gradient(520px circle at ${gx}% ${gy}%, rgb(255 236 200 / .14), transparent 55%)`;
  const handlers = {
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      if (reduce) return;
      const r = e.currentTarget.getBoundingClientRect();
      const nx = (e.clientX - r.left) / r.width;
      const ny = (e.clientY - r.top) / r.height;
      ry.set((nx - 0.5) * 9);
      rx.set(-(ny - 0.5) * 7);
      gx.set(nx * 100);
      gy.set(ny * 100);
    },
    onPointerLeave: () => { rx.set(0); ry.set(0); gy.set(0); gx.set(50); },
  };
  return { rx, ry, glare, handlers };
}

/** One character of a split headline: it rises out of its mask and comes into focus, on a spring. */
export function Char({ children, delay, reduce }: { children: string; delay: number; reduce: boolean }) {
  return (
    <motion.span
      aria-hidden
      className="inline-block"
      initial={reduce ? false : { y: "115%", rotate: 9, opacity: 0, filter: "blur(10px)" }}
      animate={{ y: 0, rotate: 0, opacity: 1, filter: "blur(0px)" }}
      transition={{ type: "spring", stiffness: 130, damping: 17, delay }}
    >
      {children}
    </motion.span>
  );
}

