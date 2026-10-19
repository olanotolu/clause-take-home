import { WORD_SEARCH_SQL } from "./word-search-sql.ts";
import { query as dbQuery, acquirePool } from "./pg-query.ts";
import { postgresMaintenance } from "./maintenance-postgres.ts";
import { JobPayloadSchema, JobOutputSchema, JobCancelledError } from "../jobs/types.ts";
import { createHash, randomUUID } from "node:crypto";
import { countWords, sha256 } from "@clause/core";
import pg from "pg";
import { recordDatabaseQuery, registerPool } from "../telemetry.ts";
import { INLINE_CONTENT_BYTES, readStoredContent } from "../content-storage.ts";
import { dueIn, newId, REQUEST_COLUMNS, sampleKeyOf, requestPatchColumns, toPlaybook, toRequest, toRule, type PlaybookRow, type RequestRow, type RuleRow } from "./shared.ts";
import { ContentTooLargeError, InvalidQueryError, MAX_REQUIREMENTS_PER_DOCUMENT, MAX_PLAYBOOKS, MAX_RULES_PER_PLAYBOOK, type Requirement, type RequirementKind, type DocumentRecord, type DocumentMetadata, type DocumentReadPrecondition, type DocumentSummary, type WordSnapshot, type RevisionInfo, type Store, type IntegrationProvider, type JobRecord, type JobStatus, type JobKind } from "./types.ts";

/** Maximum UTF-8 document size. Search indexes bounded chunks rather than a whole-document tsvector. */
export const POSTGRES_MAX_CONTENT_CHARS = 25 * 1024 * 1024;
const LARGE_CONTENT_WRITE_TIMEOUT_MS = 120_000;

export interface PostgresOptions {
  connectionString: string;
  /** PEM certificate authority that signs the database's TLS certificate (Supabase: its own CA). Verification stays on. */
  ca?: string;
  /** Pool size. Keep it small for serverless: every warm instance holds its own pool. */
  max?: number;
  /** Tests give each test its own schema so they can run in parallel against one database. */
  schema?: string;
  /** Overrides the character cap (tests only, to exercise the database's own limit). */
  maxContentChars?: number;
  /** Drop `schema` on close (tests only). */
  dropSchemaOnClose?: boolean;
  /** Called with the pool right after creation (e.g. Vercel's attachDatabasePool). */
  onPool?: (pool: pg.Pool) => void;
  /** Request runtimes pass false and use `pnpm db:migrate` during deployment. Tests default to automatic migrations. */
  autoMigrate?: boolean;
}

const MIGRATIONS: string[] = [
  `
  CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA public;

  CREATE TABLE documents (
    seq          BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
    id           TEXT PRIMARY KEY,
    title        TEXT NOT NULL,
    content      TEXT NOT NULL,
    version      INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    -- Maintained by Postgres itself, inside the writing transaction: a reader can never see text and index disagree.
    search       TSVECTOR GENERATED ALWAYS AS (
      setweight(to_tsvector('english', title), 'A') || setweight(to_tsvector('english', content), 'D')
    ) STORED
  );
  CREATE INDEX documents_search_idx ON documents USING gin (search);
  CREATE INDEX documents_content_trgm_idx ON documents USING gin (content public.gin_trgm_ops);
  CREATE INDEX documents_created_idx ON documents (created_at DESC, seq DESC);

  CREATE TABLE revisions (
    document_id  TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    version      INTEGER NOT NULL,
    content      TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    summary      TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    PRIMARY KEY (document_id, version)
  );
  `,
  `
  CREATE TABLE requirements (
    id          TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL CHECK (kind IN ('present', 'absent', 'unchanged', 'semantic')),
    text        TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    seq         BIGINT GENERATED ALWAYS AS IDENTITY
  );
  CREATE INDEX requirements_document_idx ON requirements (document_id, seq);
  `,
  `
  CREATE TABLE requests (
    id          TEXT PRIMARY KEY,
    document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
    title       TEXT NOT NULL,
    goal        TEXT NOT NULL,
    status      TEXT NOT NULL CHECK (status IN ('inbox', 'in_progress', 'needs_review', 'completed')),
    priority    TEXT NOT NULL CHECK (priority IN ('low', 'medium', 'high')),
    type        TEXT NOT NULL CHECK (type IN ('NDA', 'Commercial', 'Employment', 'Data & Privacy', 'Other')),
    due_date    TEXT,
    ci          TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    seq         BIGINT GENERATED ALWAYS AS IDENTITY
  );
  CREATE INDEX requests_status_idx ON requests (status, updated_at DESC);

  CREATE TABLE playbooks (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    seq         BIGINT GENERATED ALWAYS AS IDENTITY
  );
  CREATE TABLE playbook_rules (
    id          TEXT PRIMARY KEY,
    playbook_id TEXT NOT NULL REFERENCES playbooks(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('present', 'absent', 'unchanged', 'semantic')),
    text        TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    seq         BIGINT GENERATED ALWAYS AS IDENTITY
  );
  CREATE INDEX playbook_rules_idx ON playbook_rules (playbook_id, seq);
  `,
  `
  CREATE TABLE integration_connections (
    provider TEXT PRIMARY KEY,
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    expires_at TEXT,
    account_name TEXT,
    connected_at TEXT NOT NULL
  );
  CREATE TABLE integration_imports (
    provider TEXT NOT NULL,
    file_id TEXT NOT NULL,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    imported_at TEXT NOT NULL,
    PRIMARY KEY (provider, file_id)
  );
  CREATE INDEX integration_imports_document_idx ON integration_imports (document_id);
  `,
  `ALTER TABLE documents ADD COLUMN template_provenance TEXT;`,
  `ALTER TABLE documents ADD COLUMN sample_key TEXT;
   CREATE UNIQUE INDEX documents_sample_key_idx ON documents (sample_key) WHERE sample_key IS NOT NULL;`,
  `CREATE TABLE document_chunks (
     document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
     chunk_no INTEGER NOT NULL,
     start_offset INTEGER NOT NULL,
     end_offset INTEGER NOT NULL,
     content TEXT NOT NULL,
     search TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
     PRIMARY KEY (document_id, chunk_no)
   );
   CREATE INDEX document_chunks_search_idx ON document_chunks USING gin (search);
   CREATE INDEX document_chunks_trgm_idx ON document_chunks USING gin (content public.gin_trgm_ops);
   INSERT INTO document_chunks (document_id, chunk_no, start_offset, end_offset, content)
   SELECT d.id, n - 1, (n - 1) * 8000, LEAST(n * 8000, length(d.content)), substring(d.content FROM (n - 1) * 8000 + 1 FOR 8000)
   FROM documents d CROSS JOIN LATERAL generate_series(1, GREATEST(1, ceil(length(d.content)::numeric / 8000)::integer)) n;
   DROP INDEX IF EXISTS documents_search_idx;
   ALTER TABLE documents DROP COLUMN search;
   ALTER TABLE documents ADD COLUMN content_path TEXT;
   CREATE UNIQUE INDEX documents_content_path_idx ON documents (content_path) WHERE content_path IS NOT NULL;
   ALTER TABLE revisions ADD COLUMN content_path TEXT;`,
  `ALTER TABLE documents ADD COLUMN content_bytes BIGINT;
   ALTER TABLE documents ADD COLUMN content_utf16 INTEGER;
   ALTER TABLE documents ADD COLUMN word_count INTEGER;
   ALTER TABLE revisions ADD COLUMN content_bytes BIGINT;
   ALTER TABLE revisions ADD COLUMN content_utf16 INTEGER;
   ALTER TABLE revisions ADD COLUMN word_count INTEGER;
   CREATE INDEX documents_title_trgm_idx ON documents USING gin (title public.gin_trgm_ops);`,
  `CREATE TABLE content_migration_checkpoints (
     name TEXT PRIMARY KEY,
     last_document_id TEXT NOT NULL,
     last_version INTEGER NOT NULL,
     updated_at TEXT NOT NULL
   );`,
  `ALTER TABLE documents ADD COLUMN title_search TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', title)) STORED;
   CREATE INDEX documents_title_search_idx ON documents USING gin (title_search);`,
  `CREATE TABLE clause_jobs (
     id TEXT PRIMARY KEY,
     idempotency_key TEXT NOT NULL UNIQUE,
     kind TEXT NOT NULL CHECK(kind IN ('export','provider_import','content_backfill','integrity_sweep','orphan_cleanup')),
     status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled')),
     progress INTEGER NOT NULL DEFAULT 0,
     result_ref TEXT,
     error_code TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     expires_at TEXT
   );
   CREATE INDEX clause_jobs_queue_idx ON clause_jobs(status,created_at);`,
  `ALTER TABLE document_chunks ADD COLUMN chunk_id TEXT;
   WITH ranked AS (
     SELECT document_id,chunk_no,md5(content) || ':' || row_number() OVER (PARTITION BY document_id,md5(content) ORDER BY chunk_no)::text AS stable_id
     FROM document_chunks
   )
   UPDATE document_chunks c SET chunk_id=ranked.stable_id FROM ranked WHERE c.document_id=ranked.document_id AND c.chunk_no=ranked.chunk_no;
   ALTER TABLE document_chunks ALTER COLUMN chunk_id SET NOT NULL;
   CREATE UNIQUE INDEX document_chunks_identity_idx ON document_chunks(document_id,chunk_id);`,
  `DROP INDEX IF EXISTS documents_content_trgm_idx;`,
  `ALTER TABLE clause_jobs ADD COLUMN payload TEXT;
   ALTER TABLE clause_jobs ADD COLUMN output TEXT;
   ALTER TABLE clause_jobs ADD COLUMN checkpoint TEXT;
   ALTER TABLE clause_jobs ADD COLUMN lease_owner TEXT;
   ALTER TABLE clause_jobs ADD COLUMN lease_until TEXT;
   CREATE TABLE content_recovery_manifests(path TEXT PRIMARY KEY, content_hash TEXT NOT NULL, proof_path TEXT NOT NULL);
   CREATE TABLE content_recovery_objects(manifest_path TEXT NOT NULL REFERENCES content_recovery_manifests(path),path TEXT NOT NULL,PRIMARY KEY(manifest_path,path));`,
  `CREATE FUNCTION clause_utf16_chars(value TEXT, units INTEGER) RETURNS INTEGER LANGUAGE plpgsql IMMUTABLE STRICT AS $$
   DECLARE lo INTEGER:=0; hi INTEGER:=LEAST(char_length(value),units); mid INTEGER; prefix TEXT; actual INTEGER;
   BEGIN
     IF value !~ ('['||chr(65536)||'-'||chr(1114111)||']') THEN RETURN hi; END IF;
     WHILE lo<hi LOOP
       mid:=(lo+hi)/2; prefix:=substring(value FROM 1 FOR mid);
       actual:=char_length(prefix)+char_length(regexp_replace(prefix,'[^'||chr(65536)||'-'||chr(1114111)||']','','g'));
       IF actual<units THEN lo:=mid+1; ELSE hi:=mid; END IF;
     END LOOP;
     RETURN lo;
   END $$;`,
  `ALTER TABLE document_chunks ADD COLUMN core_content TEXT;`,
];

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
  ...(r.template_provenance ? { templateProvenance: typeof r.template_provenance === "string" ? JSON.parse(r.template_provenance) : r.template_provenance } : {}),
  ...(r.sample_key ? { sample: true } : {}),
  ...(r.content_path ? { contentPath: r.content_path } : {}),
});

