import { z } from "zod";
import { SEED_DOCUMENTS } from "../seed-data.ts";
import { TemplateOut, errors } from "../schemas.ts";
import type { App } from "../types.ts";

type Category = z.infer<typeof TemplateOut>["category"];

const categoryOf = (title: string): Category => {
  const t = title.toLowerCase();
  if (t.includes("nda") || t.includes("non-disclosure")) return "NDA";
  if (t.includes("employee") || t.includes("employment")) return "Employment";
  if (t.includes("data processing")) return "Data & Privacy";
  return "Commercial";
};

const slug = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const TEMPLATES = SEED_DOCUMENTS.map((d) => ({ id: slug(d.title), title: d.title, category: categoryOf(d.title), content: d.content }));

/**
 * Starting points for new documents: the fictional sample contracts that ship with the app. Read-only and static;
 * "using" one is just POST /documents with its text, so it goes through the normal create path and its limits.
 */
export function registerTemplateRoutes(app: App): void {
  app.get("/templates", { schema: { response: { 200: z.object({ items: z.array(TemplateOut) }), ...errors(500) } } }, async () => ({ items: TEMPLATES }));
}
