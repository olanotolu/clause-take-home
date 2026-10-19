import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { sha256 } from "../../packages/core/src/index.ts";
import { DocumentOut, ReceiptOut, PreviewOut, SearchPageOut } from "../../apps/api/src/schemas.ts";

const [inventory,output="/tmp/clause-large-verification.json"]=process.argv.slice(2);
if(!inventory)throw new Error("Supply an inventory from prepare.ts containing only disposable fixtures");
const fixture=JSON.parse(await readFile(inventory,"utf8"));
const headers={"content-type":"application/json",Prefer:"return=minimal",...(process.env.VERCEL_AUTOMATION_BYPASS_SECRET?{"x-vercel-protection-bypass":process.env.VERCEL_AUTOMATION_BYPASS_SECRET}:{})};
const measurements:{operation:string;ms:number;responseBytes:number;status:number}[]=[];
async function request(method:string,path:string,body?:unknown) {
  const started=performance.now(),response=await fetch(fixture.base+path,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})});
  const text=await response.text();measurements.push({operation:`${method} ${path.replace(/doc_[^/?]+/g,":document").replace(/job_[^/?]+/g,":job")}`,ms:performance.now()-started,responseBytes:Buffer.byteLength(text),status:response.status});
  if(!response.ok)throw new Error(`Verification failed: ${method} ${response.status}`);
  if(Buffer.byteLength(text)>4*1048576)throw new Error("Function response exceeds the payload budget");
  return JSON.parse(text);
}
async function content(url:string,hash:string) {
  const resolved=url.startsWith("https://")?url:fixture.base+url;
  const response=await fetch(resolved,{...(url.startsWith("https://")?{}:{headers}),redirect:"follow"});
  if(!response.ok)throw new Error(`Content download failed: ${response.status}`);
  const body=await response.text();if(sha256(body)!==hash)throw new Error("Downloaded content hash mismatch");return body;
}
const results=[];
for(const item of fixture.documents) {
  const doc=DocumentOut.parse(await request("GET",`/documents/${item.id}`));
  if(!doc.title.startsWith("CLAUSE loadfixture "))throw new Error("Verification is limited to disposable fixtures");
  if(!doc.contentUrl)throw new Error("Metadata must include an immutable download reference");
  const original=await content(doc.contentUrl,doc.contentHash);
  const marker=original.slice(0,13);if(!/^CLAUSE_LOAD_[A-Z]$/.test(marker))throw new Error("Unexpected fixture marker");
  const replacement=marker==="CLAUSE_LOAD_B"?"CLAUSE_LOAD_A":"CLAUSE_LOAD_B";
  const changes=[{operation:"replace",target:{position:{start:0,end:marker.length,expectedText:marker}},replacement}];
  const preview=PreviewOut.parse(await request("POST",`/documents/${doc.id}/changes/preview`,{expectedVersion:doc.version,changes}));
  if(!preview.wouldChange)throw new Error("Preview did not find the staged change");
  const receipt=ReceiptOut.parse(await request("PATCH",`/documents/${doc.id}`,{expectedVersion:doc.version,changes}));
  const expected=original.replace(marker,replacement);
  if(receipt.afterHash!==sha256(expected))throw new Error("Committed receipt hash mismatch");
  const matches=SearchPageOut.parse(await request("GET",`/documents/search?q=${replacement}&mode=exact&ids=${doc.id}`));
  if(matches.results[0]?.matchCount!==1)throw new Error("Exact search count mismatch");
  const reverted=ReceiptOut.parse(await request("POST",`/documents/${doc.id}/revert`,{expectedVersion:receipt.version,toVersion:doc.version}));
  if(reverted.afterHash!==doc.contentHash)throw new Error("Revert changed original bytes");
  await content(receipt.contentUrl??`/documents/${doc.id}/revisions/${receipt.version}/content`,receipt.afterHash);
  const exported=await fetch(`${fixture.base}/documents/${doc.id}/export.docx?from=${doc.version}&to=${receipt.version}`,{headers});
  let downloadUrl:string|undefined;
  if(exported.status===202) {
    const queued=await exported.json();const deadline=Date.now()+180_000;
    while(Date.now()<deadline) {
      const job=await request("GET",queued.statusUrl);
      if(job.status==="succeeded"){downloadUrl=job.downloadUrl;break;}
      if(job.status==="failed"||job.status==="cancelled")throw new Error(`Export ${job.status}: ${job.errorCode}`);
      await new Promise<void>((resolve)=>setTimeout(resolve,1000));
    }
    if(!downloadUrl)throw new Error("Export did not complete before the verification deadline");
  } else if(exported.status===200) {
    const file=Buffer.from(await exported.arrayBuffer());if(file.subarray(0,2).toString()!=="PK")throw new Error("Invalid Word export");
  } else throw new Error(`Export request failed: ${exported.status}`);
  if(downloadUrl){const response=await fetch(downloadUrl.startsWith("https://")?downloadUrl:fixture.base+downloadUrl,{...(downloadUrl.startsWith("https://")?{}:{headers})});const file=Buffer.from(await response.arrayBuffer());if(!response.ok||file.subarray(0,2).toString()!=="PK")throw new Error("Invalid asynchronous Word export");}
  const fullReplacement=original.replace(marker,marker==="CLAUSE_LOAD_C"?"CLAUSE_LOAD_D":"CLAUSE_LOAD_C");
  const intent=await request("POST","/documents/uploads/intents",{operation:"revision",documentId:doc.id,expectedVersion:reverted.version,size:Buffer.byteLength(fullReplacement)});
  if(intent.clientToken) {
    const require=createRequire(new URL("../../apps/api/package.json",import.meta.url));const {put}=await import(require.resolve("@vercel/blob/client"));
    await put(intent.pathname,fullReplacement,{access:"private",token:intent.clientToken,contentType:"text/plain",multipart:true});
  } else {
    const response=await fetch(`${fixture.base}${intent.uploadUrl}?intent=${encodeURIComponent(intent.intent)}`,{method:"POST",headers:{...headers,"content-type":"text/plain"},body:fullReplacement});if(!response.ok)throw new Error("Revision upload failed");
  }
  const replaced=ReceiptOut.parse(await request("POST","/documents/uploads/complete",{intent:intent.intent,sha256:sha256(fullReplacement)}));
  if(replaced.afterHash!==sha256(fullReplacement)||replaced.version!==reverted.version+1)throw new Error("Uploaded replacement did not commit atomically");
  await content(replaced.contentUrl??`/documents/${doc.id}/revisions/${replaced.version}/content`,replaced.afterHash);
  results.push({byteLength:Buffer.byteLength(original),utf16Length:original.length,hashVerified:true,preview:true,edit:true,search:true,revert:true,pinnedReceipt:true,wordExport:true,fullReplacementUpload:true});
}
const report={generatedAt:new Date().toISOString(),node:process.version,base:fixture.base,results,measurements};await writeFile(output,JSON.stringify(report,null,2));console.log(JSON.stringify({output,results},null,2));
