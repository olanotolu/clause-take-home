import { z } from "zod";

/**
 * SQLite's FTS tokenizers, length() and instr() all stop at a NUL character, so text containing one would be
 * silently under-indexed (search would miss everything after it). Refuse it at the door instead.
 */
const text = () => z.string().refine((s) => !s.includes("\u0000"), { message: "must not contain NUL (U+0000) characters" });

/**
 * Structural validation only. Semantic rules (occurrence >= 1, non-empty exact,
 * integer ranges, bounds) belong to the edit engine so there is a single source
 * of truth and consistent typed errors.
 */
const Quote = z.strictObject({
  exact: z.string().meta({ description: "Literal, case-sensitive text to find. Never a regex." }),
  prefix: z.string().optional().meta({ description: "Text that must immediately precede the match." }),
  suffix: z.string().optional().meta({ description: "Text that must immediately follow the match." }),
  occurrence: z.number().optional().meta({ description: "1-based, counted among matches that satisfy prefix/suffix." }),
});

const Position = z.strictObject({
  start: z.number().meta({ description: "UTF-16 code-unit offset, inclusive." }),
  end: z.number().meta({ description: "UTF-16 code-unit offset, exclusive." }),
  expectedText: z.string().meta({ description: "Required. Must equal the text at [start, end); use \"\" for insertion (start === end)." }),
});

export const TargetSchema = z.union([z.strictObject({ quote: Quote }), z.strictObject({ position: Position })]);

export const ChangeSchema = z.strictObject({
  operation: z.literal("replace"),
  target: TargetSchema,
  replacement: text().meta({ description: "Delete = \"\". Insert = position target with start === end." }),
});

export const ChangesBody = z.strictObject({
  expectedVersion: z.number().int().min(1).optional().meta({ description: "Reject with 409 unless the document is at exactly this version." }),
  changes: z.array(ChangeSchema).min(1).max(5000),
});

export const RevertBody = z.strictObject({
  toVersion: z.number().int().min(1).meta({ description: "The old version whose text becomes current again, as a NEW version." }),
  expectedVersion: z.number().int().min(1).optional().meta({ description: "Reject with 409 unless the document is exactly at this version." }),
});

export const CopyBody = z.strictObject({
  title: text().pipe(z.string().min(1).max(300)).optional(),
});

export const CreateBody = z.strictObject({
  title: text().pipe(z.string().min(1).max(300)),
  content: text(),
});

/**
 * Strict integer from a query/path string. z.coerce.number() would turn "" into 0 and accept " 1", "1e1", "0x1";
 * the documented type is a plain base-10 integer, so anything else is a 400.
 */
const strictInt = (min: number, max: number) =>
  z
    .string()
    // min >= 1 can't start with 0 (so "000" is a documented-invalid value, not a pattern-valid one the range then rejects)
    .regex(min >= 1 ? /^[1-9]\d{0,8}$/ : /^(0|[1-9]\d{0,8})$/, `must be a base-10 integer between ${min} and ${max}`)
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));
const withDefault = <T extends z.ZodType>(schema: T, def: z.output<T>) => schema.optional().transform((v) => (v ?? def) as z.output<T>);

export const VersionParam = strictInt(1, 1_000_000_000);

export const ExportQuery = z.object({
  from: strictInt(1, 1_000_000_000).optional().meta({ description: "Older version to compare against. Default 1 (the original)." }),
  to: strictInt(1, 1_000_000_000).optional().meta({ description: "Newer version. Default: the current version." }),
});

export const IdParams = z.strictObject({ id: z.string().min(1).max(64) });

export const PageQuery = z.object({
  limit: withDefault(strictInt(1, 100), 20),
  offset: withDefault(strictInt(0, 1_000_000_000), 0),
});

export const SearchQuery = z.object({
  q: z.string().min(1).max(200),
  mode: z.enum(["words", "exact"]).default("words"),
  ids: z.string().optional().meta({ description: "Comma-separated document ids to restrict the search to." }),
  limit: withDefault(strictInt(1, 100), 10),
  offset: withDefault(strictInt(0, 1_000_000_000), 0),
});

