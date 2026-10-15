/** Browser-safe entry: everything except sha256 (which needs node:crypto). */
export * from "./types.ts";
export { resolveChanges, splitsSurrogate } from "./resolve.ts";
export { selectorFor } from "./anchor.ts";
export { applyChanges, applyOrderedSpans, orderSpans } from "./apply.ts";
