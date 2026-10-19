import { sha256 } from "@clause/core";
import { readStoredContent, removeStoredContent, verifyIntent } from "../content-storage.ts";
import { AI_REQUEST_TIMEOUT_MS } from "../ai-deadline.ts";
import { runCi } from "../review/runner.ts";
import type { SemanticEvaluator } from "../review/types.ts";
import { CheckBody, CiReportOut, IdParams, errors } from "../schemas.ts";
import type { App } from "../types.ts";

export function registerCheckRoutes(app: App, semantic: SemanticEvaluator, limit: { max: number; timeWindow: string }, timeoutMs = AI_REQUEST_TIMEOUT_MS): void {
  /**
   * CLAUSE CI: preview the edit, then run the document's requirements (and the optional goal) against the current and
   * the proposed text. Read-only: nothing is saved, and the report only informs; committing is still PATCH.
   */
  app.post(
    "/documents/:id/changes/check",
    { config: { rateLimit: limit }, schema: { params: IdParams, body: CheckBody, response: { 200: CiReportOut, ...errors(400, 404, 409, 412, 413, 422, 429, 500) } } },
    async (req, reply) => {
      let path:string|undefined;
      try {
        let changes=req.body.changes;
        if(req.body.uploadedContent) {
          const claim=await verifyIntent(req.body.uploadedContent.intent);
          if(claim.op!=="preview"||claim.id!==req.params.id||claim.version!==req.body.expectedVersion)return reply.code(400).send({error:"The preview upload does not match this document version",code:400,type:"UPLOAD_OPERATION_MISMATCH"});
          path=claim.path;
          const content=await readStoredContent(path,process.env,false);
          if(Buffer.byteLength(content)!==claim.size||sha256(content)!==req.body.uploadedContent.sha256){await removeStoredContent(path);path=undefined;return reply.code(422).send({error:"Uploaded preview failed integrity verification",code:422,type:"UPLOAD_HASH_MISMATCH"});}
          const doc=await app.store.getDocument(req.params.id);
          if(!doc){await removeStoredContent(path);path=undefined;return reply.problem({type:"DOCUMENT_NOT_FOUND",id:req.params.id});}
          changes=[{operation:"replace",target:{position:{start:0,end:doc.content.length,expectedText:doc.content}},replacement:content}];
        }
        const r = await runCi(app.store, req.params.id, { ...req.body,changes,ifMatch: req.headers["if-match"], signal: AbortSignal.timeout(timeoutMs) }, semantic);
        if (!r.ok) {if(path&&!await app.store.isContentReferenced(path))await removeStoredContent(path);path=undefined;return reply.problem(r.error);}
        return r.value;
      } finally {if(path&&!await app.store.isContentReferenced(path))await removeStoredContent(path).catch(()=>undefined);}
    },
  );
}
