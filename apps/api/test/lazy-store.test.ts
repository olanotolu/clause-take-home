import { describe, expect, it, vi } from "vitest";
import { lazyStore } from "../src/store/lazy.ts";
import type { Store } from "../src/store/types.ts";
import { testStore } from "./helpers.ts";

describe("lazyStore (a serverless instance must boot even while the database is down)", () => {
  it("does not connect until the first call, then connects once", async () => {
    const real = await testStore();
    const create = vi.fn(async () => real);
    const lazy = lazyStore({ kind: real.kind, maxContentChars: real.maxContentChars }, create);
    expect(create).not.toHaveBeenCalled();
    expect(lazy.kind).toBe(real.kind);
    const doc = await lazy.insertDocument({ title: "T", content: "hello" });
    expect(await lazy.getDocument(doc.id)).toMatchObject({ title: "T" });
    expect((await lazy.listDocuments(10, 0)).total).toBe(1);
    expect(create).toHaveBeenCalledTimes(1);
    await lazy.close();
  });

  it("forgets a failed connection and retries on the next call instead of caching the failure", async () => {
    const real = await testStore();
    const create = vi.fn<() => Promise<Store>>().mockRejectedValueOnce(new Error("db unreachable")).mockResolvedValue(real);
    const lazy = lazyStore({ kind: real.kind, maxContentChars: real.maxContentChars }, create);
    await expect(lazy.listDocuments(10, 0)).rejects.toThrow("db unreachable");
    await expect(lazy.listDocuments(10, 0)).resolves.toMatchObject({ total: 0 });
    expect(create).toHaveBeenCalledTimes(2);
    await lazy.close();
  });

  it("forwards the workspace and search methods to the real store", async () => {
    const real = await testStore();
    const lazy = lazyStore({ kind: real.kind, maxContentChars: real.maxContentChars }, async () => real);
    const doc = await lazy.insertDocument({ title: "NDA", content: "Receiving Party shall not disclose Confidential Information." });
    expect(((await lazy.wordsPage("disclose", { limit: 100, offset: 0 })).items).map((r) => r.id)).toEqual([doc.id]);
    expect((await lazy.exactPage("shall not disclose", { limit: 10, offset: 0, hitsPerDocument: 5 })).items.length).toBeGreaterThan(0);
    expect((await lazy.wordsPage("disclose", { limit: 1, offset: 0 })).items[0]?.content).toContain("Receiving Party");
    await lazy.addRequirement(doc.id, { kind: "absent", text: "perpetual" });
    expect(await lazy.listRequirements(doc.id)).toHaveLength(1);
    expect(await lazy.listRequests()).toEqual([]);
    expect((await lazy.listRecentRevisions(5)).length).toBe(1);
    expect(await lazy.listRevisions(doc.id)).toHaveLength(1);

    await lazy.deleteDocument(doc.id);
    expect(await lazy.getDocument(doc.id)).toBeUndefined();
    await lazy.close();
  });
});