export const ScopedSearchQuery = z.object({
  q: z.string().min(1).max(200),
  mode: z.enum(["words", "exact"]).default("exact"),
  limit: withDefault(strictInt(1, 500), 50).meta({ description: "Maximum hits to return." }),
});

// ---------------------------------------------------------------- responses
// Declared so the OpenAPI document is the real contract (and so fuzzing can check it).
// NOTE: response schemas also SERIALISE, so every field a route returns must be listed here.

export const ErrorBody = z.object({
  error: z.string(),
  code: z.number().int(),
  type: z.string().meta({ description: "Stable machine-readable error type, e.g. AMBIGUOUS_TARGET." }),
  details: z.record(z.string(), z.unknown()).optional(),
});

/** Every non-2xx has this body. 400 malformed, 404 missing, 409 conflict/ambiguity, 412 If-Match, 413 too large, 422 unsatisfiable, 5xx server. */
export const errors = <const C extends number[]>(...codes: C) =>
  Object.fromEntries(codes.map((c) => [c, ErrorBody])) as { [K in C[number]]: typeof ErrorBody };

export const DocumentOut = z.object({
  id: z.string(),
  title: z.string(),
  content: z.string().optional(),
  contentUrl: z.string().optional(),
  version: z.number().int(),
  contentHash: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  byteLength: z.number().int().optional(),
  utf16Length: z.number().int().optional(),
  wordCount: z.number().int().optional(),
  sample: z.boolean().optional().meta({ description: "True for the shared sample contracts: read-only through the API; POST /documents/{id}/copy makes an editable copy." }),
  templateProvenance: z.object({
    templateId: z.string(), title: z.string(), source: z.string(), attribution: z.string(), sourceUrl: z.string(),
    sourceVersion: z.string(), license: z.string(), jurisdictionNote: z.string(),
  }).optional(),
});

export const DocumentSummaryOut = DocumentOut.omit({ content: true }).extend({ size: z.number().int() });

export const AppliedOut = z.object({
  index: z.number().int(),
  start: z.number().int().meta({ description: "Offsets in the ORIGINAL text." }),
  end: z.number().int(),
  before: z.string().optional().meta({description:"Omitted when changed text exceeds the response budget."}),
  after: z.string().optional().meta({description:"Omitted when changed text exceeds the response budget."}),
  newStart: z.number().int().meta({ description: "Offsets of `after` in the NEW text." }),
  newEnd: z.number().int(),
});

export const ReceiptOut = z.object({
  id: z.string(),
  title: z.string(),
  content: z.string().optional().meta({ description: "The full updated document text. Omitted when the request sent `Prefer: return=minimal`." }),
  contentUrl: z.string().optional().meta({ description: "Short-lived content endpoint for documents above 1 MiB." }),
  previousVersion: z.number().int(),
  version: z.number().int(),
  changed: z.boolean().meta({ description: "False for a no-op (identical text): no new revision is created." }),
  beforeHash: z.string(),
  afterHash: z.string(),
  applied: z.array(AppliedOut),
  revertedTo: z.number().int().optional().meta({ description: "Present on a revert: the old version whose text was restored." }),
});

export const PreviewOut = z.object({
  id: z.string(),
  version: z.number().int(),
  wouldChange: z.boolean(),
  proposedContent: z.string().optional().meta({ description: "The full proposed text. Omitted for minimal responses and documents larger than 1 MiB." }),
  applied: z.array(AppliedOut),
  beforeHash: z.string(),
  afterHash: z.string(),
  diff: z.string().optional().meta({ description: "Unified diff of current -> proposed. Omitted for minimal responses and documents larger than 1 MiB." }),
});

export const RevisionInfoOut = z.object({
  version: z.number().int(),
  contentHash: z.string(),
  createdAt: z.string(),
  summary: z.unknown(),
  byteLength: z.number().int().optional(),
  utf16Length: z.number().int().optional(),
  wordCount: z.number().int().optional(),
});

