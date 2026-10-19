import { readStoredContent } from "../content-storage.ts";
import { sqliteMaintenance } from "./maintenance-sqlite.ts";
import { JobPayloadSchema, JobOutputSchema, JobCancelledError } from "../jobs/types.ts";
import { randomUUID } from "node:crypto";
import { countWords, sha256 } from "@clause/core";
import { openDb, transaction, type Db } from "../db.ts";
import { dueIn, newId, REQUEST_COLUMNS, sampleKeyOf, requestPatchColumns, toPlaybook, toRequest, toRule, type PlaybookRow, type RequestRow, type RuleRow } from "./shared.ts";
import { InvalidQueryError, queryTerms, MAX_REQUIREMENTS_PER_DOCUMENT, MAX_PLAYBOOKS, MAX_RULES_PER_PLAYBOOK, type Requirement, type RequirementKind, type DocumentRecord, type DocumentMetadata, type DocumentReadPrecondition, type DocumentSummary, NATIVE_SNIPPET_MAX_CHARS, type WordSnapshot, type RevisionInfo, type Store, type IntegrationConnection, type IntegrationProvider, type JobRecord, type JobStatus, type JobKind } from "./types.ts";

const OPEN = "\u0002";
const CLOSE = "\u0003";
const ELLIPSIS = "…";

interface Row {
  id: string;
  title: string;
  content: string;
  version: number;
  content_hash: string;
  created_at: string;
  updated_at: string;
  template_provenance?: string | null;
  sample_key?: string | null;
  content_path?: string | null;
}

const toRecord = (r: Row): DocumentRecord => ({
  id: r.id,
  title: r.title,
  content: r.content,
  version: r.version,
  contentHash: r.content_hash,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  ...(r.template_provenance ? { templateProvenance: JSON.parse(r.template_provenance) } : {}),
  ...(r.sample_key ? { sample: true } : {}),
  ...(r.content_path ? { contentPath: r.content_path } : {}),
});

interface JobRow {id:string;idempotency_key:string;kind:JobKind;status:JobStatus;progress:number;result_ref:string|null;error_code:string|null;created_at:string;updated_at:string;expires_at:string|null;payload:string|null;output:string|null;checkpoint:string|null}
const toJob=(r:JobRow):JobRecord=>({id:r.id,idempotencyKey:r.idempotency_key,kind:r.kind,status:r.status,progress:r.progress,createdAt:r.created_at,updatedAt:r.updated_at,...(r.result_ref?{resultRef:r.result_ref}:{}),...(r.error_code?{errorCode:r.error_code}:{}),...(r.expires_at?{expiresAt:r.expires_at}:{}),...(r.payload?{payload:JobPayloadSchema.parse(JSON.parse(r.payload))}:{}),...(r.output?{output:JobOutputSchema.parse(JSON.parse(r.output))}:{}),...(r.checkpoint?{checkpoint:r.checkpoint}:{})});

const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(",");

/**
 * Plain text -> FTS5 query. Every term (or "quoted phrase") is emitted as an FTS5 phrase literal, so operators,
 * column filters, NEAR, `*` and `-` in user input are inert. Terms are implicitly ANDed.
 */
export function compileWordsQuery(q: string): string {
  const terms = queryTerms(q);
  if (terms.length === 0) throw new InvalidQueryError("Query is empty");
  return terms.map((t) => `"${t.replaceAll('"', '""')}"`).join(" ");
}

/** SQLite + FTS5. Synchronous underneath; the methods are async only to satisfy the shared interface. */
export function createSqliteStore(path: string): Store {
  return sqliteStore(openDb(path));
}

