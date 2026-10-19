import type { AppliedChange } from "@clause/core";
import { INLINE_CONTENT_BYTES } from "./content-storage.ts";

/** Leave headroom for JSON escaping, metadata and the optional inline body. */
export function boundedApplied(applied:readonly AppliedChange[]) {
  const bytes=applied.reduce((sum,item)=>sum+Buffer.byteLength(item.before)+Buffer.byteLength(item.after),0);
  if(bytes<=128*1024)return [...applied];
  return applied.map(({before:_before,after:_after,...positions})=>positions);
}
export function boundedDiff(diff:string):string|undefined {
  return Buffer.byteLength(JSON.stringify(diff))<=INLINE_CONTENT_BYTES?diff:undefined;
}