const SegmentOut = z.object({ text: z.string(), match: z.boolean() });
const HitOut = z.object({
  snippet: z.array(SegmentOut),
  start: z.number().int().optional(),
  end: z.number().int().optional(),
  target: TargetSchema.optional().meta({ description: "A selector that resolves to exactly [start, end) in this version; usable as a PATCH target." }),
});
export const DocumentResultOut = z.object({
  documentId: z.string(),
  title: z.string(),
  version: z.number().int(),
  relevance: z.number(),
  matchCount: z.number().int().optional(),
  hits: z.array(HitOut),
});
export const SearchPageOut = z.object({
  query: z.string(),
  mode: z.enum(["words", "exact"]),
  total: z.number().int().meta({ description: "Matching DOCUMENTS (not occurrences)." }),
  limit: z.number().int(),
  offset: z.number().int(),
  results: z.array(DocumentResultOut),
});
export const ScopedSearchOut = z.object({
  query: z.string(),
  mode: z.enum(["words", "exact"]),
  documentId: z.string(),
  result: DocumentResultOut.nullable(),
});


// ---------------------------------------------------------------- requirements and CI checks

export const RequirementKindSchema = z.enum(["present", "absent", "unchanged", "semantic"]).meta({
  description: "present = must contain this text · absent = must not contain it · unchanged = this passage must survive verbatim · semantic = a statement judged by AI models",
});

export const RequirementBody = z.strictObject({
  kind: RequirementKindSchema,
  text: text().pipe(z.string().min(1).max(2000)),
});

export const RequirementIdParams = IdParams.extend({ rid: z.string().min(1).max(64) });

export const RequirementOut = z.object({ id: z.string(), documentId: z.string(), kind: RequirementKindSchema, text: z.string(), createdAt: z.string() });

export const CheckBody = ChangesBody.extend({
  uploadedContent:z.object({intent:z.string().min(1),sha256:z.string().regex(/^[0-9a-f]{64}$/)}).optional(),
  changes: z.array(ChangeSchema).max(5000).meta({ description: "Empty means: check the CURRENT text against the requirements (no edit proposed)." }),
  goal: text().pipe(z.string().min(1).max(500)).optional().meta({ description: "What the edit is meant to achieve, in plain words. Judged like a requirement that should become true." }),
  strictness: z.enum(["balanced", "strict"]).optional().meta({ description: "strict: a semantic PASS needs every judge to be at least 80% sure, otherwise NEEDS_REVIEW. Default balanced." }),
});

const VerdictSchema = z.enum(["PASS", "FAIL", "NEEDS_REVIEW", "UNAVAILABLE"]);
const EvidenceOut = z.object({ start: z.number().int(), end: z.number().int(), quote: z.string(), verified: z.boolean() });
const JudgeDetailOut = z.object({ id: z.string(), label: z.string(), probability: z.number().optional(), rationale: z.string().optional() });
const CheckOutcome = z.object({ verdict: VerdictSchema, detail: z.string(), evidence: z.array(EvidenceOut), judges: z.array(JudgeDetailOut).optional() });

export const RequirementReportOut = z.object({
  id: z.string(),
  kind: z.union([RequirementKindSchema, z.literal("goal")]),
  text: z.string(),
  before: CheckOutcome.meta({ description: "Result on the current version. Evidence offsets index the current text." }),
  after: CheckOutcome.meta({ description: "Result on the proposed text. Evidence offsets index the proposed text." }),
  delta: z.enum(["held", "regressed", "achieved", "still_failing", "uncertain"]),
  method: z.enum(["exact", "model"]).meta({ description: "exact = literal text matching, no model. model = a judge's opinion: advisory, and its quotes show only that the text exists, not that it supports the conclusion." }),
  answeredBy: z.array(z.string()).meta({ description: "Judges that actually answered; empty for exact checks and when no judge could." }),
  touchedBy: z.array(z.number().int()),
});

