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
 * The camera holds a framing for each beat and moves between them in the gaps, like cuts that are dollies instead:
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
 * Draws the dune field. The render resolution adapts: if frames run long it steps down, and it never goes below a
 * soft floor, so a slow GPU gets a softer picture instead of a stutter. Automated browsers get a small, cheap one.
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
    const uRes = u("uRes"), uTime = u("uTime"), uScroll = u("uScroll"), uIntro = u("uIntro"), uAnimate = u("uAnimate"), uPointer = u("uPointer"), uYaw = u("uYaw"), uFocal = u("uFocal");

    const automated = navigator.webdriver === true;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let scale = automated ? 0.18 : 0.72;
    let w = 0;
    let h = 0;
    const fit = () => {
      w = Math.max(2, Math.round(canvas.clientWidth * dpr * scale));
      h = Math.max(2, Math.round(canvas.clientHeight * dpr * scale));
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    };
    fit();
    window.addEventListener("resize", fit);

    const start = performance.now();
    let last = start;
    let slow = 0;
    let fast = 0;
    let raf = 0;
    let running = true;
    const draw = (now: number) => {
      if (!running) return;
      const dt = now - last;
      last = now;
      if (!automated && !reduce) {
        // Step the resolution down if frames run long, and back up if there is plenty of headroom.
        if (dt > 26) { slow++; fast = 0; } else if (dt < 15) { fast++; slow = 0; } else { slow = 0; fast = 0; }
        if (slow > 18 && scale > 0.34) { scale = Math.max(0.34, scale * 0.86); slow = 0; fit(); }
        if (fast > 240 && scale < 0.85) { scale = Math.min(0.85, scale * 1.1); fast = 0; fit(); }
      }
      const elapsed = (now - start) / 1000;
      const intro = reduce ? 1 : 1 - Math.pow(1 - Math.min(elapsed / 3.4, 1), 3);
      gl.uniform2f(uRes, w, h);
      gl.uniform1f(uTime, elapsed);
      gl.uniform1f(uScroll, Math.min(Math.max(p.get(), 0), 1));
      gl.uniform1f(uIntro, intro);
      gl.uniform1f(uAnimate, reduce ? 0 : 1);
      gl.uniform2f(uPointer, reduce ? 0 : px.get(), reduce ? 0 : py.get());
      const shot = shotAt(Math.min(Math.max(p.get(), 0), 1));
      gl.uniform1f(uYaw, shot.yaw);
      gl.uniform1f(uFocal, shot.focal);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    const onVisibility = () => {
      if (document.hidden) { running = false; cancelAnimationFrame(raf); }
      else if (!running) { running = true; last = performance.now(); raf = requestAnimationFrame(draw); }
    };
    const onLost = (e: Event) => { e.preventDefault(); running = false; onFail(); };
    document.addEventListener("visibilitychange", onVisibility);
    canvas.addEventListener("webglcontextlost", onLost);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", fit);
      document.removeEventListener("visibilitychange", onVisibility);
      canvas.removeEventListener("webglcontextlost", onLost);
      gl.deleteBuffer(buf);
      gl.deleteProgram(program);
    };
  }, [p, px, py, reduce, onFail]);

  return <canvas ref={ref} aria-hidden className="absolute inset-0 size-full" />;
}
