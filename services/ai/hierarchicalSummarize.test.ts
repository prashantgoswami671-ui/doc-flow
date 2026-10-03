/**
 * V8-A07 — Integration tests for hierarchical Stage-2 orchestration.
 *
 * Exercises runTier2ValidatedSummarize end to end with stubbed Ollama
 * fetch (same harness pattern as tier2Summarize.test.ts): real PDF
 * fixtures, real B03/B04/C02/C03, over-budget pools that force the
 * multi-section path. No live Ollama.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTextVectorPdfBytes, toFile } from "../pdf/__fixtures__/pdf";
import { createAiConsentStore, grantAiConsent } from "./consent";
import { OLLAMA_MODEL, OLLAMA_PROVIDER_ID } from "./ollama/types";
import { MAX_STAGE2_EVIDENCE_ITEMS, runTier2ValidatedSummarize } from "./tier2Summarize";
import { SECTION_MAX_ITEMS } from "./stage2/sections";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function sliceSpans(chunkText: string, count: number): string[] {
  const spans: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const span = chunkText.slice(i * 5, i * 5 + 25);
    if (span.trim().length > 0) {
      spans.push(span);
    }
  }
  return spans;
}

function stubOllamaFetch(options: {
  stage1?: (callIndex: number, chunkText: string) => string | { throw: true };
  stage2?: (call: { index: number; pool: Array<{ evidenceId: string }> }) => string | { throw: true };
  calls?: { stage2: number };
}) {
  let stage1Calls = 0;
  let stage2Calls = 0;
  const mock = vi.fn(async (url: unknown, init?: { body?: unknown }) => {
    const target = String(url);
    if (target.endsWith("/api/tags")) {
      return {
        ok: true,
        json: () => Promise.resolve({ models: [{ name: OLLAMA_MODEL, model: OLLAMA_MODEL }] }),
      };
    }
    if (target.endsWith("/api/generate")) {
      const body = JSON.parse(String(init?.body)) as { prompt: string };
      if (body.prompt.includes("Trusted evidence pool")) {
        stage2Calls += 1;
        if (options.calls !== undefined) {
          options.calls.stage2 += 1;
        }
        const poolJson = body.prompt.slice(
          body.prompt.indexOf("Trusted evidence pool:\n") + "Trusted evidence pool:\n".length,
          body.prompt.lastIndexOf("\n\nTask:"),
        );
        const pool = JSON.parse(poolJson) as Array<{ evidenceId: string }>;
        const outcome = options.stage2
          ? options.stage2({ index: stage2Calls, pool })
          : JSON.stringify([
              { kind: "fact", text: "Section point.", evidenceIds: [pool[0]?.evidenceId] },
            ]);
        if (typeof outcome !== "string") {
          throw new Error("stage-2 generation failed");
        }
        return {
          ok: true,
          json: () =>
            Promise.resolve({ model: OLLAMA_MODEL, created_at: "t", response: outcome, done: true }),
        };
      }
      stage1Calls += 1;
      const chunkText = body.prompt.slice(body.prompt.indexOf("Document chunk:\n") + "Document chunk:\n".length);
      const outcome = options.stage1
        ? options.stage1(stage1Calls, chunkText)
        : JSON.stringify(sliceSpans(chunkText, 2));
      if (typeof outcome !== "string") {
        throw new Error("stage-1 generation failed");
      }
      return {
        ok: true,
        json: () =>
          Promise.resolve({ model: OLLAMA_MODEL, created_at: "t", response: outcome, done: true }),
      };
    }
    throw new Error(`unexpected url ${target}`);
  });
  vi.stubGlobal("fetch", mock);
}

async function testPdfFile(pages = 1) {
  return toFile(await buildTextVectorPdfBytes(pages));
}

function grantedStore() {
  const store = createAiConsentStore();
  grantAiConsent(store, OLLAMA_PROVIDER_ID);
  return store;
}

/** Over-budget fixture: ~40 admitted items per chunk across 3 chunks. */
function overBudgetStage1() {
  return {
    stage1: (_callIndex: number, chunkText: string) =>
      JSON.stringify(sliceSpans(chunkText, 40)),
  };
}

