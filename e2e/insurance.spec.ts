import { test, expect } from "@playwright/test";

test("synthetic insurance review journey", async ({ page }) => {
  await page.goto("/#/insurance");
  await page.getByRole("button", { name: "Review evidence" }).click();
  await expect(page.getByText("The $2M aggregate limit does not satisfy", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: /View Current Policy Schedule/ }).first().click();
  await expect(page.getByText(/Verified passage/)).toBeVisible();
  await page.getByRole("button", { name: "Stage suggestion" }).click();
  await expect(page.getByText(/below the independent approved/)).toBeVisible();
  await page.getByRole("button", { name: "Discard proposal" }).click();
  await expect(page.getByText(/below the independent approved/)).toHaveCount(0);
  await page.getByRole("button", { name: "Introduce revised schedule" }).click();
  await expect(page.getByText(/Review is stale/)).toBeVisible();
  await page.getByRole("button", { name: "Review evidence" }).click();
  await expect(page.getByText(/stated per-occurrence limit now matches/)).toBeVisible();
  await page.getByRole("button", { name: "Replay scenarios" }).click();
  await expect(page.getByText(/Three illustrative examples/)).toBeVisible();
});