export const CiReportOut = z.object({
  documentId: z.string(),
  version: z.number().int(),
  mechanical: z.object({ valid: z.literal(true), wouldChange: z.boolean(), changes: z.number().int() }),
  requirements: z.array(RequirementReportOut),
  summary: z.object({ held: z.number().int(), regressed: z.number().int(), achieved: z.number().int(), still_failing: z.number().int(), uncertain: z.number().int() }),
  judges: z.array(z.string()),
  elapsedMs: z.number().int(),
});

// Defined last: it embeds CiReportOut.
export const SuggestOut = z.object({
  status: z.literal("proposal"),
  applied: z.literal(false).meta({ description: "A suggestion is never applied. Commit it through PATCH." }),
  provider: z.enum(["live", "fixture"]),
  model: z.string(),
  documentVersion: z.number().int(),
  rationale: z.string(),
  changes: z.array(ChangeSchema),
  ci: CiReportOut.nullable().optional().meta({ description: "CLAUSE CI report for a valid proposal: the instruction as the goal plus the document's saved requirements. Null when it could not be produced." }),
  validation: z.union([
    z.object({ valid: z.literal(true), applied: z.array(AppliedOut), diff: z.string().optional() }),
    z.object({ valid: z.literal(false), error: z.object({ type: z.string(), error: z.string(), details: z.record(z.string(), z.unknown()).optional() }) }),
  ]),
});

export const SettingsStatusOut = z.object({
  version: z.string(),
  storage: z.enum(["sqlite", "postgres"]),
  access: z.literal("open").meta({ description: "There is no authentication: every visitor shares one workspace." }),
  ai: z.object({
    judges: z.array(z.string()).meta({ description: "Model ids that judge semantic requirements. Empty when none is configured." }),
    suggestions: z.boolean(),
    suggestionModel: z.string().nullable(),
    strictnessOptions: z.array(z.enum(["balanced", "strict"])),
  }),
  limits: z.object({
    maxDocumentChars: z.number().int().nullable(),
    maxJudgedChars: z.number().int(),
    maxRequirementsPerDocument: z.number().int(),
    checkPerHour: z.number().int(),
    suggestPerHour: z.number().int(),
  }),
});

export const TemplateOut = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  category: z.enum(["NDA", "Commercial", "Data & Privacy", "Vendor & Services", "Employment"]),
  content: z.string(),
  source: z.string(), attribution: z.string(), sourceUrl: z.string(), sourceVersion: z.string(), license: z.string(),
  jurisdictionNote: z.string(), featured: z.boolean(),
  variables: z.array(z.object({ id: z.string(), label: z.string(), required: z.boolean(), placeholder: z.string(), helpText: z.string() })),
  suggestedRequirements: z.array(z.object({ id: z.string(), title: z.string(), kind: RequirementKindSchema, text: z.string() })),
});

/** The catalog list: everything but the (up to ~80 KB) text, which GET /templates/:id returns. */
export const TemplateSummaryOut = TemplateOut.omit({ content: true }).extend({ size: z.number().int().meta({ description: "Length of the full text in characters." }) });

export const CreateTemplateBody = z.strictObject({
  title: z.string().trim().min(1).max(300).optional(),
  values: z.record(z.string(), z.string().max(4000)),
  selectedRequirementIds: z.array(z.string()).max(8),
});
export const TemplateIdParams = z.strictObject({ id: z.string().min(1).max(100) });

// ---------------------------------------------------------------- requests (units of legal work)

const IsoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD").refine(
    (s) => {
      // Date.parse rolls "2026-02-31" over to March 3, so require the parsed date to print back as the same day.
      const d = new Date(`${s}T00:00:00Z`);
      return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
    },
    { message: "not a real date" },
  );

export const RequestStatusSchema = z.enum(["inbox", "in_progress", "needs_review", "completed"]);
export const PrioritySchema = z.enum(["low", "medium", "high"]);
export const RequestTypeSchema = z.enum(["NDA", "Commercial", "Employment", "Data & Privacy", "Other"]);

