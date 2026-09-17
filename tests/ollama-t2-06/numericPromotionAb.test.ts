/**
 * T2-06 Deterministic Numeric Promotion A/B Experiment (controlled, PoC-ONLY).
 *
 * Frozen baseline: same PDF, same 6 AI-02 chunks, same model (qwen3:4b),
 * same Ollama endpoint/options, same T2-05 Stage-1 evidence-extraction prompt,
 * same T2-05 Stage-2 Evidence-ID reasoning prompt, same Stage-2 validator.
 * No repair. No prompt/model/chunking/config changes.
 *
 * Variant A (model-typed baseline): Stage-1 model typing trusted after exact
 *   validation — numbers[] -> kind "number", excerpts[] -> kind "span".
 * Variant B (deterministic numeric promotion): EXACT SAME Stage-1 raw model
 *   responses as Variant A (no second Stage-1 request); validated generic
 *   spans are examined locally and, under a conservative deterministic rule,
 *   promoted to kind "number" with exactText preserved verbatim.
 *
 * Live-call budget (enforced by assertion): 6 Stage-1 + 6 Stage-2(A) +
 *   6 Stage-2(B) = 18 Ollama calls. Exactly one run per variant, then STOP.
 *
 * Does NOT modify: production code, tests/ollama-t2-03/*,
 * tests/ollama-t2-04/*, tests/ollama-t2-05/*, package files, docs.
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

const POC_ENABLED = process.env.RUN_OLLAMA_T206 === "1";
const describeLive = POC_ENABLED ? describe : describe.skip;

const BENCHMARK_DOC_DIR = join(process.cwd(), "benchmark-docs");
const RESULTS_DIR = join(BENCHMARK_DOC_DIR, "results");
const REAL_PDF_PATH = join(BENCHMARK_DOC_DIR, "Economic_Growth_vs_Development_WB_Jharkhand.pdf");

const SCENARIO_TIMEOUT_MS = 30 * 60_000;

/* ------------------------------------------------------------------ */
/* Frozen T2-05 prompts (copied verbatim; MUST NOT be changed)         */
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
 * Stage-1 validation + Evidence Store construction (Variant A rule, same as T2-05).
 * `numbers[]` entries become kind "number"; `excerpts[]` entries become kind
 * "span" (model-typed split trusted, each side independently validated).
 * IDs assigned locally in validated output order; model never sees IDs.
 * NO deterministic numeric promotion is performed here.
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

/* ------------------------------------------------------------------ */
/* Variant B — conservative deterministic numeric promotion rule       */
/*                                                                     */
/* A validated generic span (kind "span") is promoted to kind "number" */
/* ONLY when ALL of the following hold (precision over recall):        */
/*                                                                     */
/* 1. The span's exactText contains EXACTLY ONE decimal-numeric token  */
/*    of the form <digits>.<digits> with an optional trailing "%"      */
/*    (e.g. "84.78%", "41.13"). Bare integers are NEVER promoted, so   */
/*    years, page numbers, section numbers, citation numbers and       */
/*    arbitrary alphanumeric identifiers cannot qualify.               */
/* 2. The token has clean boundaries: the character before is not a    */
/*    letter/digit and the character after (past an optional "%") is   */
/*    not a letter/digit, so version strings/identifiers are excluded. */
/* 3. The token is not structural numbering: it is not immediately     */
/*    preceded (<=14 chars back, same span) by section|figure|table|    */
/*    page|chapter|equation|appendix|reference|citation|volume|issue.   */
/* 4. A span with ZERO such tokens is not promoted (nothing numeric).  */
/* 5. A span with TWO OR MORE such tokens is not promoted: it cannot   */
/*    be deterministically represented as ONE number item, and no      */
/*    single number is manufactured.                                   */
/*                                                                     */
/* Promotion NEVER alters exactText; the numeric value is the token    */
/* copied verbatim from the source text (units preserved, no           */
/* normalization: 84.78% stays "84.78%", never 0.8478). The model      */
/* does not participate in promotion.                                  */
/* ------------------------------------------------------------------ */

