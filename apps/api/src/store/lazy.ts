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
    insertImportedDocument: (i) => get().then((s) => s.insertImportedDocument(i)),
    listIntegrationConnections: () => get().then((s) => s.listIntegrationConnections()),
    getIntegrationConnection: (p) => get().then((s) => s.getIntegrationConnection(p)),
    saveIntegrationConnection: (c) => get().then((s) => s.saveIntegrationConnection(c)),
    deleteIntegrationConnection: (p) => get().then((s) => s.deleteIntegrationConnection(p)),
    getIntegrationImport: (p, id) => get().then((s) => s.getIntegrationImport(p, id)),
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
    listRecentRevisions: (l) => get().then((s) => s.listRecentRevisions(l)),
    listRequests: () => get().then((s) => s.listRequests()),
    getRequest: (id) => get().then((s) => s.getRequest(id)),
    insertRequest: (i) => get().then((s) => s.insertRequest(i)),
    updateRequest: (id, p) => get().then((s) => s.updateRequest(id, p)),
    deleteRequest: (id) => get().then((s) => s.deleteRequest(id)),
    listPlaybooks: () => get().then((s) => s.listPlaybooks()),
    getPlaybook: (id) => get().then((s) => s.getPlaybook(id)),
    insertPlaybook: (i) => get().then((s) => s.insertPlaybook(i)),
    updatePlaybook: (id, p) => get().then((s) => s.updatePlaybook(id, p)),
    deletePlaybook: (id) => get().then((s) => s.deletePlaybook(id)),
    addPlaybookRule: (p, i) => get().then((s) => s.addPlaybookRule(p, i)),
    deletePlaybookRule: (p, r) => get().then((s) => s.deletePlaybookRule(p, r)),
    seedPlaybooksIfEmpty: (i) => get().then((s) => s.seedPlaybooksIfEmpty(i)),
    seedRequestsIfEmpty: (i) => get().then((s) => s.seedRequestsIfEmpty(i)),
    seedIfEmpty: (items) => get().then((s) => s.seedIfEmpty(items)),
    close: async () => {
      if (pending) await (await pending).close();
    },
  };
}
