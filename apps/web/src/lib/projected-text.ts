import { orderSpans, type AppliedChange } from "@clause/engine";
export interface TextSource {readonly length:number;slice(start:number,end?:number):string}

/** A preview is a list of references to existing text; only requested evidence windows are materialized. */
export function projectText(original:string,applied:readonly AppliedChange[]):TextSource {
  const ordered=orderSpans(applied.map(x=>({index:x.index,start:x.start,end:x.end,replacement:x.after})));
  if(!ordered.ok)return original;
  const pieces:{text:string;start:number;end:number;offset:number}[]=[];
  let cursor=0,length=0;
  const add=(text:string,start:number,end:number)=>{pieces.push({text,start,end,offset:length});length+=end-start;};
  for(const change of ordered.value){if(change.start<cursor||change.end>original.length)return original;add(original,cursor,change.start);add(change.replacement,0,change.replacement.length);cursor=change.end;}
  add(original,cursor,original.length);
  return {length,slice(start,end=length){
    const from=Math.min(length,start<0?Math.max(0,length+start):start),to=Math.min(length,end<0?Math.max(0,length+end):end);
    if(to<=from)return "";
    return pieces.flatMap(piece=>{const low=Math.max(from,piece.offset),high=Math.min(to,piece.offset+piece.end-piece.start);return high>low?[piece.text.slice(piece.start+low-piece.offset,piece.start+high-piece.offset)]:[];}).join("");
  }};
}
