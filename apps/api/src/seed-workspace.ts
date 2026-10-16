import type { SeedPlaybook, SeedRequest } from "./store/types.ts";

/** Fictional sample playbooks and requests that go with the fictional sample contracts. Loaded only into an empty table. */
export const SEED_PLAYBOOKS: SeedPlaybook[] = [
  {
    name: "NDA Playbook",
    description: "Confidentiality, permitted exceptions, term and survival for non-disclosure agreements.",
    rules: [
      { title: "Mutual confidentiality", kind: "semantic", text: "Both parties are bound by the confidentiality obligations" },
      { title: "Compelled-disclosure exception", kind: "semantic", text: "Disclosure required by law, regulation or court order is permitted, after prompt written notice to the Disclosing Party" },
      { title: "Standard exclusions", kind: "semantic", text: "Confidential Information excludes information that is public, already known, independently developed, or rightfully received from a third party" },
      { title: "Survival period stated", kind: "semantic", text: "The confidentiality obligations survive termination for a stated number of years" },
      { title: "No perpetual term", kind: "absent", text: "perpetual" },
    ],
  },
  {
    name: "Data Privacy Playbook",
    description: "Processor terms for data processing addenda.",
    rules: [
      { title: "Documented instructions", kind: "semantic", text: "The Processor processes Personal Data only on the Controller's documented instructions" },
      { title: "Breach notification", kind: "semantic", text: "The Processor must notify the Controller of a Personal Data breach without undue delay" },
      { title: "Sub-processor authorization", kind: "semantic", text: "Sub-processors may only be engaged with the Controller's prior authorization" },
      { title: "Deletion or return", kind: "semantic", text: "At the end of the services the Processor deletes or returns the Personal Data" },
    ],
  },
  {
    name: "Commercial Agreement Playbook",
    description: "Liability, termination and payment terms for SaaS and services agreements.",
    rules: [
      { title: "Liability cap", kind: "semantic", text: "Each party's total liability is subject to a stated cap" },
      { title: "Termination notice", kind: "semantic", text: "Either party may terminate with a stated period of written notice" },
      { title: "Governing law", kind: "semantic", text: "The agreement states its governing law and venue" },
      { title: "Payment terms", kind: "semantic", text: "Payment is due within a stated number of days of the invoice" },
    ],
  },
  {
    name: "Employment Playbook",
    description: "Confidentiality and invention assignment for employee agreements.",
    rules: [
      { title: "Confidentiality continues", kind: "semantic", text: "The employee's confidentiality obligations continue after employment ends" },
      { title: "Invention assignment", kind: "semantic", text: "The employee assigns inventions made in the course of employment to the Employer" },
      { title: "Legally required disclosure", kind: "semantic", text: "Disclosure required by law is permitted" },
    ],
  },
];

export const SEED_REQUESTS: SeedRequest[] = [
  { documentTitle: "Mutual NDA - Acme Corp", title: "Mutual confidentiality for Acme", goal: "Make the confidentiality obligations mutual, preserve the existing exceptions, and keep the three-year survival period.", status: "inbox", priority: "high", type: "NDA", dueInDays: 2 },
  { documentTitle: "Data Processing Addendum - Soylent", title: "Review data retention terms", goal: "Require the Processor to delete or return Personal Data within thirty (30) days of the end of the services.", status: "inbox", priority: "medium", type: "Data & Privacy", dueInDays: 6 },
  { documentTitle: "MSA - Hooli", title: "Tighten liability and indemnification", goal: "Cap each party's liability and make indemnification mutual.", status: "in_progress", priority: "medium", type: "Commercial", dueInDays: 5 },
  { documentTitle: "SaaS Agreement - Initech", title: "Add termination for convenience", goal: "Either party may terminate for convenience on thirty (30) days written notice.", status: "in_progress", priority: "low", type: "Commercial" },
  { documentTitle: "Employee Confidentiality Agreement - Stark", title: "Confirm invention assignment wording", goal: "The employee assigns inventions made in the course of employment to the Employer.", status: "completed", priority: "low", type: "Employment" },
];