async function hydrateRecord(r: Row): Promise<DocumentRecord> {
  const record = toRecord(r);
  if (!r.content_path) return record;
  const content = await readStoredContent(r.content_path);
  if (sha256(content) !== r.content_hash) throw new Error(`Stored content hash mismatch for document ${r.id}`);
  return { ...record, content };
}

interface JobRow {id:string;idempotency_key:string;kind:JobKind;status:JobStatus;progress:number;result_ref:string|null;error_code:string|null;created_at:string;updated_at:string;expires_at:string|null;payload:string|null;output:string|null;checkpoint:string|null}
const toJob=(r:JobRow):JobRecord=>({id:r.id,idempotencyKey:r.idempotency_key,kind:r.kind,status:r.status,progress:r.progress,createdAt:r.created_at,updatedAt:r.updated_at,...(r.result_ref?{resultRef:r.result_ref}:{}),...(r.error_code?{errorCode:r.error_code}:{}),...(r.expires_at?{expiresAt:r.expires_at}:{}),...(r.payload?{payload:JobPayloadSchema.parse(JSON.parse(r.payload))}:{}),...(r.output?{output:JobOutputSchema.parse(JSON.parse(r.output))}:{}),...(r.checkpoint?{checkpoint:r.checkpoint}:{})});

const DOC_COLUMNS = "id, title, content, version, content_hash, created_at, updated_at, template_provenance, sample_key, content_path";

/**
 * Plain text -> tsquery text. Every word is emitted as a quoted literal and a "quoted phrase" becomes a `<->`
 * chain, so operators in user input (`&`, `|`, `!`, `:*`, parentheses) are inert; only letters and digits survive.
 * Terms are ANDed. `to_tsquery('english', ...)` then stems each word, as the index did.
 */
export function toTsQuery(q: string): string {
  const parts=[...q.matchAll(/"([^"]*)"|(\S+)/g)].map((match)=>{
    const phrase=match[1]!==undefined;
    const raw=phrase?match[1]!:match[2]!;
    const lits=(raw.match(/[\p{L}\p{N}]+/gu)??[]).map((w)=>`'${w}'`);
    if(!lits.length) return undefined;
    return phrase||lits.length>1?(lits.length===1?lits[0]:`(${lits.join(" <-> ")})`):lits[0];
  }).filter((part):part is string=>part!==undefined);
  if(!parts.length) throw new InvalidQueryError("Query has no searchable words");
  return parts.join(" & ");
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, "\\$&");

const SEARCH_CONTEXT = 200;
const chunkText = (content: string) => {
  const out: { no: number; id:string; start: number; end: number; text: string; core:string }[] = [];
  const occurrences=new Map<string,number>();
  let start=0;
  while(start<content.length || (content.length===0 && out.length===0)) {
    let end=Math.min(start+8000,content.length);
    if(end<content.length) {
      // Search only within this chunk's latter half. A full-prefix lastIndexOf scans the entire document for every
      // chunk when a long body has no paragraph breaks, turning a 25 MiB import into quadratic work.
      const minimum=start+4000;
      const tail=content.slice(minimum,end);
      const paragraph=tail.lastIndexOf("\n\n");
      const whitespace=Math.max(tail.lastIndexOf(" "),tail.lastIndexOf("\n"));
      const boundary=paragraph>=0 ? minimum+paragraph+2 : whitespace>=0 ? minimum+whitespace+1 : end;
      end=boundary;
      if(end>start && /[\uD800-\uDBFF]/.test(content[end-1]!)) end++;
    }
    const searchStart=Math.max(0,start-SEARCH_CONTEXT);
    const searchEnd=Math.min(content.length,end+SEARCH_CONTEXT);
    const text=content.slice(searchStart,searchEnd);
    const hash=createHash("md5").update(text).digest("hex");
    const occurrence=(occurrences.get(hash)??0)+1;
    occurrences.set(hash,occurrence);
    out.push({no:out.length,id:`${hash}:${occurrence}`,start,end,text,core:content.slice(start,end)});
    if(content.length===0) break;
    start=end;
  }
  return out;
};