export function sqliteStore(db: Db): Store {
  const getDoc = (id: string): DocumentRecord | undefined => {
    const row = db.prepare("SELECT id, title, content, version, content_hash, created_at, updated_at, template_provenance, sample_key, content_path FROM documents WHERE id = ?").get(id);
    return row ? toRecord(row as unknown as Row) : undefined;
  };
  const getMetadata = (id:string):DocumentMetadata|undefined=>{
    const r=db.prepare(`SELECT id,title,version,content_hash,created_at,updated_at,template_provenance,sample_key,content_path,
      COALESCE(content_bytes,length(CAST(content AS BLOB))) AS byte_length,COALESCE(content_utf16,length(content)) AS utf16_length,word_count
      FROM documents WHERE id=?`).get(id) as {id:string;title:string;version:number;content_hash:string;created_at:string;updated_at:string;template_provenance:string|null;sample_key:string|null;content_path:string|null;byte_length:number;utf16_length:number;word_count:number|null}|undefined;
    if(!r)return undefined;
    return {id:r.id,title:r.title,version:r.version,contentHash:r.content_hash,createdAt:r.created_at,updatedAt:r.updated_at,byteLength:r.byte_length,utf16Length:r.utf16_length,...(r.word_count===null?{}:{wordCount:r.word_count}),
      ...(r.template_provenance?{templateProvenance:JSON.parse(r.template_provenance)}:{}),...(r.sample_key?{sample:true}:{}),...(r.content_path?{contentPath:r.content_path}:{})};
  };

  return {
    ...sqliteMaintenance(db),
    kind: "sqlite",
    maxContentChars: Number.POSITIVE_INFINITY,

    async insertDocument(input) {
      const now = new Date().toISOString();
      const id = `doc_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
      const hash = sha256(input.content);
      const stats = [Buffer.byteLength(input.content, "utf8"), input.content.length, countWords(input.content)] as const;
      return transaction(db, () => {
        const provenance = input.templateProvenance ? JSON.stringify(input.templateProvenance) : null;
        db.prepare("INSERT INTO documents (id, title, content, version, content_hash, created_at, updated_at, template_provenance, content_path, content_bytes, content_utf16, word_count) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, input.title, input.content, hash, now, now, provenance, input.contentPath ?? null, ...stats);
        db.prepare("INSERT INTO revisions (document_id, version, content, content_hash, summary, created_at, content_path, content_bytes, content_utf16, word_count) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, input.content, hash, JSON.stringify([{ created: true }]), now, input.contentPath ?? null, ...stats);
        return { id, title: input.title, content: input.content, version: 1, contentHash: hash, createdAt: now, updatedAt: now, ...(input.templateProvenance ? { templateProvenance: input.templateProvenance } : {}), ...(input.contentPath ? { contentPath: input.contentPath } : {}) };
      });
    },

    async insertDocumentWithRequirements(input) {
      if (input.requirements.length > MAX_REQUIREMENTS_PER_DOCUMENT) return undefined;
      const now = new Date().toISOString();
      const id = `doc_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
      const hash = sha256(input.content);
      const stats = [Buffer.byteLength(input.content, "utf8"), input.content.length, countWords(input.content)] as const;
      return transaction(db, () => {
        db.prepare("INSERT INTO documents (id, title, content, version, content_hash, created_at, updated_at, content_path, content_bytes, content_utf16, word_count) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)").run(id, input.title, input.content, hash, now, now, input.contentPath ?? null, ...stats);
        db.prepare("INSERT INTO revisions (document_id, version, content, content_hash, summary, created_at, content_path, content_bytes, content_utf16, word_count) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, input.content, hash, JSON.stringify([{ created: true }]), now, input.contentPath ?? null, ...stats);
        input.requirements.forEach((r, seq) => { db.prepare("INSERT INTO requirements (id, document_id, kind, text, created_at, seq) VALUES (?, ?, ?, ?, ?, ?)").run(`req_${randomUUID().replaceAll("-", "").slice(0, 12)}`, id, r.kind, r.text, now, seq + 1); });
        return getDoc(id)!;
      });
    },

    async insertImportedDocument(input) {
      return transaction(db, () => {
        if(input.jobId && !db.prepare("SELECT 1 FROM clause_jobs WHERE id=? AND status='running'").get(input.jobId)) throw new JobCancelledError();
        const prior = db.prepare("SELECT d.id FROM integration_imports i JOIN documents d ON d.id = i.document_id WHERE i.provider = ? AND i.file_id = ?").get(input.provider, input.fileId) as { id: string } | undefined;
        if (prior) return { doc: getDoc(prior.id)!, imported: false };
        const now = new Date().toISOString();
        const id = `doc_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
        const hash = sha256(input.content);
        const stats = [Buffer.byteLength(input.content, "utf8"), input.content.length, countWords(input.content)] as const;
        db.prepare("INSERT INTO documents (id, title, content, version, content_hash, created_at, updated_at, content_path, content_bytes, content_utf16, word_count) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)").run(id, input.title, input.content, hash, now, now, input.contentPath ?? null, ...stats);
        db.prepare("INSERT INTO revisions (document_id, version, content, content_hash, summary, created_at, content_path, content_bytes, content_utf16, word_count) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, input.content, hash, JSON.stringify([{ created: true, importedFrom: input.provider }]), now, input.contentPath ?? null, ...stats);
        db.prepare("INSERT INTO integration_imports (provider, file_id, document_id, imported_at) VALUES (?, ?, ?, ?)").run(input.provider, input.fileId, id, now);
        return { doc: getDoc(id)!, imported: true };
      });
    },

    async listIntegrationConnections() {
      const rows = db.prepare("SELECT provider, expires_at, account_name, connected_at FROM integration_connections ORDER BY provider").all() as unknown as { provider: IntegrationProvider; expires_at: string | null; account_name: string | null; connected_at: string }[];
      return rows.map((r) => ({ provider: r.provider, expiresAt: r.expires_at, accountName: r.account_name, connectedAt: r.connected_at }));
    },

    async getIntegrationConnection(provider) {
      const r = db.prepare("SELECT provider, access_token, refresh_token, expires_at, account_name, connected_at FROM integration_connections WHERE provider = ?").get(provider) as unknown as { provider: IntegrationProvider; access_token: string; refresh_token: string | null; expires_at: string | null; account_name: string | null; connected_at: string } | undefined;
      return r && { provider: r.provider, accessToken: r.access_token, refreshToken: r.refresh_token, expiresAt: r.expires_at, accountName: r.account_name, connectedAt: r.connected_at };
    },

    async saveIntegrationConnection(c: IntegrationConnection) {
      db.prepare("INSERT INTO integration_connections (provider, access_token, refresh_token, expires_at, account_name, connected_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(provider) DO UPDATE SET access_token = excluded.access_token, refresh_token = excluded.refresh_token, expires_at = excluded.expires_at, account_name = excluded.account_name, connected_at = excluded.connected_at").run(c.provider, c.accessToken, c.refreshToken, c.expiresAt, c.accountName, c.connectedAt);
    },

    async deleteIntegrationConnection(provider) {
      db.prepare("DELETE FROM integration_connections WHERE provider = ?").run(provider);
    },

    async getIntegrationImport(provider, fileId) {
      const r = db.prepare("SELECT provider, file_id, document_id, imported_at FROM integration_imports WHERE provider = ? AND file_id = ?").get(provider, fileId) as unknown as { provider: IntegrationProvider; file_id: string; document_id: string; imported_at: string } | undefined;
      return r && { provider: r.provider, fileId: r.file_id, documentId: r.document_id, importedAt: r.imported_at };
    },

    async getDocument(id) {
      return getDoc(id);
    },

    async getDocumentForEdit(id,precondition:DocumentReadPrecondition) {
      const row=db.prepare(`SELECT id,title,content,version,content_hash,created_at,updated_at,template_provenance,sample_key,content_path FROM documents
        WHERE id=? AND (? IS NULL OR version=?) AND (? IS NULL OR substr(content_hash,1,12)=?)`).get(id,precondition.expectedVersion??null,precondition.expectedVersion??null,precondition.contentHashPrefix??null,precondition.contentHashPrefix??null) as Row|undefined;
      if(row)return toRecord(row);
      return getMetadata(id);
    },

    async getDocumentMetadata(id): Promise<DocumentMetadata | undefined> {
      return getMetadata(id);
    },

    async listDocuments(limit, offset) {
      const rows = db
        .prepare(
          `SELECT id, title, version, content_hash, created_at, updated_at, sample_key, COALESCE(content_utf16,length(content)) AS size,
             COALESCE(content_bytes,length(CAST(content AS BLOB))) AS byte_length,COALESCE(content_utf16,length(content)) AS utf16_length,word_count
           FROM documents ORDER BY (sample_key IS NULL), created_at DESC, seq DESC LIMIT ? OFFSET ?`,
        )
        .all(limit, offset) as unknown as {id:string;title:string;version:number;content_hash:string;created_at:string;updated_at:string;sample_key:string|null;size:number;byte_length:number;utf16_length:number;word_count:number|null}[];
      const { n } = db.prepare("SELECT count(*) AS n FROM documents").get() as { n: number };
      const items: DocumentSummary[] = rows.map((r) => ({ id: r.id, title: r.title, version: r.version, contentHash: r.content_hash, createdAt: r.created_at, updatedAt: r.updated_at, size: r.size,byteLength:r.byte_length,utf16Length:r.utf16_length,...(r.word_count===null?{}:{wordCount:r.word_count}), ...(r.sample_key ? { sample: true } : {}) }));
      return { total: n, items };
    },

    async deleteDocument(id) {
      return transaction(db, () => db.prepare("DELETE FROM documents WHERE id = ?").run(id).changes === 1);
    },

    /** Compare-and-swap: the UPDATE only matches while the row is still at `expectedVersion`. Triggers keep both FTS indexes in step. */
    async commitRevision(args) {
      const now = new Date().toISOString();
      const hash = sha256(args.content);
      const next = args.expectedVersion + 1;
      return transaction(db, () => {
        const byteLength = Buffer.byteLength(args.content, "utf8");
        const utf16Length = args.content.length;
        const wordCount = countWords(args.content);
        const res = db.prepare("UPDATE documents SET content = ?, version = ?, content_hash = ?, updated_at = ?, content_path = ?, content_bytes = ?, content_utf16 = ?, word_count = ? WHERE id = ? AND version = ?").run(args.content, next, hash, now, args.contentPath ?? null, byteLength, utf16Length, wordCount, args.id, args.expectedVersion);
        if (res.changes !== 1) return "conflict" as const;
        db.prepare("INSERT INTO revisions (document_id, version, content, content_hash, summary, created_at, content_path, content_bytes, content_utf16, word_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(args.id, next, args.content, hash, args.summary, now, args.contentPath ?? null, byteLength, utf16Length, wordCount);
        return getDoc(args.id)!;
      });
    },

    async listRevisions(id) {
      const rows = db
        .prepare("SELECT version, content_hash, created_at, summary, content_path, COALESCE(content_bytes,length(CAST(content AS BLOB))) AS byte_length,COALESCE(content_utf16,length(content)) AS utf16_length,word_count FROM revisions WHERE document_id = ? ORDER BY version DESC")
        .all(id) as unknown as { version: number; content_hash: string; created_at: string; summary: string; content_path: string | null; byte_length:number; utf16_length:number; word_count:number|null }[];
      return rows.map((r): RevisionInfo => ({ version: r.version, contentHash: r.content_hash, createdAt: r.created_at, summary: JSON.parse(r.summary),byteLength:r.byte_length,utf16Length:r.utf16_length,...(r.word_count===null?{}:{wordCount:r.word_count}), ...(r.content_path ? { contentPath: r.content_path } : {}) }));
    },

    async getRevision(id, version) {
      const r = db
        .prepare("SELECT version, content, content_hash, created_at, summary, content_path FROM revisions WHERE document_id = ? AND version = ?")
        .get(id, version) as unknown as { version: number; content: string; content_hash: string; created_at: string; summary: string; content_path: string | null } | undefined;
      if (!r) return undefined;
      const content = r.content_path ? await readStoredContent(r.content_path) : r.content;
      if (sha256(content)!==r.content_hash) throw new Error("Stored revision hash mismatch");
      return {version:r.version,content,contentHash:r.content_hash,createdAt:r.created_at,summary:JSON.parse(r.summary),...(r.content_path?{contentPath:r.content_path}:{})};
    },

    async getRevisionMetadata(id, version) {
      const r = db.prepare("SELECT version,content_hash,created_at,summary,content_path,COALESCE(content_bytes,length(CAST(content AS BLOB))) AS byte_length,COALESCE(content_utf16,length(content)) AS utf16_length,word_count FROM revisions WHERE document_id = ? AND version = ?").get(id, version) as {version:number;content_hash:string;created_at:string;summary:string;content_path:string|null;byte_length:number;utf16_length:number;word_count:number|null}|undefined;
      return r && { version:r.version,contentHash:r.content_hash,createdAt:r.created_at,summary:JSON.parse(r.summary),byteLength:r.byte_length,utf16Length:r.utf16_length,...(r.word_count===null?{}:{wordCount:r.word_count}),...(r.content_path ? {contentPath:r.content_path} : {}) };
    },

    async createJob(input) {
      return transaction(db,()=>{
        const prior=db.prepare("SELECT * FROM clause_jobs WHERE idempotency_key=?").get(input.idempotencyKey) as JobRow|undefined;
        if(prior) return {job:toJob(prior),created:false};
        const {n}=db.prepare("SELECT count(*) AS n FROM clause_jobs WHERE status='queued'").get() as {n:number};
        if(n>=100) return undefined;
        const now=new Date().toISOString();
        const row:JobRow={id:`job_${randomUUID().replaceAll("-","")}`,idempotency_key:input.idempotencyKey,kind:input.kind,status:"queued",progress:0,result_ref:null,error_code:null,created_at:now,updated_at:now,expires_at:input.expiresAt??null,payload:input.payload?JSON.stringify(input.payload):null,output:null,checkpoint:null};
        db.prepare("INSERT INTO clause_jobs(id,idempotency_key,kind,status,created_at,updated_at,expires_at,payload) VALUES(?,?,?,'queued',?,?,?,?)").run(row.id,row.idempotency_key,row.kind,now,now,row.expires_at,row.payload);
        return {job:toJob(row),created:true};
      });
    },

    async listExpiredExports(limit) { return (db.prepare("SELECT * FROM clause_jobs WHERE kind='export' AND status='succeeded' AND expires_at<=? AND result_ref IS NOT NULL LIMIT ?").all(new Date().toISOString(),Math.min(100,limit)) as unknown as JobRow[]).map(toJob); },

    async listPendingJobs(limit) { return (db.prepare("SELECT * FROM clause_jobs WHERE status IN ('queued','running') ORDER BY created_at LIMIT ?").all(Math.min(100,limit)) as unknown as JobRow[]).map(toJob); },

    async getJob(id) {
      const row=db.prepare("SELECT * FROM clause_jobs WHERE id=?").get(id) as JobRow|undefined;
      return row&&toJob(row);
    },

    async claimJob(id,maxConcurrent) {
      return transaction(db,()=>{
        const row=db.prepare("SELECT status FROM clause_jobs WHERE id=?").get(id) as {status:JobStatus}|undefined;
        if(!row||row.status==="cancelled") return false;
        if(row.status==="running") return true;
        if(row.status!=="queued") return false;
        const {n}=db.prepare("SELECT count(*) AS n FROM clause_jobs WHERE status='running'").get() as {n:number};
        if(n>=maxConcurrent) return false;
        db.prepare("UPDATE clause_jobs SET status='running',updated_at=? WHERE id=? AND status='queued'").run(new Date().toISOString(),id);
        return true;
      });
    },

    async updateJob(id,patch) {
      db.prepare(`UPDATE clause_jobs SET status=COALESCE(?,status),progress=COALESCE(?,progress),
        result_ref=CASE WHEN ? THEN ? ELSE result_ref END,error_code=CASE WHEN ? THEN ? ELSE error_code END,
        expires_at=CASE WHEN ? THEN ? ELSE expires_at END,checkpoint=COALESCE(?,checkpoint),output=COALESCE(?,output),updated_at=? WHERE id=? AND status IN ('queued','running','succeeded')`).run(patch.status??null,patch.progress??null,Number("resultRef" in patch),patch.resultRef??null,Number("errorCode" in patch),patch.errorCode??null,Number("expiresAt" in patch),patch.expiresAt??null,patch.checkpoint??null,patch.output?JSON.stringify(patch.output):null,new Date().toISOString(),id);
      const row=db.prepare("SELECT * FROM clause_jobs WHERE id=?").get(id) as JobRow|undefined;
      return row&&toJob(row);
    },

    async completeJob(id,resultRef,expiresAt) {
      return db.prepare("UPDATE clause_jobs SET status='succeeded',progress=100,result_ref=?,expires_at=?,updated_at=? WHERE id=? AND status='running'").run(resultRef,expiresAt,new Date().toISOString(),id).changes===1;
    },

    async failJob(id,errorCode) {
      return db.prepare("UPDATE clause_jobs SET status='failed',error_code=?,updated_at=? WHERE id=? AND status='running'").run(errorCode,new Date().toISOString(),id).changes===1;
    },

    async cancelJob(id) {
      db.prepare("UPDATE clause_jobs SET status='cancelled',updated_at=? WHERE id=? AND status IN ('queued','running')").run(new Date().toISOString(),id);
      const row=db.prepare("SELECT * FROM clause_jobs WHERE id=?").get(id) as JobRow|undefined;
      return row&&toJob(row);
    },

    async wordsPage(query, { ids = [], limit, offset }) {
      const match = compileWordsQuery(query);
      const idFilter = ids.length ? `AND d.id IN (${placeholders(ids.length)})` : "";
      db.exec("BEGIN");
      try {
        const { n } = db.prepare(`SELECT count(*) AS n FROM documents_words JOIN documents d ON d.seq = documents_words.rowid WHERE documents_words MATCH ? ${idFilter}`).get(match, ...ids) as { n: number };
        const ranked = db.prepare(`SELECT d.id, d.title, d.version, length(d.content) AS size, bm25(documents_words, 5.0, 1.0) AS score
          FROM documents_words JOIN documents d ON d.seq = documents_words.rowid
          WHERE documents_words MATCH ? ${idFilter} ORDER BY score, d.seq LIMIT ? OFFSET ?`).all(match, ...ids, limit, offset) as unknown as Omit<WordSnapshot, "content">[];
        const snippetNeedle = queryTerms(query)[0]?.split(/\s+/)[0] ?? query;
        const items = ranked.map((r): WordSnapshot => {
          const isWindow = r.size > NATIVE_SNIPPET_MAX_CHARS;
          const content = isWindow
            ? (db.prepare("SELECT substr(content,max(1,instr(lower(content),lower(?))-200),400) AS content FROM documents WHERE id=?").get(snippetNeedle,r.id) as {content:string}|undefined)?.content ?? ""
            : getDoc(r.id)!.content;
          const snippet = !isWindow
            ? db.prepare(`SELECT snippet(documents_words, 1, '${OPEN}', '${CLOSE}', '${ELLIPSIS}', 24) AS snip
                FROM documents_words JOIN documents d ON d.seq = documents_words.rowid WHERE documents_words MATCH ? AND d.id = ?`).get(match, r.id) as { snip: string } | undefined
            : undefined;
          return { ...r, score: -r.score, content, ...(isWindow?{contentIsWindow:true}:{}), ...(snippet && { nativeSnippet: snippet.snip }) };
        });
        db.exec("COMMIT");
        return { total: n, items };
      } catch (e) {
        db.exec("ROLLBACK");
        if (e instanceof Error && /fts5|unterminated|syntax|malformed/i.test(e.message)) throw new InvalidQueryError(`Unsupported query: ${e.message}`);
        throw e;
      }
    },

    async exactPage(query, { ids = [], limit, offset, hitsPerDocument }) {
      const idFilter = ids.length ? `AND id IN (${placeholders(ids.length)})` : "";
      const params = [query, ...ids];
      const total = (db.prepare(`SELECT count(*) AS n FROM documents WHERE instr(content, ?) > 0 ${idFilter}`).get(...params) as { n: number }).n;
      const ranked = db.prepare(`SELECT id,title,version,content,
          (length(content)-length(replace(content, ?, '')))/length(?) AS match_count
        FROM documents WHERE instr(content, ?) > 0 ${idFilter}
        ORDER BY match_count DESC,title COLLATE NOCASE,title,seq LIMIT ? OFFSET ?`)
        .all(query, query, query, ...ids, limit, offset) as unknown as {id:string;title:string;version:number;content:string;match_count:number}[];
      return { total, items: ranked.map((row) => {
        const hits: {start:number;end:number;before:string;after:string}[] = [];
        for (let at = row.content.indexOf(query); at !== -1 && hits.length < hitsPerDocument; at = row.content.indexOf(query, at + query.length)) {
          hits.push({ start:at, end:at+query.length, before:row.content.slice(Math.max(0,at-60),at), after:row.content.slice(at+query.length,at+query.length+60) });
        }
        return {id:row.id,title:row.title,version:row.version,matchCount:Number(row.match_count),hits};
      }) };
    },

    async listRequirements(documentId) {
      const rows = db.prepare("SELECT id, document_id, kind, text, created_at FROM requirements WHERE document_id = ? ORDER BY seq").all(documentId) as unknown as { id: string; document_id: string; kind: RequirementKind; text: string; created_at: string }[];
      return rows.map((r): Requirement => ({ id: r.id, documentId: r.document_id, kind: r.kind, text: r.text, createdAt: r.created_at }));
    },

    async addRequirement(documentId, input) {
      const id = `req_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
      const now = new Date().toISOString();
      return transaction(db, () => {
        const count = Number((db.prepare("SELECT count(*) AS n FROM requirements WHERE document_id = ?").get(documentId) as { n: number }).n);
        if (count >= MAX_REQUIREMENTS_PER_DOCUMENT) return undefined;
        db.prepare("INSERT INTO requirements (id, document_id, kind, text, created_at, seq) VALUES (?, ?, ?, ?, ?, ?)").run(id, documentId, input.kind, input.text, now, count + 1);
        return { id, documentId, kind: input.kind, text: input.text, createdAt: now };
      });
    },

    async applyPlaybookRequirements(documentId, rules) {
      return transaction(db, () => {
        const haveRows = db.prepare("SELECT id, document_id, kind, text, created_at FROM requirements WHERE document_id = ? ORDER BY seq").all(documentId) as unknown as { id: string; document_id: string; kind: RequirementKind; text: string; created_at: string }[];
        const have = haveRows.map((r): Requirement => ({ id: r.id, documentId: r.document_id, kind: r.kind, text: r.text, createdAt: r.created_at }));
        const added: Requirement[] = [];
        const skipped: { title: string; reason: "duplicate" | "limit" }[] = [];
        for (const rule of rules) {
          if ([...have, ...added].some((r) => r.kind === rule.kind && r.text === rule.text)) { skipped.push({ title: rule.title, reason: "duplicate" }); continue; }
          if (have.length + added.length >= MAX_REQUIREMENTS_PER_DOCUMENT) { skipped.push({ title: rule.title, reason: "limit" }); continue; }
          const now = new Date().toISOString();
          const req = { id: `req_${randomUUID().replaceAll("-", "").slice(0, 12)}`, documentId, kind: rule.kind, text: rule.text, createdAt: now };
          db.prepare("INSERT INTO requirements (id, document_id, kind, text, created_at, seq) VALUES (?, ?, ?, ?, ?, ?)").run(req.id, documentId, req.kind, req.text, now, have.length + added.length + 1);
          added.push(req);
        }
        return { added, skipped };
      });
    },

    async deleteRequirement(documentId, id) {
      return db.prepare("DELETE FROM requirements WHERE document_id = ? AND id = ?").run(documentId, id).changes === 1;
    },

    async listRecentRevisions(limit) {
      const rows = db
        .prepare("SELECT r.document_id, d.title, r.version, r.content_hash, r.created_at, r.summary FROM revisions r JOIN documents d ON d.id = r.document_id ORDER BY r.created_at DESC, r.version DESC LIMIT ?")
        .all(limit) as unknown as { document_id: string; title: string; version: number; content_hash: string; created_at: string; summary: string }[];
      return rows.map((r) => ({ documentId: r.document_id, title: r.title, version: r.version, contentHash: r.content_hash, createdAt: r.created_at, summary: JSON.parse(r.summary) }));
    },

    async listRequests() {
      return (db.prepare(`SELECT ${REQUEST_COLUMNS} FROM requests ORDER BY updated_at DESC, seq DESC`).all() as unknown as RequestRow[]).map(toRequest);
    },

    async getRequest(id) {
      const r = db.prepare(`SELECT ${REQUEST_COLUMNS} FROM requests WHERE id = ?`).get(id) as unknown as RequestRow | undefined;
      return r && toRequest(r);
    },

    async insertRequest(input) {
      const id = newId("wrq");
      const now = new Date().toISOString();
      db.prepare("INSERT INTO requests (id, document_id, title, goal, status, priority, type, due_date, ci, created_at, updated_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM requests))").run(id, input.documentId, input.title, input.goal, input.status, input.priority, input.type, input.dueDate, now, now);
      return (await this.getRequest(id))!;
    },

    async updateRequest(id, patch) {
      const cols = requestPatchColumns(patch);
      const now = new Date().toISOString();
      const set = [...cols.map(([c]) => `${c} = ?`), "updated_at = ?"].join(", ");
      const res = db.prepare(`UPDATE requests SET ${set} WHERE id = ?`).run(...cols.map(([, v]) => v), now, id);
      return res.changes === 1 ? this.getRequest(id) : undefined;
    },

    async deleteRequest(id) {
      return db.prepare("DELETE FROM requests WHERE id = ?").run(id).changes === 1;
    },

    async listPlaybooks() {
      const rows = db.prepare("SELECT p.id, p.name, p.description, p.created_at, p.updated_at, (SELECT count(*) FROM playbook_rules r WHERE r.playbook_id = p.id) AS rule_count FROM playbooks p ORDER BY p.seq").all() as unknown as (PlaybookRow & { rule_count: number })[];
      return rows.map((r) => ({ ...toPlaybook(r), ruleCount: Number(r.rule_count) }));
    },

    async getPlaybook(id) {
      const p = db.prepare("SELECT id, name, description, created_at, updated_at FROM playbooks WHERE id = ?").get(id) as unknown as PlaybookRow | undefined;
      if (!p) return undefined;
      const rules = db.prepare("SELECT id, playbook_id, title, kind, text, created_at FROM playbook_rules WHERE playbook_id = ? ORDER BY seq").all(id) as unknown as RuleRow[];
      return { ...toPlaybook(p), rules: rules.map(toRule) };
    },

    async insertPlaybook(input) {
      const id = newId("pbk");
      const now = new Date().toISOString();
      return transaction(db, () => {
        if (Number((db.prepare("SELECT count(*) AS n FROM playbooks").get() as { n: number }).n) >= MAX_PLAYBOOKS) return undefined;
        db.prepare("INSERT INTO playbooks (id, name, description, created_at, updated_at, seq) VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM playbooks))").run(id, input.name, input.description, now, now);
        return { id, name: input.name, description: input.description, createdAt: now, updatedAt: now };
      });
    },

    async updatePlaybook(id, patch) {
      const now = new Date().toISOString();
      const cur = db.prepare("SELECT id, name, description, created_at, updated_at FROM playbooks WHERE id = ?").get(id) as unknown as PlaybookRow | undefined;
      if (!cur) return undefined;
      const name = patch.name ?? cur.name;
      const description = patch.description ?? cur.description;
      db.prepare("UPDATE playbooks SET name = ?, description = ?, updated_at = ? WHERE id = ?").run(name, description, now, id);
      return { id, name, description, createdAt: cur.created_at, updatedAt: now };
    },

    async deletePlaybook(id) {
      return db.prepare("DELETE FROM playbooks WHERE id = ?").run(id).changes === 1;
    },

    async addPlaybookRule(playbookId, input) {
      const id = newId("rul");
      const now = new Date().toISOString();
      return transaction(db, () => {
        if (!db.prepare("SELECT 1 FROM playbooks WHERE id = ?").get(playbookId)) return undefined;
        const count = Number((db.prepare("SELECT count(*) AS n FROM playbook_rules WHERE playbook_id = ?").get(playbookId) as { n: number }).n);
        if (count >= MAX_RULES_PER_PLAYBOOK) return undefined;
        db.prepare("INSERT INTO playbook_rules (id, playbook_id, title, kind, text, created_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, playbookId, input.title, input.kind, input.text, now, count + 1);
        db.prepare("UPDATE playbooks SET updated_at = ? WHERE id = ?").run(now, playbookId);
        return { id, playbookId, title: input.title, kind: input.kind, text: input.text, createdAt: now };
      });
    },

    async deletePlaybookRule(playbookId, ruleId) {
      return db.prepare("DELETE FROM playbook_rules WHERE playbook_id = ? AND id = ?").run(playbookId, ruleId).changes === 1;
    },

    async seedPlaybooksIfEmpty(items) {
      return transaction(db, () => {
        if ((db.prepare("SELECT count(*) AS n FROM playbooks").get() as { n: number }).n > 0) return 0;
        const now = new Date().toISOString();
        items.forEach((pb, i) => {
          const pid = newId("pbk");
          db.prepare("INSERT INTO playbooks (id, name, description, created_at, updated_at, seq) VALUES (?, ?, ?, ?, ?, ?)").run(pid, pb.name, pb.description, now, now, i + 1);
          for (const [j, r] of pb.rules.entries()) db.prepare("INSERT INTO playbook_rules (id, playbook_id, title, kind, text, created_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?)").run(newId("rul"), pid, r.title, r.kind, r.text, now, j + 1);
        });
        return items.length;
      });
    },

    async seedRequestsIfEmpty(items) {
      return transaction(db, () => {
        if ((db.prepare("SELECT count(*) AS n FROM requests").get() as { n: number }).n > 0) return 0;
        let n = 0;
        for (const it of items) {
          const doc = db.prepare("SELECT id FROM documents WHERE title = ? ORDER BY (sample_key IS NULL), seq LIMIT 1").get(it.documentTitle) as { id: string } | undefined;
          if (!doc) continue;
          const now = new Date(Date.now() - (items.length - n) * 3_600_000).toISOString();
          db.prepare("INSERT INTO requests (id, document_id, title, goal, status, priority, type, due_date, ci, created_at, updated_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)").run(newId("wrq"), doc.id, it.title, it.goal, it.status, it.priority, it.type, it.dueInDays === undefined ? null : dueIn(it.dueInDays), now, now, ++n);
        }
        return n;
      });
    },

    async ensureSamples(items) {
      const now = new Date().toISOString();
      return transaction(db, () => {
        let touched = 0;
        for (const item of items) {
          const key = sampleKeyOf(item.title);
          if (db.prepare("SELECT 1 FROM documents WHERE sample_key = ?").get(key)) continue;
          const hash = sha256(item.content);
          // A document with this title and exactly the canonical text is the sample already (the hosted database was
          // seeded before samples were marked): adopt it rather than create a duplicate.
          const same = db.prepare("SELECT id FROM documents WHERE title = ? AND content_hash = ? AND sample_key IS NULL ORDER BY seq LIMIT 1").get(item.title, hash) as { id: string } | undefined;
          if (same) {
            db.prepare("UPDATE documents SET sample_key = ? WHERE id = ?").run(key, same.id);
          } else {
            const id = `doc_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
            db.prepare("INSERT INTO documents (id, title, content, version, content_hash, created_at, updated_at, sample_key) VALUES (?, ?, ?, 1, ?, ?, ?, ?)").run(id, item.title, item.content, hash, now, now, key);
            db.prepare("INSERT INTO revisions (document_id, version, content, content_hash, summary, created_at) VALUES (?, 1, ?, ?, ?, ?)").run(id, item.content, hash, JSON.stringify([{ created: true }]), now);
          }
          touched++;
        }
        return touched;
      });
    },

    async checkReady() { db.prepare("SELECT 1").get(); },

    async close() {
      db.close();
    },
  };
}
