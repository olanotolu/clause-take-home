import AxeBuilder from "@axe-core/playwright";
import { expect, type APIRequestContext, type Page } from "@playwright/test";

export const CONTRACT = [
  "SERVICES AGREEMENT",
  "1. Term",
  "1.1 This Agreement lasts for a period of two (2) years from the date above.",
  "2. Confidentiality",
  "2.1 The Receiving Party shall not disclose Confidential Information to any third party.",
  "2.2 The obligations in Section 2 survive termination for a period of five (5) years.",
  "3. General",
  "3.1 This Agreement is governed by the laws of the State of Delaware.",
  "",
].join("\n\n");

let counter = 0;
/** A fresh document per test, created through the API the web app itself uses, so tests never depend on each other. */
export async function createDocument(request: APIRequestContext, opts: { requirements?: { kind: string; text: string }[]; extra?: string } = {}) {
  const title = `E2E Agreement ${Date.now().toString(36)}-${counter++}`;
  const created = await request.post("/api/documents", { data: { title, content: opts.extra ? `${CONTRACT}\n\n${opts.extra}` : CONTRACT } });
  expect(created.status()).toBe(201);
  const doc = (await created.json()) as { id: string };
  for (const r of opts.requirements ?? []) expect((await request.post(`/api/documents/${doc.id}/requirements`, { data: r })).status()).toBe(201);
  return { id: doc.id, title };
}

export async function openDocument(page: Page, title: string) {
  await page.goto("/#/documents");
  await page.getByRole("link", { name: title }).click();
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
}

/**
 * Selects `text` inside the document the way a drag would: the selection is made on the real text node and the pane
 * receives the mouseup it listens for. (Dragging by pixels is flaky across viewports; this exercises the same handler.)
 */
export async function selectPassage(page: Page, text: string) {
  await page.evaluate(async (needle) => {
    const scroller = document.querySelector<HTMLElement>(".cm-scroller");
    if (!scroller) throw new Error("document editor is not mounted");
    for (let attempt = 0; attempt < 200; attempt++) {
      for (const line of document.querySelectorAll<HTMLElement>(".cm-line")) {
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        const nodes: Text[] = [];
        while (walker.nextNode()) nodes.push(walker.currentNode as Text);
        const joined = nodes.map((node) => node.data).join("");
        const at = joined.indexOf(needle);
        if (at < 0) continue;
        const locate = (offset: number) => {
          let remaining = offset;
          for (const node of nodes) { if (remaining <= node.length) return { node, offset: remaining }; remaining -= node.length; }
          return { node: nodes.at(-1)!, offset: nodes.at(-1)!.length };
        };
        const start = locate(at), end = locate(at + needle.length);
        const range = document.createRange();
        range.setStart(start.node, start.offset);
        range.setEnd(end.node, end.offset);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        line.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        return;
      }
      const next = Math.min(scroller.scrollTop + Math.max(1, scroller.clientHeight * 0.8), scroller.scrollHeight);
      if (next <= scroller.scrollTop) break;
      scroller.scrollTop = next;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    throw new Error(`passage not found in the document: ${needle}`);
  }, text);
}

export async function stageReplacement(page: Page, passage: string, replacement: string) {
  await selectPassage(page, passage);
  await page.getByRole("toolbar", { name: "Selected passage" }).getByRole("button", { name: "Replace" }).click();
  await page.getByRole("group", { name: "Replace selected passage" }).getByRole("textbox").fill(replacement);
  await page.getByRole("button", { name: "Stage change" }).click();
  await expect(page.getByRole("region", { name: "Proposed changes" })).toBeVisible();
}

/** Fails on serious or critical accessibility violations; anything accepted must be listed in `known`, with a reason. */
export async function expectAccessible(page: Page, known: Record<string, string> = {}) {
  // Axe measures contrast on what is painted, so let entrance animations (opacity) finish first.
  await page.waitForFunction(() => document.getAnimations().every((a) => a.timeline !== document.timeline || a.effect?.getComputedTiming().iterations === Infinity || a.playState !== "running"));
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  const blocking = violations.filter((v) => (v.impact === "serious" || v.impact === "critical") && !(v.id in known));
  expect(blocking.map((v) => `${v.id}: ${v.help} (${v.nodes.length} nodes, e.g. ${v.nodes[0]?.target.join(" ")})`)).toEqual([]);
}
