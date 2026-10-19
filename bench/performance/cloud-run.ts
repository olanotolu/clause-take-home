import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base=process.env.CLAUSE_BENCH_BASE;
if(!base||!/^https:\/\/[a-z0-9-]+\.vercel\.app\/api$/.test(base))throw new Error("Configure an isolated preview API for this manual cloud benchmark");
const directory=await mkdtemp(join(tmpdir(),"clause-cloud-load-")),fixture=join(directory,"fixtures.json"),results=join(directory,"results");
await mkdir(results,{recursive:true});
const archive=await fetch("https://github.com/grafana/k6/releases/download/v2.3.0/k6-v2.3.0-linux-amd64.tar.gz");
if(!archive.ok)throw new Error("Could not download pinned k6");
const bytes=Buffer.from(await archive.arrayBuffer());
if(createHash("sha256").update(bytes).digest("hex")!=="39c3117b6af817592dcd0ce4242105c0a7af10948c2a425306f0be8f7a8a8ab1")throw new Error("k6 checksum mismatch");
const archivePath=join(directory,"k6.tar.gz");await writeFile(archivePath,bytes);
const env={...process.env,VERCEL_AUTOMATION_BYPASS_SECRET:process.env.CLAUSE_BENCH_BYPASS??"",CLAUSE_OPERATIONS_TOKEN:process.env.CLAUSE_BENCH_OPERATIONS_TOKEN??process.env.CLAUSE_OPERATIONS_TOKEN??"",CLAUSE_FIXTURE_FILE:fixture,CLAUSE_RESULTS_DIR:results,CLAUSE_FIXTURE_COUNT:"32",CLAUSE_FIXTURE_BYTES:"1048576",CLAUSE_DURATION:"15s",PATH:`${join(directory,"k6-v2.3.0-linux-amd64")}:${process.env.PATH??""}`};
async function run(command:string,args:string[],overrides:NodeJS.ProcessEnv={}) {const child=spawn(command,args,{env:{...env,...overrides},stdio:"inherit"});return await new Promise<number|null>((done,reject)=>{child.once("exit",done);child.once("error",reject);});}
if(await run("tar",["-xzf",archivePath,"-C",directory])!==0)throw new Error("Could not unpack k6");
let exitCode:number|null=null,error:string|undefined;
const transferErrors:unknown[]=[];
try {
  if(process.env.CLAUSE_BENCH_MATRIX!=="0") {
    if(await run(process.execPath,["bench/performance/prepare.ts","prepare",base,fixture])!==0)throw new Error("Cloud fixture preparation failed");
    exitCode=await run(process.execPath,["bench/performance/run-hosted.ts"]);
  }
  if(process.env.CLAUSE_BENCH_LARGE_READS==="1") {
    for(const size of [10*1048576,25*1048576]) {
      const inventory=join(directory,`large-${size}.json`),result=join(results,`large-read-${size/1048576}mib.json`);
      const overrides={CLAUSE_FIXTURE_BYTES:String(size),CLAUSE_FIXTURE_COUNT:"1"};
      let failure:unknown,cleanupFailed=false;
      try {
        const prepared=await run(process.execPath,["bench/performance/prepare.ts","prepare",base,inventory],overrides);
        if(prepared!==0)throw new Error(`Cloud ${size}-byte fixture preparation failed`);
        const status=await run(process.execPath,["bench/performance/verify-large-reads.ts",inventory,result,"5"]);
        if(status!==0)throw new Error(`Cloud ${size}-byte read verification failed`);
      } catch(cause) {
        failure=cause;
      } finally {
        if(await access(inventory).then(()=>true,()=>false))cleanupFailed=await run(process.execPath,["bench/performance/prepare.ts","cleanup",base,inventory],overrides)!==0;
      }
      if(cleanupFailed)throw new Error(`Cloud ${size}-byte fixture cleanup failed`);
      if(failure)throw failure;
    }
  }
} catch(cause) {error=cause instanceof Error?cause.message:"Cloud benchmark failed";}
const files:Record<string,unknown>={};
try {for(const file of await readdir(results))if(file.endsWith(".json"))files[file]=JSON.parse(await readFile(join(results,file),"utf8"));}catch{}
const report={generatedAt:new Date().toISOString(),generator:"Vercel build",generatorRegion:process.env.CLAUSE_BENCH_GENERATOR_REGION??process.env.VERCEL_REGION??"unverified",node:process.version,k6:"2.3.0",exitCode,error,files};
const payload=JSON.stringify({encoding:"gzip-base64",data:gzipSync(JSON.stringify(report)).toString("base64")});
const headers={"content-type":"application/json",...(env.VERCEL_AUTOMATION_BYPASS_SECRET?{"x-vercel-protection-bypass":env.VERCEL_AUTOMATION_BYPASS_SECRET}:{})};
try {
  const response=await fetch(base+"/documents",{method:"POST",headers,body:JSON.stringify({title:"CLAUSE loadfixture cloud benchmark report",content:payload})});
  if(!response.ok)throw new Error(`Cloud artifact transfer failed (${response.status})`);
  const document=await response.json();console.log(`CLAUSE_CLOUD_REPORT=${document.id}`);
} catch(cause) {transferErrors.push(cause);}
try {
  if(await access(fixture).then(()=>true,()=>false)) {
    const cleaned=await run(process.execPath,["bench/performance/prepare.ts","cleanup",base,fixture]);
    if(cleaned!==0)throw new Error("Cloud fixture cleanup failed; recover using the build fixture inventory");
  }
} catch(cause) {transferErrors.push(cause);}
if(transferErrors.length)throw new AggregateError(transferErrors,"Cloud artifact transfer or fixture cleanup failed");
await rm(directory,{recursive:true,force:true});
console.log(JSON.stringify({cloudBenchmarkFinished:true,performanceGate:exitCode===0,error}));
