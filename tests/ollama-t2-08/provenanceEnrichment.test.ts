/**
 * T2-08 Evidence Attribution / Provenance Enrichment Experiment (controlled, PoC-ONLY).
 *
 * Hypothesis: compact deterministic/local provenance enrichment of already
 * validated Evidence Store items improves comparison reasoning without a
 * long Stage-2 prompt (T2-07's appendix failed and caused truncation).
 *
 * Fairness: ONE shared Stage-1 run (6 calls, T2-06 Variant-A/model-typed
 * construction, NO numeric promotion). Variant A Stage-2 receives the bare
 * store; Variant B Stage-2 receives the byte-identical store PLUS a compact
 * deterministic `provenance` field. Same frozen Stage-2 prompt for BOTH
 * variants (no comparison appendix). Total: 18 Ollama calls, no repair.
 *
 * Provenance rule (conservative, local, value-blind): for each validated
 * item, inspect a ±250-char window around its exactText occurrence in the
 * SOURCE CHUNK TEXT for entity/domain/subgroup cue words. Assign a label
 * ONLY when exactly one candidate's cues appear; otherwise "unknown".
 * Numeric values are NEVER consulted (a value equal to a frozen expected
 * answer with no contextual cues stays fully unknown). Unknown beats wrong.
 *
 * Adjudication: T2-07 deterministic A-D logic reused, extended with
 * criterion B2 (provenance support: no conflicting known labels on cited
 * items + at least one supporting known label). Strict "correct" requires
 * sufficiency + quantities + provenance + direction + arithmetic.
 *
 * The non-gated `describe` blocks below are pure offline unit checks
 * (enrichment + adjudication); the gated block is the single live run.
 *
 * Does NOT modify: production code, tests/ollama-t2-03/*,
 * tests/ollama-t2-04/*, tests/ollama-t2-05/*, tests/ollama-t2-06/*,
 * tests/ollama-t2-07/*, package files, docs.
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

const POC_ENABLED = process.env.RUN_OLLAMA_T208 === "1";
const describeLive = POC_ENABLED ? describe : describe.skip;

const BENCHMARK_DOC_DIR = join(process.cwd(), "benchmark-docs");
const RESULTS_DIR = join(BENCHMARK_DOC_DIR, "results");
const REAL_PDF_PATH = join(BENCHMARK_DOC_DIR, "Economic_Growth_vs_Development_WB_Jharkhand.pdf");

const SCENARIO_TIMEOUT_MS = 30 * 60_000;

/* ------------------------------------------------------------------ */
/* Frozen T2-05 prompts / helpers (copied verbatim; MUST NOT change)   */
/* ------------------------------------------------------------------ */

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

/** Frozen T2-05/T2-06/T2-07-Variant-A Stage-2 prompt — used for BOTH T2-08 variants. */
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

/** Stage-1 validation + store construction (T2-06 Variant A rule; no promotion). */
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

/** Frozen Stage-2 validator (T2-05/T2-06/T2-07). Extra input fields (provenance) are ignored by design. */
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
/* Deterministic conservative provenance enrichment (Variant B only)   */
/*                                                                     */
/* Value-blind: item.value is never read. Only a ±250-char window of   */
/* source chunk text around the exactText occurrence is scanned for    */
/* cue words. A dimension is labeled only when exactly one candidate's */
/* cues occur in the window; otherwise "unknown".                      */
/* ------------------------------------------------------------------ */

export type ProvenanceEntity = "West Bengal" | "Jharkhand" | "unknown";
export type ProvenanceDomain = "literacy" | "IMR" | "MPI" | "GSDP" | "unknown";
export type ProvenanceSubgroup = "urban" | "rural" | "overall" | "unknown";

export interface Provenance {
  entity: ProvenanceEntity;
  domain: ProvenanceDomain;
  subgroup: ProvenanceSubgroup;
  comparisonSide: ProvenanceSubgroup;
}

export interface EnrichedEvidenceItem extends EvidenceItem {
  provenance: Provenance;
}

export interface ProvenanceDecision {
  evidenceId: string;
  provenance: Provenance;
  windowSnippet: string;
  entityCues: string[];
  domainCues: string[];
  subgroupCues: string[];
  refused: string[];
}

export const PROVENANCE_WINDOW_CHARS = 250;

const ENTITY_CUES: Array<{ label: ProvenanceEntity; patterns: RegExp[]; names: string[] }> = [
  { label: "West Bengal", patterns: [/\bwest bengal\b/i, /\bbengal\b/i, /\bwb\b/i], names: ["west bengal", "bengal", "wb"] },
  { label: "Jharkhand", patterns: [/\bjharkhand\b/i], names: ["jharkhand"] },
];

const DOMAIN_CUES: Array<{ label: ProvenanceDomain; patterns: RegExp[]; names: string[] }> = [
  { label: "literacy", patterns: [/literacy/i, /literate/i], names: ["literacy", "literate"] },
  { label: "IMR", patterns: [/\bimr\b/i, /infant mortality/i], names: ["imr", "infant mortality"] },
  { label: "MPI", patterns: [/\bmpi\b/i, /multidimensional/i], names: ["mpi", "multidimensional"] },
  { label: "GSDP", patterns: [/\bgsdp\b/i], names: ["gsdp"] },
];

function matchedCueNames(windowText: string, patterns: RegExp[], names: string[]): string[] {
  const out: string[] = [];
  patterns.forEach((re, i) => {
    re.lastIndex = 0;
    if (re.test(windowText) && !out.includes(names[i])) {
      out.push(names[i]);
    }
  });
  return out;
}

