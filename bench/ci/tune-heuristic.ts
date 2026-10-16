/**
 * Picks the keyword baseline's one threshold (tau) on the DEV split only, by macro-F1, and records it in config.json.
 * The test items are never read here. Run once; the result is committed before any judge touches the test cases.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadSplit } from "./dataset.ts";
import { bestSentence } from "./heuristic.ts";
import type { CasesFile } from "./build-cases.ts";
import { classReport, confusion } from "./metrics.ts";
import cases from "./cases.json" with { type: "json" };

const dev = (cases as CasesFile).dev;
const split = loadSplit("dev");
const byId = new Map(split.documents.map((d) => [d.id, d]));
const LABELS = ["Entailment", "Contradiction", "NotMentioned"] as const;
const NEG = /\b(not|no|never|neither|nor|without|cannot)\b/i;

const grid: { tau: number; macroF1: number; accuracy: number }[] = [];
for (let tau = 0.05; tau <= 0.9001; tau += 0.05) {
  const rows = dev.map((c) => {
    const doc = byId.get(c.docId)!;
    const hyp = split.labels[c.hypothesis]!.hypothesis;
    const { score, sentence } = bestSentence(hyp, doc.text);
    const pred = score < tau ? "NotMentioned" : NEG.test(sentence) !== NEG.test(hyp) ? "Contradiction" : "Entailment";
    return { truth: c.label, pred } as const;
  });
  const r = classReport(LABELS, confusion(LABELS, rows));
  grid.push({ tau: Math.round(tau * 100) / 100, macroF1: r.macroF1, accuracy: r.accuracy });
}
const best = grid.reduce((a, b) => (b.macroF1 > a.macroF1 ? b : a));
for (const g of grid) console.log(`tau ${g.tau.toFixed(2)}  macro-F1 ${g.macroF1.toFixed(3)}  acc ${g.accuracy.toFixed(3)}${g.tau === best.tau ? "   <- chosen" : ""}`);

writeFileSync(
  join(import.meta.dirname, "config.json"),
  JSON.stringify(
    {
      note: "Fixed BEFORE any judge ran on the test cases. tau was chosen on the dev split only.",
      heuristicTau: best.tau,
      heuristicDevMacroF1: Number(best.macroF1.toFixed(4)),
      jevMinConfidence: 0.7,
      llmModel: "anthropic/claude-sonnet-5.5",
      jevModel: "typesafe-ai/jev-1.14.0",
      judgeTimeoutMs: 40000,
    },
    null,
    1,
  ) + "\n",
);
