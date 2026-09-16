/**
 * T2-03 Evidence-Fidelity PoC — isolated experiment (PoC-ONLY).
 *
 * Tests whether qwen3:4b can reliably COPY exact source spans when the task
 * is separated from Fact Card classification/reasoning (hypothesis B) vs
 * being unreliable at exact copying at all (hypothesis A).
 *
 * The model performs extraction ONLY — no claim classification, no causal
 * judgments, no comparisons, no conclusions, no definitions, no summary.
 *
 * Frozen baseline: same PDF, same AI-02 chunks, qwen3:4b, think:false,
 * temperature 0, num_predict 2048, single attempt, NO repair.
 *
 * Does NOT modify factCardSchema / factCardValidator / factCardClient /
 * factCardPoc / production Ollama code. Uses its own minimal prompt and its
 * own exact-substring (no normalization) deterministic checks.
 */

import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildAiTextContext } from "../../services/ai/pipeline";
import {
  OLLAMA_API_GENERATE,
  OLLAMA_BASE_URL,
  OLLAMA_MODEL,
} from "../../services/ai/ollama/types";

const POC_ENABLED = process.env.RUN_OLLAMA_T203 === "1";
const describeLive = POC_ENABLED ? describe : describe.skip;

const BENCHMARK_DOC_DIR = join(process.cwd(), "benchmark-docs");
const RESULTS_DIR = join(BENCHMARK_DOC_DIR, "results");
const REAL_PDF_PATH = join(BENCHMARK_DOC_DIR, "Economic_Growth_vs_Development_WB_Jharkhand.pdf");

const SCENARIO_TIMEOUT_MS = 30 * 60_000;

/** Frozen expected numeric facts (same list as the Fact Card PoC). */
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

/**
 * Minimal evidence-first task formulation. Deliberately short: the prior
 * full-prompt experiment showed long prompts can eat the 2048 output budget
 * (chunk-0 truncated at 8479 chars). Extraction only — no interpretation.
 */
export function buildEvidencePrompt(): string {
  return (
    `Copy evidence from the document context below. This is extraction, not interpretation.\n` +
    `Return ONLY one JSON object with exactly this shape:\n` +
    `{"excerpts": ["<exact source span>"], "numbers": [{"value": "<exact number as written>", "excerpt": "<exact source span containing value>"}]}\n` +
    `Rules: COPY text exactly from the document context. Do not paraphrase, rewrite, summarize, correct, or invent. ` +
    `Do not normalize punctuation or numbers. Do not change %, units, commas, or decimals. ` +
    `Every excerpts[] entry must be an exact contiguous span of the source text. ` +
    `Every numbers[].value must be copied exactly as written; every numbers[].excerpt must be an exact source span containing that exact value. ` +
    `If something cannot be located exactly, omit it. Output ONLY the JSON object.`
  );
}

const DOCUMENT_CONTEXT_START = "<<<DOCUMENT_CONTEXT_START>>>";
const DOCUMENT_CONTEXT_END = "<<<DOCUMENT_CONTEXT_END>>>";

export function renderEvidenceContext(pageNumber: number, text: string): string {
  return `${DOCUMENT_CONTEXT_START}\n[page ${pageNumber}] ${text}\n${DOCUMENT_CONTEXT_END}`;
}

/** Extracts the first balanced {...} JSON object; null when unbalanced/absent. */
export function extractFirstJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start === -1) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index++) {
    const char = raw[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(start, index + 1);
      }
    }
  }
  return null;
}

