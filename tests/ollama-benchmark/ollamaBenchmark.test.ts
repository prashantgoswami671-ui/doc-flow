/**
 * T2-02 — Real-document Ollama benchmark (BENCHMARK ONLY, env-gated).
 *
 * Evidence-gathering benchmark, NOT production code. Skipped entirely
 * unless RUN_OLLAMA_BENCHMARK=1, so the normal `npm test` suite remains
 * offline-safe and fast. See docs/OLLAMA_T2-02_BENCHMARK.md for the run
 * protocol, cold/warm procedure, and the manual quality-review checklist.
 *
 * Exercises the real production path exactly as the shipped Summarize
 * integration does:
 *
 *   PDF File
 *     -> buildAiTextContext()            (AI-02 extraction + chunking)
 *     -> buildAiInstructionPrompt()      (production instruction builder)
 *     -> OllamaRuntime.generateText()    (Tier-2 runtime, T2-01)
 *     -> local Ollama http://127.0.0.1:11434, model qwen3:4b
 *
 * Ollama's own metrics (token counts, load/eval durations) are captured
 * from the SAME single generation via a recording client wrapper that
 * delegates to the real client's generateDetailed() — the wire request
 * is identical to client.generate(). No extraction, chunking, or prompt
 * logic is duplicated.
 *
 * Cold/warm is classified ONLY from Ollama's load_duration evidence —
 * never from what the run intended to be.
 *
 * Results are written to benchmark-docs/results/ (git-ignored):
 *   - one JSON file per run
 *   - t2-02-runs.jsonl (append-only, cumulative)
 */

import { describe, expect, it } from "vitest";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";

import { buildAiTextContext } from "../../services/ai/pipeline";
import { buildAiInstructionPrompt } from "../../services/ai/instructions";
import { OllamaRuntime } from "../../services/ai/ollama/runtime";
import {
  createOllamaClient,
  type OllamaClient,
  type OllamaGenerateDetailedResult,
} from "../../services/ai/ollama/client";
import { OLLAMA_MODEL } from "../../services/ai/ollama/types";
import {
  buildTextVectorPdfBytes,
  toFile,
} from "../../services/pdf/__fixtures__/pdf";

const BENCHMARK_ENABLED = process.env.RUN_OLLAMA_BENCHMARK === "1";
const describeBenchmark = BENCHMARK_ENABLED ? describe : describe.skip;

const BENCHMARK_DOC_DIR = join(process.cwd(), "benchmark-docs");
const RESULTS_DIR = join(BENCHMARK_DOC_DIR, "results");
const REAL_PDF_PATH = join(
  BENCHMARK_DOC_DIR,
  "Economic_Growth_vs_Development_WB_Jharkhand.pdf",
);

/**
 * Generation settings held fixed across every scenario so runs are
 * comparable: low temperature for near-deterministic output, and a
 * 1,024-token output cap (within the runtime's 8,192-token num_predict
 * ceiling) so summary length does not dominate timings.
 */
const BENCHMARK_TEMPERATURE = 0.2;
const BENCHMARK_MAX_OUTPUT_TOKENS = 1024;

/**
 * Ollama reports load_duration ≈ 0 (or a few ms) when the model is
 * already resident, and the real load time (seconds) on a cold run.
 * Above this threshold a run is classified COLD — evidence-based, not
 * intention-based. The raw loadDurationMs is always recorded so a
 * reviewer can reclassify.
 */
const COLD_LOAD_THRESHOLD_MS = 1000;

/** Per-test timeout: cold model loads plus multi-minute generations. */
const SCENARIO_TIMEOUT_MS = 15 * 60_000;
const MULTI_RUN_TIMEOUT_MS = 45 * 60_000;

function classifyColdWarm(loadDurationMs: number | null): "cold" | "warm" | "unknown" {
  if (loadDurationMs === null) {
    return "unknown";
  }
  return loadDurationMs > COLD_LOAD_THRESHOLD_MS ? "cold" : "warm";
}

