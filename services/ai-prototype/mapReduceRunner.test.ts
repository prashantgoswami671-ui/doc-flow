/**
 * Unit tests for the benchmark Map -> Reduce extensions
 * (PROTOTYPE / BENCHMARK ONLY):
 * output-cap propagation, continue-on-error partial results,
 * MapReduceRunError partial payloads, coverage, cancellation.
 *
 * Uses a stub client — no Worker, no model.
 */
import { describe, expect, it, vi } from "vitest";
import type { AiContextChunk } from "@/services/ai/types";
import type { BrowserAiWorkerClient, GenerateResult } from "./browserAiWorkerClient";
import type { AiWorkerGenerationDiagnostic } from "./workerProtocol";
import {
  MapReduceRunError,
  buildCoverage,
  extractSourceEvidence,
  runMapReduceSummarize,
  selectNumericDensityChunk,
} from "./mapReduceRunner";

function chunk(index: number, page: number): AiContextChunk {
  const text = `chunk-${index}-on-page-${page} ` + "x".repeat(40);
  return { chunkIndex: index, pageNumber: page, text, startOffset: 0, endOffset: text.length };
}

function diagnostic(overrides: Partial<AiWorkerGenerationDiagnostic> = {}): AiWorkerGenerationDiagnostic {
  return {
    generatedTokenCount: 10,
    specialTokenCount: 0,
    firstTokenIds: [1],
    lastTokenIds: [2],
    rawDecoded: "x",
    streamedOutputCharacters: 5,
    inputTokenCount: 100,
    ...overrides,
  };
}

function successResult(text: string): GenerateResult {
  return { text, inferenceMs: 50, outputCharacters: text.length, cancelled: false, diagnostic: diagnostic() };
}

type GenerateOutcome =
  | { kind: "ok"; text: string }
  | { kind: "error"; message: string }
  | { kind: "cancelled" };

/** Stub client recording every requested max_new_tokens. */
function stubClient(outcomes: GenerateOutcome[]) {
  const requestedCaps: number[] = [];
  const calls: { messages: unknown; maxNewTokens: number }[] = [];
  let n = 0;
  const generate = vi.fn((messages: unknown, maxNewTokens: number) => {
    requestedCaps.push(maxNewTokens);
    calls.push({ messages, maxNewTokens });
    const outcome = outcomes[Math.min(n, outcomes.length - 1)];
    n += 1;
    const requestId = `req-${n}`;
    if (outcome.kind === "error") {
      return { requestId, result: Promise.reject(new Error(outcome.message)) };
    }
    if (outcome.kind === "cancelled") {
      return {
        requestId,
        result: Promise.resolve({
          text: "",
          inferenceMs: 0,
          outputCharacters: 0,
          cancelled: true,
          diagnostic: null,
        } satisfies GenerateResult),
      };
    }
    return { requestId, result: Promise.resolve(successResult(outcome.text)) };
  });
  return {
    client: { generate } as unknown as BrowserAiWorkerClient,
    requestedCaps,
    calls,
    generate,
  };
}

const SIX_CHUNKS = [0, 1, 2, 3, 4, 5].map((i) => chunk(i, i + 1));

