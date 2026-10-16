import { SettingsStatusOut, errors } from "../schemas.ts";
import { MAX_REQUIREMENTS_PER_DOCUMENT } from "../store/types.ts";
import { MAX_JUDGED_CHARS } from "../review/judges/llm.ts";
import type { SemanticEvaluator } from "../review/types.ts";
import type { App } from "../types.ts";

export interface StatusInputs {
  semantic: SemanticEvaluator;
  suggestionsEnabled: boolean;
  suggestionModel: string | null;
  checkPerHour: number;
  suggestPerHour: number;
  version: string;
}

/**
 * Read-only facts about this server for the Settings screen. Deliberately no way to change anything: the workspace
 * is open to every visitor, so cost-bearing choices (which models, which limits) stay in the server's environment.
 * Never includes keys, URLs or connection strings; model ids are public names.
 */
export function registerSettingsRoutes(app: App, inputs: StatusInputs): void {
  app.get("/settings/status", { schema: { response: { 200: SettingsStatusOut, ...errors(500) } } }, async () => ({
    version: inputs.version,
    storage: app.store.kind,
    access: "open" as const,
    ai: { judges: [...inputs.semantic.models], suggestions: inputs.suggestionsEnabled, suggestionModel: inputs.suggestionModel, strictnessOptions: ["balanced" as const, "strict" as const] },
    limits: {
      maxDocumentChars: Number.isFinite(app.store.maxContentChars) ? app.store.maxContentChars : null,
      maxJudgedChars: MAX_JUDGED_CHARS,
      maxRequirementsPerDocument: MAX_REQUIREMENTS_PER_DOCUMENT,
      checkPerHour: inputs.checkPerHour,
      suggestPerHour: inputs.suggestPerHour,
    },
  }));
}
