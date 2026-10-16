import { randomBytes } from "node:crypto";
import { Document, Packer, Paragraph } from "docx";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { browseFiles, encrypt, extractText } from "../src/integrations/service.ts";
import type { IntegrationProvider, Store } from "../src/store/types.ts";
import { testApp } from "./helpers.ts";

/**
 * The connector routes and provider adapters end to end, with every outbound call stubbed: a real admin JWT is
 * verified against a stub JWKS, so the auth path under test is the production one.
 */
const AUTH = "https://auth.test/db";
const text = (body: string, type = "text/plain") => new Response(body, { status: 200, headers: { "content-type": type } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let privateKey: CryptoKey;
let jwk: object;
let app: FastifyInstance | undefined;
let calls: { url: string; init?: RequestInit }[] = [];

beforeAll(async () => {
  const pair = await generateKeyPair("ES256");
  privateKey = pair.privateKey;
  jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" };
});

const token = (role = "admin") => new SignJWT({ role, email: "a@example.com", name: "A" }).setProtectedHeader({ alg: "ES256", kid: "k1" }).setSubject("u1").setIssuedAt().setExpirationTime("1h").sign(privateKey);
const bearer = async (role?: string) => ({ authorization: `Bearer ${await token(role)}` });

/** Routes outbound fetches by URL prefix; anything unexpected fails the test loudly. */
function stub(routes: Record<string, (url: string, init?: RequestInit) => Response | Promise<Response>>) {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, ...(init && { init }) });
    if (url === `${AUTH}/jwt`) return json({ keys: [jwk] });
    const hit = Object.keys(routes).filter((prefix) => url.startsWith(prefix)).sort((a, b) => b.length - a.length)[0];
    if (!hit) throw new Error(`unexpected outbound request: ${url}`);
    return routes[hit]!(url, init);
  }));
}

const connect = (store: Store, provider: IntegrationProvider) => store.saveIntegrationConnection({
  provider, accountName: "counsel@example.com", connectedAt: new Date().toISOString(),
  accessToken: encrypt("live-token"), refreshToken: encrypt("refresh"), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
});

beforeEach(() => {
  calls = [];
  vi.stubEnv("NEON_AUTH_BASE_URL", AUTH);
  vi.stubEnv("CLAUSE_INTEGRATION_ENCRYPTION_KEY", randomBytes(32).toString("hex"));
  vi.stubEnv("CLAUSE_IMANAGE_API_BASE", "https://imanage.test/api");
  vi.stubEnv("CLAUSE_NETDOCUMENTS_API_BASE", "https://nd.test/api");
});
afterEach(async () => {
  await app?.close(); app = undefined;
  vi.unstubAllEnvs(); vi.unstubAllGlobals();
});

describe("admin gate", () => {
  it("lets an admin list the providers, and shows no credential material", async () => {
    app = await testApp();
    stub({});
    const res = await app.inject({ method: "GET", url: "/integrations", headers: await bearer() });
    expect(res.statusCode).toBe(200);
    expect(res.json().providers.map((p: { id: string }) => p.id).sort()).toEqual(["box", "dropbox", "google_drive", "imanage", "netdocuments", "onedrive", "sharepoint"]);
    expect(res.body).not.toMatch(/secret|access_token|refresh_token|live-token/i);
  });

  it("refuses a signed-in user who is not an admin, and a token the issuer did not sign", async () => {
    app = await testApp();
    stub({});
    const member = await app.inject({ method: "GET", url: "/integrations", headers: await bearer("member") });
    expect(member.statusCode).toBe(403);
    expect(member.json()).toMatchObject({ type: "ADMIN_REQUIRED" });
    const other = await generateKeyPair("ES256");
    const forged = await new SignJWT({ role: "admin" }).setProtectedHeader({ alg: "ES256", kid: "k1" }).setSubject("u1").setExpirationTime("1h").sign(other.privateKey);
    const res = await app.inject({ method: "GET", url: "/integrations", headers: { authorization: `Bearer ${forged}` } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ type: "INVALID_SESSION" });
  });

  it("says so, with a 503, when sign-in is not configured on the server", async () => {
    app = await testApp();
    vi.stubEnv("NEON_AUTH_BASE_URL", "");
    vi.stubEnv("VITE_NEON_AUTH_URL", "");
    const res = await app.inject({ method: "GET", url: "/integrations", headers: { authorization: "Bearer anything" } });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ type: "AUTH_UNAVAILABLE" });
  });
});

