import { z } from "zod";
import type { App } from "../types.ts";
import { errors } from "../schemas.ts";
import type { IntegrationProvider } from "../store/types.ts";
import { authenticateAdmin, authorizationUrl, browseFiles, extractText, finishOAuth, IntegrationError, listProviders, OAUTH_COOKIE_MAX_AGE_S, type RemoteFile } from "../integrations/service.ts";
import { providerConfig } from "../integrations/providers.ts";

const Provider = z.enum(["imanage", "netdocuments", "onedrive", "dropbox", "google_drive", "sharepoint", "box"]);
const Query = z.object({ parentId: z.string().optional(), driveId: z.string().optional(), pageToken: z.string().optional() });
const ImportBody = z.object({ file: z.object({ id: z.string().min(1), name: z.string().min(1), mimeType: z.string(), folder: z.boolean().optional(), parentId: z.string().optional(), driveId: z.string().optional() }) });
const auth = async (authorization?: string) => authenticateAdmin(authorization);

const cookieName = (provider: string) => `clause_oauth_${provider}`;
/** Only the nonce for this provider's flow is read from the Cookie header; nothing else is trusted or parsed. */
function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=") || undefined;
  }
  return undefined;
}
function bindingCookie(provider: IntegrationProvider, value: string, maxAge: number): string {
  const secure = providerConfig(provider).redirectUri.startsWith("https://") ? "; Secure" : "";
  return `${cookieName(provider)}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

export function registerIntegrationRoutes(app: App): void {
  app.get("/integrations", { schema: { response: { 200: z.object({ providers: z.array(z.object({ id: Provider, name: z.string(), description: z.string(), configured: z.boolean(), connected: z.boolean(), accountName: z.string().nullable(), connectedAt: z.string().nullable() })) }), ...errors(401, 403, 500) } } }, async (req) => {
    await auth(req.headers.authorization);
    return { providers: await listProviders(app.store) };
  });

  app.post("/integrations/:provider/connect", { schema: { params: z.object({ provider: Provider }), response: { 200: z.object({ url: z.string() }), ...errors(401, 403, 500, 503) } } }, async (req, reply) => {
    const user = await auth(req.headers.authorization);
    const { url, binding } = authorizationUrl(req.params.provider, user);
    reply.header("set-cookie", bindingCookie(req.params.provider, binding, OAUTH_COOKIE_MAX_AGE_S));
    return { url };
  });

  app.get("/integrations/:provider/callback", { schema: { params: z.object({ provider: Provider }), querystring: z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() }), response: errors(500) } }, async (req, reply) => {
    // This is a browser navigation from the provider, so failures go back to the Integrations page rather than to a
    // raw JSON body. The one-time binding cookie is cleared whatever the outcome.
    const provider = req.params.provider;
    const binding = readCookie(req.headers.cookie, cookieName(provider));
    reply.header("set-cookie", bindingCookie(provider, "", 0));
    const back = (query: string) => reply.redirect(`/#/integrations?${query}`);
    if (req.query.error) return back(`error=${encodeURIComponent(req.query.error)}`);
    try {
      if (!req.query.code || !req.query.state) throw new IntegrationError(400, "OAUTH_CALLBACK_INVALID", "The provider did not return a complete authorization response.");
      await finishOAuth(app.store, provider, req.query.code, req.query.state, binding);
    } catch (error) {
      if (error instanceof IntegrationError) return back(`error=${encodeURIComponent(error.message)}&code=${encodeURIComponent(error.code)}`);
      throw error;
    }
    return back(`connected=${encodeURIComponent(provider)}`);
  });

  app.get("/integrations/:provider/files", { schema: { params: z.object({ provider: Provider }), querystring: Query, response: { 200: z.object({ files: z.array(z.object({ id: z.string(), name: z.string(), mimeType: z.string(), folder: z.boolean(), parentId: z.string().optional(), driveId: z.string().optional(), imported: z.boolean() })), nextPageToken: z.string().nullable() }), ...errors(401, 403, 409, 502) } } }, async (req) => {
    await auth(req.headers.authorization);
    const page = await browseFiles(app.store, req.params.provider, req.query.parentId, req.query.driveId, req.query.pageToken);
    const files = await Promise.all(page.files.map(async (file) => ({ ...file, imported: Boolean(await app.store.getIntegrationImport(req.params.provider, file.id)) })));
    return { ...page, files };
  });

  app.post("/integrations/:provider/import", { schema: { params: z.object({ provider: Provider }), body: ImportBody, response: { 200: z.object({ imported: z.boolean(), document: z.object({ id: z.string(), title: z.string(), version: z.number() }) }), 201: z.object({ imported: z.boolean(), document: z.object({ id: z.string(), title: z.string(), version: z.number() }) }), ...errors(401, 403, 409, 413, 415, 502) } } }, async (req, reply) => {
    await auth(req.headers.authorization);
    const file = req.body.file as RemoteFile;
    if (file.folder) throw new IntegrationError(400, "FOLDER_NOT_IMPORTABLE", "Choose a document file to import.");
    const prior = await app.store.getIntegrationImport(req.params.provider, file.id);
    if (prior) {
      const existing = await app.store.getDocument(prior.documentId);
      if (existing) return reply.code(200).send({ imported: false, document: { id: existing.id, title: existing.title, version: existing.version } });
    }
    const content = await extractText(app.store, req.params.provider, file);
    if (!content.trim()) throw new IntegrationError(415, "EMPTY_DOCUMENT", "No readable text was found in this file.");
    if (content.length > app.store.maxContentChars) throw new IntegrationError(413, "DOCUMENT_TOO_LARGE", `This file exceeds the ${app.store.maxContentChars.toLocaleString()} character document limit.`);
    const result = await app.store.insertImportedDocument({ title: file.name, content, provider: req.params.provider, fileId: file.id });
    return reply.code(result.imported ? 201 : 200).send({ imported: result.imported, document: { id: result.doc.id, title: result.doc.title, version: result.doc.version } });
  });

  app.delete("/integrations/:provider", { schema: { params: z.object({ provider: Provider }), response: { 204: z.null(), ...errors(401, 403, 500) } } }, async (req, reply) => {
    await auth(req.headers.authorization);
    await app.store.deleteIntegrationConnection(req.params.provider as IntegrationProvider);
    return reply.code(204).send(null);
  });
}
