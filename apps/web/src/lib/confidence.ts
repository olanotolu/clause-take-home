/** A model's reported probability as a whole percent. Clamped so a stray 1.2 can never print "120%". */
export function pct(p: number): string {
  return `${Math.round(Math.min(1, Math.max(0, p)) * 100)}%`;
}

/** Last path segment of a model id: "anthropic/claude-sonnet-5.5" -> "claude-sonnet-5.5". */
export const shortModel = (id: string): string => id.split("/").pop() ?? id;
