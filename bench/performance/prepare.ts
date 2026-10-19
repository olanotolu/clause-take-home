import { createRequire } from "node:module";
import { sha256 } from "../../packages/core/src/index.ts";
import { writeFile, readFile } from "node:fs/promises";
const [operation="prepare",base,output="/tmp/clause-load-fixtures.json"]=process.argv.slice(2);
if(!base)throw new Error("Usage: prepare.ts prepare|cleanup API_BASE FIXTURE_FILE");
const apiBase=base.replace(/\/$/,"");
const bypass=process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
const headers={"content-type":"application/json",Prefer:"return=minimal",...(bypass?{"x-vercel-protection-bypass":bypass}:{})};
async function api(method:string,path:string,body?:unknown){const r=await fetch(`${apiBase}${path}`,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})});if(!r.ok)throw new Error(`Fixture ${method} failed: ${r.status}`);return r.status===204?undefined:await r.json();}
if(operation==="cleanup") {
  const fixture=JSON.parse(await readFile(output,"utf8"));if(fixture.base!==base)throw new Error("Fixture deployment does not match cleanup URL");
  for(const doc of fixture.documents){const meta=await api("GET",`/documents/${doc.id}`);if(!meta.title.startsWith("CLAUSE loadfixture "))throw new Error("Refusing to delete a document not created by this benchmark");await api("DELETE",`/documents/${doc.id}`);}
  console.log(JSON.stringify({deleted:fixture.documents.length}));
} else {
  const bytes=Number(process.env.CLAUSE_FIXTURE_BYTES??1048576),count=Number(process.env.CLAUSE_FIXTURE_COUNT??32);
  if(!Number.isInteger(bytes)||bytes<100||bytes>25*1048576||count<1||count>32)throw new Error("Invalid fixture bounds");
  const prefix="CLAUSE_LOAD_A\n",paragraph="Each party shall protect confidentiality and personal data. ".repeat(64)+"\n";
  const left=bytes-prefix.length;const content=prefix+paragraph.repeat(Math.floor(left/paragraph.length))+"x".repeat(left%paragraph.length);
  const documents=[];
  const require=createRequire(new URL("../../apps/api/package.json",import.meta.url));
  const {put}=await import(require.resolve("@vercel/blob/client"));
  for(let i=0;i<count;i++){
    const title=`CLAUSE loadfixture ${bytes} ${i}`;let doc:{id:string};
    if(bytes<=1048576)doc=await api("POST","/documents",{title,content});
    else {
      const intent=await api("POST","/documents/uploads/intents",{size:bytes});
      if(intent.clientToken)await put(intent.pathname,content,{access:"private",token:intent.clientToken,contentType:"text/plain",multipart:true});
      else {const r=await fetch(`${base}${intent.uploadUrl}?intent=${encodeURIComponent(intent.intent)}`,{method:"POST",headers:{...headers,"content-type":"text/plain"},body:content});if(!r.ok)throw new Error(`Direct fixture upload failed: ${r.status}`);}
      doc=await api("POST","/documents/uploads/complete",{intent:intent.intent,title,sha256:sha256(content)});
    }
    documents.push({id:doc.id});
    await writeFile(output,JSON.stringify({base,bytes,documents},null,2),{mode:0o600});
  }
  console.log(JSON.stringify({fixtureFile:output,bytes,documents:documents.length}));
}