const STRUCTURAL_PREFIX_RE = /(?:section|figure|table|page|chapter|equation|appendix|reference|citation|volume|issue)\s*[^a-z0-9]{0,3}$/i;

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9]/.test(char);
}

export function tryPromoteSpanToNumber(exactText: string): { value: string | null; reason: string } {
  const tokenRe = /\d+\.\d+\s?%/g;
  const found: Array<{ token: string; start: number; end: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(exactText)) !== null) {
    found.push({ token: match[0].trim(), start: match.index, end: match.index + match[0].length });
  }
  const remainder = exactText.replace(tokenRe, " ".repeat(1));
  const bareRe = /\d+\.\d+/g;
  while ((match = bareRe.exec(remainder)) !== null) {
    // Map back: find the same token text in the original at/after the remainder offset.
    const token = match[0];
    const start = exactText.indexOf(token, match.index);
    if (start === -1) {
      continue;
    }
    // Skip if this bare hit overlaps an already-found percent token.
    if (found.some((f) => start < f.end && start + token.length > f.start)) {
      continue;
    }
    found.push({ token, start, end: start + token.length });
  }
  if (found.length === 0) {
    return { value: null, reason: "no decimal numeric expression present; not promoted." };
  }
  // Boundary + structural-numbering checks apply per candidate.
  const clean = found.filter((f) => {
    const before = exactText[f.start - 1];
    const after = exactText[f.end];
    if (isWordChar(before) || isWordChar(after)) {
      return false;
    }
    const prefixWindow = exactText.slice(Math.max(0, f.start - 14), f.start);
    if (STRUCTURAL_PREFIX_RE.test(prefixWindow)) {
      return false;
    }
    return true;
  });
  if (clean.length === 0) {
    return { value: null, reason: "numeric token(s) fail boundary/structural checks (identifier or structural numbering); not promoted." };
  }
  if (found.length > 1 || clean.length > 1) {
    return { value: null, reason: `multiple independent numeric expressions (${found.length} found); cannot represent as one number item; not promoted.` };
  }
  return { value: clean[0].token, reason: `single decimal numeric expression "${clean[0].token}" with clean boundaries and no structural-numbering context; promoted.` };
}

export interface PromotionDecision {
  evidenceId: string;
  promoted: boolean;
  numericValue: string | null;
  reason: string;
  originalExactText: string;
}

/**
 * Build the Variant B Evidence Store from the SAME validated Variant A store.
 * Same IDs, same order, same exactText/chunk/page scope; promoted spans flip
 * kind "span" -> "number" and gain the verbatim numeric value.
 */
export function buildVariantBStore(storeA: EvidenceItem[]): { store: EvidenceItem[]; decisions: PromotionDecision[] } {
  const store: EvidenceItem[] = [];
  const decisions: PromotionDecision[] = [];
  for (const item of storeA) {
    if (item.kind !== "span") {
      store.push({ ...item });
      continue;
    }
    const attempt = tryPromoteSpanToNumber(item.exactText);
    decisions.push({
      evidenceId: item.evidenceId,
      promoted: attempt.value !== null,
      numericValue: attempt.value,
      reason: attempt.reason,
      originalExactText: item.exactText,
    });
    if (attempt.value !== null) {
      store.push({ ...item, kind: "number", value: attempt.value });
    } else {
      store.push({ ...item });
    }
  }
  return { store, decisions };
}

/* ------------------------------------------------------------------ */
/* Frozen T2-05 Stage-2 validator (copied verbatim)                    */
/* ------------------------------------------------------------------ */

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

export const EXPECTED_NUMBERS = ["84.78%", "72.13%", "82.26%", "61.11%", "41.13", "22.24", "11.89%", "28.81%"];
const EXPECTED_COMPARISONS: Array<{ alternatives: string[][] }> = [
  { alternatives: [["west bengal", "urban", "rural"]] },
  { alternatives: [["jharkhand", "urban", "rural"]] },
  { alternatives: [["gap", "jharkhand", "bengal"], ["gap", "jharkhand", "wb"]] },
  { alternatives: [["imr", "rural", "urban"], ["41.13", "22.24"]] },
];

