import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { WORD_SEARCH_SQL } from "../../apps/api/src/store/word-search-sql.ts";

const url=process.env.CLAUSE_LOAD_DATABASE_URL??process.env.DATABASE_URL_UNPOOLED;
const schema=process.env.CLAUSE_DATABASE_SCHEMA;
if(!url||!schema||!/^[a-z_][a-z0-9_]*$/.test(schema))throw new Error("Supply an unpooled disposable CLAUSE_LOAD_DATABASE_URL and CLAUSE_DATABASE_SCHEMA");
const require=createRequire(new URL("../../apps/api/package.json",import.meta.url));
const {default:pg}=await import(require.resolve("pg"));
const pool=new pg.Pool({connectionString:url,max:1,connectionTimeoutMillis:2000,statement_timeout:15000,options:`-c search_path=${schema},public`});
type Plan={"Node Type":string;"Index Name"?:string;"Actual Rows":number;"Actual Loops":number;"Actual Total Time":number;"Sort Space Type"?:string;"Sort Space Used"?:number;Plans?:Plan[]};
function summarize(plan:Plan):unknown {return {node:plan["Node Type"],...(plan["Index Name"]?{index:plan["Index Name"]}:{}),rows:plan["Actual Rows"],loops:plan["Actual Loops"],ms:plan["Actual Total Time"],...(plan["Sort Space Type"]?{sortSpace:plan["Sort Space Type"],sortKiB:plan["Sort Space Used"]}:{}),children:plan.Plans?.map(summarize)??[]};}
try {
  await pool.query("BEGIN READ ONLY");
  const result=await pool.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${WORD_SEARCH_SQL}`,[["'confidentiality'"],[],1,10,0]);
  const plan=result.rows[0]["QUERY PLAN"][0];
  await pool.query("ROLLBACK");
  const report={generatedAt:new Date().toISOString(),node:process.version,query:"Common-word search; fictional benchmark documents",planningMs:plan["Planning Time"],executionMs:plan["Execution Time"],plan:summarize(plan.Plan)};
  const output=process.argv[2]??"/tmp/clause-query-plan.json";await writeFile(output,JSON.stringify(report,null,2));console.log(JSON.stringify({output,executionMs:report.executionMs}));
} finally {await pool.end();}
