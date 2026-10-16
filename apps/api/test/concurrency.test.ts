import type { Result } from "@clause/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as docs from "../src/documents.ts";
import type { DomainError } from "../src/errors.ts";
import type { Store } from "../src/store/types.ts";
import { quote, sharedStores } from "./helpers.ts";

let a: Store;
let b: Store;
let cleanup: () => Promise<void>;

beforeEach(async () => void ({ a, b, cleanup } = await sharedStores()));
afterEach(async () => void (await cleanup()));

const must = <T,>(r: Result<T, DomainError>): T => {
  if (!r.ok) throw new Error(`unexpected failure: ${JSON.stringify(r.error)}`);
  return r.value;
};
const changes = (from: string, to: string) => [quote(from, to)];
const versions = async (s: Store, id: string) => (await s.listRevisions(id)).map((r) => r.version);

describe("two writers race on the same version", () => {
  it("exactly one commit wins; the loser's compare-and-swap fails and writes nothing", async () => {
    const doc = must(await docs.createDocument(a, { title: "NDA", content: "alpha beta gamma" }));

    // Both writers read v1 and resolve their edits against it...
    const pa = must(await docs.preview(a, doc.id, { changes: changes("alpha", "ALPHA") }));
    const pb = must(await docs.preview(b, doc.id, { changes: changes("gamma", "GAMMA") }));

    // ...A commits first, then B tries to commit against the version it read.
    const winA = await a.commitRevision({ id: doc.id, expectedVersion: 1, content: pa.result.content, summary: "[]" });
    const loseB = await b.commitRevision({ id: doc.id, expectedVersion: 1, content: pb.result.content, summary: "[]" });

    expect(winA).toMatchObject({ version: 2, content: "ALPHA beta gamma" });
    expect(loseB).toBe("conflict");

    const final = (await a.getDocument(doc.id))!;
    expect(final).toMatchObject({ version: 2, content: "ALPHA beta gamma" }); // B's edit is absent, not half-applied
    expect(await versions(a, doc.id)).toEqual([2, 1]); // contiguous, no phantom v2
  });

  it("truly simultaneous commits: exactly one succeeds", async () => {
    const doc = must(await docs.createDocument(a, { title: "NDA", content: "alpha beta gamma" }));
    const results = await Promise.all([
      a.commitRevision({ id: doc.id, expectedVersion: 1, content: "FROM A", summary: "[]" }),
      b.commitRevision({ id: doc.id, expectedVersion: 1, content: "FROM B", summary: "[]" }),
    ]);
    expect(results.filter((r) => r === "conflict")).toHaveLength(1);
    const winner = results.find((r) => r !== "conflict") as { content: string };
    expect((await a.getDocument(doc.id))!.content).toBe(winner.content);
    expect(await versions(a, doc.id)).toEqual([2, 1]);
  });

  it("through the service: the stale writer gets VERSION_CONFLICT with the current version", async () => {
    const doc = must(await docs.createDocument(a, { title: "NDA", content: "alpha beta gamma" }));
    const first = await docs.apply(a, doc.id, { expectedVersion: 1, changes: changes("alpha", "ALPHA") });
    const second = await docs.apply(b, doc.id, { expectedVersion: 1, changes: changes("gamma", "GAMMA") });
    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, error: { type: "VERSION_CONFLICT", expectedVersion: 1, currentVersion: 2 } });
  });

  it("a writer without preconditions is still protected from committing against a stale read", async () => {
    const doc = must(await docs.createDocument(a, { title: "NDA", content: "alpha beta gamma" }));
    const p = must(await docs.preview(b, doc.id, { changes: changes("gamma", "GAMMA") }));
    await docs.apply(a, doc.id, { changes: changes("alpha", "ALPHA") }); // wins the race
    const late = await b.commitRevision({ id: doc.id, expectedVersion: p.doc.version, content: p.result.content, summary: "[]" });
    expect(late).toBe("conflict");
  });

  it("the loser can retry after re-reading and then succeeds", async () => {
    const doc = must(await docs.createDocument(a, { title: "NDA", content: "alpha beta gamma" }));
    await docs.apply(a, doc.id, { expectedVersion: 1, changes: changes("alpha", "ALPHA") });
    const retry = await docs.apply(b, doc.id, { expectedVersion: 2, changes: changes("gamma", "GAMMA") });
    expect(retry.ok && retry.value.content).toBe("ALPHA beta GAMMA");
    expect(await versions(b, doc.id)).toEqual([3, 2, 1]);
  });

  it("a failed commit leaves the search index consistent with the stored document", async () => {
    const doc = must(await docs.createDocument(a, { title: "NDA", content: "alpha beta gamma" }));
    await docs.apply(a, doc.id, { changes: changes("alpha", "ALPHA") });
    await b.commitRevision({ id: doc.id, expectedVersion: 1, content: "STALE WRITE zzz", summary: "[]" });
    expect((await b.wordsPage("zzz", { limit: 100, offset: 0 })).items).toHaveLength(0);
    expect((await b.wordsPage("gamma", { limit: 100, offset: 0 })).items).toHaveLength(1);
  });
});

it("word search returns content and version from the same snapshot while another connection writes", async () => {
  const doc = await a.insertDocument({ title: "snapshot", content: "target snapshot 1" });
  await Promise.all([
    (async () => { for (let version = 1; version < 20; version++) await a.commitRevision({ id: doc.id, expectedVersion: version, content: `target snapshot ${version + 1}`, summary: "[]" }); })(),
    (async () => { for (let n = 0; n < 30; n++) {
      const page = await b.wordsPage("target", { limit: 1, offset: 0 });
      expect(page.total).toBe(1);
      expect(page.items[0]!.content).toBe(`target snapshot ${page.items[0]!.version}`);
    } })(),
  ]);
  expect(await b.wordsPage("target", { limit: 1, offset: 10 })).toEqual({ total: 1, items: [] });
  await a.deleteDocument(doc.id);
  expect(await b.wordsPage("target", { limit: 1, offset: 0 })).toEqual({ total: 0, items: [] });
});
