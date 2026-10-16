import { describe, expect, it } from "vitest";
import { buildVersion, chooseBackend } from "../src/config.ts";

describe("chooseBackend (a local run must never touch the hosted database by accident)", () => {
  it("defaults to SQLite even when DATABASE_URL happens to be set (e.g. pulled by `vercel env pull`)", () => {
    expect(chooseBackend({})).toBe("sqlite");
    expect(chooseBackend({ DATABASE_URL: "postgres://prod" })).toBe("sqlite");
    expect(chooseBackend({ POSTGRES_URL: "postgres://prod", VERCEL_OIDC_TOKEN: "t" })).toBe("sqlite");
  });
  it("uses Postgres when asked, or by default on Vercel", () => {
    expect(chooseBackend({ CLAUSE_STORAGE: "postgres" })).toBe("postgres");
    expect(chooseBackend({ VERCEL: "1" })).toBe("postgres");
  });
  it("lets an explicit choice win in both directions, and rejects typos", () => {
    expect(chooseBackend({ VERCEL: "1", CLAUSE_STORAGE: "sqlite" })).toBe("sqlite");
    expect(() => chooseBackend({ CLAUSE_STORAGE: "postgress" })).toThrow(/must be/);
  });
});

describe("buildVersion", () => {
  it("prefers an explicit build sha, then Vercel's, and never reports an empty string", () => {
    expect(buildVersion({ CLAUSE_BUILD_SHA: "e18397c9999", VERCEL_GIT_COMMIT_SHA: "ffffffffff" })).toBe("e18397c");
    expect(buildVersion({ VERCEL_GIT_COMMIT_SHA: "41ab06a360b3" })).toBe("41ab06a");
    expect(buildVersion({ VERCEL_GIT_COMMIT_SHA: "" })).toBe("dev");
    expect(buildVersion({})).toBe("dev");
  });
});
