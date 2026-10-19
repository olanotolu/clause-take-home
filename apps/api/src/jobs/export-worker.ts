import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { JobCancelledError } from "./types.ts";
import type { RedlineInput } from "../docx.ts";

/** CPU work runs in a separate thread so Workflow exports do not occupy Fastify's event loop. */
export async function redlineOffThread(input:RedlineInput,isCancelled:()=>Promise<boolean>=async()=>false):Promise<Buffer> {
  const built=new URL("./heavy-worker.mjs",import.meta.url);
  const source=new URL("./heavy-entry.ts",import.meta.url);
  const fallback=resolve(process.cwd(),"src/jobs/heavy-entry.ts");
  const entry=existsSync(built)?built:existsSync(source)?source:pathToFileURL(existsSync(fallback)?fallback:resolve(process.cwd(),"apps/api/src/jobs/heavy-entry.ts"));
  return new Promise<Buffer>((resolve,reject)=>{
    const worker=new Worker(entry,{workerData:input});
    let checking=false;
    const timer=setInterval(()=>{
      if(checking) return;
      checking=true;
      void isCancelled().then((cancelled)=>{if(cancelled){void worker.terminate();reject(new JobCancelledError());}}).catch(reject).finally(()=>{checking=false;});
    },1000);
    const cleanup=()=>{clearInterval(timer);void worker.terminate();};
    worker.once("message",(result:unknown)=>{cleanup();if(result instanceof Uint8Array) resolve(Buffer.from(result));else reject(new Error("Invalid export worker result"));});
    worker.once("error",(error)=>{cleanup();reject(error);});
    worker.once("exit",(code)=>{clearInterval(timer);if(code!==0) reject(new Error("Export worker stopped"));});
  });
}
