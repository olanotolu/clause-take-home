import { shutdownTelemetryBounded } from "./telemetry.ts";
import { buildApp } from "./app.ts";
import { lazyStoreFromEnv } from "./config.ts";
import { evaluatorFromEnv } from "./review/evaluator.ts";
import { providerFromEnv } from "./suggest.ts";

const port = Number(process.env.PORT ?? 3000);

// AI suggestions are optional: enabled only when credentials exist (OPENROUTER_API_KEY, or AI Gateway credentials).
// Everything else works without them.
const suggestionProvider = providerFromEnv(process.env);
const semanticEvaluator = evaluatorFromEnv(process.env);
// On Vercel, release idle database connections when the function instance is suspended.
const onPool = process.env.VERCEL ? (await import("@vercel/functions")).attachDatabasePool : undefined;
const store = lazyStoreFromEnv(process.env, { ...(onPool && { onPool }) });
const app = await buildApp({ store, logger: true, trustProxy: Boolean(process.env.VERCEL), ...(suggestionProvider && { suggestionProvider }), ...(semanticEvaluator && { semanticEvaluator }) });
app.log.info(`storage: ${store.kind}`);
app.log.info(semanticEvaluator ? `CLAUSE CI judges: ${semanticEvaluator.models.join(", ")}` : "CLAUSE CI judges: none (exact requirements only)");
app.log.info(suggestionProvider ? `AI suggestions enabled (${suggestionProvider.model})` : "AI suggestions disabled (no OPENROUTER_API_KEY or AI Gateway credentials)");
const listening = app.listen({ port, host: process.env.HOST ?? (process.env.VERCEL ? "0.0.0.0" : "127.0.0.1") });
if (process.env.VERCEL) {
  // Vercel's runtime takes over listen(); awaiting it here left the function waiting forever (requests hung until the
  // platform timed out). Don't block module startup on it there; still report a failure.
  listening.catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
} else {
  await listening; // locally, fail loudly (e.g. port already in use)
}

if(!process.env.VERCEL) {
  let closing=false;
  for(const signal of ["SIGINT","SIGTERM"] as const) process.once(signal,()=>{
    if(closing) return;
    closing=true;
    const deadline=setTimeout(()=>process.exit(1),5000);deadline.unref();
    void (async()=>{try {await app.close();} finally {await shutdownTelemetryBounded(1000);clearTimeout(deadline);process.exit(0);}})();
  });
}
