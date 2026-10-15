import { applyChanges, type Change, type EditError, type EditResult } from "../src/index.ts";

export const q = (exact: string, replacement: string, extra: { prefix?: string; suffix?: string; occurrence?: number } = {}): Change => ({
  operation: "replace",
  target: { quote: { exact, ...extra } },
  replacement,
});

export const pos = (start: number, end: number, expectedText: string, replacement: string): Change => ({
  operation: "replace",
  target: { position: { start, end, expectedText } },
  replacement,
});

export function ok(text: string, changes: Change[]): EditResult {
  const r = applyChanges(text, changes);
  if (!r.ok) throw new Error(`expected success, got ${JSON.stringify(r.error)}`);
  return r.value;
}

export function err(text: string, changes: Change[]): EditError {
  const r = applyChanges(text, changes);
  if (r.ok) throw new Error(`expected failure, got ${JSON.stringify(r.value.content)}`);
  return r.error;
}
