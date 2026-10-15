import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db.ts";
import * as docs from "../src/documents.ts";
import * as repo from "../src/repo.ts";
import { quote } from "./helpers.ts";

let dir: string;
let a: Db;
let b: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clause-"));
  a = openDb(join(dir, "t.db"));
  b = openDb(join(dir, "t.db")); // a second, independent connection to the same file
});
afterEach(() => {
  a.close();
  b.close();
  rmSync(dir, { recursive: true, force: true });
});

const changes = (from: string, to: string) => [quote(from, to)];

describe("two writers race on the same version", () => {
  it("exactly one commit wins; the loser's compare-and-swap fails and writes nothing", () => {
    const doc = docs.createDocument(a, { title: "NDA", content: "alpha beta gamma" });

    // Both writers read v1 and resolve their edits against it...
    const pa = docs.preview(a, doc.id, { changes: changes("alpha", "ALPHA") });
    const pb = docs.preview(b, doc.id, { changes: changes("gamma", "GAMMA") });
    expect(pa.ok && pb.ok).toBe(true);
    if (!pa.ok || !pb.ok) return;

    // ...A commits first, then B tries to commit against the version it read.
    const winA = repo.commitRevision(a, { id: doc.id, expectedVersion: 1, content: pa.value.result.content, summary: "[]" });
    const loseB = repo.commitRevision(b, { id: doc.id, expectedVersion: 1, content: pb.value.result.content, summary: "[]" });

    expect(winA).toMatchObject({ version: 2, content: "ALPHA beta gamma" });
    expect(loseB).toBe("conflict");

    const final = repo.getDocument(a, doc.id)!;
    expect(final).toMatchObject({ version: 2, content: "ALPHA beta gamma" }); // B's edit is absent, not half-applied
    expect(repo.listRevisions(a, doc.id).map((r) => r.version)).toEqual([2, 1]); // contiguous, no phantom v2
  });

  it("through the service: the stale writer gets VERSION_CONFLICT with the current version", () => {
    const doc = docs.createDocument(a, { title: "NDA", content: "alpha beta gamma" });
    const first = docs.apply(a, doc.id, { expectedVersion: 1, changes: changes("alpha", "ALPHA") });
    const second = docs.apply(b, doc.id, { expectedVersion: 1, changes: changes("gamma", "GAMMA") });
    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, error: { type: "VERSION_CONFLICT", expectedVersion: 1, currentVersion: 2 } });
  });

  it("a writer without preconditions is still protected from committing against a stale read", () => {
    const doc = docs.createDocument(a, { title: "NDA", content: "alpha beta gamma" });
    const p = docs.preview(b, doc.id, { changes: changes("gamma", "GAMMA") });
    docs.apply(a, doc.id, { changes: changes("alpha", "ALPHA") }); // wins the race
    if (!p.ok) throw new Error("preview failed");
    const late = repo.commitRevision(b, { id: doc.id, expectedVersion: p.value.doc.version, content: p.value.result.content, summary: "[]" });
    expect(late).toBe("conflict");
  });

  it("the loser can retry after re-reading and then succeeds", () => {
    const doc = docs.createDocument(a, { title: "NDA", content: "alpha beta gamma" });
    docs.apply(a, doc.id, { expectedVersion: 1, changes: changes("alpha", "ALPHA") });
    const retry = docs.apply(b, doc.id, { expectedVersion: 2, changes: changes("gamma", "GAMMA") });
    expect(retry.ok && retry.value.content).toBe("ALPHA beta GAMMA");
    expect(repo.listRevisions(b, doc.id).map((r) => r.version)).toEqual([3, 2, 1]);
  });

  it("a failed commit leaves the search index consistent with the stored document", () => {
    const doc = docs.createDocument(a, { title: "NDA", content: "alpha beta gamma" });
    docs.apply(a, doc.id, { changes: changes("alpha", "ALPHA") });
    repo.commitRevision(b, { id: doc.id, expectedVersion: 1, content: "STALE WRITE zzz", summary: "[]" });
    const hit = (q: string) => b.prepare("SELECT count(*) AS n FROM documents_words WHERE documents_words MATCH ?").get(q) as { n: number };
    expect(hit("zzz").n).toBe(0);
    expect(hit("gamma").n).toBe(1);
  });
});
