import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTextVectorPdfBytes, toFile } from "../pdf/__fixtures__/pdf";
import { createAiConsentStore, grantAiConsent } from "./consent";
import { OLLAMA_MODEL, OLLAMA_PROVIDER_ID } from "./ollama/types";
import { Tier2ServiceError } from "./tier2";
import {
  MAX_STAGE2_EVIDENCE_ITEMS,
  runTier2ValidatedSummarize,
} from "./tier2Summarize";

/**
 * V6-E01 — Unit tests for the validated Tier-2 summarize pipeline.
 *
 * No live Ollama: global `fetch` is stubbed to emulate `/api/tags` +
 * `/api/generate`, routed by prompt markers (Stage-1 carries
 * "Document chunk:", Stage-2 carries "Trusted evidence pool").
 * Real PDF fixtures; no UI; no research fixtures.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type TagsMode = "ok" | "no-model" | "down";

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
  tags?: TagsMode;
  stage1?: (callIndex: number, chunkText: string) => string | { throw: true };
  stage2?: (pool: Array<{ evidenceId: string }>) => string;
}) {
  const tags = options.tags ?? "ok";
  let stage1Calls = 0;
  let stage2Calls = 0;
  const stage1Prompts: string[] = [];
  const stage2Prompts: string[] = [];
  const urls: string[] = [];
  const mock = vi.fn(async (url: unknown, init?: { body?: unknown }) => {
    const target = String(url);
    urls.push(target);
    if (target.endsWith("/api/tags")) {
      if (tags === "down") {
        throw new Error("fetch failed");
      }
      const models =
        tags === "no-model"
          ? [{ name: "other:1b", model: "other:1b" }]
          : [{ name: OLLAMA_MODEL, model: OLLAMA_MODEL }];
      return { ok: true, json: () => Promise.resolve({ models }) };
    }
    if (target.endsWith("/api/generate")) {
      const body = JSON.parse(String(init?.body)) as { prompt: string };
      if (body.prompt.includes("Trusted evidence pool")) {
        stage2Calls += 1;
        const poolJson = body.prompt.slice(
          body.prompt.indexOf("Trusted evidence pool:\n") + "Trusted evidence pool:\n".length,
          body.prompt.lastIndexOf("\n\nTask:"),
        );
        const pool = JSON.parse(poolJson) as Array<{ evidenceId: string }>;
        const text = options.stage2
          ? options.stage2(pool)
          : JSON.stringify([
              { kind: "fact", text: "Summary point one.", evidenceIds: [pool[0]?.evidenceId] },
              {
                kind: "conclusion",
                text: "Overall conclusion.",
                evidenceIds: pool.slice(0, 2).map((p) => p.evidenceId),
              },
            ]);
        return {
          ok: true,
          json: () =>
            Promise.resolve({ model: OLLAMA_MODEL, created_at: "t", response: text, done: true }),
        };
      }
      stage1Calls += 1;
      stage1Prompts.push(body.prompt);
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
  return {
    urls,
    stage1Prompts,
    stage2Prompts: stage2Prompts as string[],
    counts: () => ({ stage1Calls, stage2Calls }),
    recordStage2(prompt: string) {
      stage2Prompts.push(prompt);
    },
  };
}

async function testPdfFile(pages = 1) {
  return toFile(await buildTextVectorPdfBytes(pages));
}

function grantedStore() {
  const store = createAiConsentStore();
  grantAiConsent(store, OLLAMA_PROVIDER_ID);
  return store;
}

async function serviceErrorOf(promise: Promise<unknown>): Promise<Tier2ServiceError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(Tier2ServiceError);
    return error as Tier2ServiceError;
  }
  throw new Error("expected Tier2ServiceError");
}

describe("STAGE 1 evidence acquisition", () => {
  it("1. candidate JSON array parses and admits evidence", async () => {
    stubOllamaFetch({});
    const result = await runTier2ValidatedSummarize({
      file: await testPdfFile(),
      consentStore: grantedStore(),
    });
    expect(result.status).toBe("grounded");
    expect(result.evidenceAdmitted).toBeGreaterThan(0);
  });

  it("2. malformed candidate JSON rejects the chunk but siblings survive", async () => {
    stubOllamaFetch({
      stage1: (callIndex, chunkText) =>
        callIndex === 1 ? "not json at all" : JSON.stringify(sliceSpans(chunkText, 2)),
    });
    const result = await runTier2ValidatedSummarize({
      file: await testPdfFile(3),
      consentStore: grantedStore(),
    });
    expect(result.failedChunks).toHaveLength(1);
    expect(result.status).toBe("grounded");
  });

  it("3. non-string candidate entries are rejected per-item, valid siblings admitted", async () => {
    stubOllamaFetch({
      stage1: (_callIndex, chunkText) => {
        const spans = sliceSpans(chunkText, 1);
        return JSON.stringify([spans[0], 42, null, { evidenceId: "x" }]);
      },
    });
    const result = await runTier2ValidatedSummarize({
      file: await testPdfFile(),
      consentStore: grantedStore(),
    });
    expect(result.status).toBe("grounded");
    expect(result.evidenceAdmitted).toBe(1);
  });

  it("4. exact spans pass B03 containment", async () => {
    stubOllamaFetch({});
    const result = await runTier2ValidatedSummarize({
      file: await testPdfFile(),
      consentStore: grantedStore(),
    });
    for (const claim of result.claims) {
      for (const g of claim.evidence) {
        expect(g.chunk.text.includes(g.item.exactText)).toBe(true);
      }
    }
  });

  it("5. non-contained spans are rejected", async () => {
    stubOllamaFetch({ stage1: () => JSON.stringify(["zzz not in the document zzz"]) });
    const result = await runTier2ValidatedSummarize({
      file: await testPdfFile(),
      consentStore: grantedStore(),
    });
    expect(result.status).toBe("limited");
    expect(result.reason).toBe("no-evidence");
  });

  it("6. model cannot mint IDs (object entries rejected, never stored)", async () => {
    stubOllamaFetch({
      stage1: (_callIndex, chunkText) =>
        JSON.stringify([
          { evidenceId: "chunk-0-e99", exactText: chunkText.slice(0, 20), kind: "number", value: "99" },
        ]),
    });
    const result = await runTier2ValidatedSummarize({
      file: await testPdfFile(),
      consentStore: grantedStore(),
    });
    expect(result.status).toBe("limited");
    expect(result.reason).toBe("no-evidence");
    expect(result.evidenceAdmitted).toBe(0);
  });

  it("7. duplicate spans retain B03 behavior (distinct IDs, both admitted)", async () => {
    stubOllamaFetch({
      stage1: (_callIndex, chunkText) => {
        const span = sliceSpans(chunkText, 1)[0] as string;
        return JSON.stringify([span, span]);
      },
    });
    const result = await runTier2ValidatedSummarize({
      file: await testPdfFile(),
      consentStore: grantedStore(),
    });
    expect(result.evidenceAdmitted).toBe(2);
    const ids = result.claims.flatMap((c) => c.evidence.map((g) => g.item.evidenceId));
    expect(new Set(ids).size).toBe(2);
  });

  it("8. numeric promotion stays B03-authoritative (model sends no kinds)", async () => {
    const { stage1Prompts } = stubOllamaFetch({});
    const result = await runTier2ValidatedSummarize({
      file: await testPdfFile(),
      consentStore: grantedStore(),
    });
    expect(stage1Prompts.join(" ").toLowerCase()).not.toContain('"kind"');
    for (const claim of result.claims) {
      for (const g of claim.evidence) {
        expect(["span", "number"]).toContain(g.item.kind);
        if (g.item.kind === "number") {
          expect(g.item.exactText.includes(g.item.value as string)).toBe(true);
        }
      }
    }
  });
});

describe("STORE + evidence budget", () => {
  it("9-10. evidence enters through admit in admission order", async () => {
    stubOllamaFetch({});
    const result = await runTier2ValidatedSummarize({
      file: await testPdfFile(),
      consentStore: grantedStore(),
    });
    const ids = result.claims.flatMap((c) => c.evidence.map((g) => g.item.evidenceId));
    expect(ids.length).toBeGreaterThan(0);
    expect(ids[0]).toBe("chunk-0-e0");
  });

  it("11-12. budget is deterministic and truncation is flagged", async () => {
    stubOllamaFetch({ stage1: (_callIndex, chunkText) => JSON.stringify(sliceSpans(chunkText, 40)) });
    const first = await runTier2ValidatedSummarize({
      file: await testPdfFile(),
      consentStore: grantedStore(),
    });
    const second = await runTier2ValidatedSummarize({
      file: await testPdfFile(),
      consentStore: grantedStore(),
    });
    expect(first.evidenceAdmitted).toBeGreaterThan(MAX_STAGE2_EVIDENCE_ITEMS);
    expect(first.evidenceTruncated).toBe(true);
    expect(JSON.stringify(first.claims)).toBe(JSON.stringify(second.claims));
    const poolIds = first.claims.flatMap((c) => [...c.evidenceIds]);
    for (const id of poolIds) {
      const sequence = Number(id.split("-e")[1]);
      expect(sequence).toBeLessThan(MAX_STAGE2_EVIDENCE_ITEMS);
    }
  });

  it("13. store contents survive projection (second run unaffected)", async () => {
    stubOllamaFetch({});
    const file = await testPdfFile();
    const first = await runTier2ValidatedSummarize({ file, consentStore: grantedStore() });
    const second = await runTier2ValidatedSummarize({ file, consentStore: grantedStore() });
    expect(first.evidenceAdmitted).toBe(second.evidenceAdmitted);
  });
});

describe("STAGE-2 INPUT + OUTPUT", () => {
  it("14-18. Stage2Input carries the exact frozen schema", async () => {
    let capturedPool = "";
    stubOllamaFetch({
      stage2: (pool) => {
        capturedPool = JSON.stringify(pool);
        return JSON.stringify([
          { kind: "fact", text: "Point.", evidenceIds: [pool[0]?.evidenceId] },
        ]);
      },
    });
    const result = await runTier2ValidatedSummarize({
      file: await testPdfFile(),
      consentStore: grantedStore(),
    });
    expect(result.status).toBe("grounded");
    const pool = JSON.parse(capturedPool) as Array<Record<string, unknown>>;
    expect(pool.length).toBeGreaterThan(0);
    for (const view of pool) {
      expect(Object.keys(view).sort()).toEqual(
        (view["value"] === undefined ? ["evidenceId", "exactText", "kind"] : ["evidenceId", "exactText", "kind", "value"]).sort(),
      );
    }
    expect(capturedPool).not.toContain("sourcePages");
    expect(capturedPool).not.toContain("chunkIndex");
  });

  it("19-21. valid fact, conclusion, and multiple claims ground", async () => {
    stubOllamaFetch({});
    const result = await runTier2ValidatedSummarize({
      file: await testPdfFile(),
      consentStore: grantedStore(),
    });
    expect(result.status).toBe("grounded");
    expect(result.claims.length).toBe(2);
    expect(result.claims.map((c) => c.kind).sort()).toEqual(["conclusion", "fact"]);
  });

  it("22-23. malformed JSON and prose wrappers map to malformed-output limited state", async () => {
    for (const bad of ["not json", "Here are claims: [{...}]", "```json\n[]\n```"]) {
      stubOllamaFetch({ stage2: () => bad });
      const result = await runTier2ValidatedSummarize({
        file: await testPdfFile(),
        consentStore: grantedStore(),
      });
      expect(result.status).toBe("limited");
      expect(result.reason).toBe("malformed-output");
      expect(result.claims).toEqual([]);
    }
  });

  it("parsed-but-rejected output stays no-valid-claims (distinct from malformed-output)", async () => {
    stubOllamaFetch({ stage2: () => JSON.stringify([{ kind: "fact", text: "  " }]) });
    const result = await runTier2ValidatedSummarize({
      file: await testPdfFile(),
      consentStore: grantedStore(),
    });
    expect(result.status).toBe("limited");
    expect(result.reason).toBe("no-valid-claims");
  });

  it("24-29. C02 rejects unknown fields, bad IDs, and forbidden excerpt/value/pages fields", async () => {
    const cases: Array<{ name: string; make: (id: string) => unknown }> = [
      { name: "unknown field", make: (id) => [{ kind: "fact", text: "T.", evidenceIds: [id], note: "x" }] },
      { name: "malformed ID", make: () => [{ kind: "fact", text: "T.", evidenceIds: ["nope"] }] },
      { name: "unknown ID", make: () => [{ kind: "fact", text: "T.", evidenceIds: ["chunk-0-e99"] }] },
      { name: "excerpt", make: (id) => [{ kind: "fact", text: "T.", evidenceIds: [id], excerpt: "x" }] },
      { name: "pages", make: (id) => [{ kind: "fact", text: "T.", evidenceIds: [id], pages: [1] }] },
      { name: "value", make: (id) => [{ kind: "fact", text: "T.", evidenceIds: [id], value: "1" }] },
    ];
    for (const { make } of cases) {
      stubOllamaFetch({ stage2: (pool) => JSON.stringify(make(pool[0]?.evidenceId as string)) });
      const result = await runTier2ValidatedSummarize({
        file: await testPdfFile(),
        consentStore: grantedStore(),
      });
      expect(result.status).toBe("limited");
      expect(result.reason).toBe("no-valid-claims");
    }
  });
});

describe("COVERAGE-BALANCED SELECTION (V7-A02)", () => {
  function chunkIndexOf(evidenceId: string): number {
    return Number(evidenceId.split("-")[1]);
  }

  function overBudgetStub(captured: { pool: Array<{ evidenceId: string }> }) {
    return stubOllamaFetch({
      stage1: (_callIndex, chunkText) => JSON.stringify(sliceSpans(chunkText, 40)),
      stage2: (pool) => {
        captured.pool = pool;
        return JSON.stringify([
          { kind: "fact", text: "Point.", evidenceIds: [pool[0]?.evidenceId] },
        ]);
      },
    });
  }

  it("45. over-budget pool spreads across chunks instead of first-N", async () => {
    const captured: { pool: Array<{ evidenceId: string }> } = { pool: [] };
    overBudgetStub(captured);
    const result = await runTier2ValidatedSummarize({
      file: await testPdfFile(3),
      consentStore: grantedStore(),
    });
    expect(result.status).toBe("grounded");
    expect(result.evidenceAdmitted).toBeGreaterThan(MAX_STAGE2_EVIDENCE_ITEMS);
    expect(result.evidenceTruncated).toBe(true);
    // Budget respected: whole items only, at most 24, budget fully used.
    expect(captured.pool).toHaveLength(MAX_STAGE2_EVIDENCE_ITEMS);
    // Spread: first-N would carry chunk 0 only; balanced must reach
    // every chunk, including the trailing one.
    const chunks = new Set(captured.pool.map((p) => chunkIndexOf(p.evidenceId)));
    expect(chunks.size).toBeGreaterThan(1);
    expect(chunks.has(2)).toBe(true);
  });

  it("46. balanced selection is deterministic across runs", async () => {
    const first: { pool: Array<{ evidenceId: string }> } = { pool: [] };
    overBudgetStub(first);
    const firstResult = await runTier2ValidatedSummarize({
      file: await testPdfFile(3),
      consentStore: grantedStore(),
    });
    const second: { pool: Array<{ evidenceId: string }> } = { pool: [] };
    overBudgetStub(second);
    const secondResult = await runTier2ValidatedSummarize({
      file: await testPdfFile(3),
      consentStore: grantedStore(),
    });
    expect(second.pool.map((p) => p.evidenceId)).toEqual(
      first.pool.map((p) => p.evidenceId),
    );
    expect(JSON.stringify(secondResult.claims)).toBe(JSON.stringify(firstResult.claims));
    expect(secondResult.evidenceAdmitted).toBe(firstResult.evidenceAdmitted);
  });

  it("47. under-budget pool passes through with truncated=false", async () => {
    const captured: { pool: Array<{ evidenceId: string }> } = { pool: [] };
    stubOllamaFetch({
      stage2: (pool) => {
        captured.pool = pool;
        return JSON.stringify([
          { kind: "fact", text: "Point.", evidenceIds: [pool[0]?.evidenceId] },
        ]);
      },
    });
    const result = await runTier2ValidatedSummarize({
      file: await testPdfFile(),
      consentStore: grantedStore(),
    });
    expect(result.status).toBe("grounded");
    expect(result.evidenceTruncated).toBe(false);
    expect(captured.pool).toHaveLength(result.evidenceAdmitted);
  });
  it("49. store stays immutable and C02/C03 behave as before", async () => {
    const captured: { pool: Array<{ evidenceId: string }> } = { pool: [] };
    overBudgetStub(captured);
    const result = await runTier2ValidatedSummarize({
      file: await testPdfFile(3),
      consentStore: grantedStore(),
    });
    expect(result.status).toBe("grounded");
    // Every grounded ID resolves inside the admitted store scope.
    const admittedIds = new Set(captured.pool.map((p) => p.evidenceId));
    for (const claim of result.claims) {
      expect(claim.evidence.length).toBeGreaterThan(0);
      for (const id of claim.evidenceIds) {
        expect(admittedIds.has(id)).toBe(true);
      }
      for (const g of claim.evidence) {
        expect(g.chunk.text.includes(g.item.exactText)).toBe(true);
      }
    }
  });
});

describe("GROUNDING", () => {
  it("30-35. displayed evidence is store-projected, ordered, and never model text", async () => {
    stubOllamaFetch({
      stage2: (pool) =>
        JSON.stringify([
          {
            kind: "fact",
            text: "Model restatement here.",
            evidenceIds: [pool[0]?.evidenceId, pool[0]?.evidenceId],
          },
        ]),
    });
    const result = await runTier2ValidatedSummarize({
      file: await testPdfFile(),
      consentStore: grantedStore(),
    });
    expect(result.status).toBe("grounded");
    const [claim] = result.claims;
    expect(claim?.text).toBe("Model restatement here.");
    expect(claim?.evidence).toHaveLength(2);
    expect(claim?.evidence[0]?.item).toBe(claim?.evidence[1]?.item);
    expect(claim?.evidence[0]?.item.exactText).not.toBe("Model restatement here.");
    expect(typeof claim?.evidence[0]?.chunk.text).toBe("string");
  });
});

describe("ZERO RESULT", () => {
  it("36. all claims rejected → explicit limited state, no raw fallback", async () => {
    stubOllamaFetch({ stage2: () => JSON.stringify([{ kind: "comparison", text: "T.", evidenceIds: ["chunk-0-e0"] }]) });
    const result = await runTier2ValidatedSummarize({
      file: await testPdfFile(),
      consentStore: grantedStore(),
    });
    expect(result.status).toBe("limited");
    expect(result.reason).toBe("no-valid-claims");
    expect(result.claims).toEqual([]);
    expect("text" in result).toBe(false);
  });

  it("37. zero evidence → no grounded summary and no Stage-2 call", async () => {
    const stub = stubOllamaFetch({ stage1: () => JSON.stringify(["zzz absent zzz"]) });
    const result = await runTier2ValidatedSummarize({
      file: await testPdfFile(),
      consentStore: grantedStore(),
    });
    expect(result.status).toBe("limited");
    expect(result.reason).toBe("no-evidence");
    expect(stub.counts().stage2Calls).toBe(0);
  });

  it("38. no raw fallback field exists on limited results", async () => {
    stubOllamaFetch({ stage1: () => JSON.stringify(["zzz absent zzz"]) });
    const result = await runTier2ValidatedSummarize({
      file: await testPdfFile(),
      consentStore: grantedStore(),
    });
    expect("text" in result).toBe(false);
    expect("summary" in result).toBe(false);
  });
});

describe("OLLAMA POLICY (E01 path)", () => {
  it("39-40. unavailable and model-missing block before Stage 1", async () => {
    for (const [tags, code] of [["down", "service-unavailable"], ["no-model", "model-unavailable"]] as const) {
      const stub = stubOllamaFetch({ tags });
      const error = await serviceErrorOf(
        runTier2ValidatedSummarize({ file: await testPdfFile(), consentStore: grantedStore() }),
      );
      expect(error.code).toBe(code);
      expect(stub.counts().stage1Calls).toBe(0);
    }
  });

  it("41-42. missing and wrong-provider consent block before Stage 1", async () => {
    for (const store of [createAiConsentStore(), (() => {
      const s = createAiConsentStore();
      grantAiConsent(s, "other");
      return s;
    })()]) {
      const stub = stubOllamaFetch({});
      const error = await serviceErrorOf(
        runTier2ValidatedSummarize({ file: await testPdfFile(), consentStore: store }),
      );
      expect(error.code).toBe("consent-required");
      expect(stub.counts().stage1Calls).toBe(0);
    }
  });

  it("43. matching consent permits the full pipeline", async () => {
    stubOllamaFetch({});
    const result = await runTier2ValidatedSummarize({
      file: await testPdfFile(),
      consentStore: grantedStore(),
    });
    expect(result.status).toBe("grounded");
  });

  it("44. generation occurs only after availability + consent", async () => {
    const stub = stubOllamaFetch({});
    await runTier2ValidatedSummarize({ file: await testPdfFile(), consentStore: grantedStore() });
    expect(stub.counts().stage1Calls).toBeGreaterThan(0);
    expect(stub.counts().stage2Calls).toBe(1);
  });
});

describe("SECURITY + ERRORS", () => {
  it("52-56. only prompt payloads reach the runtime; errors stay content-free", async () => {
    const stub = stubOllamaFetch({});
    const file = await testPdfFile();
    await runTier2ValidatedSummarize({ file, consentStore: grantedStore() });
    for (const url of stub.urls) {
      expect(url.startsWith("http://127.0.0.1:11434")).toBe(true);
    }
    const error = await serviceErrorOf(runTier2ValidatedSummarize({ file: "x" }));
    expect(JSON.stringify(error)).not.toContain("JVBER");
  });

  it("empty PDFs fail closed with empty-context", async () => {
    stubOllamaFetch({});
    const { buildScannedImageOnlyPdfBytes } = await import("../pdf/__fixtures__/pdf");
    const file = toFile(await buildScannedImageOnlyPdfBytes(1));
    const error = await serviceErrorOf(
      runTier2ValidatedSummarize({ file, consentStore: grantedStore() }),
    );
    expect(error.code).toBe("empty-context");
  });
});
