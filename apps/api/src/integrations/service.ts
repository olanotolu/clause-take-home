import type { RemoteFile } from "../jobs/types.ts";
export type { RemoteFile } from "../jobs/types.ts";
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import type { IntegrationConnection, IntegrationProvider, Store } from "../store/types.ts";
import { providerById, providerConfig, PROVIDERS } from "./providers.ts";

export class IntegrationError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

const MAX_IMPORT_BYTES = 25 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;

/** A dead or slow provider must come back as a clear 5xx, not hang the function or surface as an unhandled 500. */
function networkError(error: unknown): IntegrationError {
  if (error instanceof IntegrationError) return error;
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return new IntegrationError(504, "PROVIDER_TIMEOUT", "The provider took too long to respond. Try again.");
  return new IntegrationError(502, "PROVIDER_UNREACHABLE", "Could not reach the provider. Try again.");
}

async function providerFetch(url: string, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  try { return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) }); }
  catch (error) { throw networkError(error); }
}

/** Read a provider response without buffering more than the import limit in memory. */
export async function readLimitedResponse(response: Response, limit = MAX_IMPORT_BYTES): Promise<Buffer> {
  const tooLarge = () => new IntegrationError(413, "FILE_TOO_LARGE", "Files larger than 25 MiB cannot be imported.");
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > limit) {
    await response.body?.cancel().catch(() => {});
    throw tooLarge();
  }

  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read().catch((error) => { throw networkError(error); });
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

export interface AuthUser { id: string; email: string; name: string; role: string }
const authBase = () => (process.env.NEON_AUTH_BASE_URL ?? process.env.VITE_NEON_AUTH_URL ?? "").replace(/\/$/, "");
let jwks: ReturnType<typeof import("jose").createRemoteJWKSet> | undefined;

export async function authenticateAdmin(header?: string): Promise<AuthUser> {
  if (!header?.startsWith("Bearer ")) throw new IntegrationError(401, "AUTH_REQUIRED", "Sign in to manage integrations.");
  const base = authBase();
  if (!base) throw new IntegrationError(503, "AUTH_UNAVAILABLE", "Neon Auth is not configured for this deployment.");
  try {
    const { jwtVerify, createRemoteJWKSet } = await import("jose"); // loaded on first sign-in, not on every cold start
    jwks ??= createRemoteJWKSet(new URL(`${base}/jwt`));
    const { payload } = await jwtVerify(header.slice(7), jwks);
    const user = { id: String(payload.sub ?? ""), email: String(payload.email ?? ""), name: String(payload.name ?? ""), role: String(payload.role ?? "") };
    if (!user.id) throw new Error("missing subject");
    if (user.role !== "admin") throw new IntegrationError(403, "ADMIN_REQUIRED", "Your Neon Auth account needs the admin role to manage workspace integrations.");
    return user;
  } catch (error) {
    if (error instanceof IntegrationError) throw error;
    throw new IntegrationError(401, "INVALID_SESSION", "Your session is invalid or expired. Sign in again.");
  }
}