const CiSnapshotOut = z.object({
  version: z.number().int(),
  checkedAt: z.string(),
  total: z.number().int(),
  holding: z.number().int(),
  attention: z.number().int(),
  judges: z.array(z.string()),
  goal: VerdictSchema.optional(),
  requirements: z.array(z.object({ text: z.string(), kind: RequirementKindSchema, verdict: VerdictSchema })),
});

export const RequestOut = z.object({
  id: z.string(),
  documentId: z.string().nullable(),
  title: z.string(),
  goal: z.string(),
  status: RequestStatusSchema,
  priority: PrioritySchema,
  type: RequestTypeSchema,
  dueDate: z.string().nullable(),
  ci: CiSnapshotOut.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const RequestCreateBody = z.strictObject({
  documentId: z.string().min(1).max(64).optional().meta({ description: "The document this request is about. Must exist." }),
  title: text().pipe(z.string().trim().min(1).max(200)),
  goal: text().pipe(z.string().trim().min(1).max(500)).meta({ description: "The requested outcome, in plain words. Also judged against the document by Clause CI." }),
  status: RequestStatusSchema.default("inbox"),
  priority: PrioritySchema.default("medium"),
  type: RequestTypeSchema.default("Other"),
  dueDate: IsoDay.nullable().default(null),
});

export const RequestPatchBody = z
  .strictObject({
    title: text().pipe(z.string().trim().min(1).max(200)).optional(),
    goal: text().pipe(z.string().trim().min(1).max(500)).optional(),
    status: RequestStatusSchema.optional(),
    priority: PrioritySchema.optional(),
    type: RequestTypeSchema.optional(),
    dueDate: IsoDay.nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "send at least one field to change" });

export const RequestIdParams = z.object({ id: z.string().min(1).max(64) });

export const RequestCheckOut = z.object({
  request: RequestOut,
  /** True when the audit found problems and moved the request into Needs review. It never moves a request to Completed. */
  moved: z.boolean(),
});

// ---------------------------------------------------------------- playbooks

export const PlaybookRuleOut = z.object({ id: z.string(), playbookId: z.string(), title: z.string(), kind: RequirementKindSchema, text: z.string(), createdAt: z.string() });
export const PlaybookOut = z.object({ id: z.string(), name: z.string(), description: z.string(), createdAt: z.string(), updatedAt: z.string() });
export const PlaybookSummaryOut = PlaybookOut.extend({ ruleCount: z.number().int() });
export const PlaybookDetailOut = PlaybookOut.extend({ rules: z.array(PlaybookRuleOut) });
export const PlaybookBody = z.strictObject({ name: text().pipe(z.string().trim().min(1).max(120)), description: text().pipe(z.string().trim().max(500)).default("") });
export const PlaybookPatchBody = z
  .strictObject({ name: text().pipe(z.string().trim().min(1).max(120)).optional(), description: text().pipe(z.string().trim().max(500)).optional() })
  .refine((b) => Object.keys(b).length > 0, { message: "send at least one field to change" });
export const PlaybookRuleBody = z.strictObject({ title: text().pipe(z.string().trim().min(1).max(160)), kind: RequirementKindSchema, text: text().pipe(z.string().min(1).max(2000)) });
export const PlaybookIdParams = z.object({ id: z.string().min(1).max(64) });
export const PlaybookRuleParams = PlaybookIdParams.extend({ rid: z.string().min(1).max(64) });
export const ApplyPlaybookBody = z.strictObject({ playbookId: z.string().min(1).max(64) });
export const ApplyPlaybookOut = z.object({
  added: z.array(RequirementOut),
  skipped: z.array(z.object({ title: z.string(), reason: z.enum(["duplicate", "limit"]) })),
});

// ---------------------------------------------------------------- activity across documents

export const ActivityOut = z.object({
  items: z.array(z.object({ documentId: z.string(), title: z.string(), version: z.number().int(), contentHash: z.string(), createdAt: z.string(), summary: z.unknown() })),
});
export const ActivityQuery = z.object({ limit: withDefault(strictInt(1, 100), 40) });
