import swagger from "@fastify/swagger";
import scalar from "@scalar/fastify-api-reference";
import { jsonSchemaTransform, serializerCompiler, validatorCompiler, hasZodFastifySchemaValidationErrors, type ZodTypeProvider } from "@fastify/type-provider-zod";
import Fastify, { type FastifyInstance } from "fastify";
import type { Db } from "./db.ts";
import type { App } from "./types.ts";
import { openDb } from "./db.ts";
import { toHttp, type DomainError } from "./errors.ts";
import { registerDocumentRoutes } from "./routes/documents.ts";
import { registerSearchRoutes } from "./routes/search.ts";
import { registerSuggestRoutes } from "./routes/suggest.ts";
import type { EditSuggestionProvider } from "./suggest.ts";

/** Large enough for the 10 MB+ documents the service is designed for. Oversized bodies get a 413. */
export const BODY_LIMIT = 50 * 1024 * 1024;

export interface AppOptions {
  /** SQLite path, or ":memory:". Ignored when `db` is supplied. */
  dbPath?: string;
  db?: Db;
  logger?: boolean;
  bodyLimit?: number;
  /** Source of AI edit proposals. Omit to disable /suggest (503). The rest of the API never depends on it. */
  suggestionProvider?: EditSuggestionProvider;
}

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
  }
  interface FastifyReply {
    problem(error: DomainError): FastifyReply;
  }
}

export async function buildApp(opts: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: opts.bodyLimit ?? BODY_LIMIT });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const db = opts.db ?? openDb(opts.dbPath ?? ":memory:");
  app.decorate("db", db);
  app.addHook("onClose", async () => {
    if (!opts.db) db.close();
  });

  app.decorateReply("problem", function (this: import("fastify").FastifyReply, error: DomainError) {
    const { status, ...body } = toHttp(error);
    return this.code(status).send({ ...body, code: status });
  });

  // Every non-2xx has the same shape: { error, code, type, details? }. No stack traces, no document text.
  app.setErrorHandler((err, req, reply) => {
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.code(400).send({
        error: "Request validation failed",
        code: 400,
        type: "VALIDATION_ERROR",
        details: { issues: err.validation.map((v) => ({ path: v.instancePath, message: v.message })) },
      });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status === 413) return reply.code(413).send({ error: `Request body exceeds ${BODY_LIMIT} bytes`, code: 413, type: "PAYLOAD_TOO_LARGE" });
    if (status >= 400 && status < 500) return reply.code(status).send({ error: err instanceof Error ? err.message : "Bad request", code: status, type: "BAD_REQUEST" });
    req.log.error({ err }, "unhandled error");
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
      return spec as never;
    },
  });
  await app.register(scalar, { routePrefix: "/docs" });
  app.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());
  app.get("/health", { schema: { hide: true } }, async () => ({ status: "ok" }));

  const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as App;
  registerDocumentRoutes(typed);
  registerSearchRoutes(typed);
  registerSuggestRoutes(typed, opts.suggestionProvider);
  return app;
}
