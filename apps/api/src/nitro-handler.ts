import { attachDatabasePool } from "@vercel/functions";
import type { IncomingMessage, ServerResponse } from "node:http";
import { buildApp } from "./app.ts";
import { lazyStoreFromEnv } from "./config.ts";
import { evaluatorFromEnv } from "./review/evaluator.ts";
import { providerFromEnv } from "./suggest.ts";

const store=lazyStoreFromEnv(process.env,process.env.VERCEL?{onPool:attachDatabasePool}:{});
const suggestionProvider=providerFromEnv(process.env);
const semanticEvaluator=evaluatorFromEnv(process.env);
const appPromise=buildApp({store,logger:process.env.NODE_ENV!=="production",trustProxy:Boolean(process.env.VERCEL),...(suggestionProvider ? {suggestionProvider} : {}),...(semanticEvaluator ? {semanticEvaluator} : {})});

export default async function handler(request:IncomingMessage,response:ServerResponse):Promise<void> {
  // Service rewrites retain the public prefix in Nitro request objects.
  if(request.url?.startsWith("/api/")) request.url=request.url.slice(4);
  else if(request.url==="/api") request.url="/";
  const app=await appPromise;
  await app.ready();
  app.server.emit("request",request,response);
}
