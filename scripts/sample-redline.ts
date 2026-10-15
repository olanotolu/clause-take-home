/** Regenerates samples/mutual-nda-redline.docx: a real redline built through the edit engine from the NDA fixture. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyChanges, type Change } from "../packages/core/src/index.ts";
import { redlineDocx } from "../apps/api/src/docx.ts";

const root = join(import.meta.dirname, "..");
const v1 = readFileSync(join(root, "fixtures/mutual-nda.txt"), "utf8");
const q = (exact: string, replacement: string, extra = {}): Change => ({ operation: "replace", target: { quote: { exact, ...extra } }, replacement });

const r = applyChanges(v1, [
  q("The Receiving Party shall not disclose Confidential Information to any third party,", "The Receiving Party shall not disclose Confidential Information to any third party without the Disclosing Party's prior written consent,"),
  q("two (2) years", "three (3) years"),
  q("five (5) years", "seven (7) years"),
  q("6.3 Any notice under this Agreement shall be in writing and delivered to the addresses set out on the signature page.", "6.3 Any notice under this Agreement shall be in writing and delivered by email and courier to the addresses set out on the signature page.\n\n6.4 This Agreement may be executed in counterparts."),
]);
if (!r.ok) throw new Error(JSON.stringify(r.error));

const buf = await redlineDocx({ title: "Mutual NDA - Acme Corp", from: { version: 1, content: v1 }, to: { version: 2, content: r.value.content, createdAt: "2026-10-15T12:00:00.000Z" } });
writeFileSync(join(root, "samples/mutual-nda-redline.docx"), buf);
console.log(`wrote samples/mutual-nda-redline.docx (${buf.length} bytes)`);
