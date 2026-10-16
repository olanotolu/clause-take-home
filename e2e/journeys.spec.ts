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

test("search selects the exact passage and edits directly from it", async ({ page, request }) => {
  const token = `zebracrossing${Date.now().toString(36)}`;
  const doc = await createDocument(request, { extra: `Schedule A: the ${token} fee applies.` });
  await page.goto("/#/documents");
  // The app is code-split, so the page can load before the shortcut handler exists: wait for a rendered view first.
  await page.getByRole("heading", { level: 1 }).first().waitFor();
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
  await expect(page.locator('[data-kind="sel"]')).toContainText(token);
  await page.getByRole("toolbar", { name: "Selected passage" }).getByRole("button", { name: "Replace" }).click();
  await page.getByRole("group", { name: "Replace selected passage" }).getByRole("textbox").fill(`${token}edited`);
  await page.getByRole("button", { name: "Stage change" }).click();
  await page.getByRole("button", { name: "Apply change", exact: true }).click();
  await expect(page.getByRole("region", { name: "Proposed changes" })).toBeHidden();
  const saved = (await (await request.get(`/api/documents/${doc.id}`)).json());
  expect(saved.version).toBe(2);
  expect(saved.content).toContain(`${token}edited`);
});

test("a stale search hit never selects unrelated text", async ({ page, request }) => {
  const token = `staleproof${Date.now().toString(36)}`;
  const doc = await createDocument(request, { extra: `The ${token} applies.` });
  await page.route("**/api/documents/search?**", async (route) => {
    const response = await route.fetch();
    const edited = await request.patch(`/api/documents/${doc.id}`, { data: { expectedVersion: 1, changes: [{ operation: "replace", target: { quote: { exact: "SERVICES AGREEMENT" } }, replacement: "A NEW AND MUCH LONGER SERVICES AGREEMENT HEADING" }] } });
    expect(edited.status()).toBe(200);
    await route.fulfill({ response });
  });
  await page.goto("/#/documents");
  // The app is code-split, so the page can load before the shortcut handler exists: wait for a rendered view first.
  await page.getByRole("heading", { level: 1 }).first().waitFor();
  await page.keyboard.press("ControlOrMeta+k");
  const dialog = page.getByRole("dialog", { name: "Search documents and clauses" });
  await dialog.getByRole("combobox").fill(token);
  await dialog.getByRole("option").first().click();
  await expect(page.getByText("This document changed or the passage could not be verified. Search again to select the current passage.")).toBeVisible();
  await expect(page.locator('[data-kind="sel"]')).toHaveCount(0);
});

test("opening a search result preserves a staged edit", async ({ page, request }) => {
  const token = `draftproof${Date.now().toString(36)}`;
  const doc = await createDocument(request, { extra: `The ${token} applies.` });
  await openDocument(page, doc.title);
  await stageReplacement(page, "two (2) years", "four (4) years");
  // The app is code-split, so the page can load before the shortcut handler exists: wait for a rendered view first.
  await page.getByRole("heading", { level: 1 }).first().waitFor();
  await page.keyboard.press("ControlOrMeta+k");
  const dialog = page.getByRole("dialog", { name: "Search documents and clauses" });
  await dialog.getByRole("combobox").fill(token);
  await dialog.getByRole("option").first().click();
  await expect(page.getByText("Apply or discard your staged changes before opening a document.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Proposed changes" })).toContainText("Valid");
  await page.getByRole("button", { name: "Apply change", exact: true }).click();
  await expect(page.getByRole("article", { name: "Document text" })).toContainText("four (4) years");
  expect((await (await request.get(`/api/documents/${doc.id}`)).json()).version).toBe(2);
});

test("opening a document title cannot discard another document's draft", async ({ page, request }) => {
  const first = await createDocument(request);
  const second = await createDocument(request);
  await openDocument(page, first.title);
  await stageReplacement(page, "two (2) years", "four (4) years");
  // The app is code-split, so the page can load before the shortcut handler exists: wait for a rendered view first.
  await page.getByRole("heading", { level: 1 }).first().waitFor();
  await page.keyboard.press("ControlOrMeta+k");
  const dialog = page.getByRole("dialog", { name: "Search documents and clauses" });
  await dialog.getByRole("option").filter({ hasText: second.title }).click();
  await expect(page.getByText("Apply or discard your staged changes before opening a document.")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(first.id));
  await expect(page.getByRole("region", { name: "Proposed changes" })).toBeVisible();
  await page.getByRole("button", { name: "Apply change", exact: true }).click();
  await expect(page.getByRole("article", { name: "Document text" })).toContainText("four (4) years");
  expect((await (await request.get(`/api/documents/${second.id}`)).json()).version).toBe(1);
});

test("an obsolete load cannot replace the document from a later navigation", async ({ page, request }) => {
  const first = await createDocument(request);
  const second = await createDocument(request);
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let loading = () => {};
  const started = new Promise<void>((resolve) => { loading = resolve; });
  await page.route(`**/api/documents/${first.id}`, async (route) => {
    const response = await route.fetch();
    loading();
    await held;
    await route.fulfill({ response });
  });
  await page.goto("/#/documents");
  await page.getByRole("link", { name: first.title }).click();
  await started;
  await page.evaluate((id) => { window.location.hash = `/doc/${id}/edit`; }, second.id);
  await expect(page.getByRole("heading", { level: 1, name: second.title })).toBeVisible();
  const returned = page.waitForResponse((response) => response.url().endsWith(`/api/documents/${first.id}`));
  release();
  await returned;
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  await expect(page.getByRole("heading", { level: 1, name: second.title })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(second.id));
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
