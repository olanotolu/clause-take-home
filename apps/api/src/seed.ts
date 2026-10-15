import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { openDb } from "./db.ts";
import { insertDocument, listDocuments } from "./repo.ts";

/** Loads the fictional contracts in fixtures/ into a database. Run: `pnpm seed`. Never touches existing rows. */
const dbPath = process.env.CLAUSE_DB ?? "data/clause.db";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
mkdirSync(dirname(dbPath), { recursive: true });

const db = openDb(dbPath);
const dir = join(import.meta.dirname, "../../../fixtures");
const TITLES: Record<string, string> = {
  "mutual-nda": "Mutual NDA - Acme Corp",
  "saas-agreement": "SaaS Agreement - Initech",
  "vendor-msa": "MSA - Hooli",
  "data-processing-addendum": "Data Processing Addendum - Soylent",
  "employment-confidentiality": "Employee Confidentiality Agreement - Stark",
};
const existing = new Set(listDocuments(db, 100, 0).items.map((d) => d.title));
for (const file of readdirSync(dir).filter((f) => f.endsWith(".txt")).sort()) {
  const key = basename(file, ".txt");
  const title = TITLES[key] ?? key;
  if (existing.has(title)) continue;
  const doc = insertDocument(db, { title, content: readFileSync(join(dir, file), "utf8") });
  console.log(`${doc.id}  v${doc.version}  ${title}`);
}
db.close();
