export const INK = "#141416";
export const BONE = "#f5f5f5";

/** A run of text; `strong` runs are set heavier, so the claim reads before the sentence does. */
export type Run = readonly [text: string, strong?: true];

export const BEATS: readonly { n: string; title: string; runs: readonly Run[] }[] = [
  { n: "01", title: "Resolve", runs: [["A target that matches three places is "], ["refused", true], [", with every candidate listed. "], ["Never the first match.", true]] },
  { n: "02", title: "Version", runs: [["Every save is a new version. A stale edit is a "], ["conflict", true], [", never a "], ["silent merge.", true]] },
  { n: "03", title: "Check", runs: [["Clause CI shows which of your rules an edit would break, "], ["before anything is saved.", true]] },
];

/** Where each beat starts in the scroll (0 to 1). Every window stays inside [0, 1]. */
export const beatStart = (i: number) => 0.2 + i * 0.2;
