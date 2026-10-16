import { readFileSync } from "node:fs";
import { join } from "node:path";

export type NliLabel = "Entailment" | "Contradiction" | "NotMentioned";

export interface NliDocument {
  id: number;
  text: string;
  /** [start, end) character offsets of each annotated span (a sentence or list item). */
  spans: [number, number][];
  annotation_sets: { annotations: Record<string, { choice: NliLabel; spans: number[] }> }[];
}

export interface NliSplit {
  documents: NliDocument[];
  labels: Record<string, { short_description: string; hypothesis: string }>;
}

const dir = join(import.meta.dirname, "data", "contract-nli");

export function loadSplit(name: "train" | "dev" | "test"): NliSplit {
  return JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8")) as NliSplit;
}

export const annotationsOf = (d: NliDocument) => d.annotation_sets[0]!.annotations;
