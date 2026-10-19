import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
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
  const cancelled = page.waitForEvent("requestfailed", (request) => request.url().endsWith(`/api/documents/${first.id}`));
  await page.evaluate((id) => { window.location.hash = `/doc/${id}/edit`; }, second.id);
  await expect(page.getByRole("heading", { level: 1, name: second.title })).toBeVisible();
  release();
  await cancelled;
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  await expect(page.getByRole("heading", { level: 1, name: second.title })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(second.id));
});

test("a deep link opens the page directly", async ({ page }) => {
  await page.goto("/#/documents");
  await expect(page.getByRole("heading", { level: 1, name: "Documents" })).toBeVisible();
});

test("a sample is read-only, and applying an edit to it lands on your own copy", async ({ page, request }) => {
  // Samples are pinned first and carry a "Sample" tag; earlier runs may have left "(copy)" documents with the same prefix.
  await page.goto("/#/documents");
  await page.getByRole("link", { name: /^Mutual NDA - Acme Corp\s*Sample$/ }).click();
  await expect(page.getByText("Sample · read-only")).toBeVisible();
  await expectAccessible(page);
  await stageReplacement(page, '1.1 "Confidential Information"', '1.1 "Protected Information"');
  await expect(page.getByRole("button", { name: "Apply to a copy" })).toBeVisible();
  await page.getByRole("button", { name: "Apply to a copy" }).click();

  // We end on a different document: a normal one at v2, while the sample is exactly as it was.
  await expect(page.getByRole("heading", { level: 1, name: /Mutual NDA - Acme Corp \(copy\)/ })).toBeVisible();
  await expect(page.getByText("Sample · read-only")).toBeHidden();
  const list = (await (await request.get("/api/documents?limit=100")).json()) as { items: { id: string; title: string; version: number; sample?: boolean }[] };
  expect(list.items.find((d) => d.sample && d.title === "Mutual NDA - Acme Corp")?.version).toBe(1);
  expect(list.items.find((d) => d.title === "Mutual NDA - Acme Corp (copy)")).toMatchObject({ version: 2 });
  const sample = list.items.find((d) => d.sample && d.title === "Mutual NDA - Acme Corp")!;
  expect((await request.patch(`/api/documents/${sample.id}`, { data: { expectedVersion: 1, changes: [{ operation: "replace", target: { quote: { exact: "two (2) years" } }, replacement: "x" }] } })).status()).toBe(403);
});

test("a large document keeps selection and replacement outside function JSON bodies",async({page,request})=>{
  test.setTimeout(120000);
  const token=`largepassage${Date.now().toString(36)}`,title=`E2E Large ${token}`;
  const content=`${token}\n${"The parties shall protect confidential information.\n".repeat(22000)}\nTAIL_EVIDENCE`;
  const intent=(await (await request.post("/api/documents/uploads/intents",{data:{size:Buffer.byteLength(content)}})).json());
  expect((await request.post(`/api${intent.uploadUrl}?intent=${encodeURIComponent(intent.intent)}`,{headers:{"content-type":"text/plain"},data:content})).status()).toBe(204);
  const hash=createHash("sha256").update(content).digest("hex");
  const created=await request.post("/api/documents/uploads/complete",{data:{intent:intent.intent,title,sha256:hash}});expect(created.status()).toBe(201);const doc=await created.json();
  await request.post(`/api/documents/${doc.id}/requirements`,{data:{kind:"present",text:"replacementmarker"}});
  await page.addInitScript(()=>{
    const stats={longTasks:0,maxLongTaskMs:0,maxEventDurationMs:0};Reflect.set(window,"__clausePerformance",stats);
    new PerformanceObserver(list=>{for(const entry of list.getEntries()){stats.longTasks++;stats.maxLongTaskMs=Math.max(stats.maxLongTaskMs,entry.duration);}}).observe({type:"longtask",buffered:true});
    const eventOptions:PerformanceObserverInit & {durationThreshold:number}={type:"event",buffered:true,durationThreshold:16};
    new PerformanceObserver(list=>{for(const entry of list.getEntries())stats.maxEventDurationMs=Math.max(stats.maxEventDurationMs,entry.duration);}).observe(eventOptions);
  });
  const sizes:number[]=[];
  page.on("request",event=>{if(event.headers()["content-type"]?.includes("application/json"))sizes.push(event.postDataBuffer()?.byteLength??0);});
  await openDocument(page,title);
  await page.keyboard.press("ControlOrMeta+k");
  const search=page.getByRole("dialog",{name:"Search documents and clauses"});
  await search.getByRole("combobox").fill("TAIL_EVIDENCE");
  await search.getByRole("option").first().click();
  await expect(page.locator('[data-kind="sel"]')).toContainText("TAIL_EVIDENCE");
  await page.reload();await expect(page.getByRole("heading",{level:1,name:title})).toBeVisible();
  await stageReplacement(page,token,"replacementmarker ".repeat(70000));
  await expect(page.getByRole("region",{name:"Proposed changes"})).toBeVisible();
  await page.getByRole("button",{name:"Run Clause CI"}).first().click();
  await expect(page.getByRole("region",{name:"Clause CI results summary"})).toBeVisible();
  await page.getByRole("tab",{name:/Edit/}).click();
  await page.getByRole("button",{name:/^Apply/}).click();
  await expect(page.getByRole("region",{name:"Proposed changes"})).toBeHidden();
  const metadata=await request.get(`/api/documents/${doc.id}`,{headers:{Prefer:"return=minimal"}});
  expect((await metadata.json()).version).toBe(2);expect(sizes.every(size=>size<=1048576)).toBe(true);
  const performance=await page.evaluate(()=>Reflect.get(window,"__clausePerformance"));
  const metricPath=test.info().outputPath("large-document-browser-metrics.json");
  await writeFile(metricPath,JSON.stringify({project:test.info().project.name,fixtureBytes:Buffer.byteLength(content),largestJsonRequestBytes:Math.max(0,...sizes),...performance},null,2));
  await test.info().attach("large-document-browser-metrics",{path:metricPath,contentType:"application/json"});
  await expectAccessible(page);
});
