/**
 * T2-03 Fact Card PoC — live test (ENV-GATED, BENCHMARK ONLY).
 *
 * Skipped entirely unless RUN_OLLAMA_T203=1, so `npm test` stays offline
 * and fast. Uses ONLY benchmark-docs/Economic_Growth_vs_Development_WB_Jharkhand.pdf
 * (git-ignored, never committed). No 20/50-page processing. No production
 * integration, routing, UI, or MapReduce.
 *
 * Pipeline:
 *   buildAiTextContext() (AI-02, unchanged)
 *     -> 1 Fact Card per chunk via PoC-local format:"json" client
 *     -> deterministic validateFactCard()
 *     -> accepted cards + excerpts -> final Qwen3 4B summary (production
 *        OllamaRuntime.generateText, unmodified; prompt contains cards only,
 *        never raw chunks)
 *
 * The live test NEVER fails on model quality misses — it records evidence
 * (JSON + console) for the engineering decision. It fails only on harness
 * errors (extraction crash, transport crash, results-write crash).
 */

import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildAiTextContext } from "../../services/ai/pipeline";
import { OllamaRuntime } from "../../services/ai/ollama/runtime";
import { OLLAMA_MODEL } from "../../services/ai/ollama/types";
import { extractFactCard } from "./factCardClient";
import { validateFactCard } from "./factCardValidator";
import {
  buildFinalSummaryPrompt,
  FINAL_SUMMARY_MAX_OUTPUT_TOKENS,
  FINAL_SUMMARY_TEMPERATURE,
} from "./factCardPrompts";
import type { FactCard } from "./factCardSchema";

const POC_ENABLED = process.env.RUN_OLLAMA_T203 === "1";
const describePoc = POC_ENABLED ? describe : describe.skip;

const BENCHMARK_DOC_DIR = join(process.cwd(), "benchmark-docs");
const RESULTS_DIR = join(BENCHMARK_DOC_DIR, "results");
const REAL_PDF_PATH = join(BENCHMARK_DOC_DIR, "Economic_Growth_vs_Development_WB_Jharkhand.pdf");

const SCENARIO_TIMEOUT_MS = 30 * 60_000;

/**
 * PRE-REGISTERED evaluation baseline — frozen before any model run.
 * Do NOT change after seeing model results. Source: the known real-PDF
 * content (literacy / IMR / MPI figures, growth-vs-development framing).
 */
export const EXPECTED_DEFINITIONS = ["economic growth", "economic development"];

export const EXPECTED_NUMBERS = [
  "84.78%",
  "72.13%",
  "82.26%",
  "61.11%",
  "41.13",
  "22.24",
  "11.89%",
  "28.81%",
];

export const EXPECTED_COMPARISONS = [
  "WB urban literacy > WB rural literacy",
  "Jharkhand urban literacy > Jharkhand rural literacy",
  "Jharkhand literacy gap > WB literacy gap",
  "Jharkhand rural IMR > Jharkhand urban IMR",
];

export const EXPECTED_CONCLUSION_KEYWORDS = ["necessary", "not sufficient"];

function cardCorpus(cards: FactCard[]): string {
  return cards
    .map((card) =>
      [
        ...card.definitions.map((d) => `${d.term} ${d.definition}`),
        ...card.numbers.map((n) => `${n.value} ${n.unit ?? ""}`),
        ...card.claims.map((c) => c.text),
        ...card.excerpts,
      ].join("\n"),
    )
    .join("\n")
    .toLowerCase();
}

export function measureExpectedCoverage(cards: FactCard[]): {
  numbersFound: string[];
  definitionsFound: string[];
  conclusionPresent: boolean;
} {
  const corpus = cardCorpus(cards);
  return {
    numbersFound: EXPECTED_NUMBERS.filter((n) => corpus.includes(n.toLowerCase())),
    definitionsFound: EXPECTED_DEFINITIONS.filter((d) => corpus.includes(d.toLowerCase())),
    conclusionPresent: EXPECTED_CONCLUSION_KEYWORDS.every((keyword) =>
      corpus.includes(keyword.toLowerCase()),
    ),
  };
}