/** Bound both protocol row count and encoded text volume for every index write. */
async function insertChunkRows(c: pg.PoolClient, documentId: string, chunks: ReturnType<typeof chunkText>): Promise<void> {
  let batch: typeof chunks = [];
  let bytes = Buffer.byteLength(documentId)+64;
  const flush = async () => {
    if (batch.length === 0) return;
    const ids = batch.map((x) => x.no);
    const identities=batch.map((x)=>x.id);
    const starts = batch.map((x) => x.start);
    const ends = batch.map((x) => x.end);
    const texts = batch.map((x) => x.text);
    const cores=batch.map((x)=>x.core);
    await dbQuery(c,{
      text:`INSERT INTO document_chunks (document_id, chunk_no, start_offset, end_offset, content,chunk_id,core_content)
       SELECT $1, x.chunk_no, x.start_offset, x.end_offset, x.content,x.chunk_id,x.core_content
       FROM unnest($2::integer[], $3::integer[], $4::integer[], $5::text[],$6::text[],$7::text[])
         AS x(chunk_no, start_offset, end_offset, content,chunk_id,core_content)`,
      values:[documentId, ids, starts, ends, texts,identities,cores],query_timeout:LARGE_CONTENT_WRITE_TIMEOUT_MS} as pg.QueryConfig & {query_timeout:number});
    batch = [];
    bytes = Buffer.byteLength(documentId)+64;
  };
  for (const chunk of chunks) {
    const chunkBytes=Buffer.byteLength(JSON.stringify([chunk.text,chunk.core,chunk.id,chunk.start,chunk.end,chunk.no]))+64;
    if (batch.length >= 256 || (batch.length > 0 && bytes + chunkBytes > 2 * 1024 * 1024)) await flush();
    batch.push(chunk);
    bytes += chunkBytes;
  }
  await flush();
}

async function insertChunks(c:pg.PoolClient,documentId:string,content:string):Promise<void>{await insertChunkRows(c,documentId,chunkText(content));}

async function syncChunks(c:pg.PoolClient,documentId:string,content:string,previousContent?:string):Promise<void>{
  const next=chunkText(content);
  const previous=previousContent===undefined
    ? (await dbQuery<{chunk_id:string;chunk_no:number;start_offset:number;end_offset:number}>(c,"SELECT chunk_id,chunk_no,start_offset,end_offset FROM document_chunks WHERE document_id=$1",[documentId])).rows
    : chunkText(previousContent).map((x)=>({chunk_id:x.id,chunk_no:x.no,start_offset:x.start,end_offset:x.end}));
  const identities=new Set(next.map((x)=>x.id));
  const removed=previous.map((x)=>x.chunk_id).filter((id)=>!identities.has(id));
  if(removed.length) await dbQuery(c,"DELETE FROM document_chunks WHERE document_id=$1 AND chunk_id=ANY($2::text[])",[documentId,removed]);
  const existing=new Map(previous.map((x)=>[x.chunk_id,x]));
  const moved=next.filter((x)=>{const old=existing.get(x.id);return old&&old.chunk_no!==x.no;});
  const repositioned=next.filter((x)=>{const old=existing.get(x.id);return old&&(old.chunk_no!==x.no||old.start_offset!==x.start||old.end_offset!==x.end);});
  for(let i=0;i<moved.length;i+=256){
    const page=moved.slice(i,i+256);
    await dbQuery(c,"UPDATE document_chunks SET chunk_no=-chunk_no-1 WHERE document_id=$1 AND chunk_id=ANY($2::text[])",[documentId,page.map((x)=>x.id)]);
  }
  await insertChunkRows(c,documentId,next.filter((x)=>!existing.has(x.id)));
  for(let i=0;i<repositioned.length;i+=256){
    const page=repositioned.slice(i,i+256);
    await dbQuery(c,`UPDATE document_chunks c SET chunk_no=x.chunk_no,start_offset=x.start_offset,end_offset=x.end_offset
      FROM unnest($1::text[],$2::integer[],$3::integer[],$4::integer[]) AS x(chunk_id,chunk_no,start_offset,end_offset)
      WHERE c.document_id=$5 AND c.chunk_id=x.chunk_id`,[page.map((x)=>x.id),page.map((x)=>x.no),page.map((x)=>x.start),page.map((x)=>x.end),documentId]);
  }
}

