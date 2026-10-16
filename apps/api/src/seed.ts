import { storeFromEnv } from "./config.ts";
import { SEED_DOCUMENTS } from "./seed-data.ts";
import { SEED_PLAYBOOKS, SEED_REQUESTS } from "./seed-workspace.ts";

/** Loads the fictional contracts into whichever database the environment selects (SQLite by default). Never touches existing rows. */
const store = await storeFromEnv(process.env);
const existing = new Set((await store.listDocuments(100, 0)).items.map((d) => d.title));
for (const item of SEED_DOCUMENTS) {
  if (existing.has(item.title)) continue;
  const doc = await store.insertDocument(item);
  console.log(`${doc.id}  v${doc.version}  ${item.title}`);
}
const playbooks = await store.seedPlaybooksIfEmpty(SEED_PLAYBOOKS);
const requests = await store.seedRequestsIfEmpty(SEED_REQUESTS);
if (playbooks) console.log(`${playbooks} sample playbooks`);
if (requests) console.log(`${requests} sample requests`);
await store.close();
