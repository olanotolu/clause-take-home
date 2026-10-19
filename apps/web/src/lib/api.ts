import type { Target } from "@clause/engine";
import { put as uploadBlob } from "@vercel/blob/client";
import { wrap, type Remote } from "comlink";

export interface TemplateProvenance { templateId: string; title: string; source: string; attribution: string; sourceUrl: string; sourceVersion: string; license: string; jurisdictionNote: string }
export interface Doc { id: string; title: string; content: string; version: number; contentHash: string; createdAt: string; updatedAt: string; byteLength?: number; utf16Length?: number; wordCount?: number; templateProvenance?: TemplateProvenance; sample?: boolean }
export interface DocSummary { id: string; title: string; version: number; size: number; updatedAt: string; sample?: boolean }
export interface Applied { index: number; start: number; end: number; before: string; after: string; newStart: number; newEnd: number }
export interface Segment { text: string; match: boolean }
export interface Hit { snippet: Segment[]; start?: number; end?: number; target?: Target }
export interface DocResult { documentId: string; title: string; version: number; relevance: number; matchCount?: number; hits: Hit[] }
export interface SearchPage { query: string; mode: "words" | "exact"; total: number; results: DocResult[] }
export interface Candidate { start: number; end: number; context: string }
export interface ApiError { error: string; code: number; type: string; details?: { candidates?: Candidate[]; currentVersion?: number; matchCount?: number; index?: number } }
export interface Preview { version: number; wouldChange: boolean; applied: Applied[]; afterHash: string }
export interface Receipt { revertedTo?: number; id: string; content?: string; contentUrl?: string; previousVersion: number; version: number; changed: boolean; beforeHash: string; afterHash: string; applied: Applied[] }
type WireApplied=Omit<Applied,"before"|"after"> & {before?:string;after?:string};
type WireReceipt=Omit<Receipt,"applied"> & {applied:WireApplied[]};
type WirePreview=Omit<Preview,"applied"> & {applied:WireApplied[]};
const hydrateSpans=(spans:WireApplied[],changes:Change[],base?:string):Applied[]=>spans.map(span=>({...span,before:span.before??base?.slice(span.start,span.end)??"",after:span.after??changes[span.index]?.replacement??""}));
export interface Revision { version: number; contentHash: string; createdAt: string; summary: { before?: string; after?: string; created?: boolean; revertedTo?: number }[] }
export interface SuggestResponse {
  status: "proposal";
  applied: false;
  provider: "live" | "fixture";
  model: string;
  documentVersion: number;
  rationale: string;
  changes: Change[];
  ci?: CiReport | null;
  validation: { valid: true; applied: Applied[]; diff?: string } | { valid: false; error: { type: string; error: string; details?: ApiError["details"] } };
}
export type RequirementKind = "present" | "absent" | "unchanged" | "semantic";
export interface Requirement { id: string; documentId: string; kind: RequirementKind; text: string; createdAt: string }
export type Verdict = "PASS" | "FAIL" | "NEEDS_REVIEW" | "UNAVAILABLE";
export type Delta = "held" | "regressed" | "achieved" | "still_failing" | "uncertain";
export interface Evidence { start: number; end: number; quote: string; verified: boolean }
export interface JudgeDetail { id: string; label: string; probability?: number; decisionConfidence?: number; rationale?: string }
export interface CheckOutcome { verdict: Verdict; detail: string; evidence: Evidence[]; judges?: JudgeDetail[] }
export interface RequirementReport { id: string; kind: RequirementKind | "goal"; text: string; before: CheckOutcome; after: CheckOutcome; delta: Delta; method: "exact" | "model"; answeredBy: string[]; touchedBy: number[] }
export interface CiReport {
  documentId: string;
  version: number;
  mechanical: { valid: true; wouldChange: boolean; changes: number };
  requirements: RequirementReport[];
  summary: { held: number; regressed: number; achieved: number; still_failing: number; uncertain: number };
  judges: string[];
  elapsedMs: number;
}
export interface SettingsStatus {
  version: string;
  storage: "sqlite" | "postgres";
  access: "open";
  ai: { judges: string[]; suggestions: boolean; suggestionModel: string | null; strictnessOptions: ("balanced" | "strict")[]; jevMode: "off" | "shadow" | "pilot"; externalProviderNotice: string | null };
  limits: { maxDocumentChars: number | null; maxJudgedChars: number; maxRequirementsPerDocument: number; checkPerHour: number; suggestPerHour: number };
}
export type RequestStatus = "inbox" | "in_progress" | "needs_review" | "completed";
export type Priority = "low" | "medium" | "high";
export type RequestType = "NDA" | "Commercial" | "Employment" | "Data & Privacy" | "Other";
export const REQUEST_STATUSES: readonly RequestStatus[] = ["inbox", "in_progress", "needs_review", "completed"];
export const REQUEST_TYPES: readonly RequestType[] = ["NDA", "Commercial", "Employment", "Data & Privacy", "Other"];
export const PRIORITIES: readonly Priority[] = ["low", "medium", "high"];
export interface CiSnapshot {
  version: number;
  checkedAt: string;
  total: number;
  holding: number;
  attention: number;
  judges: string[];
  goal?: Verdict;
  requirements: { text: string; kind: RequirementKind; verdict: Verdict }[];
}
export interface WorkRequest {
  id: string;
  documentId: string | null;
  title: string;
  goal: string;
  status: RequestStatus;
  priority: Priority;
  type: RequestType;
  dueDate: string | null;
  ci: CiSnapshot | null;
  createdAt: string;
  updatedAt: string;
}
export interface RequestCreate { documentId?: string; title: string; goal: string; status?: RequestStatus; priority?: Priority; type?: RequestType; dueDate?: string | null }
export type RequestPatch = Partial<Pick<WorkRequest, "title" | "goal" | "status" | "priority" | "type" | "dueDate">>;
export interface PlaybookRule { id: string; playbookId: string; title: string; kind: RequirementKind; text: string; createdAt: string }
export interface Playbook { id: string; name: string; description: string; createdAt: string; updatedAt: string }
export interface PlaybookSummary extends Playbook { ruleCount: number }
export interface PlaybookDetail extends Playbook { rules: PlaybookRule[] }
export interface ApplyResult { added: Requirement[]; skipped: { title: string; reason: "duplicate" | "limit" }[] }
export interface ActivityItem { documentId: string; title: string; version: number; contentHash: string; createdAt: string; summary: Revision["summary"] }
export type TemplateCategory = "NDA" | "Commercial" | "Data & Privacy" | "Vendor & Services" | "Employment";
export interface TemplateVariable { id: string; label: string; required: boolean; placeholder: string; helpText: string }
export interface TemplateSuggestion { id: string; title: string; kind: RequirementKind; text: string }
export interface Template { id: string; title: string; description: string; category: TemplateCategory; size: number; source: string; attribution: string; sourceUrl: string; sourceVersion: string; license: string; jurisdictionNote: string; featured: boolean; variables: TemplateVariable[]; suggestedRequirements: TemplateSuggestion[] }
export interface TemplateFull extends Omit<Template, "size"> { content: string }
export interface Change { operation: "replace"; target: Target; replacement: string }