/** Applies pending migrations under an advisory lock, so two cold starts can't race each other. */
export async function migratePostgresPool(pool: pg.Pool): Promise<void> {
  const client = await acquirePool(pool);
  try {
    await dbQuery(client,"BEGIN");
    await dbQuery(client,"SELECT pg_advisory_xact_lock(727274)");
    await dbQuery(client,"CREATE TABLE IF NOT EXISTS clause_meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)");
    const cur = Number((await dbQuery(client,"SELECT v FROM clause_meta WHERE k = 'schema_version'")).rows[0]?.v ?? 0);
    for (let v = cur; v < MIGRATIONS.length; v++) await dbQuery(client,MIGRATIONS[v]!);
    await dbQuery(client,"INSERT INTO clause_meta (k, v) VALUES ('schema_version', $1) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v", [MIGRATIONS.length]);
    await dbQuery(client,"COMMIT");
  } catch (e) {
    await dbQuery(client,"ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

async function fetchRequest(pool: pg.Pool, id: string) {
  const r = (await dbQuery<RequestRow>(pool,`SELECT ${REQUEST_COLUMNS} FROM requests WHERE id = $1`, [id])).rows[0];
  return r && toRequest(r);
}

/** TLS settings for every pool: the CA when one is given, otherwise the connection string's own sslmode decides. */
const tls = (ca?: string) => (ca ? { ssl: { ca, rejectUnauthorized: true } } : {});

export async function createPostgresStore(opts: PostgresOptions): Promise<Store> {
  const schema = opts.schema;
  if (schema !== undefined && !/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error(`invalid schema name: ${schema}`);

  if (schema && opts.autoMigrate !== false) {
    const boot = new pg.Pool({ connectionString: opts.connectionString, max: 1, ...tls(opts.ca) });
    await dbQuery(boot,`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await boot.end();
  }
  const pool = new pg.Pool({
    connectionString: opts.connectionString,
    ...tls(opts.ca),
    max: opts.max ?? 5,
    connectionTimeoutMillis: 2_000,
    statement_timeout: 15_000,
    query_timeout: 20_000,
    ...(schema && { options: `-c search_path=${schema},public` }),
  });
  // pg emits idle-client socket errors at the pool level. Without a listener Node treats the event as
  // uncaughtException and the instance dies before liveness/readiness can respond during a DB outage.
  pool.on("error",()=>recordDatabaseQuery("pool_idle_client",0,true));
  opts.onPool?.(pool);
  const unregisterPool=registerPool({kind:"postgres",get waitingCount(){return pool.waitingCount;},get totalCount(){return pool.totalCount;},get idleCount(){return pool.idleCount;},lockWaits:async()=>Number((await pool.query({text:"SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND usename=current_user AND wait_event_type='Lock'",query_timeout:1000} as pg.QueryConfig & {query_timeout:number})).rows[0]?.n??0)});
  if (opts.autoMigrate !== false) await migratePostgresPool(pool);

  async function insertWith(c: pg.PoolClient, input: { title: string; content: string; contentPath?: string; templateProvenance?: import("./types.ts").TemplateProvenance; sampleKey?: string }): Promise<DocumentRecord> {
    const now = new Date().toISOString();
    const id = `doc_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const hash = sha256(input.content);
    const byteLength = Buffer.byteLength(input.content, "utf8");
    const wordCount = countWords(input.content);
    const inlineContent = input.contentPath ? "" : input.content;
    await contentWrite(c,"INSERT INTO documents (id, title, content, version, content_hash, created_at, updated_at, template_provenance, sample_key, content_path, content_bytes, content_utf16, word_count) VALUES ($1, $2, $3, 1, $4, $5, $5, $6, $7, $8, $9, $10, $11)", [id, input.title, inlineContent, hash, now, input.templateProvenance ? JSON.stringify(input.templateProvenance) : null, input.sampleKey ?? null, input.contentPath ?? null, byteLength, input.content.length, wordCount]);
    await insertChunks(c, id, input.content);
    await contentWrite(c,"INSERT INTO revisions (document_id, version, content, content_hash, summary, created_at, content_path, content_bytes, content_utf16, word_count) VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9)", [id, inlineContent, hash, JSON.stringify([{ created: true }]), now, input.contentPath ?? null, byteLength, input.content.length, wordCount]);
    return { id, title: input.title, content: input.content, version: 1, contentHash: hash, createdAt: now, updatedAt: now, ...(input.templateProvenance ? { templateProvenance: input.templateProvenance } : {}), ...(input.sampleKey ? { sample: true } : {}), ...(input.contentPath ? { contentPath: input.contentPath } : {}) };
  }

  /** Runs `fn` on one connection inside a transaction. */
  async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>, begin = "BEGIN", statementTimeoutMs?: number): Promise<T> {
    const client = await acquirePool(pool);
    try {
      await dbQuery(client,begin);
      if (statementTimeoutMs) await dbQuery(client,"SELECT set_config('statement_timeout',$1,true)",[`${statementTimeoutMs}ms`]);
      const out = await fn(client);
      await dbQuery(client,"COMMIT");
      return out;
    } catch (e) {
      await dbQuery(client,"ROLLBACK").catch(() => undefined);
      // 54000 = program_limit_exceeded: "string is too long for tsvector". Report it as what it is, not as a crash.
      if ((e as { code?: string }).code === "54000") throw new ContentTooLargeError("text exceeds the full-text index limit");
      throw e;
    } finally {
      client.release();
    }
  }

  const contentWrite = (client:pg.PoolClient,text:string,values:unknown[]):Promise<pg.QueryResult> =>
    dbQuery(client,{text,values,query_timeout:LARGE_CONTENT_WRITE_TIMEOUT_MS} as pg.QueryConfig & {query_timeout:number}) as unknown as Promise<pg.QueryResult>;

  async function readDocumentMetadata(id:string):Promise<DocumentMetadata|undefined> {
    const r=(await dbQuery<{id:string;title:string;version:number;content_hash:string;created_at:string;updated_at:string;template_provenance:string|null;sample_key:string|null;content_path:string|null;byte_length:string;utf16_length:string;word_count:number|null}>(pool,
      `SELECT id,title,version,content_hash,created_at,updated_at,template_provenance,sample_key,content_path,
        COALESCE(content_bytes,octet_length(content)) AS byte_length,COALESCE(content_utf16,length(content)) AS utf16_length,word_count
       FROM documents WHERE id=$1`,[id])).rows[0];
    if(!r)return undefined;
    return {id:r.id,title:r.title,version:r.version,contentHash:r.content_hash,createdAt:r.created_at,updatedAt:r.updated_at,byteLength:Number(r.byte_length),utf16Length:Number(r.utf16_length),wordCount:r.word_count??0,
      ...(r.template_provenance?{templateProvenance:typeof r.template_provenance==="string"?JSON.parse(r.template_provenance):r.template_provenance}:{}),...(r.sample_key?{sample:true}:{}),...(r.content_path?{contentPath:r.content_path}:{})};
  }

  return {
    ...postgresMaintenance(pool,tx),
    kind: "postgres",
    maxContentChars: opts.maxContentChars ?? POSTGRES_MAX_CONTENT_CHARS,

    async insertDocument(input) {
      const large=Buffer.byteLength(input.content,"utf8")>INLINE_CONTENT_BYTES;
      return tx((c) => insertWith(c, input),"BEGIN",large?LARGE_CONTENT_WRITE_TIMEOUT_MS:undefined);
    },

    async insertDocumentWithRequirements(input) {
      if (input.requirements.length > MAX_REQUIREMENTS_PER_DOCUMENT) return undefined;
      const large=Buffer.byteLength(input.content,"utf8")>INLINE_CONTENT_BYTES;
      return tx(async (c) => {
        const doc = await insertWith(c, { title: input.title, content: input.content, ...(input.contentPath && { contentPath: input.contentPath }) });
        for (const r of input.requirements) await dbQuery(c,"INSERT INTO requirements (id, document_id, kind, text, created_at) VALUES ($1, $2, $3, $4, $5)", [`req_${randomUUID().replaceAll("-", "").slice(0, 12)}`, doc.id, r.kind, r.text, new Date().toISOString()]);
        return doc;
      },"BEGIN",large?LARGE_CONTENT_WRITE_TIMEOUT_MS:undefined);
    },

    async insertImportedDocument(input) {
      const large=Buffer.byteLength(input.content,"utf8")>INLINE_CONTENT_BYTES;
      return tx(async (c) => {
        if(input.jobId && !(await dbQuery(c,"SELECT 1 FROM clause_jobs WHERE id=$1 AND status='running' FOR UPDATE",[input.jobId])).rowCount) throw new JobCancelledError();
        const lock = `${input.provider}:${input.fileId}`;
        await dbQuery(c,"SELECT pg_advisory_xact_lock(hashtext($1))", [lock]);
        const prior = (await dbQuery<{ id: string }>(c,"SELECT d.id FROM integration_imports i JOIN documents d ON d.id = i.document_id WHERE i.provider = $1 AND i.file_id = $2", [input.provider, input.fileId])).rows[0];
        if (prior) {
          const r = (await dbQuery<Row>(c,`SELECT ${DOC_COLUMNS} FROM documents WHERE id = $1`, [prior.id])).rows[0]!;
          return { doc: await hydrateRecord(r), imported: false };
        }
        const doc = await insertWith(c, input);
        await dbQuery(c,"INSERT INTO integration_imports (provider, file_id, document_id, imported_at) VALUES ($1, $2, $3, $4)", [input.provider, input.fileId, doc.id, new Date().toISOString()]);
        return { doc, imported: true };
      },"BEGIN",large?LARGE_CONTENT_WRITE_TIMEOUT_MS:undefined);
    },

    async listIntegrationConnections() {
      const rows = await dbQuery<{ provider: IntegrationProvider; expires_at: string | null; account_name: string | null; connected_at: string }>(pool,"SELECT provider, expires_at, account_name, connected_at FROM integration_connections ORDER BY provider");
      return rows.rows.map((r) => ({ provider: r.provider, expiresAt: r.expires_at, accountName: r.account_name, connectedAt: r.connected_at }));
    },

    async getIntegrationConnection(provider) {
      const r = (await dbQuery<{ provider: IntegrationProvider; access_token: string; refresh_token: string | null; expires_at: string | null; account_name: string | null; connected_at: string }>(pool,"SELECT provider, access_token, refresh_token, expires_at, account_name, connected_at FROM integration_connections WHERE provider = $1", [provider])).rows[0];
      return r && { provider: r.provider, accessToken: r.access_token, refreshToken: r.refresh_token, expiresAt: r.expires_at, accountName: r.account_name, connectedAt: r.connected_at };
    },

    async saveIntegrationConnection(c) {
      await dbQuery(pool,"INSERT INTO integration_connections (provider, access_token, refresh_token, expires_at, account_name, connected_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT(provider) DO UPDATE SET access_token = excluded.access_token, refresh_token = excluded.refresh_token, expires_at = excluded.expires_at, account_name = excluded.account_name, connected_at = excluded.connected_at", [c.provider, c.accessToken, c.refreshToken, c.expiresAt, c.accountName, c.connectedAt]);
    },

    async deleteIntegrationConnection(provider) {
      await dbQuery(pool,"DELETE FROM integration_connections WHERE provider = $1", [provider]);
    },

    async getIntegrationImport(provider, fileId) {
      const r = (await dbQuery<{ provider: IntegrationProvider; file_id: string; document_id: string; imported_at: string }>(pool,"SELECT provider, file_id, document_id, imported_at FROM integration_imports WHERE provider = $1 AND file_id = $2", [provider, fileId])).rows[0];
      return r && { provider: r.provider, fileId: r.file_id, documentId: r.document_id, importedAt: r.imported_at };
    },

    async getDocument(id) {
      const r = await dbQuery<Row>(pool,`SELECT ${DOC_COLUMNS} FROM documents WHERE id = $1`, [id]);
      return r.rows[0] && hydrateRecord(r.rows[0]);
    },

    async getDocumentForEdit(id,precondition:DocumentReadPrecondition) {
      const r=await dbQuery<Row>(pool,`SELECT ${DOC_COLUMNS} FROM documents
        WHERE id=$1 AND ($2::integer IS NULL OR version=$2) AND ($3::text IS NULL OR left(content_hash,12)=$3)`,
        [id,precondition.expectedVersion??null,precondition.contentHashPrefix??null]);
      if(r.rows[0])return hydrateRecord(r.rows[0]);
      return readDocumentMetadata(id);
    },

    async getDocumentMetadata(id) {
      return readDocumentMetadata(id);
    },

    async listDocuments(limit, offset) {
      const rows = await dbQuery<Omit<Row, "content"> & { size: number; byte_length:string; utf16_length:string; word_count:number|null }>(pool,
        `SELECT id, title, version, content_hash, created_at, updated_at, sample_key, COALESCE(content_utf16,length(content)) AS size,
          COALESCE(content_bytes,octet_length(content)) AS byte_length,COALESCE(content_utf16,length(content)) AS utf16_length,word_count
         FROM documents ORDER BY (sample_key IS NULL), created_at DESC, seq DESC LIMIT $1 OFFSET $2`,
        [limit, offset],
      );
      const total = Number((await dbQuery<{ n: string }>(pool,"SELECT count(*) AS n FROM documents")).rows[0]!.n);
      const items: DocumentSummary[] = rows.rows.map((r) => ({ id: r.id, title: r.title, version: r.version, contentHash: r.content_hash, createdAt: r.created_at, updatedAt: r.updated_at, ...(r.sample_key ? { sample: true } : {}), size: Number(r.size),byteLength:Number(r.byte_length),utf16Length:Number(r.utf16_length),wordCount:r.word_count??0 }));
      return { total, items };
    },

    async deleteDocument(id) {
      return (await dbQuery(pool,"DELETE FROM documents WHERE id = $1", [id])).rowCount === 1;
    },

    /** Compare-and-swap: text, revision, and chunk indexes commit together. */
    async commitRevision(args) {
      const now = new Date().toISOString();
      const hash = sha256(args.content);
      const next = args.expectedVersion + 1;
      const large=Buffer.byteLength(args.content,"utf8")>INLINE_CONTENT_BYTES;
      return tx(async (c) => {
        const before=await dbQuery<{version:number}>(c,"SELECT version FROM documents WHERE id=$1 FOR UPDATE",[args.id]);
        if(before.rowCount!==1||before.rows[0]!.version!==args.expectedVersion) return "conflict" as const;
        const inlineContent = args.contentPath ? "" : args.content;
        const res = await contentWrite(c,
          `UPDATE documents SET content = $1, version = $2, content_hash = $3, updated_at = $4, content_path = $5, content_bytes = $8, content_utf16 = $9, word_count = $10 WHERE id = $6 AND version = $7 RETURNING ${DOC_COLUMNS}`,
          [inlineContent, next, hash, now, args.contentPath ?? null, args.id, args.expectedVersion, Buffer.byteLength(args.content, "utf8"), args.content.length, countWords(args.content)],
        );
        if (res.rowCount !== 1) return "conflict" as const;
        await syncChunks(c, args.id, args.content,args.previousContent);
        await contentWrite(c,"INSERT INTO revisions (document_id, version, content, content_hash, summary, created_at, content_path, content_bytes, content_utf16, word_count) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)", [args.id, next, inlineContent, hash, args.summary, now, args.contentPath ?? null, Buffer.byteLength(args.content, "utf8"), args.content.length, countWords(args.content)]);
        return { ...toRecord(res.rows[0]!), content: args.content };
      },"BEGIN",large?LARGE_CONTENT_WRITE_TIMEOUT_MS:undefined);
    },

    async listRevisions(id) {
      const r = await dbQuery<{ version: number; content_hash: string; created_at: string; summary: string; content_path: string | null; byte_length:string; utf16_length:string; word_count:number|null }>(pool,"SELECT version, content_hash, created_at, summary, content_path, COALESCE(content_bytes,octet_length(content)) AS byte_length, COALESCE(content_utf16,length(content)) AS utf16_length, word_count FROM revisions WHERE document_id = $1 ORDER BY version DESC", [id]);
      return r.rows.map((x): RevisionInfo => ({ version: x.version, contentHash: x.content_hash, createdAt: x.created_at, summary: JSON.parse(x.summary), byteLength:Number(x.byte_length),utf16Length:Number(x.utf16_length),wordCount:x.word_count ?? 0, ...(x.content_path ? { contentPath: x.content_path } : {}) }));
    },

    async getRevision(id, version) {
      const r = await dbQuery<{ version: number; content: string; content_hash: string; created_at: string; summary: string; content_path: string | null }>(pool,"SELECT version, content, content_hash, created_at, summary, content_path FROM revisions WHERE document_id = $1 AND version = $2", [id, version]);
      const x = r.rows[0];
      if (!x) return undefined;
      if (x.content_path) {
        const content = await readStoredContent(x.content_path);
        if (sha256(content) !== x.content_hash) throw new Error(`Stored content hash mismatch for revision ${id} v${version}`);
        return { version:x.version,content,contentHash:x.content_hash,createdAt:x.created_at,summary:JSON.parse(x.summary),contentPath:x.content_path };
      }
      return { version: x.version, content: x.content, contentHash: x.content_hash, createdAt: x.created_at, summary: JSON.parse(x.summary) };
    },

    async getRevisionMetadata(id, version) {
      const x = (await dbQuery<{version:number;content_hash:string;created_at:string;summary:string;content_path:string|null;byte_length:string;utf16_length:string;word_count:number|null}>(pool,"SELECT version, content_hash, created_at, summary, content_path, COALESCE(content_bytes,octet_length(content)) AS byte_length, COALESCE(content_utf16,length(content)) AS utf16_length, word_count FROM revisions WHERE document_id = $1 AND version = $2", [id, version])).rows[0];
      return x && { version:x.version,contentHash:x.content_hash,createdAt:x.created_at,summary:JSON.parse(x.summary),byteLength:Number(x.byte_length),utf16Length:Number(x.utf16_length),wordCount:x.word_count ?? 0,...(x.content_path ? {contentPath:x.content_path} : {}) };
    },

    async createJob(input) {
      return tx(async(c)=>{
        await dbQuery(c,"SELECT pg_advisory_xact_lock(727276)");
        const prior=(await dbQuery<JobRow>(c,"SELECT * FROM clause_jobs WHERE idempotency_key=$1",[input.idempotencyKey])).rows[0];
        if(prior) return {job:toJob(prior),created:false};
        const queued=Number((await dbQuery<{n:string}>(c,"SELECT count(*) AS n FROM clause_jobs WHERE status='queued'")).rows[0]!.n);
        if(queued>=100) return undefined;
        const now=new Date().toISOString();
        const id=`job_${randomUUID().replaceAll("-","")}`;
        const row=(await dbQuery<JobRow>(c,"INSERT INTO clause_jobs(id,idempotency_key,kind,status,created_at,updated_at,expires_at,payload) VALUES($1,$2,$3,'queued',$4,$4,$5,$6) RETURNING *",[id,input.idempotencyKey,input.kind,now,input.expiresAt??null,input.payload?JSON.stringify(input.payload):null])).rows[0]!;
        return {job:toJob(row),created:true};
      });
    },

    async listExpiredExports(limit) { return (await dbQuery<JobRow>(pool,"SELECT * FROM clause_jobs WHERE kind='export' AND status='succeeded' AND expires_at<=$1 AND result_ref IS NOT NULL LIMIT $2",[new Date().toISOString(),Math.min(100,limit)])).rows.map(toJob); },

    async listPendingJobs(limit) { return (await dbQuery<JobRow>(pool,"SELECT * FROM clause_jobs WHERE status IN ('queued','running') ORDER BY created_at LIMIT $1",[Math.min(100,limit)])).rows.map(toJob); },

    async getJob(id) {
      const row=(await dbQuery<JobRow>(pool,"SELECT * FROM clause_jobs WHERE id=$1",[id])).rows[0];
      return row&&toJob(row);
    },

    async claimJob(id,maxConcurrent) {
      return tx(async(c)=>{
        await dbQuery(c,"SELECT pg_advisory_xact_lock(727277)");
        const row=(await dbQuery<{status:JobStatus}>(c,"SELECT status FROM clause_jobs WHERE id=$1",[id])).rows[0];
        if(!row||row.status==="cancelled") return false;
        if(row.status==="running") return true;
        if(row.status!=="queued") return false;
        const running=Number((await dbQuery<{n:string}>(c,"SELECT count(*) AS n FROM clause_jobs WHERE status='running'")).rows[0]!.n);
        if(running>=maxConcurrent) return false;
        await dbQuery(c,"UPDATE clause_jobs SET status='running',updated_at=$2 WHERE id=$1 AND status='queued'",[id,new Date().toISOString()]);
        return true;
      });
    },

    async updateJob(id,patch) {
      const row=(await dbQuery<JobRow>(pool,`UPDATE clause_jobs SET
        status=COALESCE($2,status),progress=COALESCE($3,progress),
        result_ref=CASE WHEN $4 THEN $5 ELSE result_ref END,
        error_code=CASE WHEN $6 THEN $7 ELSE error_code END,
        expires_at=CASE WHEN $8 THEN $9 ELSE expires_at END,updated_at=$10,checkpoint=COALESCE($11,checkpoint),output=COALESCE($12,output)
        WHERE id=$1 AND status IN ('queued','running','succeeded') RETURNING *`,[id,patch.status??null,patch.progress??null,"resultRef" in patch,patch.resultRef??null,"errorCode" in patch,patch.errorCode??null,"expiresAt" in patch,patch.expiresAt??null,new Date().toISOString(),patch.checkpoint??null,patch.output?JSON.stringify(patch.output):null])).rows[0];
      return row&&toJob(row);
    },

    async completeJob(id,resultRef,expiresAt) {
      return (await dbQuery(pool,"UPDATE clause_jobs SET status='succeeded',progress=100,result_ref=$2,expires_at=$3,updated_at=$4 WHERE id=$1 AND status='running'",[id,resultRef,expiresAt,new Date().toISOString()])).rowCount===1;
    },

    async failJob(id,errorCode) {
      return (await dbQuery(pool,"UPDATE clause_jobs SET status='failed',error_code=$2,updated_at=$3 WHERE id=$1 AND status='running'",[id,errorCode,new Date().toISOString()])).rowCount===1;
    },

    async cancelJob(id) {
      const row=(await dbQuery<JobRow>(pool,"UPDATE clause_jobs SET status='cancelled',updated_at=$2 WHERE id=$1 AND status IN ('queued','running') RETURNING *",[id,new Date().toISOString()])).rows[0];
      return row&&toJob(row);
    },

    async wordsPage(query, { ids = [], limit, offset }) {
      const terms=[...query.matchAll(/"([^"]*)"|(\S+)/g)].map((m)=>toTsQuery(m[1]!==undefined?`"${m[1]}"`:m[2]!));
      if(!terms.length)throw new InvalidQueryError("Query has no searchable words");
      // Start from GIN matches. Repeated boilerplate often has identical vectors;
      // rank each distinct vector once and keep its earliest chunk for snippets.
      const rows=await dbQuery<WordSnapshot & {total:string}>(pool,WORD_SEARCH_SQL,[terms,ids,terms.length,limit,offset]);
      return {total:Number(rows.rows[0]?.total??0),items:rows.rows.filter(r=>r.id!==null).map(({total:_total,...r})=>({...r,size:Number(r.size),score:Number(r.score),...(r.contentOffset!==null?{contentOffset:Number(r.contentOffset)}:{})}))};
    },

    async exactPage(query, { ids = [], limit, offset, hitsPerDocument }) {
      return tx(async (client) => {
        const params: unknown[] = [query];
        let filter = "";
        if (ids.length) { params.push(ids); filter = `AND d.id = ANY($${params.length})`; }
        // Aggregate cores inside Postgres before counting. This preserves the
        // non-overlap phase and matches that cross a chunk boundary, including
        // non-BMP characters, without sending candidate bodies to Node.
        const coreStart="clause_utf16_chars(c.content,LEAST(c.start_offset,200))";
        const coreEnd="clause_utf16_chars(c.content,LEAST(c.start_offset,200)+c.end_offset-c.start_offset)";
        const core=`COALESCE(c.core_content,substring(c.content FROM ${coreStart}+1 FOR ${coreEnd}-${coreStart}))`;
        const bodies=`WITH bodies AS (SELECT d.id,d.title,d.version,d.seq,
          CASE WHEN d.content<>'' THEN d.content ELSE (SELECT string_agg(${core},'' ORDER BY c.chunk_no) FROM document_chunks c WHERE c.document_id=d.id) END AS body
          FROM documents d WHERE TRUE ${filter})`;
        const countExpr="(length(b.body)-length(replace(b.body,$1,'')))/char_length($1)";
        const count=await dbQuery<{n:string}>(client,`${bodies} SELECT count(*) AS n FROM bodies b WHERE ${countExpr}>0`,params.slice(0,ids.length?2:1));
        params.push(limit,offset);
        const page=await dbQuery<{id:string;title:string;version:number;match_count:string}>(client,
          `${bodies} SELECT b.id,b.title,b.version,${countExpr} AS match_count FROM bodies b WHERE ${countExpr}>0
           ORDER BY match_count DESC,b.title COLLATE "en-US-x-icu",b.seq LIMIT $${params.length-1} OFFSET $${params.length}`,params);
        if (!page.rows.length) return {total:Number(count.rows[0]!.n),items:[]};
        const pageIds = page.rows.map((r)=>r.id);
        const chunks = await dbQuery<{document_id:string;content:string;start_offset:number;end_offset:number}>(client,
          `SELECT c.document_id,c.content,c.start_offset,c.end_offset FROM unnest($1::text[]) AS page(id)
           CROSS JOIN LATERAL (SELECT document_id,content,start_offset,end_offset FROM document_chunks
             WHERE document_id=page.id AND content LIKE $2 ESCAPE '\\' ORDER BY chunk_no LIMIT 16) c
           ORDER BY c.document_id,c.start_offset`, [pageIds,`%${escapeLike(query)}%`]);
        const byId = new Map<string, typeof chunks.rows>();
        for (const c of chunks.rows) { const list=byId.get(c.document_id)??[]; if(list.length<16) list.push(c); byId.set(c.document_id,list); }
        const items=page.rows.map((r)=>{
          const hits:{start:number;end:number;before:string;after:string}[]=[];
          for(const c of byId.get(r.id)??[]) {
            const base=Math.max(0,c.start_offset-SEARCH_CONTEXT);
            for(let at=c.content.indexOf(query);at!==-1&&hits.length<hitsPerDocument;at=c.content.indexOf(query,at+query.length)) {
              const start=base+at;
              if(start<c.start_offset||start>=c.end_offset) continue;
              hits.push({start,end:start+query.length,before:c.content.slice(Math.max(0,at-60),at),after:c.content.slice(at+query.length,at+query.length+60)});
            }
            if(hits.length>=hitsPerDocument) break;
          }
          return {id:r.id,title:r.title,version:r.version,matchCount:Number(r.match_count),hits};
        });
        return {total:Number(count.rows[0]!.n),items};
      },"BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    },

    async listRequirements(documentId) {
      const r = await dbQuery<{ id: string; document_id: string; kind: RequirementKind; text: string; created_at: string }>(pool,"SELECT id, document_id, kind, text, created_at FROM requirements WHERE document_id = $1 ORDER BY seq", [documentId]);
      return r.rows.map((x): Requirement => ({ id: x.id, documentId: x.document_id, kind: x.kind, text: x.text, createdAt: x.created_at }));
    },

    async addRequirement(documentId, input) {
      const id = `req_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
      const now = new Date().toISOString();
      return tx(async (c) => {
        if (!(await dbQuery(c,"SELECT id FROM documents WHERE id = $1 FOR UPDATE", [documentId])).rowCount) return undefined;
        const count = Number((await dbQuery<{ n: string }>(c,"SELECT count(*) AS n FROM requirements WHERE document_id = $1", [documentId])).rows[0]!.n);
        if (count >= MAX_REQUIREMENTS_PER_DOCUMENT) return undefined;
        await dbQuery(c,"INSERT INTO requirements (id, document_id, kind, text, created_at) VALUES ($1, $2, $3, $4, $5)", [id, documentId, input.kind, input.text, now]);
        return { id, documentId, kind: input.kind, text: input.text, createdAt: now };
      });
    },

    async applyPlaybookRequirements(documentId, rules) {
      return tx(async (c) => {
        if (!(await dbQuery(c,"SELECT id FROM documents WHERE id = $1 FOR UPDATE", [documentId])).rowCount) return { added: [], skipped: rules.map((r) => ({ title: r.title, reason: "limit" as const })) };
        const rows = (await dbQuery<{ id: string; document_id: string; kind: RequirementKind; text: string; created_at: string }>(c,"SELECT id, document_id, kind, text, created_at FROM requirements WHERE document_id = $1 ORDER BY seq", [documentId])).rows;
        const have = rows.map((r): Requirement => ({ id: r.id, documentId: r.document_id, kind: r.kind, text: r.text, createdAt: r.created_at }));
        const added: Requirement[] = [];
        const skipped: { title: string; reason: "duplicate" | "limit" }[] = [];
        for (const rule of rules) {
          if ([...have, ...added].some((r) => r.kind === rule.kind && r.text === rule.text)) { skipped.push({ title: rule.title, reason: "duplicate" }); continue; }
          if (have.length + added.length >= MAX_REQUIREMENTS_PER_DOCUMENT) { skipped.push({ title: rule.title, reason: "limit" }); continue; }
          const now = new Date().toISOString();
          const req = { id: `req_${randomUUID().replaceAll("-", "").slice(0, 12)}`, documentId, kind: rule.kind, text: rule.text, createdAt: now };
          await dbQuery(c,"INSERT INTO requirements (id, document_id, kind, text, created_at) VALUES ($1, $2, $3, $4, $5)", [req.id, documentId, req.kind, req.text, now]);
          added.push(req);
        }
        return { added, skipped };
      });
    },

    async deleteRequirement(documentId, id) {
      return (await dbQuery(pool,"DELETE FROM requirements WHERE document_id = $1 AND id = $2", [documentId, id])).rowCount === 1;
    },

    async listRecentRevisions(limit) {
      const r = await dbQuery<{ document_id: string; title: string; version: number; content_hash: string; created_at: string; summary: string }>(pool,
        "SELECT r.document_id, d.title, r.version, r.content_hash, r.created_at, r.summary FROM revisions r JOIN documents d ON d.id = r.document_id ORDER BY r.created_at DESC, r.version DESC LIMIT $1",
        [limit],
      );
      return r.rows.map((x) => ({ documentId: x.document_id, title: x.title, version: x.version, contentHash: x.content_hash, createdAt: x.created_at, summary: JSON.parse(x.summary) }));
    },

    async listRequests() {
      return (await dbQuery<RequestRow>(pool,`SELECT ${REQUEST_COLUMNS} FROM requests ORDER BY updated_at DESC, seq DESC`)).rows.map(toRequest);
    },

    async getRequest(id) {
      return fetchRequest(pool, id);
    },

    async insertRequest(input) {
      const id = newId("wrq");
      const now = new Date().toISOString();
      await dbQuery(pool,"INSERT INTO requests (id, document_id, title, goal, status, priority, type, due_date, ci, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9, $9)", [id, input.documentId, input.title, input.goal, input.status, input.priority, input.type, input.dueDate, now]);
      return (await fetchRequest(pool, id))!;
    },

    async updateRequest(id, patch) {
      const cols = requestPatchColumns(patch);
      const now = new Date().toISOString();
      const set = [...cols.map(([c], i) => `${c} = $${i + 1}`), `updated_at = $${cols.length + 1}`].join(", ");
      const res = await dbQuery(pool,`UPDATE requests SET ${set} WHERE id = $${cols.length + 2}`, [...cols.map(([, v]) => v), now, id]);
      return res.rowCount === 1 ? fetchRequest(pool, id) : undefined;
    },

    async deleteRequest(id) {
      return (await dbQuery(pool,"DELETE FROM requests WHERE id = $1", [id])).rowCount === 1;
    },

    async listPlaybooks() {
      const r = await dbQuery<PlaybookRow & { rule_count: string }>(pool,"SELECT p.id, p.name, p.description, p.created_at, p.updated_at, (SELECT count(*) FROM playbook_rules r WHERE r.playbook_id = p.id) AS rule_count FROM playbooks p ORDER BY p.seq");
      return r.rows.map((x) => ({ ...toPlaybook(x), ruleCount: Number(x.rule_count) }));
    },

    async getPlaybook(id) {
      const p = (await dbQuery<PlaybookRow>(pool,"SELECT id, name, description, created_at, updated_at FROM playbooks WHERE id = $1", [id])).rows[0];
      if (!p) return undefined;
      const rules = (await dbQuery<RuleRow>(pool,"SELECT id, playbook_id, title, kind, text, created_at FROM playbook_rules WHERE playbook_id = $1 ORDER BY seq", [id])).rows;
      return { ...toPlaybook(p), rules: rules.map(toRule) };
    },

    async insertPlaybook(input) {
      const id = newId("pbk");
      const now = new Date().toISOString();
      return tx(async (c) => {
        await dbQuery(c,"SELECT pg_advisory_xact_lock(727275)");
        const count = Number((await dbQuery<{ n: string }>(c,"SELECT count(*) AS n FROM playbooks")).rows[0]!.n);
        if (count >= MAX_PLAYBOOKS) return undefined;
        await dbQuery(c,"INSERT INTO playbooks (id, name, description, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)", [id, input.name, input.description, now]);
        return { id, name: input.name, description: input.description, createdAt: now, updatedAt: now };
      });
    },

    async updatePlaybook(id, patch) {
      const cur = (await dbQuery<PlaybookRow>(pool,"SELECT id, name, description, created_at, updated_at FROM playbooks WHERE id = $1", [id])).rows[0];
      if (!cur) return undefined;
      const now = new Date().toISOString();
      const name = patch.name ?? cur.name;
      const description = patch.description ?? cur.description;
      await dbQuery(pool,"UPDATE playbooks SET name = $1, description = $2, updated_at = $3 WHERE id = $4", [name, description, now, id]);
      return { id, name, description, createdAt: cur.created_at, updatedAt: now };
    },

    async deletePlaybook(id) {
      return (await dbQuery(pool,"DELETE FROM playbooks WHERE id = $1", [id])).rowCount === 1;
    },

    async addPlaybookRule(playbookId, input) {
      return tx(async (c) => {
        if (!(await dbQuery(c,"SELECT id FROM playbooks WHERE id = $1 FOR UPDATE", [playbookId])).rowCount) return undefined;
        const count = Number((await dbQuery<{ n: string }>(c,"SELECT count(*) AS n FROM playbook_rules WHERE playbook_id = $1", [playbookId])).rows[0]!.n);
        if (count >= MAX_RULES_PER_PLAYBOOK) return undefined;
        const now = new Date().toISOString();
        const touched = await dbQuery(c,"UPDATE playbooks SET updated_at = $1 WHERE id = $2", [now, playbookId]);
        if (touched.rowCount !== 1) return undefined;
        const id = newId("rul");
        await dbQuery(c,"INSERT INTO playbook_rules (id, playbook_id, title, kind, text, created_at) VALUES ($1, $2, $3, $4, $5, $6)", [id, playbookId, input.title, input.kind, input.text, now]);
        return { id, playbookId, title: input.title, kind: input.kind, text: input.text, createdAt: now };
      });
    },

    async deletePlaybookRule(playbookId, ruleId) {
      return (await dbQuery(pool,"DELETE FROM playbook_rules WHERE playbook_id = $1 AND id = $2", [playbookId, ruleId])).rowCount === 1;
    },

    async seedPlaybooksIfEmpty(items) {
      return tx(async (c) => {
        await dbQuery(c,"SELECT pg_advisory_xact_lock(727276)");
        if (Number((await dbQuery<{ n: string }>(c,"SELECT count(*) AS n FROM playbooks")).rows[0]!.n) > 0) return 0;
        const now = new Date().toISOString();
        for (const pb of items) {
          const pid = newId("pbk");
          await dbQuery(c,"INSERT INTO playbooks (id, name, description, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)", [pid, pb.name, pb.description, now]);
          for (const r of pb.rules) await dbQuery(c,"INSERT INTO playbook_rules (id, playbook_id, title, kind, text, created_at) VALUES ($1, $2, $3, $4, $5, $6)", [newId("rul"), pid, r.title, r.kind, r.text, now]);
        }
        return items.length;
      });
    },

    async seedRequestsIfEmpty(items) {
      return tx(async (c) => {
        await dbQuery(c,"SELECT pg_advisory_xact_lock(727277)");
        if (Number((await dbQuery<{ n: string }>(c,"SELECT count(*) AS n FROM requests")).rows[0]!.n) > 0) return 0;
        let n = 0;
        for (const it of items) {
          const doc = (await dbQuery<{ id: string }>(c,"SELECT id FROM documents WHERE title = $1 ORDER BY (sample_key IS NULL), seq LIMIT 1", [it.documentTitle])).rows[0];
          if (!doc) continue;
          const now = new Date(Date.now() - (items.length - n) * 3_600_000).toISOString();
          n++;
          await dbQuery(c,"INSERT INTO requests (id, document_id, title, goal, status, priority, type, due_date, ci, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9, $9)", [newId("wrq"), doc.id, it.title, it.goal, it.status, it.priority, it.type, it.dueInDays === undefined ? null : dueIn(it.dueInDays), now]);
        }
        return n;
      });
    },

    /** An advisory lock makes "is it empty? then fill it" atomic across instances: exactly one cold start seeds. */
    async ensureSamples(items) {
      return tx(async (c) => {
        await dbQuery(c,"SELECT pg_advisory_xact_lock(727275)");
        let touched = 0;
        for (const item of items) {
          const key = sampleKeyOf(item.title);
          if ((await dbQuery(c,"SELECT 1 FROM documents WHERE sample_key = $1", [key])).rowCount) continue;
          // An unmarked document with this title and exactly the canonical text is the sample already (the hosted
          // database was seeded before samples were marked): adopt it rather than create a duplicate.
          const same = (await dbQuery<{ id: string }>(c,"SELECT id FROM documents WHERE title = $1 AND content_hash = $2 AND sample_key IS NULL ORDER BY seq LIMIT 1", [item.title, sha256(item.content)])).rows[0];
          if (same) await dbQuery(c,"UPDATE documents SET sample_key = $1 WHERE id = $2", [key, same.id]);
          else await insertWith(c, { ...item, sampleKey: key });
          touched++;
        }
        return touched;
      });
    },

    async checkReady() {
      const row = (await dbQuery<{ v: number }>(pool,`SELECT v FROM ${schema?`${schema}.`:""}clause_meta WHERE k = 'schema_version'`)).rows[0];
      if (!row || Number(row.v) < MIGRATIONS.length) throw new Error("database migrations are pending");
      await dbQuery(pool,"SELECT 1");
    },

    async close() {
      unregisterPool();
      await pool.end();
      if (schema && opts.dropSchemaOnClose) {
        const boot = new pg.Pool({ connectionString: opts.connectionString, max: 1, ...tls(opts.ca) });
        await dbQuery(boot,`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await boot.end();
      }
    },
  };
}