describe("connect route", () => {
  it("returns the provider URL and sets the HttpOnly browser-binding cookie", async () => {
    app = await testApp();
    stub({});
    vi.stubEnv("CLAUSE_GOOGLE_DRIVE_CLIENT_ID", "id");
    vi.stubEnv("CLAUSE_GOOGLE_DRIVE_CLIENT_SECRET", "secret");
    vi.stubEnv("PUBLIC_APP_URL", "https://clause.test");
    const res = await app.inject({ method: "POST", url: "/integrations/google_drive/connect", headers: await bearer() });
    expect(res.statusCode).toBe(200);
    expect(new URL(res.json().url).searchParams.get("code_challenge_method")).toBe("S256");
    expect(String(res.headers["set-cookie"])).toMatch(/^clause_oauth_google_drive=.+; HttpOnly; SameSite=Lax; Path=\/; Max-Age=600; Secure$/);
  });

  it("explains a provider that has no credentials instead of redirecting nowhere", async () => {
    app = await testApp();
    stub({});
    const res = await app.inject({ method: "POST", url: "/integrations/box/connect", headers: await bearer() });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ type: "PROVIDER_NOT_CONFIGURED" });
  });
});

describe("browse, import, disconnect", () => {
  it("imports a file once, indexes it for search, marks it imported, and disconnects", async () => {
    app = await testApp();
    await connect(app.store, "dropbox");
    stub({
      "https://api.dropboxapi.com/2/files/list_folder": () => json({ entries: [{ ".tag": "file", id: "id:nda", name: "Redwood NDA.txt", path_lower: "/redwood nda.txt" }, { ".tag": "folder", id: "id:f", name: "Archive", path_lower: "/archive" }], has_more: false }),
      "https://content.dropboxapi.com/2/files/download": () => text("Confidential: Redwood acquisition terms."),
    });
    const headers = await bearer();
    const listed = await app.inject({ method: "GET", url: "/integrations/dropbox/files", headers });
    expect(listed.json().files).toEqual([
      expect.objectContaining({ id: "id:nda", folder: false, imported: false }),
      expect.objectContaining({ id: "id:f", folder: true }),
    ]);

    const file = { id: "id:nda", name: "Redwood NDA.txt", mimeType: "application/octet-stream" };
    const first = await app.inject({ method: "POST", url: "/integrations/dropbox/import", headers, payload: { file } });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ imported: true, document: { title: "Redwood NDA.txt", version: 1 } });
    const again = await app.inject({ method: "POST", url: "/integrations/dropbox/import", headers, payload: { file } });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ imported: false, document: { id: first.json().document.id } });

    expect((await app.inject({ method: "GET", url: "/integrations/dropbox/files", headers })).json().files[0]).toMatchObject({ imported: true });
    const found = await app.inject({ method: "GET", url: "/documents/search?q=Redwood&mode=words" });
    expect(found.json().total).toBe(1);

    expect((await app.inject({ method: "DELETE", url: "/integrations/dropbox", headers })).statusCode).toBe(204);
    expect(await app.store.getIntegrationConnection("dropbox")).toBeUndefined();
    const after = await app.inject({ method: "GET", url: "/integrations/dropbox/files", headers });
    expect(after.statusCode).toBe(409);
    expect(after.json()).toMatchObject({ type: "PROVIDER_NOT_CONNECTED" });
  });

  it("refuses folders, empty files and unsupported types with specific errors", async () => {
    app = await testApp();
    await connect(app.store, "dropbox");
    stub({ "https://content.dropboxapi.com/2/files/download": (_u, init) => {
      const id = String((init?.headers as Record<string, string>)["Dropbox-API-Arg"]);
      return id.includes("empty") ? text("   ") : text("binary", "application/octet-stream");
    } });
    const headers = await bearer();
    const post = (file: object) => app!.inject({ method: "POST", url: "/integrations/dropbox/import", headers, payload: { file } });
    expect((await post({ id: "f", name: "Dir", mimeType: "folder", folder: true })).json()).toMatchObject({ type: "FOLDER_NOT_IMPORTABLE" });
    expect((await post({ id: "empty", name: "Blank.txt", mimeType: "text/plain" })).json()).toMatchObject({ type: "EMPTY_DOCUMENT" });
    expect((await post({ id: "bin", name: "Deck.pptx", mimeType: "application/octet-stream" })).json()).toMatchObject({ type: "UNSUPPORTED_FILE" });
  });
});

