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
    insertDocumentWithRequirements: (i) => get().then((s) => s.insertDocumentWithRequirements(i)),
    insertImportedDocument: (i) => get().then((s) => s.insertImportedDocument(i)),
    listIntegrationConnections: () => get().then((s) => s.listIntegrationConnections()),
    getIntegrationConnection: (p) => get().then((s) => s.getIntegrationConnection(p)),
    saveIntegrationConnection: (c) => get().then((s) => s.saveIntegrationConnection(c)),
    deleteIntegrationConnection: (p) => get().then((s) => s.deleteIntegrationConnection(p)),
    getIntegrationImport: (p, id) => get().then((s) => s.getIntegrationImport(p, id)),
    getDocument: (id) => get().then((s) => s.getDocument(id)),
    getDocumentMetadata: (id) => get().then((s) => s.getDocumentMetadata(id)),
    getDocumentForEdit: (id,precondition) => get().then((s) => s.getDocumentForEdit(id,precondition)),
    listDocuments: (l, o) => get().then((s) => s.listDocuments(l, o)),
    deleteDocument: (id) => get().then((s) => s.deleteDocument(id)),
    commitRevision: (a) => get().then((s) => s.commitRevision(a)),
    listRevisions: (id) => get().then((s) => s.listRevisions(id)),
    getRevision: (id, v) => get().then((s) => s.getRevision(id, v)),
    getRevisionMetadata: (id, v) => get().then((s) => s.getRevisionMetadata(id, v)),
    createJob: (i) => get().then((s) => s.createJob(i)),
    getJob: (id) => get().then((s) => s.getJob(id)),
    claimJob: (id,max) => get().then((s) => s.claimJob(id,max)),
    updateJob: (id,p) => get().then((s) => s.updateJob(id,p)),
    completeJob: (id,ref,exp) => get().then((s) => s.completeJob(id,ref,exp)),
    failJob: (id,code) => get().then((s) => s.failJob(id,code)),
    cancelJob: (id) => get().then((s) => s.cancelJob(id)),
    wordsPage: (q, options) => get().then((s) => s.wordsPage(q, options)),
    exactPage: (q, options) => get().then((s) => s.exactPage(q, options)),
    listRequirements: (d) => get().then((s) => s.listRequirements(d)),
    addRequirement: (d, i) => get().then((s) => s.addRequirement(d, i)),
    applyPlaybookRequirements: (d, rules) => get().then((s) => s.applyPlaybookRequirements(d, rules)),
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
    ensureSamples: (items) => get().then((s) => s.ensureSamples(items)),
    checkReady: () => get().then((s) => s.checkReady()),
    finishJob: (id,out) => get().then((s) => s.finishJob(id,out)),
    leaseJob: (id,owner) => get().then((s) => s.leaseJob(id,owner)),
    releaseJob: (id,owner) => get().then((s) => s.releaseJob(id,owner)),
    listExpiredExports: (limit) => get().then((s) => s.listExpiredExports(limit)),
    listPendingJobs: (limit) => get().then((s) => s.listPendingJobs(limit)),
    snapshotPage: (after,limit) => get().then((s) => s.snapshotPage(after,limit)),
    setSnapshotMetadata: (ref,jobId) => get().then((s) => s.setSnapshotMetadata(ref,jobId)),
    setSnapshotObject: (ref,jobId) => get().then((s) => s.setSnapshotObject(ref,jobId)),
    registerRecoveryManifest: (path,hash,proof,objects) => get().then((s) => s.registerRecoveryManifest(path,hash,proof,objects)),
    pruneSnapshot: (ref,path) => get().then((s) => s.pruneSnapshot(ref,path)),
    restoreSnapshot: (ref,content) => get().then((s) => s.restoreSnapshot(ref,content)),
    isContentReferenced: (path) => get().then((s) => s.isContentReferenced(path)),
    hasOtherActiveJobs: (id) => get().then((s) => s.hasOtherActiveJobs(id)),
    close: async () => {
      if (pending) await (await pending).close();
    },
  };
}