export interface EvidenceFidelityMetrics {
  excerptCount: number;
  exactExcerptCount: number;
  exactExcerptRate: number | null;
  numberCount: number;
  exactNumberValueCount: number;
  exactNumberExcerptCount: number;
  numberValueInExcerptCount: number;
  malformedEvidenceCount: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deterministic evidence-fidelity checks. EXACT substring containment only —
 * no whitespace/punctuation normalization. `parsed` is the parsed model
 * output (unknown shape); anything structurally off-schema counts as
 * malformed, never as exact.
 */
export function checkEvidenceFidelity(parsed: unknown, chunkText: string): EvidenceFidelityMetrics {
  let excerptCount = 0;
  let exactExcerptCount = 0;
  let numberCount = 0;
  let exactNumberValueCount = 0;
  let exactNumberExcerptCount = 0;
  let numberValueInExcerptCount = 0;
  let malformedEvidenceCount = 0;

  if (!isPlainObject(parsed)) {
    return {
      excerptCount,
      exactExcerptCount,
      exactExcerptRate: null,
      numberCount,
      exactNumberValueCount,
      exactNumberExcerptCount,
      numberValueInExcerptCount,
      malformedEvidenceCount: 1,
    };
  }

  if (Array.isArray(parsed.excerpts)) {
    for (const entry of parsed.excerpts) {
      if (typeof entry !== "string" || entry.length === 0) {
        malformedEvidenceCount += 1;
        continue;
      }
      excerptCount += 1;
      if (chunkText.includes(entry)) {
        exactExcerptCount += 1;
      }
    }
  } else if (parsed.excerpts !== undefined) {
    malformedEvidenceCount += 1;
  }

  if (Array.isArray(parsed.numbers)) {
    for (const entry of parsed.numbers) {
      if (!isPlainObject(entry) || typeof entry.value !== "string" || typeof entry.excerpt !== "string") {
        malformedEvidenceCount += 1;
        continue;
      }
      numberCount += 1;
      const valueExact = entry.value.length > 0 && chunkText.includes(entry.value);
      const excerptExact = entry.excerpt.length > 0 && chunkText.includes(entry.excerpt);
      if (valueExact) {
        exactNumberValueCount += 1;
      }
      if (excerptExact) {
        exactNumberExcerptCount += 1;
      }
      if (entry.value.length > 0 && entry.excerpt.includes(entry.value)) {
        numberValueInExcerptCount += 1;
      }
    }
  } else if (parsed.numbers !== undefined) {
    malformedEvidenceCount += 1;
  }

  return {
    excerptCount,
    exactExcerptCount,
    exactExcerptRate: excerptCount === 0 ? null : exactExcerptCount / excerptCount,
    numberCount,
    exactNumberValueCount,
    exactNumberExcerptCount,
    numberValueInExcerptCount,
    malformedEvidenceCount,
  };
}

describe("evidence-fidelity deterministic checks (offline)", () => {
  it("counts exact excerpts with strict substring containment", () => {
    const chunk = "WB urban literacy 84.78% and rural 72.13% overall.";
    const metrics = checkEvidenceFidelity(
      { excerpts: ["WB urban literacy 84.78%", "paraphrased rural rate"], numbers: [] },
      chunk,
    );
    expect(metrics.excerptCount).toBe(2);
    expect(metrics.exactExcerptCount).toBe(1);
    expect(metrics.exactExcerptRate).toBe(0.5);
    expect(metrics.malformedEvidenceCount).toBe(0);
  });

  it("rejects normalized numbers and non-verbatim excerpts", () => {
    const chunk = "share of 28.81% (2nd highest) and IMR 41.13 approx.";
    const metrics = checkEvidenceFidelity(
      {
        excerpts: [],
        numbers: [
          { value: "28.81%", excerpt: "share of 28.81% (2nd highest)" },
          { value: "28.81 percent", excerpt: "share of 28.81% (2nd highest)" },
          { value: "41.13", excerpt: "invented surrounding text 41.13" },
        ],
      },
      chunk,
    );
    expect(metrics.numberCount).toBe(3);
    expect(metrics.exactNumberValueCount).toBe(2);
    expect(metrics.exactNumberExcerptCount).toBe(2);
    expect(metrics.numberValueInExcerptCount).toBe(2);
  });

  it("counts malformed entries without throwing", () => {
    const metrics = checkEvidenceFidelity(
      { excerpts: [42, ""], numbers: [{ value: "x" }, "not-an-object"] },
      "x",
    );
    expect(metrics.excerptCount).toBe(0);
    expect(metrics.numberCount).toBe(0);
    expect(metrics.malformedEvidenceCount).toBe(4);
  });

  it("extractFirstJsonObject returns null for truncated output", () => {
    expect(extractFirstJsonObject('{"excerpts": ["abc"')).toBeNull();
    expect(extractFirstJsonObject('{"excerpts": []} trailing')).toBe('{"excerpts": []}');
  });
});

describeLive("Ollama T2-03 Evidence-Fidelity PoC (gated: RUN_OLLAMA_T203=1)", () => {
  const liveIt = it.skipIf(!existsSync(REAL_PDF_PATH));

  liveIt("extract verbatim evidence spans for each AI-02 chunk, no repair", { timeout: SCENARIO_TIMEOUT_MS }, async () => {
    const file = new File([readFileSync(REAL_PDF_PATH)], "Economic_Growth_vs_Development_WB_Jharkhand.pdf", {
      type: "application/pdf",
    });

    const context = await buildAiTextContext(file);
    expect(context.chunks.length).toBeGreaterThan(0);

    const chunkResults: Array<{
      chunkIndex: number;
      pageNumber: number;
      rawOutput: string | null;
      rawOutputLength: number;
      balanced: boolean;
      parseSuccess: boolean;
      parseError: string | null;
      metrics: EvidenceFidelityMetrics | null;
      expectedPresent: string[];
      expectedRecovered: string[];
      inputTokens: number | null;
      outputTokens: number | null;
      generationMs: number;
      failure: string | null;
    }> = [];

    for (const chunk of context.chunks) {
      const started = performance.now();
      try {
        const response = await fetch(`${OLLAMA_BASE_URL}${OLLAMA_API_GENERATE}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: OLLAMA_MODEL,
            prompt: `${buildEvidencePrompt()}\n\n${renderEvidenceContext(chunk.pageNumber, chunk.text)}`,
            stream: false,
            format: "json",
            think: false,
            options: { temperature: 0, num_predict: 2048 },
          }),
        });
        if (!response.ok) {
          throw new Error(`Ollama request failed: ${response.status} ${response.statusText}`);
        }
        const data = (await response.json()) as {
          response: string;
          prompt_eval_count?: number;
          eval_count?: number;
        };
        const raw: string = data.response;
        const jsonText = extractFirstJsonObject(raw);
        const balanced = jsonText !== null;
        let parsed: unknown = null;
        let parseError: string | null = null;
        if (jsonText) {
          try {
            parsed = JSON.parse(jsonText) as unknown;
          } catch (error) {
            parseError = error instanceof Error ? error.message : String(error);
          }
        } else {
          parseError = "no balanced JSON object (absent or truncated)";
        }
        const parseSuccess = parsed !== null;
        const metrics = parseSuccess ? checkEvidenceFidelity(parsed, chunk.text) : null;
        const expectedPresent = EXPECTED_NUMBERS.filter((n) => chunk.text.includes(n));
        let expectedRecovered: string[] = [];
        if (parseSuccess && isPlainObject(parsed) && Array.isArray(parsed.numbers)) {
          const returnedValues = (parsed.numbers as unknown[])
            .filter((e): e is Record<string, unknown> => isPlainObject(e))
            .map((e) => e.value)
            .filter((v): v is string => typeof v === "string");
          expectedRecovered = expectedPresent.filter((n) => returnedValues.includes(n));
        }
        chunkResults.push({
          chunkIndex: chunk.chunkIndex,
          pageNumber: chunk.pageNumber,
          rawOutput: raw,
          rawOutputLength: raw.length,
          balanced,
          parseSuccess,
          parseError,
          metrics,
          expectedPresent,
          expectedRecovered,
          inputTokens: typeof data.prompt_eval_count === "number" ? data.prompt_eval_count : null,
          outputTokens: typeof data.eval_count === "number" ? data.eval_count : null,
          generationMs: performance.now() - started,
          failure: null,
        });
      } catch (error) {
        chunkResults.push({
          chunkIndex: chunk.chunkIndex,
          pageNumber: chunk.pageNumber,
          rawOutput: null,
          rawOutputLength: 0,
          balanced: false,
          parseSuccess: false,
          parseError: null,
          metrics: null,
          expectedPresent: [],
          expectedRecovered: [],
          inputTokens: null,
          outputTokens: null,
          generationMs: performance.now() - started,
          failure: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        });
      }
    }

    const totals = {
      totalChunks: chunkResults.length,
      parseableChunks: chunkResults.filter((r) => r.parseSuccess).length,
      totalExcerpts: chunkResults.reduce((n, r) => n + (r.metrics?.excerptCount ?? 0), 0),
      exactExcerpts: chunkResults.reduce((n, r) => n + (r.metrics?.exactExcerptCount ?? 0), 0),
      totalNumbers: chunkResults.reduce((n, r) => n + (r.metrics?.numberCount ?? 0), 0),
      exactNumberValues: chunkResults.reduce((n, r) => n + (r.metrics?.exactNumberValueCount ?? 0), 0),
      exactNumberExcerpts: chunkResults.reduce((n, r) => n + (r.metrics?.exactNumberExcerptCount ?? 0), 0),
      numberValueInExcerpt: chunkResults.reduce((n, r) => n + (r.metrics?.numberValueInExcerptCount ?? 0), 0),
      malformedEvidence: chunkResults.reduce((n, r) => n + (r.metrics?.malformedEvidenceCount ?? 0), 0),
    };
    const excerptExactRate =
      totals.totalExcerpts === 0 ? null : totals.exactExcerpts / totals.totalExcerpts;

    const record = {
      timestamp: new Date().toISOString(),
      scenario: "t2-03-evidence-fidelity-poc",
      model: OLLAMA_MODEL,
      document: "Economic_Growth_vs_Development_WB_Jharkhand.pdf",
      sourcePageCount: context.sourcePageCount,
      prompt: buildEvidencePrompt(),
      budgets: { firstAttemptNumPredict: 2048, temperature: 0, think: false },
      totals,
      excerptExactRate,
      chunks: chunkResults,
    };
    mkdirSync(RESULTS_DIR, { recursive: true });
    writeFileSync(join(RESULTS_DIR, `t2-03-evidence-fidelity-${Date.now()}.json`), JSON.stringify(record, null, 2));

    console.log(
      `[t2-03-evidence] chunks=${totals.totalChunks} parseable=${totals.parseableChunks} ` +
        `excerpts=${totals.exactExcerpts}/${totals.totalExcerpts} ` +
        `numValues=${totals.exactNumberValues}/${totals.totalNumbers} ` +
        `numExcerpts=${totals.exactNumberExcerpts}/${totals.totalNumbers} malformed=${totals.malformedEvidence}`,
    );

    expect(record.chunks.length).toBe(context.chunks.length);
    expect(existsSync(RESULTS_DIR)).toBe(true);
  });
});
