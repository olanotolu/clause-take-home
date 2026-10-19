import { createServer } from "node:http";
import { buildApp } from "../apps/api/src/app.ts";
import { flushTelemetryBounded, initTelemetry, recordRoute, shutdownTelemetryBounded } from "../apps/api/src/telemetry.ts";

const credential="Bearer clause-local-auth-smoke";
let delivered:Promise<{authorized:boolean;bytes:number;payload:Buffer}>;
let resolveDelivery:(value:{authorized:boolean;bytes:number;payload:Buffer})=>void=()=>undefined;
delivered=new Promise((resolve)=>{resolveDelivery=resolve;});
const collector=createServer((request,response)=>{
  let bytes=0;
  const payload:Buffer[]=[];
  request.on("data",(chunk:Buffer)=>{bytes+=chunk.byteLength;payload.push(chunk);});
  request.on("end",()=>{
    const authorized=request.headers.authorization===credential;
    resolveDelivery({authorized,bytes,payload:Buffer.concat(payload)});
    response.writeHead(authorized?200:401,{"content-type":"application/x-protobuf"});
    response.end();
  });
});
await new Promise<void>((resolve,reject)=>{collector.once("error",reject);collector.listen(0,"127.0.0.1",resolve);});
const address=collector.address();
if(!address||typeof address==="string")throw new Error("Local collector did not bind");
process.env.OTEL_EXPORTER_OTLP_ENDPOINT=`http://127.0.0.1:${address.port}`;
process.env.OTEL_EXPORTER_OTLP_HEADERS=`authorization=${encodeURIComponent(credential)}`;
process.env.OTEL_METRIC_EXPORT_INTERVAL_MS="60000";
try {
  initTelemetry();
  const app=await buildApp();
  const sensitiveBody="sensitive-contract-body-sentinel";
  const created=await app.inject({method:"POST",url:"/documents",payload:{title:"sensitive-title-sentinel",content:sensitiveBody}});
  const documentId=(created.json() as {id:string}).id;
  if(created.statusCode!==201||(await app.inject({method:"GET",url:`/documents/${documentId}`})).statusCode!==200)throw new Error("Unable to produce app telemetry fixture");
  await app.close();
  recordRoute({method:"GET",route:"/health",status:200,durationMs:3});
  await flushTelemetryBounded(5000);
  const result=await Promise.race([delivered,new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error("Authenticated collector received no metrics")),5000))]);
  if(!result.authorized||result.bytes===0)throw new Error("OTLP metric delivery was rejected by the authenticated collector");
  for(const sensitive of [sensitiveBody,"sensitive-title-sentinel",documentId,"sensitive-user-id"])if(result.payload.includes(Buffer.from(sensitive)))throw new Error("Sensitive document or user data found in OTLP payload");
  console.log(JSON.stringify({authenticatedDelivery:true,metricsPayloadBytes:result.bytes,sensitiveDataExcluded:true,credentialIncludedInOutput:false}));
} finally {
  await shutdownTelemetryBounded(1000);
  await new Promise<void>((resolve)=>collector.close(()=>resolve()));
}
