import { z } from "zod";
import { CreateTemplateBody, DocumentOut, RequirementOut, TemplateIdParams, TemplateOut, errors } from "../schemas.ts";
import { SOURCE_TEXT } from "../templates/source-text.ts";
import { SEED_DOCUMENTS } from "../seed-data.ts";
import * as docs from "../documents.ts";
import type { App } from "../types.ts";
import type { RequirementKind, TemplateProvenance } from "../store/types.ts";

const LICENSE = "Creative Commons Attribution 4.0 International (CC BY 4.0)";
const JURISDICTION = "US-first drafting resource. Governing law is a user-filled field; this is not state-specific legal advice or approval.";
const source = (slug: string) => SOURCE_TEXT[slug] ?? "";
const vars = [
  { id: "provider_name", label: "Provider / disclosing party", required: true, placeholder: "[Provider legal name]", helpText: "Use the legal entity name shown in the signature block." },
  { id: "customer_name", label: "Customer / receiving party", required: true, placeholder: "[Customer legal name]", helpText: "Use the counterparty's full legal entity name." },
  { id: "effective_date", label: "Effective date", required: true, placeholder: "[Effective date]", helpText: "Enter a date, or a clearly defined commencement event." },
  { id: "business_scope", label: "Purpose / scope", required: true, placeholder: "[Describe the purpose or services]", helpText: "Summarize the business purpose, product, or services covered." },
  { id: "fees", label: "Fees", required: false, placeholder: "[Add fees or state that no fees apply]", helpText: "Optional. Leave blank to retain this visible drafting prompt." },
  { id: "governing_law", label: "Governing law", required: false, placeholder: "[Choose governing law]", helpText: "Optional. Confirm the applicable state and venue with counsel." },
];
type Cat = "NDA" | "Commercial" | "Data & Privacy" | "Vendor & Services" | "Employment";
type Kind = RequirementKind;
type Def = { id: string; title: string; category: Cat; description: string; sourceUrl: string; version: string; slug?: string; sourceType?: "download" | "adaptation"; featured?: boolean; content?: string; custom?: boolean };
const defs: Def[] = [
  { id: "mutual-nda", title: "Mutual Non-Disclosure Agreement", category: "NDA", description: "Protect confidential information shared by either party during evaluation or business discussions.", sourceUrl: "https://commonpaper.com/standards/mutual-nda/1.0", version: "1.0", slug: "mutual-nda", featured: true },
  { id: "one-way-nda", title: "One-Way Non-Disclosure Agreement", category: "NDA", sourceType: "download", slug: "one-way-nda", description: "Protect information disclosed by one party to a recipient.", sourceUrl: "https://commonpaper.com/documents/one-way-nda/", version: "Downloadable form (unversioned; 2025)", featured: true },
  { id: "cloud-service-agreement", title: "Cloud Service Agreement", category: "Commercial", description: "Terms for providing hosted software and related support to a business customer.", sourceUrl: "https://commonpaper.com/standards/cloud-service-agreement/2.1", version: "2.1", slug: "cloud-service-agreement", featured: true },
  { id: "terms-of-service", title: "Terms of Service", category: "Commercial", sourceType: "download", slug: "terms-of-service", description: "Click-through terms for business cloud services, including access, acceptable use, and account responsibilities.", sourceUrl: "https://commonpaper.com/standards/terms-of-service/", version: "2.1 (CSA Standard Terms)", featured: true },
  { id: "sla", title: "Service Level Agreement", category: "Commercial", description: "Availability commitments, service credits, support response targets, and exclusions.", sourceUrl: "https://commonpaper.com/standards/service-level-agreement/2.0", version: "2.0", slug: "sla" },
  { id: "dpa", title: "Data Processing Agreement", category: "Data & Privacy", description: "Processor terms for handling personal data, security, subprocessors, and data subject requests.", sourceUrl: "https://commonpaper.com/standards/data-processing-agreement/1.1", version: "1.1", slug: "dpa", featured: true },
  { id: "baa", title: "Business Associate Agreement", category: "Data & Privacy", description: "HIPAA-related terms for permitted uses, safeguards, breach reporting, and subcontractors.", sourceUrl: "https://commonpaper.com/standards/business-associate-agreement/1.0", version: "1.0", slug: "baa" },
  { id: "ai-addendum", title: "AI Addendum", category: "Data & Privacy", description: "Supplemental terms covering AI features, data use, model training, and output risks.", sourceUrl: "https://commonpaper.com/standards/ai-addendum/1.0", version: "1.0", slug: "ai-addendum", featured: true },
  { id: "professional-services-agreement", title: "Professional Services Agreement", category: "Vendor & Services", description: "Framework terms for consulting and implementation services, with project scope in statements of work.", sourceUrl: "https://commonpaper.com/standards/professional-services-agreement/1.1", version: "1.1", slug: "professional-services-agreement", featured: true },
  { id: "software-license-agreement", title: "Software License Agreement", category: "Commercial", description: "License terms for software delivered or installed for a business customer.", sourceUrl: "https://commonpaper.com/standards/software-license-agreement/1.1", version: "1.1", slug: "software-license-agreement" },
  { id: "pilot-agreement", title: "Pilot Agreement", category: "Commercial", description: "Time-limited trial terms for evaluating a product before a broader commitment.", sourceUrl: "https://commonpaper.com/standards/pilot-agreement/1.1", version: "1.1", slug: "pilot-agreement" },
  { id: "partnership-agreement", title: "Partnership Agreement", category: "Vendor & Services", description: "Terms for a commercial collaboration, referrals, and co-marketing activities.", sourceUrl: "https://commonpaper.com/standards/partnership-agreement/1.1", version: "1.1", slug: "partnership-agreement" },
  { id: "independent-contractor-agreement", title: "Independent Contractor Agreement", category: "Employment", sourceType: "download", slug: "independent-contractor-agreement", description: "Engagement terms for an independent consultant, work product, confidentiality, and payment.", sourceUrl: "https://commonpaper.com/documents/independent-contractor-agreement/", version: "Downloadable form (unversioned)" },
  { id: "amendment", title: "Amendment to Agreement", category: "Commercial", sourceType: "download", slug: "amendment", description: "A short form for changing specific provisions while leaving the underlying agreement in effect.", sourceUrl: "https://commonpaper.com/documents/amendment/", version: "Downloadable form (unversioned)" },
  { id: "statement-of-work", title: "Statement of Work", category: "Vendor & Services", sourceType: "download", slug: "statement-of-work", description: "Project-level scope, milestones, deliverables, assumptions, and fees under a services agreement.", sourceUrl: "https://commonpaper.com/documents/statement-of-work/", version: "Downloadable form (unversioned; PSA 1.1 reference)" },
  { id: "order-form", title: "Cloud Service Order Form", category: "Commercial", sourceType: "download", slug: "order-form", description: "Commercial order details for a cloud subscription, fees, term, support, and selected services.", sourceUrl: "https://commonpaper.com/documents/order-form", version: "2.1 (CSA order form)" },
  { id: "clause-sample-mutual-nda-acme", title: "Mutual NDA — Acme Corp (CLAUSE sample)", category: "NDA", description: "Fictional CLAUSE sample document for demo and onboarding.", sourceUrl: "", version: "CLAUSE sample", custom: true },
  { id: "clause-sample-saas-initech", title: "SaaS Agreement — Initech (CLAUSE sample)", category: "Commercial", description: "Fictional CLAUSE sample document for demo and onboarding.", sourceUrl: "", version: "CLAUSE sample", custom: true },
  { id: "clause-sample-msa-hooli", title: "MSA — Hooli (CLAUSE sample)", category: "Commercial", description: "Fictional CLAUSE sample document for demo and onboarding.", sourceUrl: "", version: "CLAUSE sample", custom: true },
  { id: "clause-sample-employment-stark", title: "Employment Confidentiality Agreement — Stark (CLAUSE sample)", category: "Employment", description: "Fictional CLAUSE sample document for demo and onboarding.", sourceUrl: "", version: "CLAUSE sample", custom: true },
  { id: "clause-sample-dpa-soylent", title: "Data Processing Addendum — Soylent (CLAUSE sample)", category: "Data & Privacy", description: "Fictional CLAUSE sample document for demo and onboarding.", sourceUrl: "", version: "CLAUSE sample", custom: true },
];

