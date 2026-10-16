import { describe, expect, it } from "vitest";
import { DEFAULTS, formatDate, parseSettings } from "../src/lib/settings-core.ts";

describe("parseSettings", () => {
  it("returns defaults for nothing, garbage, arrays and non-objects", () => {
    for (const raw of [null, undefined, "", "{not json", "[]", "42", "null", '"x"']) expect(parseSettings(raw)).toEqual(DEFAULTS);
  });

  it("keeps valid fields and replaces only the invalid ones", () => {
    const s = parseSettings(JSON.stringify({ confirmApply: true, dateFormat: "klingon", aiTab: "yes", strictness: "strict", showHash: false }));
    expect(s).toMatchObject({ confirmApply: true, dateFormat: DEFAULTS.dateFormat, aiTab: DEFAULTS.aiTab, strictness: "strict", showHash: false });
  });

  it("ignores unknown keys and never returns them", () => {
    expect(Object.keys(parseSettings(JSON.stringify({ admin: true, theme: "dark" }))).sort()).toEqual(Object.keys(DEFAULTS).sort());
    expect(parseSettings(JSON.stringify({ admin: true }))).not.toHaveProperty("admin");
  });
});

describe("formatDate", () => {
  const iso = new Date(2026, 9, 5, 14, 7).toISOString(); // local 5 Oct 2026 14:07
  it("renders each fixed format in local time", () => {
    expect(formatDate(iso, "iso")).toBe("2026-10-05 14:07");
    expect(formatDate(iso, "us")).toBe("10/05/2026 14:07");
    expect(formatDate(iso, "eu")).toBe("05/10/2026 14:07");
  });
  it("returns unparseable input unchanged instead of 'Invalid Date'", () => {
    expect(formatDate("not a date", "iso")).toBe("not a date");
  });
});
