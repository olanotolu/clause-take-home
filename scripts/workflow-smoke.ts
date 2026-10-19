import { spawn } from "node:child_process";
import { mkdtemp, open, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

const directory=await mkdtemp(join(tmpdir(),"clause-workflow-smoke-"));
const port=await new Promise<number>((resolvePort,reject)=>{const server=createServer();server.once("error",reject);server.listen(0,"127.0.0.1",()=>{const address=server.address();if(!address||typeof address==="string")return reject(new Error("No test port"));server.close(()=>resolvePort(address.port));});});
const base=`http://127.0.0.1:${port}`,log=await open(join(directory,"server.log"),"w");
const child=spawn(process.execPath,[".output/server/index.mjs"],{cwd:resolve("apps/api"),env:{...process.env,VERCEL:"",NODE_ENV:"production",PORT:String(port),HOST:"127.0.0.1",CLAUSE_STORAGE:"sqlite",CLAUSE_DB:join(directory,"jobs.db"),CLAUSE_CONTENT_DIR:join(directory,"content"),WORKFLOW_LOCAL_DATA_DIR:join(directory,"workflow"),WORKFLOW_LOCAL_BASE_URL:base,BLOB_READ_WRITE_TOKEN:"",OPENROUTER_API_KEY:"",AI_GATEWAY_API_KEY:""},stdio:["ignore",log.fd,log.fd]});
async function request(method:string,path:string,body?:unknown) {
  const response=await fetch(base+path,{method,headers:{"content-type":"application/json",Prefer:"return=minimal"},...(body===undefined?{}:{body:JSON.stringify(body)})});
  if(!response.ok)throw new Error(`Local Workflow verification: ${method} failed (${response.status})`);return response.json();
}
try {
  const readyDeadline=Date.now()+30000;
  while(Date.now()<readyDeadline){try{if((await fetch(base+"/health")).ok)break;}catch{}await new Promise<void>(done=>setTimeout(done,100));}
  await request("GET","/ready");
  const body="CLAUSE_LOAD_A\n"+"Confidentiality clause. ".repeat(60000),hash=createHash("sha256").update(body).digest("hex");
  const intent=await request("POST","/documents/uploads/intents",{size:Buffer.byteLength(body)});
  if((await fetch(`${base}${intent.uploadUrl}?intent=${encodeURIComponent(intent.intent)}`,{method:"POST",headers:{"content-type":"text/plain"},body})).status!==204)throw new Error("Local upload failed");
  const doc=await request("POST","/documents/uploads/complete",{intent:intent.intent,title:"Local Workflow fixture",sha256:hash});
  await request("PATCH",`/documents/${doc.id}`,{expectedVersion:1,changes:[{operation:"replace",target:{position:{start:0,end:13,expectedText:"CLAUSE_LOAD_A"}},replacement:"CLAUSE_LOAD_B"}]});
  const response=await fetch(`${base}/documents/${doc.id}/export.docx?from=1&to=2`);if(response.status!==202)throw new Error("Large export was not queued");
  const queued=await response.json();const deadline=Date.now()+60000;let complete=false;
  while(Date.now()<deadline){const job=await request("GET",queued.statusUrl);if(job.status==="failed")throw new Error(`Local export failed: ${job.errorCode}`);if(job.status==="succeeded"){const file=await fetch(base+job.downloadUrl);if(Buffer.from(await file.arrayBuffer()).subarray(0,2).toString()!=="PK")throw new Error("Invalid Word archive");complete=true;break;}await new Promise<void>(done=>setTimeout(done,200));}
  if(!complete)throw new Error("Local export did not complete");
  console.log(JSON.stringify({node:process.version,sqlite:true,localStorage:true,workflow:true,exportWorker:true,wordArchive:true}));
} finally {
  child.kill("SIGTERM");await new Promise<void>(done=>{const timeout=setTimeout(()=>{child.kill("SIGKILL");done();},5000);child.once("exit",()=>{clearTimeout(timeout);done();});});
  await log.close();await rm(directory,{recursive:true,force:true});
}