/** Pure, deterministic, value-blind provenance assignment for one item. */
export function enrichOneItem(item: EvidenceItem, chunkText: string): ProvenanceDecision {
  const at = chunkText.indexOf(item.exactText);
  const windowText =
    at === -1
      ? ""
      : chunkText.slice(Math.max(0, at - PROVENANCE_WINDOW_CHARS), at + item.exactText.length + PROVENANCE_WINDOW_CHARS);
  const windowSnippet = windowText.length > 200 ? `${windowText.slice(0, 200)}…` : windowText;

  const entityHits = ENTITY_CUES.map((c) => ({ label: c.label, cues: matchedCueNames(windowText, c.patterns, c.names) }))
    .filter((h) => h.cues.length > 0);
  const domainHits = DOMAIN_CUES.map((c) => ({ label: c.label, cues: matchedCueNames(windowText, c.patterns, c.names) }))
    .filter((h) => h.cues.length > 0);
  const urbanCues = matchedCueNames(windowText, [/\burban\b/i], ["urban"]);
  const ruralCues = matchedCueNames(windowText, [/\brural\b/i], ["rural"]);
  const overallCues = matchedCueNames(windowText, [/\boverall\b/i, /\btotal\b/i], ["overall", "total"]);

  const refused: string[] = [];
  let entity: ProvenanceEntity = "unknown";
  if (entityHits.length === 1) {
    entity = entityHits[0].label;
  } else if (entityHits.length > 1) {
    refused.push(`entity ambiguous (${entityHits.map((h) => h.label).join(" vs ")})`);
  } else {
    refused.push("entity: no cues in window");
  }

  let domain: ProvenanceDomain = "unknown";
  if (domainHits.length === 1) {
    domain = domainHits[0].label;
  } else if (domainHits.length > 1) {
    refused.push(`domain ambiguous (${domainHits.map((h) => h.label).join(" vs ")})`);
  } else {
    refused.push("domain: no cues in window");
  }

  let subgroup: ProvenanceSubgroup = "unknown";
  if (urbanCues.length > 0 && ruralCues.length === 0) {
    subgroup = "urban";
  } else if (ruralCues.length > 0 && urbanCues.length === 0) {
    subgroup = "rural";
  } else if (urbanCues.length === 0 && ruralCues.length === 0 && overallCues.length > 0) {
    subgroup = "overall";
  } else if (urbanCues.length > 0 && ruralCues.length > 0) {
    refused.push("subgroup ambiguous (urban vs rural)");
  } else {
    refused.push("subgroup: no cues in window");
  }

  return {
    evidenceId: item.evidenceId,
    provenance: { entity, domain, subgroup, comparisonSide: subgroup },
    windowSnippet,
    entityCues: entityHits.flatMap((h) => h.cues),
    domainCues: domainHits.flatMap((h) => h.cues),
    subgroupCues: [...urbanCues, ...ruralCues, ...overallCues],
    refused,
  };
}

/** Enrich a whole validated store. Never alters exactText/kind/value/ids. */
export function enrichStoreWithProvenance(
  store: EvidenceItem[],
  chunkText: string,
): { items: EnrichedEvidenceItem[]; decisions: ProvenanceDecision[] } {
  const items: EnrichedEvidenceItem[] = [];
  const decisions: ProvenanceDecision[] = [];
  for (const item of store) {
    const decision = enrichOneItem(item, chunkText);
    decisions.push(decision);
    items.push({ ...item, provenance: decision.provenance });
  }
  return { items, decisions };
}

/* ------------------------------------------------------------------ */
/* Frozen comparisons + deterministic A-D adjudication (T2-07 logic,   */
/* extended with B2 provenance-support criterion for Variant B)        */
/* ------------------------------------------------------------------ */

export interface FrozenComparison {
  id: string;
  label: string;
  signature: string[][];
  higherValue: string;
  lowerValue: string;
  higherSideAlts: string[];
  lowerSideAlts: string[];
  expectedEntity: Array<"West Bengal" | "Jharkhand">;
  expectedDomain: "literacy" | "IMR";
  /** Expected (entity, subgroup) per side for provenance cross-check. */
  higherSideProv: { entity: string; subgroup: string };
  lowerSideProv: { entity: string; subgroup: string };
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
    expectedEntity: ["West Bengal"],
    expectedDomain: "literacy",
    higherSideProv: { entity: "West Bengal", subgroup: "urban" },
    lowerSideProv: { entity: "West Bengal", subgroup: "rural" },
  },
  {
    id: "jh-literacy",
    label: "Jharkhand urban literacy > Jharkhand rural literacy",
    signature: [["jharkhand"], ["urban"], ["rural"], ["literacy", "literate"]],
    higherValue: "82.26%",
    lowerValue: "61.11%",
    higherSideAlts: ["urban"],
    lowerSideAlts: ["rural"],
    expectedEntity: ["Jharkhand"],
    expectedDomain: "literacy",
    higherSideProv: { entity: "Jharkhand", subgroup: "urban" },
    lowerSideProv: { entity: "Jharkhand", subgroup: "rural" },
  },
  {
    id: "literacy-gap",
    label: "Jharkhand literacy gap > WB literacy gap",
    signature: [["jharkhand"], ["west bengal", "wb", "bengal"], ["gap", "disparity", "difference", "disparities"]],
    higherValue: "21.15",
    lowerValue: "12.65",
    higherSideAlts: ["jharkhand"],
    lowerSideAlts: ["west bengal", "wb", "bengal"],
    expectedEntity: ["West Bengal", "Jharkhand"],
    expectedDomain: "literacy",
    higherSideProv: { entity: "Jharkhand", subgroup: "unknown" },
    lowerSideProv: { entity: "West Bengal", subgroup: "unknown" },
  },
  {
    id: "jh-imr",
    label: "Jharkhand rural IMR > Jharkhand urban IMR",
    signature: [["jharkhand", "imr", "infant", "mortality"], ["rural"], ["urban"], ["imr", "infant", "mortality"]],
    higherValue: "41.13",
    lowerValue: "22.24",
    higherSideAlts: ["rural"],
    lowerSideAlts: ["urban"],
    expectedEntity: ["Jharkhand"],
    expectedDomain: "IMR",
    higherSideProv: { entity: "Jharkhand", subgroup: "rural" },
    lowerSideProv: { entity: "Jharkhand", subgroup: "urban" },
  },
];

