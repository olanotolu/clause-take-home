import { createHash, createHmac, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { testApp, testStore } from "./helpers.ts";
import { providerConfig } from "../src/integrations/providers.ts";
import { authorizationUrl, browseFiles, decrypt, encrypt, makeState, readLimitedResponse, readState } from "../src/integrations/service.ts";
import type { Store } from "../src/store/types.ts";

const KEY = randomBytes(32).toString("hex");
const user = { id: "user-1", email: "admin@example.com", name: "Admin", role: "admin" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let app: FastifyInstance | undefined;
beforeEach(() => {
  vi.stubEnv("CLAUSE_INTEGRATION_ENCRYPTION_KEY", KEY);
  vi.stubEnv("CLAUSE_GOOGLE_DRIVE_CLIENT_ID", "client-id");
  vi.stubEnv("CLAUSE_GOOGLE_DRIVE_CLIENT_SECRET", "client-secret");
  vi.stubEnv("PUBLIC_APP_URL", "https://clause.test");
});
afterEach(async () => {
  await app?.close(); app = undefined;
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers();
});

const connect = (store: Store, over: { accessToken?: string; refreshToken?: string | null; expiresAt?: string | null } = {}) => store.saveIntegrationConnection({
  provider: "google_drive", accountName: null, connectedAt: new Date().toISOString(),
  accessToken: encrypt(over.accessToken ?? "access-1"),
  refreshToken: over.refreshToken === null ? null : encrypt(over.refreshToken ?? "refresh-1"),
  expiresAt: over.expiresAt === undefined ? new Date(Date.now() - 1000).toISOString() : over.expiresAt,
});

describe("integrations", () => {
  it("rejects an oversized declared download before reading its body", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const response = new Response(body, { headers: { "content-length": "5" } });
    await expect(readLimitedResponse(response, 4)).rejects.toMatchObject({ status: 413, code: "FILE_TOO_LARGE" });
    expect(cancelled).toBe(true);
  });

  it("enforces the download cap while streaming when content length is absent", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); controller.enqueue(new Uint8Array([4, 5])); controller.close(); },
    });
    await expect(readLimitedResponse(new Response(body), 4)).rejects.toMatchObject({ status: 413, code: "FILE_TOO_LARGE" });
  });

  it("rejects missing or invalid sessions before returning provider state", async () => {
    app = await testApp();
    const missing = await app.inject({ method: "GET", url: "/integrations" });
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toMatchObject({ type: "AUTH_REQUIRED" });
    const invalid = await app.inject({ method: "GET", url: "/integrations", headers: { authorization: "Bearer invalid" } });
    expect([401, 503]).toContain(invalid.statusCode);
    expect(invalid.body).not.toMatch(/access_token|refresh_token|client_secret/i);
  });

  it("stores imported documents once and indexes their text for search", async () => {
    const store = await testStore();
    try {
      const input = { title: "Executed NDA.txt", content: "Confidential matter: Redwood acquisition", provider: "google_drive" as const, fileId: "drive-file-1" };
      const first = await store.insertImportedDocument(input);
      const duplicate = await store.insertImportedDocument(input);
      expect(first.imported).toBe(true);
      expect(duplicate.imported).toBe(false);
      expect(duplicate.doc.id).toBe(first.doc.id);
      expect(await store.listDocuments(10, 0)).toMatchObject({ total: 1, items: [{ title: input.title }] });
      expect(await store.rankWords("Redwood acquisition")).toMatchObject([{ id: first.doc.id, title: input.title }]);
      expect(await store.getIntegrationImport(input.provider, input.fileId)).toMatchObject({ documentId: first.doc.id, provider: input.provider });
      expect(await store.listIntegrationConnections()).toEqual([]);
    } finally { await store.close(); }
  });

  it("does not let public document routes bypass connector admin protection", async () => {
    app = await testApp();
    const response = await app.inject({ method: "POST", url: "/integrations/google_drive/connect" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ type: "AUTH_REQUIRED" });
  });

  describe("token encryption", () => {
    it("round-trips, uses a fresh IV each time, and never stores the plaintext", () => {
      const a = encrypt("secret-token"); const b = encrypt("secret-token");
      expect(a).not.toBe(b);
      expect(a).not.toContain("secret-token");
      expect(decrypt(a)).toBe("secret-token");
    });

    it("refuses tampered ciphertext and a different server key with a clear 503", () => {
      const sealed = encrypt("secret-token");
      const [iv, tag, data] = sealed.split(".");
      const flipped = `${iv}.${tag}.${Buffer.from(Buffer.from(data!, "base64url").map((byte, i) => (i === 0 ? byte ^ 1 : byte))).toString("base64url")}`;
      expect(() => decrypt(flipped)).toThrowError(expect.objectContaining({ status: 503, code: "INTEGRATION_TOKEN_UNAVAILABLE" }));
      vi.stubEnv("CLAUSE_INTEGRATION_ENCRYPTION_KEY", randomBytes(32).toString("hex"));
      expect(() => decrypt(sealed)).toThrowError(expect.objectContaining({ status: 503, code: "INTEGRATION_TOKEN_UNAVAILABLE" }));
    });

    it("reports a missing or short key instead of encrypting with it", () => {
      vi.stubEnv("CLAUSE_INTEGRATION_ENCRYPTION_KEY", "too-short");
      expect(() => encrypt("x")).toThrowError(expect.objectContaining({ status: 503, code: "INTEGRATION_KEY_MISSING" }));
    });
  });

  describe("OAuth state", () => {
    const issue = () => makeState(user.id, "google_drive", "nonce-a", "verifier-a");

    it("round-trips the signed fields and keeps the PKCE verifier and binding nonce out of the clear", () => {
      const state = issue();
      const parsed = readState(state);
      expect(parsed).toMatchObject({ sub: user.id, provider: "google_drive" });
      expect(decrypt(parsed.verifier)).toBe("verifier-a");
      const body = Buffer.from(state.split(".")[0]!, "base64url").toString("utf8");
      expect(body).not.toContain("verifier-a");
      expect(body).not.toContain("nonce-a");
    });

    it("rejects a tampered body, a tampered signature and a malformed value", () => {
      const [body, signature] = issue().split(".");
      const forgedBody = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, "base64url").toString("utf8")), sub: "someone-else" })).toString("base64url");
      for (const bad of [`${forgedBody}.${signature}`, `${body}.${signature!.slice(0, -2)}AA`, `${body}.`, "nodots", ""]) {
        expect(() => readState(bad), bad).toThrowError(expect.objectContaining({ status: 400, code: "INVALID_OAUTH_STATE" }));
      }
    });

    it("rejects a state older than ten minutes", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const state = issue();
      vi.setSystemTime(Date.now() + 9 * 60_000);
      expect(() => readState(state)).not.toThrow();
      vi.setSystemTime(Date.now() + 2 * 60_000);
      expect(() => readState(state)).toThrowError(expect.objectContaining({ code: "INVALID_OAUTH_STATE" }));
    });

    it("is signed with a derived key, so the raw encryption key cannot mint a valid state", () => {
      const body = Buffer.from(JSON.stringify({ sub: user.id, provider: "google_drive", exp: Date.now() + 60_000, bind: "x", verifier: encrypt("v") })).toString("base64url");
      const forged = `${body}.${createHmac("sha256", Buffer.from(KEY, "hex")).update(body).digest("base64url")}`;
      expect(() => readState(forged)).toThrowError(expect.objectContaining({ code: "INVALID_OAUTH_STATE" }));
    });
  });

  describe("authorization request", () => {
    it("sends an S256 PKCE challenge whose verifier is recoverable only from the signed state", () => {
      const { url, binding } = authorizationUrl("google_drive", user);
      const params = new URL(url).searchParams;
      expect(params.get("code_challenge_method")).toBe("S256");
      const verifier = decrypt(readState(params.get("state")!).verifier);
      expect(params.get("code_challenge")).toBe(createHash("sha256").update(verifier).digest("base64url"));
      expect(url).not.toContain(binding);
      expect(url).not.toContain(verifier);
    });
  });

  describe("OAuth callback", () => {
    const start = () => {
      const { url, binding } = authorizationUrl("google_drive", user);
      return { state: new URL(url).searchParams.get("state")!, binding, verifier: decrypt(readState(new URL(url).searchParams.get("state")!).verifier) };
    };
    const callback = (state: string, headers: Record<string, string> = {}, provider = "google_drive") => app!.inject({ method: "GET", url: `/integrations/${provider}/callback?code=the-code&state=${encodeURIComponent(state)}`, headers });
    const stubProvider = () => {
      const calls: { url: string; body: string }[] = [];
      vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
        calls.push({ url: String(url), body: String(init?.body ?? "") });
        if (String(url) === providerConfig("google_drive").tokenUrl) return json({ access_token: "live-access", refresh_token: "live-refresh", expires_in: 3600 });
        return json({ email: "counsel@example.com" });
      }));
      return calls;
    };

    it("connects when the cookie matches, redeems the code with the PKCE verifier and stores only ciphertext", async () => {
      app = await testApp();
      const calls = stubProvider();
      const { state, binding, verifier } = start();
      const res = await callback(state, { cookie: `clause_oauth_google_drive=${binding}` });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/#/integrations?connected=google_drive");
      expect(String(res.headers["set-cookie"])).toMatch(/clause_oauth_google_drive=;.*Max-Age=0/);
      const exchange = new URLSearchParams(calls.find((c) => c.url === providerConfig("google_drive").tokenUrl)!.body);
      expect(exchange.get("code")).toBe("the-code");
      expect(exchange.get("code_verifier")).toBe(verifier);
      const saved = await app.store.getIntegrationConnection("google_drive");
      expect(saved).toMatchObject({ accountName: "counsel@example.com" });
      expect(saved!.accessToken).not.toContain("live-access");
      expect(decrypt(saved!.accessToken)).toBe("live-access");
      expect(decrypt(saved!.refreshToken!)).toBe("live-refresh");
    });

    it("refuses a callback that arrives without the browser cookie, or with another flow's cookie, before any token exchange", async () => {
      app = await testApp();
      const calls = stubProvider();
      const { state, binding } = start();
      const noCookie = await callback(state);
      expect(noCookie.statusCode).toBe(302);
      expect(noCookie.headers.location).toContain("code=OAUTH_BROWSER_MISMATCH");
      const other = await callback(state, { cookie: `clause_oauth_google_drive=${start().binding}` });
      expect(other.headers.location).toContain("code=OAUTH_BROWSER_MISMATCH");
      expect(binding).toBeTruthy();
      expect(calls).toEqual([]);
      expect(await app.store.getIntegrationConnection("google_drive")).toBeUndefined();
    });

    it("refuses a state minted for a different provider, a forged state and a missing code", async () => {
      app = await testApp();
      const calls = stubProvider();
      const dropbox = makeState(user.id, "dropbox", "nonce", "verifier");
      const cookie = { cookie: "clause_oauth_google_drive=nonce" };
      expect((await callback(dropbox, cookie)).headers.location).toContain("code=INVALID_OAUTH_STATE");
      expect((await callback("forged.state", cookie)).headers.location).toContain("code=INVALID_OAUTH_STATE");
      const noCode = await app.inject({ method: "GET", url: "/integrations/google_drive/callback?state=x" });
      expect(noCode.headers.location).toContain("code=OAUTH_CALLBACK_INVALID");
      expect(calls).toEqual([]);
    });

    it("sends a provider-side denial back to the Integrations page", async () => {
      app = await testApp();
      const res = await app.inject({ method: "GET", url: "/integrations/google_drive/callback?error=access_denied" });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/#/integrations?error=access_denied");
    });

    it("does not leak the stored credentials through the provider list", async () => {
      app = await testApp();
      await connect(app.store, { expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
      expect(JSON.stringify(await app.store.listIntegrationConnections())).not.toMatch(/access|refresh/i);
    });
  });

  describe("token refresh", () => {
    const tokenUrl = () => providerConfig("google_drive").tokenUrl;

    it("shares one refresh between concurrent requests", async () => {
      const store = await testStore();
      try {
        await connect(store);
        let refreshes = 0;
        const seen: string[] = [];
        vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
          if (String(url) === tokenUrl()) { refreshes++; await delay(40); return json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 }); }
          seen.push(String((init?.headers as Record<string, string>).authorization));
          return json({ files: [] });
        }));
        await Promise.all([browseFiles(store, "google_drive"), browseFiles(store, "google_drive"), browseFiles(store, "google_drive")]);
        expect(refreshes).toBe(1);
        expect(seen).toEqual(["Bearer access-2", "Bearer access-2", "Bearer access-2"]);
        expect(decrypt((await store.getIntegrationConnection("google_drive"))!.refreshToken!)).toBe("refresh-2");
      } finally { await store.close(); }
    });

    it("uses the token another instance already rotated instead of asking the user to reconnect", async () => {
      const store = await testStore();
      try {
        await connect(store);
        vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
          if (String(url) === tokenUrl()) {
            // Another serverless instance wins the race: its new token lands in the store, ours is rejected.
            await connect(store, { accessToken: "rotated", refreshToken: "refresh-rotated", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
            return json({ error: "invalid_grant" }, 400);
          }
          expect((init?.headers as Record<string, string>).authorization).toBe("Bearer rotated");
          return json({ files: [] });
        }));
        await expect(browseFiles(store, "google_drive")).resolves.toEqual({ files: [], nextPageToken: null });
      } finally { await store.close(); }
    });

    it("asks to reconnect when the refresh is rejected and nothing newer is stored", async () => {
      const store = await testStore();
      try {
        await connect(store);
        vi.stubGlobal("fetch", vi.fn(async () => json({ error: "invalid_grant" }, 400)));
        await expect(browseFiles(store, "google_drive")).rejects.toMatchObject({ status: 401, code: "PROVIDER_AUTH_EXPIRED" });
        // A failed refresh must not wedge later requests behind a dead in-flight promise.
        await expect(browseFiles(store, "google_drive")).rejects.toMatchObject({ code: "PROVIDER_AUTH_EXPIRED" });
      } finally { await store.close(); }
    });

    it("leaves a still-valid token alone", async () => {
      const store = await testStore();
      try {
        await connect(store, { expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
        const fetched = vi.fn(async () => json({ files: [] }));
        vi.stubGlobal("fetch", fetched);
        await browseFiles(store, "google_drive");
        expect(fetched).toHaveBeenCalledTimes(1);
      } finally { await store.close(); }
    });
  });

  describe("provider timeouts", () => {
    const live = (store: Store) => connect(store, { expiresAt: new Date(Date.now() + 3_600_000).toISOString() });

    it("gives every provider call an abort signal", async () => {
      const store = await testStore();
      try {
        await live(store);
        const fetched = vi.fn(async (_url: string | URL, init?: RequestInit) => { expect(init?.signal).toBeInstanceOf(AbortSignal); return json({ files: [] }); });
        vi.stubGlobal("fetch", fetched);
        await browseFiles(store, "google_drive");
        expect(fetched).toHaveBeenCalled();
      } finally { await store.close(); }
    });

    it("maps a timeout to 504 and an unreachable provider to 502", async () => {
      const store = await testStore();
      try {
        await live(store);
        vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("The operation timed out", "TimeoutError"); }));
        await expect(browseFiles(store, "google_drive")).rejects.toMatchObject({ status: 504, code: "PROVIDER_TIMEOUT" });
        vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
        await expect(browseFiles(store, "google_drive")).rejects.toMatchObject({ status: 502, code: "PROVIDER_UNREACHABLE" });
      } finally { await store.close(); }
    });

    it("maps a stall in the middle of a download body to 504", async () => {
      const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1])); controller.error(new DOMException("aborted", "TimeoutError")); } });
      await expect(readLimitedResponse(new Response(body), 1024)).rejects.toMatchObject({ status: 504, code: "PROVIDER_TIMEOUT" });
    });
  });
});
