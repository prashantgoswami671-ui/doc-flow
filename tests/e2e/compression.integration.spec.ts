import { test, expect } from "@playwright/test";

/*
 * Phase 3.3 — Real Rasterizer Integration Tests
 *
 * These tests exercise the ACTUAL browser rasterization path (PDF.js +
 * canvas + JPEG encoding + pdf-lib reconstruction) with no mocks, against
 * the real production functions in services/pdf/compress.ts and
 * services/pdf/rasterize.ts. Driven by app/test/compression/page.tsx.
 *
 * This file intentionally does NOT modify rasterize.ts or compress.ts.
 *
 * KNOWN EXPECTED FAILURE — TEST C (rotation):
 * The Phase 3.3 audit identified that rasterize.ts's outputPdf.addPage()
 * call is never followed by outputPage.setRotation(...), so every output
 * page's /Rotate metadata comes back 0 regardless of the source page's
 * rotation. TEST C asserts the ideal invariant (rotation metadata should
 * be preserved) and is EXPECTED TO FAIL against the current production
 * rasterizer. That failure is the Phase 3.3 baseline finding this test
 * exists to capture — it must not be "fixed" by weakening the assertion
 * or by changing rasterize.ts.
 */

test.describe("Phase 3.3 — real rasterizer integration tests", () => {
  test.setTimeout(120_000);

  // Redundant with playwright.config.ts's workers:1/fullyParallel:false —
  // kept here too so this file stays correct on its own even if the
  // global config changes later. Each test rasterizes real PDFs through
  // PDF.js + canvas; running them concurrently previously produced
  // net::ERR_INSUFFICIENT_RESOURCES / renderer crashes (exit code
  // 3221226505) instead of usable results.
  test.describe.configure({ mode: "serial" });

  async function runAndGetResult(page: import("@playwright/test").Page, testId: string) {
    await page.goto("/test/compression");
    await page.getByTestId(testId).click();

    await expect(page.getByTestId("status")).not.toHaveText("running", {
      timeout: 120_000,
    });

    const hasError = await page.getByTestId("error").count();
    expect(hasError, "test harness reported an unexpected error").toBe(0);

    await expect(page.getByTestId("results")).toBeVisible();
    const resultsText = await page.getByTestId("results").textContent();

    return JSON.parse(resultsText || "{}");
  }

  test("TEST A — real rasterizer roundtrip produces a valid, correctly-sized PDF", async ({ page }) => {
    const r = await runAndGetResult(page, "run-test-a");

    expect(r.success).toBe(true);
    expect(r.notEmpty).toBe(true);
    expect(r.loadableByPdfLib).toBe(true);
    expect(r.pageCountPreserved).toBe(true);
    expect(r.dimensionsPreserved).toBe(true);
    expect(r.pageCount).toBe(2);
    expect(r.outputPageCount).toBe(2);
    // Recorded, not hard-asserted: a scanned/image fixture is expected to
    // shrink under Light settings, but this test's job is roundtrip
    // correctness, not compression ratio.
  });

  test("TEST B — physical dimension preservation across different page sizes (real rasterizer, direct call)", async ({ page }) => {
    const r = await runAndGetResult(page, "run-test-b");

    expect(r.success).toBe(true);
    expect(r.pageCount).toBe(3);
    expect(r.dimensionsPreserved).toBe(true);
  });

  test("TEST C — rotation baseline: metadata is NOT preserved (expected pre-existing defect); visual bounding box IS", async ({ page }) => {
    const r = await runAndGetResult(page, "run-test-c");
    test.fail(true, "Known Phase 3.3 baseline: rasterizer currently loses /Rotate metadata");
    expect(r.success).toBe(true);
    expect(r.pageCount).toBe(5);

    // Expected to PASS: PDF.js's scale-1 viewport already reflects
    // /Rotate, so the output page's physical (visual) bounding box
    // matches the source's rotated bounding box.
    expect(r.visualDimensionsPreserved).toBe(true);

    // Expected to FAIL against the current production rasterizer — see
    // file header. Left as the "correct" invariant on purpose.
    expect(r.rotationMetadataPreserved).toBe(true);
  });

  test("TEST D — real scanned PDF compression distinguishes genuine compression from fallback", async ({ page }) => {
    const r = await runAndGetResult(page, "run-test-d");

    expect(r.success).toBe(true);
    expect(r.pageCountPreserved).toBe(true);
    expect(r.notLarger).toBe(true);
    // Exactly one of these must be true — proven by byte equality, not
    // just a size comparison.
    expect(r.wasFallback || r.wasGenuineCompression).toBe(true);
    expect(r.wasFallback && r.wasGenuineCompression).toBe(false);
  });

  test("TEST E — real image-heavy PDF compression", async ({ page }) => {
    const r = await runAndGetResult(page, "run-test-e");

    expect(r.success).toBe(true);
    expect(r.pageCountPreserved).toBe(true);
    expect(r.notLarger).toBe(true);
  });

  test("TEST F — real text/vector PDF fallback behavior", async ({ page }) => {
    const r = await runAndGetResult(page, "run-test-f");

    expect(r.success).toBe(true);
    expect(r.pageCountPreserved).toBe(true);
    expect(r.notLarger).toBe(true);
    // Documented expectation from the Phase 3.3 inspection report: text/
    // vector content should be counterproductive to rasterize, tripping
    // the fallback-to-original path.
    expect(r.wasFallback).toBe(true);
  });

  test("TEST G — custom compression actually executes against the real rasterizer", async ({ page }) => {
    const r = await runAndGetResult(page, "run-test-g");

    expect(r.success).toBe(true);
    expect(r.pageCountPreserved).toBe(true);
    expect(r.customExecuted).toBe(true);
    expect(r.smallerThanOriginal).toBe(true);
    expect(r.processedSize).toBeLessThanOrEqual(r.originalSize);
    // Not hard-asserted: whether the binary search actually lands at or
    // under the requested target depends on real JPEG-encoding behavior
    // (see the audit's monotonicity-assumption risk). targetReached is
    // still recorded in the JSON for inspection.
  });
});
