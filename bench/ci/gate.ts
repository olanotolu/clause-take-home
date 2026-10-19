import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { JudgeSummary } from "./report.ts";

const dir = join(import.meta.dirname, "results");
const config = JSON.parse(readFileSync(join(import.meta.dirname, "config.json"), "utf8")) as { llmModel: string; jevModel: string };
const cases = JSON.parse(readFileSync(join(import.meta.dirname, "cases.json"), "utf8")) as { static: unknown[]; regression: unknown[]; cuadStatic: unknown[] };
const summaries = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8")) as JudgeSummary[];
const baseline = summaries.find((summary) => summary.judge === config.llmModel);
const jev = summaries.find((summary) => summary.judge === config.jevModel);
const reasons: string[] = [];
if (!baseline || !jev) reasons.push("both the current judge and Jev need recorded benchmark results");
if (baseline && baseline.coverage.static.answered !== cases.static.length) reasons.push(`current-judge ContractNLI coverage is ${baseline.coverage.static.answered}/${cases.static.length}`);
if (baseline && baseline.coverage.regressionTexts.answered !== cases.regression.length * 3) reasons.push(`current-judge regression-text coverage is ${baseline.coverage.regressionTexts.answered}/${cases.regression.length * 3}`);
if (baseline && baseline.errors !== 0) reasons.push(`current judge had ${baseline.errors} provider failures across benchmark attempts`);
if (baseline && baseline.cuad.attempted !== cases.cuadStatic.length) reasons.push(`current-judge CUAD coverage is ${baseline.cuad.attempted}/${cases.cuadStatic.length}`);
if (baseline && baseline.cuad.answered !== cases.cuadStatic.length) reasons.push(`current-judge CUAD answered coverage is ${baseline.cuad.answered}/${cases.cuadStatic.length}`);
if (jev && jev.coverage.static.answered !== cases.static.length) reasons.push(`Jev ContractNLI coverage is ${jev.coverage.static.answered}/${cases.static.length}`);
if (jev && jev.coverage.regressionTexts.answered !== cases.regression.length * 3) reasons.push(`Jev regression-text coverage is ${jev.coverage.regressionTexts.answered}/${cases.regression.length * 3}`);
if (jev && jev.errors !== 0) reasons.push(`Jev had ${jev.errors} provider failures`);
if (jev && jev.cuad.answered !== cases.cuadStatic.length) reasons.push(`Jev CUAD answered coverage is ${jev.cuad.answered}/${cases.cuadStatic.length}`);
if (jev && Object.keys(jev.cuad.categories).length < 41) reasons.push(`CUAD category coverage is ${Object.keys(jev.cuad.categories).length}/41`);
if (baseline && jev && jev.cuad.falsePassRate.p > baseline.cuad.falsePassRate.p) reasons.push("CUAD false-PASS point rate is higher than the current judge");
if (baseline && jev && jev.regression.recallAll.p < baseline.regression.recallAll.p) reasons.push("regression detection point rate is lower than the current judge");
if (reasons.length) {
  console.error("PILOT GATE FAILED:");
  for (const reason of reasons) console.error(`- ${reason}`);
  process.exitCode = 1;
} else {
  console.log(`PILOT GATE PASSED: Jev ${jev!.cuad.falsePassRate.p.toFixed(3)} false-PASS rate <= ${baseline!.cuad.falsePassRate.p.toFixed(3)} baseline; regression detection ${jev!.regression.recallAll.p.toFixed(3)} >= ${baseline!.regression.recallAll.p.toFixed(3)} baseline.`);
}
