import { defineNitroConfig } from "nitro/config";

// Preview follows the Neon primary in us-east-2 (Vercel cle1). Production stays in iad1.
const functionRegion=process.env.VERCEL_ENV==="preview"?"cle1":"iad1";

export default defineNitroConfig({
  modules:["workflow/nitro"],
vercel:{entryFormat:"node",functions:{regions:[functionRegion],maxDuration:300}},
  routes:{"/**":{handler:"./src/nitro-handler.ts",format:"node"}},
});
