import type { Counter, Histogram } from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { randomUUID } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";

let initialized = false;
const instanceId=randomUUID();
const instanceStartedAt=new Date().toISOString();
const diagnostics={queryCount:0,queryErrors:0,queryDurationMs:0,acquireCount:0,acquireDurationMs:0};
export function runtimeDiagnostics() {return {instanceId,instanceStartedAt,uptimeSeconds:process.uptime(),region:process.env.VERCEL_REGION??null,...diagnostics,memory:process.memoryUsage(),eventLoopDelayMs:(loopDelay?.mean??0)/1e6};}
let provider: MeterProvider | undefined;
let routeDuration: Histogram | undefined;
let routeRequests: Counter | undefined;
let dbDuration: Histogram | undefined;
let dbErrors: Counter | undefined;
let dbQueries: Counter | undefined;
let aiCalls: Counter | undefined;
let aiErrors: Counter | undefined;
let aiDuration: Histogram | undefined;
let aiInputTokens: Counter | undefined;
let aiOutputTokens: Counter | undefined;
let aiCost: Counter | undefined;
let jevShadowComparisons: Counter | undefined;
let blobDuration: Histogram | undefined;
let blobBytes: Counter | undefined;
let acquireDuration: Histogram | undefined;
let sqlDuration: Histogram | undefined;
let sqlCalls: Counter | undefined;
let sqlErrors: Counter | undefined;
let queueAge: Histogram | undefined;
let webVitals: Histogram | undefined;
let loopDelay: ReturnType<typeof monitorEventLoopDelay> | undefined;
type ObservedPool={kind:string;waitingCount:number;totalCount:number;idleCount:number;lockWaits?:()=>Promise<number>};
const pools = new Set<ObservedPool>();

/** Parses the OpenTelemetry OTLP header list without ever logging credential values. */
export function parseOtlpHeaders(raw: string | undefined): Record<string,string> | undefined {
  if(!raw?.trim()) return undefined;
  const headers:Record<string,string>={};
  const seenNames=new Set<string>();
  for(const item of raw.split(",")) {
    const equals=item.indexOf("=");
    if(equals<1) throw new Error("Invalid OTLP header configuration");
    let name:string,value:string;
    try { name=decodeURIComponent(item.slice(0,equals).trim());value=decodeURIComponent(item.slice(equals+1).trim()); }
    catch { throw new Error("Invalid OTLP header encoding"); }
    const normalizedName=name.toLowerCase();
    if(!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)||!value||/[\r\n]/.test(value)||seenNames.has(normalizedName)) throw new Error("Invalid OTLP header configuration");
    seenNames.add(normalizedName);
    headers[name]=value;
  }
  return headers;
}

export function initTelemetry(env: Record<string, string | undefined> = process.env): void {
  if (initialized) return;
  initialized = true;
  const endpoint = env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ?? env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return;
  const url = env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ?? `${endpoint.replace(/\/$/, "")}/v1/metrics`;
  const headers=parseOtlpHeaders(env.OTEL_EXPORTER_OTLP_HEADERS);
  const reader = new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter({ url, ...(headers?{headers}:{}) }), exportIntervalMillis: Number(env.OTEL_METRIC_EXPORT_INTERVAL_MS ?? 60000), exportTimeoutMillis: 5000 });
  provider = new MeterProvider({ readers: [reader] });
  const meter = provider.getMeter("clause.api", "1.0.0");
  routeDuration = meter.createHistogram("clause.http.server.duration", { unit: "ms" });
  routeRequests = meter.createCounter("clause.http.server.requests");
  dbDuration = meter.createHistogram("clause.database.operation.duration", { unit: "ms" });
  dbErrors = meter.createCounter("clause.database.operation.errors");
  dbQueries = meter.createCounter("clause.database.operation.calls");
  aiCalls = meter.createCounter("clause.ai.calls");
  aiErrors = meter.createCounter("clause.ai.errors");
  aiDuration = meter.createHistogram("clause.ai.duration",{unit:"ms"});
  aiInputTokens = meter.createCounter("clause.ai.input_tokens", { unit: "{token}" });
  aiOutputTokens = meter.createCounter("clause.ai.output_tokens", { unit: "{token}" });
  aiCost = meter.createCounter("clause.ai.estimated_cost", { unit: "USD" });
  jevShadowComparisons = meter.createCounter("clause.ai.jev.shadow.comparisons");
  blobDuration = meter.createHistogram("clause.blob.operation.duration", { unit: "ms" });
  blobBytes = meter.createCounter("clause.blob.bytes", { unit: "By" });
  acquireDuration=meter.createHistogram("clause.database.pool.acquire.duration",{unit:"ms"});
  sqlDuration=meter.createHistogram("clause.database.query.duration",{unit:"ms"});
  sqlCalls=meter.createCounter("clause.database.query.calls");
  sqlErrors=meter.createCounter("clause.database.query.errors");
  queueAge=meter.createHistogram("clause.jobs.queue.age",{unit:"s"});
  webVitals = meter.createHistogram("clause.web.vital", { unit: "ms" });
  const poolWait=meter.createObservableGauge("clause.database.pool.waiting",{unit:"{connection}"});
  const poolOpen=meter.createObservableGauge("clause.database.pool.open",{unit:"{connection}"});
  const poolIdle=meter.createObservableGauge("clause.database.pool.idle",{unit:"{connection}"});
  const locks=meter.createObservableGauge("clause.database.lock.waiting",{unit:"{connection}"});
  meter.addBatchObservableCallback(async(result)=>{
    for(const pool of pools) {
      const labels={"db.system":pool.kind};
      result.observe(poolWait,pool.waitingCount,labels);
      result.observe(poolOpen,pool.totalCount,labels);
      result.observe(poolIdle,pool.idleCount,labels);
      if(pool.lockWaits) result.observe(locks,await pool.lockWaits().catch(()=>0),labels);
    }
  },[poolWait,poolOpen,poolIdle,locks]);
  loopDelay=monitorEventLoopDelay({resolution:20}); loopDelay.enable();
  const loop=meter.createObservableGauge("clause.node.event_loop.delay",{unit:"ms"});
  const heap=meter.createObservableGauge("clause.node.memory.heap_used",{unit:"By"});
  meter.addBatchObservableCallback((result)=>{
    result.observe(loop,(loopDelay?.mean ?? 0)/1e6);
    result.observe(heap,process.memoryUsage().heapUsed);
  },[loop,heap]);
}

