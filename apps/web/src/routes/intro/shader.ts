export const VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

/**
 * A ray-marched dune field. The same height function drives the silhouette, the surface normal (with fine wind ripples
 * added), the sun's cast shadows and the haze, so the light reads as light on terrain rather than as a painted gradient.
 */
export const FRAG = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform float uScroll;   // 0..1 through the page
uniform float uIntro;    // 0..1 over the opening seconds
uniform float uAnimate;  // 0 under reduced motion: no drift, no shimmer
uniform vec2 uPointer;   // -0.5..0.5
uniform float uYaw;      // camera heading, set per beat
uniform float uFocal;    // focal length: larger is a tighter shot
out vec4 outColor;

float hash(vec2 p) { p = 50.0 * fract(p * 0.3183099 + vec2(0.71, 0.113)); return fract(p.x * p.y * (p.x + p.y)); }
float noise(vec2 x) {
  vec2 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}

float dune(vec2 p) {
  p = mat2(0.80, -0.60, 0.60, 0.80) * p; // slant the crests across the view so the light can rake them
  vec2 w = p + 22.0 * noise(p * 0.011) * vec2(1.0, 0.8);
  float h = 0.0;
  float a = 8.5;
  vec2 q = vec2(w.x * 0.011, w.y * 0.034);
  for (int i = 0; i < 3; i++) {
    float n = noise(q);
    n = 1.0 - abs(2.0 * n - 1.0);
    // Broad, low slopes meeting in a thin crest: dunes, not peaks.
    h += a * n * n * n;
    q = q * 2.03 + 11.7;
    a *= 0.36;
  }
  return h;
}
// Fine ripples, only used for shading.
float ripple(vec2 p) {
  float s = noise(p * 0.35) * 5.0;
  return 0.035 * sin(p.x * 6.5 + s) + 0.012 * sin(p.x * 17.0 + p.y * 1.3 + s * 2.0);
}
float surf(vec2 p) { return dune(p) + ripple(p); }