describe("provider adapters", () => {
  const store = async () => { app = await testApp(); return app.store; };

  it("google drive: lists files and folders with pagination, and only exports Google Docs", async () => {
    const s = await store(); await connect(s, "google_drive");
    stub({
      "https://www.googleapis.com/drive/v3/files?": () => json({ nextPageToken: "p2", files: [{ id: "d1", name: "Deal", mimeType: "application/vnd.google-apps.document", parents: ["root"] }, { id: "f1", name: "Folder", mimeType: "application/vnd.google-apps.folder" }] }),
      "https://www.googleapis.com/drive/v3/files/d1/export": () => text("Exported Google Doc"),
      "https://www.googleapis.com/drive/v3/files/pdf1?alt=media": () => text("plain text body"),
    });
    const page = await browseFiles(s, "google_drive", "o'brien");
    expect(page.nextPageToken).toBe("p2");
    expect(page.files).toEqual([expect.objectContaining({ id: "d1", folder: false }), expect.objectContaining({ id: "f1", folder: true })]);
    expect(new URL(calls.at(-1)!.url).searchParams.get("q")).toBe("'o\\'brien' in parents and trashed = false");
    expect(await extractText(s, "google_drive", { id: "d1", name: "Deal", mimeType: "application/vnd.google-apps.document", folder: false })).toBe("Exported Google Doc");
    expect(await extractText(s, "google_drive", { id: "pdf1", name: "Notes.txt", mimeType: "text/plain", folder: false })).toBe("plain text body");
    await expect(extractText(s, "google_drive", { id: "s1", name: "Sheet", mimeType: "application/vnd.google-apps.spreadsheet", folder: false })).rejects.toMatchObject({ status: 415, code: "UNSUPPORTED_FILE" });
  });

  it("box: pages by offset and downloads content", async () => {
    const s = await store(); await connect(s, "box");
    stub({
      "https://api.box.com/2.0/folders/0/items": () => json({ entries: [{ id: "1", name: "MSA.pdf", type: "file", extension: "pdf" }, { id: "2", name: "Legal", type: "folder" }], next_offset: 100, total_count: 250 }),
      "https://api.box.com/2.0/files/1/content": () => text("box text"),
    });
    const page = await browseFiles(s, "box");
    expect(page.nextPageToken).toBe("100");
    expect(page.files[0]).toMatchObject({ mimeType: "application/pdf", folder: false });
    expect(await extractText(s, "box", { id: "1", name: "n.txt", mimeType: "text/plain", folder: false })).toBe("box text");
  });

  it("onedrive and sharepoint: list drives, follow same-origin cursors only, download from the right drive", async () => {
    const s = await store(); await connect(s, "onedrive"); await connect(s, "sharepoint");
    stub({
      "https://graph.microsoft.com/v1.0/me/drives": () => json({ value: [{ id: "drive-1", name: "Contracts" }] }),
      "https://graph.microsoft.com/v1.0/me/drive/root/children": () => json({ value: [{ id: "i1", name: "A.docx", file: { mimeType: "application/x" }, parentReference: { id: "root", driveId: "drive-9" } }], "@odata.nextLink": "https://graph.microsoft.com/v1.0/next?page=2" }),
      "https://graph.microsoft.com/v1.0/next": () => json({ value: [{ id: "i2", name: "Sub", folder: {}, parentReference: { id: "root" } }] }),
      "https://graph.microsoft.com/v1.0/drives/drive-9/items/i1/content": () => text("graph text"),
    });
    expect((await browseFiles(s, "sharepoint")).files).toEqual([{ id: "drive-1", name: "Contracts", mimeType: "drive", folder: true, driveId: "drive-1" }]);
    const first = await browseFiles(s, "onedrive");
    expect(first.files[0]).toMatchObject({ id: "i1", driveId: "drive-9" });
    expect((await browseFiles(s, "onedrive", "", "", first.nextPageToken!)).files[0]).toMatchObject({ id: "i2", folder: true });
    await expect(browseFiles(s, "onedrive", "", "", "https://evil.test/steal")).rejects.toMatchObject({ code: "INVALID_PAGE_TOKEN" });
    expect(await extractText(s, "onedrive", { id: "i1", name: "x.txt", mimeType: "text/plain", folder: false, driveId: "drive-9" })).toBe("graph text");
  });

  it("imanage and netdocuments: tenant endpoints, flexible response shapes", async () => {
    const s = await store(); await connect(s, "imanage"); await connect(s, "netdocuments");
    stub({
      "https://imanage.test/api/folders/root/children": () => json({ data: [{ id: 7, title: "Master Agreement", mime_type: "application/pdf" }, { document_id: "8", file_name: "Folder", is_folder: true }], next_page_token: "n2" }),
      "https://nd.test/api/documents": () => json({ documents: [{ docId: "d-1", name: "Lease.docx" }] }),
      "https://nd.test/api/documents/d-1/download": () => text("nd text"),
    });
    const im = await browseFiles(s, "imanage");
    expect(im.files).toEqual([expect.objectContaining({ id: "7", name: "Master Agreement", folder: false }), expect.objectContaining({ id: "8", folder: true })]);
    expect(im.nextPageToken).toBe("n2");
    expect((await browseFiles(s, "netdocuments")).files[0]).toMatchObject({ id: "d-1", name: "Lease.docx" });
    expect(await extractText(s, "netdocuments", { id: "d-1", name: "l.txt", mimeType: "text/plain", folder: false })).toBe("nd text");
  });

  it("maps provider failures: 401 means reconnect, anything else is a clear 502", async () => {
    const s = await store(); await connect(s, "box");
    stub({ "https://api.box.com/2.0/folders/0/items": () => json({}, 401), "https://api.box.com/2.0/files/9/content": () => new Response("no", { status: 500 }) });
    await expect(browseFiles(s, "box")).rejects.toMatchObject({ status: 401, code: "PROVIDER_AUTH_EXPIRED" });
    await expect(extractText(s, "box", { id: "9", name: "a.txt", mimeType: "text/plain", folder: false })).rejects.toMatchObject({ status: 502, code: "DOWNLOAD_FAILED" });
  });
});

describe("text extraction", () => {
  it("reads a .docx", async () => {
    app = await testApp(); await connect(app.store, "box");
    const docx = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph("Clause one."), new Paragraph("Clause two.")] }] }));
    stub({ "https://api.box.com/2.0/files/w/content": () => new Response(new Uint8Array(docx), { status: 200, headers: { "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" } }) });
    const out = await extractText(app.store, "box", { id: "w", name: "Agreement.docx", mimeType: "application/octet-stream", folder: false });
    expect(out).toContain("Clause one.");
    expect(out).toContain("Clause two.");
  });
});
