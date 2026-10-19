import pg from "pg";
import { recordDatabaseAcquire, recordDatabaseQuery } from "../telemetry.ts";

export async function acquirePool(pool:pg.Pool):Promise<pg.PoolClient> {
  const started=performance.now();
  try {const client=await pool.connect();recordDatabaseAcquire(performance.now()-started,false);return client;}
  catch(error) {recordDatabaseAcquire(performance.now()-started,true);throw error;}
}

export async function query<R extends pg.QueryResultRow=pg.QueryResultRow>(executor:pg.Pool|pg.PoolClient,config:string|pg.QueryConfig,values?:unknown[]):Promise<pg.QueryResult<R>> {
  const pooled=executor instanceof pg.Pool;
  const client=pooled?await acquirePool(executor):executor;
  const text=typeof config==="string"?config:config.text;
  const first=text.trimStart().split(/\s/,1)[0]?.toUpperCase();
  const operation=["SELECT","INSERT","UPDATE","DELETE","BEGIN","COMMIT","ROLLBACK","WITH"].includes(first??"")?first??"OTHER":"OTHER";
  const started=performance.now();
  let failed=false;
  try {return await client.query<R>(config,values);}
  catch(error) {failed=true;throw error;}
  finally {recordDatabaseQuery(operation,performance.now()-started,failed);if(pooled) client.release();}
}