export const LOCAL_GAP_ARITHMETIC = {
  jharkhandGap: 82.26 - 61.11,
  wbGap: 84.78 - 72.13,
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

export interface CitedResolution {
  distinctValidIds: string[];
  citedItems: EvidenceItem[];
  inventedIds: string[];
}

export function resolveCitedIds(
  claim: ComparisonClaimView,
  storesByChunk: Map<number, Map<string, EvidenceItem>>,
): CitedResolution {
  const store = storesByChunk.get(claim.chunkIndex) ?? new Map<string, EvidenceItem>();
  const distinctValidIds = [...new Set(claim.evidenceIds)].filter((id) => {
    const item = store.get(id);
    return item !== undefined && item.chunkIndex === claim.chunkIndex;
  });
  return {
    distinctValidIds,
    citedItems: distinctValidIds
      .map((id) => store.get(id))
      .filter((item): item is EvidenceItem => item !== undefined),
    inventedIds: claim.evidenceIds.filter((id) => !store.has(id)),
  };
}

/** Quantity-pair check (criterion A2/C): cited items contain both expected values. */
export function checkQuantityPair(spec: FrozenComparison, citedItems: EvidenceItem[]): boolean {
  if (spec.id === "literacy-gap") {
    const jhValues = ["82.26%", "82.26", "61.11"];
    const wbValues = ["84.78%", "84.78", "72.13"];
    return (
      citedItems.some((item) => jhValues.some((v) => itemContainsValue(item, v))) &&
      citedItems.some((item) => wbValues.some((v) => itemContainsValue(item, v)))
    );
  }
  return (
    citedItems.some((item) => itemContainsValue(item, spec.higherValue)) &&
    citedItems.some((item) => itemContainsValue(item, spec.lowerValue))
  );
}

export interface ProvenanceSupport {
  ok: boolean;
  conflicts: string[];
  supports: string[];
  detail: string;
}

/**
 * Criterion B2 (Variant B only): cited items' KNOWN provenance labels must
 * not conflict with the comparison's expected entity/domain/side mapping,
 * and at least one cited item must carry a supporting known label.
 * "unknown" never conflicts and never supports.
 */
export function checkProvenanceSupport(spec: FrozenComparison, citedItems: EvidenceItem[]): ProvenanceSupport {
  const conflicts: string[] = [];
  const supports: string[] = [];
  const expectedSideLabels = [spec.higherSideProv, spec.lowerSideProv];
  for (const item of citedItems) {
    const prov = (item as EnrichedEvidenceItem).provenance;
    if (!prov) {
      continue;
    }
    if (prov.entity !== "unknown" && !(spec.expectedEntity as string[]).includes(prov.entity)) {
      conflicts.push(`${item.evidenceId}: entity ${prov.entity} not in [${spec.expectedEntity.join(", ")}]`);
      continue;
    }
    if (prov.domain !== "unknown" && prov.domain !== spec.expectedDomain) {
      conflicts.push(`${item.evidenceId}: domain ${prov.domain} !== ${spec.expectedDomain}`);
      continue;
    }
    if (prov.subgroup !== "unknown" && !expectedSideLabels.some((s) => s.subgroup === "unknown" || s.subgroup === prov.subgroup)) {
      conflicts.push(`${item.evidenceId}: subgroup ${prov.subgroup} matches neither comparison side`);
      continue;
    }
    const sideHit = expectedSideLabels.some(
      (s) =>
        (s.entity === "unknown" || s.entity === prov.entity || prov.entity === "unknown") &&
        (s.subgroup === "unknown" || s.subgroup === prov.subgroup || prov.subgroup === "unknown"),
    );
    const entityHit = prov.entity !== "unknown" && (spec.expectedEntity as string[]).includes(prov.entity);
    const domainHit = prov.domain !== "unknown" && prov.domain === spec.expectedDomain;
    if (sideHit && (entityHit || domainHit)) {
      supports.push(`${item.evidenceId}: supports ${prov.entity}/${prov.domain}/${prov.subgroup}`);
    }
  }
  if (conflicts.length > 0) {
    return { ok: false, conflicts, supports, detail: `${conflicts.length} conflicting provenance label(s).` };
  }
  if (supports.length === 0) {
    return { ok: false, conflicts, supports, detail: "no supporting known provenance label on cited items." };
  }
  return { ok: true, conflicts, supports, detail: `${supports.length} supporting label(s), no conflicts.` };
}

function claimedGapNumbers(text: string): number[] {
  const out: number[] = [];
  const re = /\d+\.\d+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push(Number(m[0]));
  }
  return out;
}

