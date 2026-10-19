import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { testApp } from "./helpers.ts";

const deal = {
  provider_name: "Acme Legal, Inc.",
  customer_name: "Example Systems LLC",
  effective_date: "October 15, 2026",
  business_scope: "evaluate the cloud service",
};

describe("source-backed template library", () => {
  let app: FastifyInstance;
  afterEach(async () => app?.close());

  it("includes 16 requested source forms plus the five labeled CLAUSE samples", async () => {
    app = await testApp();
    const r = await app.inject({ method: "GET", url: "/templates" });
    expect(r.statusCode).toBe(200);
    const list = r.json().items as { id: string; size: number }[];
    expect(list.every((t) => !("content" in t) && t.size > 0)).toBe(true); // the list is metadata only
    const items = await Promise.all(list.map(async (t) => (await app.inject({ method: "GET", url: `/templates/${t.id}` })).json()));
    expect(items).toHaveLength(21);
    expect(items.map((t: { content: string }) => t.content.length)).toEqual(list.map((t) => t.size));
    expect(new Set(items.map((t: { id: string }) => t.id)).size).toBe(21);
    expect(items.filter((t: { source: string }) => t.source === "CLAUSE sample")).toHaveLength(5);
    for (const title of ["One-Way Non-Disclosure Agreement", "Cloud Service Agreement", "Terms of Service", "Service Level Agreement", "Data Processing Agreement", "Business Associate Agreement", "AI Addendum", "Professional Services Agreement", "Software License Agreement", "Pilot Agreement", "Partnership Agreement", "Independent Contractor Agreement", "Amendment to Agreement", "Statement of Work", "Cloud Service Order Form"]) {
      expect(items.some((t: { title: string }) => t.title === title), title).toBe(true);
    }
    const csa = items.find((t: { id: string }) => t.id === "cloud-service-agreement");
    expect(csa.content.length).toBeGreaterThan(30_000);
    expect(csa.license).toContain("CC BY 4.0");
    expect(csa.suggestedRequirements.length).toBeGreaterThan(0);
    const oneWay = items.find((t: { id: string }) => t.id === "one-way-nda");
    expect(oneWay.content).toContain("This One-Way Non-Disclosure Agreement");
    expect(oneWay.variables.some((v: { label: string }) => /disclosing party/i.test(v.label))).toBe(true);
    const orderForm = items.find((t: { id: string }) => t.id === "order-form");
    expect(orderForm.variables).toHaveLength(6);
    expect(orderForm.variables.every((v: { label: string }) => !/drafting note|fill in|delete the/i.test(v.label))).toBe(true);
    expect(orderForm.content).toContain("Drafting note:");
    const tos = items.find((t: { id: string }) => t.id === "terms-of-service");
    expect(tos.sourceVersion).toContain("2.1");
    expect(tos.content).toContain("INCORPORATED STANDARD TERMS");
    expect(tos.content).not.toContain("begin instructions");
  });

  it("validates required fields, preserves blank optional prompts, and persists provenance and selected CI requirements", async () => {
    app = await testApp();
    const missing = await app.inject({ method: "POST", url: "/templates/cloud-service-agreement/create", payload: { values: {}, selectedRequirementIds: [] } });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().type).toBe("MISSING_TEMPLATE_FIELDS");

    const catalog = await app.inject({ method: "GET", url: "/templates" });
    expect(catalog.statusCode).toBe(200);
    const template = (await app.inject({ method: "GET", url: "/templates/cloud-service-agreement" })).json();
    const created = await app.inject({ method: "POST", url: "/templates/cloud-service-agreement/create", payload: { values: deal, selectedRequirementIds: [template.suggestedRequirements[0].id] } });
    expect(created.statusCode).toBe(201);
    const { document, attachedRequirements } = created.json();
    expect(document.content).toContain("Acme Legal, Inc.");
    expect(document.content).toContain("[Add fees or state that no fees apply]");
    expect(document.templateProvenance).toMatchObject({ templateId: "cloud-service-agreement", source: "Common Paper", sourceVersion: "2.1", license: expect.stringContaining("CC BY 4.0") });
    expect(attachedRequirements).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: `/documents/${document.id}/requirements` })).json().items).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: `/documents/${document.id}` })).json().templateProvenance).toEqual(document.templateProvenance);
    expect((await app.inject({ method: "GET", url: "/documents/search?q=Acme&mode=words" })).json().total).toBeGreaterThan(0);
  });

  it("rejects unknown suggestions and keeps the document workflow available for samples", async () => {
    app = await testApp();
    const bad = await app.inject({ method: "POST", url: "/templates/cloud-service-agreement/create", payload: { values: deal, selectedRequirementIds: ["made-up"] } });
    expect(bad.statusCode).toBe(400);
    const sample = await app.inject({ method: "POST", url: "/templates/clause-sample-mutual-nda-acme/create", payload: { values: {}, selectedRequirementIds: [] } });
    expect(sample.statusCode).toBe(201);
    expect(sample.json().document.templateProvenance.source).toBe("CLAUSE sample");
  });

  it("inserts literal dollar sequences into template values", async () => {
    app = await testApp();
    const value = "Acme $& $$ Legal";
    const r = await app.inject({ method: "POST", url: "/templates/cloud-service-agreement/create", payload: { values: { ...deal, provider_name: value }, selectedRequirementIds: [] } });
    expect(r.statusCode).toBe(201);
    expect(r.json().document.content).toContain(value);
  });

  it("returns a useful partial-success result if attaching a selected requirement fails", async () => {
    app = await testApp();
    const original = app.store.addRequirement.bind(app.store);
    let calls = 0;
    app.store.addRequirement = async (...args) => {
      calls += 1;
      if (calls === 2) throw new Error("simulated storage failure");
      return original(...args);
    };
    const r = await app.inject({ method: "POST", url: "/templates/cloud-service-agreement/create", payload: { values: deal, selectedRequirementIds: ["confidentiality", "termination", "liability"] } });
    expect(r.statusCode).toBe(201);
    expect(r.json().document.id).toBeTruthy();
    expect(r.json().attachedRequirements).toHaveLength(1);
    expect(r.json().attachmentError).toContain("document was created");
  });
});
