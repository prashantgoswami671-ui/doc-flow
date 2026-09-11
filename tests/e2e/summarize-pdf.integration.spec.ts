import { expect, test } from "@playwright/test";
import { PDFDocument, StandardFonts } from "pdf-lib";

/*
 * Phase 1 closure — production Summarize PDF E2E regression test.
 *
 * Exercises the REAL production flow in a real browser with no mocks:
 * PDF upload -> PDF text extraction -> AI orchestration ->
 * production Browser AI runtime (WASM) -> AI generation ->
 * displayed non-empty summary.
 *
 * Route: /tools/summarize-pdf (SummarizePdfCard, production component).
 * Asserts only that a result appears and is non-empty — never exact wording.
 */

const E2E_TEXT =
  "DocFlow E2E test document. " +
  "Economic growth means an increase in the production of goods and services. " +
  "Economic development also considers improvements in human well-being.";

/** Builds a very small valid single-page text PDF in the Node test context. */
async function buildE2ePdfBytes(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([612, 792]);
  page.drawText(E2E_TEXT, {
    x: 50,
    y: 700,
    size: 12,
    font,
    maxWidth: 500,
    lineHeight: 16,
  });
  return pdf.save();
}

test.describe("Phase 1 closure — production Summarize PDF", () => {
  // Browser AI uses WASM and downloads/caches the model on first use, so
  // allow ample time scoped to this block only (no global timeout change).
  test.setTimeout(600_000);

  test("uploading a text PDF and summarizing shows a non-empty generated summary", async ({
    page,
  }) => {
    const pdfBytes = await buildE2ePdfBytes();

    await page.goto("/tools/summarize-pdf");

    // Production UI is rendered (the tool page shell renders an h1 and the
    // production card renders its own h2 with the same title).
    await expect(
      page.getByRole("heading", { name: /Summarize PDF/i }).first(),
    ).toBeVisible();
    await expect(
      page.getByText(/Choose a PDF to summarize/i),
    ).toBeVisible();

    const summarizeButton = page.getByRole("button", {
      name: /Summarize PDF/i,
    });
    await expect(summarizeButton).toBeDisabled();

    // Upload through the real production upload UI (hidden file input owned
    // by UploadZone). No mocks, no interception.
    await page
      .locator('input[type="file"]')
      .setInputFiles({
        name: "docflow-summarize-e2e.pdf",
        mimeType: "application/pdf",
        buffer: Buffer.from(pdfBytes),
      });

    await expect(page.getByText("docflow-summarize-e2e.pdf")).toBeVisible();
    await expect(summarizeButton).toBeEnabled();

    // Trigger the real Summarize action (extraction -> orchestration ->
    // production Browser AI runtime -> generation).
    await summarizeButton.click();

    // Meaningful UI state change: wait for the production result panel,
    // not an arbitrary sleep.
    await expect(page.getByText(/Summary ready/i)).toBeVisible({
      timeout: 540_000,
    });

    // The generated summary paragraph rendered by SummarizePdfCard inside
    // the ResultPanel must exist and be non-empty. Exact wording is
    // intentionally not asserted (it is real AI output).
    const summaryParagraph = page.locator("p.whitespace-pre-wrap");
    await expect(summaryParagraph).toBeVisible({ timeout: 30_000 });
    const summaryText = ((await summaryParagraph.textContent()) ?? "").trim();
    expect(summaryText.length).toBeGreaterThan(0);
  });
});