export interface ComparisonVerdict {
  comparisonId: string;
  status: "correct" | "incorrect" | "missing";
  emitted: boolean;
  idsSufficient: boolean;
  quantitiesCorrect: boolean;
  provenanceCorrect: boolean | null;
  directionCorrect: boolean;
  arithmeticCorrect: boolean | null;
  directionDetail: string;
  provenanceDetail: string | null;
  bestClaim: ComparisonClaimView | null;
  gapArithmeticOk: boolean | null;
}

/**
 * Strict adjudication. Variant A: provenanceCorrect=null (no labels;
 * strict-correct falls back to quantities). Variant B: provenance via B2.
 * Gap arithmetic is verified locally; a claimed gap number disagreeing
 * with the locally computed gap fails arithmetic.
 */
export function adjudicateComparison(
  spec: FrozenComparison,
  claims: ComparisonClaimView[],
  storesByChunk: Map<number, Map<string, EvidenceItem>>,
  useProvenance: boolean,
): ComparisonVerdict {
  const matching = claims.filter((c) => signatureMatches(c.text, spec));
  const gapOkLocal = LOCAL_GAP_ARITHMETIC.jharkhandGap > LOCAL_GAP_ARITHMETIC.wbGap;
  if (matching.length === 0) {
    return {
      comparisonId: spec.id,
      status: "missing",
      emitted: false,
      idsSufficient: false,
      quantitiesCorrect: false,
      provenanceCorrect: useProvenance ? false : null,
      directionCorrect: false,
      arithmeticCorrect: spec.id === "literacy-gap" ? gapOkLocal : null,
      directionDetail: "no signature-matching comparison claim emitted.",
      provenanceDetail: useProvenance ? "no claim to evaluate." : null,
      bestClaim: null,
      gapArithmeticOk: spec.id === "literacy-gap" ? gapOkLocal : null,
    };
  }
  let best: ComparisonVerdict | null = null;
  for (const claim of matching) {
    const resolved = resolveCitedIds(claim, storesByChunk);
    const idsOk = resolved.distinctValidIds.length >= 2;
    const quantOk = checkQuantityPair(spec, resolved.citedItems);
    const dir = checkDirection(claim.text, spec);
    let arithOk: boolean | null = null;
    if (spec.id === "literacy-gap") {
      const nums = claimedGapNumbers(claim.text);
      // Any claimed gap-sized number must match a locally computed gap (±0.01).
      const gapTargets = [LOCAL_GAP_ARITHMETIC.jharkhandGap, LOCAL_GAP_ARITHMETIC.wbGap];
      const gapSized = nums.filter((n) => n > 5 && n < 40);
      arithOk = gapOkLocal && gapSized.every((n) => gapTargets.some((g) => Math.abs(g - n) < 0.011));
      if (gapSized.length === 0) {
        arithOk = gapOkLocal; // relational claim without numbers: arithmetic locally holds
      }
    }
    const prov = useProvenance ? checkProvenanceSupport(spec, resolved.citedItems) : null;
    const provOk = prov ? prov.ok : null;
    const strictOk =
      idsOk && quantOk && dir.ok && (arithOk ?? true) && (useProvenance ? provOk === true : true);
    const verdict: ComparisonVerdict = {
      comparisonId: spec.id,
      status: strictOk ? "correct" : "incorrect",
      emitted: true,
      idsSufficient: idsOk,
      quantitiesCorrect: quantOk,
      provenanceCorrect: provOk,
      directionCorrect: dir.ok,
      arithmeticCorrect: arithOk,
      directionDetail: dir.detail,
      provenanceDetail: prov ? prov.detail : null,
      bestClaim: claim,
      gapArithmeticOk: spec.id === "literacy-gap" ? (arithOk ?? gapOkLocal) : null,
    };
    if (verdict.status === "correct") {
      return verdict;
    }
    if (!best) {
      best = verdict;
    } else {
      const score = (v: ComparisonVerdict): number =>
        (v.idsSufficient ? 1 : 0) +
        (v.quantitiesCorrect ? 1 : 0) +
        (v.provenanceCorrect === true ? 1 : 0) +
        (v.directionCorrect ? 1 : 0) +
        (v.arithmeticCorrect === true ? 1 : 0);
      if (score(verdict) > score(best)) {
        best = verdict;
      }
    }
  }
  return best as ComparisonVerdict;
}

/* ------------------------------------------------------------------ */
/* Offline unit checks (no Ollama): enrichment + adjudication logic    */
/* ------------------------------------------------------------------ */

