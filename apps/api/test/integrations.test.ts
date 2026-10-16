import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { testApp, testStore } from "./helpers.ts";

let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

describe("integrations", () => {
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
});