export type Res<T> = { ok: true; data: T } | { ok: false; status: number; error: ApiError };

export type RepositoryId="imanage"|"netdocuments"|"onedrive"|"dropbox"|"google_drive"|"sharepoint"|"box";
export interface Repository {id:RepositoryId;name:string;description:string;connected:boolean;accountName:string|null;connectedAt:string|null}
export interface RepositoryFile {id:string;name:string;mimeType:string;folder:boolean;parentId?:string;driveId?:string;imported?:boolean}
interface ImportResult {imported:boolean;document:{id:string;title:string;version:number}}
interface QueuedImport {jobId:string;status:string;statusUrl:string}

export const repositories={
  list:(token:string)=>call<{providers:Repository[]}>("GET","/integrations",undefined,{authorization:`Bearer ${token}`}),
  connect:(id:RepositoryId,token:string)=>call<{url:string}>("POST",`/integrations/${id}/connect`,undefined,{authorization:`Bearer ${token}`}),
  disconnect:(id:RepositoryId,token:string)=>call<void>("DELETE",`/integrations/${id}`,undefined,{authorization:`Bearer ${token}`}),
  files:(id:RepositoryId,token:string,query:URLSearchParams)=>call<{files:RepositoryFile[];nextPageToken:string|null}>("GET",`/integrations/${id}/files?${query}`,undefined,{authorization:`Bearer ${token}`}),
};

