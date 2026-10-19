import { readFile, stat } from "node:fs/promises";
import { buildApp } from "../apps/api/src/app.ts";
import { flushTelemetryBounded, instrumentStore, recordAi, recordBlob, recordDatabaseAcquire, recordDatabaseQuery, recordJobQueueAge, shutdownTelemetryBounded } from "../apps/api/src/telemetry.ts";

if(!process.env.OTEL_EXPORTER_OTLP_ENDPOINT||!process.env.CLAUSE_OTEL_CAPTURE) throw new Error("Start the collector with ops/otel-collector.yaml; set OTEL_EXPORTER_OTLP_ENDPOINT and CLAUSE_OTEL_CAPTURE to its log file");
const start=(await stat(process.env.CLAUSE_OTEL_CAPTURE)).size;
const app=await buildApp();
const body="sensitive-contract-body-sentinel";
const created=await app.inject({method:"POST",url:"/documents",payload:{title:"sensitive-title-sentinel",content:body}});
const id=created.json().id;
try {
  await app.inject({method:"GET",url:`/documents/${id}`});
  const failing=instrumentStore({kind:"sqlite",async controlledFailure(){throw new Error("fixture");}});
  await failing.controlledFailure().catch(()=>undefined);
  recordAi("fixture/no-provider",{inputTokens:100,outputTokens:20},0.00042,true,10);
  recordBlob("read",2,32);recordBlob("upload",3,32,true);
  recordDatabaseAcquire(2,false);recordDatabaseQuery("SELECT",3,true);
  recordJobQueueAge("export",new Date(Date.now()-1200).toISOString());
  await flushTelemetryBounded(5000);
  await new Promise<void>((resolve)=>setTimeout(resolve,500));
  const expected=["clause.http.server.requests","clause.database.operation.errors","clause.database.query.calls","clause.database.pool.acquire.duration","clause.ai.errors","clause.ai.input_tokens","clause.ai.estimated_cost","clause.blob.bytes","clause.jobs.queue.age"];
  let output="";const deadline=Date.now()+60_000;
  while(Date.now()<deadline) {
    await flushTelemetryBounded(5000);
    output=(await readFile(process.env.CLAUSE_OTEL_CAPTURE,"utf8")).slice(start);
    if(expected.every((metric)=>output.includes(metric))) break;
    await new Promise<void>((resolve)=>setTimeout(resolve,500));
  }
  for(const metric of expected) if(!output.includes(metric)) throw new Error(`Collector did not receive ${metric}`);
  for(const sensitive of [body,"sensitive-title-sentinel",id,"user.id","document.id","url.full"]) if(output.includes(sensitive)) throw new Error("Sensitive telemetry label detected");
  console.log(JSON.stringify({generatedAt:new Date().toISOString(),node:process.version,metricDelivery:true,sensitiveLabelsAbsent:true,metrics:expected},null,2));
} finally {await app.close();await shutdownTelemetryBounded(1000);}
