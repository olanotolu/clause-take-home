import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import scalar from "@scalar/fastify-api-reference";
import { jsonSchemaTransform, serializerCompiler, validatorCompiler, hasZodFastifySchemaValidationErrors, type ZodTypeProvider } from "@fastify/type-provider-zod";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { createSqliteStore } from "./store/sqlite.ts";
import type { Store } from "./store/types.ts";
import type { App } from "./types.ts";
import { toHttp, type DomainError } from "./errors.ts";
import { registerCheckRoutes } from "./routes/check.ts";
import { registerDocumentRoutes } from "./routes/documents.ts";
import { registerRequirementRoutes } from "./routes/requirements.ts";
import { registerActivityRoutes } from "./routes/activity.ts";
import { registerPlaybookRoutes } from "./routes/playbooks.ts";
import { registerRequestRoutes } from "./routes/requests.ts";
import { registerSettingsRoutes } from "./routes/settings.ts";
import { registerTemplateRoutes } from "./routes/templates.ts";
import { registerSearchRoutes } from "./routes/search.ts";
import { registerSuggestRoutes } from "./routes/suggest.ts";
import { noSemanticEvaluator } from "./review/runner.ts";
import { buildVersion } from "./config.ts";
import { registerIntegrationRoutes } from "./routes/integrations.ts";
import { IntegrationError } from "./integrations/service.ts";
import type { SemanticEvaluator } from "./review/types.ts";
import type { EditSuggestionProvider } from "./suggest.ts";
import { start } from "workflow/api";
import { jobsWorkflow } from "../workflows/jobs.ts";
import { registerJobRoutes } from "./routes/jobs.ts";
import { flushTelemetryBounded, initTelemetry, instrumentStore, recordRoute, recordWebVital } from "./telemetry.ts";

/** Large enough for the 10 MB+ documents the service is designed for. Oversized bodies get a 413. */
export const BODY_LIMIT = 50 * 1024 * 1024;

export interface AppOptions {
  /** Storage backend. Closed when the app closes. */
  store?: Store;
  aiTimeoutMs?: number;
  /** Convenience: a SQLite path (or ":memory:"). Ignored when `store` is supplied. */
  dbPath?: string;
  logger?: boolean;
  bodyLimit?: number;
  /** Behind a proxy (Vercel) the client IP comes from X-Forwarded-For; never trust that header when directly exposed. */
  trustProxy?: boolean;
  /** Per-IP cap on /suggest, the only route that spends money. Per instance (in memory), so it is a brake, not a quota. */
  suggestRateLimit?: { max: number; timeWindow: string };
  /** Judges for `semantic` requirements and goals. Omit and those answer UNAVAILABLE; exact requirements still run. */
  semanticEvaluator?: SemanticEvaluator;
  /** Per-IP cap on /changes/check (semantic checks cost money). */
  checkRateLimit?: { max: number; timeWindow: string };
  /** Creating or copying documents; bounds how fast anyone can fill a shared database. */
  createRateLimit?: { max: number; timeWindow: string };
  /** Source of AI edit proposals. Omit to disable /suggest (503). The rest of the API never depends on it. */
  suggestionProvider?: EditSuggestionProvider;
  /** Test seam for the durable job provider. Production uses the Workflow SDK. */
  startJobWorkflow?: (jobId:string)=>Promise<unknown>;
  startExportWorkflow?: (args:{jobId:string;documentId:string;fromVersion:number;toVersion:number})=>Promise<unknown>;
}

declare module "fastify" {
  interface FastifyInstance {
    store: Store;
    startJobWorkflow: (jobId:string)=>Promise<unknown>;
    startExportWorkflow: (args:{jobId:string;documentId:string;fromVersion:number;toVersion:number})=>Promise<unknown>;
  }
  interface FastifyReply {
    problem(error: DomainError): FastifyReply;
  }
}

