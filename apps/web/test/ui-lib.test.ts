import { describe, expect, it } from "vitest";
import { pct, shortModel } from "../src/lib/confidence.ts";
import { workspaceIdentity } from "../src/lib/identity.ts";
import { buildRoute, parseRoute, type Route } from "../src/lib/router.ts";
import { ago, deltaLabel, kb, wordCount, wordDelta } from "../src/lib/wordDelta.ts";

describe("router", () => {
  const routes: Route[] = [
    { name: "home" },
    { name: "home", request: "wrq_abc" },
    { name: "documents" },
    { name: "activity" },
    { name: "playbooks" },
    { name: "playbooks", id: "pbk_123" },
    { name: "templates" },
    { name: "settings" },
    { name: "doc", id: "doc_abc123", tab: "edit" },
    { name: "doc", id: "doc_abc123", tab: "ci" },
    { name: "doc", id: "doc_abc123", tab: "activity" },
    { name: "doc", id: "weird id/with#chars", tab: "details" },
  ];
  it("round-trips every route", () => {
    for (const r of routes) expect(parseRoute(buildRoute(r))).toEqual(r);
  });
  it("falls back safely: unknown paths go home, unknown tab goes to edit, bad escapes do not throw", () => {
    expect(parseRoute("")).toEqual({ name: "home" });
    expect(parseRoute("#/nope/x")).toEqual({ name: "home" });
    expect(parseRoute("#/welcome")).toEqual({ name: "home" });
    expect(parseRoute("#/doc/doc_1")).toEqual({ name: "doc", id: "doc_1", tab: "edit" });
    expect(parseRoute("#/doc/doc_1/zzz")).toEqual({ name: "doc", id: "doc_1", tab: "edit" });
    expect(parseRoute("#/doc/%E0%A4%A")).toEqual({ name: "home" });
    expect(parseRoute("#/request/%E0%A4%A")).toEqual({ name: "home" });
    expect(parseRoute("#/playbooks/%E0%A4%A")).toEqual({ name: "playbooks" });
  });
});

