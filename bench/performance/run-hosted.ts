import { spawn } from "node:child_process";
import { readFile, mkdir, writeFile, open } from "node:fs/promises";
import { loadavg, platform, arch } from "node:os";
import { join } from "node:path";

const fixtureFile=process.env.CLAUSE_FIXTURE_FILE;
if(!fixtureFile)throw new Error("Set CLAUSE_FIXTURE_FILE to a disposable preview inventory");
const fixture=JSON.parse(await readFile(fixtureFile,"utf8"));
const output=process.env.CLAUSE_RESULTS_DIR??join(import.meta.dirname,"results",new Date().toISOString().replaceAll(":","-"));
await mkdir(output,{recursive:true});
async function run(clients:number,scenario:string,phase:string,duration:string,writeIterations=100) {
  const name=`${phase}-${clients}-${scenario}`,log=await open(join(output,`${name}.log`),"w");
  try {
    const child=spawn("k6",["run",join(import.meta.dirname,"k6.js")],{env:{...process.env,CLAUSE_VUS:String(clients),CLAUSE_SCENARIO:scenario,CLAUSE_PHASE:phase,CLAUSE_DURATION:duration,CLAUSE_WRITE_ITERATIONS:String(writeIterations),CLAUSE_ALLOW_WRITES:"1",CLAUSE_RESULT_FILE:join(output,`${name}.json`)},stdio:["ignore",log.fd,log.fd]});
    const exitCode=await new Promise<number|null>((resolve)=>child.once("exit",resolve));
    console.log(JSON.stringify({clients,scenario,phase,writeIterations,exitCode}));return {clients,scenario,phase,writeIterations,exitCode};
  } finally {await log.close();}
}
async function diagnostics() {
  const token=process.env.CLAUSE_OPERATIONS_TOKEN;if(!token)return null;
  const response=await fetch(`${fixture.base}/internal/diagnostics`,{headers:{authorization:`Bearer ${token}`,...(process.env.VERCEL_AUTOMATION_BYPASS_SECRET?{"x-vercel-protection-bypass":process.env.VERCEL_AUTOMATION_BYPASS_SECRET}:{})}});
  return response.ok?await response.json():{status:response.status};
}
const before=await diagnostics(),initialLoad=loadavg();
await run(1,"metadata","initial",process.env.CLAUSE_DURATION??"15s");
await run(8,"metadata","warmup","5s");
await run(8,"search","warmup","5s");
await run(8,"edit","warmup","5s",10);
const runs=[];
for(const clients of [1,8,32])for(const scenario of ["metadata","search","edit","contention","mixed"])runs.push(await run(clients,scenario,"warm",process.env.CLAUSE_DURATION??"15s"));
await writeFile(join(output,"environment.json"),JSON.stringify({generatedAt:new Date().toISOString(),node:process.version,platform:platform(),arch:arch(),fixture:{base:fixture.base,bytes:fixture.bytes,documents:fixture.documents.length},initialLoad,finalLoad:loadavg(),before,after:await diagnostics(),diagnosticsScope:"Per instance; these counters are not fleet totals",coldState:"Not asserted: initial requests do not prove a cold function",runs},null,2));
console.log(JSON.stringify({output,passing:runs.filter(x=>x.exitCode===0).length,total:runs.length}));
if(runs.some(x=>x.exitCode!==0))process.exitCode=1;
