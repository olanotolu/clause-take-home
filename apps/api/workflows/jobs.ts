import { sleep } from "workflow";
import { attachDatabasePool } from "@vercel/functions";
import { storeFromEnv } from "../src/config.ts";
import { cleanupJobOutputs, executeJobBatch, type BatchResult } from "../src/jobs/runner.ts";

async function batch(jobId:string):Promise<BatchResult> {
  "use step";
  const store=await storeFromEnv(process.env,process.env.VERCEL?{onPool:attachDatabasePool}:{},{autoMigrate:!process.env.VERCEL});
  try { return await executeJobBatch(store,jobId); }
  finally { await store.close(); }
}

async function fail(jobId:string,code:string):Promise<void> {
  "use step";
  const store=await storeFromEnv(process.env,process.env.VERCEL?{onPool:attachDatabasePool}:{},{autoMigrate:!process.env.VERCEL});
  try { await store.failJob(jobId,code); await cleanupJobOutputs(store,jobId); }
  finally { await store.close(); }
}

export async function jobsWorkflow(jobId:string):Promise<void> {
  "use workflow";
  let retries=0;
  for(;;) {
    const result=await batch(jobId);
    if(result.state==="done") return;
    if(result.state==="retry") {
      if(retries>=3) { await fail(jobId,result.code); return; }
      retries++;
      await sleep("2s");
    } else if(result.state==="waiting") await sleep("2s");
    else retries=0;
  }
}
