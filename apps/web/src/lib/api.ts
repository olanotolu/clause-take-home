import type { Target } from "@clause/engine";

export interface TemplateProvenance { templateId: string; title: string; source: string; attribution: string; sourceUrl: string; sourceVersion: string; license: string; jurisdictionNote: string }
export interface Doc { id: string; title: string; content: string; version: number; contentHash: string; createdAt: string; updatedAt: string; templateProvenance?: TemplateProvenance; sample?: boolean }
export interface DocSummary { id: string; title: string; version: number; size: number; updatedAt: string; sample?: boolean }
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
export interface SuggestResponse {
  status: "proposal";
  applied: false;
  provider: "live" | "fixture";
  model: string;
  documentVersion: number;
  rationale: string;
  changes: Change[];
  ci?: CiReport | null;
  validation: { valid: true; applied: Applied[]; diff: string } | { valid: false; error: { type: string; error: string; details?: ApiError["details"] } };
}
export type RequirementKind = "present" | "absent" | "unchanged" | "semantic";
export interface Requirement { id: string; documentId: string; kind: RequirementKind; text: string; createdAt: string }
export type Verdict = "PASS" | "FAIL" | "NEEDS_REVIEW" | "UNAVAILABLE";
export type Delta = "held" | "regressed" | "achieved" | "still_failing" | "uncertain";
export interface Evidence { start: number; end: number; quote: string; verified: boolean }
export interface JudgeDetail { id: string; label: string; probability?: number; rationale?: string }
export interface CheckOutcome { verdict: Verdict; detail: string; evidence: Evidence[]; judges?: JudgeDetail[] }
export interface RequirementReport { id: string; kind: RequirementKind | "goal"; text: string; before: CheckOutcome; after: CheckOutcome; delta: Delta; method: "exact" | "model"; answeredBy: string[]; touchedBy: number[] }
export interface CiReport {
  documentId: string;
  version: number;
  mechanical: { valid: true; wouldChange: boolean; changes: number };
  requirements: RequirementReport[];
  summary: { held: number; regressed: number; achieved: number; still_failing: number; uncertain: number };
  judges: string[];
  elapsedMs: number;
}
export interface SettingsStatus {
  version: string;
  storage: "sqlite" | "postgres";
  access: "open";
  ai: { judges: string[]; suggestions: boolean; suggestionModel: string | null; strictnessOptions: ("balanced" | "strict")[] };
  limits: { maxDocumentChars: number | null; maxJudgedChars: number; maxRequirementsPerDocument: number; checkPerHour: number; suggestPerHour: number };
}
export type RequestStatus = "inbox" | "in_progress" | "needs_review" | "completed";
export type Priority = "low" | "medium" | "high";
export type RequestType = "NDA" | "Commercial" | "Employment" | "Data & Privacy" | "Other";
export const REQUEST_STATUSES: readonly RequestStatus[] = ["inbox", "in_progress", "needs_review", "completed"];
export const REQUEST_TYPES: readonly RequestType[] = ["NDA", "Commercial", "Employment", "Data & Privacy", "Other"];
export const PRIORITIES: readonly Priority[] = ["low", "medium", "high"];
export interface CiSnapshot {
  version: number;
  checkedAt: string;
  total: number;
  holding: number;
  attention: number;
  judges: string[];
  goal?: Verdict;
  requirements: { text: string; kind: RequirementKind; verdict: Verdict }[];
}
export interface WorkRequest {
  id: string;
  documentId: string | null;
  title: string;
  goal: string;
  status: RequestStatus;
  priority: Priority;
  type: RequestType;
  dueDate: string | null;
  ci: CiSnapshot | null;
  createdAt: string;
  updatedAt: string;
}
export interface RequestCreate { documentId?: string; title: string; goal: string; status?: RequestStatus; priority?: Priority; type?: RequestType; dueDate?: string | null }
export type RequestPatch = Partial<Pick<WorkRequest, "title" | "goal" | "status" | "priority" | "type" | "dueDate">>;
export interface PlaybookRule { id: string; playbookId: string; title: string; kind: RequirementKind; text: string; createdAt: string }
export interface Playbook { id: string; name: string; description: string; createdAt: string; updatedAt: string }
export interface PlaybookSummary extends Playbook { ruleCount: number }
export interface PlaybookDetail extends Playbook { rules: PlaybookRule[] }
export interface ApplyResult { added: Requirement[]; skipped: { title: string; reason: "duplicate" | "limit" }[] }
export interface ActivityItem { documentId: string; title: string; version: number; contentHash: string; createdAt: string; summary: Revision["summary"] }
export type TemplateCategory = "NDA" | "Commercial" | "Data & Privacy" | "Vendor & Services" | "Employment";
export interface TemplateVariable { id: string; label: string; required: boolean; placeholder: string; helpText: string }
export interface TemplateSuggestion { id: string; title: string; kind: RequirementKind; text: string }
export interface Template { id: string; title: string; description: string; category: TemplateCategory; size: number; source: string; attribution: string; sourceUrl: string; sourceVersion: string; license: string; jurisdictionNote: string; featured: boolean; variables: TemplateVariable[]; suggestedRequirements: TemplateSuggestion[] }
export interface TemplateFull extends Omit<Template, "size"> { content: string }
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
  copy: (id: string, title?: string) => call<Doc>("POST", `/documents/${encodeURIComponent(id)}/copy`, title ? { title } : {}),
  revisions: (id: string) => call<{ items: Revision[] }>("GET", `/documents/${id}/revisions`),
  search: (q: string, mode: string) => call<SearchPage>("GET", `/documents/search?q=${encodeURIComponent(q)}&mode=${mode}&limit=20`),
  preview: (id: string, expectedVersion: number, changes: Change[]) =>
    call<Preview>("POST", `/documents/${id}/changes/preview`, { expectedVersion, changes }),
  revert: (id: string, expectedVersion: number, toVersion: number) => call<Receipt>("POST", `/documents/${id}/revert`, { toVersion, expectedVersion }),
  requirements: (id: string) => call<{ items: Requirement[]; max: number }>("GET", `/documents/${id}/requirements`),
  addRequirement: (id: string, kind: RequirementKind, text: string) => call<Requirement>("POST", `/documents/${id}/requirements`, { kind, text }),
  deleteRequirement: (id: string, rid: string) => call<undefined>("DELETE", `/documents/${id}/requirements/${rid}`),
  check: (id: string, expectedVersion: number, changes: Change[], goal?: string, strictness?: "balanced" | "strict") =>
    call<CiReport>("POST", `/documents/${id}/changes/check`, { expectedVersion, changes, ...(goal ? { goal } : {}), ...(strictness === "strict" ? { strictness } : {}) }),
  requests: () => call<{ items: WorkRequest[] }>("GET", "/requests"),
  createRequest: (b: RequestCreate) => call<WorkRequest>("POST", "/requests", b),
  patchRequest: (id: string, b: RequestPatch) => call<WorkRequest>("PATCH", `/requests/${id}`, b),
  deleteRequest: (id: string) => call<undefined>("DELETE", `/requests/${id}`),
  checkRequest: (id: string) => call<{ request: WorkRequest; moved: boolean }>("POST", `/requests/${id}/check`),
  playbooks: () => call<{ items: PlaybookSummary[] }>("GET", "/playbooks"),
  playbook: (id: string) => call<PlaybookDetail>("GET", `/playbooks/${id}`),
  createPlaybook: (name: string, description: string) => call<Playbook>("POST", "/playbooks", { name, description }),
  patchPlaybook: (id: string, b: { name?: string; description?: string }) => call<Playbook>("PATCH", `/playbooks/${id}`, b),
  deletePlaybook: (id: string) => call<undefined>("DELETE", `/playbooks/${id}`),
  addRule: (id: string, b: { title: string; kind: RequirementKind; text: string }) => call<PlaybookRule>("POST", `/playbooks/${id}/rules`, b),
  deleteRule: (id: string, rid: string) => call<undefined>("DELETE", `/playbooks/${id}/rules/${rid}`),
  applyPlaybook: (docId: string, playbookId: string) => call<ApplyResult>("POST", `/documents/${docId}/apply-playbook`, { playbookId }),
  activity: (limit = 60) => call<{ items: ActivityItem[] }>("GET", `/activity?limit=${limit}`),
  template: (id: string) => call<TemplateFull>("GET", `/templates/${encodeURIComponent(id)}`),
  templates: () => call<{ items: Template[] }>("GET", "/templates"),
  createFromTemplate: (id: string, values: Record<string, string>, selectedRequirementIds: string[], title?: string) =>
    call<{ document: Doc; attachedRequirements: Requirement[]; attachmentError?: string }>("POST", `/templates/${encodeURIComponent(id)}/create`, { values, selectedRequirementIds, ...(title ? { title } : {}) }),
  settingsStatus: () => call<SettingsStatus>("GET", "/settings/status"),
  suggest: (id: string, instruction: string) => call<SuggestResponse>("POST", `/documents/${id}/suggest`, { instruction }),
  apply: (id: string, expectedVersion: number, changes: Change[]) => call<Receipt>("PATCH", `/documents/${id}`, { expectedVersion, changes }),
};
