import type { Priority, RequestStatus, RequestType, WorkRequest } from "./api.ts";

export const STATUS_LABEL: Record<RequestStatus, string> = { inbox: "Inbox", in_progress: "In progress", needs_review: "Needs review", completed: "Completed" };
export const PRIORITY_LABEL: Record<Priority, string> = { low: "Low", medium: "Medium", high: "High" };

/** Same rule the server uses to categorise the sample templates, so a new request starts with a sensible type. */
export function typeFromTitle(title: string): RequestType {
  const t = title.toLowerCase();
  if (t.includes("nda") || t.includes("non-disclosure")) return "NDA";
  if (t.includes("employee") || t.includes("employment")) return "Employment";
  if (t.includes("data processing") || t.includes("dpa")) return "Data & Privacy";
  if (t.includes("msa") || t.includes("saas") || t.includes("services") || t.includes("agreement")) return "Commercial";
  return "Other";
}

/** Whole days from `now` to the due day, in the viewer's calendar (due dates are plain days, not instants). */
export function daysUntil(due: string, now = new Date()): number {
  const [y, m, d] = due.split("-").map(Number) as [number, number, number];
  const startOfDue = new Date(y, m - 1, d).getTime();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.round((startOfDue - startOfToday) / 86_400_000);
}

export function dueLabel(due: string | null, status: RequestStatus, now = new Date()): { text: string; overdue: boolean } | null {
  if (!due) return null;
  const n = daysUntil(due, now);
  if (status === "completed") return { text: `Was due ${due}`, overdue: false };
  if (n < 0) return { text: `Overdue by ${-n} day${n === -1 ? "" : "s"}`, overdue: true };
  if (n === 0) return { text: "Due today", overdue: false };
  if (n === 1) return { text: "Due tomorrow", overdue: false };
  return { text: `Due in ${n} days`, overdue: false };
}

export type Filters = { type: RequestType | "all"; priority: Priority | "all"; scope: "all" | "open" | "completed" };

export function applyFilters(items: WorkRequest[], f: Filters): WorkRequest[] {
  return items.filter((r) => (f.type === "all" || r.type === f.type) && (f.priority === "all" || r.priority === f.priority) && (f.scope === "all" || (f.scope === "completed") === (r.status === "completed")));
}

export function byStatus(items: WorkRequest[]): Record<RequestStatus, WorkRequest[]> {
  const out: Record<RequestStatus, WorkRequest[]> = { inbox: [], in_progress: [], needs_review: [], completed: [] };
  for (const r of items) out[r.status].push(r);
  return out;
}
