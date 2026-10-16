import type { Store } from "./types.ts";

/**
 * Defers connecting (and migrating, and seeding) until the first request that needs the database. A serverless
 * instance can therefore boot, answer /health and serve the UI even while the database is unreachable, and a failed
 * connection is retried on the next request instead of being cached forever.
 */
export function lazyStore(info: { kind: Store["kind"]; maxContentChars: number }, create: () => Promise<Store>): Store {
  let pending: Promise<Store> | undefined;
  const get = (): Promise<Store> =>
    (pending ??= create().catch((e) => {
      pending = undefined;
      throw e;
    }));

  return {
    kind: info.kind,
    maxContentChars: info.maxContentChars,
    insertDocument: (i) => get().then((s) => s.insertDocument(i)),
    getDocument: (id) => get().then((s) => s.getDocument(id)),
    listDocuments: (l, o) => get().then((s) => s.listDocuments(l, o)),
    deleteDocument: (id) => get().then((s) => s.deleteDocument(id)),
    commitRevision: (a) => get().then((s) => s.commitRevision(a)),
    listRevisions: (id) => get().then((s) => s.listRevisions(id)),
    getRevision: (id, v) => get().then((s) => s.getRevision(id, v)),
    rankWords: (q, ids) => get().then((s) => s.rankWords(q, ids)),
    // Only SQLite has a native snippet; the search layer checks for the method's presence.
    ...(info.kind === "sqlite" && { wordsSnippet: (id: string, q: string) => get().then((s) => s.wordsSnippet!(id, q)) }),
    getContent: (id) => get().then((s) => s.getContent(id)),
    exactCandidates: (q, ids) => get().then((s) => s.exactCandidates(q, ids)),
    listRequirements: (d) => get().then((s) => s.listRequirements(d)),
    addRequirement: (d, i) => get().then((s) => s.addRequirement(d, i)),
    deleteRequirement: (d, id) => get().then((s) => s.deleteRequirement(d, id)),
    seedIfEmpty: (items) => get().then((s) => s.seedIfEmpty(items)),
    close: async () => {
      if (pending) await (await pending).close();
    },
  };
}