function claimTextsOf(card: unknown): string[] {
  if (!isPlainObject(card) || !Array.isArray(card.claims)) {
    return [];
  }
  return (card.claims as unknown[]).filter(isPlainObject).map((e) => String((e as Record<string, unknown>).text ?? "").toLowerCase());
}

/** Grounded card numbers: value + evidenceId resolving to a store item with the same value. */
function groundedCardNumbers(card: unknown, store: Map<string, EvidenceItem>): string[] {
  if (!isPlainObject(card) || !Array.isArray(card.numbers)) {
    return [];
  }
  const out: string[] = [];
  for (const entry of card.numbers as unknown[]) {
    if (!isPlainObject(entry) || typeof entry.value !== "string" || typeof entry.evidenceId !== "string") {
      continue;
    }
    const item = store.get(entry.evidenceId);
    if (item && item.kind === "number" && item.value === entry.value) {
      out.push(entry.value);
    }
  }
  return out;
}

describeLive("Ollama T2-06 Numeric Promotion A/B (gated: RUN_OLLAMA_T206=1)", () => {
  const liveIt = it.skipIf(!existsSync(REAL_PDF_PATH));

  liveIt("shared stage-1 then stage-2 for variant A and variant B, no repair", { timeout: SCENARIO_TIMEOUT_MS }, async () => {
    const file = new File([readFileSync(REAL_PDF_PATH)], "Economic_Growth_vs_Development_WB_Jharkhand.pdf", {
      type: "application/pdf",
    });
    const context = await buildAiTextContext(file);
    expect(context.chunks.length).toBe(6);

    let stage1Calls = 0;
    let stage2ACalls = 0;
    let stage2BCalls = 0;

    /* ---- Shared Stage 1 (ONE run covering all 6 chunks) ---- */
    let s1Ms = 0;
    let s1Parseable = 0;
    let s1Malformed = 0;
    let s1ValidatedSpans = 0;
    let s1ValidatedNumbers = 0;
    let excerptAttempts = 0;
    let numberAttempts = 0;
    let numberValueExact = 0;

    interface ChunkStage1 {
      chunkIndex: number;
      pageNumber: number;
      chunkText: string;
      rawResponse: string;
      parseSuccess: boolean;
      usedFallback: boolean;
      balanced: boolean;
      truncated: boolean;
      excerptAttempts: number;
      numberAttempts: number;
      storeA: EvidenceItem[];
      reasons: string[];
      malformed: number;
      validatedSpans: number;
      validatedNumbers: number;
      generationMs: number;
      inputTokens: number | null;
      outputTokens: number | null;
    }
    const stage1ByChunk: ChunkStage1[] = [];

    for (const chunk of context.chunks) {
      const s1 = await postGenerate(
        `${buildStage1Prompt()}\n\n${DOCUMENT_CONTEXT_START}\n[page ${chunk.pageNumber}] ${chunk.text}\n${DOCUMENT_CONTEXT_END}`,
      );
      stage1Calls += 1;
      s1Ms += s1.ms;
      const s1Parsed = parseWithFallback(s1.data.response);
      let storeA: EvidenceItem[] = [];
      let reasons: string[] = [];
      let spans = 0;
      let numbers = 0;
      let malformed = 0;
      let exAttempts = 0;
      let numAttempts = 0;
      if (s1Parsed.parseSuccess) {
        s1Parseable += 1;
        if (isPlainObject(s1Parsed.parsed)) {
          if (Array.isArray(s1Parsed.parsed.excerpts)) {
            exAttempts = s1Parsed.parsed.excerpts.length;
          }
          if (Array.isArray(s1Parsed.parsed.numbers)) {
            numAttempts = s1Parsed.parsed.numbers.length;
            for (const entry of s1Parsed.parsed.numbers as unknown[]) {
              if (isPlainObject(entry) && typeof entry.value === "string" && chunk.text.includes(entry.value)) {
                numberValueExact += 1;
              }
            }
          }
        }
        const built = buildEvidenceStore(s1Parsed.parsed, chunk.text, chunk.chunkIndex, chunk.pageNumber);
        storeA = built.store;
        spans = built.validatedSpans;
        numbers = built.validatedNumbers;
        malformed = built.malformed;
        reasons = built.reasons;
      } else {
        malformed = 1;
        reasons = ["Stage-1 output unparseable."];
      }
      excerptAttempts += exAttempts;
      numberAttempts += numAttempts;
      s1Malformed += malformed;
      s1ValidatedSpans += spans;
      s1ValidatedNumbers += numbers;
      stage1ByChunk.push({
        chunkIndex: chunk.chunkIndex,
        pageNumber: chunk.pageNumber,
        chunkText: chunk.text,
        rawResponse: s1.data.response,
        parseSuccess: s1Parsed.parseSuccess,
        usedFallback: s1Parsed.usedFallback,
        balanced: s1Parsed.balanced,
        truncated: s1Parsed.truncated,
        excerptAttempts: exAttempts,
        numberAttempts: numAttempts,
        storeA,
        reasons,
        malformed,
        validatedSpans: spans,
        validatedNumbers: numbers,
        generationMs: Math.round(s1.ms),
        inputTokens: s1.data.prompt_eval_count ?? null,
        outputTokens: s1.data.eval_count ?? null,
      });
    }

    /* ---- Variant B stores from the SAME validated Stage-1 evidence ---- */
    const storeBByChunk = stage1ByChunk.map((c) => buildVariantBStore(c.storeA));
    const allDecisions = storeBByChunk.flatMap((b, i) =>
      b.decisions.map((d) => ({ chunkIndex: stage1ByChunk[i].chunkIndex, ...d })),
    );
    const spansExamined = allDecisions.length;
    const spansPromoted = allDecisions.filter((d) => d.promoted).length;

    /* ---- Stage-2 runner (identical prompt/input shape for both variants) ---- */
    async function runStage2(
      store: EvidenceItem[],
      chunkIndex: number,
      pageNumber: number,
    ): Promise<{
      rawResponse: string;
      parseSuccess: boolean;
      usedFallback: boolean;
      balanced: boolean;
      truncated: boolean;
      accepted: boolean;
      schemaValid: boolean;
      reasons: string[];
      inventedIds: string[];
      leakageHits: string[];
      parsed: unknown;
      generationMs: number;
      inputTokens: number | null;
      outputTokens: number | null;
    }> {
      const stage2Input = {
        chunkIndex,
        sourcePages: [pageNumber],
        evidence: store,
        task: "Create a Fact Card grounded only in the supplied evidence.",
      };
      const s2 = await postGenerate(`${buildStage2Prompt(chunkIndex, pageNumber)}\n\n${JSON.stringify(stage2Input)}`);
      const s2Parsed = parseWithFallback(s2.data.response);
      let reasons: string[] = [];
      let invented: string[] = [];
      let leakage: string[] = [];
      let accepted = false;
      let schemaValid = false;
      if (s2Parsed.parseSuccess) {
        const storeMap = new Map(store.map((item) => [item.evidenceId, item]));
        const verdict = validateStage2Card(s2Parsed.parsed, storeMap, chunkIndex, [pageNumber]);
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
      return {
        rawResponse: s2.data.response,
        parseSuccess: s2Parsed.parseSuccess,
        usedFallback: s2Parsed.usedFallback,
        balanced: s2Parsed.balanced,
        truncated: s2Parsed.truncated,
        accepted,
        schemaValid,
        reasons,
        inventedIds: invented,
        leakageHits: leakage,
        parsed: s2Parsed.parsed,
        generationMs: Math.round(s2.ms),
        inputTokens: s2.data.prompt_eval_count ?? null,
        outputTokens: s2.data.eval_count ?? null,
      };
    }

    interface ChunkVariantResult {
      chunkIndex: number;
      store: EvidenceItem[];
      rawResponse: string;
      parseSuccess: boolean;
      schemaValid: boolean;
      accepted: boolean;
      reasons: string[];
      inventedIds: string[];
      leakageHits: string[];
      truncated: boolean;
      generationMs: number;
      expectedNumbersPresent: string[];
      expectedNumbersTyped: string[];
      recoveredNumbers: string[];
      recoveredComparisons: boolean[];
    }

    async function runVariant(
      stores: EvidenceItem[][],
      onCall: () => void,
    ): Promise<{ chunks: ChunkVariantResult[]; ms: number }> {
      const chunks: ChunkVariantResult[] = [];
      let ms = 0;
      for (let i = 0; i < stage1ByChunk.length; i++) {
        const base = stage1ByChunk[i];
        const store = stores[i];
        const started = performance.now();
        const r = await runStage2(store, base.chunkIndex, base.pageNumber);
        onCall();
        ms += performance.now() - started;
        const storeMap = new Map(store.map((item) => [item.evidenceId, item]));
        const expectedNumbersPresent = EXPECTED_NUMBERS.filter((n) => base.chunkText.includes(n));
        const expectedNumbersTyped = EXPECTED_NUMBERS.filter((n) =>
          store.some((e) => e.kind === "number" && e.value === n),
        );
        let recoveredNumbers: string[] = [];
        let recoveredComparisons: boolean[] = EXPECTED_COMPARISONS.map(() => false);
        if (r.accepted) {
          const grounded = groundedCardNumbers(r.parsed, storeMap);
          recoveredNumbers = expectedNumbersPresent.filter((n) => grounded.includes(n));
          const texts = claimTextsOf(r.parsed);
          recoveredComparisons = EXPECTED_COMPARISONS.map((c) =>
            c.alternatives.some((tokens) => texts.some((t) => tokens.every((tok) => t.includes(tok)))),
          );
        }
        chunks.push({
          chunkIndex: base.chunkIndex,
          store,
          rawResponse: r.rawResponse,
          parseSuccess: r.parseSuccess,
          schemaValid: r.schemaValid,
          accepted: r.accepted,
          reasons: r.reasons,
          inventedIds: r.inventedIds,
          leakageHits: r.leakageHits,
          truncated: r.truncated,
          generationMs: r.generationMs,
          expectedNumbersPresent,
          expectedNumbersTyped,
          recoveredNumbers,
          recoveredComparisons,
        });
      }
      return { chunks, ms };
    }

    // ONE Stage-2 run for Variant A, then ONE Stage-2 run for Variant B.
    const variantA = await runVariant(
      stage1ByChunk.map((c) => c.storeA),
      () => {
        stage2ACalls += 1;
      },
    );
    const variantB = await runVariant(
      storeBByChunk.map((b) => b.store),
      () => {
        stage2BCalls += 1;
      },
    );

    /* ---- Live-call budget enforcement ---- */
    expect(stage1Calls).toBe(6);
    expect(stage2ACalls).toBe(6);
    expect(stage2BCalls).toBe(6);

    /* ---- Aggregation ---- */
    function summarizeVariant(chunks: ChunkVariantResult[]): Record<string, unknown> {
      const reasons = chunks.flatMap((c) => c.reasons);
      const countRe = (re: RegExp): number => reasons.filter((r) => re.test(r)).length;
      const typed = new Set(chunks.flatMap((c) => c.expectedNumbersTyped));
      const presentInSource = new Set(chunks.flatMap((c) => c.expectedNumbersPresent));
      const recovered = new Set(chunks.flatMap((c) => c.recoveredNumbers));
      const typedAndPresent = [...typed].filter((n) => presentInSource.has(n));
      return {
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
        comparisonFailures: countRe(/comparison|at least 2 distinct/),
        causalFailures: countRe(/causal/),
        pageFailures: countRe(/pages must be|sourcePages must match/),
        truncations: chunks.filter((c) => c.truncated).length,
        expectedPresentInSource: [...presentInSource],
        expectedTyped: typedAndPresent,
        expectedRecovered: [...recovered],
        expectedNotRecovered: [...presentInSource].filter((n) => !recovered.has(n)),
        numericRecall:
          presentInSource.size === 0 ? null : typedAndPresent.length / presentInSource.size,
        recoveryRate: typedAndPresent.length === 0 ? null : recovered.size / typedAndPresent.length,
        comparisonsRecovered: EXPECTED_COMPARISONS.map(
          (_, i) => chunks.filter((c) => c.recoveredComparisons[i]).length,
        ),
      };
    }

    const summaryA = summarizeVariant(variantA.chunks);
    const summaryB = summarizeVariant(variantB.chunks);

    const promotedValues = allDecisions.filter((d) => d.promoted).map((d) => d.numericValue);
    const incorrectPromotions = allDecisions.filter((d) => {
      if (!d.promoted || d.numericValue === null) {
        return false;
      }
      const chunk = stage1ByChunk.find((c) => c.chunkIndex === d.chunkIndex);
      return !chunk || !chunk.chunkText.includes(d.numericValue) || !d.originalExactText.includes(d.numericValue);
    });
    const nonExpectedPromotions = allDecisions.filter(
      (d) => d.promoted && d.numericValue !== null && !EXPECTED_NUMBERS.includes(d.numericValue),
    );

    const record = {
      timestamp: new Date().toISOString(),
      scenario: "t2-06-numeric-promotion-ab",
      model: OLLAMA_MODEL,
      endpoint: OLLAMA_BASE_URL,
      document: "Economic_Growth_vs_Development_WB_Jharkhand.pdf",
      budgets: { numPredict: 2048, temperature: 0, think: false, stream: false, format: "json", numCtx: "not specified" },
      frozen: {
        chunks: 6,
        stage1Prompt: "t2-05 verbatim",
        stage2Prompt: "t2-05 verbatim",
        stage2Validator: "t2-05 verbatim",
        expectedNumbers: EXPECTED_NUMBERS,
        repair: false,
      },
      typingRules: {
        variantA: "model-typed split trusted per side with independent validation; no deterministic promotion applied",
        variantB:
          "same Stage-1 responses as A; validated spans with exactly one decimal token (<digits>.<digits>, optional %) and clean boundaries promoted locally; exactText preserved verbatim",
      },
      liveCalls: { stage1: stage1Calls, stage2A: stage2ACalls, stage2B: stage2BCalls },
      stage1Shared: {
        chunks: 6,
        parseable: s1Parseable,
        malformed: s1Malformed,
        validatedItems: s1ValidatedSpans + s1ValidatedNumbers,
        modelTypedSpans: s1ValidatedSpans,
        modelTypedNumbers: s1ValidatedNumbers,
        excerptAttempts,
        numberAttempts,
        exactExcerptRate: excerptAttempts === 0 ? null : s1ValidatedSpans / excerptAttempts,
        exactNumberValueRate: numberAttempts === 0 ? null : numberValueExact / numberAttempts,
        exactNumberExcerptRate: numberAttempts === 0 ? null : s1ValidatedNumbers / numberAttempts,
        runtimeMs: Math.round(s1Ms),
      },
      promotion: {
        spansExamined,
        spansPromoted,
        spansNotPromoted: spansExamined - spansPromoted,
        promotionPct: spansExamined === 0 ? null : (100 * spansPromoted) / spansExamined,
        promotedValues,
        incorrectPromotions,
        nonExpectedPromotions,
        decisions: allDecisions,
      },
      variantA: { ...summaryA, runtimeMs: Math.round(variantA.ms), chunksDetail: variantA.chunks },
      variantB: { ...summaryB, runtimeMs: Math.round(variantB.ms), chunksDetail: variantB.chunks },
      runtime: {
        stage1SharedMs: Math.round(s1Ms),
        stage2AMs: Math.round(variantA.ms),
        stage2BMs: Math.round(variantB.ms),
        totalMs: Math.round(s1Ms + variantA.ms + variantB.ms),
      },
      stage1: stage1ByChunk,
    };

    mkdirSync(RESULTS_DIR, { recursive: true });
    writeFileSync(join(RESULTS_DIR, `t2-06-numeric-promotion-ab-${Date.now()}.json`), JSON.stringify(record, null, 2));

    console.log(
      `[t2-06] s1 parseable=${s1Parseable}/6 items=${s1ValidatedSpans + s1ValidatedNumbers} ` +
        `promoted=${spansPromoted}/${spansExamined} ` +
        `A accepted=${summaryA.accepted} B accepted=${summaryB.accepted}`,
    );

    expect(record.stage1.length).toBe(6);
    expect(existsSync(RESULTS_DIR)).toBe(true);
  });
});
