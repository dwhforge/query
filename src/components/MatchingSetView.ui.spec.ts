import { test, expect } from "@playwright/test";
import { mount } from "./MatchingWorkspace.testHarness";

test("Matching set preview keeps dataset evaluation distinct from a sampled Estimate", async ({ page }) => {
  await mount(page, 2);
  const set = page.getByTestId("matching-set-view");
  await expect(set).toBeVisible();
  const table = set.getByRole("region", { name: "Proposed relationships table" });
  const before = await table.getByRole("row").count();
  const percent = set.getByTestId("matching-estimate-percent");
  await expect(percent).toHaveValue("5");
  await set.getByTestId("matching-estimate-run").click();
  await expect(set.getByTestId("matching-estimate-result")).toContainText("acquired LEFT keys");
  await expect(set.getByTestId("matching-estimate-result")).toContainText("NOT a full-dataset result");
  expect(await table.getByRole("row").count()).toBe(before);
  expect(await page.evaluate(() => (window as any).session.decisions)).toEqual([]);
  await percent.fill("0");
  await expect(set.getByTestId("matching-estimate-run")).toBeDisabled();
  await percent.fill("25");
  await set.getByTestId("matching-estimate-run").click();
  await expect(set.getByTestId("matching-estimate-result")).toContainText("Sampled");
  expect(await table.getByRole("row").count()).toBe(before);
  await set.getByRole("button", { name: "Details" }).first().click();
  await expect(set.getByTestId("matching-set-details")).toBeVisible();
  await set.getByRole("button", { name: "Close" }).click();
  await set.getByTestId("matching-set-review").click();
  await expect(set.getByTestId("matching-set-review-panel")).toBeVisible();
});
