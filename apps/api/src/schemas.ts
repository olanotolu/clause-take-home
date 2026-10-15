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
  content: z.string(),
  version: z.number().int(),
  contentHash: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const DocumentSummaryOut = DocumentOut.omit({ content: true }).extend({ size: z.number().int() });

export const AppliedOut = z.object({
  index: z.number().int(),
  start: z.number().int().meta({ description: "Offsets in the ORIGINAL text." }),
  end: z.number().int(),
  before: z.string(),
  after: z.string(),
  newStart: z.number().int().meta({ description: "Offsets of `after` in the NEW text." }),
  newEnd: z.number().int(),
});

export const ReceiptOut = z.object({
  id: z.string(),
  title: z.string(),
  content: z.string().meta({ description: "The full updated document text." }),
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
  proposedContent: z.string(),
  applied: z.array(AppliedOut),
  beforeHash: z.string(),
  afterHash: z.string(),
  diff: z.string().meta({ description: "Unified diff of current -> proposed." }),
});

export const RevisionInfoOut = z.object({
  version: z.number().int(),
  contentHash: z.string(),
  createdAt: z.string(),
  summary: z.unknown(),
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

export const SuggestOut = z.object({
  status: z.literal("proposal"),
  applied: z.literal(false).meta({ description: "A suggestion is never applied. Commit it through PATCH." }),
  provider: z.enum(["live", "fixture"]),
  model: z.string(),
  documentVersion: z.number().int(),
  rationale: z.string(),
  changes: z.array(ChangeSchema),
  validation: z.union([
    z.object({ valid: z.literal(true), applied: z.array(AppliedOut), diff: z.string() }),
    z.object({ valid: z.literal(false), error: z.object({ type: z.string(), error: z.string(), details: z.record(z.string(), z.unknown()).optional() }) }),
  ]),
});