export async function importRepositoryFile(id:RepositoryId,file:RepositoryFile,token:string,options:{signal:AbortSignal;onProgress:(progress:number)=>void}):Promise<Res<ImportResult>> {
  const response=await call<ImportResult|QueuedImport>("POST",`/integrations/${id}/import`,{file},{authorization:`Bearer ${token}`},options.signal);
  if(!response.ok) return response;
  if("document" in response.data) return {ok:true,data:response.data};
  const {jobId,statusUrl}=response.data;
  const abort=()=>{void call("POST",`/jobs/${jobId}/cancel`,undefined,{authorization:`Bearer ${token}`});};
  options.signal.addEventListener("abort",abort,{once:true});
  try {
    while(!options.signal.aborted) {
      const job=await call<{status:string;progress:number;errorCode?:string;output?:{kind:"provider_import"}&ImportResult}>("GET",statusUrl,undefined,{authorization:`Bearer ${token}`},options.signal);
      if(!job.ok) return job;
      options.onProgress(job.data.progress);
      if(job.data.status==="succeeded"&&job.data.output) return {ok:true,data:job.data.output};
      if(job.data.status==="failed"||job.data.status==="cancelled") return {ok:false,status:422,error:{type:job.data.errorCode??"IMPORT_CANCELLED",code:422,error:"The import could not be completed. Try again."}};
      await new Promise<void>((resolve)=>{const done=()=>{clearTimeout(timer);options.signal.removeEventListener("abort",done);resolve();};const timer=setTimeout(done,1000);options.signal.addEventListener("abort",done,{once:true});});
    }
    abort();
    return {ok:false,status:0,error:{type:"IMPORT_CANCELLED",code:0,error:"Import cancelled."}};
  } finally {options.signal.removeEventListener("abort",abort);}
}
type WireDoc = Omit<Doc, "content"> & { content?: string; contentUrl?: string };
interface ContentWorkerApi {
  initialize(id:string,version:number,content:string,expectedHash?:string):Promise<string>;
  hydrate(id:string,version:number,spans:WireApplied[],changes:Change[]):Promise<Applied[]|null>;
  propose(id:string,version:number,changes:Change[]):Promise<{ok:true;content:string;changed:boolean;applied:Applied[];hash:string}|{ok:false;error:string}>;
  apply(id:string,previousVersion:number,version:number,spans:Applied[],expectedHash:string):Promise<{ok:true;content:string;hash:string}|{ok:false;reason:string;actual?:string}>;
  metrics(id:string,version:number):Promise<{version:number;wordCount:number;byteLength:number;utf16Length:number}|null>;
  wordDelta(id:string,version:number,start:number,end:number,replacement:string):Promise<{added:number;removed:number}|null>;
  measure(content:string):Promise<{byteLength:number;utf16Length:number;wordCount:number;hash:string}>;
  occurrences(id:string,version:number,start:number,end:number):Promise<{version:number;count:number}|null>;
  discard(id:string):void;
}
let worker: Remote<ContentWorkerApi> | undefined;
export function documentWorker(): Remote<ContentWorkerApi> {
  if (!worker) worker = wrap<ContentWorkerApi>(new Worker(new URL("./content-worker.ts", import.meta.url), { type:"module", name:"clause-document-worker" }));
  return worker;
}

const CONTENT_CACHE_BYTES = 64 * 1024 * 1024;
let contentCacheBytes = 0;
const contentCache = new Map<string,{content:string;bytes:number}>();
function cacheKey(id:string,version:number,hash:string) { return `${id}:${version}:${hash}`; }
function cachedContent(key:string) {
  const item=contentCache.get(key);
  if(!item) return undefined;
  contentCache.delete(key); contentCache.set(key,item);
  return item.content;
}
function cacheContent(key:string,content:string) {
  const bytes=new TextEncoder().encode(content).byteLength;
  const old=contentCache.get(key); if(old) contentCacheBytes-=old.bytes;
  if(bytes>CONTENT_CACHE_BYTES) return;
  contentCache.delete(key); contentCache.set(key,{content,bytes}); contentCacheBytes+=bytes;
  while(contentCacheBytes>CONTENT_CACHE_BYTES) {
    const oldest=contentCache.keys().next().value as string|undefined;
    if(!oldest) break;
    contentCacheBytes-=contentCache.get(oldest)!.bytes; contentCache.delete(oldest);
  }
}
export function rememberDocument(id:string,version:number,hash:string,content:string) {
  cacheContent(cacheKey(id,version,hash),content);
  void documentWorker().initialize(id,version,content);
}
async function mapOk<A, B>(result: Res<A>, map: (value: A) => B | Promise<B>): Promise<Res<B>> {
  return result.ok ? { ok: true, data: await map(result.data) } : result;
}

