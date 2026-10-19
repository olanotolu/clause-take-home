import { execFileSync, spawn } from "node:child_process";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { arch, loadavg, platform } from "node:os";
import { join, resolve } from "node:path";

const [beforeFile,afterFile,outputArg="bench/performance/results/paired-local"]=process.argv.slice(2);
if(!beforeFile||!afterFile)throw new Error("Usage: node bench/performance/run-paired-local.ts BEFORE_FIXTURES AFTER_FIXTURES [OUTPUT_DIR]");
const output=resolve(outputArg);
await mkdir(output,{recursive:true});
const fixtureFiles={before:resolve(beforeFile),after:resolve(afterFile)};
const fixtures={before:JSON.parse(await readFile(beforeFile,"utf8")),after:JSON.parse(await readFile(afterFile,"utf8"))} as const;
for(const [revision,fixture] of Object.entries(fixtures)) {
  const url=new URL(fixture.base);
  if(!["127.0.0.1","localhost"].includes(url.hostname))throw new Error(`${revision} fixture must target a local disposable server`);
  if(fixture.bytes!==400000||fixture.documents.length!==32)throw new Error(`${revision} fixture must be the matched 32-document, 400000-byte corpus`);
}
if(fixtures.before.bytes!==fixtures.after.bytes||fixtures.before.documents.length!==fixtures.after.documents.length)throw new Error("Before and after fixtures must have matching size and count");
const initialLoad=loadavg();
const runs:Array<{revision:"before"|"after";scenario:"metadata"|"search"|"edit";phase:"warmup"|"paired-local";writeAttemptLimit:number;exitCode:number|null}>=[];
async function run(revision:"before"|"after",scenario:"metadata"|"search"|"edit",phase:"warmup"|"paired-local",iterations:number) {
  const name=`${revision}-${scenario}-${phase}`;
  const log=await open(join(output,`${name}.log`),"w");
  try {
    const env={...process.env,CLAUSE_FIXTURE_FILE:fixtureFiles[revision],CLAUSE_VUS:"8",CLAUSE_SCENARIO:scenario,CLAUSE_PHASE:phase,CLAUSE_DURATION:phase==="warmup"?"5s":"15s",CLAUSE_WRITE_ITERATIONS:String(iterations),CLAUSE_ALLOW_WRITES:"1",CLAUSE_RESULT_FILE:join(output,`${name}.json`)};
    const child=spawn("k6",["run","--quiet",join(import.meta.dirname,"k6.js")],{env,stdio:["ignore",log.fd,log.fd]});
    const exitCode=await new Promise<number|null>((resolveExit,reject)=>{child.once("error",reject);child.once("exit",resolveExit);});
    runs.push({revision,scenario,phase,writeAttemptLimit:iterations,exitCode});
    console.log(JSON.stringify(runs.at(-1)));
  } finally {await log.close();}
}
// Warm the same endpoint on both revisions immediately before collecting each paired set.
for(const scenario of ["metadata","search","edit"] as const) for(const revision of ["before","after"] as const) {
  await run(revision,scenario,"warmup",scenario==="edit"?10:100);
  await run(revision,scenario,"paired-local",100);
}
const manifest={generatedAt:new Date().toISOString(),node:process.version,postgresVersion:"PostgreSQL 16.14",baselineCommit:"15da2be",updatedBaseCommit:execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim(),updatedCode:"working tree changes atop updatedBaseCommit",platform:platform(),arch:arch(),initialLoad,finalLoad:loadavg(),clients:8,warmupSeconds:5,durationSeconds:15,databaseIsolation:"separate databases on the same disposable PostgreSQL 16 instance",fixtures:{bytes:400000,documents:32,baseline:fixtures.before.base,updated:fixtures.after.base},writeAttemptLimit:100,scenarios:["metadata","search","edit"],coldState:"local processes; per-scenario warmup; no cold-instance claim",runs};
await writeFile(join(output,"environment.json"),JSON.stringify(manifest,null,2)+"\n");
if(runs.some((run)=>run.exitCode!==0))process.exitCode=1;
