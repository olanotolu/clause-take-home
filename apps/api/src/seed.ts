import { storeFromEnv } from "./config.ts";
import { SEED_DOCUMENTS } from "./seed-data.ts";
import { SEED_PLAYBOOKS, SEED_REQUESTS, seedDemoRequirements } from "./seed-workspace.ts";

/** Makes sure the fictional sample contracts exist in whichever database the environment selects (SQLite by default). Never rewrites an existing document. */
const store = await storeFromEnv(process.env);
const samples = await store.ensureSamples(SEED_DOCUMENTS);
if (samples) console.log(`${samples} sample contracts created or marked`);
const playbooks = await store.seedPlaybooksIfEmpty(SEED_PLAYBOOKS);
const requests = await store.seedRequestsIfEmpty(SEED_REQUESTS);
const demoRules = await seedDemoRequirements(store);
if (demoRules) console.log(`${demoRules} requirements on the sample NDA (from the NDA playbook)`);
if (playbooks) console.log(`${playbooks} sample playbooks`);
if (requests) console.log(`${requests} sample requests`);
await store.close();
