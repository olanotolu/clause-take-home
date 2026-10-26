export type Source = { id: string; title: string; version: number; text: string };
export type Evidence<T> = { value: T; source: string; version: number; quote: string };
export type Limit = { cents: number; currency: "USD"; basis: "occurrence" | "aggregate" | "unknown" };
export type Facts = { entity?: Evidence<string>[]; coverage?: Evidence<string>[]; limits?: Evidence<Limit>[]; effective?: Evidence<string>[]; expires?: Evidence<string>[] };
export type Status = "Match" | "Mismatch" | "Needs review" | "Unavailable";
export type Check = { label: string; status: Status; reason: string; evidence: Evidence<unknown>[] };
export const scenarioDate = "2026-10-26";
export const evaluatorVersion = "insurance-checks-1";
export const playbook = { version: 1, entity: "Northline Facilities LLC", coverage: "Commercial General Liability", minimumCents: 200_000_000, serviceStart: "2026-10-01", serviceEnd: "2026-12-31" } as const;
export const agreement: Source = { id: "agreement", title: "Service Agreement · editable draft", version: 1, text: "SYNTHETIC SERVICE AGREEMENT — DRAFT\n\nHarborlight Hospitality engages Northline Facilities LLC to provide maintenance services from October 1 through December 31, 2026.\n\nNorthline Facilities LLC shall maintain commercial general liability insurance with a limit of not less than $2,000,000 per occurrence throughout the service period.\n\nThis draft awaits final review and execution by the parties." };
export const schedule = (revised = false): Source => ({ id: "schedule", title: revised ? "Revised Policy Schedule · synthetic issuer record" : "Current Policy Schedule · synthetic issuer record", version: revised ? 2 : 1, text: `SYNTHETIC POLICY SCHEDULE${revised ? " — REVISED" : ""}\nNamed insured: Northline Facilities LLC.\nCoverage: Commercial General Liability.\nEach occurrence: $${revised ? "2,000,000" : "1,000,000"}.\nGeneral aggregate: $2,000,000.\nEffective: January 1, 2026.\nExpires: January 1, 2027.` });
export const email: Source = { id: "email", title: "Vendor Email · unverified assertion", version: 1, text: "SYNTHETIC VENDOR EMAIL\n\nWe carry two million in liability coverage. Please find the current schedule attached." };
export function factsFor(s: Source): Facts {
  const ev = <T>(value: T, quote: string): Evidence<T> => ({ value, source: s.id, version: s.version, quote });
  const occurrence = s.version === 2 ? 200_000_000 : 100_000_000;
  return { entity: [ev("Northline Facilities LLC", "Named insured: Northline Facilities LLC.")], coverage: [ev("Commercial General Liability", "Coverage: Commercial General Liability.")], limits: [ev({ cents: occurrence, currency: "USD", basis: "occurrence" }, `Each occurrence: $${s.version === 2 ? "2,000,000" : "1,000,000"}.`), ev({ cents: 200_000_000, currency: "USD", basis: "aggregate" }, "General aggregate: $2,000,000.")], effective: [ev("2026-01-01", "Effective: January 1, 2026.")], expires: [ev("2027-01-01", "Expires: January 1, 2027.")] };
}
function verified<T>(items: Evidence<T>[] | undefined, sources: Source[]): boolean {
  return !!items?.length && items.every(e => { const s = sources.find(x => x.id === e.source && x.version === e.version); return !!s && !!e.quote && s.text.indexOf(e.quote) >= 0 && s.text.indexOf(e.quote) === s.text.lastIndexOf(e.quote); });
}
function check<T>(label: string, items: Evidence<T>[] | undefined, sources: Source[], matches: (value: T) => boolean, good: string, bad: string): Check {
  if (!items?.length) return { label, status: "Unavailable", reason: "No evidence supplied.", evidence: [] };
  if (!verified(items, sources)) return { label, status: "Needs review", reason: "The quoted evidence could not be verified against the specified source version.", evidence: items };
  if (new Set(items.map(x => JSON.stringify(x.value))).size > 1) return { label, status: "Needs review", reason: "Supplied evidence is contradictory.", evidence: items };
  return { label, status: matches(items[0]!.value) ? "Match" : "Mismatch", reason: matches(items[0]!.value) ? good : bad, evidence: items };
}
export function review(sources: Source[], facts: Facts): { checks: Check[]; provenance: string } {
  const limits = facts.limits?.filter(x => x.value.basis === "occurrence");
  const unknown = facts.limits?.some(x => x.value.basis === "unknown");
  const limit = unknown && !limits?.length ? { label: "Per-occurrence limit", status: "Needs review" as const, reason: "The limit basis is missing or ambiguous.", evidence: facts.limits ?? [] } : check("Per-occurrence limit", limits, sources, x => x.currency === "USD" && x.cents >= playbook.minimumCents, "The supplied per-occurrence limit meets the stated minimum.", "The supplied per-occurrence limit is below the $2,000,000 minimum.");
  const dates = [...(facts.effective ?? []), ...(facts.expires ?? [])];
  let period: Check;
  if (!facts.effective?.length || !facts.expires?.length) period = { label: "Effective period", status: "Unavailable", reason: "Both effective and expiry dates are required.", evidence: dates };
  else if (!verified(dates, sources) || facts.effective.length !== 1 || facts.expires.length !== 1) period = { label: "Effective period", status: "Needs review", reason: "Dates are unverified or contradictory.", evidence: dates };
  else period = { label: "Effective period", status: facts.effective[0]!.value <= playbook.serviceStart && facts.expires[0]!.value > playbook.serviceEnd ? "Match" : "Mismatch", reason: facts.effective[0]!.value <= playbook.serviceStart && facts.expires[0]!.value > playbook.serviceEnd ? "Supplied dates cover the stated service period." : "Supplied dates do not cover the full service period.", evidence: dates };
  return { checks: [check("Named entity", facts.entity, sources, x => x === playbook.entity, "Matches the stated entity in the supplied records.", "The stated entity differs from the approved playbook."), check("Coverage type", facts.coverage, sources, x => x === playbook.coverage, "Matches the stated type in the supplied schedule.", "The stated coverage type differs from the playbook."), limit, period], provenance: `Sources ${sources.map(s => `${s.id} v${s.version}`).join(", ")} · playbook v${playbook.version} · scenario ${scenarioDate} · evaluator ${evaluatorVersion}` };
}

/** The fixture agreement uses a narrowly defined clause; unknown wording requires review. */
export function agreementRequirement(text: string): { status: Status; reason: string } {
  const matches = [...text.matchAll(/limit of not less than \$([\d,]+) per occurrence/g)];
  if (matches.length !== 1) return { status: "Needs review", reason: "The proposed agreement limit could not be identified uniquely." };
  const dollars = Number(matches[0]![1]!.replaceAll(",", ""));
  if (!Number.isSafeInteger(dollars) || !Number.isSafeInteger(dollars * 100)) return { status: "Needs review", reason: "The proposed limit is not a valid amount." };
  return dollars * 100 >= playbook.minimumCents
    ? { status: "Match", reason: "The proposed agreement meets the approved minimum." }
    : { status: "Mismatch", reason: `Proposed agreement: $${dollars.toLocaleString("en-US")} per occurrence, below the independent approved $2,000,000 minimum.` };
}