async function call<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, signal?:AbortSignal): Promise<Res<T>> {
  try {
    const res = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
      body: body === undefined ? null : JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    if (res.status === 204) return { ok: true, data: undefined as T };
    const json = await res.json();
    return res.ok ? { ok: true, data: json as T } : { ok: false, status: res.status, error: json as ApiError };
  } catch {
    return { ok: false, status: 0, error: { error: "Cannot reach the API. Is it running on :3000?", code: 0, type: "NETWORK" } };
  }
}

async function resolveDoc(doc: WireDoc, knownContent?: string, signal?:AbortSignal): Promise<Doc> {
  const key=cacheKey(doc.id,doc.version,doc.contentHash);
  if (doc.content !== undefined) { cacheContent(key,doc.content); await documentWorker().initialize(doc.id,doc.version,doc.content,doc.contentHash); return { ...doc, content: doc.content }; }
  if (knownContent !== undefined) { cacheContent(key,knownContent); await documentWorker().initialize(doc.id,doc.version,knownContent,doc.contentHash); return { ...doc, content: knownContent }; }
  const cached=cachedContent(key);
  if(cached!==undefined) { await documentWorker().initialize(doc.id,doc.version,cached,doc.contentHash); return { ...doc, content:cached }; }
  if (!doc.contentUrl) throw new Error("The API returned no document content URL");
  const url=doc.contentUrl.startsWith("/") ? `/api${doc.contentUrl}` : doc.contentUrl;
  const contentRes = await fetch(url, signal ? { signal } : {});
  if (!contentRes.ok) throw new Error("Could not download document content");
  const content=await contentRes.text();
  if((await documentWorker().initialize(doc.id,doc.version,content,doc.contentHash))!==doc.contentHash) throw new Error("Downloaded document failed integrity verification");
  cacheContent(key,content);
  return { ...doc, content };
}

async function uploadText(content:string,scope:{operation:"create"}|{operation:"revision"|"preview";documentId:string;expectedVersion:number}) {
  const encoded=new TextEncoder().encode(content);
  const result=await call<{intent:string;pathname:string;clientToken?:string;uploadUrl?:string}>("POST","/documents/uploads/intents",{size:encoded.byteLength,...scope});
  if(!result.ok)return result;
  const intent=result.data;
  if(intent.clientToken)await uploadBlob(intent.pathname,new Blob([encoded],{type:"text/plain"}),{access:"private",token:intent.clientToken,contentType:"text/plain",multipart:true});
  else {
    const response=await fetch(`/api${intent.uploadUrl}?intent=${encodeURIComponent(intent.intent)}`,{method:"POST",headers:{"content-type":"text/plain; charset=utf-8"},body:encoded});
    if(!response.ok)return {ok:false as const,status:response.status,error:await response.json() as ApiError};
  }
  const digest=await crypto.subtle.digest("SHA-256",encoded);
  const hash=[...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,"0")).join("");
  return {ok:true as const,data:{intent:intent.intent,sha256:hash}};
}

export async function receiptContent(receipt:Receipt):Promise<string|undefined> {
  if(receipt.content!==undefined)return receipt.content;
  if(!receipt.contentUrl)return undefined;
  try {
    const response=await fetch(receipt.contentUrl.startsWith("/")?`/api${receipt.contentUrl}`:receipt.contentUrl);
    if(!response.ok)return undefined;
    const content=await response.text();
    if((await documentWorker().measure(content)).hash!==receipt.afterHash)return undefined;
    return content;
  } catch {return undefined;}
}

