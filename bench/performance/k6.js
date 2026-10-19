import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Trend } from "k6/metrics";

const fixture=JSON.parse(open(__ENV.CLAUSE_FIXTURE_FILE));
const base=fixture.base.replace(/\/$/,"");
const mode=__ENV.CLAUSE_SCENARIO??"mixed";
const vus=Number(__ENV.CLAUSE_VUS??8);
const phase=__ENV.CLAUSE_PHASE??"warm";
const writeEnabled=__ENV.CLAUSE_ALLOW_WRITES==="1";
const writeMode=mode==="edit"||mode==="contention"||mode==="mixed";
const requestedWrites=Number(__ENV.CLAUSE_WRITE_ITERATIONS??100);
if(!Number.isSafeInteger(requestedWrites)||requestedWrites<1) throw new Error("CLAUSE_WRITE_ITERATIONS must be a positive integer");
const writeIterations=Math.min(100,requestedWrites);
if(!Array.isArray(fixture.documents)||!fixture.documents.length) throw new Error("Prepare disposable fixtures before running k6");
if((mode==="edit"||mode==="contention"||mode==="mixed")&&!writeEnabled) throw new Error("Set CLAUSE_ALLOW_WRITES=1 for these disposable benchmark fixtures");
http.setResponseCallback(http.expectedStatuses({min:200,max:399},409,412));
const serverFailures=new Counter("clause_http_5xx"),clientFailures=new Counter("clause_http_4xx"),transportFailures=new Counter("clause_http_transport");
let reportedFailure=false;
const failures=new Counter("clause_http_failures"),conflicts=new Counter("clause_cas_conflicts"),writes=new Counter("clause_committed_writes"),attempts=new Counter("clause_write_attempts");
const serverMetadata=new Trend("clause_server_metadata_ms",true),serverSearch=new Trend("clause_server_search_ms",true),serverEdit=new Trend("clause_server_edit_ms",true);
function serverTime(response,trend){const raw=response.headers["Server-Timing"]??response.headers["server-timing"];const found=raw?.match(/clause;dur=([\d.]+)/);if(found)trend.add(Number(found[1]));}
const bytes=new Counter("clause_response_bytes"),metadata=new Trend("clause_metadata_ms",true),search=new Trend("clause_search_ms",true),edit=new Trend("clause_edit_ms",true);
const strict=phase==="warm"&&vus===8&&fixture.bytes<=1048576;
export const options={summaryTrendStats:["min","med","p(90)","p(95)","p(99)","max"],scenarios:{load:writeMode?{executor:"shared-iterations",vus,iterations:writeIterations,maxDuration:__ENV.CLAUSE_MAX_DURATION??"2m"}:{executor:"constant-vus",vus,duration:__ENV.CLAUSE_DURATION??"30s"}},thresholds:{clause_http_failures:["count==0"],...(strict?{...(mode!=="search"?{clause_metadata_ms:["p(95)<100"]}:{}),...(["search","mixed"].includes(mode)?{clause_search_ms:["p(95)<300"]}:{}),...(["edit","contention","mixed"].includes(mode)?{clause_edit_ms:["p(95)<500"]}:{})}:{})}};
const headers={"Content-Type":"application/json",Prefer:"return=minimal",...(__ENV.VERCEL_AUTOMATION_BYPASS_SECRET?{"x-vercel-protection-bypass":__ENV.VERCEL_AUTOMATION_BYPASS_SECRET}:{})};
function receive(response) {bytes.add(response.body?.length??0);return response;}
function ok(response) {
  if(!check(response,{"request succeeds":r=>r.status>=200&&r.status<300})) {
    failures.add(1);if(response.status>=500)serverFailures.add(1);else if(response.status>=400)clientFailures.add(1);else transportFailures.add(1);
    if(!reportedFailure){reportedFailure=true;let code="UNKNOWN";try{const value=response.json().type;if(typeof value==="string"&&/^[A-Z_]{1,64}$/.test(value))code=value;}catch{}console.warn(JSON.stringify({status:response.status,code}));}
  }return response;
}
function read(id) {const response=receive(http.get(`${base}/documents/${encodeURIComponent(id)}`,{headers,tags:{name:"metadata"}}));metadata.add(response.timings.duration);serverTime(response,serverMetadata);return ok(response);}
function find() {const response=receive(http.get(`${base}/documents/search?q=confidentiality&mode=words&limit=10`,{headers,tags:{name:"search"}}));search.add(response.timings.duration);serverTime(response,serverSearch);ok(response);}
function update(id) {
  const current=read(id);if(current.status!==200)return;
  const doc=current.json();if(!doc.title.startsWith("CLAUSE loadfixture "))throw new Error("Writes are restricted to benchmark fixture documents");
  const from=doc.version%2===1?"CLAUSE_LOAD_A":"CLAUSE_LOAD_B",to=doc.version%2===1?"CLAUSE_LOAD_B":"CLAUSE_LOAD_A";
  const response=receive(http.patch(`${base}/documents/${encodeURIComponent(id)}`,JSON.stringify({expectedVersion:doc.version,changes:[{operation:"replace",target:{position:{start:0,end:from.length,expectedText:from}},replacement:to}]}),{headers,tags:{name:"edit"}}));
  attempts.add(1);
  edit.add(response.timings.duration);serverTime(response,serverEdit);
  if(response.status===409||response.status===412)conflicts.add(1);
  else if(response.status===200)writes.add(1);else ok(response);
}
export default function() {
  const doc=fixture.documents[mode==="contention"?0:(__VU-1)%fixture.documents.length];
  if(mode==="metadata")read(doc.id);else if(mode==="search")find();else if(mode==="edit"||mode==="contention")update(doc.id);else {read(doc.id);find();update(doc.id);}
  sleep(0.05);
}
export function handleSummary(data) {
  const values=name=>data.metrics[name]?.values??null;
  const report={generatedAt:new Date().toISOString(),base,bytes:fixture.bytes,phase,scenario:mode,clients:vus,...(writeMode?{writeAttemptLimit:writeIterations}:{}),metadata:values("clause_metadata_ms"),search:values("clause_search_ms"),edit:values("clause_edit_ms"),serverMetadata:values("clause_server_metadata_ms"),serverSearch:values("clause_server_search_ms"),serverEdit:values("clause_server_edit_ms"),attemptedWrites:values("clause_write_attempts"),committedWrites:values("clause_committed_writes"),conflicts:values("clause_cas_conflicts"),failures:values("clause_http_failures"),serverFailures:values("clause_http_5xx"),clientFailures:values("clause_http_4xx"),transportFailures:values("clause_http_transport"),transferredBytes:values("data_received"),responseBytes:values("clause_response_bytes"),thresholds:data.metrics};
  const output=JSON.stringify(report,null,2)+"\n";
  return {stdout:output,...(__ENV.CLAUSE_RESULT_FILE?{[__ENV.CLAUSE_RESULT_FILE]:output}:{})};
}
