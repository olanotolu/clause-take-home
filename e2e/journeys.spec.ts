import { expect, test } from "@playwright/test";
import { createDocument, expectAccessible, openDocument, stageReplacement } from "./helpers.ts";

test("edit, check it against a rule, apply, find it in Activity", async ({ page, request }) => {
  const doc = await createDocument(request, { requirements: [{ kind: "absent", text: "perpetual" }] });
  await openDocument(page, doc.title);
  await stageReplacement(page, "five (5) years", "a perpetual period");
  await expectAccessible(page);

  // The edit would break the "no perpetual term" rule, and Clause CI says so before anything is saved.
  await page.getByRole("button", { name: "Run Clause CI" }).first().click();
  await expect(page.getByRole("region", { name: "Clause CI results summary" })).toBeVisible();
  await expect(page.getByText("perpetual").first()).toBeVisible();
  await expect(page.getByLabel("Fails").first()).toBeVisible();
  await expectAccessible(page);

  // Applying still works (the checker informs, the human decides) and creates version 2.
  await page.getByRole("tab", { name: /Edit/ }).click();
  await page.getByRole("button", { name: /^Apply/ }).click();
  await expect(page.getByRole("region", { name: "Proposed changes" })).toBeHidden();
  const saved = (await (await request.get(`/api/documents/${doc.id}`)).json()) as { version: number; content: string };
  expect(saved).toMatchObject({ version: 2 });
  expect(saved.content).toContain("a perpetual period");
  await page.getByRole("tab", { name: "Activity" }).click();
  await expect(page.getByText(/perpetual period/).first()).toBeVisible();
  await expectAccessible(page);
});

test("a stale edit is refused and nothing is overwritten", async ({ page, request }) => {
  const doc = await createDocument(request);
  await openDocument(page, doc.title);
  await stageReplacement(page, "two (2) years", "three (3) years");

  // Someone else saves first, from the same version the page still shows.
  const other = await request.patch(`/api/documents/${doc.id}`, { data: { expectedVersion: 1, changes: [{ operation: "replace", target: { quote: { exact: "Delaware" } }, replacement: "New York" }] } });
  expect(other.status()).toBe(200);

  await page.getByRole("button", { name: /^Apply/ }).click();
  await expect(page.getByRole("region", { name: "Proposed changes" }).getByRole("alert").first()).toBeVisible();
  await expectAccessible(page);

  const now = (await (await request.get(`/api/documents/${doc.id}`)).json()) as { version: number; content: string };
  expect(now.version).toBe(2); // only the other writer's edit landed
  expect(now.content).toContain("New York");
  expect(now.content).toContain("two (2) years");
  expect(now.content).not.toContain("three (3) years");
});

test("search finds a clause and opens the document", async ({ page, request }) => {
  const token = `zebracrossing${Date.now().toString(36)}`;
  const doc = await createDocument(request, { extra: `Schedule A: the ${token} fee applies.` });
  await page.goto("/#/documents");
  await page.keyboard.press("ControlOrMeta+k");
  const dialog = page.getByRole("dialog", { name: "Search documents and clauses" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("combobox").fill(token);
  await expectAccessible(page);
  await dialog.getByRole("option").first().click();
  await expect(page).toHaveURL(new RegExp(doc.id));
  await expect(page.getByRole("heading", { level: 1, name: doc.title })).toBeVisible();
});