describe("T2-08 offline: deterministic provenance enrichment", () => {
  const item = (id: string, exactText: string, value?: string): EvidenceItem => ({
    evidenceId: id,
    chunkIndex: 4,
    sourcePages: [5],
    exactText,
    kind: value === undefined ? "span" : "number",
    ...(value === undefined ? { unit: null } : { value, unit: null }),
  });

  it("labels entity/domain/subgroup when the window clearly establishes them", () => {
    const chunk = "West Bengal urban literacy stands at 84.78% according to Census 2011 figures.";
    const d = enrichOneItem(item("chunk-4-e1", "84.78%", "84.78%"), chunk);
    expect(d.provenance).toEqual({ entity: "West Bengal", domain: "literacy", subgroup: "urban", comparisonSide: "urban" });
  });

  it("never consults the numeric value: expected-looking value without cues stays unknown", () => {
    const chunk = "The figures are as follows: 84.78 and 72.13 respectively.";
    const d = enrichOneItem(item("chunk-9-e1", "84.78", "84.78"), chunk);
    expect(d.provenance.entity).toBe("unknown");
    expect(d.provenance.domain).toBe("unknown");
    expect(d.provenance.subgroup).toBe("unknown");
  });

  it("refuses entity when both states appear and refuses subgroup when urban+rural co-occur", () => {
    const chunk = "West Bengal and Jharkhand urban vs rural literacy gaps differ markedly.";
    const d = enrichOneItem(item("chunk-4-e2", "gap", undefined), chunk);
    expect(d.provenance.entity).toBe("unknown");
    expect(d.provenance.subgroup).toBe("unknown");
    expect(d.refused.length).toBeGreaterThan(0);
  });

  it("labels IMR rural Jharkhand and never mutates the item", () => {
    const chunk = "Jharkhand rural IMR was recorded at 41.13 in the survey round.";
    const src = item("chunk-2-e1", "41.13", "41.13");
    const before = JSON.stringify(src);
    const d = enrichOneItem(src, chunk);
    expect(d.provenance).toEqual({ entity: "Jharkhand", domain: "IMR", subgroup: "rural", comparisonSide: "rural" });
    expect(JSON.stringify(src)).toBe(before);
  });

  it("enrichStoreWithProvenance preserves ids/order/exactText/kind/value", () => {
    const store = [item("chunk-4-e1", "84.78%", "84.78%"), item("chunk-4-e0", "Some context span", undefined)];
    const chunk = "West Bengal urban literacy stands at 84.78%. Some context span follows here.";
    const { items, decisions } = enrichStoreWithProvenance(store, chunk);
    expect(items.map((e) => e.evidenceId)).toEqual(store.map((s) => s.evidenceId));
    expect(items.map((e) => e.exactText)).toEqual(store.map((s) => s.exactText));
    expect(items.map((e) => e.kind)).toEqual(store.map((s) => s.kind));
    expect(decisions).toHaveLength(2);
  });
});

describe("T2-08 offline: deterministic adjudication", () => {
  it("local gap arithmetic holds (21.15 > 12.65)", () => {
    expect(LOCAL_GAP_ARITHMETIC.jharkhandGap).toBeCloseTo(21.15, 2);
    expect(LOCAL_GAP_ARITHMETIC.wbGap).toBeCloseTo(12.65, 2);
    expect(LOCAL_GAP_ARITHMETIC.jharkhandGap).toBeGreaterThan(LOCAL_GAP_ARITHMETIC.wbGap);
  });

  it("direction check accepts correct and rejects reversed literacy claims", () => {
    const spec = FROZEN_COMPARISONS[0];
    expect(checkDirection("Urban literacy is higher than rural literacy in the state.", spec).ok).toBe(true);
    expect(checkDirection("Rural literacy is higher than urban literacy in the state.", spec).ok).toBe(false);
    expect(checkDirection("Rural literacy is lower than urban literacy in the state.", spec).ok).toBe(true);
  });

  it("provenance B2 rejects conflicting labels and requires support", () => {
    const spec = FROZEN_COMPARISONS[0];
    const base: EvidenceItem = { evidenceId: "chunk-4-e1", chunkIndex: 4, sourcePages: [5], exactText: "84.78%", kind: "number", value: "84.78%", unit: null };
    const good = { ...base, provenance: { entity: "West Bengal", domain: "literacy", subgroup: "urban", comparisonSide: "urban" } } as EnrichedEvidenceItem;
    const bad = { ...base, evidenceId: "chunk-4-e9", provenance: { entity: "Jharkhand", domain: "literacy", subgroup: "urban", comparisonSide: "urban" } } as EnrichedEvidenceItem;
    const unk = { ...base, evidenceId: "chunk-4-e2", provenance: { entity: "unknown", domain: "unknown", subgroup: "unknown", comparisonSide: "unknown" } } as EnrichedEvidenceItem;
    expect(checkProvenanceSupport(spec, [good, unk]).ok).toBe(true);
    expect(checkProvenanceSupport(spec, [good, bad]).ok).toBe(false);
    expect(checkProvenanceSupport(spec, [unk]).ok).toBe(false);
  });

  it("gap arithmetic rejects fabricated gap numbers", () => {
    const spec = FROZEN_COMPARISONS[2];
    const mkStore = (): Map<number, Map<string, EvidenceItem>> => {
      const mk = (id: string, text: string, value?: string): EvidenceItem => ({
        evidenceId: id, chunkIndex: 4, sourcePages: [5], exactText: text,
        kind: value === undefined ? "span" : "number", value, unit: null,
      });
      const items = [
        mk("chunk-4-e6", "Urban literacy at 84.78% and rural at 72.13%.", undefined),
        mk("chunk-4-e8", "Urban literacy at 82.26% and rural at 61.11%.", undefined),
      ];
      return new Map([[4, new Map(items.map((e) => [e.evidenceId, e]))]]);
    };
    const stores = mkStore();
    const badClaim: ComparisonClaimView = {
      chunkIndex: 4, claimIndex: 0,
      text: "The Jharkhand literacy gap exceeds the West Bengal gap by 22.65 percentage points.",
      evidenceIds: ["chunk-4-e6", "chunk-4-e8"],
    };
    const v = adjudicateComparison(spec, [badClaim], stores, false);
    expect(v.emitted).toBe(true);
    expect(v.arithmeticCorrect).toBe(false);
    expect(v.status).toBe("incorrect");
  });
});