describe("cap propagation", () => {
  it("passes mapMaxNewTokens to Map calls and maxNewTokens to Reduce by default", async () => {
    const { client, requestedCaps } = stubClient([
      { kind: "ok", text: "m1" },
      { kind: "ok", text: "m2" },
      { kind: "ok", text: "reduce" },
    ]);
    const outcome = await runMapReduceSummarize({
      client,
      chunks: SIX_CHUNKS,
      batchSize: 3,
      maxNewTokens: 256,
      mapMaxNewTokens: 64,
      hasPagesWithoutText: false,
      wasTruncated: false,
    });
    // 2 Map batches + 1 Reduce.
    expect(requestedCaps).toEqual([64, 64, 256]);
    expect(outcome.success).toBe(true);
    expect(outcome.diagnostics.map((d) => d.requestedMaxNewTokens)).toEqual([64, 64, 256]);
  });

  it("passes an explicit reduceMaxNewTokens to the Reduce call only", async () => {
    const { client, requestedCaps } = stubClient([
      { kind: "ok", text: "m1" },
      { kind: "ok", text: "reduce" },
    ]);
    const outcome = await runMapReduceSummarize({
      client,
      chunks: SIX_CHUNKS.slice(0, 3),
      batchSize: 3,
      maxNewTokens: 256,
      mapMaxNewTokens: 128,
      reduceMaxNewTokens: 512,
      hasPagesWithoutText: false,
      wasTruncated: false,
    });
    expect(requestedCaps).toEqual([128, 512]);
    expect(outcome.success).toBe(true);
  });

  it("preserves legacy single-value behavior when the new options are omitted", async () => {
    const { client, requestedCaps } = stubClient([
      { kind: "ok", text: "m1" },
      { kind: "ok", text: "reduce" },
    ]);
    const outcome = await runMapReduceSummarize({
      client,
      chunks: SIX_CHUNKS.slice(0, 3),
      batchSize: 3,
      maxNewTokens: 256,
      hasPagesWithoutText: false,
      wasTruncated: false,
    });
    expect(requestedCaps).toEqual([256, 256]);
    expect(outcome.success).toBe(true);
    expect(outcome.partial).toBe(false);
    expect(outcome.completedBatchIndexes).toEqual([0]);
    expect(outcome.failedBatchIndexes).toEqual([]);
    expect(outcome.coverage).toMatchObject({
      totalChunks: 3,
      attemptedChunks: 3,
      completedChunks: 3,
      failedChunks: 0,
      batchesAttempted: 1,
      batchesCompleted: 1,
      batchesFailed: 0,
      pagesRepresented: [1, 2, 3],
    });
  });
});

describe("continueOnMapError", () => {
  it("records a failed batch and reduces over the successes (PARTIAL)", async () => {
    const { client, requestedCaps } = stubClient([
      { kind: "ok", text: "map-ok" },
      { kind: "error", message: "std::bad_alloc" },
      { kind: "ok", text: "final" },
    ]);
    const outcome = await runMapReduceSummarize({
      client,
      chunks: SIX_CHUNKS,
      batchSize: 3,
      maxNewTokens: 256,
      mapMaxNewTokens: 64,
      continueOnMapError: true,
      hasPagesWithoutText: false,
      wasTruncated: false,
    });
    expect(outcome.success).toBe(false);
    expect(outcome.partial).toBe(true);
    expect(outcome.completedBatchIndexes).toEqual([0]);
    expect(outcome.failedBatchIndexes).toEqual([1]);
    expect(outcome.intermediateSummaries).toEqual(["map-ok"]);
    expect(outcome.finalSummary).toBe("final");
    expect(outcome.coverage).toMatchObject({
      totalChunks: 6,
      attemptedChunks: 6,
      completedChunks: 3,
      failedChunks: 3,
      batchesAttempted: 2,
      batchesCompleted: 1,
      batchesFailed: 1,
      pagesRepresented: [1, 2, 3],
    });
    // Map batch 2 (failed) + Reduce still ran: 3 generations.
    expect(requestedCaps).toEqual([64, 64, 256]);
    const errorEntry = outcome.diagnostics.find((d) => d.stage === "map" && d.batchIndex === 1);
    expect(errorEntry?.error).toContain("std::bad_alloc");
  });

  it("skips Reduce and reports FAILED when every Map batch fails", async () => {
    const stub = stubClient([{ kind: "error", message: "boom" }]);
    const outcome = await runMapReduceSummarize({
      client: stub.client,
      chunks: SIX_CHUNKS.slice(0, 4),
      batchSize: 2,
      maxNewTokens: 256,
      continueOnMapError: true,
      hasPagesWithoutText: false,
      wasTruncated: false,
    });
    expect(outcome.success).toBe(false);
    expect(outcome.partial).toBe(false);
    expect(outcome.finalSummary).toBeNull();
    expect(outcome.failedBatchIndexes).toEqual([0, 1]);
    expect(outcome.coverage.failedChunks).toBe(4);
    // Exactly 2 Map attempts, no Reduce call.
    expect(stub.generate).toHaveBeenCalledTimes(2);
    expect(outcome.diagnostics).toHaveLength(2);
  });
});

