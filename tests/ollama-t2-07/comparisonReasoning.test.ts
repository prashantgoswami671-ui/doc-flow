/**
 * T2-07 Evidence-ID Comparison Reasoning Experiment (controlled, PoC-ONLY).
 *
 * Frozen baseline: same PDF, same 6 AI-02 chunks, same model (qwen3:4b),
 * same Ollama endpoint/options, same T2-05 Stage-1 extraction prompt,
 * validation, and Evidence Store construction (T2-06 Variant A approach:
 * model-typed split trusted, NO deterministic numeric promotion).
 *
 * A/B design: ONE shared Stage-1 run (6 calls). Variant A Stage-2 uses the
 * frozen T2-05/T2-06 prompt unchanged (6 calls). Variant B Stage-2 uses the
 * SAME prompt PLUS a narrowly scoped comparison-reasoning appendix (6 calls).
 * Total: 18 Ollama generation calls. No repair, no retries.
 *
 * Evaluation: local DETERMINISTIC per-comparison adjudication (NOT keyword
 * counting alone). For each frozen comparison and each emitted
 * kind="comparison" claim: (A) signature emitted? (B) >=2 distinct valid
 * evidenceIds? (C) cited items contain the two relevant quantities?
 * (D) direction correct (arithmetic for the gap comparison done locally)?
 *
 * Does NOT modify: production code, tests/ollama-t2-03/*,
 * tests/ollama-t2-04/*, tests/ollama-t2-05/*, tests/ollama-t2-06/*,
 * package files, docs.
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

const POC_ENABLED = process.env.RUN_OLLAMA_T207 === "1";
const describeLive = POC_ENABLED ? describe : describe.skip;

const BENCHMARK_DOC_DIR = join(process.cwd(), "benchmark-docs");
const RESULTS_DIR = join(BENCHMARK_DOC_DIR, "results");
const REAL_PDF_PATH = join(BENCHMARK_DOC_DIR, "Economic_Growth_vs_Development_WB_Jharkhand.pdf");

const SCENARIO_TIMEOUT_MS = 30 * 60_000;

/* ------------------------------------------------------------------ */
/* Frozen T2-05 prompts / helpers (copied verbatim; MUST NOT change)   */
/* ------------------------------------------------------------------ */

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

