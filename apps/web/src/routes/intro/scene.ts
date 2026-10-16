export const W = 1600;
export const H = 900;
export const INK = "#2a180d";
export const BONE = "#f6ead2";
export const SUN = { x: W / 2, y: 470 } as const;

/** A smooth, deterministic ridge line (a few summed sines), so every load draws the same dunes. */
export function ridge(base: number, amp: number, phase: number, close = true): string {
  const pts: string[] = [];
  for (let x = 0; x <= W; x += 16) {
    const y = base + amp * Math.sin(x / 210 + phase) + amp * 0.45 * Math.sin(x / 83 + phase * 2.1) + amp * 0.2 * Math.sin(x / 31 + phase * 3.7);
    pts.push(`${x === 0 ? "M" : "L"}${x} ${y.toFixed(1)}`);
  }
  return close ? `${pts.join(" ")} L${W} ${H + 240} L0 ${H + 240} Z` : pts.join(" ");
}

/** Far to near. `depth` scales both the scroll rise and the pointer parallax; `lit` and `shade` are the crest and base colours. */
export const DUNES = [
  { lit: "#e9bd84", shade: "#c9925c", base: 520, amp: 26, phase: 0.4, depth: 0.12, rim: 0.55, haze: 0.5 },
  { lit: "#d79d62", shade: "#b0743f", base: 575, amp: 34, phase: 1.9, depth: 0.28, rim: 0.5, haze: 0.38 },
  { lit: "#bb7a47", shade: "#8d5430", base: 640, amp: 40, phase: 3.1, depth: 0.5, rim: 0.42, haze: 0.26 },
  { lit: "#8f5733", shade: "#5e381f", base: 720, amp: 46, phase: 4.6, depth: 0.78, rim: 0.34, haze: 0.14 },
  { lit: "#5c3520", shade: "#32190d", base: 810, amp: 38, phase: 5.8, depth: 1.15, rim: 0.22, haze: 0 },
] as const;

/** Flat-topped buttes on the far horizon. */
export const MESAS = [
  { x: 190, w: 250, h: 82, y: 505 },
  { x: 400, w: 120, h: 58, y: 510 },
  { x: 1090, w: 300, h: 96, y: 508 },
  { x: 1380, w: 140, h: 62, y: 512 },
] as const;

export const BEATS = [
  { n: "01", title: "Resolve", text: "A target that matches three places is refused, with every candidate listed. Never the first match." },
  { n: "02", title: "Version", text: "Every save is a new version. A stale edit is a conflict, never a silent merge." },
  { n: "03", title: "Check", text: "Clause CI shows which of your rules an edit would break, before anything is saved." },
] as const;

/** Where each beat sits in the scroll (0 to 1), and the card windows inside it. All values stay within [0, 1]. */
export const beatStart = (i: number) => 0.2 + i * 0.2;