describe("MapReduceRunError", () => {
  it("carries partial diagnostics/coverage/cause when continueOnMapError is false", async () => {
    const { client } = stubClient([{ kind: "error", message: "OrtRun failed" }]);
    const caught = await runMapReduceSummarize({
      client,
      chunks: SIX_CHUNKS.slice(0, 3),
      batchSize: 3,
      maxNewTokens: 256,
      hasPagesWithoutText: false,
      wasTruncated: false,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(MapReduceRunError);
    const err = caught as MapReduceRunError;
    expect(err.stage).toBe("map");
    expect(err.message).toContain("Map batch 1/1 failed");
    expect(err.diagnostics).toHaveLength(1);
    expect(err.coverage.failedChunks).toBe(3);
    expect(err.cause).toBeInstanceOf(Error);
  });

  it("carries partial Map data when Reduce fails", async () => {
    const { client } = stubClient([
      { kind: "ok", text: "map-ok" },
      { kind: "error", message: "reduce blew up" },
    ]);
    const caught = await runMapReduceSummarize({
      client,
      chunks: SIX_CHUNKS.slice(0, 3),
      batchSize: 3,
      maxNewTokens: 256,
      continueOnMapError: true,
      hasPagesWithoutText: false,
      wasTruncated: false,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(MapReduceRunError);
    const err = caught as MapReduceRunError;
    expect(err.stage).toBe("reduce");
    expect(err.intermediateSummaries).toEqual(["map-ok"]);
    expect(err.completedBatchIndexes).toEqual([0]);
    expect(err.coverage.completedChunks).toBe(3);
  });
});

describe("cancellation and coverage", () => {
  it("stops between batches and reports coverage of completed batches only", async () => {
    const { client } = stubClient([
      { kind: "ok", text: "m1" },
      { kind: "ok", text: "m2" },
    ]);
    let calls = 0;
    const outcome = await runMapReduceSummarize({
      client,
      chunks: SIX_CHUNKS,
      batchSize: 2, // 3 batches
      maxNewTokens: 64,
      hasPagesWithoutText: false,
      wasTruncated: false,
      isCancelled: () => {
        calls += 1;
        return calls > 1; // allow the first batch, then cancel
      },
    });
    expect(outcome.cancelled).toBe(true);
    expect(outcome.success).toBe(false);
    expect(outcome.completedBatchIndexes).toEqual([0]);
    expect(outcome.coverage.completedChunks).toBe(2);
    expect(outcome.coverage.attemptedChunks).toBe(2);
  });

  it("buildCoverage handles non-contiguous uploaded-style pages", () => {
    const batches = [
      [chunk(0, 1), chunk(1, 3)],
      [chunk(2, 7)],
    ];
    const coverage = buildCoverage(batches, [0], [1]);
    expect(coverage.totalChunks).toBe(3);
    expect(coverage.completedChunks).toBe(2);
    expect(coverage.failedChunks).toBe(1);
    expect(coverage.pagesRepresented).toEqual([1, 3]);
  });
});

/**
 * Reduce Limited Source Grounding experiment (PROTOTYPE ONLY):
 * unit tests for the deterministic source-evidence selector and
 * excerpt extractor used to ground the Reduce stage (see
 * mapReduceRunner.ts's `selectNumericDensityChunk` /
 * `extractSourceEvidence` and the experiment's spec §9.C/§9.D).
 */
function customChunk(chunkIndex: number, pageNumber: number, text: string): AiContextChunk {
  return { chunkIndex, pageNumber, text, startOffset: 0, endOffset: text.length };
}

describe("selectNumericDensityChunk", () => {
  it("selects the chunk with the highest digit-character count", () => {
    const chunks = [
      customChunk(0, 1, "no numbers here at all"),
      customChunk(1, 2, "GSDP grew from 2015 to 2020, up 12.4% to 4.7 lakh crore"),
      customChunk(2, 3, "a single 7 appears here"),
    ];
    const selected = selectNumericDensityChunk(chunks);
    expect(selected?.chunkIndex).toBe(1);
  });

  it("breaks ties by the lowest chunkIndex", () => {
    const chunks = [
      customChunk(2, 3, "123456"),
      customChunk(0, 1, "654321"),
      customChunk(1, 2, "111111"),
    ];
    const selected = selectNumericDensityChunk(chunks);
    expect(selected?.chunkIndex).toBe(0);
  });

  it("returns null for an empty chunk list", () => {
    expect(selectNumericDensityChunk([])).toBeNull();
  });

  it("selection depends only on the chunk list itself, independent of how chunks would be batched", () => {
    // selectNumericDensityChunk has no batchSize parameter and is called
    // by mapReduceRunner against the full original chunk list, not a
    // per-batch slice — reordering/regrouping the same chunks (as
    // different batch sizes effectively would) must not change the
    // result.
    const chunks = [
      customChunk(0, 1, "no digits at all in this text"),
      customChunk(1, 2, "literacy rate 66.4% infant mortality rate 41 per 1000"),
      customChunk(2, 3, "per capita income grew steadily"),
      customChunk(3, 4, "another plain sentence with no numbers"),
    ];
    const selectedInOrder = selectNumericDensityChunk(chunks);
    const selectedReversed = selectNumericDensityChunk([...chunks].reverse());
    expect(selectedInOrder?.chunkIndex).toBe(1);
    expect(selectedReversed?.chunkIndex).toBe(1);
  });
});

describe("extractSourceEvidence", () => {
  it("returns the whole chunk verbatim when it is already at or under the max length", () => {
    const shortChunk = customChunk(0, 4, "GSDP grew 6% in 2020.");
    const evidence = extractSourceEvidence(shortChunk);
    expect(evidence.text).toBe(shortChunk.text);
    expect(evidence.pageNumber).toBe(4);
  });

  it("bounds a long chunk's excerpt to the intended size (<= 250 characters)", () => {
    const longText =
      "Introductory prose with no numbers padded out to push the dense region further away. " +
      "x".repeat(100) +
      " Per-capita income rose from 45231 to 68970 between 2011 and 2021, a rise of 52.4 percent, " +
      "while literacy climbed from 61.2% to 74.8% and infant mortality fell from 61 to 32 per 1000 live births. " +
      "y".repeat(200);
    const longChunk = customChunk(3, 5, longText);
    const evidence = extractSourceEvidence(longChunk);
    expect(evidence.text.length).toBeLessThanOrEqual(250);
    expect(evidence.pageNumber).toBe(5);
  });

  it("produces an excerpt that is an exact substring of the original chunk text (no paraphrasing)", () => {
    const longText =
      "z".repeat(300) +
      " GDP was 12345 crore in 2019, rising to 67890 crore in 2023, an increase of 45.6 percent. " +
      "w".repeat(300);
    const longChunk = customChunk(0, 2, longText);
    const evidence = extractSourceEvidence(longChunk);
    expect(longText.includes(evidence.text)).toBe(true);
  });

  it("preserves the source chunk's page number", () => {
    const longText = "no digits at all, ".repeat(30);
    const longChunk = customChunk(1, 9, longText);
    const evidence = extractSourceEvidence(longChunk);
    expect(evidence.pageNumber).toBe(9);
  });

  it("windows around the region with the highest digit concentration", () => {
    const digitBlock = "1234567890123456789012345678901234567890"; // 40 digits
    const longText = "a".repeat(150) + digitBlock + "b".repeat(150);
    const longChunk = customChunk(0, 1, longText);
    const evidence = extractSourceEvidence(longChunk);
    expect(evidence.text).toContain(digitBlock);
  });
});
