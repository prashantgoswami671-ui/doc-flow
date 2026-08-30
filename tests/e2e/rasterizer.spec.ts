import { test, expect } from "@playwright/test";

test.describe("Phase 3.3 — real browser rasterizer", () => {
  test("light rasterizer produces a valid PDF with five pages", async ({
    page,
  }) => {
    await page.goto("/test/rasterizer");

    await page.getByTestId("run-light").click();

    await expect(page.getByTestId("status")).toBeHidden({
      timeout: 120_000,
    });

    await expect(page.getByTestId("error")).toBeHidden();

    await expect(page.getByTestId("result")).toBeVisible();

    await expect(page.getByTestId("page-count")).toHaveText(
      "Page count: 5",
    );

    for (let pageNumber = 1; pageNumber <= 5; pageNumber++) {
      await expect(
        page.getByTestId(`page-${pageNumber}`),
      ).toBeVisible();
    }
  });

  test("heavy rasterizer produces a valid PDF with five pages", async ({
    page,
  }) => {
    await page.goto("/test/rasterizer");

    await page.getByTestId("run-heavy").click();

    await expect(page.getByTestId("status")).toBeHidden({
      timeout: 120_000,
    });

    await expect(page.getByTestId("error")).toBeHidden();

    await expect(page.getByTestId("result")).toBeVisible();

    await expect(page.getByTestId("page-count")).toHaveText(
      "Page count: 5",
    );
  });

  test("custom rasterizer produces a valid PDF with five pages", async ({
    page,
  }) => {
    await page.goto("/test/rasterizer");

    await page.getByTestId("run-custom").click();

    await expect(page.getByTestId("status")).toBeHidden({
      timeout: 120_000,
    });

    await expect(page.getByTestId("error")).toBeHidden();

    await expect(page.getByTestId("result")).toBeVisible();

    await expect(page.getByTestId("page-count")).toHaveText(
      "Page count: 5",
    );
  });

  test("preserves the physical page geometry across different rasterization scales", async ({
    page,
  }) => {
    await page.goto("/test/rasterizer");

    await page.getByTestId("run-light").click();

    await expect(page.getByTestId("status")).toBeHidden({
      timeout: 120_000,
    });

    await expect(page.getByTestId("result")).toBeVisible();

    const lightDimensions = await page.evaluate(() => {
      return Array.from({ length: 5 }, (_, index) => ({
        width: document.querySelector(
          `[data-testid="page-${index + 1}-width"]`,
        )?.textContent,
        height: document.querySelector(
          `[data-testid="page-${index + 1}-height"]`,
        )?.textContent,
        rotation: document.querySelector(
          `[data-testid="page-${index + 1}-rotation"]`,
        )?.textContent,
      }));
    });

    await page.getByTestId("run-custom").click();

    await expect(page.getByTestId("status")).toBeHidden({
      timeout: 120_000,
    });

    await expect(page.getByTestId("result")).toBeVisible();

    const customDimensions = await page.evaluate(() => {
      return Array.from({ length: 5 }, (_, index) => ({
        width: document.querySelector(
          `[data-testid="page-${index + 1}-width"]`,
        )?.textContent,
        height: document.querySelector(
          `[data-testid="page-${index + 1}-height"]`,
        )?.textContent,
        rotation: document.querySelector(
          `[data-testid="page-${index + 1}-rotation"]`,
        )?.textContent,
      }));
    });

    expect(customDimensions).toEqual(lightDimensions);
  });

  test("preserves rotated-page geometry", async ({ page }) => {
    await page.goto("/test/rasterizer");

    await page.getByTestId("run-light").click();

    await expect(page.getByTestId("status")).toBeHidden({
      timeout: 120_000,
    });

    await expect(page.getByTestId("result")).toBeVisible();

    await expect(
      page.getByTestId("page-3-rotation"),
    ).toHaveText("90");

    await expect(
      page.getByTestId("page-4-rotation"),
    ).toHaveText("180");

    await expect(
      page.getByTestId("page-5-rotation"),
    ).toHaveText("270");

    await expect(
      page.getByTestId("page-3-width"),
    ).toHaveText("842");

    await expect(
      page.getByTestId("page-3-height"),
    ).toHaveText("595");
  });
});