describe("hierarchical Stage-2 (V8-A07)", () => {
  it("partitions an over-budget pool into sections and assembles claims in order", async () => {
    const calls = { stage2: 0 };
    stubOllamaFetch({ ...overBudgetStage1(), calls });
    const result = await runTier2ValidatedSummarize({
      file: await testPdfFile(3),
      consentStore: grantedStore(),
    });
    expect(result.status).toBe("grounded");
    // Three 40-item page groups → three sections → three Stage-2 calls.
    expect(calls.stage2).toBe(3);
    expect(result.sectionCount).toBe(3);
    expect(result.failedSections).toEqual([]);
    expect(result.claims).toHaveLength(3);
    // Assembly order: section order, then claim order within sections.
    const firstIds = result.claims.map((c) => c.evidenceIds[0]);
    expect(firstIds).toEqual(["chunk-0-e0", "chunk-1-e0", "chunk-2-e0"]);
    // Root IDs preserved verbatim; no rewriting.
    for (const claim of result.claims) {
      for (const id of claim.evidenceIds) {
        expect(id).toMatch(/^chunk-\d+-e\d+$/);
      }
    }
    // Coverage metadata: all three fixture pages grounded.
    expect(result.groundedPages).toEqual([1, 2, 3]);
  });

  it("oversized atomic pages stay whole and total selection respects the budget", async () => {
    const seen: Array<Array<{ evidenceId: string }>> = [];
    stubOllamaFetch({
      ...overBudgetStage1(),
      stage2: ({ pool }) => {
        seen.push(pool);
        return JSON.stringify([
          { kind: "fact", text: "Point.", evidenceIds: [pool[0]?.evidenceId] },
        ]);
      },
    });
    const result = await runTier2ValidatedSummarize({
      file: await testPdfFile(3),
      consentStore: grantedStore(),
    });
    expect(result.status).toBe("grounded");
    // Page atomicity: every section pool carries exactly one chunk's items
    // (40-item pages stay whole instead of being split at 16).
    for (const pool of seen) {
      const chunks = new Set(pool.map((p) => p.evidenceId.split("-")[1]));
      expect(chunks.size).toBe(1);
    }
    // Total selected evidence still respects the 64-item budget.
    const totalSelected = seen.reduce((n, pool) => n + pool.length, 0);
    expect(totalSelected).toBeLessThanOrEqual(MAX_STAGE2_EVIDENCE_ITEMS);
    expect(totalSelected).toBeGreaterThan(SECTION_MAX_ITEMS);
  });

  it("a failed section is recorded as a gap while siblings survive", async () => {
    stubOllamaFetch({
      ...overBudgetStage1(),
      stage2: ({ index, pool }) => {
        if (index === 2) {
          return { throw: true };
        }
        return JSON.stringify([
          { kind: "fact", text: "Point.", evidenceIds: [pool[0]?.evidenceId] },
        ]);
      },
    });
    const result = await runTier2ValidatedSummarize({
      file: await testPdfFile(3),
      consentStore: grantedStore(),
    });
    expect(result.status).toBe("grounded");
    expect(result.sectionCount).toBe(3);
    expect(result.failedSections).toEqual([1]);
    expect(result.claims).toHaveLength(2);
    // Failed section's page is absent from grounded pages.
    expect(result.groundedPages).toEqual([1, 3]);
  });

  it("malformed output in every section maps to malformed-output", async () => {
    stubOllamaFetch({ ...overBudgetStage1(), stage2: () => "not json at all" });
    const result = await runTier2ValidatedSummarize({
      file: await testPdfFile(3),
      consentStore: grantedStore(),
    });
    expect(result.status).toBe("limited");
    expect(result.reason).toBe("malformed-output");
    expect(result.claims).toEqual([]);
    expect(result.sectionCount).toBe(3);
    expect(result.failedSections).toEqual([0, 1, 2]);
  });

  it("unknown IDs in one section fail only that section", async () => {
    stubOllamaFetch({
      ...overBudgetStage1(),
      stage2: ({ index, pool }) => {
        if (index === 2) {
          return JSON.stringify([
            { kind: "fact", text: "Bad.", evidenceIds: ["chunk-0-e99"] },
          ]);
        }
        return JSON.stringify([
          { kind: "fact", text: "Point.", evidenceIds: [pool[0]?.evidenceId] },
        ]);
      },
    });
    const result = await runTier2ValidatedSummarize({
      file: await testPdfFile(3),
      consentStore: grantedStore(),
    });
    expect(result.status).toBe("grounded");
    expect(result.failedSections).toEqual([1]);
    expect(result.claims).toHaveLength(2);
    expect(result.rejectedClaims).toBe(1);
  });

  it("a small pool takes the flat fallback with sectionCount 1", async () => {
    stubOllamaFetch({});
    const result = await runTier2ValidatedSummarize({
      file: await testPdfFile(),
      consentStore: grantedStore(),
    });
    expect(result.status).toBe("grounded");
    expect(result.sectionCount).toBe(1);
    expect(result.failedSections).toEqual([]);
    expect(result.groundedPages).toEqual([1]);
  });

  it("empty pool after selection limits without a Stage-2 call", async () => {
    const calls = { stage2: 0 };
    stubOllamaFetch({
      stage1: () => JSON.stringify(["zzz absent zzz"]),
      calls,
    });
    const result = await runTier2ValidatedSummarize({
      file: await testPdfFile(),
      consentStore: grantedStore(),
    });
    expect(result.status).toBe("limited");
    expect(result.reason).toBe("no-evidence");
    expect(calls.stage2).toBe(0);
    expect(result.sectionCount).toBe(0);
  });
});