async function createLargeDocument(title: string, content: string): Promise<Res<Doc>> {
  try {
    const uploaded=await uploadText(content,{operation:"create"});if(!uploaded.ok)return uploaded;
    const complete=await call<WireDoc>("POST","/documents/uploads/complete",{...uploaded.data,title});
    return complete.ok ? { ok: true, data: await resolveDoc(complete.data, content) } : complete;
  } catch {
    return { ok: false, status: 0, error: { error: "Document upload failed. Try again.", code: 0, type: "UPLOAD_FAILED" } };
  }
}

export const api = {
  list: () => call<{ items: DocSummary[]; total: number }>("GET", "/documents?limit=100"),
  get: async (id: string, signal?:AbortSignal) => mapOk(await call<WireDoc>("GET", `/documents/${id}`, undefined, {}, signal), (doc) => resolveDoc(doc,undefined,signal)),
  create: async (title: string, content: string) => new TextEncoder().encode(content).byteLength > 1024 * 1024 ? createLargeDocument(title, content) : call<Doc>("POST", "/documents", { title, content }),
  copy: async (id: string, title?: string) => mapOk(await call<WireDoc>("POST", `/documents/${encodeURIComponent(id)}/copy`, title ? { title } : {}), (doc) => resolveDoc(doc)),
  revisions: (id: string) => call<{ items: Revision[] }>("GET", `/documents/${id}/revisions`),
  search: (q: string, mode: string) => call<SearchPage>("GET", `/documents/search?q=${encodeURIComponent(q)}&mode=${mode}&limit=20`),
  preview: async(id:string,expectedVersion:number,changes:Change[],signal?:AbortSignal,base?:string):Promise<Res<Preview>>=>{
    if(new TextEncoder().encode(JSON.stringify({changes})).byteLength>1024*1024) {
      const metadata=await call<WireDoc>("GET",`/documents/${id}`,undefined,{prefer:"return=minimal"},signal);
      if(!metadata.ok)return metadata;
      if(metadata.data.version!==expectedVersion)return {ok:false,status:409,error:{code:409,type:"VERSION_CONFLICT",error:"This document changed. Reload before reviewing the replacement.",details:{currentVersion:metadata.data.version}}};
      const result=await documentWorker().propose(id,expectedVersion,changes);
      return result.ok?{ok:true,data:{version:expectedVersion,wouldChange:result.changed,applied:result.applied,afterHash:result.hash}}:{ok:false,status:422,error:{code:422,type:"INVALID_REPLACEMENT",error:result.error}};
    }
    return mapOk(await call<WirePreview>("POST",`/documents/${id}/changes/preview`,{expectedVersion,changes},{prefer:"return=minimal"},signal),result=>({...result,applied:hydrateSpans(result.applied,changes,base)}));
  },
  revert: async(id:string,expectedVersion:number,toVersion:number):Promise<Res<Receipt>>=>mapOk(await call<WireReceipt>("POST",`/documents/${id}/revert`,{toVersion,expectedVersion},{prefer:"return=minimal"}),result=>({...result,applied:hydrateSpans(result.applied,[])})),
  requirements: (id: string) => call<{ items: Requirement[]; max: number }>("GET", `/documents/${id}/requirements`),
  addRequirement: (id: string, kind: RequirementKind, text: string) => call<Requirement>("POST", `/documents/${id}/requirements`, { kind, text }),
  deleteRequirement: (id: string, rid: string) => call<undefined>("DELETE", `/documents/${id}/requirements/${rid}`),
  check: async(id:string,expectedVersion:number,changes:Change[],goal?:string,strictness?:"balanced"|"strict"):Promise<Res<CiReport>>=>{
    const common={expectedVersion,...(goal?{goal}:{}),...(strictness==="strict"?{strictness}:{})};
    if(new TextEncoder().encode(JSON.stringify({changes})).byteLength>1024*1024) {
      try {
        const proposed=await documentWorker().propose(id,expectedVersion,changes);
        if(!proposed.ok)return {ok:false,status:422,error:{code:422,type:"INVALID_REPLACEMENT",error:proposed.error}};
        const uploaded=await uploadText(proposed.content,{operation:"preview",documentId:id,expectedVersion});if(!uploaded.ok)return uploaded;
        return call<CiReport>("POST",`/documents/${id}/changes/check`,{...common,changes:[],uploadedContent:uploaded.data});
      } catch{return {ok:false,status:0,error:{code:0,type:"UPLOAD_FAILED",error:"Preview upload failed. Try again."}};}
    }
    return call<CiReport>("POST",`/documents/${id}/changes/check`,{...common,changes});
  },
  requests: () => call<{ items: WorkRequest[] }>("GET", "/requests"),
  createRequest: (b: RequestCreate) => call<WorkRequest>("POST", "/requests", b),
  patchRequest: (id: string, b: RequestPatch) => call<WorkRequest>("PATCH", `/requests/${id}`, b),
  deleteRequest: (id: string) => call<undefined>("DELETE", `/requests/${id}`),
  checkRequest: (id: string) => call<{ request: WorkRequest; moved: boolean }>("POST", `/requests/${id}/check`),
  playbooks: () => call<{ items: PlaybookSummary[] }>("GET", "/playbooks"),
  playbook: (id: string) => call<PlaybookDetail>("GET", `/playbooks/${id}`),
  createPlaybook: (name: string, description: string) => call<Playbook>("POST", "/playbooks", { name, description }),
  patchPlaybook: (id: string, b: { name?: string; description?: string }) => call<Playbook>("PATCH", `/playbooks/${id}`, b),
  deletePlaybook: (id: string) => call<undefined>("DELETE", `/playbooks/${id}`),
  addRule: (id: string, b: { title: string; kind: RequirementKind; text: string }) => call<PlaybookRule>("POST", `/playbooks/${id}/rules`, b),
  deleteRule: (id: string, rid: string) => call<undefined>("DELETE", `/playbooks/${id}/rules/${rid}`),
  applyPlaybook: (docId: string, playbookId: string) => call<ApplyResult>("POST", `/documents/${docId}/apply-playbook`, { playbookId }),
  activity: (limit = 60) => call<{ items: ActivityItem[] }>("GET", `/activity?limit=${limit}`),
  template: (id: string) => call<TemplateFull>("GET", `/templates/${encodeURIComponent(id)}`),
  templates: () => call<{ items: Template[] }>("GET", "/templates"),
  createFromTemplate: (id: string, values: Record<string, string>, selectedRequirementIds: string[], title?: string) =>
    call<{ document: Doc; attachedRequirements: Requirement[]; attachmentError?: string }>("POST", `/templates/${encodeURIComponent(id)}/create`, { values, selectedRequirementIds, ...(title ? { title } : {}) }),
  settingsStatus: () => call<SettingsStatus>("GET", "/settings/status"),
  suggest: async(id:string,instruction:string):Promise<Res<SuggestResponse>>=>{
    const result=await call<SuggestResponse>("POST",`/documents/${id}/suggest`,{instruction});
    if(!result.ok||!result.data.validation.valid)return result;
    const applied=await documentWorker().hydrate(id,result.data.documentVersion,result.data.validation.applied,result.data.changes);
    if(!applied)return {ok:false,status:409,error:{code:409,type:"VERSION_CONFLICT",error:"Reload the document before reviewing this proposal."}};
    return {ok:true,data:{...result.data,validation:{...result.data.validation,applied}}};
  },
  apply: async(id:string,expectedVersion:number,changes:Change[],base?:string):Promise<Res<Receipt>>=>{
    if(new TextEncoder().encode(JSON.stringify({changes})).byteLength>1024*1024) {
      try {
        const proposed=await documentWorker().propose(id,expectedVersion,changes);
        if(!proposed.ok)return {ok:false,status:422,error:{code:422,type:"INVALID_REPLACEMENT",error:proposed.error}};
        const upload=await uploadText(proposed.content,{operation:"revision",documentId:id,expectedVersion});if(!upload.ok)return upload;
        return mapOk(await call<WireReceipt>("POST","/documents/uploads/complete",upload.data,{prefer:"return=minimal"}),result=>({...result,applied:hydrateSpans(result.applied,changes,base),...(result.afterHash===proposed.hash?{content:proposed.content}:{})}));
      } catch {return {ok:false,status:0,error:{code:0,type:"UPLOAD_FAILED",error:"Document upload failed. Try again."}};}
    }
    return mapOk(await call<WireReceipt>("PATCH",`/documents/${id}`,{expectedVersion,changes},{prefer:"return=minimal"}),result=>({...result,applied:hydrateSpans(result.applied,changes,base)}));
  },
};
