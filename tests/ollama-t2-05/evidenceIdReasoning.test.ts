/**
 * T2-05 Stage-2 Evidence-ID Reasoning Experiment (controlled, PoC-ONLY).
 *
 * Stage 1: evidence-only extraction per chunk (same behavior as the T2-03
 *   evidence-fidelity experiment) → deterministic exact-substring validation →
 *   local Evidence Store with deterministic IDs (`chunk-<i>-e<n>`).
 * Stage 2: qwen3:4b receives ONLY validated evidence items + reasoning task
 *   (NO raw chunk text) and must return a Fact Card referencing evidenceIds.
 *   Single attempt per stage, NO repair anywhere.
 *
 * Does NOT modify: services/ai/ollama/*, tests/ollama-t2-03/*,
 * tests/ollama-t2-04/*, production code, package files, docs.
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

const POC_ENABLED = process.env.RUN_OLLAMA_T205 === "1";
const describeLive = POC_ENABLED ? describe : describe.skip;

const BENCHMARK_DOC_DIR = join(process.cwd(), "benchmark-docs");
const RESULTS_DIR = join(BENCHMARK_DOC_DIR, "results");
const REAL_PDF_PATH = join(BENCHMARK_DOC_DIR, "Economic_Growth_vs_Development_WB_Jharkhand.pdf");

const SCENARIO_TIMEOUT_MS = 30 * 60_000;

/** Minimal evidence-extraction prompt established by the T2-03 evidence-fidelity experiment. */
export function buildStage1Prompt(): string {
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

export function buildStage2Prompt(chunkIndex: number, pageNumber: number): string {
  return (
    `You receive VALIDATED evidence items (exact source text) plus a reasoning task. ` +
    `Reason over the meaning of exactText, but NEVER reproduce source text.\n` +
    `Return ONLY one JSON object with exactly this shape:\n` +
    `{"cardId": "chunk-${chunkIndex}", "chunkIndex": ${chunkIndex}, "sourcePages": [${pageNumber}], ` +
    `"definitions": [{"term": "...", "definition": "...", "evidenceIds": ["..."]}], ` +
    `"numbers": [{"value": "...", "unit": null, "evidenceId": "..."}], ` +
    `"claims": [{"kind": "fact|comparison|conclusion", "text": "...", "evidenceIds": ["..."], ` +
    `"pages": [${pageNumber}], "causal": false, "causalEvidenceId": null}]}\n` +
    `Rules: (1) Use ONLY the supplied evidence items. ` +
    `(2) Every definition and every factual claim must cite one or more evidenceIds. ` +
    `(3) Every comparison must cite at least two distinct evidenceIds. ` +
    `(4) Never invent evidenceIds; copy them exactly as supplied. ` +
    `(5) Never create evidence text. (6) Never output source excerpts. ` +
    `(7) Never paraphrase evidence into a dedicated evidence field; claim text is your own restatement. ` +
    `(8) Do not invent numbers: every numbers[].value must equal the value of its cited evidence item. ` +
    `(9) Do not normalize or correct source numbers. (10) Do not infer facts unsupported by cited evidence. ` +
    `(11) causal=true requires a valid causalEvidenceId from the supplied evidence. ` +
    `(12) causal=false needs no causal evidence; causal must always be a boolean. ` +
    `(13) Evidence IDs are references, not content to be modified. ` +
    `(14) cardId must be "chunk-${chunkIndex}", chunkIndex ${chunkIndex}, sourcePages [${pageNumber}], claim pages a subset of sourcePages. ` +
    `(15) Return ONLY the requested JSON object with the exact schema.`
  );
}

const DOCUMENT_CONTEXT_START = "<<<DOCUMENT_CONTEXT_START>>>";
const DOCUMENT_CONTEXT_END = "<<<DOCUMENT_CONTEXT_END>>>";

export interface EvidenceItem {
  evidenceId: string;
  chunkIndex: number;
  sourcePages: number[];
  exactText: string;
  kind: "span" | "number";
  value?: string;
  unit?: string | null;
}

/** First balanced {...} object; null when absent/truncated. */
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface OllamaGenerateResponse {
  response: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

async function postGenerate(prompt: string): Promise<{ data: OllamaGenerateResponse; ms: number }> {
  const started = performance.now();
  const response = await fetch(`${OLLAMA_BASE_URL}${OLLAMA_API_GENERATE}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      format: "json",
      think: false,
      options: { temperature: 0, num_predict: 2048 },
    }),
  });
  if (!response.ok) {
    throw new Error(`Ollama request failed: ${response.status} ${response.statusText}`);
  }
  const data = (await response.json()) as OllamaGenerateResponse;
  return { data, ms: performance.now() - started };
}

/** Parse with direct-parse-first, balanced-extraction fallback. Reports which path worked. */
export function parseWithFallback(raw: string): {
  parsed: unknown;
  parseSuccess: boolean;
  usedFallback: boolean;
  balanced: boolean;
  truncated: boolean;
} {
  try {
    return { parsed: JSON.parse(raw) as unknown, parseSuccess: true, usedFallback: false, balanced: true, truncated: false };
  } catch {
    const jsonText = extractFirstJsonObject(raw);
    if (!jsonText) {
      return { parsed: null, parseSuccess: false, usedFallback: true, balanced: false, truncated: true };
    }
    try {
      return { parsed: JSON.parse(jsonText) as unknown, parseSuccess: true, usedFallback: true, balanced: true, truncated: false };
    } catch {
      return { parsed: null, parseSuccess: false, usedFallback: true, balanced: false, truncated: true };
    }
  }
}

/**
 * Stage-1 validation + Evidence Store construction. Typing rule (documented):
 * `numbers[]` entries become kind "number"; `excerpts[]` entries become kind
 * "span" (model-typed split trusted, each side independently validated — the
 * chunk-2 mis-typing case is therefore preserved as spans, not promoted).
 * IDs assigned locally in validated output order; model never sees IDs.
 */
export function buildEvidenceStore(
  parsed: unknown,
  chunkText: string,
  chunkIndex: number,
  pageNumber: number,
): { store: EvidenceItem[]; validatedSpans: number; validatedNumbers: number; malformed: number; reasons: string[] } {
  const store: EvidenceItem[] = [];
  const reasons: string[] = [];
  let validatedSpans = 0;
  let validatedNumbers = 0;
  let malformed = 0;
  let counter = 0;
  if (!isPlainObject(parsed)) {
    return { store, validatedSpans, validatedNumbers, malformed: 1, reasons: ["Stage-1 output is not an object."] };
  }
  if (Array.isArray(parsed.excerpts)) {
    for (const entry of parsed.excerpts) {
      if (typeof entry !== "string" || entry.length === 0 || !chunkText.includes(entry)) {
        malformed += 1;
        reasons.push("excerpts[] entry is not an exact substring.");
        continue;
      }
      store.push({
        evidenceId: `chunk-${chunkIndex}-e${counter++}`,
        chunkIndex,
        sourcePages: [pageNumber],
        exactText: entry,
        kind: "span",
        unit: null,
      });
      validatedSpans += 1;
    }
  } else if (parsed.excerpts !== undefined) {
    malformed += 1;
    reasons.push("excerpts is not an array.");
  }
  if (Array.isArray(parsed.numbers)) {
    for (const entry of parsed.numbers) {
      if (
        !isPlainObject(entry) ||
        typeof entry.value !== "string" ||
        typeof entry.excerpt !== "string" ||
        entry.value.length === 0 ||
        !chunkText.includes(entry.value) ||
        !chunkText.includes(entry.excerpt) ||
        !entry.excerpt.includes(entry.value)
      ) {
        malformed += 1;
        reasons.push("numbers[] entry failed exact-substring validation.");
        continue;
      }
      store.push({
        evidenceId: `chunk-${chunkIndex}-e${counter++}`,
        chunkIndex,
        sourcePages: [pageNumber],
        exactText: entry.excerpt,
        kind: "number",
        value: entry.value,
        unit: null,
      });
      validatedNumbers += 1;
    }
  } else if (parsed.numbers !== undefined) {
    malformed += 1;
    reasons.push("numbers is not an array.");
  }
  return { store, validatedSpans, validatedNumbers, malformed, reasons };
}

const FORBIDDEN_STAGE2_KEYS = ["excerpt", "excerpt2", "exactText", "sourceExcerpt", "causalExcerpt", "sourceText"];

function findForbiddenKeys(value: unknown, path: string, hits: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => findForbiddenKeys(entry, `${path}[${index}]`, hits));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (FORBIDDEN_STAGE2_KEYS.includes(key)) {
        hits.push(`${path}.${key}`);
      }
      findForbiddenKeys(entry, `${path}.${key}`, hits);
    }
  }
}

/** Stage-2 Fact Card validation against the chunk's Evidence Store. */
export function validateStage2Card(
  card: unknown,
  store: Map<string, EvidenceItem>,
  chunkIndex: number,
  sourcePages: number[],
): { reasons: string[]; inventedIds: string[]; leakageHits: string[] } {
  const reasons: string[] = [];
  const inventedIds: string[] = [];
  const leakageHits: string[] = [];
  if (!isPlainObject(card)) {
    return { reasons: ["Card must be an object."], inventedIds, leakageHits };
  }
  findForbiddenKeys(card, "$", leakageHits);
  if (leakageHits.length > 0) {
    reasons.push(`forbidden source-text fields present: ${leakageHits.join(", ")}.`);
  }
  if (card.cardId !== `chunk-${chunkIndex}` || card.chunkIndex !== chunkIndex) {
    reasons.push(`cardId must be "chunk-${chunkIndex}" with matching chunkIndex.`);
  }
  if (!Array.isArray(card.sourcePages) || card.sourcePages.length !== sourcePages.length ||
    !sourcePages.every((p) => (card.sourcePages as unknown[]).includes(p))) {
    reasons.push("sourcePages must match the chunk source pages.");
  }
  const checkIds = (ids: unknown, prefix: string, minDistinct: number): string[] => {
    if (!Array.isArray(ids) || ids.length === 0) {
      reasons.push(`${prefix} requires at least one evidenceId.`);
      return [];
    }
    const valid: string[] = [];
    for (const id of ids) {
      if (typeof id !== "string") {
        reasons.push(`${prefix} evidenceIds must be strings.`);
        continue;
      }
      const item = store.get(id);
      if (!item) {
        reasons.push(`${prefix} references unknown evidenceId: ${id}.`);
        if (!inventedIds.includes(id)) {
          inventedIds.push(id);
        }
        continue;
      }
      if (item.chunkIndex !== chunkIndex) {
        reasons.push(`${prefix} evidenceId ${id} belongs to another chunk.`);
        continue;
      }
      valid.push(id);
    }
    if (new Set(valid).size < minDistinct) {
      reasons.push(`${prefix} requires at least ${minDistinct} distinct evidenceIds.`);
    }
    return valid;
  };
  if (!Array.isArray(card.definitions)) {
    reasons.push("definitions must be an array.");
  } else {
    card.definitions.forEach((entry: unknown, index: number) => {
      if (!isPlainObject(entry) || typeof entry.term !== "string" || entry.term.trim() === "" ||
        typeof entry.definition !== "string" || entry.definition.trim() === "") {
        reasons.push(`definitions[${index}] must have non-empty term/definition strings.`);
      }
      checkIds(isPlainObject(entry) ? entry.evidenceIds : undefined, `definitions[${index}]`, 1);
    });
  }
  if (!Array.isArray(card.numbers)) {
    reasons.push("numbers must be an array.");
  } else {
    card.numbers.forEach((entry: unknown, index: number) => {
      if (!isPlainObject(entry) || typeof entry.value !== "string" || typeof entry.evidenceId !== "string") {
        reasons.push(`numbers[${index}] must have value/evidenceId strings.`);
        return;
      }
      if (entry.unit !== null && entry.unit !== undefined && typeof entry.unit !== "string") {
        reasons.push(`numbers[${index}].unit must be a string or null.`);
      }
      const item = store.get(entry.evidenceId);
      if (!item) {
        reasons.push(`numbers[${index}] references unknown evidenceId: ${entry.evidenceId}.`);
        if (!inventedIds.includes(entry.evidenceId)) {
          inventedIds.push(entry.evidenceId);
        }
        return;
      }
      if (item.chunkIndex !== chunkIndex) {
        reasons.push(`numbers[${index}] evidenceId belongs to another chunk.`);
        return;
      }
      if (item.kind !== "number" || item.value !== entry.value) {
        reasons.push(`numbers[${index}].value does not match the cited evidence item.`);
      }
    });
  }
  if (!Array.isArray(card.claims)) {
    reasons.push("claims must be an array.");
  } else {
    card.claims.forEach((entry: unknown, index: number) => {
      if (!isPlainObject(entry)) {
        reasons.push(`claims[${index}] must be an object.`);
        return;
      }
      if (!["fact", "comparison", "conclusion"].includes(entry.kind as string)) {
        reasons.push(`claims[${index}].kind must be fact|comparison|conclusion.`);
      }
      if (typeof entry.text !== "string" || entry.text.trim() === "") {
        reasons.push(`claims[${index}].text must be a non-empty string.`);
      }
      checkIds(entry.evidenceIds, `claims[${index}]`, entry.kind === "comparison" ? 2 : 1);
      if (!Array.isArray(entry.pages) || entry.pages.length === 0 ||
        !(entry.pages as unknown[]).every((p) => sourcePages.includes(p as number))) {
        reasons.push(`claims[${index}].pages must be a non-empty subset of sourcePages.`);
      }
      if (typeof entry.causal !== "boolean") {
        reasons.push(`claims[${index}].causal must be a boolean.`);
        return;
      }
      if (entry.causal) {
        if (typeof entry.causalEvidenceId !== "string" || !store.has(entry.causalEvidenceId) ||
          (store.get(entry.causalEvidenceId) as EvidenceItem).chunkIndex !== chunkIndex) {
          reasons.push(`claims[${index}].causalEvidenceId must reference valid supplied evidence.`);
          if (typeof entry.causalEvidenceId === "string" && !store.has(entry.causalEvidenceId) &&
            !inventedIds.includes(entry.causalEvidenceId)) {
            inventedIds.push(entry.causalEvidenceId);
          }
        }
      }
    });
  }
  return { reasons, inventedIds, leakageHits };
}

export const EXPECTED_DEFINITIONS = ["economic growth", "economic development"];
export const EXPECTED_NUMBERS = ["84.78%", "72.13%", "82.26%", "61.11%", "41.13", "22.24", "11.89%", "28.81%"];
const EXPECTED_COMPARISONS: Array<{ alternatives: string[][] }> = [
  { alternatives: [["west bengal", "urban", "rural"]] },
  { alternatives: [["jharkhand", "urban", "rural"]] },
  { alternatives: [["gap", "jharkhand", "bengal"], ["gap", "jharkhand", "wb"]] },
  { alternatives: [["imr", "rural", "urban"], ["41.13", "22.24"]] },
];

describeLive("Ollama T2-05 Evidence-ID Reasoning (gated: RUN_OLLAMA_T205=1)", () => {
  const liveIt = it.skipIf(!existsSync(REAL_PDF_PATH));

  liveIt("stage-1 evidence store then stage-2 evidence-ID fact cards, no repair", { timeout: SCENARIO_TIMEOUT_MS }, async () => {
    const file = new File([readFileSync(REAL_PDF_PATH)], "Economic_Growth_vs_Development_WB_Jharkhand.pdf", {
      type: "application/pdf",
    });
    const context = await buildAiTextContext(file);
    expect(context.chunks.length).toBe(6);

    const chunkResults: Array<Record<string, unknown>> = [];
    let s1Parseable = 0;
    let s1ValidatedItems = 0;
    let s1Malformed = 0;
    let s1Ms = 0;
    let s2Parseable = 0;
    let s2Accepted = 0;
    let s2Ms = 0;
    let inventedTotal = 0;
    let leakageTotal = 0;

    for (const chunk of context.chunks) {
      const sourcePages = [chunk.pageNumber];
      // ---- Stage 1 ----
      const s1 = await postGenerate(
        `${buildStage1Prompt()}\n\n${DOCUMENT_CONTEXT_START}\n[page ${chunk.pageNumber}] ${chunk.text}\n${DOCUMENT_CONTEXT_END}`,
      );
      s1Ms += s1.ms;
      const s1Parsed = parseWithFallback(s1.data.response);
      let store: EvidenceItem[] = [];
      let s1Reasons: string[] = [];
      let spans = 0;
      let numbers = 0;
      let malformed = 0;
      if (s1Parsed.parseSuccess) {
        s1Parseable += 1;
        const built = buildEvidenceStore(s1Parsed.parsed, chunk.text, chunk.chunkIndex, chunk.pageNumber);
        store = built.store;
        spans = built.validatedSpans;
        numbers = built.validatedNumbers;
        malformed = built.malformed;
        s1Reasons = built.reasons;
      } else {
        malformed = 1;
        s1Reasons = ["Stage-1 output unparseable."];
      }
      s1Malformed += malformed;
      s1ValidatedItems += store.length;
      const storeMap = new Map(store.map((item) => [item.evidenceId, item]));

      // ---- Stage 2 (validated evidence ONLY; no raw chunk text) ----
      const stage2Input = {
        chunkIndex: chunk.chunkIndex,
        sourcePages,
        evidence: store,
        task: "Create a Fact Card grounded only in the supplied evidence.",
      };
      const s2 = await postGenerate(`${buildStage2Prompt(chunk.chunkIndex, chunk.pageNumber)}\n\n${JSON.stringify(stage2Input)}`);
      s2Ms += s2.ms;
      const s2Parsed = parseWithFallback(s2.data.response);
      let s2Reasons: string[] = [];
      let invented: string[] = [];
      let leakage: string[] = [];
      let accepted = false;
      if (s2Parsed.parseSuccess) {
        s2Parseable += 1;
        const verdict = validateStage2Card(s2Parsed.parsed, storeMap, chunk.chunkIndex, sourcePages);
        s2Reasons = verdict.reasons;
        invented = verdict.inventedIds;
        leakage = verdict.leakageHits;
        accepted = s2Reasons.length === 0;
        if (accepted) {
          s2Accepted += 1;
        }
      } else {
        s2Reasons = ["Stage-2 output unparseable."];
      }
      inventedTotal += invented.length;
      leakageTotal += leakage.length;

      // Expected-fact recovery (accepted cards only; numbers denominator = values present in store).
      const expectedNumbersPresent = EXPECTED_NUMBERS.filter((n) => store.some((e) => e.value === n));
      let recoveredNumbers: string[] = [];
      let recoveredDefinitions: string[] = [];
      let recoveredComparisons = 0;
      if (accepted && isPlainObject(s2Parsed.parsed)) {
        const card = s2Parsed.parsed as Record<string, unknown>;
        const cardNumbers = Array.isArray(card.numbers)
          ? (card.numbers as unknown[]).filter(isPlainObject).map((e) => e.value).filter((v): v is string => typeof v === "string")
          : [];
        recoveredNumbers = expectedNumbersPresent.filter((n) => cardNumbers.includes(n));
        const defCorpus = Array.isArray(card.definitions)
          ? (card.definitions as unknown[]).filter(isPlainObject).map((e) => `${e.term ?? ""} ${e.definition ?? ""}`.toLowerCase()).join("\n")
          : "";
        recoveredDefinitions = EXPECTED_DEFINITIONS.filter((d) => defCorpus.includes(d));
        const claimTexts = Array.isArray(card.claims)
          ? (card.claims as unknown[]).filter(isPlainObject).map((e) => String(e.text ?? "").toLowerCase())
          : [];
        recoveredComparisons = EXPECTED_COMPARISONS.filter((c) =>
          c.alternatives.some((tokens) => claimTexts.some((t) => tokens.every((tok) => t.includes(tok)))),
        ).length;
      }

      chunkResults.push({
        chunkIndex: chunk.chunkIndex,
        stage1: {
          rawOutputLength: s1.data.response.length,
          parseSuccess: s1Parsed.parseSuccess,
          balanced: s1Parsed.balanced,
          truncated: s1Parsed.truncated,
          usedFallback: s1Parsed.usedFallback,
          validatedSpans: spans,
          validatedNumbers: numbers,
          malformed,
          storeSize: store.length,
          reasons: s1Reasons,
          inputTokens: s1.data.prompt_eval_count ?? null,
          outputTokens: s1.data.eval_count ?? null,
          generationMs: Math.round(s1.ms),
        },
        evidenceStore: store,
        stage2: {
          rawOutputLength: s2.data.response.length,
          parseSuccess: s2Parsed.parseSuccess,
          balanced: s2Parsed.balanced,
          truncated: s2Parsed.truncated,
          usedFallback: s2Parsed.usedFallback,
          accepted,
          reasons: s2Reasons,
          inventedIds: invented,
          leakageHits: leakage,
          inputTokens: s2.data.prompt_eval_count ?? null,
          outputTokens: s2.data.eval_count ?? null,
          generationMs: Math.round(s2.ms),
        },
        rawStage2: s2.data.response,
        expected: { expectedNumbersPresent, recoveredNumbers, recoveredDefinitions, recoveredComparisons },
      });
    }

    const record = {
      timestamp: new Date().toISOString(),
      scenario: "t2-05-evidence-id-reasoning",
      model: OLLAMA_MODEL,
      document: "Economic_Growth_vs_Development_WB_Jharkhand.pdf",
      budgets: { numPredict: 2048, temperature: 0, think: false },
      typingRule: "model-typed split trusted per side with independent validation; no deterministic promotion applied",
      stage1: { chunks: 6, parseable: s1Parseable, malformed: s1Malformed, validatedItems: s1ValidatedItems, runtimeMs: Math.round(s1Ms) },
      stage2: {
        chunks: 6,
        parseable: s2Parseable,
        accepted: s2Accepted,
        rejected: 6 - s2Accepted,
        inventedIds: inventedTotal,
        leakageHits: leakageTotal,
        runtimeMs: Math.round(s2Ms),
      },
      totalRuntimeMs: Math.round(s1Ms + s2Ms),
      chunks: chunkResults,
    };
    mkdirSync(RESULTS_DIR, { recursive: true });
    writeFileSync(join(RESULTS_DIR, `t2-05-evidence-id-${Date.now()}.json`), JSON.stringify(record, null, 2));

    console.log(
      `[t2-05] s1 parseable=${s1Parseable}/6 items=${s1ValidatedItems} malformed=${s1Malformed} ` +
        `s2 parseable=${s2Parseable}/6 accepted=${s2Accepted}/6 invented=${inventedTotal} leakage=${leakageTotal}`,
    );

    expect(record.chunks.length).toBe(6);
    expect(existsSync(RESULTS_DIR)).toBe(true);
  });
});