function encryptionKey(): Buffer {
  const raw = process.env.CLAUSE_INTEGRATION_ENCRYPTION_KEY ?? "";
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) throw new IntegrationError(503, "INTEGRATION_KEY_MISSING", "Connector encryption is not configured on the server.");
  return key;
}
/** Sub-keys are derived per purpose so the OAuth-state HMAC never uses the same key bytes as token encryption. */
function derivedKey(purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", encryptionKey(), Buffer.alloc(0), `clause:${purpose}`, 32));
}
export function encrypt(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
}
export function decrypt(value: string): string {
  try {
    const [iv, tag, data] = value.split(".");
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv!, "base64url"));
    decipher.setAuthTag(Buffer.from(tag!, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(data!, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new IntegrationError(503, "INTEGRATION_TOKEN_UNAVAILABLE", "The saved connector credentials cannot be decrypted. Check the server encryption key.");
  }
}

const b64 = (s: string) => Buffer.from(s).toString("base64url");
const sha256 = (s: string) => createHash("sha256").update(s).digest("base64url");
const sameString = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const STATE_TTL_MS = 10 * 60_000;
export const OAUTH_COOKIE_MAX_AGE_S = STATE_TTL_MS / 1000;
const invalidState = () => new IntegrationError(400, "INVALID_OAUTH_STATE", "The connection request expired. Start again.");

interface OAuthState { sub: string; provider: IntegrationProvider; exp: number; bind: string; verifier: string }

/**
 * The state is signed (tamper-proof) and carries three things the callback needs: who started the flow, a hash of the
 * per-browser binding nonce (the nonce itself travels only in an HttpOnly cookie), and the PKCE verifier, encrypted so
 * that anyone who sees the redirect URL still cannot redeem the code.
 */
export function makeState(userId: string, provider: IntegrationProvider, bindingNonce: string, verifier: string) {
  const payload: OAuthState = { sub: userId, provider, exp: Date.now() + STATE_TTL_MS, bind: sha256(bindingNonce), verifier: encrypt(verifier) };
  const body = b64(JSON.stringify(payload));
  const signature = createHmac("sha256", derivedKey("oauth-state")).update(body).digest("base64url");
  return `${body}.${signature}`;
}
export function readState(state: string): OAuthState {
  const [body, signature] = state.split(".");
  if (!body || !signature) throw invalidState();
  const expected = createHmac("sha256", derivedKey("oauth-state")).update(body).digest("base64url");
  if (!sameString(signature, expected)) throw invalidState();
  try {
    const value = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as OAuthState;
    if (!value.sub || !value.provider || !value.bind || !value.verifier || value.exp < Date.now()) throw new Error("expired");
    return value;
  } catch { throw invalidState(); }
}

export function listProviders(store: Store) {
  return store.listIntegrationConnections().then((connections) => PROVIDERS.map((p) => {
    const config = providerConfig(p.id);
    const saved = connections.find((c) => c.provider === p.id);
    return { id: p.id, name: p.name, description: p.description, configured: config.configured, connected: Boolean(saved), accountName: saved?.accountName ?? null, connectedAt: saved?.connectedAt ?? null };
  }));
}

export function authorizationUrl(provider: IntegrationProvider, user: AuthUser): { url: string; binding: string } {
  const config = providerConfig(provider);
  if (!config.configured || !config.authUrl || !config.tokenUrl || !config.apiBase) throw new IntegrationError(503, "PROVIDER_NOT_CONFIGURED", `${providerById(provider)?.name ?? provider} OAuth credentials and endpoints are not configured.`);
  const binding = randomBytes(24).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const url = new URL(config.authUrl);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", config.scope);
  url.searchParams.set("state", makeState(user.id, provider, binding, verifier));
  // PKCE (RFC 7636): providers that do not support it ignore the extra parameters, as RFC 6749 requires.
  url.searchParams.set("code_challenge", sha256(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  if (provider === "google_drive") { url.searchParams.set("access_type", "offline"); url.searchParams.set("prompt", "consent"); }
  if (provider === "dropbox") url.searchParams.set("token_access_type", "offline");
  return { url: url.toString(), binding };
}

async function exchange(provider: IntegrationProvider, code: string, verifier: string) {
  const config = providerConfig(provider);
  const body = new URLSearchParams({ grant_type: "authorization_code", code, client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: config.redirectUri, code_verifier: verifier });
  const response = await providerFetch(config.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  const json = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || typeof json.access_token !== "string") throw new IntegrationError(502, "OAUTH_EXCHANGE_FAILED", `Could not connect to ${providerById(provider)?.name ?? provider}. Check its OAuth configuration and try again.`);
  return { accessToken: json.access_token, refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : null, expiresAt: typeof json.expires_in === "number" ? new Date(Date.now() + json.expires_in * 1000).toISOString() : null };
}

async function providerAccount(provider: IntegrationProvider, token: string): Promise<string | null> {
  const urls: Partial<Record<IntegrationProvider, string>> = { google_drive: "https://openidconnect.googleapis.com/v1/userinfo", onedrive: "https://graph.microsoft.com/v1.0/me", sharepoint: "https://graph.microsoft.com/v1.0/me", box: "https://api.box.com/2.0/users/me", dropbox: "https://api.dropboxapi.com/2/users/get_current_account", imanage: `${providerConfig(provider).apiBase}/users/me`, netdocuments: `${providerConfig(provider).apiBase}/users/me` };
  try {
    const response = provider === "dropbox"
      ? await providerFetch(urls[provider]!, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" })
      : await providerFetch(urls[provider]!, { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) return null;
    const body = await response.json();
    const b = body as Record<string, unknown>;
    const displayName = typeof b.name === "object" && b.name !== null ? (b.name as Record<string, unknown>).display_name : b.name;
    return String(b.email ?? b.login ?? displayName ?? b.display_name ?? b.user_name ?? "") || null;
  } catch { return null; }
}

export async function finishOAuth(store: Store, provider: IntegrationProvider, code: string, state: string, binding: string | undefined): Promise<void> {
  const parsed = readState(state);
  if (parsed.provider !== provider) throw invalidState();
  // The callback is a top-level redirect from the provider, so it carries no Bearer token. Instead the nonce set in an
  // HttpOnly cookie when the flow started must match the hash inside the signed state: a callback replayed or planted
  // in a different browser is refused.
  if (!binding || !sameString(sha256(binding), parsed.bind)) throw new IntegrationError(400, "OAUTH_BROWSER_MISMATCH", "This connection request was not started in this browser. Start again from Integrations.");
  const tokens = await exchange(provider, code, decrypt(parsed.verifier));
  const connection: IntegrationConnection = { provider, accessToken: encrypt(tokens.accessToken), refreshToken: tokens.refreshToken ? encrypt(tokens.refreshToken) : null, expiresAt: tokens.expiresAt, accountName: await providerAccount(provider, tokens.accessToken), connectedAt: new Date().toISOString() };
  await store.saveIntegrationConnection(connection);
}

const REFRESH_RECHECK_MS = [150, 350];
const refreshing = new Map<IntegrationProvider, Promise<string>>();
const needsRefresh = (c: { expiresAt: string | null; refreshToken: string | null }) => Boolean(c.expiresAt && c.refreshToken && Date.parse(c.expiresAt) <= Date.now() + 60_000);

async function accessToken(store: Store, provider: IntegrationProvider): Promise<string> {
  const stored = await store.getIntegrationConnection(provider);
  if (!stored) throw new IntegrationError(409, "PROVIDER_NOT_CONNECTED", `Connect ${providerById(provider)?.name ?? provider} first.`);
  if (!needsRefresh(stored)) return decrypt(stored.accessToken);
  // Concurrent imports share one refresh: Box rotates refresh tokens on every use, so a second refresh with the old
  // token would fail and could cost the user their connection.
  const inFlight = refreshing.get(provider);
  if (inFlight !== undefined) return inFlight;
  const refresh = refreshAccessToken(store, provider, stored).finally(() => refreshing.delete(provider));
  refreshing.set(provider, refresh);
  return refresh;
}

async function refreshAccessToken(store: Store, provider: IntegrationProvider, stored: IntegrationConnection): Promise<string> {
  const config = providerConfig(provider);
  let failure: IntegrationError | undefined;
  try {
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: decrypt(stored.refreshToken!), client_id: config.clientId, client_secret: config.clientSecret });
    const response = await providerFetch(config.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    const json = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (response.ok && typeof json.access_token === "string") {
      await store.saveIntegrationConnection({ ...stored, accessToken: encrypt(json.access_token), refreshToken: typeof json.refresh_token === "string" ? encrypt(json.refresh_token) : stored.refreshToken, expiresAt: typeof json.expires_in === "number" ? new Date(Date.now() + json.expires_in * 1000).toISOString() : null });
      return json.access_token;
    }
  } catch (error) {
    if (error instanceof IntegrationError && error.status !== 503) failure = error;
    else if (error instanceof IntegrationError) throw error;
  }
  // The in-process guard cannot see other serverless instances. If another one refreshed first, its new token is
  // already stored and our rejected refresh is expected; use it instead of telling the user to reconnect.
  for (const wait of REFRESH_RECHECK_MS) {
    await new Promise((resolve) => setTimeout(resolve, wait));
    const latest = await store.getIntegrationConnection(provider);
    if (latest && latest.accessToken !== stored.accessToken && !needsRefresh(latest)) return decrypt(latest.accessToken);
  }
  throw failure ?? new IntegrationError(401, "PROVIDER_AUTH_EXPIRED", `Reconnect ${providerById(provider)?.name ?? provider} to continue importing.`);
}

export interface FilePage { files: RemoteFile[]; nextPageToken: string | null }
type ProviderRow=Record<string,unknown>;
const providerRow=(value:unknown):ProviderRow=>typeof value==="object"&&value!==null&&!Array.isArray(value)?value as ProviderRow:{};
const providerRows=(value:unknown):ProviderRow[]=>Array.isArray(value)?value.map(providerRow):[];
const providerText=(value:unknown,fallback=""):string=>typeof value==="string"?value:typeof value==="number"&&Number.isFinite(value)?String(value):fallback;
const jsonRequest = async (url: string, token: string, init?: RequestInit) => {
  const response = await providerFetch(url, { ...init, headers: { authorization: `Bearer ${token}`, ...init?.headers } });
  if (!response.ok) throw new IntegrationError(response.status === 401 ? 401 : 502, response.status === 401 ? "PROVIDER_AUTH_EXPIRED" : "PROVIDER_REQUEST_FAILED", `The provider could not complete this request (${response.status}).`);
  return response.json().catch((error) => { throw networkError(error); }) as Promise<ProviderRow>;
};

export async function browseFiles(store: Store, provider: IntegrationProvider, parentId = "", driveId = "", pageToken = ""): Promise<FilePage> {
  const token = await accessToken(store, provider);
  const config = providerConfig(provider);
  let body: ProviderRow;
  let files: RemoteFile[];
  let nextPageToken: string | null = null;
  if (provider === "google_drive") {
    const params = new URLSearchParams({ pageSize: "100", orderBy: "folder,name", fields: "nextPageToken,files(id,name,mimeType,parents)", q: parentId ? `'${parentId.replaceAll("'", "\\'")}' in parents and trashed = false` : "'root' in parents and trashed = false" });
    if (pageToken) params.set("pageToken", pageToken);
    body = await jsonRequest(`${config.apiBase}/files?${params}`, token);
    files = providerRows(body.files).map((f)=>({id:providerText(f.id),name:providerText(f.name),mimeType:providerText(f.mimeType,"application/octet-stream"),folder:f.mimeType==="application/vnd.google-apps.folder",...(Array.isArray(f.parents)&&typeof f.parents[0]==="string"?{parentId:f.parents[0]}:{})}));
    nextPageToken = providerText(body.nextPageToken)||null;
  } else if (provider === "dropbox") {
    body = await jsonRequest(`${config.apiBase}/files/list_folder${pageToken ? "/continue" : ""}`, token, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(pageToken ? { cursor: pageToken } : { path: parentId, recursive: false, limit: 100 }) });
    files = providerRows(body.entries).map((f)=>{const name=providerText(f.name);const folder=f[".tag"]==="folder";return {id:providerText(f.id),name,mimeType:folder?"folder":(name.split(".").pop()?.toLowerCase()==="pdf"?"application/pdf":"application/octet-stream"),folder,...(typeof f.path_lower==="string"?{parentId:f.path_lower}:{})};});
    nextPageToken = body.has_more ? providerText(body.cursor)||null : null;
  } else if (provider === "box") {
    const folder = parentId || "0";
    const params = new URLSearchParams({ limit: "100", fields: "id,name,type,parent,extension", ...(pageToken && { offset: pageToken }) });
    body = await jsonRequest(`${config.apiBase}/folders/${encodeURIComponent(folder)}/items?${params}`, token);
    files = providerRows(body.entries).map((f)=>{const parent=providerRow(f.parent);return {id:providerText(f.id),name:providerText(f.name),mimeType:f.extension==="pdf"?"application/pdf":"application/octet-stream",folder:f.type==="folder",...(typeof parent.id==="string"?{parentId:parent.id}:{})};});
    const next=Number(body.next_offset),total=Number(body.total_count);
    nextPageToken = Number.isFinite(next)&&Number.isFinite(total)&&next<total ? String(next) : null;
  } else if (provider === "onedrive" || provider === "sharepoint") {
    let path: string;
    let data: ProviderRow[];
    if (pageToken) {
      const nextUrl = new URL(pageToken);
      if (nextUrl.origin !== new URL(config.apiBase).origin) throw new IntegrationError(400, "INVALID_PAGE_TOKEN", "The provider returned an invalid page cursor.");
      body = await jsonRequest(nextUrl.toString(), token);
      data = providerRows(body.value);
      files = data.map((f)=>{const file=providerRow(f.file);const parent=providerRow(f.parentReference);return {id:providerText(f.id),name:providerText(f.name),mimeType:providerText(file.mimeType,"application/octet-stream"),folder:Boolean(f.folder),...(typeof parent.id==="string"?{parentId:parent.id}:{}),driveId:providerText(parent.driveId,driveId)};});
    } else if (provider === "sharepoint" && !driveId) {
      path = "/me/drives?$top=100";
      body = await jsonRequest(`${config.apiBase}${path}`, token);
      files = providerRows(body.value).map((f)=>({id:providerText(f.id),name:providerText(f.name),mimeType:"drive",folder:true,driveId:providerText(f.id)}));
    } else {
      const drivePath = driveId ? `/drives/${encodeURIComponent(driveId)}` : "/me/drive";
      path = parentId ? `${drivePath}/items/${encodeURIComponent(parentId)}/children` : `${drivePath}/root/children`;
      body = await jsonRequest(`${config.apiBase}${path}?$top=100&$select=id,name,file,folder,parentReference`, token);
      data = providerRows(body.value);
      files = data.map((f)=>{const file=providerRow(f.file);const parent=providerRow(f.parentReference);return {id:providerText(f.id),name:providerText(f.name),mimeType:providerText(file.mimeType,"application/octet-stream"),folder:Boolean(f.folder),...(typeof parent.id==="string"?{parentId:parent.id}:{}),driveId:providerText(parent.driveId,driveId)};});
    }
    nextPageToken = providerText(body["@odata.nextLink"])||null;
  } else {
    const endpoint = provider === "imanage" ? (parentId ? `/folders/${encodeURIComponent(parentId)}/children` : "/folders/root/children") : (parentId ? `/folders/${encodeURIComponent(parentId)}/documents` : "/documents");
    body = await jsonRequest(`${config.apiBase.replace(/\/$/, "")}${endpoint}${pageToken ? `?page=${encodeURIComponent(pageToken)}` : ""}`, token);
    files = providerRows(body.files??body.documents??body.data??body.items).map((f)=>({id:providerText(f.id??f.document_id??f.docId),name:providerText(f.name??f.title??f.file_name),mimeType:providerText(f.mimeType??f.mime_type,"application/octet-stream"),folder:Boolean(f.folder??f.is_folder??f.type==="folder"),...(parentId?{parentId}:{})}));
    nextPageToken = providerText(body.nextPageToken??body.next_page_token)||null;
  }
  return { files: files.filter((f) => f.id && f.name), nextPageToken };
}

async function downloadFile(store: Store, provider: IntegrationProvider, file: RemoteFile): Promise<{ bytes: Buffer; mimeType: string }> {
  const token = await accessToken(store, provider);
  const config = providerConfig(provider);
  let response: Response;
  if (provider === "google_drive" && file.mimeType.startsWith("application/vnd.google-apps.")) {
    if (file.mimeType !== "application/vnd.google-apps.document") throw new IntegrationError(415, "UNSUPPORTED_FILE", "Only Google Docs can be exported as text; Sheets and Slides are not supported.");
    response = await providerFetch(`${config.apiBase}/files/${encodeURIComponent(file.id)}/export?mimeType=text/plain`, { headers: { authorization: `Bearer ${token}` } }, DOWNLOAD_TIMEOUT_MS);
  } else if (provider === "google_drive") {
    response = await providerFetch(`${config.apiBase}/files/${encodeURIComponent(file.id)}?alt=media`, { headers: { authorization: `Bearer ${token}` } }, DOWNLOAD_TIMEOUT_MS);
  } else if (provider === "dropbox") {
    response = await providerFetch("https://content.dropboxapi.com/2/files/download", { method: "POST", headers: { authorization: `Bearer ${token}`, "Dropbox-API-Arg": JSON.stringify({ path: file.id }) } }, DOWNLOAD_TIMEOUT_MS);
  } else if (provider === "box") {
    response = await providerFetch(`${config.apiBase}/files/${encodeURIComponent(file.id)}/content`, { headers: { authorization: `Bearer ${token}` }, redirect: "follow" }, DOWNLOAD_TIMEOUT_MS);
  } else if (provider === "onedrive" || provider === "sharepoint") {
    const driveId = file.driveId || "me";
    response = await providerFetch(`${config.apiBase}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(file.id)}/content`, { headers: { authorization: `Bearer ${token}` }, redirect: "follow" }, DOWNLOAD_TIMEOUT_MS);
  } else {
    response = await providerFetch(`${config.apiBase.replace(/\/$/, "")}/documents/${encodeURIComponent(file.id)}/download`, { headers: { authorization: `Bearer ${token}` }, redirect: "follow" }, DOWNLOAD_TIMEOUT_MS);
  }
  if (!response.ok) throw new IntegrationError(response.status === 401 ? 401 : 502, response.status === 401 ? "PROVIDER_AUTH_EXPIRED" : "DOWNLOAD_FAILED", `Could not download ${file.name} (${response.status}).`);
  const bytes = await readLimitedResponse(response);
  return { bytes, mimeType: response.headers.get("content-type")?.split(";")[0] ?? file.mimeType };
}

export async function extractText(store: Store, provider: IntegrationProvider, file: RemoteFile): Promise<string> {
  const { bytes, mimeType } = await downloadFile(store, provider, file);
  const ext = file.name.toLowerCase().split(".").pop();
  if (mimeType.startsWith("text/") || ext === "txt") return bytes.toString("utf8").replace(/^\uFEFF/, "");
  if (mimeType.includes("wordprocessingml") || ext === "docx") {
    const { default: mammoth } = await import("mammoth"); // 2 MB of parsing code, only when a .docx is imported
    const result = await mammoth.extractRawText({ buffer: bytes });
    return result.value.trim();
  }
  if (mimeType === "application/pdf" || ext === "pdf") {
    // PDF.js 5 expects browser geometry globals during module initialization. Vercel's
    // function bundler does not include pdf-parse's optional canvas dependency unless
    // it is imported explicitly, so load and expose its Node implementations first.
    const canvas = await import("@napi-rs/canvas");
    Object.assign(globalThis, { DOMMatrix: canvas.DOMMatrix, ImageData: canvas.ImageData, Path2D: canvas.Path2D });
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: bytes });
    try { return (await parser.getText()).text.trim(); }
    finally { await parser.destroy(); }
  }
  throw new IntegrationError(415, "UNSUPPORTED_FILE", "Choose a .docx, .pdf, or .txt file, or a Google Doc.");
}