interface BenchmarkRunRecord {
  timestamp: string;
  scenario: string;
  label: string;
  document: string;
  model: string;
  sourcePageCount: number;
  pagesWithoutExtractableText: number[];
  extractionMs: number;
  chunkCount: number;
  totalExtractedCharacters: number;
  /** AI-02's own truncation signal (chunk-count / 200k-character budgets). */
  ai02Truncated: boolean;
  /** OllamaRuntime's contextTruncated (32,768-character runtime bound). */
  contextTruncated: boolean;
  requestedMaxOutputTokens: number;
  inputTokens: number | null;
  outputTokens: number | null;
  loadDurationMs: number | null;
  promptEvalDurationMs: number | null;
  evalDurationMs: number | null;
  totalOllamaDurationMs: number | null;
  /** Wall-clock around runtime.generateText(), measured by this harness. */
  generationMs: number | null;
  derivedEvalTokensPerSecond: number | null;
  totalBenchmarkRuntimeMs: number;
  coldWarm: "cold" | "warm" | "unknown";
  /** Verbatim failure (error name + message), null on success. */
  failure: string | null;
  rawOutput: string | null;
  /** Filled manually during the quality review — see the results doc. */
  qualityNotes: string;
}

function persistRecord(record: BenchmarkRunRecord): void {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const slug = `${record.scenario}-${record.label}`.replace(/[^a-z0-9-]/gi, "_");
  const file = join(RESULTS_DIR, `t2-02-${slug}-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(record, null, 2));
  appendFileSync(join(RESULTS_DIR, "t2-02-runs.jsonl"), `${JSON.stringify(record)}\n`);
}

function logRecord(record: BenchmarkRunRecord): void {
  const ms = (value: number | null) =>
    value === null ? "n/a" : `${value.toFixed(0)}ms`;
  console.log(
    `[t2-02] ${record.scenario} / ${record.label}: ` +
      `state=${record.coldWarm} ` +
      `load=${ms(record.loadDurationMs)} ` +
      `in=${record.inputTokens ?? "n/a"}tok out=${record.outputTokens ?? "n/a"}tok ` +
      `gen=${ms(record.generationMs)} eval=${ms(record.evalDurationMs)} ` +
      `tok/s=${record.derivedEvalTokensPerSecond?.toFixed(1) ?? "n/a"} ` +
      `ctxTrunc=${record.contextTruncated} ` +
      `failure=${record.failure ?? "none"}`,
  );
}

/**
 * Runs one benchmark scenario through the REAL production path.
 *
 * The OllamaRuntime is constructed with a recording client that
 * delegates to the real client's generateDetailed() — the wire request
 * is byte-identical to client.generate(), and the runtime keeps full
 * responsibility for validation, availability gating, context bounding,
 * settings clamping, and result shaping. The metrics captured come from
 * the same single generation the summary text comes from.
 */
async function runBenchmarkScenario(options: {
  scenario: string;
  label: string;
  document: string;
  file: File;
}): Promise<BenchmarkRunRecord> {
  const client = createOllamaClient();
  const generation: { detailed: OllamaGenerateDetailedResult | null } = { detailed: null };
  const recordingClient: OllamaClient = {
    checkAvailability: () => client.checkAvailability(),
    showModel: () => client.showModel(),
    generate: async (prompt, contextChunks, settings) => {
      const detailed = await client.generateDetailed(prompt, contextChunks, settings);
      generation.detailed = detailed;
      return detailed.text;
    },
    generateDetailed: (prompt, contextChunks, settings) =>
      client.generateDetailed(prompt, contextChunks, settings),
  };
  const runtime = new OllamaRuntime({ clientFactory: () => recordingClient });

  const benchmarkStart = performance.now();

  const context = await buildAiTextContext(options.file);

  const prompt = buildAiInstructionPrompt({
    action: "summarize",
    hasPagesWithoutText: context.pagesWithoutText.length > 0,
    wasTruncated: context.truncated,
  });

  let failure: string | null = null;
  let rawOutput: string | null = null;
  let runtimeContextTruncated = false;
  let generationMs: number | null = null;

  const availability = await runtime.checkAvailability();
  if (!availability.available) {
    failure = `Ollama unavailable: ${availability.reason ?? "unknown reason"}`;
  } else {
    try {
      const generationStart = performance.now();
      const result = await runtime.generateText({
        prompt,
        contextChunks: context.chunks,
        settings: {
          temperature: BENCHMARK_TEMPERATURE,
          maxOutputTokens: BENCHMARK_MAX_OUTPUT_TOKENS,
        },
      });
      generationMs = performance.now() - generationStart;
      rawOutput = result.text;
      runtimeContextTruncated = result.contextTruncated;
    } catch (error) {
      failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
  }

  const detailed = generation.detailed;
  const derivedEvalTokensPerSecond =
    detailed?.evalCount != null &&
    detailed.evalDurationMs != null &&
    detailed.evalDurationMs > 0
      ? detailed.evalCount / (detailed.evalDurationMs / 1000)
      : null;

  const record: BenchmarkRunRecord = {
    timestamp: new Date().toISOString(),
    scenario: options.scenario,
    label: options.label,
    document: options.document,
    model: OLLAMA_MODEL,
    sourcePageCount: context.sourcePageCount,
    pagesWithoutExtractableText: context.pagesWithoutText,
    extractionMs: context.processingTime,
    chunkCount: context.chunks.length,
    totalExtractedCharacters: context.totalCharacters,
    ai02Truncated: context.truncated,
    contextTruncated: runtimeContextTruncated,
    requestedMaxOutputTokens: BENCHMARK_MAX_OUTPUT_TOKENS,
    inputTokens: detailed?.promptEvalCount ?? null,
    outputTokens: detailed?.evalCount ?? null,
    loadDurationMs: detailed?.loadDurationMs ?? null,
    promptEvalDurationMs: detailed?.promptEvalDurationMs ?? null,
    evalDurationMs: detailed?.evalDurationMs ?? null,
    totalOllamaDurationMs: detailed?.totalDurationMs ?? null,
    generationMs,
    derivedEvalTokensPerSecond,
    totalBenchmarkRuntimeMs: performance.now() - benchmarkStart,
    coldWarm: classifyColdWarm(detailed?.loadDurationMs ?? null),
    failure,
    rawOutput,
    qualityNotes: "",
  };

  persistRecord(record);
  logRecord(record);
  return record;
}

function expectSuccessfulRun(record: BenchmarkRunRecord): void {
  expect(
    record.failure,
    `Scenario ${record.scenario}/${record.label} failed: ${record.failure ?? "unknown"}`,
  ).toBeNull();
  expect(record.rawOutput?.length ?? 0).toBeGreaterThan(0);
}

/**
 * Dense deterministic synthetic document (~1,500 varied characters per
 * page, distinct figures on every page). Deliberately different from the
 * sparse Phase 3.1 fixture: at ~1.5k chars/page, 20 pages (~30k chars)
 * fit inside OllamaRuntime's 32,768-character context while 50 pages
 * (~75k chars) exceed it — so the 50-page run records the truncation
 * boundary as evidence, and the sparse 50-page control separates
 * page-count effects from token-count effects.
 */
const DENSE_PAGE_SECTORS = [
  "Agriculture and irrigation",
  "Rural electrification",
  "Road connectivity",
  "Primary education",
  "Public health",
  "Urban housing",
  "Forest coverage",
  "Industrial investment",
  "Mining and livelihoods",
  "Water supply",
  "Women and child welfare",
  "Financial inclusion",
  "Skill development",
  "Tourism",
  "Renewable energy",
  "Fisheries and animal husbandry",
  "Handloom and handicrafts",
  "Transport logistics",
  "Digital governance",
  "Social security pensions",
];

function densePageText(pageIndex: number): string {
  const sector = DENSE_PAGE_SECTORS[pageIndex % DENSE_PAGE_SECTORS.length];
  const nextSector = DENSE_PAGE_SECTORS[(pageIndex + 1) % DENSE_PAGE_SECTORS.length];
  const fiscalYear = 2015 + (pageIndex % 10);
  const outlay = (((pageIndex + 3) * 137.5) % 900 + 100).toFixed(1);
  const share = (12 + pageIndex * 1.3).toFixed(1);
  const households = (pageIndex + 2) * 4821;
  const growth = (4.2 + (pageIndex % 5) * 0.4).toFixed(1);
  const deficit = (2.1 + (pageIndex % 4) * 0.3).toFixed(1);
  const schools = (pageIndex + 1) * 317;
  const coverage = (40 + pageIndex * 2.2).toFixed(1);
  const districts = 6 + (pageIndex % 18);
  const jobs = (pageIndex + 4) * 2539;

  return [
    `Section ${pageIndex + 1}: ${sector}.`,
    `During fiscal year ${fiscalYear}-${String((fiscalYear + 1) % 100).padStart(2, "0")}, the ${sector.toLowerCase()} programme received a budgetary outlay of Rs ${outlay} crore, representing ${share} percent of the state's development expenditure for that year.`,
    `Coverage expanded to ${districts} districts, reaching ${households.toLocaleString("en-IN")} households, of which approximately ${coverage} percent reported satisfaction in the independent survey.`,
    `Annual growth in this sector was recorded at ${growth} percent, while the fiscal deficit for the same period stood at ${deficit} percent of gross state domestic product.`,
    `The programme supported ${schools.toLocaleString("en-IN")} institutions and created ${jobs.toLocaleString("en-IN")} person-days of employment under the convergence framework.`,
    `Comparisons with the preceding year show a measurable improvement: the ratio of completed to sanctioned projects rose from 61.8 percent to ${(61.8 + (pageIndex % 7) * 1.1).toFixed(1)} percent.`,
    `A formal definition used throughout this report: effective coverage means the share of eligible beneficiaries who received the benefit within the fiscal year, excluding pending or rejected applications.`,
    `Officials cautioned that figures for the last two quarters are provisional and subject to revision after the annual audit, an important caveat when citing the ${outlay} crore outlay.`,
    `Because the ${sector.toLowerCase()} budget depends on centrally sponsored schemes, any reduction in central allocations directly constrains district-level spending; this is a causal claim the report supports with the ${fiscalYear} absorption data.`,
    `Inter-district variation remains wide: the best-performing district exceeded the state average by a factor of ${(1.4 + (pageIndex % 6) * 0.2).toFixed(1)}, while the weakest district reached barely half the state average.`,
    `The report concludes that ${sector.toLowerCase()} outcomes improved in absolute terms but lags behind ${nextSector.toLowerCase()} on cost-effectiveness, a comparison revisited in Section ${pageIndex + 2 <= 50 ? pageIndex + 2 : 1}.`,
    `Data sources cited include the Economic Survey, the district statistical handbook, and the beneficiary database extracts dated March ${fiscalYear + 1}.`,
  ].join(" ");
}