export function registerPool(pool:ObservedPool):()=>void { pools.add(pool); return ()=>{pools.delete(pool);}; }
export function recordDatabaseAcquire(ms:number,failed:boolean):void { diagnostics.acquireCount++;diagnostics.acquireDurationMs+=ms;acquireDuration?.record(ms,{error:failed}); }
export function recordDatabaseQuery(operation:string,ms:number,failed:boolean):void { diagnostics.queryCount++;diagnostics.queryDurationMs+=ms;if(failed)diagnostics.queryErrors++;const attrs={"db.operation.name":operation};sqlDuration?.record(ms,attrs);sqlCalls?.add(1,attrs);if(failed) sqlErrors?.add(1,attrs); }
export function recordJobQueueAge(kind:string,createdAt:string):void { queueAge?.record(Math.max(0,(Date.now()-Date.parse(createdAt))/1000),{"clause.job.kind":kind}); }
export async function shutdownTelemetryBounded(timeoutMs=1000):Promise<void> {
  if(!provider) return;
  const current=provider;provider=undefined;loopDelay?.disable();pools.clear();
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {await Promise.race([current.shutdown().catch(()=>undefined),new Promise<void>((resolve)=>{timer=setTimeout(resolve,timeoutMs);})]);}
  finally {if(timer) clearTimeout(timer);}
}

export function recordRoute(args: { method: string; route: string; status: number; durationMs: number }): void {
  const attrs = { "http.request.method": args.method, "http.route": args.route, "http.response.status_class": `${Math.floor(args.status / 100)}xx` };
  routeRequests?.add(1, attrs);
  routeDuration?.record(args.durationMs, attrs);
}

export function recordDb(kind: string, operation: string, durationMs: number, failed: boolean): void {
  const attrs = { "db.system": kind, "db.operation.name": operation };
  dbQueries?.add(1,attrs);
  dbDuration?.record(durationMs, attrs);
  if (failed) dbErrors?.add(1, attrs);
}

export function recordAi(model: string, usage?: { inputTokens: number; outputTokens: number }, costUsd?: number, failed=false, durationMs?:number): void {
  const attrs = { "gen_ai.request.model": model };
  aiCalls?.add(1, attrs);
  if(failed) aiErrors?.add(1,attrs);
  if(durationMs!==undefined) aiDuration?.record(durationMs,attrs);
  if (usage) {
    aiInputTokens?.add(usage.inputTokens, attrs);
    aiOutputTokens?.add(usage.outputTokens, attrs);
  }
  if (costUsd !== undefined && Number.isFinite(costUsd)) aiCost?.add(costUsd, attrs);
}

export function recordAiError(model:string,durationMs?:number):void {
  const attrs={"gen_ai.request.model":model};
  aiErrors?.add(1,attrs);
  if(durationMs!==undefined) aiDuration?.record(durationMs,attrs);
}

/** Aggregate only fixed verdict/label values; never attach document text, user or document identifiers. */
export function recordJevShadowComparison(baseline: string, jevLabel: string | undefined): void {
  const allowedBaseline = ["PASS", "FAIL", "NEEDS_REVIEW", "UNAVAILABLE"].includes(baseline) ? baseline : "UNAVAILABLE";
  const allowedLabel = ["entailed", "contradicted", "not_mentioned", "unclear"].includes(jevLabel ?? "") ? jevLabel! : "unavailable";
  const mapped = allowedLabel === "entailed" ? "PASS" : allowedLabel === "unclear" || allowedLabel === "unavailable" ? "NEEDS_REVIEW" : "FAIL";
  jevShadowComparisons?.add(1, { "clause.ai.baseline_verdict": allowedBaseline, "clause.ai.jev_label": allowedLabel, "clause.ai.verdict_match": String(allowedBaseline === mapped) });
}

export function recordBlob(operation:string,durationMs:number,bytes:number,failed=false):void {
  const labels={"clause.blob.operation":operation,"error":failed};
  blobDuration?.record(durationMs,labels);
  if(!failed && bytes>0) blobBytes?.add(bytes,labels);
}

export function recordWebVital(name:"CLS"|"INP"|"LCP",value:number):void {
  if(Number.isFinite(value) && value>=0) webVitals?.record(value,{"web.vital.name":name});
}

export async function flushTelemetryBounded(timeoutMs=1000):Promise<void> {
  if(!provider) return;
  let timer:ReturnType<typeof setTimeout>|undefined;
  try { await Promise.race([provider.forceFlush().catch(()=>undefined),new Promise<void>((resolve)=>{timer=setTimeout(resolve,timeoutMs);})]); }
  finally { if(timer) clearTimeout(timer); }
}

export function instrumentStore<T extends { kind: string }>(store: T): T {
  return new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function" || property === "close") return value;
      return async (...args: unknown[]) => {
        const start = performance.now();
        let failed = false;
        try { return await Reflect.apply(value, target, args); }
        catch (error) { failed = true; throw error; }
        finally { recordDb(target.kind, String(property), performance.now() - start, failed); }
      };
    },
  });
}
