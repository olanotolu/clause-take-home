import { z } from "zod";

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
  replacement: z.string().meta({ description: "Delete = \"\". Insert = position target with start === end." }),
});

export const ChangesBody = z.strictObject({
  expectedVersion: z.number().int().min(1).optional().meta({ description: "Reject with 409 unless the document is at exactly this version." }),
  changes: z.array(ChangeSchema).min(1).max(5000),
});

export const CreateBody = z.strictObject({
  title: z.string().min(1).max(300),
  content: z.string(),
});

export const IdParams = z.strictObject({ id: z.string().min(1).max(64) });

export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const SearchQuery = z.object({
  q: z.string(),
  mode: z.enum(["words", "exact"]).default("words"),
  ids: z.string().optional().meta({ description: "Comma-separated document ids to restrict the search to." }),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  offset: z.coerce.number().int().min(0).default(0),
});

export const ScopedSearchQuery = z.object({
  q: z.string(),
  mode: z.enum(["words", "exact"]).default("exact"),
  limit: z.coerce.number().int().min(1).max(500).default(50).meta({ description: "Maximum hits to return." }),
});