const ciFor = (category: Cat) => {
  const common: { id: string; title: string; kind: Kind; text: string }[] = [
    { id: "confidentiality", title: "Protect confidential information", kind: "present", text: "The agreement requires each recipient to protect confidential information and limits use to the stated purpose." },
    { id: "termination", title: "Review termination rights", kind: "present", text: "The agreement states clear termination rights and what happens to data or materials when it ends." },
    { id: "liability", title: "Review liability limits", kind: "present", text: "The agreement states an aggregate liability cap and identifies any exceptions." },
  ];
  if (category === "Data & Privacy") return [common[0]!, { id: "security", title: "Require security safeguards", kind: "present" as Kind, text: "The processor or business associate must maintain appropriate safeguards and report security incidents." }, { id: "subprocessors", title: "Control subprocessors", kind: "present" as Kind, text: "Subprocessor use is subject to notice, flow-down duties, and an objection or approval process." }];
  if (category === "NDA") return [common[0]!, { id: "exceptions", title: "Include standard confidentiality exclusions", kind: "present" as Kind, text: "Confidential information excludes information independently developed, lawfully received, already known, or publicly available without breach." }, { id: "return-delete", title: "Address return or deletion", kind: "present" as Kind, text: "The recipient must return or destroy confidential information on request, subject to narrow archival retention." }];
  return common;
};
const cleanup = (s: string) => s.replaceAll("<br>", "\n").replaceAll("&nbsp;", " ").trim();
const SEED_CONTENT_BY_TITLE = Object.fromEntries(SEED_DOCUMENTS.map((d) => [d.title, d.content])) as Record<string, string>;
const sampleContent = (title: string) => SEED_CONTENT_BY_TITLE[title] ?? "";
// Kept in this module to make the initial five fictional examples explicit and clearly distinguishable from licensed source forms.
const sampleFor = (id: string) => id.includes("mutual") ? sampleContent("Mutual NDA - Acme Corp") : id.includes("saas") ? sampleContent("SaaS Agreement - Initech") : id.includes("msa") ? sampleContent("MSA - Hooli") : id.includes("employment") ? sampleContent("Employee Confidentiality Agreement - Stark") : sampleContent("Data Processing Addendum - Soylent");

