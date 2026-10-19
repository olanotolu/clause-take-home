import { applyChanges, type Change } from "@clause/engine";
import { countWords } from "@clause/core/count-words";
import { expose } from "comlink";

interface Span { start:number; end:number; before:string; after:string; newStart:number; newEnd:number }
interface Entry { version:number; content:string; hash:string;wordCount:number;byteLength:number }
const documents = new Map<string, Entry>();
let initializationSequence=0;

const hash = async (content:string) => {
  const bytes = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2,"0")).join("");
};

const api = {
  async initialize(id:string, version:number, content:string,expectedHash?:string) {
    const token=++initializationSequence;
    const actual = await hash(content);
    if(expectedHash&&actual!==expectedHash)return actual;
    if(initializationSequence===token && (documents.get(id)?.version??0)<=version){documents.clear();documents.set(id,{version,content,hash:actual,wordCount:countWords(content),byteLength:new TextEncoder().encode(content).byteLength});}
    return actual;
  },
  hydrate(id:string,version:number,spans:(Omit<Span,"before"|"after"> & {index:number;before?:string;after?:string})[],changes:Change[]) {
    const prior=documents.get(id);if(!prior||prior.version!==version)return null;
    return spans.map(span=>({...span,before:span.before??prior.content.slice(span.start,span.end),after:span.after??changes[span.index]?.replacement??""}));
  },
  async propose(id:string,version:number,changes:Change[]) {
    const prior=documents.get(id);if(!prior||prior.version!==version)return {ok:false as const,error:"The document base is unavailable. Reload before applying this replacement."};
    const result=applyChanges(prior.content,changes);if(!result.ok)return {ok:false as const,error:result.error.type};
    return {ok:true as const,content:result.value.content,changed:result.value.changed,applied:result.value.applied,hash:await hash(result.value.content)};
  },
  async apply(id:string, previousVersion:number, version:number, spans:Span[], expectedHash:string) {
    const prior = documents.get(id);
    if (!prior || prior.version !== previousVersion) return {ok:false as const, reason:"base-unavailable" as const};
    let output = prior.content;
    try {
      for (const span of [...spans].sort((a,b)=>b.start-a.start)) {
        if (output.slice(span.start,span.end) !== span.before) return {ok:false as const, reason:"base-mismatch" as const};
        output = output.slice(0,span.start) + span.after + output.slice(span.end);
      }
    } catch { return {ok:false as const, reason:"transform-failed" as const}; }
    const actual = await hash(output);
    if (actual !== expectedHash) return {ok:false as const, reason:"hash-mismatch" as const, actual};
    if(documents.get(id)!==prior)return {ok:false as const,reason:"superseded" as const};
    documents.set(id,{version,content:output,hash:actual,wordCount:countWords(output),byteLength:new TextEncoder().encode(output).byteLength});
    return {ok:true as const,content:output,hash:actual};
  },
  metrics(id:string,version:number) {const entry=documents.get(id);return entry?.version===version?{version,wordCount:entry.wordCount,byteLength:entry.byteLength,utf16Length:entry.content.length}:null;},
  wordDelta(id:string,version:number,start:number,end:number,replacement:string) {const entry=documents.get(id);return entry?.version===version?{added:countWords(replacement),removed:countWords(entry.content.slice(start,end))}:null;},
  async measure(content:string) {
    return {byteLength:new TextEncoder().encode(content).byteLength,utf16Length:content.length,wordCount:countWords(content),hash:await hash(content)};
  },
  async occurrences(id:string,version:number,start:number,end:number) {
    const prior=documents.get(id);if(!prior||prior.version!==version)return null;
    const content=prior.content,needle=content.slice(start,end);
    if (!needle) return {version,count:0};
    let count=0;
    for(let at=content.indexOf(needle);at!==-1;at=content.indexOf(needle,at+needle.length)) count++;
    return {version,count};
  },
  discard(id:string) { initializationSequence++;documents.delete(id); },
};

expose(api);
