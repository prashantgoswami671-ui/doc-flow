import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/*
 * V6-F03 — real browser E2E for the production-integrated Tier-2
 * Ollama summarization flow. No mocks anywhere: real PDF upload,
 * real browser extraction, real provider selection, real Ollama
 * availability, real consent/disclosure, real Stage-1, real B03
 * admission, real Stage-2, real C02 validation, real C03 grounding,
 * real grounded UI result.
 *
 * Fixture: benchmark-docs/Economic_Growth_vs_Development_WB_Jharkhand.pdf
 * (read-only; the same real document used by the F02 live runs).
 *
 * Prerequisite: local Ollama at http://127.0.0.1:11434 with qwen3:4b
 * installed and operator-running. This is checked explicitly up front;
 * a missing prerequisite fails clearly instead of skipping silently.
 * No fake provider or fallback is used.
 *
 * Asserts structural/user-facing success only (grounded result +
 * evidence + provider/UI states) — never exact model wording, claim
 * counts, or generated text. One passing run proves the path works,
 * not general model quality.
 */

const OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const REQUIRED_MODEL = "qwen3:4b";
const FIXTURE_NAME = "Economic_Growth_vs_Development_WB_Jharkhand.pdf";

test.describe("V6-F03 — production Tier-2 Ollama summarization", () => {
  // Real F02 wall times were 260–304s for this document; allow ample
  // time scoped to this block only (no global timeout change).
  test.setTimeout(600_000);

  test("selecting Ollama, approving consent, and summarizing shows a grounded result with source evidence", async ({
    page,
    request,
  }) => {
    // Explicit live prerequisite (fails clearly, never skips silently).
    // Uses the test runner's HTTP client, not the app, so a failure
    // here unambiguously means the environment prerequisite is absent.
    let tags: { models?: { name: string }[] };
    try {
      const response = await request.get(`${OLLAMA_BASE_URL}/api/tags`, {
        timeout: 30_000,
      });
      expect(
        response.ok(),
        `Ollama prerequisite missing: GET ${OLLAMA_BASE_URL}/api/tags not OK. ` +
          `Start the operator-run local Ollama service before this test.`,
      ).toBe(true);
      tags = (await response.json()) as { models?: { name: string }[] };
    } catch (error) {
      expect(
        false,
        `Ollama prerequisite missing: cannot reach ${OLLAMA_BASE_URL} ` +
          `(${error instanceof Error ? error.message : String(error)}). ` +
          `Start the operator-run local Ollama service before this test.`,
      ).toBe(true);
      return;
    }
    const modelNames = (tags.models ?? []).map((m) => m.name);
    expect(
      modelNames.some((name) => name === REQUIRED_MODEL || name.startsWith(`${REQUIRED_MODEL}:`)),
      `Ollama prerequisite missing: model ${REQUIRED_MODEL} not installed ` +
        `(installed: ${modelNames.join(", ") || "none"}). Run: ollama pull ${REQUIRED_MODEL}.`,
    ).toBe(true);

    // Load the real fixture PDF bytes in Node and upload through the
    // real production upload UI. No mocks, no interception.
    const pdfBuffer = readFileSync(join("benchmark-docs", FIXTURE_NAME));
    expect(pdfBuffer.length).toBeGreaterThan(0);

    await page.goto("/tools/summarize-pdf");
    await expect(
      page.getByRole("heading", { name: /Summarize PDF/i }).first(),
    ).toBeVisible();

    await page.locator('input[type="file"]').setInputFiles({
      name: FIXTURE_NAME,
      mimeType: "application/pdf",
      buffer: pdfBuffer,
    });
    await expect(page.getByText(FIXTURE_NAME)).toBeVisible();

    // Select the Ollama provider through the real production control
    // (locator form: this Playwright install lacks page.getByLabelText).
    await page.locator('input[name="ai-provider"][value="ollama"]').check();

    // Real availability must resolve to ready inside the app itself —
    // this also proves the test browser can reach 127.0.0.1:11434.
    await expect(page.getByText(/Ollama is available/i)).toBeVisible({
      timeout: 120_000,
    });

    // Real consent/disclosure flow: the disclosure must appear and no
    // generation may start before explicit approval.
    await expect(
      page.getByText("Send selected text to Ollama (qwen3:4b)."),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Send selected text to Ollama (qwen3:4b)" })
      .click();

    // Wait for the actual grounded result (real Stage-1 → B03 → Stage-2
    // → C02 → C03 against live Ollama, ~4–6 minutes observed in F02).
    await expect(page.getByText(/Summary ready/i)).toBeVisible({
      timeout: 540_000,
    });

    // The result must be grounded, not limited: no limited state and no
    // app error alert may replace it (scoped to <main>: the Next.js dev
    // overlay also exposes an alert role outside the application).
    await expect(page.getByText(/Limited result/i)).toHaveCount(0);
    await expect(page.locator("main").getByRole("alert")).toHaveCount(0);

    // Summary restatement section with non-empty claim text.
    await expect(
      page.getByRole("heading", { name: "Summary points" }),
    ).toBeVisible();
    const claimItems = page.locator(
      "//h3[text()='Summary points']/following-sibling::ul[1]/li",
    );
    expect(await claimItems.count()).toBeGreaterThan(0);
    const firstClaimText = ((await claimItems.first().textContent()) ?? "").trim();
    expect(firstClaimText.length).toBeGreaterThan(0);

    // Source evidence section, store-derived: deterministic evidence
    // IDs plus non-empty evidence text.
    await expect(
      page.getByRole("heading", { name: "Source evidence" }),
    ).toBeVisible();
    const evidenceItems = page.locator(
      "//h3[text()='Source evidence']/following-sibling::ul[1]/li",
    );
    expect(await evidenceItems.count()).toBeGreaterThan(0);
    const firstEvidenceId = ((await evidenceItems.first().textContent()) ?? "").trim();
    expect(firstEvidenceId).toMatch(/\[chunk-\d+-e\d+\]/);
    expect(firstEvidenceId.length).toBeGreaterThan("[chunk-0-e0]".length);

    // Provider indication identifies Ollama per the UI contract.
    await expect(page.getByText(/Ollama \(qwen3:4b\)/i).first()).toBeVisible();
  });
});
