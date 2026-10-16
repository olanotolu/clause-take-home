import { storeFromEnv } from "./config.ts";
import { SEED_DOCUMENTS } from "./seed-data.ts";

/** Loads the fictional contracts into whichever database the environment selects (SQLite by default). Never touches existing rows. */
const store = await storeFromEnv(process.env);
const existing = new Set((await store.listDocuments(100, 0)).items.map((d) => d.title));
for (const item of SEED_DOCUMENTS) {
  if (existing.has(item.title)) continue;
  const doc = await store.insertDocument(item);
  console.log(`${doc.id}  v${doc.version}  ${item.title}`);
}
await store.close();
