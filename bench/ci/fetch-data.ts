/**
 * Downloads the ContractNLI dataset (Koreeda & Manning, 2021; Stanford NLP; CC BY 4.0) into bench/ci/data/ (git-ignored).
 *   607 real non-disclosure agreements, 17 fixed hypotheses, labels Entailment | Contradiction | NotMentioned,
 *   evidence given as span indices into each document.
 * Source: https://stanfordnlp.github.io/contract-nli/
 * If you reuse results, attribute: Koreeda & Manning, "ContractNLI: A Dataset for Document-level NLI for Contracts" (Findings of EMNLP 2021).
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const URL = "https://stanfordnlp.github.io/contract-nli/resources/contract-nli.zip";
const dir = join(import.meta.dirname, "data");
const zip = join(dir, "contract-nli.zip");
mkdirSync(dir, { recursive: true });

if (!existsSync(zip)) {
  console.log(`downloading ${URL}`);
  const res = await fetch(URL);
  if (!res.ok || !res.body) throw new Error(`download failed: ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(zip));
}
const bytes = statSync(zip).size;
const sha = createHash("sha256").update(readFileSync(zip)).digest("hex");
console.log(`zip: ${(bytes / 1048576).toFixed(1)} MiB  sha256 ${sha}`);
execFileSync("unzip", ["-oq", zip, "-d", dir]);
console.log("unzipped into bench/ci/data/");