export const TEMPLATES = defs.map((d) => {
  const isSample = d.id.startsWith("clause-sample-");
  const provenance = isSample ? null : {
    source: d.sourceType === "adaptation" ? "CLAUSE adaptation" : "Common Paper",
    attribution: d.sourceType === "adaptation" ? `CLAUSE adaptation informed by Common Paper ${d.title}. Source: ${d.sourceUrl}.` : d.sourceType === "download" ? `Derived from the Common Paper ${d.title} downloadable form (source version: ${d.version}).` : `Derived from Common Paper ${d.title} Standard Terms, version ${d.version}.`,
  };
  const fields = isSample ? [] : [...vars];
  const details = fields.length ? `# Deal Details\n\nProvider / disclosing party: {{provider_name}}\n\nCustomer / receiving party: {{customer_name}}\n\nEffective date: {{effective_date}}\n\nPurpose / service scope: {{business_scope}}\n\nFees: {{fees}}\n\nGoverning law: {{governing_law}}\n\n---\n\n` : "";
  let content = d.content ?? (d.slug ? source(d.slug) : sampleFor(d.id));
  content = cleanup(content);
  if (d.slug === "mutual-nda") content = content.replace(/^# Standard Terms/m, "# Mutual Non-Disclosure Agreement — Standard Terms");
  const sourceNote = isSample ? "Fictional CLAUSE sample. Not a legal standard or licensed source document." : `\n\n---\n\n**Source and attribution:** ${provenance!.attribution} Source: ${d.sourceUrl}. Licensed under CC BY 4.0. This CLAUSE copy may contain edits and added deal fields.`;
  return {
    id: d.id, title: d.title, category: d.category, description: d.description, featured: !!d.featured,
    content: details + content + sourceNote,
    source: isSample ? "CLAUSE sample" : d.sourceType === "adaptation" ? "CLAUSE adaptation" : "Common Paper",
    attribution: isSample ? "Fictional sample content created for CLAUSE." : provenance!.attribution,
    sourceUrl: d.sourceUrl, sourceVersion: d.version,
    license: isSample ? "Not applicable — fictional CLAUSE sample" : LICENSE,
    jurisdictionNote: JURISDICTION,
    variables: fields,
    suggestedRequirements: isSample ? [] : ciFor(d.category),
  };
});

export function registerTemplateRoutes(app: App, createLimit: { max: number; timeWindow: string }): void {
  app.get("/templates", { schema: { response: { 200: z.object({ items: TemplateOut.array() }), ...errors(500) } } }, async () => ({ items: TEMPLATES }));
  app.post("/templates/:id/create", { config: { rateLimit: createLimit }, schema: { params: TemplateIdParams, body: CreateTemplateBody, response: { 201: z.object({ document: DocumentOut, attachedRequirements: RequirementOut.array(), attachmentError: z.string().optional() }), ...errors(400, 404, 413, 429, 500) } } }, async (req, reply) => {
    const template = TEMPLATES.find((t) => t.id === req.params.id);
    if (!template) return reply.code(404).send({ error: "Template not found", code: 404, type: "TEMPLATE_NOT_FOUND" });
    const missing = template.variables.filter((v) => v.required && !req.body.values[v.id]?.trim()).map((v) => v.label);
    if (missing.length) return reply.code(400).send({ error: `Complete required fields: ${missing.join(", ")}`, code: 400, type: "MISSING_TEMPLATE_FIELDS", details: { fields: missing } });
    const known = new Set(template.variables.map((v) => v.id));
    if (Object.keys(req.body.values).some((key) => !known.has(key))) return reply.code(400).send({ error: "Unknown template field", code: 400, type: "UNKNOWN_TEMPLATE_FIELD" });
    const selected = req.body.selectedRequirementIds;
    const selectedRequirements = template.suggestedRequirements.filter((r) => selected.includes(r.id));
    if (selectedRequirements.length !== selected.length) return reply.code(400).send({ error: "Unknown Clause CI suggestion", code: 400, type: "UNKNOWN_TEMPLATE_REQUIREMENT" });
    let content = template.content;
    for (const field of template.variables) {
      const value = req.body.values[field.id]?.trim() || field.placeholder;
      content = content.replaceAll(`{{${field.id}}}`, () => value);
    }
    const provenance: TemplateProvenance = {
      templateId: template.id, title: template.title, source: template.source, attribution: template.attribution,
      sourceUrl: template.sourceUrl, sourceVersion: template.sourceVersion, license: template.license, jurisdictionNote: template.jurisdictionNote,
    };
    const created = await docs.createDocument(app.store, { title: req.body.title?.trim() || `${template.title} — ${req.body.values.provider_name?.trim() || "Draft"}`, content, templateProvenance: provenance });
    if (!created.ok) return reply.problem(created.error);
    const attachedRequirements = [];
    let attachmentError: string | undefined;
    for (const rule of selectedRequirements) {
      try { attachedRequirements.push(await app.store.addRequirement(created.value.id, { kind: rule.kind as RequirementKind, text: rule.text })); }
      catch { attachmentError = "The document was created, but one or more Clause CI suggestions could not be attached. You can add them from the document."; break; }
    }
    const payload = { document: created.value, attachedRequirements, ...(attachmentError ? { attachmentError } : {}) };
    return reply.code(201).send(payload);
  });
}