export async function buildApp(opts: AppOptions = {}): Promise<FastifyInstance> {
  initTelemetry();
  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: opts.bodyLimit ?? BODY_LIMIT,
    trustProxy: opts.trustProxy ?? false,
    // Ids are at most 100 characters, so anything longer is a bad request like any other. Fastify's own answer to an
    // over-long path parameter is a 414 whose `code` is a string, which breaks this API's { error, code: number } contract.
    routerOptions: { maxParamLength: 1024 },
    frameworkErrors: (error, _req, res) => {
      const reply = res as import("fastify").FastifyReply;
      if (error.code === "FST_ERR_MAX_PARAM_LENGTH") return reply.code(400).send({ error: "A path parameter is too long", code: 400, type: "VALIDATION_ERROR" });
      return reply.send(error);
    },
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Fastify rejects an empty body that arrives with "content-type: application/json", which is what a copied
  // `curl -X DELETE -H 'content-type: application/json'` sends. Treat it as "no body": routes that need one still
  // fail validation (400), and malformed JSON keeps the stock parser's checks, including prototype-poisoning.
  const jsonParser = app.getDefaultJsonParser("error", "error");
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    if (body === "") return done(null, undefined);
    return jsonParser(req, body as string, done);
  });

  const store = instrumentStore(opts.store ?? createSqliteStore(opts.dbPath ?? ":memory:"));
  app.decorate("store", store);
  app.decorate("startJobWorkflow",opts.startJobWorkflow ?? ((jobId)=>start(jobsWorkflow,[jobId])));
  app.decorate("startExportWorkflow",opts.startExportWorkflow ?? ((args)=>app.startJobWorkflow(args.jobId)));
  registerJobRoutes(app.withTypeProvider<ZodTypeProvider>());
  app.addHook("onClose", async () => {
    await store.close();
  });

  const requestStarted = new WeakMap<object, number>();
  app.addHook("onRequest", async (req) => { requestStarted.set(req, performance.now()); });
  app.addHook("onSend",async(req,reply,payload)=>{const started=requestStarted.get(req);if(started!==undefined)reply.header("server-timing",`clause;dur=${(performance.now()-started).toFixed(2)}`);return payload;});
  app.addHook("onResponse", async (req, reply) => {
    const started = requestStarted.get(req);
    if (started !== undefined) recordRoute({ method: req.method, route: req.routeOptions.url ?? "unmatched", status: reply.statusCode, durationMs: performance.now() - started });
    if (process.env.VERCEL) {
      const { waitUntil } = await import("@vercel/functions");
      waitUntil(flushTelemetryBounded());
    }
  });

  app.decorateReply("problem", function (this: import("fastify").FastifyReply, error: DomainError) {
    const { status, ...body } = toHttp(error);
    return this.code(status).send({ ...body, code: status });
  });

  // Every non-2xx has the same shape: { error, code, type, details? }. No stack traces, no document text.
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof IntegrationError) return reply.code(err.status).send({ error: err.message, code: err.status, type: err.code });
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.code(400).send({
        error: "Request validation failed",
        code: 400,
        type: "VALIDATION_ERROR",
        details: { issues: err.validation.map((v) => ({ path: v.instancePath, message: v.message })) },
      });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status === 429) return reply.code(429).send({ error: "Too many requests; slow down and try again later", code: 429, type: "RATE_LIMITED" });
    if (status === 413) return reply.code(413).send({ error: `Request body exceeds ${BODY_LIMIT} bytes`, code: 413, type: "PAYLOAD_TOO_LARGE" });
    if (status >= 400 && status < 500) return reply.code(status).send({ error: err instanceof Error ? err.message : "Bad request", code: status, type: "BAD_REQUEST" });
    const candidate=typeof err==="object"&&err!==null&&"code" in err?err.code:undefined;
    const errorCode=typeof candidate==="string"&&/^[0-9A-Z]{5}$/.test(candidate)?candidate:"INTERNAL";
    const failure={event:"clause.request.failure",method:req.method,route:req.routeOptions.url??"unmatched",errorCode};
    if(process.env.VERCEL)console.error(JSON.stringify(failure));
    else req.log.error(failure,"unhandled error");
    return reply.code(500).send({ error: "Internal server error", code: 500, type: "INTERNAL" });
  });

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "Route not found", code: 404, type: "ROUTE_NOT_FOUND" }));

  await app.register(swagger, {
    openapi: { info: { title: "CLAUSE API", version: "0.1.0", description: "Versioned document editing and search. Offsets are UTF-16 code units." } },
    transform: jsonSchemaTransform,
    // 204/304 have no body on the wire; z.null() would otherwise make the spec claim a JSON `null` body.
    transformObject: (doc) => {
      const spec = ("openapiObject" in doc ? doc.openapiObject : doc) as { paths?: Record<string, Record<string, { responses?: Record<string, { content?: unknown }> }>> };
      for (const methods of Object.values(spec.paths ?? {})) {
        for (const op of Object.values(methods)) {
          for (const code of ["204", "304"]) if (op.responses?.[code]) delete op.responses[code].content;
        }
      }
      const exp = (spec.paths?.["/documents/{id}/export.docx"] as { get?: { responses?: Record<string, unknown> } } | undefined)?.get;
      if (exp?.responses) {
        exp.responses["200"] = {
          description: "A .docx whose differences are native Word tracked changes.",
          content: { "application/vnd.openxmlformats-officedocument.wordprocessingml.document": { schema: { type: "string", format: "binary" } } },
        };
      }
      return spec as never;
    },
  });
  // The reference lives at /docs/ (its assets are relative). Scalar's own redirect from /docs is absolute ("/docs/"),
  // which drops the /api prefix behind the Vercel rewrite and the Vite proxy and lands on the web app instead. A relative
  // redirect resolves against the URL the browser actually used: /api/docs -> /api/docs/, and /docs -> /docs/ locally.
  app.addHook("onRequest", async (req, reply) => {
    if (req.method === "GET" && req.url.split("?")[0] === "/docs") return reply.redirect("docs/", 301);
  });
  await app.register(scalar, { routePrefix: "/docs" });
  app.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());
  app.get("/health", { schema: { hide: true } }, async () => ({ status: "ok" }));
  app.get("/ready", { schema: { hide: true } }, async (_req, reply) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([store.checkReady(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("readiness timeout")),2000);})]);
      return { status: "ready" };
    }
    catch { return reply.code(503).send({ status: "not_ready" }); }
    finally { if(timer) clearTimeout(timer); }
  });
  app.post("/telemetry/vitals", { schema:{hide:true,body:z.strictObject({name:z.enum(["CLS","INP","LCP"]),value:z.number().finite().min(0).max(120_000)})} }, async (req,reply)=>{
    const body=req.body as {name:"CLS"|"INP"|"LCP";value:number};
    recordWebVital(body.name,body.value);
    return reply.code(204).send(null);
  });

  // global:false: nothing is limited unless a route opts in: document create/copy and template create, Clause CI checks
  // (document and request), and suggestions. Limits are per process, not per tenant.
  await app.register(rateLimit, { global: false });

  const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as App;
  const createLimit = opts.createRateLimit ?? { max: Number(process.env.CLAUSE_CREATE_PER_HOUR ?? 60), timeWindow: "1 hour" };
  registerDocumentRoutes(typed, createLimit);
  registerSearchRoutes(typed);
  registerRequirementRoutes(typed);
  const checkLimit = opts.checkRateLimit ?? { max: 60, timeWindow: "1 hour" };
  const suggestLimit = opts.suggestRateLimit ?? { max: 20, timeWindow: "1 hour" };
  const semantic = opts.semanticEvaluator ?? noSemanticEvaluator;
  registerCheckRoutes(typed, semantic, checkLimit, opts.aiTimeoutMs);
  registerSuggestRoutes(typed, opts.suggestionProvider, suggestLimit, semantic, opts.aiTimeoutMs);
  registerRequestRoutes(typed, semantic, checkLimit);
  registerPlaybookRoutes(typed);
  registerActivityRoutes(typed);
  registerTemplateRoutes(typed, createLimit);
  registerIntegrationRoutes(typed);
  registerSettingsRoutes(typed, { semantic, suggestionsEnabled: opts.suggestionProvider !== undefined, suggestionModel: opts.suggestionProvider?.model ?? null, checkPerHour: checkLimit.max, suggestPerHour: suggestLimit.max, version: buildVersion(process.env) });
  return app;
}
