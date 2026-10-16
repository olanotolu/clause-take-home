import type { MotionValue } from "motion/react";
import { useEffect, useRef } from "react";
import { FRAG, VERT } from "./shader.ts";

interface Props {
  /** Scroll progress, 0 to 1. */
  p: MotionValue<number>;
  px: MotionValue<number>;
  py: MotionValue<number>;
  reduce: boolean;
  /** Called if WebGL2 is unavailable or the context is lost, so the page can show its static fallback. */
  onFail: () => void;
}

/**
 * The camera holds a framing for each beat and moves between them in the gaps, like cuts that are dollies:
 * a new heading and a new lens (a tighter or wider shot) per beat, eased, never a straight linear glide.
 */
const SHOTS = [
  { from: 0, to: 0.12, yaw: 0, focal: 1.55 },
  { from: 0.24, to: 0.36, yaw: -0.3, focal: 1.85 },
  { from: 0.44, to: 0.56, yaw: 0.32, focal: 1.4 },
  { from: 0.64, to: 0.76, yaw: -0.12, focal: 2.15 },
  { from: 0.88, to: 1, yaw: 0, focal: 1.5 },
] as const;

export function shotAt(p: number): { yaw: number; focal: number } {
  for (let i = 0; i < SHOTS.length - 1; i++) {
    const a = SHOTS[i]!;
    const b = SHOTS[i + 1]!;
    if (p <= a.to) return { yaw: a.yaw, focal: a.focal };
    if (p < b.from) {
      const t = (p - a.to) / (b.from - a.to);
      const e = t * t * t * (t * (t * 6 - 15) + 10); // smootherstep
      return { yaw: a.yaw + (b.yaw - a.yaw) * e, focal: a.focal + (b.focal - a.focal) * e };
    }
  }
  const last = SHOTS[SHOTS.length - 1]!;
  return { yaw: last.yaw, focal: last.focal };
}

function compile(gl: WebGL2RenderingContext, type: number, src: string) {
  const sh = gl.createShader(type);
  if (!sh) throw new Error("no shader");
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? "shader failed");
  return sh;
}

/**
 * Draws the dune field, and only when something changed. While you scroll or move the pointer it renders at a low
 * resolution so it stays at frame rate; when you stop, it draws once more, sharp, and then the GPU goes idle. That
 * idle frame is the one most people are looking at, and it costs nothing, which keeps every other animation on the
 * page smooth. If frames still run long while moving, the moving resolution steps down.
 */
export function Terrain({ p, px, py, reduce, onFail }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, powerPreference: "high-performance" });
    if (!gl) { onFail(); return; }

    let program: WebGLProgram;
    try {
      program = gl.createProgram()!;
      gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT));
      gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "link failed");
    } catch {
      onFail();
      return;
    }
    const bind = gl.useProgram.bind(gl); // named so it does not read as a React hook
    bind(program);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, "aPos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const u = (name: string) => gl.getUniformLocation(program, name);
    const uRes = u("uRes"), uTime = u("uTime"), uScroll = u("uScroll"), uIntro = u("uIntro"), uPointer = u("uPointer"), uYaw = u("uYaw"), uFocal = u("uFocal");

    const automated = navigator.webdriver === true;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let moveScale = automated ? 0.18 : 0.5;
    const sharpScale = automated ? 0.18 : 0.85;
    let scale = moveScale;
    let w = 0;
    let h = 0;
    const fit = () => {
      w = Math.max(2, Math.round(canvas.clientWidth * dpr * scale));
      h = Math.max(2, Math.round(canvas.clientHeight * dpr * scale));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
    };
    fit();

    // Open the page with ?perf (for example /?perf#/welcome) to see, once a second in the console, how many frames were
    // actually drawn, how long the frames took, and the resolution it chose. Idle should read 0 drawn.
    const perf = new URLSearchParams(window.location.search).has("perf");
    let drawn = 0;
    let dtSum = 0;
    let dtN = 0;
    const perfTimer = perf ? window.setInterval(() => {
      console.info(`[intro] drawn ${drawn}/s, frame ${dtN ? (dtSum / dtN).toFixed(1) : "-"} ms, moving scale ${moveScale.toFixed(2)}, canvas ${w}x${h}`);
      drawn = 0; dtSum = 0; dtN = 0;
    }, 1000) : 0;

    const INTRO_S = 2.4;
    const start = performance.now();
    let last = start;
    let lastChange = start;
    let key = "";
    let drewSharp = false;
    let slow = 0;
    let raf = 0;
    let running = true;
    let dirty = true;
    const markDirty = () => { dirty = true; };
    window.addEventListener("resize", markDirty);

    const draw = (now: number) => {
      if (!running) return;
      raf = requestAnimationFrame(draw);
      const dt = now - last;
      last = now;
      const elapsed = (now - start) / 1000;
      const intro = reduce ? 1 : 1 - Math.pow(1 - Math.min(elapsed / INTRO_S, 1), 3);
      const scroll = Math.min(Math.max(p.get(), 0), 1);
      const ptrX = reduce ? 0 : px.get();
      const ptrY = reduce ? 0 : py.get();
      const next = `${scroll.toFixed(4)}|${ptrX.toFixed(3)}|${ptrY.toFixed(3)}|${intro.toFixed(3)}`;
      if (next !== key || dirty) {
        key = next;
        lastChange = now;
        drewSharp = false;
        dirty = false;
        scale = moveScale;
        // Step the moving resolution down if frames run long while animating.
        if (!automated) {
          if (dt > 24) slow++; else slow = 0;
          if (slow > 12 && moveScale > 0.3) { moveScale = Math.max(0.3, moveScale * 0.85); scale = moveScale; slow = 0; }
        }
      } else if (!drewSharp && now - lastChange > 220) {
        // Still for a moment: one sharp frame, then nothing until something moves again.
        scale = sharpScale;
        drewSharp = true;
      } else {
        return;
      }
      fit();
      drawn++;
      dtSum += dt;
      dtN++;
      const shot = shotAt(scroll);
      gl.uniform2f(uRes, w, h);
      gl.uniform1f(uTime, elapsed);
      gl.uniform1f(uScroll, scroll);
      gl.uniform1f(uIntro, intro);
      gl.uniform2f(uPointer, ptrX, ptrY);
      gl.uniform1f(uYaw, shot.yaw);
      gl.uniform1f(uFocal, shot.focal);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    raf = requestAnimationFrame(draw);

    const onVisibility = () => {
      if (document.hidden) { running = false; cancelAnimationFrame(raf); }
      else if (!running) { running = true; last = performance.now(); dirty = true; raf = requestAnimationFrame(draw); }
    };
    const onLost = (e: Event) => { e.preventDefault(); running = false; onFail(); };
    document.addEventListener("visibilitychange", onVisibility);
    canvas.addEventListener("webglcontextlost", onLost);

    return () => {
      running = false;
      window.clearInterval(perfTimer);
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", markDirty);
      document.removeEventListener("visibilitychange", onVisibility);
      canvas.removeEventListener("webglcontextlost", onLost);
      gl.deleteBuffer(buf);
      gl.deleteProgram(program);
    };
  }, [p, px, py, reduce, onFail]);

  return <canvas ref={ref} aria-hidden className="absolute inset-0 size-full" />;
}
