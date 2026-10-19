import { createRequire } from "node:module";
import { copyFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

// Use Nitro's own bundler version, keeping the API and worker builds on the same toolchain.
const require=createRequire(import.meta.resolve("nitro"));
const {rolldown}=await import(require.resolve("rolldown"));
const targets:string[]=[];
if(existsSync(".output/server")) targets.push(".output/server/heavy-worker.mjs");
function functions(directory:string):void {
  for(const item of readdirSync(directory,{withFileTypes:true})) {
    if(!item.isDirectory())continue;
    const path=join(directory,item.name);
    if(item.name.endsWith(".func"))targets.push(join(path,"heavy-worker.mjs"));
    else functions(path);
  }
}
if(existsSync(".vercel/output/functions"))functions(".vercel/output/functions");
if(!targets.length)throw new Error("Nitro produced no server output for the export worker");
const [first,...others]=targets;
const bundle=await rolldown({input:resolve("src/jobs/heavy-entry.ts"),platform:"node"});
await bundle.write({file:first!,format:"esm",codeSplitting:false});
await bundle.close();
for(const file of others)copyFileSync(first!,file);
console.log(`Packaged export worker for ${targets.length} server targets`);
