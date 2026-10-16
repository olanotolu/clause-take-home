export const INK = "#1d0f07";
export const BONE = "#f6ead2";

export const BEATS = [
  { n: "01", title: "Resolve", text: "A target that matches three places is refused, with every candidate listed. Never the first match." },
  { n: "02", title: "Version", text: "Every save is a new version. A stale edit is a conflict, never a silent merge." },
  { n: "03", title: "Check", text: "Clause CI shows which of your rules an edit would break, before anything is saved." },
] as const;

/** Where each beat starts in the scroll (0 to 1). Every window stays inside [0, 1]. */
export const beatStart = (i: number) => 0.2 + i * 0.2;
