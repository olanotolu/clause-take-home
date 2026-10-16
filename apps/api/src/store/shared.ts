import { randomUUID } from "node:crypto";
import type { CiSnapshot, Playbook, PlaybookRule, Priority, RequestPatch, RequestStatus, RequestType, RequirementKind, WorkRequest } from "./types.ts";

export const newId = (prefix: string, len = 12): string => `${prefix}_${randomUUID().replaceAll("-", "").slice(0, len)}`;

/** YYYY-MM-DD, `days` from now (UTC). */
export const dueIn = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

export interface RequestRow {
  id: string;
  document_id: string | null;
  title: string;
  goal: string;
  status: string;
  priority: string;
  type: string;
  due_date: string | null;
  ci: string | null;
  created_at: string;
  updated_at: string;
}

export const REQUEST_COLUMNS = "id, document_id, title, goal, status, priority, type, due_date, ci, created_at, updated_at";

export const toRequest = (r: RequestRow): WorkRequest => ({
  id: r.id,
  documentId: r.document_id,
  title: r.title,
  goal: r.goal,
  status: r.status as RequestStatus,
  priority: r.priority as Priority,
  type: r.type as RequestType,
  dueDate: r.due_date,
  ci: r.ci ? (JSON.parse(r.ci) as CiSnapshot) : null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** The columns a patch sets, in a fixed vocabulary (names never come from user input). */
export function requestPatchColumns(patch: RequestPatch): [column: string, value: string | null][] {
  const out: [string, string | null][] = [];
  if (patch.title !== undefined) out.push(["title", patch.title]);
  if (patch.goal !== undefined) out.push(["goal", patch.goal]);
  if (patch.status !== undefined) out.push(["status", patch.status]);
  if (patch.priority !== undefined) out.push(["priority", patch.priority]);
  if (patch.type !== undefined) out.push(["type", patch.type]);
  if (patch.dueDate !== undefined) out.push(["due_date", patch.dueDate]);
  if (patch.ci !== undefined) out.push(["ci", patch.ci === null ? null : JSON.stringify(patch.ci)]);
  return out;
}

export interface PlaybookRow { id: string; name: string; description: string; created_at: string; updated_at: string }
export interface RuleRow { id: string; playbook_id: string; title: string; kind: string; text: string; created_at: string }

export const toPlaybook = (r: PlaybookRow): Playbook => ({ id: r.id, name: r.name, description: r.description, createdAt: r.created_at, updatedAt: r.updated_at });
export const toRule = (r: RuleRow): PlaybookRule => ({ id: r.id, playbookId: r.playbook_id, title: r.title, kind: r.kind as RequirementKind, text: r.text, createdAt: r.created_at });