async function buildDenseSyntheticPdfBytes(pageCount: number): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdf.embedFont(StandardFonts.HelveticaBold);

  for (let index = 0; index < pageCount; index++) {
    const page = pdf.addPage([612, 792]);
    const heading = `Jharkhand Development Review — Part ${index + 1} of ${pageCount}`;

    page.drawText(heading, { x: 50, y: 740, size: 16, font: boldFont });
    page.drawText(densePageText(index), {
      x: 50,
      y: 700,
      size: 10,
      font,
      maxWidth: 512,
      lineHeight: 13,
    });
  }

  return pdf.save();
}

if (BENCHMARK_ENABLED && !existsSync(REAL_PDF_PATH)) {
  console.warn(
    `[t2-02] Real benchmark PDF not found at ${REAL_PDF_PATH} — ` +
      `real-document scenarios will be skipped. Place the file there to run them ` +
      `(it is git-ignored and must never be committed).`,
  );
}

describeBenchmark("Ollama T2-02 real-document benchmark (gated: RUN_OLLAMA_BENCHMARK=1)", () => {
  const realPdfIt = it.skipIf(!existsSync(REAL_PDF_PATH));

  realPdfIt(
    "scenario 1: real 6-page PDF — cold run (run `ollama stop qwen3:4b` immediately before)",
    { timeout: SCENARIO_TIMEOUT_MS },
    async () => {
      const file = new File(
        [readFileSync(REAL_PDF_PATH)],
        "Economic_Growth_vs_Development_WB_Jharkhand.pdf",
        { type: "application/pdf" },
      );

      const record = await runBenchmarkScenario({
        scenario: "real-6page",
        label: "cold-1",
        document: "Economic_Growth_vs_Development_WB_Jharkhand.pdf",
        file,
      });

      expectSuccessfulRun(record);
      // The run is INTENDED to be cold, but only load_duration is evidence.
      // If this logs "warm", the model was already resident — re-run after
      // `ollama stop qwen3:4b` to obtain a valid cold data point.
      console.log(
        `[t2-02] intended-cold run classified as ${record.coldWarm.toUpperCase()} ` +
          `(load_duration=${record.loadDurationMs?.toFixed(0) ?? "unreported"}ms)`,
      );
    },
  );

  realPdfIt(
    "scenario 1b: real 6-page PDF — warm runs x3",
    { timeout: MULTI_RUN_TIMEOUT_MS },
    async () => {
      const file = new File(
        [readFileSync(REAL_PDF_PATH)],
        "Economic_Growth_vs_Development_WB_Jharkhand.pdf",
        { type: "application/pdf" },
      );

      const records: BenchmarkRunRecord[] = [];
      for (let index = 1; index <= 3; index++) {
        records.push(
          await runBenchmarkScenario({
            scenario: "real-6page",
            label: `warm-${index}`,
            document: "Economic_Growth_vs_Development_WB_Jharkhand.pdf",
            file,
          }),
        );
      }

      records.forEach(expectSuccessfulRun);
    },
  );

  it(
    "scenario 2: controlled dense 20-page PDF — warm runs x3",
    { timeout: MULTI_RUN_TIMEOUT_MS },
    async () => {
      const file = toFile(
        await buildDenseSyntheticPdfBytes(20),
        "t2-02-synthetic-dense-20p.pdf",
      );

      const records: BenchmarkRunRecord[] = [];
      for (let index = 1; index <= 3; index++) {
        records.push(
          await runBenchmarkScenario({
            scenario: "synthetic-dense-20page",
            label: `warm-${index}`,
            document: "t2-02-synthetic-dense-20p.pdf",
            file,
          }),
        );
      }

      records.forEach(expectSuccessfulRun);
      // ~30k chars must fit the runtime's 32,768-character bound.
      expect(records.every((r) => r.contextTruncated === false)).toBe(true);
    },
  );

  it(
    "scenario 3: controlled dense 50-page PDF — warm runs x3 (expected to exceed the 32,768-char context)",
    { timeout: MULTI_RUN_TIMEOUT_MS },
    async () => {
      const file = toFile(
        await buildDenseSyntheticPdfBytes(50),
        "t2-02-synthetic-dense-50p.pdf",
      );

      const records: BenchmarkRunRecord[] = [];
      for (let index = 1; index <= 3; index++) {
        records.push(
          await runBenchmarkScenario({
            scenario: "synthetic-dense-50page",
            label: `warm-${index}`,
            document: "t2-02-synthetic-dense-50p.pdf",
            file,
          }),
        );
      }

      records.forEach(expectSuccessfulRun);
      // ~75k chars exceed the bound: truncation here is the data point.
      expect(records.every((r) => r.contextTruncated === true)).toBe(true);
    },
  );

  it(
    "scenario 4: sparse 50-page control (existing Phase 3.1 fixture) — warm run x1",
    { timeout: SCENARIO_TIMEOUT_MS },
    async () => {
      const file = toFile(
        await buildTextVectorPdfBytes(50),
        "t2-02-synthetic-sparse-50p.pdf",
      );

      const record = await runBenchmarkScenario({
        scenario: "synthetic-sparse-50page-control",
        label: "warm-1",
        document: "t2-02-synthetic-sparse-50p.pdf",
        file,
      });

      expectSuccessfulRun(record);
    },
  );
});
