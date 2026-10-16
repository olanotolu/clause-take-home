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
  // Results arrive after a debounce and a request; measure only once they are on screen.
  await expect(dialog.getByRole("option").first()).toBeVisible();
  await expectAccessible(page);
  await dialog.getByRole("option").first().click();
  await expect(page).toHaveURL(new RegExp(doc.id));
  await expect(page.getByRole("heading", { level: 1, name: doc.title })).toBeVisible();
});

test("the intro shows once on a first visit, is skippable, and never blocks a deep link", async ({ page }) => {
  await page.goto("/");
  const intro = page.getByRole("dialog", { name: "Welcome to CLAUSE" });
  await expect(intro).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: /land exactly where you point/ })).toBeVisible();
  await expectAccessible(page);

  // Scrolling through it ends on the one way in.
  await intro.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  const enter = page.getByRole("button", { name: /Open the workspace/ });
  await expect(enter).toBeVisible();
  await expectAccessible(page);
  await enter.click();
  await expect(intro).toBeHidden();
  await expect(page.getByRole("heading", { level: 1, name: "Workspace" })).toBeVisible();

  // Seen once, so a reload goes straight to the app; the replay link still works.
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Workspace" })).toBeVisible();
  await page.goto("/#/welcome");
  await expect(intro).toBeVisible();
  await page.getByRole("button", { name: "Skip intro" }).click();
  await expect(intro).toBeHidden();
});

test("a deep link on a first visit goes straight to the page, with no intro", async ({ page }) => {
  await page.goto("/#/documents");
  await expect(page.getByRole("heading", { level: 1, name: "Documents" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Welcome to CLAUSE" })).toBeHidden();
});
