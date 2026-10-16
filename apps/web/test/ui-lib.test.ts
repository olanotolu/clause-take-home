import { describe, expect, it } from "vitest";
import { pct, shortModel } from "../src/lib/confidence.ts";
import { buildRoute, parseRoute, type Route } from "../src/lib/router.ts";
import { ago, deltaLabel, kb, wordCount, wordDelta } from "../src/lib/wordDelta.ts";

describe("router", () => {
  const routes: Route[] = [
    { name: "home" },
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
    expect(parseRoute("#/doc/doc_1")).toEqual({ name: "doc", id: "doc_1", tab: "edit" });
    expect(parseRoute("#/doc/doc_1/zzz")).toEqual({ name: "doc", id: "doc_1", tab: "edit" });
    expect(parseRoute("#/doc/%E0%A4%A")).toEqual({ name: "home" });
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
