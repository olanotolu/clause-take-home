/** Deterministic synthetic contract text (seeded PRNG), so every run benchmarks identical input. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SUBJECTS = ["The Receiving Party", "The Disclosing Party", "Each party", "The Vendor", "The Customer", "The Company"];
const VERBS = ["shall not disclose", "shall maintain", "may terminate", "shall indemnify", "agrees to protect", "shall notify"];
const OBJECTS = ["Confidential Information", "the Services", "Trade Secrets", "the Agreement", "Personal Data", "the Deliverables"];
const TAILS = [
  "except as permitted under this Agreement",
  "for a period of five (5) years following termination",
  "in accordance with applicable law (including the GDPR)",
  "and shall not exceed the limitations set out in §12.3",
  "subject to the exclusions in Section 6 — Permitted Disclosures",
];

export const RARE_TOKEN = "ZYGOMORPHIC";
export const END_MARKER = "THE-VERY-LAST-CLAUSE-ENDS-HERE";

export function generateContract(targetBytes: number, seed = 42): string {
  const rnd = mulberry32(seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]!;
  const parts: string[] = [];
  let bytes = 0;
  let n = 1;
  // Leave enough room for the final marker and the longest single paragraph.
  // Unicode makes UTF-8 bytes larger than the API's UTF-16 character count,
  // and the final paragraph can otherwise push a nominal 1 MiB case over cap.
  while (bytes < targetBytes - 256) {
    const para = `${n}.${(n % 9) + 1} ${pick(SUBJECTS)} ${pick(VERBS)} ${pick(OBJECTS)} ${pick(TAILS)}. ` + `Clause ${n} café naïve ${pick(OBJECTS)}.\n`;
    parts.push(para);
    bytes += Buffer.byteLength(para);
    if (n === 4242) parts.push(`Special ${RARE_TOKEN} provision appears exactly once.\n`);
    n++;
  }
  parts.push(`${END_MARKER}\n`);
  return parts.join("");
}
