import { describe, expect, it } from "vitest";
import { agreement, agreementRequirement, email, factsFor, review, schedule } from "../src/insurance/review.ts";

describe("synthetic insurance review", () => {
  const docs = [agreement, schedule(), email];
  it("does not confuse aggregate with per occurrence", () => {
    const result = review(docs, factsFor(schedule()));
    expect(result.checks.map(x => x.status)).toEqual(["Match", "Match", "Mismatch", "Match"]);
    expect(review([agreement, schedule(true), email], factsFor(schedule(true))).checks[2]?.status).toBe("Match");
  });
  it("rejects missing quotes and wrong source versions", () => {
    const facts = factsFor(schedule());
    facts.limits![0]!.quote = "missing";
    expect(review(docs, facts).checks[2]?.status).toBe("Needs review");
    expect(review([agreement, schedule(true), email], factsFor(schedule())).checks[2]?.status).toBe("Needs review");
  });
  it("does not guess on contradictory or absent facts", () => {
    const facts = factsFor(schedule());
    facts.entity!.push({ ...facts.entity![0]!, value: "Other LLC" });
    delete facts.coverage;
    expect(review(docs, facts).checks.slice(0, 2).map(x => x.status)).toEqual(["Needs review", "Unavailable"]);
  });
  it("flags dates that do not cover the service period", () => {
    const s = { ...schedule(), text: schedule().text.replace("January 1, 2027", "November 1, 2026") };
    const facts = factsFor(s);
    facts.expires![0] = { ...facts.expires![0]!, value: "2026-11-01", quote: "Expires: November 1, 2026." };
    expect(review([agreement, s, email], facts).checks[3]?.status).toBe("Mismatch");
  });
  it("keeps the approved minimum independent of the editable agreement", () => {
    expect(agreementRequirement(agreement.text).status).toBe("Match");
    expect(agreementRequirement(agreement.text.replace("$2,000,000 per occurrence", "$1,000,000 per occurrence")).status).toBe("Mismatch");
    expect(agreementRequirement("unknown wording").status).toBe("Needs review");
  });
  it("binds reports to the evidence version", () => {
    expect(review(docs, factsFor(schedule())).provenance).not.toEqual(review([agreement, schedule(true), email], factsFor(schedule(true))).provenance);
  });
});
