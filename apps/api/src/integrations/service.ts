import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { jwtVerify, createRemoteJWKSet } from "jose";
import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
import type { IntegrationConnection, IntegrationProvider, Store } from "../store/types.ts";
import { providerById, providerConfig, PROVIDERS } from "./providers.ts";

export class IntegrationError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

/** Read a provider response without buffering more than the import limit in memory. */
export async function readLimitedResponse(response: Response, limit = MAX_IMPORT_BYTES): Promise<Buffer> {
  const tooLarge = () => new IntegrationError(413, "FILE_TOO_LARGE", "Files larger than 20 MB cannot be imported.");
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
      const { done, value } = await reader.read();
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
let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

export async function authenticateAdmin(header?: string): Promise<AuthUser> {
  if (!header?.startsWith("Bearer ")) throw new IntegrationError(401, "AUTH_REQUIRED", "Sign in to manage integrations.");
  const base = authBase();
  if (!base) throw new IntegrationError(503, "AUTH_UNAVAILABLE", "Neon Auth is not configured for this deployment.");
  try {
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
function encrypt(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
}
function decrypt(value: string): string {
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
function stateSecret() { return encryptionKey(); }
function makeState(userId: string) {
  const body = b64(JSON.stringify({ sub: userId, exp: Date.now() + 10 * 60_000, nonce: randomBytes(18).toString("base64url") }));
  const signature = createHmac("sha256", stateSecret()).update(body).digest("base64url");
  return `${body}.${signature}`;
}
function readState(state: string): { sub: string } {
  const [body, signature] = state.split(".");
  const expected = createHmac("sha256", stateSecret()).update(body ?? "").digest("base64url");
  if (!body || !signature || signature.length !== expected.length || !Buffer.from(signature).equals(Buffer.from(expected))) throw new IntegrationError(400, "INVALID_OAUTH_STATE", "The connection request expired. Start again.");
  try {
    const value = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { sub: string; exp: number };
    if (!value.sub || value.exp < Date.now()) throw new Error("expired");
    return { sub: value.sub };
  } catch { throw new IntegrationError(400, "INVALID_OAUTH_STATE", "The connection request expired. Start again."); }
}

export function listProviders(store: Store) {
  return store.listIntegrationConnections().then((connections) => PROVIDERS.map((p) => {
    const config = providerConfig(p.id);
    const saved = connections.find((c) => c.provider === p.id);
    return { id: p.id, name: p.name, description: p.description, configured: config.configured, connected: Boolean(saved), accountName: saved?.accountName ?? null, connectedAt: saved?.connectedAt ?? null };
  }));
}

export function authorizationUrl(provider: IntegrationProvider, user: AuthUser): string {
  const config = providerConfig(provider);
  if (!config.configured || !config.authUrl || !config.tokenUrl || !config.apiBase) throw new IntegrationError(503, "PROVIDER_NOT_CONFIGURED", `${providerById(provider)?.name ?? provider} OAuth credentials and endpoints are not configured.`);
  const url = new URL(config.authUrl);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", config.scope);
  url.searchParams.set("state", makeState(user.id));
  if (provider === "google_drive") { url.searchParams.set("access_type", "offline"); url.searchParams.set("prompt", "consent"); }
  if (provider === "dropbox") url.searchParams.set("token_access_type", "offline");
  return url.toString();
}

async function exchange(provider: IntegrationProvider, code: string) {
  const config = providerConfig(provider);
  const body = new URLSearchParams({ grant_type: "authorization_code", code, client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: config.redirectUri });
  const response = await fetch(config.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  const json = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || typeof json.access_token !== "string") throw new IntegrationError(502, "OAUTH_EXCHANGE_FAILED", `Could not connect to ${providerById(provider)?.name ?? provider}. Check its OAuth configuration and try again.`);
  return { accessToken: json.access_token, refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : null, expiresAt: typeof json.expires_in === "number" ? new Date(Date.now() + json.expires_in * 1000).toISOString() : null };
}

async function providerAccount(provider: IntegrationProvider, token: string): Promise<string | null> {
  const urls: Partial<Record<IntegrationProvider, string>> = { google_drive: "https://openidconnect.googleapis.com/v1/userinfo", onedrive: "https://graph.microsoft.com/v1.0/me", sharepoint: "https://graph.microsoft.com/v1.0/me", box: "https://api.box.com/2.0/users/me", dropbox: "https://api.dropboxapi.com/2/users/get_current_account", imanage: `${providerConfig(provider).apiBase}/users/me`, netdocuments: `${providerConfig(provider).apiBase}/users/me` };
  try {
    const response = provider === "dropbox"
      ? await fetch(urls[provider]!, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" })
      : await fetch(urls[provider]!, { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) return null;
    const body = await response.json();
    const b = body as Record<string, unknown>;
    const displayName = typeof b.name === "object" && b.name !== null ? (b.name as Record<string, unknown>).display_name : b.name;
    return String(b.email ?? b.login ?? displayName ?? b.display_name ?? b.user_name ?? "") || null;
  } catch { return null; }
}

export async function finishOAuth(store: Store, provider: IntegrationProvider, code: string, state: string): Promise<void> {
  readState(state);
  const tokens = await exchange(provider, code);
  const connection: IntegrationConnection = { provider, accessToken: encrypt(tokens.accessToken), refreshToken: tokens.refreshToken ? encrypt(tokens.refreshToken) : null, expiresAt: tokens.expiresAt, accountName: await providerAccount(provider, tokens.accessToken), connectedAt: new Date().toISOString() };
  await store.saveIntegrationConnection(connection);
}

async function accessToken(store: Store, provider: IntegrationProvider): Promise<string> {
  const stored = await store.getIntegrationConnection(provider);
  if (!stored) throw new IntegrationError(409, "PROVIDER_NOT_CONNECTED", `Connect ${providerById(provider)?.name ?? provider} first.`);
  const access = decrypt(stored.accessToken);
  if (!stored.expiresAt || Date.parse(stored.expiresAt) > Date.now() + 60_000 || !stored.refreshToken) return access;
  const config = providerConfig(provider);
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: decrypt(stored.refreshToken), client_id: config.clientId, client_secret: config.clientSecret });
  const response = await fetch(config.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  const json = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || typeof json.access_token !== "string") throw new IntegrationError(401, "PROVIDER_AUTH_EXPIRED", `Reconnect ${providerById(provider)?.name ?? provider} to continue importing.`);
  await store.saveIntegrationConnection({ ...stored, accessToken: encrypt(json.access_token), refreshToken: typeof json.refresh_token === "string" ? encrypt(json.refresh_token) : stored.refreshToken, expiresAt: typeof json.expires_in === "number" ? new Date(Date.now() + json.expires_in * 1000).toISOString() : null });
  return json.access_token;
}

export interface RemoteFile { id: string; name: string; mimeType: string; folder: boolean; parentId?: string; driveId?: string }
export interface FilePage { files: RemoteFile[]; nextPageToken: string | null }
const jsonRequest = async (url: string, token: string, init?: RequestInit) => {
  const response = await fetch(url, { ...init, headers: { authorization: `Bearer ${token}`, ...init?.headers } });
  if (!response.ok) throw new IntegrationError(response.status === 401 ? 401 : 502, response.status === 401 ? "PROVIDER_AUTH_EXPIRED" : "PROVIDER_REQUEST_FAILED", `The provider could not complete this request (${response.status}).`);
  return response.json() as Promise<Record<string, any>>;
};

export async function browseFiles(store: Store, provider: IntegrationProvider, parentId = "", driveId = "", pageToken = ""): Promise<FilePage> {
  const token = await accessToken(store, provider);
  const config = providerConfig(provider);
  let body: Record<string, any>;
  let files: RemoteFile[];
  let nextPageToken: string | null = null;
  if (provider === "google_drive") {
    const params = new URLSearchParams({ pageSize: "100", orderBy: "folder,name", fields: "nextPageToken,files(id,name,mimeType,parents)", q: parentId ? `'${parentId.replaceAll("'", "\\'")}' in parents and trashed = false` : "'root' in parents and trashed = false" });
    if (pageToken) params.set("pageToken", pageToken);
    body = await jsonRequest(`${config.apiBase}/files?${params}`, token);
    files = (body.files ?? []).map((f: any) => ({ id: f.id, name: f.name, mimeType: f.mimeType, folder: f.mimeType === "application/vnd.google-apps.folder", parentId: f.parents?.[0] }));
    nextPageToken = body.nextPageToken ?? null;
  } else if (provider === "dropbox") {
    body = await jsonRequest(`${config.apiBase}/files/list_folder${pageToken ? "/continue" : ""}`, token, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(pageToken ? { cursor: pageToken } : { path: parentId, recursive: false, limit: 100 }) });
    files = (body.entries ?? []).map((f: any) => ({ id: f.id, name: f.name, mimeType: f['.tag'] === "folder" ? "folder" : (f.name.split(".").pop()?.toLowerCase() === "pdf" ? "application/pdf" : "application/octet-stream"), folder: f['.tag'] === "folder", parentId: f.path_lower }));
    nextPageToken = body.has_more ? body.cursor : null;
  } else if (provider === "box") {
    const folder = parentId || "0";
    const params = new URLSearchParams({ limit: "100", fields: "id,name,type,parent,extension", ...(pageToken && { offset: pageToken }) });
    body = await jsonRequest(`${config.apiBase}/folders/${encodeURIComponent(folder)}/items?${params}`, token);
    files = (body.entries ?? []).map((f: any) => ({ id: f.id, name: f.name, mimeType: f.extension === "pdf" ? "application/pdf" : "application/octet-stream", folder: f.type === "folder", parentId: f.parent?.id }));
    nextPageToken = body.next_offset < body.total_count ? String(body.next_offset) : null;
  } else if (provider === "onedrive" || provider === "sharepoint") {
    let path: string;
    let data: any[];
    if (pageToken) {
      const nextUrl = new URL(pageToken);
      if (nextUrl.origin !== new URL(config.apiBase).origin) throw new IntegrationError(400, "INVALID_PAGE_TOKEN", "The provider returned an invalid page cursor.");
      body = await jsonRequest(nextUrl.toString(), token);
      data = body.value ?? [];
      files = data.map((f: any) => ({ id: f.id, name: f.name, mimeType: f.file?.mimeType ?? "application/octet-stream", folder: Boolean(f.folder), parentId: f.parentReference?.id, driveId: f.parentReference?.driveId ?? driveId }));
    } else if (provider === "sharepoint" && !driveId) {
      path = "/me/drives?$top=100";
      body = await jsonRequest(`${config.apiBase}${path}`, token);
      files = (body.value ?? []).map((f: any) => ({ id: f.id, name: f.name, mimeType: "drive", folder: true, driveId: f.id }));
    } else {
      const drivePath = driveId ? `/drives/${encodeURIComponent(driveId)}` : "/me/drive";
      path = parentId ? `${drivePath}/items/${encodeURIComponent(parentId)}/children` : `${drivePath}/root/children`;
      body = await jsonRequest(`${config.apiBase}${path}?$top=100&$select=id,name,file,folder,parentReference`, token);
      data = body.value ?? [];
      files = data.map((f: any) => ({ id: f.id, name: f.name, mimeType: f.file?.mimeType ?? "application/octet-stream", folder: Boolean(f.folder), parentId: f.parentReference?.id, driveId: f.parentReference?.driveId ?? driveId }));
    }
    nextPageToken = body["@odata.nextLink"] ?? null;
  } else {
    const endpoint = provider === "imanage" ? (parentId ? `/folders/${encodeURIComponent(parentId)}/children` : "/folders/root/children") : (parentId ? `/folders/${encodeURIComponent(parentId)}/documents` : "/documents");
    body = await jsonRequest(`${config.apiBase.replace(/\/$/, "")}${endpoint}${pageToken ? `?page=${encodeURIComponent(pageToken)}` : ""}`, token);
    files = (body.files ?? body.documents ?? body.data ?? body.items ?? []).map((f: any) => ({ id: String(f.id ?? f.document_id ?? f.docId), name: String(f.name ?? f.title ?? f.file_name), mimeType: String(f.mimeType ?? f.mime_type ?? "application/octet-stream"), folder: Boolean(f.folder ?? f.is_folder ?? f.type === "folder"), parentId }));
    nextPageToken = body.nextPageToken ?? body.next_page_token ?? null;
  }
  return { files: files.filter((f) => f.id && f.name), nextPageToken };
}

async function downloadFile(store: Store, provider: IntegrationProvider, file: RemoteFile): Promise<{ bytes: Buffer; mimeType: string }> {
  const token = await accessToken(store, provider);
  const config = providerConfig(provider);
  let response: Response;
  if (provider === "google_drive" && file.mimeType.startsWith("application/vnd.google-apps.")) {
    if (file.mimeType !== "application/vnd.google-apps.document") throw new IntegrationError(415, "UNSUPPORTED_FILE", "Only Google Docs can be exported as text; Sheets and Slides are not supported.");
    response = await fetch(`${config.apiBase}/files/${encodeURIComponent(file.id)}/export?mimeType=text/plain`, { headers: { authorization: `Bearer ${token}` } });
  } else if (provider === "google_drive") {
    response = await fetch(`${config.apiBase}/files/${encodeURIComponent(file.id)}?alt=media`, { headers: { authorization: `Bearer ${token}` } });
  } else if (provider === "dropbox") {
    response = await fetch("https://content.dropboxapi.com/2/files/download", { method: "POST", headers: { authorization: `Bearer ${token}`, "Dropbox-API-Arg": JSON.stringify({ path: file.id }) } });
  } else if (provider === "box") {
    response = await fetch(`${config.apiBase}/files/${encodeURIComponent(file.id)}/content`, { headers: { authorization: `Bearer ${token}` }, redirect: "follow" });
  } else if (provider === "onedrive" || provider === "sharepoint") {
    const driveId = file.driveId || "me";
    response = await fetch(`${config.apiBase}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(file.id)}/content`, { headers: { authorization: `Bearer ${token}` }, redirect: "follow" });
  } else {
    const endpoint = provider === "imanage" ? `/documents/${encodeURIComponent(file.id)}/download` : `/documents/${encodeURIComponent(file.id)}/download`;
    response = await fetch(`${config.apiBase.replace(/\/$/, "")}${endpoint}`, { headers: { authorization: `Bearer ${token}` }, redirect: "follow" });
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
    const result = await mammoth.extractRawText({ buffer: bytes });
    return result.value.trim();
  }
  if (mimeType === "application/pdf" || ext === "pdf") {
    const parser = new PDFParse({ data: bytes });
    try { return (await parser.getText()).text.trim(); }
    finally { await parser.destroy(); }
  }
  throw new IntegrationError(415, "UNSUPPORTED_FILE", "Choose a .docx, .pdf, or .txt file, or a Google Doc.");
}