vec3 skyColor(vec3 rd, vec3 sun, float day) {
  float y = clamp(rd.y, 0.0, 1.0);
  vec3 dTop = vec3(0.06, 0.05, 0.13), dMid = vec3(0.50, 0.20, 0.22), dHor = vec3(1.0, 0.60, 0.30);
  vec3 nTop = vec3(0.26, 0.38, 0.60), nMid = vec3(0.82, 0.62, 0.46), nHor = vec3(1.0, 0.74, 0.46);
  vec3 top = mix(dTop, nTop, day), mid = mix(dMid, nMid, day), hor = mix(dHor, nHor, day);
  vec3 c = mix(hor, mid, smoothstep(0.0, 0.22, y));
  c = mix(c, top, smoothstep(0.12, 0.9, y));
  float sd = max(dot(rd, sun), 0.0);
  vec3 sunCol = mix(vec3(1.0, 0.62, 0.30), vec3(1.0, 0.86, 0.62), day);
  c += sunCol * (0.30 * pow(sd, 5.0) + 0.55 * pow(sd, 48.0));
  c += vec3(1.0, 0.93, 0.78) * 6.0 * smoothstep(0.99935, 0.99965, sd);
  return c;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;

  // Camera: high over the field, glides forward with the scroll, rises a little so it opens up, drifts on its own.
  vec3 ro = vec3(uPointer.x * 4.0, 0.0, uScroll * 170.0);
  ro.y = dune(ro.xz) + 15.0 + uScroll * 16.0;
  float pitch = -0.17 - uScroll * 0.12 - uPointer.y * 0.06;
  vec3 fwd = normalize(vec3(sin(uYaw + uPointer.x * 0.1) * cos(pitch), sin(pitch), cos(uYaw + uPointer.x * 0.1) * cos(pitch)));
  vec3 right = normalize(cross(vec3(0, 1, 0), fwd));
  vec3 up = cross(fwd, right);
  vec3 rd = normalize(uv.x * right + uv.y * up + uFocal * fwd);

  // The day: dawn at the top of the page, high gold light by the end. The sun climbs out of the dark in the opening.
  float day = smoothstep(0.0, 0.32, uScroll);
  float el = mix(0.07, 0.5, smoothstep(0.0, 0.85, uScroll)) - (1.0 - uIntro) * 0.07;
  float az = -0.95;
  vec3 sun = normalize(vec3(sin(az) * cos(el), sin(el), cos(az) * cos(el)));
  vec3 sunCol = mix(vec3(1.0, 0.55, 0.26), vec3(1.0, 0.82, 0.55), day) * mix(2.4, 3.0, day);

  vec3 col;
  float t = 0.4;
  float tPrev = t;
  bool hit = false;
  for (int i = 0; i < 124; i++) {
    vec3 p = ro + rd * t;
    float d = p.y - dune(p.xz);
    if (d < 0.0015 * t) { hit = true; break; }
    tPrev = t;
    t += max(0.5 * d, 0.0058 * t);
    if (t > 420.0) break;
  }
  if (hit) {
    // Bisect between the last point above the surface and the first below it, so the silhouette is smooth, not stepped.
    float lo = tPrev, hi = t;
    for (int i = 0; i < 4; i++) {
      float mid = 0.5 * (lo + hi);
      vec3 q = ro + rd * mid;
      if (q.y - dune(q.xz) > 0.0) lo = mid; else hi = mid;
    }
    t = 0.5 * (lo + hi);
  }

  if (hit) {
    vec3 p = ro + rd * t;
    float e = 0.04 + 0.002 * t;
    vec3 n = normalize(vec3(surf(p.xz - vec2(e, 0)) - surf(p.xz + vec2(e, 0)), 2.0 * e, surf(p.xz - vec2(0, e)) - surf(p.xz + vec2(0, e))));
    // Soft shadows from the sun across the dunes.
    float sh = 1.0;
    float s = 0.25;
    for (int i = 0; i < 20; i++) {
      vec3 q = p + n * 0.05 + sun * s;
      float d = q.y - dune(q.xz);
      sh = min(sh, clamp(7.0 * d / s, 0.0, 1.0));
      s += clamp(d, 0.35, 9.0);
      if (sh < 0.02 || s > 120.0) break;
    }
    float dif = max(dot(n, sun), 0.0) * sh;
    float grain = noise(p.xz * 0.5) * 0.5 + noise(p.xz * 2.7) * 0.5;
    vec3 sand = mix(vec3(0.72, 0.36, 0.13), vec3(0.99, 0.70, 0.36), grain);
    sand *= 0.92 + 0.16 * hash(floor(p.xz * 38.0));
    vec3 amb = mix(vec3(0.22, 0.12, 0.09), vec3(0.40, 0.29, 0.22), day) * (0.45 + 0.55 * n.y);
    vec3 bounce = vec3(0.42, 0.22, 0.10) * pow(1.0 - n.y, 2.0) * 0.5;
    col = sand * (sunCol * dif + amb + bounce);
    // Glints where the sun catches single grains.
    float glint = pow(hash(floor(p.xz * 70.0) + 3.0), 38.0) * dif;
    col += vec3(1.0, 0.85, 0.6) * glint * 2.4;
    // A warm rim where the surface turns away from the eye.
    col += sunCol * 0.10 * pow(1.0 - max(dot(n, -rd), 0.0), 3.0) * sh;
    // Haze: distance fades into the horizon colour, and glows toward the sun.
    float sd = max(dot(rd, sun), 0.0);
    vec3 hazeCol = skyColor(normalize(vec3(rd.x, 0.02, rd.z)), sun, day);
    float fog = 1.0 - exp(-pow(t * 0.0042, 1.35));
    col = mix(col, hazeCol + sunCol * 0.18 * pow(sd, 6.0), fog);
  } else {
    col = skyColor(rd, sun, day);
  }

  // Film: exposure comes up from black in the opening, tonemap, vignette, grain.
  col *= mix(0.0, 1.0, smoothstep(0.0, 0.75, uIntro));
  col = (col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14);
  col = pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2));
  col = mix(vec3(dot(col, vec3(0.299, 0.587, 0.114))), col, 0.0); // monochrome: no sand or sunset tint
  vec2 vq = gl_FragCoord.xy / uRes;
  col *= 0.55 + 0.45 * pow(16.0 * vq.x * vq.y * (1.0 - vq.x) * (1.0 - vq.y), 0.18);
  col += (hash(gl_FragCoord.xy + fract(uTime) * 91.7) - 0.5) * 0.035;
  outColor = vec4(col, 1.0);
}`;