describeLive("Ollama T2-08 Provenance Enrichment (gated: RUN_OLLAMA_T208=1)", () => {
  const liveIt = it.skipIf(!existsSync(REAL_PDF_PATH));

  liveIt("shared stage-1, bare vs provenance-enriched stage-2, no repair", { timeout: SCENARIO_TIMEOUT_MS }, async () => {
    const file = new File([readFileSync(REAL_PDF_PATH)], "Economic_Growth_vs_Development_WB_Jharkhand.pdf", {
      type: "application/pdf",
    });
    const context = await buildAiTextContext(file);
    expect(context.chunks.length).toBe(6);

    let stage1Calls = 0;
    let stage2ACalls = 0;
    let stage2BCalls = 0;

    /* ---- Shared Stage 1 (ONE run, 6 calls) ---- */
    let s1Ms = 0;
    let s1Parseable = 0;
    let s1Balanced = 0;
    let s1Truncated = 0;
    let s1Fallback = 0;
    let s1Malformed = 0;
    let s1ValidatedSpans = 0;
    let s1ValidatedNumbers = 0;
    let excerptAttempts = 0;
    let numberAttempts = 0;
    let numberValueExact = 0;
    let numberExcerptExact = 0;

    interface ChunkStage1 {
      chunkIndex: number;
      pageNumber: number;
      chunkText: string;
      rawResponse: string;
      parseSuccess: boolean;
      balanced: boolean;
      truncated: boolean;
      usedFallback: boolean;
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
      if (s1Parsed.balanced) {
        s1Balanced += 1;
      }
      if (s1Parsed.truncated) {
        s1Truncated += 1;
      }
      if (s1Parsed.usedFallback) {
        s1Fallback += 1;
      }
      let store: EvidenceItem[] = [];
      let reasons: string[] = [];
      if (s1Parsed.parseSuccess) {
        s1Parseable += 1;
        if (isPlainObject(s1Parsed.parsed)) {
          if (Array.isArray(s1Parsed.parsed.excerpts)) {
            excerptAttempts += s1Parsed.parsed.excerpts.length;
          }
          if (Array.isArray(s1Parsed.parsed.numbers)) {
            const nums = s1Parsed.parsed.numbers as unknown[];
            numberAttempts += nums.length;
            for (const entry of nums) {
              if (isPlainObject(entry) && typeof entry.value === "string" && typeof entry.excerpt === "string") {
                if (chunk.text.includes(entry.value)) {
                  numberValueExact += 1;
                }
                if (chunk.text.includes(entry.excerpt) && entry.excerpt.includes(entry.value)) {
                  numberExcerptExact += 1;
                }
              }
            }
          }
        }
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
        balanced: s1Parsed.balanced,
        truncated: s1Parsed.truncated,
        usedFallback: s1Parsed.usedFallback,
        store,
        reasons,
        generationMs: Math.round(s1.ms),
      });
    }

    /* ---- Local provenance enrichment (Variant B input; no model involved) ---- */
    const enrichedByChunk = stage1ByChunk.map((c) => enrichStoreWithProvenance(c.store, c.chunkText));
    const allDecisions = enrichedByChunk.flatMap((e, i) =>
      e.decisions.map((d) => ({ chunkIndex: stage1ByChunk[i].chunkIndex, ...d })),
    );

    const baseStoresByChunk = new Map<number, Map<string, EvidenceItem>>(
      stage1ByChunk.map((c) => [c.chunkIndex, new Map(c.store.map((item) => [item.evidenceId, item]))]),
    );
    const enrichedStoresByChunk = new Map<number, Map<string, EnrichedEvidenceItem>>(
      enrichedByChunk.map((enriched, i) => [
        stage1ByChunk[i].chunkIndex,
        new Map(enriched.items.map((item) => [item.evidenceId, item])),
      ]),
    );

    /* ---- Stage-2 runner (SAME prompt both variants; evidence differs) ---- */
    interface ChunkStage2 {
      chunkIndex: number;
      evidenceSent: EvidenceItem[];
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
      evidenceFor: (chunkIndex: number) => EvidenceItem[],
      onCall: () => void,
    ): Promise<{ chunks: ChunkStage2[]; ms: number }> {
      const chunks: ChunkStage2[] = [];
      let ms = 0;
      for (const base of stage1ByChunk) {
        const evidence = evidenceFor(base.chunkIndex);
        const stage2Input = {
          chunkIndex: base.chunkIndex,
          sourcePages: [base.pageNumber],
          evidence,
          task: "Create a Fact Card grounded only in the supplied evidence.",
        };
        const started = performance.now();
        const s2 = await postGenerate(`${buildStage2PromptBase(base.chunkIndex, base.pageNumber)}\n\n${JSON.stringify(stage2Input)}`);
        onCall();
        ms += performance.now() - started;
        const s2Parsed = parseWithFallback(s2.data.response);
        let reasons: string[] = [];
        let invented: string[] = [];
        let leakage: string[] = [];
        let accepted = false;
        let schemaValid = false;
        if (s2Parsed.parseSuccess) {
          const storeMap = baseStoresByChunk.get(base.chunkIndex) as Map<string, EvidenceItem>;
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
          evidenceSent: evidence,
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

    const variantA = await runVariant(
      (ci) => stage1ByChunk.find((c) => c.chunkIndex === ci)?.store ?? [],
      () => {
        stage2ACalls += 1;
      },
    );
    const variantB = await runVariant(
      (ci) => enrichedByChunk[stage1ByChunk.findIndex((c) => c.chunkIndex === ci)]?.items ?? [],
      () => {
        stage2BCalls += 1;
      },
    );

    /* ---- Call-budget + fairness enforcement ---- */
    expect(stage1Calls).toBe(6);
    expect(stage2ACalls).toBe(6);
    expect(stage2BCalls).toBe(6);

    // Fairness: B evidence = A evidence + provenance ONLY.
    let fairnessOk = true;
    const fairnessViolations: string[] = [];
    for (let i = 0; i < stage1ByChunk.length; i++) {
      const a = variantA.chunks[i].evidenceSent;
      const b = variantB.chunks[i].evidenceSent as EnrichedEvidenceItem[];
      if (a.length !== b.length) {
        fairnessOk = false;
        fairnessViolations.push(`chunk ${a} length mismatch`);
        continue;
      }
      for (let j = 0; j < a.length; j++) {
        const { ...bRest } = b[j] as unknown as Record<string, unknown>;
        delete bRest.provenance;
        if (JSON.stringify(a[j]) !== JSON.stringify(bRest)) {
          fairnessOk = false;
          fairnessViolations.push(`chunk ${variantA.chunks[i].chunkIndex} item ${a[j].evidenceId} base-field mismatch`);
        }
        if (typeof b[j].exactText !== "string" || b[j].exactText !== a[j].exactText) {
          fairnessOk = false;
          fairnessViolations.push(`exactText altered for ${a[j].evidenceId}`);
        }
      }
    }
    expect(fairnessOk).toBe(true);

    /* ---- Aggregation ---- */
    function summarizeVariant(
      chunks: ChunkStage2[],
      useProvenance: boolean,
      storesByChunk: Map<number, Map<string, EvidenceItem>>,
    ): { summary: Record<string, unknown>; comparisonClaims: ComparisonClaimView[]; verdicts: ComparisonVerdict[] } {
      const reasons = chunks.flatMap((c) => c.reasons);
      const countRe = (re: RegExp): number => reasons.filter((r) => re.test(r)).length;
      const comparisonClaims = chunks.flatMap((c) =>
        c.parseSuccess ? extractComparisonClaims(c.parsed, c.chunkIndex) : [],
      );
      const verdicts = FROZEN_COMPARISONS.map((spec) => adjudicateComparison(spec, comparisonClaims, storesByChunk, useProvenance));

      let claimsWithGte2Ids = 0;
      let oneIdFailures = 0;
      let inventedInComparisons = 0;
      let comparisonWithLeakage = 0;
      for (const claim of comparisonClaims) {
        const resolved = resolveCitedIds(claim, storesByChunk);
        inventedInComparisons += resolved.inventedIds.length;
        if (resolved.distinctValidIds.length >= 2) {
          claimsWithGte2Ids += 1;
        } else {
          oneIdFailures += 1;
        }
        const leaks: string[] = [];
        findForbiddenKeys({ text: claim.text }, "$", leaks);
        if (leaks.length > 0) {
          comparisonWithLeakage += 1;
        }
      }

      const summary: Record<string, unknown> = {
        chunks: chunks.length,
        parseable: chunks.filter((c) => c.parseSuccess).length,
        schemaValid: chunks.filter((c) => c.schemaValid).length,
        accepted: chunks.filter((c) => c.accepted).length,
        rejected: chunks.filter((c) => !c.accepted).length,
        inventedIds: chunks.reduce((n, c) => n + c.inventedIds.length, 0),
        invalidIds: chunks.reduce((n, c) => n + c.inventedIds.length, 0) + countRe(/belongs to another chunk/),
        leakageHits: chunks.reduce((n, c) => n + c.leakageHits.length, 0),
        numericalFailures: countRe(/numbers\[\d+\]/),
        comparisonFailures: countRe(/comparison|at least 2 distinct/),
        causalFailures: countRe(/causal/),
        pageFailures: countRe(/pages must be|sourcePages must match/),
        truncations: chunks.filter((c) => c.truncated).length,
        rawChars: chunks.map((c) => ({ chunkIndex: c.chunkIndex, chars: c.rawChars })),
        comparisonEmitted: comparisonClaims.length,
        comparisonWithGte2Ids: claimsWithGte2Ids,
        oneIdFailures,
        inventedInComparisons,
        comparisonWithLeakage,
        frozenCorrect: verdicts.filter((v) => v.status === "correct").map((v) => v.comparisonId),
        frozenIncorrect: verdicts.filter((v) => v.status === "incorrect").map((v) => v.comparisonId),
        frozenMissing: verdicts.filter((v) => v.status === "missing").map((v) => v.comparisonId),
      };
      return { summary, comparisonClaims, verdicts };
    }

    const resultA = summarizeVariant(variantA.chunks, false, baseStoresByChunk);
    const resultB = summarizeVariant(variantB.chunks, true, enrichedStoresByChunk);

    const provMetrics = {
      totalExamined: allDecisions.length,
      withEntity: allDecisions.filter((d) => d.provenance.entity !== "unknown").length,
      withDomain: allDecisions.filter((d) => d.provenance.domain !== "unknown").length,
      withSubgroup: allDecisions.filter((d) => d.provenance.subgroup !== "unknown").length,
      withComparisonSide: allDecisions.filter((d) => d.provenance.comparisonSide !== "unknown").length,
      allFourKnown: allDecisions.filter(
        (d) =>
          d.provenance.entity !== "unknown" &&
          d.provenance.domain !== "unknown" &&
          d.provenance.subgroup !== "unknown",
      ).length,
      fullyUnknown: allDecisions.filter(
        (d) =>
          d.provenance.entity === "unknown" &&
          d.provenance.domain === "unknown" &&
          d.provenance.subgroup === "unknown",
      ).length,
      refusedCount: allDecisions.reduce((n, d) => n + d.refused.length, 0),
    };

    // Safety invariants.
    const s1ResponsesIdenticalNote = "single shared Stage-1 run by construction (6 calls)";
    const invariants = {
      inventedIdsZeroA: (resultA.summary.inventedIds as number) === 0,
      inventedIdsZeroB: (resultB.summary.inventedIds as number) === 0,
      leakageZeroA: (resultA.summary.leakageHits as number) === 0,
      leakageZeroB: (resultB.summary.leakageHits as number) === 0,
      fairnessBaseFieldsIdentical: fairnessOk,
      noRepair: true,
      noNumericPromotion: true,
      noRawChunkTextToStage2: true,
      stage1ResponsesShared: s1ResponsesIdenticalNote,
    };

    const record = {
      timestamp: new Date().toISOString(),
      scenario: "t2-08-provenance-enrichment",
      model: OLLAMA_MODEL,
      endpoint: OLLAMA_BASE_URL,
      document: "Economic_Growth_vs_Development_WB_Jharkhand.pdf",
      budgets: { numPredict: 2048, temperature: 0, think: false, stream: false, format: "json", numCtx: "not specified" },
      frozen: {
        chunks: 6,
        stage1Prompt: "t2-05 verbatim",
        stage2Prompt: "t2-05/t2-06/t2-07-A verbatim, BOTH variants (no comparison appendix)",
        stage2Validator: "t2-05/t2-06/t2-07 verbatim",
        evidenceTyping: "t2-06 variant A (model-typed; no numeric promotion)",
        provenanceRule: "value-blind ±250-char window cue search; single-candidate-or-unknown; unknown beats wrong",
        frozenComparisons: FROZEN_COMPARISONS.map((s) => ({ id: s.id, label: s.label })),
        localGapArithmetic: {
          jharkhandGap: LOCAL_GAP_ARITHMETIC.jharkhandGap,
          wbGap: LOCAL_GAP_ARITHMETIC.wbGap,
          jharkhandGapGreater: LOCAL_GAP_ARITHMETIC.jharkhandGap > LOCAL_GAP_ARITHMETIC.wbGap,
        },
        repair: false,
      },
      liveCalls: { stage1: stage1Calls, stage2A: stage2ACalls, stage2B: stage2BCalls },
      fairness: { baseFieldsIdentical: fairnessOk, violations: fairnessViolations },
      stage1Shared: {
        chunks: 6,
        parseable: s1Parseable,
        balanced: s1Balanced,
        truncated: s1Truncated,
        fallback: s1Fallback,
        malformed: s1Malformed,
        validatedItems: s1ValidatedSpans + s1ValidatedNumbers,
        spanCount: s1ValidatedSpans,
        numberCount: s1ValidatedNumbers,
        excerptAttempts,
        numberAttempts,
        exactExcerptFidelity: excerptAttempts === 0 ? null : s1ValidatedSpans / excerptAttempts,
        numberValueFidelity: numberAttempts === 0 ? null : numberValueExact / numberAttempts,
        numberExcerptFidelity: numberAttempts === 0 ? null : numberExcerptExact / numberAttempts,
        runtimeMs: Math.round(s1Ms),
      },
      provenance: { ...provMetrics, decisions: allDecisions },
      variantA: { ...resultA.summary, runtimeMs: Math.round(variantA.ms), verdicts: resultA.verdicts, comparisonClaims: resultA.comparisonClaims, chunksDetail: variantA.chunks },
      variantB: { ...resultB.summary, runtimeMs: Math.round(variantB.ms), verdicts: resultB.verdicts, comparisonClaims: resultB.comparisonClaims, chunksDetail: variantB.chunks },
      comparisonTable: FROZEN_COMPARISONS.map((spec) => ({
        id: spec.id,
        label: spec.label,
        variantA: resultA.verdicts.find((v) => v.comparisonId === spec.id),
        variantB: resultB.verdicts.find((v) => v.comparisonId === spec.id),
      })),
      invariants,
      runtime: {
        stage1SharedMs: Math.round(s1Ms),
        stage2AMs: Math.round(variantA.ms),
        stage2BMs: Math.round(variantB.ms),
        totalMs: Math.round(s1Ms + variantA.ms + variantB.ms),
      },
      stage1: stage1ByChunk,
    };

    mkdirSync(RESULTS_DIR, { recursive: true });
    writeFileSync(join(RESULTS_DIR, `t2-08-provenance-enrichment-${Date.now()}.json`), JSON.stringify(record, null, 2));

    console.log(
      `[t2-08] s1 parseable=${s1Parseable}/6 items=${s1ValidatedSpans + s1ValidatedNumbers} ` +
        `prov4=${provMetrics.allFourKnown}/${provMetrics.totalExamined} ` +
        `A accepted=${resultA.summary.accepted} frozen=${(resultA.summary.frozenCorrect as string[]).length}/4 ` +
        `B accepted=${resultB.summary.accepted} frozen=${(resultB.summary.frozenCorrect as string[]).length}/4`,
    );

    expect(record.stage1.length).toBe(6);
    expect(existsSync(RESULTS_DIR)).toBe(true);
  });
});
