import { storeFromEnv } from "./config.ts";
import { createRecoveryManifest, pruneFromManifest, rehearseRecovery, restoreFromManifest } from "./content-recovery.ts";
import { executeJobBatch } from "./jobs/runner.ts";

const [operation,...args]=process.argv.slice(2);
const maintenanceKinds={"backfill-content":"content_backfill","verify-content":"integrity_sweep","cleanup-content":"orphan_cleanup"} as const;
if(operation==="queue"||operation==="dispatch") {
  const [base,kind]=args;
  if(!base||!process.env.CLAUSE_OPERATIONS_TOKEN) throw new Error("Set CLAUSE_OPERATIONS_TOKEN and supply the API base URL, including /api for hosted deployments");
  const url=new URL(`${base.replace(/\/$/,"")}/jobs${operation==="dispatch"?"/dispatch":""}`);
  const response=await fetch(url,{method:"POST",headers:{authorization:`Bearer ${process.env.CLAUSE_OPERATIONS_TOKEN}`,"content-type":"application/json"},...(operation==="queue"?{body:JSON.stringify({kind,idempotencyKey:args[2]??new Date().toISOString()})}:{})});
  if(!response.ok) throw new Error(`Job API failed with status ${response.status}`);
  console.log(await response.text());
} else {
  const allowed=["migrate",...Object.keys(maintenanceKinds),"manifest-content","rehearse-content","prune-content","restore-content"];
  if(!operation||!allowed.includes(operation)) throw new Error(`Usage: ops.ts ${allowed.join("|")}|queue|dispatch`);
  const env={...process.env,CLAUSE_STORAGE:process.env.CLAUSE_STORAGE??(process.env.DATABASE_URL?"postgres":"sqlite")};
  const store=await storeFromEnv(env,{}, {autoMigrate:operation==="migrate"});
  try {
    await store.checkReady();
    if(operation==="migrate") console.log("Database schema is current.");
    else if(operation==="manifest-content") console.log(JSON.stringify(await createRecoveryManifest(store)));
    else if(operation==="rehearse-content") console.log(JSON.stringify(await rehearseRecovery(args[0]??"")));
    else if(operation==="prune-content") console.log(JSON.stringify(await pruneFromManifest(store,args[0]??"",args[1]??"")));
    else if(operation==="restore-content") console.log(JSON.stringify(await restoreFromManifest(store,args[0]??"")));
    else {
      const kind=operation==="backfill-content"?"content_backfill":operation==="verify-content"?"integrity_sweep":"orphan_cleanup";
      const existingId=args[0];
      const created=existingId?undefined:await store.createJob({kind,payload:{kind},idempotencyKey:`${kind}:cli:${new Date().toISOString()}`});
      const id=existingId??created?.job.id;
      if(!id) throw new Error("The maintenance queue is full");
      console.log(JSON.stringify({jobId:id}));
      let retries=0;
      for(;;) {
        const result=await executeJobBatch(store,id);
        if(result.state==="done") break;
        if(result.state==="retry"&&retries++>=3) { await store.failJob(id,result.code); break; }
        if(result.state==="waiting"||result.state==="retry") await new Promise<void>((resolve)=>setTimeout(resolve,2000));
      }
      const job=await store.getJob(id);
      if(job?.status!=="succeeded") throw new Error(`Maintenance ${job?.status??"missing"}: ${job?.errorCode??"no error code"}`);
      console.log(JSON.stringify(job.output));
    }
  } finally { await store.close(); }
}
