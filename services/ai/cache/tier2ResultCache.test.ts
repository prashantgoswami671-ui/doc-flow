/**
 * V8-A09 — Tests for Tier-2 result caching/reuse.
 *
 * Unit levels (identity, keys, store, validation) are pure and
 * synchronous. Reuse levels run the real pipeline end to end with
 * stubbed Ollama fetch (same harness pattern as
 * tier2Summarize.test.ts): real PDF fixtures, real B03/B04/C02/C03,
 * counted `/api/generate` calls prove avoided Ollama work.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTextVectorPdfBytes } from "../../pdf/__fixtures__/pdf";
import { createAiConsentStore, grantAiConsent } from "../consent";
import { OLLAMA_MODEL, OLLAMA_PROVIDER_ID } from "../ollama/types";
import { projectAllDetailModes } from "../stage2/detailModes";
import {
  MAX_STAGE2_EVIDENCE_ITEMS,
  Tier2ResultCache,
  buildTier2CacheKey,
  currentTier2PipelineFingerprint,
  hashDocumentBytes,
  isValidCachedTier2Entry,
  runTier2ValidatedSummarize,
} from "../tier2Summarize";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function fingerprint() {
  return currentTier2PipelineFingerprint();
}

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
  failGenerate?: boolean;
  counts?: { stage1: number; stage2: number };
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
      if (options.failGenerate === true) {
        throw new Error("generation transport down");
      }
      const body = JSON.parse(String(init?.body)) as { prompt: string };
      if (body.prompt.includes("Trusted evidence pool")) {
        stage2Calls += 1;
        if (options.counts) {
          options.counts.stage2 += 1;
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
      if (options.counts) {
        options.counts.stage1 += 1;
      }
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
  return { counts: () => ({ stage1Calls, stage2Calls }) };
}

function grantedStore() {
  const store = createAiConsentStore();
  grantAiConsent(store, OLLAMA_PROVIDER_ID);
  return store;
}

async function pdfFile(pages: number, name = "test.pdf") {
  const bytes = await buildTextVectorPdfBytes(pages);
  return new File([bytes as BlobPart], name, { type: "application/pdf" });
}

describe("A09 document identity", () => {
  it("same bytes hash identically; changed bytes hash differently", async () => {
    const bytes = await buildTextVectorPdfBytes(1);
    const first = hashDocumentBytes(bytes);
    const second = hashDocumentBytes(new Uint8Array(bytes));
    expect(second).toBe(first);
    expect(first).toMatch(/^[0-9a-f]+$/);
    const mutated = new Uint8Array(bytes);
    mutated[mutated.length - 1] = (mutated[mutated.length - 1] as number) ^ 0xff;
    expect(hashDocumentBytes(mutated)).not.toBe(first);
  });

  it("filename and path never enter content identity", async () => {
    const bytes = await buildTextVectorPdfBytes(1);
    expect(hashDocumentBytes(bytes)).toBe(hashDocumentBytes(new Uint8Array(bytes)));
  });

  it("same length with different content hashes differently", () => {
    const left = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const right = new Uint8Array([8, 7, 6, 5, 4, 3, 2, 1]);
    expect(hashDocumentBytes(left)).not.toBe(hashDocumentBytes(right));
  });
});

describe("A09 cache keys", () => {
  it("identical configuration yields identical keys", () => {
    const hash = "abc123";
    expect(buildTier2CacheKey(hash, fingerprint())).toBe(buildTier2CacheKey(hash, fingerprint()));
  });

  it("every fingerprint component change yields a different key", () => {
    const hash = "abc123";
    const base = buildTier2CacheKey(hash, fingerprint());
    const fields = ["extraction", "stage1", "selection", "sectioning", "stage2", "model"] as const;
    for (const field of fields) {
      const mutated = { ...fingerprint(), [field]: "changed" };
      expect(buildTier2CacheKey(hash, mutated)).not.toBe(base);
    }
    expect(buildTier2CacheKey("other", fingerprint())).not.toBe(base);
    const bumped = { ...fingerprint(), pipelineVersion: 999 };
    expect(buildTier2CacheKey(hash, bumped)).not.toBe(base);
  });

  it("malformed key inputs fail loud", () => {
    expect(() => buildTier2CacheKey("", fingerprint())).toThrow();
    expect(() => buildTier2CacheKey("x", { ...fingerprint(), model: "" })).toThrow();
  });

  it("live fingerprint pins the production budget", () => {
    expect(fingerprint().selection).toContain(String(MAX_STAGE2_EVIDENCE_ITEMS));
    // The §8 example: budget 64 vs 80 must key differently.
    const wider = { ...fingerprint(), selection: "budget-80" };
    expect(buildTier2CacheKey("h", wider)).not.toBe(buildTier2CacheKey("h", fingerprint()));
  });
});

describe("A09 cache store behavior", () => {
  it("miss on empty; constructor rejects non-positive capacity", () => {
    const cache = new Tier2ResultCache(2);
    expect(cache.size).toBe(0);
    const fp = fingerprint();
    expect(cache.lookup("nope", { documentHash: "h", fingerprint: fp })).toBeUndefined();
    expect(() => new Tier2ResultCache(0)).toThrow();
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it("lookup with mismatched hash is a safe miss that evicts", () => {
    const cache = new Tier2ResultCache();
    const fp = fingerprint();
    const key = buildTier2CacheKey("h", fp);
    cache.store({
      key,
      documentHash: "h",
      fingerprint: fp,
      providerId: "ollama",
      sourcePageCount: 1,
      pagesWithoutText: [],
      contextTruncated: false,
      chunks: [{ chunkIndex: 0, pageNumber: 1, text: "t", startOffset: 0, endOffset: 1 }],
      stage1: [{ chunkIndex: 0, candidates: ["t"] }],
      failedChunks: [],
      evidenceAdmitted: 1,
      selectedEvidenceIds: ["chunk-0-e0"],
      evidenceTruncated: false,
      sections: [{ sectionIndex: 0, pageRange: [1], evidenceIds: ["chunk-0-e0"] }],
      sectionTexts: [{ sectionIndex: 0, text: "[]" }],
      rejectedClaims: 0,
    });
    expect(cache.size).toBe(1);
    expect(cache.lookup(key, { documentHash: "h", fingerprint: fp })).toBeDefined();
    expect(cache.lookup(key, { documentHash: "wrong", fingerprint: fp })).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("LRU eviction drops the least-recently-used entry", () => {
    const cache = new Tier2ResultCache(2);
    const fp = fingerprint();
    const make = (hash: string) => ({
      key: buildTier2CacheKey(hash, fp),
      documentHash: hash,
      fingerprint: fp,
      providerId: "ollama",
      sourcePageCount: 1,
      pagesWithoutText: [],
      contextTruncated: false,
      chunks: [{ chunkIndex: 0, pageNumber: 1, text: "t", startOffset: 0, endOffset: 1 }],
      stage1: [{ chunkIndex: 0, candidates: ["t"] as unknown[] }],
      failedChunks: [] as number[],
      evidenceAdmitted: 1,
      selectedEvidenceIds: ["chunk-0-e0"],
      evidenceTruncated: false,
      sections: [{ sectionIndex: 0, pageRange: [1], evidenceIds: ["chunk-0-e0"] }],
      sectionTexts: [{ sectionIndex: 0, text: "[]" }],
      rejectedClaims: 0,
    });
    const meta = (hash: string) => ({ documentHash: hash, fingerprint: fp });
    cache.store(make("a"));
    cache.store(make("b"));
    // Refresh "a" so "b" is least-recently-used.
    expect(cache.lookup(buildTier2CacheKey("a", fp), meta("a"))).toBeDefined();
    cache.store(make("c"));
    expect(cache.size).toBe(2);
    expect(cache.lookup(buildTier2CacheKey("a", fp), meta("a"))).toBeDefined();
    expect(cache.lookup(buildTier2CacheKey("c", fp), meta("c"))).toBeDefined();
    expect(cache.lookup(buildTier2CacheKey("b", fp), meta("b"))).toBeUndefined();
  });

  it("storing an invalid entry throws (safe failure, never silent)", () => {
    const cache = new Tier2ResultCache();
    expect(() =>
      cache.store({ key: "k", documentHash: "h" } as never),
    ).toThrow();
  });

  it("entry validator rejects malformed, unknown-ID, and incomplete entries", async () => {
    const fp = fingerprint();
    const base = {
      key: "k",
      documentHash: "h",
      fingerprint: fp,
      providerId: "ollama",
      sourcePageCount: 1,
      pagesWithoutText: [],
      contextTruncated: false,
      chunks: [{ chunkIndex: 0, pageNumber: 1, text: "t", startOffset: 0, endOffset: 1 }],
      stage1: [{ chunkIndex: 0, candidates: ["t"] }],
      failedChunks: [],
      evidenceAdmitted: 1,
      selectedEvidenceIds: ["chunk-0-e0"],
      evidenceTruncated: false,
      sections: [{ sectionIndex: 0, pageRange: [1], evidenceIds: ["chunk-0-e0"] }],
      sectionTexts: [{ sectionIndex: 0, text: "[]" }],
      rejectedClaims: 0,
    };
    const expected = { key: "k", documentHash: "h", fingerprint: fp };
    expect(isValidCachedTier2Entry(base, expected)).toBe(true);
    expect(isValidCachedTier2Entry({ ...base, chunks: [] }, expected)).toBe(false);
    expect(isValidCachedTier2Entry({ ...base, selectedEvidenceIds: ["nope"] }, expected)).toBe(false);
    expect(isValidCachedTier2Entry({ ...base, sectionTexts: [] }, expected)).toBe(false);
    expect(
      isValidCachedTier2Entry({ ...base, fingerprint: { ...fp, model: "other" } }, expected),
    ).toBe(false);
    expect(isValidCachedTier2Entry({ ...base, documentHash: "other" }, expected)).toBe(false);
    expect(isValidCachedTier2Entry(null, expected)).toBe(false);
  });
});

describe("A09 reuse: hierarchical path", () => {
  function overBudgetStage1() {
    return { stage1: (_callIndex: number, chunkText: string) => JSON.stringify(sliceSpans(chunkText, 40)) };
  }

  it("cold miss computes; warm hit reuses with zero generate calls", async () => {
    const cache = new Tier2ResultCache();
    const file = await pdfFile(3);
    const counts = { stage1: 0, stage2: 0 };
    stubOllamaFetch({ ...overBudgetStage1(), counts });
    const cold = await runTier2ValidatedSummarize({ file, consentStore: grantedStore(), cache });
    expect(cold.status).toBe("grounded");
    expect(cold.cacheStatus).toBe("miss");
    expect(cold.avoidedStage1Calls).toBe(0);
    expect(counts.stage1).toBeGreaterThan(0);
    expect(counts.stage2).toBeGreaterThan(0);
    expect(cold.sectionCount).toBeGreaterThan(1);

    counts.stage1 = 0;
    counts.stage2 = 0;
    const warm = await runTier2ValidatedSummarize({ file, consentStore: grantedStore(), cache });
    expect(warm.status).toBe("grounded");
    expect(warm.cacheStatus).toBe("hit");
    expect(counts.stage1).toBe(0);
    expect(counts.stage2).toBe(0);
    expect(warm.avoidedStage1Calls).toBeGreaterThan(0);
    expect(warm.avoidedStage2Calls).toBe(cold.sectionCount);
    expect(JSON.stringify(warm.claims)).toBe(JSON.stringify(cold.claims));
    expect(warm.sectionCount).toBe(cold.sectionCount);
    expect(warm.groundedPages).toEqual(cold.groundedPages);
    expect(warm.evidenceAdmitted).toBe(cold.evidenceAdmitted);
  });

  it("warm hit succeeds even when generation transport is down", async () => {
    const cache = new Tier2ResultCache();
    const file = await pdfFile(3);
    stubOllamaFetch(overBudgetStage1());
    const cold = await runTier2ValidatedSummarize({ file, consentStore: grantedStore(), cache });
    expect(cold.status).toBe("grounded");
    stubOllamaFetch({ failGenerate: true });
    const warm = await runTier2ValidatedSummarize({ file, consentStore: grantedStore(), cache });
    expect(warm.status).toBe("grounded");
    expect(warm.cacheStatus).toBe("hit");
    expect(JSON.stringify(warm.claims)).toBe(JSON.stringify(cold.claims));
  });

  it("same bytes under a different filename still hit", async () => {
    const cache = new Tier2ResultCache();
    stubOllamaFetch(overBudgetStage1());
    const bytes = await buildTextVectorPdfBytes(3);
    const first = new File([bytes as BlobPart], "a.pdf", { type: "application/pdf" });
    const second = new File([bytes as BlobPart], "b.pdf", { type: "application/pdf" });
    const cold = await runTier2ValidatedSummarize({ file: first, consentStore: grantedStore(), cache });
    expect(cold.cacheStatus).toBe("miss");
    const warm = await runTier2ValidatedSummarize({ file: second, consentStore: grantedStore(), cache });
    expect(warm.cacheStatus).toBe("hit");
  });

  it("changed bytes miss and recompute (no cross-document leakage)", async () => {
    const cache = new Tier2ResultCache();
    const counts = { stage1: 0, stage2: 0 };
    stubOllamaFetch({ ...overBudgetStage1(), counts });
    const first = await runTier2ValidatedSummarize({
      file: await pdfFile(3, "a.pdf"),
      consentStore: grantedStore(),
      cache,
    });
    expect(first.cacheStatus).toBe("miss");
    counts.stage1 = 0;
    counts.stage2 = 0;
    const second = await runTier2ValidatedSummarize({
      file: await pdfFile(2, "a.pdf"),
      consentStore: grantedStore(),
      cache,
    });
    expect(second.cacheStatus).toBe("miss");
    expect(counts.stage1).toBeGreaterThan(0);
    expect(counts.stage2).toBeGreaterThan(0);
    expect(cache.size).toBe(2);
  });

  it("tampered selection identity causes safe live recompute", async () => {
    const cache = new Tier2ResultCache();
    const file = await pdfFile(3);
    const counts = { stage1: 0, stage2: 0 };
    stubOllamaFetch({ ...overBudgetStage1(), counts });
    const cold = await runTier2ValidatedSummarize({ file, consentStore: grantedStore(), cache });
    expect(cold.cacheStatus).toBe("miss");
    // Reach in through the public API only: replace the entry with a
    // well-shaped but wrong-identity sibling under the same key.
    const fingerprintNow = currentTier2PipelineFingerprint();
    const fileBytes = new Uint8Array(await file.arrayBuffer());
    const key = buildTier2CacheKey(hashDocumentBytes(fileBytes), fingerprintNow);
    const stored = cache.lookup(key, {
      documentHash: hashDocumentBytes(fileBytes),
      fingerprint: fingerprintNow,
    });
    expect(stored).toBeDefined();
    cache.store({ ...stored!, selectedEvidenceIds: ["chunk-0-e99"] });
    counts.stage1 = 0;
    counts.stage2 = 0;
    const recomputed = await runTier2ValidatedSummarize({ file, consentStore: grantedStore(), cache });
    expect(recomputed.cacheStatus).toBe("miss");
    expect(counts.stage1).toBeGreaterThan(0);
    expect(counts.stage2).toBeGreaterThan(0);
    expect(JSON.stringify(recomputed.claims)).toBe(JSON.stringify(cold.claims));
  });

  it("incomplete section set is rejected at store time", async () => {
    const cache = new Tier2ResultCache();
    stubOllamaFetch(overBudgetStage1());
    await runTier2ValidatedSummarize({
      file: await pdfFile(3),
      consentStore: grantedStore(),
      cache,
    });
    expect(cache.size).toBe(1);
    const fp = currentTier2PipelineFingerprint();
    const key = buildTier2CacheKey("h", fp);
    expect(() =>
      cache.store({
        key,
        documentHash: "h",
        fingerprint: fp,
        providerId: "ollama",
        sourcePageCount: 3,
        pagesWithoutText: [],
        contextTruncated: false,
        chunks: [{ chunkIndex: 0, pageNumber: 1, text: "t", startOffset: 0, endOffset: 1 }],
        stage1: [{ chunkIndex: 0, candidates: ["t"] }],
        failedChunks: [],
        evidenceAdmitted: 1,
        selectedEvidenceIds: ["chunk-0-e0"],
        evidenceTruncated: false,
        sections: [
          { sectionIndex: 0, pageRange: [1], evidenceIds: ["chunk-0-e0"] },
          { sectionIndex: 1, pageRange: [2], evidenceIds: ["chunk-0-e0"] },
        ],
        sectionTexts: [{ sectionIndex: 0, text: "[]" }],
        rejectedClaims: 0,
      }),
    ).toThrow();
  });

  it("A08 projections over warm cached claims need zero model calls", async () => {
    const cache = new Tier2ResultCache();
    stubOllamaFetch(overBudgetStage1());
    const file = await pdfFile(3);
    await runTier2ValidatedSummarize({ file, consentStore: grantedStore(), cache });
    const warm = await runTier2ValidatedSummarize({ file, consentStore: grantedStore(), cache });
    expect(warm.cacheStatus).toBe("hit");
    const all = projectAllDetailModes({
      claims: warm.claims,
      sourcePageCount: warm.sourcePageCount,
      pagesWithoutText: warm.pagesWithoutText,
      failedSections: warm.failedSections,
    });
    expect(all.concise.characterCount).toBeLessThanOrEqual(all.detailed.characterCount);
    expect(all.detailed.characterCount).toBeLessThanOrEqual(all["very-detailed"].characterCount);
    for (const claim of all["very-detailed"].claims) {
      expect(warm.claims).toContain(claim);
    }
  });
});

describe("A09 reuse: flat path + limited results", () => {
  it("single-section success is cached and reused", async () => {
    const cache = new Tier2ResultCache();
    const file = await pdfFile(1);
    const counts = { stage1: 0, stage2: 0 };
    stubOllamaFetch({ counts });
    const cold = await runTier2ValidatedSummarize({ file, consentStore: grantedStore(), cache });
    expect(cold.status).toBe("grounded");
    expect(cold.sectionCount).toBe(1);
    expect(cold.cacheStatus).toBe("miss");
    counts.stage1 = 0;
    counts.stage2 = 0;
    const warm = await runTier2ValidatedSummarize({ file, consentStore: grantedStore(), cache });
    expect(warm.cacheStatus).toBe("hit");
    expect(counts.stage1).toBe(0);
    expect(counts.stage2).toBe(0);
    expect(warm.avoidedStage2Calls).toBe(1);
    expect(JSON.stringify(warm.claims)).toBe(JSON.stringify(cold.claims));
  });

  it("limited results are never cached (retries always recompute)", async () => {
    const cache = new Tier2ResultCache();
    stubOllamaFetch({ stage1: () => JSON.stringify(["zzz absent zzz"]) });
    const first = await runTier2ValidatedSummarize({
      file: await pdfFile(1),
      consentStore: grantedStore(),
      cache,
    });
    expect(first.status).toBe("limited");
    expect(first.cacheStatus).toBe("miss");
    expect(cache.size).toBe(0);
    const second = await runTier2ValidatedSummarize({
      file: await pdfFile(1),
      consentStore: grantedStore(),
      cache,
    });
    expect(second.status).toBe("limited");
    expect(second.cacheStatus).toBe("miss");
    expect(cache.size).toBe(0);
  });

  it("non-cache option values are rejected fail-closed", async () => {
    stubOllamaFetch({});
    await expect(
      runTier2ValidatedSummarize({
        file: await pdfFile(1),
        consentStore: grantedStore(),
        cache: {},
      }),
    ).rejects.toMatchObject({ name: "Tier2ServiceError" });
  });

  it("no cache option means disabled metadata and unchanged behavior", async () => {
    stubOllamaFetch({});
    const result = await runTier2ValidatedSummarize({
      file: await pdfFile(1),
      consentStore: grantedStore(),
    });
    expect(result.status).toBe("grounded");
    expect(result.cacheStatus).toBe("disabled");
    expect(result.avoidedStage1Calls).toBe(0);
    expect(result.avoidedStage2Calls).toBe(0);
  });
});

describe("A09 security: nothing sensitive persists", () => {
  it("cache module uses no web/server persistence or egress APIs", () => {
    const source = readFileSync(join(__dirname, "tier2ResultCache.ts"), "utf8");
    for (const banned of [
      "localStorage",
      "sessionStorage",
      "IndexedDB",
      "indexedDB",
      "document.cookie",
      "XMLHttpRequest",
      "sendBeacon",
    ]) {
      expect(source).not.toContain(banned);
    }
  });

  it("stored entries carry no raw PDF bytes and round-trip as JSON", async () => {
    const cache = new Tier2ResultCache();
    stubOllamaFetch({});
    const file = await pdfFile(1);
    const raw = new Uint8Array(await file.arrayBuffer());
    await runTier2ValidatedSummarize({ file, consentStore: grantedStore(), cache });
    expect(cache.size).toBe(1);
    const fp = currentTier2PipelineFingerprint();
    const hash = hashDocumentBytes(raw);
    const entry = cache.lookup(buildTier2CacheKey(hash, fp), { documentHash: hash, fingerprint: fp });
    expect(entry).toBeDefined();
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain("%PDF");
    expect(serialized).not.toContain("JVBER");
    expect(serialized).not.toContain("password");
    // JSON round-trip preserves validity (plain-data proof).
    const revived = JSON.parse(serialized) as unknown;
    expect(
      isValidCachedTier2Entry(revived, {
        key: entry!.key,
        documentHash: hash,
        fingerprint: fp,
      }),
    ).toBe(true);
  });
});