/** Frozen T2-05/T2-06 Stage-2 Evidence-ID reasoning prompt = Variant A. */
export function buildStage2PromptBase(chunkIndex: number, pageNumber: number): string {
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

/**
 * Variant B = Variant A base prompt PLUS this narrowly scoped
 * comparison-reasoning appendix. Nothing else differs.
 */
export function buildComparisonAppendix(): string {
  return (
    `Comparison-reasoning requirements (apply in addition to the rules above; everything else is unchanged):\n` +
    `(1) A comparison claim (kind "comparison") requires at least TWO distinct evidenceIds.\n` +
    `(2) Identify the two quantities or entities being compared before emitting the claim.\n` +
    `(3) Determine the direction of the comparison (which side is higher or larger) from the supplied evidence items.\n` +
    `(4) Do not infer a comparison merely because two numbers appear in the evidence.\n` +
    `(5) Both sides of the comparison must be supported by the cited evidenceIds.\n` +
    `(6) If the evidence does not support the direction, do not emit the comparison claim.\n` +
    `(7) Never invent a missing value.\n` +
    `(8) Never invent an evidenceId; copy supplied IDs exactly.\n` +
    `(9) The comparison claim text may be your own semantic restatement, but its support must be represented only through evidenceIds.\n` +
    `(10) Do not output source excerpts.\n` +
    `(11) Do not perform calculations that require information absent from the supplied evidence.\n` +
    `(12) For percentage or rate comparisons, preserve the meaning and units of the source values.`
  );
}

export function buildStage2PromptVariantB(chunkIndex: number, pageNumber: number): string {
  return `${buildStage2PromptBase(chunkIndex, pageNumber)}\n\n${buildComparisonAppendix()}`;
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

/** Parse with direct-parse-first, balanced-extraction fallback. */
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
 * Stage-1 validation + Evidence Store construction (T2-06 Variant A rule).
 * numbers[] -> kind "number"; excerpts[] -> kind "span". No promotion.
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

/** Stage-2 Fact Card validation against the chunk's Evidence Store (frozen T2-05/T2-06). */
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

/* ------------------------------------------------------------------ */
/* Deterministic frozen-comparison evaluation                          */
/*                                                                     */
/* Each frozen comparison declares: a text signature (side keywords +  */
/* domain keywords), the two expected value strings, and which side is */
/* higher. A claim is CORRECT only if (A) its text matches the         */
/* signature, (B) it cites >=2 distinct valid evidenceIds from its own */
/* chunk, (C) the cited items contain BOTH expected quantities         */
/* (via item.value equality or exactText inclusion), and (D) the text  */
/* states the correct direction. Wording is free; only these four      */
/* checks matter. Gap arithmetic is verified locally, never trusted    */
/* from model output.                                                  */
/* ------------------------------------------------------------------ */

export interface FrozenComparison {
  id: string;
  label: string;
  /** Keywords that must ALL (as alternatives) appear in the claim text. */
  signature: string[][];
  /** Expected value strings: [higherSideValue, lowerSideValue]. */
  higherValue: string;
  lowerValue: string;
  /** Alternative side keywords [higherSideAlts, lowerSideAlts] for order detection. */
  higherSideAlts: string[];
  lowerSideAlts: string[];
}

export const FROZEN_COMPARISONS: FrozenComparison[] = [
  {
    id: "wb-literacy",
    label: "WB urban literacy > WB rural literacy",
    signature: [["west bengal", "wb", "bengal"], ["urban"], ["rural"], ["literacy", "literate"]],
    higherValue: "84.78%",
    lowerValue: "72.13%",
    higherSideAlts: ["urban"],
    lowerSideAlts: ["rural"],
  },
  {
    id: "jh-literacy",
    label: "Jharkhand urban literacy > Jharkhand rural literacy",
    signature: [["jharkhand"], ["urban"], ["rural"], ["literacy", "literate"]],
    higherValue: "82.26%",
    lowerValue: "61.11%",
    higherSideAlts: ["urban"],
    lowerSideAlts: ["rural"],
  },
  {
    id: "literacy-gap",
    label: "Jharkhand literacy gap > WB literacy gap",
    signature: [["jharkhand"], ["west bengal", "wb", "bengal"], ["gap", "disparity", "difference", "disparities"]],
    higherValue: "21.15",
    lowerValue: "12.65",
    higherSideAlts: ["jharkhand"],
    lowerSideAlts: ["west bengal", "wb", "bengal"],
  },
  {
    id: "jh-imr",
    label: "Jharkhand rural IMR > Jharkhand urban IMR",
    signature: [["jharkhand", "imr", "infant", "mortality"], ["rural"], ["urban"], ["imr", "infant", "mortality"]],
    higherValue: "41.13",
    lowerValue: "22.24",
    higherSideAlts: ["rural"],
    lowerSideAlts: ["urban"],
  },
];

/** Locally computed gap values (percentage points): never taken from model output. */
export const LOCAL_GAP_ARITHMETIC = {
  jharkhandGap: 82.26 - 61.11, // 21.15
  wbGap: 84.78 - 72.13, // 12.65
};

const HIGHER_WORDS = ["higher", "greater", "exceed", "above", "more than", "larger", "wider", "worse"];
const LOWER_WORDS = ["lower", "less than", "less ", "below", "fewer", "smaller", "narrower"];

function firstIndexOf(text: string, alts: string[]): number {
  let best = -1;
  for (const alt of alts) {
    const i = text.indexOf(alt);
    if (i !== -1 && (best === -1 || i < best)) {
      best = i;
    }
  }
  return best;
}

function containsAny(text: string, words: string[]): boolean {
  return words.some((w) => text.includes(w));
}

/** (D) Direction check: higher-side entity first + higher-word, or lower-side first + lower-word. Negations fail. */
export function checkDirection(text: string, spec: FrozenComparison): { ok: boolean; detail: string } {
  const t = text.toLowerCase();
  if (/(not|never|no longer|n't)\s+(higher|greater|more|large|wide|exceed|above)/.test(t)) {
    return { ok: false, detail: "negated comparative; direction rejected." };
  }
  const higherIdx = firstIndexOf(t, spec.higherSideAlts);
  const lowerIdx = firstIndexOf(t, spec.lowerSideAlts);
  if (higherIdx === -1 || lowerIdx === -1) {
    return { ok: false, detail: "comparison sides not both identifiable in text." };
  }
  const hasHigher = containsAny(t, HIGHER_WORDS);
  const hasLower = containsAny(t, LOWER_WORDS);
  if (hasHigher && hasLower) {
    return { ok: false, detail: "mixed higher/lower language; direction ambiguous." };
  }
  if (higherIdx < lowerIdx) {
    return hasHigher
      ? { ok: true, detail: "higher side stated first with higher-comparative." }
      : { ok: false, detail: "higher side first but no higher-comparative (reversed or missing direction)." };
  }
  return hasLower
    ? { ok: true, detail: "lower side stated first with lower-comparative." }
    : { ok: false, detail: "lower side first but no lower-comparative (reversed or missing direction)." };
}

export interface ComparisonClaimView {
  chunkIndex: number;
  claimIndex: number;
  text: string;
  evidenceIds: string[];
}

export function extractComparisonClaims(parsed: unknown, chunkIndex: number): ComparisonClaimView[] {
  if (!isPlainObject(parsed) || !Array.isArray(parsed.claims)) {
    return [];
  }
  const out: ComparisonClaimView[] = [];
  (parsed.claims as unknown[]).forEach((entry, claimIndex) => {
    if (!isPlainObject(entry) || entry.kind !== "comparison" || typeof entry.text !== "string") {
      return;
    }
    const ids = Array.isArray(entry.evidenceIds)
      ? (entry.evidenceIds as unknown[]).filter((id): id is string => typeof id === "string")
      : [];
    out.push({ chunkIndex, claimIndex, text: entry.text, evidenceIds: ids });
  });
  return out;
}

function signatureMatches(text: string, spec: FrozenComparison): boolean {
  const t = text.toLowerCase();
  return spec.signature.every((alts) => alts.some((alt) => t.includes(alt)));
}

function itemContainsValue(item: EvidenceItem, value: string): boolean {
  return item.value === value || item.exactText.includes(value);
}

export interface ComparisonVerdict {
  comparisonId: string;
  status: "correct" | "incorrect" | "missing";
  criterionA_emitted: boolean;
  criterionB_twoValidIds: boolean;
  criterionC_correctPair: boolean;
  criterionD_directionOk: boolean;
  directionDetail: string;
  bestClaim: ComparisonClaimView | null;
  gapArithmeticOk: boolean | null;
}

/**
 * Deterministic adjudication of ONE frozen comparison against ALL comparison
 * claims of a variant. Status: correct (some claim passes A-D), incorrect
 * (signature-matching claim exists but none passes A-D), missing (no match).
 */
export function adjudicateComparison(
  spec: FrozenComparison,
  claims: ComparisonClaimView[],
  storesByChunk: Map<number, Map<string, EvidenceItem>>,
): ComparisonVerdict {
  const matching = claims.filter((c) => signatureMatches(c.text, spec));
  if (matching.length === 0) {
    return {
      comparisonId: spec.id,
      status: "missing",
      criterionA_emitted: false,
      criterionB_twoValidIds: false,
      criterionC_correctPair: false,
      criterionD_directionOk: false,
      directionDetail: "no signature-matching comparison claim emitted.",
      bestClaim: null,
      gapArithmeticOk: spec.id === "literacy-gap" ? LOCAL_GAP_ARITHMETIC.jharkhandGap > LOCAL_GAP_ARITHMETIC.wbGap : null,
    };
  }
  let best: ComparisonVerdict | null = null;
  for (const claim of matching) {
    const store = storesByChunk.get(claim.chunkIndex) ?? new Map<string, EvidenceItem>();
    const distinctValid = [...new Set(claim.evidenceIds)].filter((id) => {
      const item = store.get(id);
      return item !== undefined && item.chunkIndex === claim.chunkIndex;
    });
    const bOk = distinctValid.length >= 2;
    const citedItems = distinctValid
      .map((id) => store.get(id))
      .filter((item): item is EvidenceItem => item !== undefined);
    let cOk: boolean;
    let gapOk: boolean | null = null;
    if (spec.id === "literacy-gap") {
      // Correct pair = cited items collectively cover >=1 Jharkhand literacy
      // value AND >=1 WB literacy value; arithmetic verified locally.
      const jhValues = ["82.26%", "82.26", "61.11"];
      const wbValues = ["84.78%", "84.78", "72.13"];
      const hasJh = citedItems.some((item) => jhValues.some((v) => itemContainsValue(item, v)));
      const hasWb = citedItems.some((item) => wbValues.some((v) => itemContainsValue(item, v)));
      cOk = hasJh && hasWb;
      gapOk = LOCAL_GAP_ARITHMETIC.jharkhandGap > LOCAL_GAP_ARITHMETIC.wbGap;
    } else {
      const hasHigher = citedItems.some((item) => itemContainsValue(item, spec.higherValue));
      const hasLower = citedItems.some((item) => itemContainsValue(item, spec.lowerValue));
      cOk = hasHigher && hasLower;
    }
    const dir = checkDirection(claim.text, spec);
    const dOk = dir.ok;
    const verdict: ComparisonVerdict = {
      comparisonId: spec.id,
      status: bOk && cOk && dOk ? "correct" : "incorrect",
      criterionA_emitted: true,
      criterionB_twoValidIds: bOk,
      criterionC_correctPair: cOk,
      criterionD_directionOk: dOk,
      directionDetail: dir.detail,
      bestClaim: claim,
      gapArithmeticOk: gapOk,
    };
    if (verdict.status === "correct") {
      return verdict;
    }
    // Prefer the claim that passes the most criteria (B > C > D) for reporting.
    if (!best) {
      best = verdict;
    } else {
      const score = (v: ComparisonVerdict): number =>
        (v.criterionB_twoValidIds ? 1 : 0) + (v.criterionC_correctPair ? 1 : 0) + (v.criterionD_directionOk ? 1 : 0);
      if (score(verdict) > score(best)) {
        best = verdict;
      }
    }
  }
  return best as ComparisonVerdict;
}

describeLive("Ollama T2-07 Comparison Reasoning (gated: RUN_OLLAMA_T207=1)", () => {
  const liveIt = it.skipIf(!existsSync(REAL_PDF_PATH));

  liveIt("shared stage-1 then stage-2 baseline vs comparison-focused prompt, no repair", { timeout: SCENARIO_TIMEOUT_MS }, async () => {
    const file = new File([readFileSync(REAL_PDF_PATH)], "Economic_Growth_vs_Development_WB_Jharkhand.pdf", {
      type: "application/pdf",
    });
    const context = await buildAiTextContext(file);
    expect(context.chunks.length).toBe(6);

    let stage1Calls = 0;
    let stage2ACalls = 0;
    let stage2BCalls = 0;

    /* ---- Shared Stage 1 (ONE run, 6 calls; T2-06 Variant A construction) ---- */
    let s1Ms = 0;
    let s1Parseable = 0;
    let s1Malformed = 0;
    let s1ValidatedSpans = 0;
    let s1ValidatedNumbers = 0;

    interface ChunkStage1 {
      chunkIndex: number;
      pageNumber: number;
      chunkText: string;
      rawResponse: string;
      parseSuccess: boolean;
      store: EvidenceItem[];
      reasons: string[];
      generationMs: number;
    }
    const stage1ByChunk: ChunkStage1[] = [];

    for (const chunk of context.chunks) {
      const s1 = await postGenerate(
        `${buildStage1Prompt()}\n\n${DOCUMENT_CONTEXT_START}\n[page ${chunk.pageNumber}] ${chunk.text}\n${DOCUMENT_CONTEXT_END}`,
      );
      stage1Calls += 1;
      s1Ms += s1.ms;
      const s1Parsed = parseWithFallback(s1.data.response);
      let store: EvidenceItem[] = [];
      let reasons: string[] = [];
      if (s1Parsed.parseSuccess) {
        s1Parseable += 1;
        const built = buildEvidenceStore(s1Parsed.parsed, chunk.text, chunk.chunkIndex, chunk.pageNumber);
        store = built.store;
        s1ValidatedSpans += built.validatedSpans;
        s1ValidatedNumbers += built.validatedNumbers;
        s1Malformed += built.malformed;
        reasons = built.reasons;
      } else {
        s1Malformed += 1;
        reasons = ["Stage-1 output unparseable."];
      }
      stage1ByChunk.push({
        chunkIndex: chunk.chunkIndex,
        pageNumber: chunk.pageNumber,
        chunkText: chunk.text,
        rawResponse: s1.data.response,
        parseSuccess: s1Parsed.parseSuccess,
        store,
        reasons,
        generationMs: Math.round(s1.ms),
      });
    }

    const storesByChunk = new Map<number, Map<string, EvidenceItem>>(
      stage1ByChunk.map((c) => [c.chunkIndex, new Map(c.store.map((item) => [item.evidenceId, item]))]),
    );

    /* ---- Stage-2 runner (prompt builder is the ONLY difference) ---- */
    interface ChunkStage2 {
      chunkIndex: number;
      evidenceSent: EvidenceItem[];
      promptSent: string;
      rawResponse: string;
      rawChars: number;
      parseSuccess: boolean;
      schemaValid: boolean;
      accepted: boolean;
      reasons: string[];
      inventedIds: string[];
      leakageHits: string[];
      truncated: boolean;
      generationMs: number;
      parsed: unknown;
    }

    async function runVariant(
      promptFor: (chunkIndex: number, pageNumber: number) => string,
      onCall: () => void,
    ): Promise<{ chunks: ChunkStage2[]; ms: number }> {
      const chunks: ChunkStage2[] = [];
      let ms = 0;
      for (const base of stage1ByChunk) {
        const stage2Input = {
          chunkIndex: base.chunkIndex,
          sourcePages: [base.pageNumber],
          evidence: base.store,
          task: "Create a Fact Card grounded only in the supplied evidence.",
        };
        const prompt = `${promptFor(base.chunkIndex, base.pageNumber)}\n\n${JSON.stringify(stage2Input)}`;
        const started = performance.now();
        const s2 = await postGenerate(prompt);
        onCall();
        ms += performance.now() - started;
        const s2Parsed = parseWithFallback(s2.data.response);
        let reasons: string[] = [];
        let invented: string[] = [];
        let leakage: string[] = [];
        let accepted = false;
        let schemaValid = false;
        if (s2Parsed.parseSuccess) {
          const storeMap = storesByChunk.get(base.chunkIndex) as Map<string, EvidenceItem>;
          const verdict = validateStage2Card(s2Parsed.parsed, storeMap, base.chunkIndex, [base.pageNumber]);
          reasons = verdict.reasons;
          invented = verdict.inventedIds;
          leakage = verdict.leakageHits;
          accepted = reasons.length === 0;
          schemaValid =
            isPlainObject(s2Parsed.parsed) &&
            Array.isArray(s2Parsed.parsed.definitions) &&
            Array.isArray(s2Parsed.parsed.numbers) &&
            Array.isArray(s2Parsed.parsed.claims);
        } else {
          reasons = ["Stage-2 output unparseable."];
        }
        chunks.push({
          chunkIndex: base.chunkIndex,
          evidenceSent: base.store,
          promptSent: prompt,
          rawResponse: s2.data.response,
          rawChars: s2.data.response.length,
          parseSuccess: s2Parsed.parseSuccess,
          schemaValid,
          accepted,
          reasons,
          inventedIds: invented,
          leakageHits: leakage,
          truncated: s2Parsed.truncated,
          generationMs: Math.round(s2.ms),
          parsed: s2Parsed.parsed,
        });
      }
      return { chunks, ms };
    }

    // ONE Stage-2 run per variant.
    const variantA = await runVariant(
      (ci, p) => buildStage2PromptBase(ci, p),
      () => {
        stage2ACalls += 1;
      },
    );
    const variantB = await runVariant(
      (ci, p) => buildStage2PromptVariantB(ci, p),
      () => {
        stage2BCalls += 1;
      },
    );

    /* ---- Live-call budget enforcement ---- */
    expect(stage1Calls).toBe(6);
    expect(stage2ACalls).toBe(6);
    expect(stage2BCalls).toBe(6);

    // Byte-identical Evidence Store content check (only the prompt differs).
    const storesByteIdentical = stage1ByChunk.every(
      (_base, i) =>
        JSON.stringify(variantA.chunks[i].evidenceSent) === JSON.stringify(variantB.chunks[i].evidenceSent),
    );
    expect(storesByteIdentical).toBe(true);

    /* ---- Aggregation ---- */
    function summarizeVariant(chunks: ChunkStage2[]): {
      summary: Record<string, unknown>;
      comparisonClaims: ComparisonClaimView[];
      verdicts: ComparisonVerdict[];
    } {
      const reasons = chunks.flatMap((c) => c.reasons);
      const countRe = (re: RegExp): number => reasons.filter((r) => re.test(r)).length;
      const comparisonClaims = chunks.flatMap((c) =>
        c.parseSuccess ? extractComparisonClaims(c.parsed, c.chunkIndex) : [],
      );
      const verdicts = FROZEN_COMPARISONS.map((spec) => adjudicateComparison(spec, comparisonClaims, storesByChunk));

      // Per-claim comparison diagnostics.
      let claimsWithGte2Ids = 0;
      let claimsWithValidIds = 0;
      let claimsCorrectPair = 0;
      let claimsDirectionOk = 0;
      let oneIdFailures = 0;
      let inventedInComparisons = 0;
      for (const claim of comparisonClaims) {
        const store = storesByChunk.get(claim.chunkIndex) ?? new Map<string, EvidenceItem>();
        const distinctValid = [...new Set(claim.evidenceIds)].filter((id) => {
          const item = store.get(id);
          return item !== undefined && item.chunkIndex === claim.chunkIndex;
        });
        const invented = claim.evidenceIds.filter((id) => !store.has(id));
        inventedInComparisons += invented.length;
        if (distinctValid.length >= 2) {
          claimsWithGte2Ids += 1;
        } else {
          oneIdFailures += 1;
        }
        if (distinctValid.length === new Set(claim.evidenceIds).size && invented.length === 0 && claim.evidenceIds.length > 0) {
          claimsWithValidIds += 1;
        }
        const citedItems = distinctValid
          .map((id) => store.get(id))
          .filter((item): item is EvidenceItem => item !== undefined);
        const pairOk = FROZEN_COMPARISONS.some((spec) => {
          if (spec.id === "literacy-gap") {
            const jh = ["82.26%", "82.26", "61.11"].some((v) => citedItems.some((it) => itemContainsValue(it, v)));
            const wb = ["84.78%", "84.78", "72.13"].some((v) => citedItems.some((it) => itemContainsValue(it, v)));
            return jh && wb;
          }
          return (
            citedItems.some((it) => itemContainsValue(it, spec.higherValue)) &&
            citedItems.some((it) => itemContainsValue(it, spec.lowerValue))
          );
        });
        if (pairOk) {
          claimsCorrectPair += 1;
        }
        const dirOk = FROZEN_COMPARISONS.some(
          (spec) => signatureMatches(claim.text, spec) && checkDirection(claim.text, spec).ok,
        );
        if (dirOk) {
          claimsDirectionOk += 1;
        }
      }

      const summary: Record<string, unknown> = {
        chunks: chunks.length,
        parseable: chunks.filter((c) => c.parseSuccess).length,
        schemaValid: chunks.filter((c) => c.schemaValid).length,
        accepted: chunks.filter((c) => c.accepted).length,
        rejected: chunks.filter((c) => !c.accepted).length,
        inventedIds: chunks.reduce((n, c) => n + c.inventedIds.length, 0),
        invalidIds:
          chunks.reduce((n, c) => n + c.inventedIds.length, 0) + countRe(/belongs to another chunk/),
        leakageHits: chunks.reduce((n, c) => n + c.leakageHits.length, 0),
        numericalFailures: countRe(/numbers\[\d+\]/),
        causalFailures: countRe(/causal/),
        pageFailures: countRe(/pages must be|sourcePages must match/),
        truncations: chunks.filter((c) => c.truncated).length,
        rawChars: chunks.map((c) => ({ chunkIndex: c.chunkIndex, chars: c.rawChars })),
        comparisonEmitted: comparisonClaims.length,
        comparisonWithGte2Ids: claimsWithGte2Ids,
        comparisonWithValidIds: claimsWithValidIds,
        comparisonCorrectPair: claimsCorrectPair,
        comparisonDirectionOk: claimsDirectionOk,
        frozenRecovered: verdicts.filter((v) => v.status === "correct").length,
        frozenMissed: verdicts.filter((v) => v.status === "missing").map((v) => v.comparisonId),
        frozenIncorrect: verdicts.filter((v) => v.status === "incorrect").map((v) => v.comparisonId),
        oneIdFailures,
        inventedInComparisons,
      };
      return { summary, comparisonClaims, verdicts };
    }

    const resultA = summarizeVariant(variantA.chunks);
    const resultB = summarizeVariant(variantB.chunks);

    const record = {
      timestamp: new Date().toISOString(),
      scenario: "t2-07-comparison-reasoning",
      model: OLLAMA_MODEL,
      endpoint: OLLAMA_BASE_URL,
      document: "Economic_Growth_vs_Development_WB_Jharkhand.pdf",
      budgets: { numPredict: 2048, temperature: 0, think: false, stream: false, format: "json", numCtx: "not specified" },
      frozen: {
        chunks: 6,
        stage1Prompt: "t2-05 verbatim",
        stage2PromptA: "t2-05/t2-06 verbatim",
        stage2PromptB: "t2-05/t2-06 verbatim + narrow comparison-reasoning appendix (12 points)",
        stage2Validator: "t2-05/t2-06 verbatim",
        evidenceTyping: "t2-06 variant A (model-typed; no numeric promotion)",
        frozenComparisons: FROZEN_COMPARISONS.map((s) => ({ id: s.id, label: s.label })),
        localGapArithmetic: {
          jharkhandGap: LOCAL_GAP_ARITHMETIC.jharkhandGap,
          wbGap: LOCAL_GAP_ARITHMETIC.wbGap,
          jharkhandGapGreater: LOCAL_GAP_ARITHMETIC.jharkhandGap > LOCAL_GAP_ARITHMETIC.wbGap,
        },
        repair: false,
      },
      liveCalls: { stage1: stage1Calls, stage2A: stage2ACalls, stage2B: stage2BCalls },
      storesByteIdentical,
      stage1Shared: {
        chunks: 6,
        parseable: s1Parseable,
        malformed: s1Malformed,
        validatedItems: s1ValidatedSpans + s1ValidatedNumbers,
        modelTypedSpans: s1ValidatedSpans,
        modelTypedNumbers: s1ValidatedNumbers,
        runtimeMs: Math.round(s1Ms),
      },
      variantA: { ...resultA.summary, runtimeMs: Math.round(variantA.ms), verdicts: resultA.verdicts, chunksDetail: variantA.chunks },
      variantB: { ...resultB.summary, runtimeMs: Math.round(variantB.ms), verdicts: resultB.verdicts, chunksDetail: variantB.chunks },
      comparisonTable: FROZEN_COMPARISONS.map((spec) => ({
        id: spec.id,
        label: spec.label,
        variantA: resultA.verdicts.find((v) => v.comparisonId === spec.id),
        variantB: resultB.verdicts.find((v) => v.comparisonId === spec.id),
      })),
      runtime: {
        stage1SharedMs: Math.round(s1Ms),
        stage2AMs: Math.round(variantA.ms),
        stage2BMs: Math.round(variantB.ms),
        totalMs: Math.round(s1Ms + variantA.ms + variantB.ms),
      },
      stage1: stage1ByChunk,
    };

    mkdirSync(RESULTS_DIR, { recursive: true });
    writeFileSync(join(RESULTS_DIR, `t2-07-comparison-reasoning-${Date.now()}.json`), JSON.stringify(record, null, 2));

    console.log(
      `[t2-07] s1 parseable=${s1Parseable}/6 ` +
        `A accepted=${resultA.summary.accepted} frozen=${resultA.summary.frozenRecovered}/4 ` +
        `B accepted=${resultB.summary.accepted} frozen=${resultB.summary.frozenRecovered}/4`,
    );

    expect(record.stage1.length).toBe(6);
    expect(existsSync(RESULTS_DIR)).toBe(true);
  });
});
