import type { Target } from "@clause/engine";

export interface Doc { id: string; title: string; content: string; version: number; contentHash: string; createdAt: string; updatedAt: string }
export interface DocSummary { id: string; title: string; version: number; size: number; updatedAt: string }
export interface Applied { index: number; start: number; end: number; before: string; after: string; newStart: number; newEnd: number }
export interface Segment { text: string; match: boolean }
export interface Hit { snippet: Segment[]; start?: number; end?: number; target?: Target }
export interface DocResult { documentId: string; title: string; version: number; relevance: number; matchCount?: number; hits: Hit[] }
export interface SearchPage { query: string; mode: "words" | "exact"; total: number; results: DocResult[] }
export interface Candidate { start: number; end: number; context: string }
export interface ApiError { error: string; code: number; type: string; details?: { candidates?: Candidate[]; currentVersion?: number; matchCount?: number; index?: number } }
export interface Preview { version: number; wouldChange: boolean; proposedContent: string; applied: Applied[]; diff: string }
export interface Receipt { revertedTo?: number; id: string; content: string; previousVersion: number; version: number; changed: boolean; beforeHash: string; afterHash: string; applied: Applied[] }
export interface Revision { version: number; contentHash: string; createdAt: string; summary: { before?: string; after?: string; created?: boolean; revertedTo?: number }[] }
export interface Change { operation: "replace"; target: Target; replacement: string }

export type Res<T> = { ok: true; data: T } | { ok: false; status: number; error: ApiError };

async function call<T>(method: string, path: string, body?: unknown): Promise<Res<T>> {
  try {
    const res = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? null : JSON.stringify(body),
    });
    if (res.status === 204) return { ok: true, data: undefined as T };
    const json = await res.json();
    return res.ok ? { ok: true, data: json as T } : { ok: false, status: res.status, error: json as ApiError };
  } catch {
    return { ok: false, status: 0, error: { error: "Cannot reach the API. Is it running on :3000?", code: 0, type: "NETWORK" } };
  }
}

export const api = {
  list: () => call<{ items: DocSummary[]; total: number }>("GET", "/documents?limit=100"),
  get: (id: string) => call<Doc>("GET", `/documents/${id}`),
  create: (title: string, content: string) => call<Doc>("POST", "/documents", { title, content }),
  revisions: (id: string) => call<{ items: Revision[] }>("GET", `/documents/${id}/revisions`),
  search: (q: string, mode: string) => call<SearchPage>("GET", `/documents/search?q=${encodeURIComponent(q)}&mode=${mode}&limit=20`),
  preview: (id: string, expectedVersion: number, changes: Change[]) =>
    call<Preview>("POST", `/documents/${id}/changes/preview`, { expectedVersion, changes }),
  revert: (id: string, expectedVersion: number, toVersion: number) => call<Receipt>("POST", `/documents/${id}/revert`, { toVersion, expectedVersion }),
  apply: (id: string, expectedVersion: number, changes: Change[]) => call<Receipt>("PATCH", `/documents/${id}`, { expectedVersion, changes }),
};