describePoc("Ollama T2-03 Fact Card PoC (gated: RUN_OLLAMA_T203=1)", () => {
  const liveIt = it.skipIf(!existsSync(REAL_PDF_PATH));

  liveIt(
    "extract 1 card per AI-02 chunk, validate, summarize accepted cards",
    { timeout: SCENARIO_TIMEOUT_MS },
    async () => {
      const file = new File(
        [readFileSync(REAL_PDF_PATH)],
        "Economic_Growth_vs_Development_WB_Jharkhand.pdf",
        { type: "application/pdf" },
      );

      // 1. AI-02 context (unchanged production path).
      const context = await buildAiTextContext(file);
      expect(context.chunks.length).toBeGreaterThan(0);
      const sourcePageCount = context.sourcePageCount;

      // 2. One card per chunk (PoC-local format:"json" client, ≤1 repair).
      const accepted: FactCard[] = [];
      // Forensic instrumentation (T2-03 only): for each rejected chunk persist
      // what Qwen3 4B actually returned. rawOutput = first-attempt raw
      // response; repairRawOutput = single repair-attempt raw response (null
      // when N/A); inputTokens/outputTokens = whatever extractFactCard
      // reported (null when unavailable on rejected chunks); generationMs =
      // total generation duration. Full raws stay in JSON only, never console.
      const rejected: {
        chunkIndex: number;
        reasons: string[];
        rawOutput: string | null;
        repairRawOutput: string | null;
        inputTokens: number | null;
        outputTokens: number | null;
        generationMs: number;
      }[] = [];
      let firstTryValid = 0;
      let repaired = 0;
      let failures = 0;
      const failureDetails: string[] = [];
      let totalInputTokens = 0;
      let totalOutputTokens = 0;

      for (const chunk of context.chunks) {
        try {
          const result = await extractFactCard(
            { chunkIndex: chunk.chunkIndex, pageNumber: chunk.pageNumber, text: chunk.text },
            sourcePageCount,
          );
          totalInputTokens += result.inputTokens ?? 0;
          totalOutputTokens += result.outputTokens ?? 0;
          if (result.firstTryValid) {
            firstTryValid += 1;
          }
          if (result.repaired) {
            repaired += 1;
          }
          if (result.ok && result.card) {
            // Belt-and-braces: re-validate through the production-shape path.
            const check = validateFactCard(result.card, chunk, sourcePageCount);
            if (check.ok) {
              accepted.push(result.card);
            } else {
              rejected.push({
                chunkIndex: chunk.chunkIndex,
                reasons: check.reasons,
                rawOutput: result.rawOutput,
                repairRawOutput: result.repairRawOutput,
                inputTokens: result.inputTokens,
                outputTokens: result.outputTokens,
                generationMs: result.generationMs,
              });
            }
          } else {
            rejected.push({
              chunkIndex: chunk.chunkIndex,
              reasons: result.reasons,
              rawOutput: result.rawOutput,
              repairRawOutput: result.repairRawOutput,
              inputTokens: result.inputTokens,
              outputTokens: result.outputTokens,
              generationMs: result.generationMs,
            });
          }
        } catch (error) {
          failures += 1;
          failureDetails.push(
            `chunk-${chunk.chunkIndex}: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
          );
        }
      }

      // 3. Provenance coverage over accepted cards (machine-checkable).
      const groundedFacts = accepted.reduce(
        (count, card) => count + card.numbers.length + card.claims.length,
        0,
      );
      const coverage = measureExpectedCoverage(accepted);
      const exactNumericAccuracy =
        coverage.numbersFound.length === 0
          ? null
          : coverage.numbersFound.length / EXPECTED_NUMBERS.length;

      // 4. Final summary from ACCEPTED cards + excerpts only (never raw chunks).
      let finalSummary: string | null = null;
      let finalFailure: string | null = null;
      const finalStarted = performance.now();
      if (accepted.length > 0) {
        try {
          const runtime = new OllamaRuntime();
          const result = await runtime.generateText({
            prompt: buildFinalSummaryPrompt(accepted),
            settings: {
              temperature: FINAL_SUMMARY_TEMPERATURE,
              maxOutputTokens: FINAL_SUMMARY_MAX_OUTPUT_TOKENS,
            },
          });
          finalSummary = result.text;
        } catch (error) {
          finalFailure =
            error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        }
      }
      const finalSummaryMs = performance.now() - finalStarted;

      // 5. Persist evidence (git-ignored results dir, same convention as T2-02).
      const record = {
        timestamp: new Date().toISOString(),
        scenario: "t2-03-fact-card-poc",
        model: OLLAMA_MODEL,
        document: "Economic_Growth_vs_Development_WB_Jharkhand.pdf",
        sourcePageCount,
        chunksAttempted: context.chunks.length,
        cardsAccepted: accepted.length,
        cardsRejected: rejected.length,
        jsonValidFirstTry: firstTryValid,
        jsonValidAfterRepair: repaired,
        rejected,
        failures,
        failureDetails,
        finalFailure,
        provenance: {
          acceptedCards: accepted.map((card) => ({
            cardId: card.cardId,
            chunkIndex: card.chunkIndex,
            sourcePages: card.sourcePages,
          })),
          groundedNumberAndClaimCount: groundedFacts,
        },
        quality: {
          expectedNumericFactsFound: `${coverage.numbersFound.length}/${EXPECTED_NUMBERS.length}`,
          numbersFound: coverage.numbersFound,
          exactNumericAccuracy,
          definitionsFound: `${coverage.definitionsFound.length}/${EXPECTED_DEFINITIONS.length}`,
          conclusionPresent: coverage.conclusionPresent,
          comparisonsListedForReview: EXPECTED_COMPARISONS,
        },
        telemetry: {
          totalCardInputTokens: totalInputTokens,
          totalCardOutputTokens: totalOutputTokens,
          finalSummaryMs: Math.round(finalSummaryMs),
        },
        acceptedCards: accepted,
        finalSummary,
      };
      mkdirSync(RESULTS_DIR, { recursive: true });
      writeFileSync(join(RESULTS_DIR, `t2-03-poc-${Date.now()}.json`), JSON.stringify(record, null, 2));

      console.log(
        `[t2-03] chunks=${record.chunksAttempted} accepted=${record.cardsAccepted} ` +
          `rejected=${record.cardsRejected} firstTry=${firstTryValid} repaired=${repaired} ` +
          `failures=${failures} numbers=${record.quality.expectedNumericFactsFound} ` +
          `conclusion=${coverage.conclusionPresent} finalFailure=${finalFailure ?? "none"}`,
      );

      // Harness assertions only — quality misses are recorded, not failed.
      expect(record.chunksAttempted).toBe(context.chunks.length);
      expect(record.cardsAccepted + record.cardsRejected + failures).toBe(
        record.chunksAttempted,
      );
      expect(existsSync(RESULTS_DIR)).toBe(true);
    },
  );
});
