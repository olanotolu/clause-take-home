import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.ts";

export async function testApp(opts: { bodyLimit?: number } = {}): Promise<FastifyInstance> {
  return buildApp({ dbPath: ":memory:", ...opts });
}

export async function createDoc(app: FastifyInstance, title: string, content: string) {
  const res = await app.inject({ method: "POST", url: "/documents", payload: { title, content } });
  if (res.statusCode !== 201) throw new Error(`create failed: ${res.body}`);
  return res.json() as { id: string; version: number; content: string; contentHash: string };
}

export const quote = (exact: string, replacement: string, extra: object = {}) => ({
  operation: "replace" as const,
  target: { quote: { exact, ...extra } },
  replacement,
});

export const patch = (app: FastifyInstance, id: string, body: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: "PATCH", url: `/documents/${id}`, payload: body as object, headers });

export const NDA = "Receiving Party shall not disclose Confidential Information. Disclosing Party shall not disclose Trade Secrets. Neither party shall not disclose the Term.";