describe("wordDelta", () => {
  it("counts words per side and handles empty and whitespace-only text", () => {
    expect(wordCount("")).toBe(0);
    expect(wordCount("   \n ")).toBe(0);
    expect(wordCount(" shall  not\ndisclose ")).toBe(3);
    expect(wordDelta("shall not disclose", "may disclose")).toEqual({ added: 2, removed: 3 });
    expect(wordDelta("gone", "")).toEqual({ added: 0, removed: 1 });
  });
  it("labels deltas for chips, empty when zero", () => {
    expect(deltaLabel(0, "+")).toBe("");
    expect(deltaLabel(1, "+")).toBe("+1 word");
    expect(deltaLabel(12, "-")).toBe("-12 words");
  });
  it("formats time and size", () => {
    const now = Date.parse("2026-10-15T12:00:00Z");
    expect(ago("2026-10-15T11:57:00Z", now)).toBe("3 minutes ago");
    expect(ago("2026-10-14T12:00:00Z", now)).toBe("yesterday");
    expect(ago("garbage", now)).toBe("garbage");
    expect(kb(512)).toBe("512 B");
    expect(kb(2048)).toBe("2.0 KB");
    expect(kb(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("confidence", () => {
  it("clamps and rounds model probabilities", () => {
    expect(pct(0.874)).toBe("87%");
    expect(pct(1.2)).toBe("100%");
    expect(pct(-1)).toBe("0%");
    expect(shortModel("anthropic/claude-sonnet-5.5")).toBe("claude-sonnet-5.5");
    expect(shortModel("plain")).toBe("plain");
  });
});

import type { WorkRequest } from "../src/lib/api.ts";
import { applyFilters, byStatus, dueLabel, daysUntil, typeFromTitle } from "../src/lib/requests.ts";

describe("requests helpers", () => {
  const now = new Date(2026, 9, 15, 15, 30); // 15 Oct 2026, afternoon: due dates are days, not instants
  const mk = (over: Partial<WorkRequest>): WorkRequest => ({ id: "r", documentId: "d", title: "t", goal: "g", status: "inbox", priority: "medium", type: "NDA", dueDate: null, ci: null, createdAt: "", updatedAt: "", ...over });

  it("labels due dates relative to today, and calls out overdue ones", () => {
    expect(daysUntil("2026-10-15", now)).toBe(0);
    expect(dueLabel("2026-10-15", "inbox", now)).toEqual({ text: "Due today", overdue: false });
    expect(dueLabel("2026-10-16", "inbox", now)).toEqual({ text: "Due tomorrow", overdue: false });
    expect(dueLabel("2026-10-20", "inbox", now)).toEqual({ text: "Due in 5 days", overdue: false });
    expect(dueLabel("2026-10-14", "inbox", now)).toEqual({ text: "Overdue by 1 day", overdue: true });
    expect(dueLabel("2026-10-10", "in_progress", now)).toEqual({ text: "Overdue by 5 days", overdue: true });
    expect(dueLabel("2026-10-10", "completed", now)).toEqual({ text: "Was due 2026-10-10", overdue: false });
    expect(dueLabel(null, "inbox", now)).toBeNull();
  });

  it("guesses a type from a document title", () => {
    expect(typeFromTitle("Mutual NDA - Acme Corp")).toBe("NDA");
    expect(typeFromTitle("Data Processing Addendum - Soylent")).toBe("Data & Privacy");
    expect(typeFromTitle("Employee Confidentiality Agreement - Stark")).toBe("Employment");
    expect(typeFromTitle("MSA - Hooli")).toBe("Commercial");
    expect(typeFromTitle("Lease")).toBe("Other");
  });

  it("filters by type, priority and open/completed, and groups by status", () => {
    const items = [mk({ id: "a", type: "NDA", priority: "high" }), mk({ id: "b", type: "Commercial", status: "completed" }), mk({ id: "c", type: "NDA", status: "needs_review", priority: "low" })];
    const all = { type: "all", priority: "all", scope: "all" } as const;
    expect(applyFilters(items, all)).toHaveLength(3);
    expect(applyFilters(items, { ...all, type: "NDA" }).map((r) => r.id)).toEqual(["a", "c"]);
    expect(applyFilters(items, { ...all, priority: "low" }).map((r) => r.id)).toEqual(["c"]);
    expect(applyFilters(items, { ...all, scope: "completed" }).map((r) => r.id)).toEqual(["b"]);
    expect(applyFilters(items, { ...all, scope: "open" }).map((r) => r.id)).toEqual(["a", "c"]);
    const g = byStatus(items);
    expect(g.inbox.map((r) => r.id)).toEqual(["a"]);
    expect(g.needs_review.map((r) => r.id)).toEqual(["c"]);
    expect(g.in_progress).toEqual([]);
  });
});

describe("workspaceIdentity", () => {
  it("claims nothing when nobody is signed in", () => {
    expect(workspaceIdentity(null)).toEqual({ signedIn: false, initials: "", title: "Open workspace", subtitle: "No sign-in required" });
  });
  it("uses the session's own name, role and initials", () => {
    expect(workspaceIdentity({ name: "Ada Lovelace", email: "ada@example.com", role: "admin" })).toEqual({ signedIn: true, initials: "AL", title: "Ada Lovelace", subtitle: "Admin" });
  });
  it("falls back to the email, then to a neutral label, without inventing a role", () => {
    expect(workspaceIdentity({ name: "", email: "grace.hopper@example.com" })).toMatchObject({ initials: "GH", title: "grace.hopper@example.com", subtitle: "Signed in" });
    expect(workspaceIdentity({})).toMatchObject({ signedIn: true, initials: "", title: "Signed in" });
  });
});
