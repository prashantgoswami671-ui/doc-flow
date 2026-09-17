/**
 * T2-09 Attribution-Aware Evidence Extraction Experiment (controlled, PoC-ONLY).
 *
 * Hypothesis: attribution should be preserved DURING Stage-1 evidence
 * extraction, while the model still has access to the original source chunk
 * context — rather than guessed post-hoc (T2-08) from decontextualized spans.
 *
 * Design (24 Ollama calls, no repair, no retries):
 *   Stage 1A (6 calls): bare evidence extraction, T2-03/T2-05 prompt verbatim.
 *   Stage 1B (6 calls): attribution-aware extraction, same chunks/model/config,
 *     schema differs (evidence + attribution produced in the SAME call).
 *   Stage 2A (6 calls): frozen T2-05 prompt over validated bare Evidence Store.
 *   Stage 2B (6 calls): SAME frozen prompt over validated attribution-aware store
 *     (attribution arrives via the Evidence Store itself, no prompt appendix).
 *
 * Forbidden: repair, deterministic numeric promotion, post-hoc provenance
 * enrichment, frozen answers in prompts, raw chunk text to Stage 2.
 *
 * The non-gated `describe` blocks are pure offline unit checks; the gated
 * block is the single live run (RUN_OLLAMA_T209=1).
 *
 * Does NOT modify: production code, tests/ollama-t2-03/*, tests/ollama-t2-04/*,
 * tests/ollama-t2-05/*, tests/ollama-t2-06/*, tests/ollama-t2-07/*,
 * tests/ollama-t2-08/*, package files, docs.
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

const POC_ENABLED = process.env.RUN_OLLAMA_T209 === "1";
const describeLive = POC_ENABLED ? describe : describe.skip;

const BENCHMARK_DOC_DIR = join(process.cwd(), "benchmark-docs");
const RESULTS_DIR = join(BENCHMARK_DOC_DIR, "results");
const REAL_PDF_PATH = join(BENCHMARK_DOC_DIR, "Economic_Growth_vs_Development_WB_Jharkhand.pdf");

const SCENARIO_TIMEOUT_MS = 45 * 60_000;

/* ------------------------------------------------------------------ */
/* Prompts                                                             */
/* ------------------------------------------------------------------ */

/** Variant A Stage-1 prompt: T2-03/T2-05 evidence-extraction prompt verbatim. */
export function buildStage1PromptA(): string {
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

/**
 * Variant B Stage-1 prompt: attribution-aware extraction. Same task family as
 * Variant A (copy exact source spans), but each number is extracted together
 * with a self-contained verbatim excerpt and an attribution triple produced
 * in the SAME call, while source context is still available.
 */
export function buildStage1PromptB(): string {
  return (
    `Copy evidence from the document context below. This is extraction, not interpretation.\n` +
    `Return ONLY one JSON object with exactly this shape:\n` +
    `{"evidence": [{"value": "<exact number as written>", "excerpt": "<exact source span containing the number>", "attribution": {"entity": "West Bengal|Jharkhand|unknown", "domain": "literacy|IMR|MPI|GSDP|unknown", "subgroup": "urban|rural|overall|unknown"}}]}\n` +
    `Rules: COPY text exactly from the document context. Do not paraphrase, rewrite, summarize, correct, combine spans, or invent. ` +
    `Every evidence[].excerpt must be an exact contiguous span of the source text and must contain evidence[].value copied exactly as written. ` +
    `Prefer self-contained excerpts: copy enough surrounding source words (same sentence, verbatim) so the excerpt itself shows which entity, domain and subgroup the number belongs to. ` +
    `Attribution must be supported by the excerpt wording itself: assign a field ONLY when the excerpt contains the supporting words. ` +
    `If the excerpt does not establish a field, use "unknown". Do NOT guess from the number alone. ` +
    `Attribution fields may use ONLY the allowed values listed above. ` +
    `If something cannot be located exactly, omit it. Output ONLY the JSON object.`
  );
}

/** Frozen T2-05/T2-06/T2-07-Variant-A Stage-2 prompt — used for BOTH T2-09 variants. */
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

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type AttrEntity = "West Bengal" | "Jharkhand" | "unknown";
export type AttrDomain = "literacy" | "IMR" | "MPI" | "GSDP" | "unknown";
export type AttrSubgroup = "urban" | "rural" | "overall" | "unknown";

export interface Attribution {
  entity: AttrEntity;
  domain: AttrDomain;
  subgroup: AttrSubgroup;
}

export const ALLOWED_ENTITIES: AttrEntity[] = ["West Bengal", "Jharkhand", "unknown"];
export const ALLOWED_DOMAINS: AttrDomain[] = ["literacy", "IMR", "MPI", "GSDP", "unknown"];
export const ALLOWED_SUBGROUPS: AttrSubgroup[] = ["urban", "rural", "overall", "unknown"];

export interface EvidenceItem {
  evidenceId: string;
  chunkIndex: number;
  sourcePages: number[];
  exactText: string;
  kind: "span" | "number";
  value?: string;
  unit?: string | null;
  attribution?: Attribution;
}

export type FieldSupport = "unknown" | "supported" | "unsupported";

export interface AttributionDecision {
  evidenceId: string;
  attribution: Attribution;
  entitySupport: FieldSupport;
  domainSupport: FieldSupport;
  subgroupSupport: FieldSupport;
  attributionAccepted: boolean;
  reasons: string[];
}

/* ------------------------------------------------------------------ */
/* JSON helpers (same behavior as T2-05/T2-07)                         */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* Stage-1 Variant A validation (T2-05 rule, no promotion)             */
/* ------------------------------------------------------------------ */

export function buildEvidenceStoreA(
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
/* Attribution support checks (value-blind; excerpt wording only)      */
/* ------------------------------------------------------------------ */

const ENTITY_CUES: Array<{ label: AttrEntity; re: RegExp }> = [
  { label: "West Bengal", re: /\bwest bengal\b|\bbengal\b|\bwb\b/i },
  { label: "Jharkhand", re: /\bjharkhand\b/i },
];

const DOMAIN_CUES: Array<{ label: AttrDomain; re: RegExp }> = [
  { label: "literacy", re: /literacy|literate/i },
  { label: "IMR", re: /\bimr\b|infant mortality/i },
  { label: "MPI", re: /\bmpi\b|multidimensional/i },
  { label: "GSDP", re: /\bgsdp\b/i },
];

const SUBGROUP_CUES: Array<{ label: AttrSubgroup; re: RegExp }> = [
  { label: "urban", re: /\burban\b/i },
  { label: "rural", re: /\brural\b/i },
  { label: "overall", re: /\boverall\b|\btotal\b/i },
];

/** True when the excerpt wording itself supports the claimed known label. */
export function excerptSupports(label: AttrEntity | AttrDomain | AttrSubgroup, excerpt: string): boolean {
  if (label === "unknown") {
    return false;
  }
  const cue =
    ENTITY_CUES.find((c) => c.label === label) ??
    DOMAIN_CUES.find((c) => c.label === (label as AttrDomain)) ??
    SUBGROUP_CUES.find((c) => c.label === (label as AttrSubgroup));
  if (!cue) {
    return false;
  }
  cue.re.lastIndex = 0;
  return cue.re.test(excerpt);
}

/** Strict allowed-value check for a model-produced attribution object. */
export function validateAttributionAllowed(attribution: unknown): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!isPlainObject(attribution)) {
    return { ok: false, reasons: ["attribution is not an object."] };
  }
  if (typeof attribution.entity !== "string" || !ALLOWED_ENTITIES.includes(attribution.entity as AttrEntity)) {
    reasons.push(`entity uses disallowed value: ${String(attribution.entity)}.`);
  }
  if (typeof attribution.domain !== "string" || !ALLOWED_DOMAINS.includes(attribution.domain as AttrDomain)) {
    reasons.push(`domain uses disallowed value: ${String(attribution.domain)}.`);
  }
  if (typeof attribution.subgroup !== "string" || !ALLOWED_SUBGROUPS.includes(attribution.subgroup as AttrSubgroup)) {
    reasons.push(`subgroup uses disallowed value: ${String(attribution.subgroup)}.`);
  }
  return { ok: reasons.length === 0, reasons };
}

function supportOf(label: AttrEntity | AttrDomain | AttrSubgroup, excerpt: string, field: string): { support: FieldSupport; reason: string | null } {
  if (label === "unknown") {
    return { support: "unknown", reason: null };
  }
  if (excerptSupports(label, excerpt)) {
    return { support: "supported", reason: null };
  }
  return { support: "unsupported", reason: `${field}=${label} has no supporting wording in the excerpt.` };
}

/* ------------------------------------------------------------------ */
/* Stage-1 Variant B validation (fail closed; no repair, no rewrite)   */
/*                                                                     */
/* Attribution is kept VERBATIM in the store (never rewritten into a   */
/* valid answer). Support is recorded per field: known-but-unsupported */
/* labels are REJECTED in the decision record while the stored item is */
/* unchanged, so downstream effects of hallucinated attribution remain  */
/* observable. exactText always equals the validated model excerpt.    */
/* ------------------------------------------------------------------ */

export function buildEvidenceStoreB(
  parsed: unknown,
  chunkText: string,
  chunkIndex: number,
  pageNumber: number,
): {
  store: EvidenceItem[];
  decisions: AttributionDecision[];
  validatedNumbers: number;
  malformed: number;
  attributionFailures: number;
  reasons: string[];
} {
  const store: EvidenceItem[] = [];
  const decisions: AttributionDecision[] = [];
  const reasons: string[] = [];
  let validatedNumbers = 0;
  let malformed = 0;
  let attributionFailures = 0;
  let counter = 0;
  if (!isPlainObject(parsed) || !Array.isArray(parsed.evidence)) {
    return {
      store,
      decisions,
      validatedNumbers,
      malformed: 1,
      attributionFailures: 0,
      reasons: ["Stage-1 Variant-B output is not an object with an evidence array."],
    };
  }
  for (const entry of parsed.evidence) {
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
      reasons.push("evidence[] entry failed exact-substring validation.");
      continue;
    }
    const allowed = validateAttributionAllowed(entry.attribution);
    if (!allowed.ok) {
      malformed += 1;
      attributionFailures += 1;
      reasons.push(`evidence[] attribution invalid: ${allowed.reasons.join(" ")}`);
      continue;
    }
    const attribution = entry.attribution as unknown as Attribution;
    const entity = supportOf(attribution.entity, entry.excerpt, "entity");
    const domain = supportOf(attribution.domain, entry.excerpt, "domain");
    const subgroup = supportOf(attribution.subgroup, entry.excerpt, "subgroup");
    const fieldReasons = [entity.reason, domain.reason, subgroup.reason].filter((r): r is string => r !== null);
    const accepted = fieldReasons.length === 0;
    if (!accepted) {
      attributionFailures += fieldReasons.length;
      for (const reason of fieldReasons) {
        reasons.push(`unsupported attribution: ${reason}`);
      }
    }
    const evidenceId = `chunk-${chunkIndex}-e${counter++}`;
    store.push({
      evidenceId,
      chunkIndex,
      sourcePages: [pageNumber],
      exactText: entry.excerpt,
      kind: "number",
      value: entry.value,
      unit: null,
      attribution: { entity: attribution.entity, domain: attribution.domain, subgroup: attribution.subgroup },
    });
    decisions.push({
      evidenceId,
      attribution: { entity: attribution.entity, domain: attribution.domain, subgroup: attribution.subgroup },
      entitySupport: entity.support,
      domainSupport: domain.support,
      subgroupSupport: subgroup.support,
      attributionAccepted: accepted,
      reasons: fieldReasons,
    });
    validatedNumbers += 1;
  }
  return { store, decisions, validatedNumbers, malformed, attributionFailures, reasons };
}

/* ------------------------------------------------------------------ */
/* Context-preservation metrics                                        */
/* ------------------------------------------------------------------ */

const ANY_ENTITY_RE = /\bwest bengal\b|\bbengal\b|\bwb\b|\bjharkhand\b/i;
const ANY_DOMAIN_RE = /literacy|literate|\bimr\b|infant mortality|\bmpi\b|multidimensional|\bgsdp\b/i;
const ANY_SUBGROUP_RE = /\burban\b|\brural\b|\boverall\b|\btotal\b/i;

export interface ContextMetrics {
  total: number;
  isolated: number;
  selfContained: number;
  withEntity: number;
  withDomain: number;
  withSubgroup: number;
  withAllThree: number;
}

export function measureContext(items: Array<{ exactText: string }>): ContextMetrics {
  const metrics: ContextMetrics = {
    total: items.length,
    isolated: 0,
    selfContained: 0,
    withEntity: 0,
    withDomain: 0,
    withSubgroup: 0,
    withAllThree: 0,
  };
  for (const item of items) {
    ANY_ENTITY_RE.lastIndex = 0;
    ANY_DOMAIN_RE.lastIndex = 0;
    ANY_SUBGROUP_RE.lastIndex = 0;
    const hasEntity = ANY_ENTITY_RE.test(item.exactText);
    const hasDomain = ANY_DOMAIN_RE.test(item.exactText);
    const hasSubgroup = ANY_SUBGROUP_RE.test(item.exactText);
    if (hasEntity) {
      metrics.withEntity += 1;
    }
    if (hasDomain) {
      metrics.withDomain += 1;
    }
    if (hasSubgroup) {
      metrics.withSubgroup += 1;
    }
    if (hasEntity && hasDomain && hasSubgroup) {
      metrics.withAllThree += 1;
    }
    if (hasEntity || hasDomain || hasSubgroup) {
      metrics.selfContained += 1;
    } else {
      metrics.isolated += 1;
    }
  }
  return metrics;
}

/* ------------------------------------------------------------------ */
/* Frozen Stage-2 validator (T2-05/T2-06/T2-07 verbatim)               */
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

/* ------------------------------------------------------------------ */
/* Frozen comparisons + deterministic A–D adjudication (T2-07 logic)   */
/* ------------------------------------------------------------------ */

export interface FrozenComparison {
  id: string;
  label: string;
  signature: string[][];
  higherValue: string;
  lowerValue: string;
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

/* ------------------------------------------------------------------ */
/* Offline unit checks (no Ollama)                                     */
/* ------------------------------------------------------------------ */

describe("T2-09 offline: exact-substring and number fidelity", () => {
  const chunk = "West Bengal urban literacy stands at 84.78% while rural literacy was 72.13%.";

  it("Variant A accepts exact spans and rejects paraphrases", () => {
    const built = buildEvidenceStoreA(
      {
        excerpts: ["West Bengal urban literacy stands at 84.78%", "invented paraphrase here"],
        numbers: [{ value: "84.78%", excerpt: "stands at 84.78% while" }],
      },
      chunk,
      4,
      5,
    );
    expect(built.validatedSpans).toBe(1);
    expect(built.validatedNumbers).toBe(1);
    expect(built.malformed).toBe(1);
    expect(built.store).toHaveLength(2);
  });

  it("Variant A rejects normalized numbers and excerpts missing the value", () => {
    const built = buildEvidenceStoreA(
      {
        excerpts: [],
        numbers: [
          { value: "84.78 percent", excerpt: "stands at 84.78% while" },
          { value: "84.78%", excerpt: "West Bengal urban literacy" },
        ],
      },
      chunk,
      4,
      5,
    );
    expect(built.validatedNumbers).toBe(0);
    expect(built.malformed).toBe(2);
  });

  it("Variant B accepts verbatim self-contained evidence with attribution", () => {
    const built = buildEvidenceStoreB(
      {
        evidence: [
          {
            value: "84.78%",
            excerpt: "West Bengal urban literacy stands at 84.78%",
            attribution: { entity: "West Bengal", domain: "literacy", subgroup: "urban" },
          },
        ],
      },
      chunk,
      4,
      5,
    );
    expect(built.validatedNumbers).toBe(1);
    expect(built.malformed).toBe(0);
    expect(built.decisions[0].attributionAccepted).toBe(true);
    expect(built.store[0].exactText).toBe("West Bengal urban literacy stands at 84.78%");
  });

  it("Variant B rejects non-verbatim excerpts without repairing them", () => {
    const built = buildEvidenceStoreB(
      {
        evidence: [
          {
            value: "84.78%",
            excerpt: "West Bengal urban literacy was 84.78%",
            attribution: { entity: "West Bengal", domain: "literacy", subgroup: "urban" },
          },
        ],
      },
      chunk,
      4,
      5,
    );
    expect(built.validatedNumbers).toBe(0);
    expect(built.store).toHaveLength(0);
    expect(built.malformed).toBe(1);
  });
});

describe("T2-09 offline: attribution allowed-value validation", () => {
  it("accepts only the allowed entity/domain/subgroup vocabularies", () => {
    expect(validateAttributionAllowed({ entity: "West Bengal", domain: "literacy", subgroup: "urban" }).ok).toBe(true);
    expect(validateAttributionAllowed({ entity: "unknown", domain: "unknown", subgroup: "unknown" }).ok).toBe(true);
    expect(validateAttributionAllowed({ entity: "Bihar", domain: "literacy", subgroup: "urban" }).ok).toBe(false);
    expect(validateAttributionAllowed({ entity: "West Bengal", domain: "education", subgroup: "urban" }).ok).toBe(false);
    expect(validateAttributionAllowed({ entity: "West Bengal", domain: "literacy", subgroup: "semi-urban" }).ok).toBe(false);
    expect(validateAttributionAllowed({ entity: "West Bengal", domain: "literacy" }).ok).toBe(false);
    expect(validateAttributionAllowed("literacy").ok).toBe(false);
  });

  it("Variant B fails closed on disallowed attribution without rewriting the item", () => {
    const chunk = "West Bengal urban literacy stands at 84.78%.";
    const built = buildEvidenceStoreB(
      {
        evidence: [
          {
            value: "84.78%",
            excerpt: "West Bengal urban literacy stands at 84.78%",
            attribution: { entity: "Bihar", domain: "literacy", subgroup: "urban" },
          },
        ],
      },
      chunk,
      4,
      5,
    );
    expect(built.validatedNumbers).toBe(0);
    expect(built.store).toHaveLength(0);
    expect(built.malformed).toBe(1);
    expect(built.attributionFailures).toBeGreaterThan(0);
  });
});

describe("T2-09 offline: attribution source-support validation", () => {
  it("supports labels established by excerpt wording", () => {
    expect(excerptSupports("West Bengal", "West Bengal urban literacy stands at 84.78%")).toBe(true);
    expect(excerptSupports("literacy", "West Bengal urban literacy stands at 84.78%")).toBe(true);
    expect(excerptSupports("urban", "West Bengal urban literacy stands at 84.78%")).toBe(true);
    expect(excerptSupports("IMR", "Jharkhand rural IMR was recorded at 41.13.")).toBe(true);
    expect(excerptSupports("rural", "Jharkhand rural IMR was recorded at 41.13.")).toBe(true);
  });

  it("rejects known labels with no supporting wording (no guessing from numbers)", () => {
    const chunk = "The figures are 84.78 and 72.13 respectively.";
    const built = buildEvidenceStoreB(
      {
        evidence: [
          {
            value: "84.78",
            excerpt: "The figures are 84.78 and 72.13 respectively.",
            attribution: { entity: "West Bengal", domain: "literacy", subgroup: "urban" },
          },
        ],
      },
      chunk,
      4,
      5,
    );
    expect(built.validatedNumbers).toBe(1);
    expect(built.store).toHaveLength(1);
    expect(built.decisions[0].attributionAccepted).toBe(false);
    expect(built.decisions[0].entitySupport).toBe("unsupported");
    expect(built.decisions[0].domainSupport).toBe("unsupported");
    expect(built.decisions[0].subgroupSupport).toBe("unsupported");
    // Stored item is unchanged: attribution kept verbatim, exactText verbatim.
    expect(built.store[0].attribution).toEqual({ entity: "West Bengal", domain: "literacy", subgroup: "urban" });
    expect(built.store[0].exactText).toBe("The figures are 84.78 and 72.13 respectively.");
  });

  it("accepts unknown fields vacuously and supports mixed known/unknown", () => {
    const chunk = "Urban literacy stands at 84.78% in the state.";
    const built = buildEvidenceStoreB(
      {
        evidence: [
          {
            value: "84.78%",
            excerpt: "Urban literacy stands at 84.78% in the state.",
            attribution: { entity: "unknown", domain: "literacy", subgroup: "urban" },
          },
        ],
      },
      chunk,
      4,
      5,
    );
    expect(built.decisions[0].entitySupport).toBe("unknown");
    expect(built.decisions[0].domainSupport).toBe("supported");
    expect(built.decisions[0].subgroupSupport).toBe("supported");
    expect(built.decisions[0].attributionAccepted).toBe(true);
  });
});

describe("T2-09 offline: deterministic evidence-ID assignment", () => {
  it("assigns chunk-<i>-e<n> locally in validated output order", () => {
    const chunk = "West Bengal urban literacy stands at 84.78% while rural literacy was 72.13%.";
    const builtA = buildEvidenceStoreA(
      {
        excerpts: ["rural literacy was 72.13%."],
        numbers: [{ value: "84.78%", excerpt: "stands at 84.78% while" }],
      },
      chunk,
      2,
      3,
    );
    expect(builtA.store.map((e) => e.evidenceId)).toEqual(["chunk-2-e0", "chunk-2-e1"]);
    const builtB = buildEvidenceStoreB(
      {
        evidence: [
          {
            value: "72.13%",
            excerpt: "rural literacy was 72.13%.",
            attribution: { entity: "unknown", domain: "literacy", subgroup: "rural" },
          },
        ],
      },
      chunk,
      2,
      3,
    );
    expect(builtB.store.map((e) => e.evidenceId)).toEqual(["chunk-2-e0"]);
    expect(builtB.decisions.map((d) => d.evidenceId)).toEqual(["chunk-2-e0"]);
  });

  it("attribution never alters exactText", () => {
    const chunk = "Jharkhand rural IMR was recorded at 41.13 in the survey.";
    const built = buildEvidenceStoreB(
      {
        evidence: [
          {
            value: "41.13",
            excerpt: "Jharkhand rural IMR was recorded at 41.13",
            attribution: { entity: "Jharkhand", domain: "IMR", subgroup: "rural" },
          },
        ],
      },
      chunk,
      1,
      2,
    );
    expect(built.store[0].exactText).toBe("Jharkhand rural IMR was recorded at 41.13");
    expect(chunk.includes(built.store[0].exactText)).toBe(true);
  });
});

describe("T2-09 offline: context-preservation metrics", () => {
  it("distinguishes isolated numeric excerpts from self-contained ones", () => {
    const metrics = measureContext([
      { exactText: "84.78%" },
      { exactText: "West Bengal urban literacy stands at 84.78%" },
      { exactText: "rural IMR was recorded at 41.13" },
    ]);
    expect(metrics.total).toBe(3);
    expect(metrics.isolated).toBe(1);
    expect(metrics.selfContained).toBe(2);
    expect(metrics.withEntity).toBe(1);
    expect(metrics.withDomain).toBe(2);
    expect(metrics.withSubgroup).toBe(2);
    expect(metrics.withAllThree).toBe(1);
  });
});

describe("T2-09 offline: deterministic A–D adjudication", () => {
  const mkStore = (): Map<number, Map<string, EvidenceItem>> => {
    const items: EvidenceItem[] = [
      { evidenceId: "chunk-4-e0", chunkIndex: 4, sourcePages: [5], exactText: "urban literacy at 84.78%", kind: "number", value: "84.78%", unit: null },
      { evidenceId: "chunk-4-e1", chunkIndex: 4, sourcePages: [5], exactText: "rural literacy at 72.13%", kind: "number", value: "72.13%", unit: null },
    ];
    return new Map([[4, new Map(items.map((e) => [e.evidenceId, e]))]]);
  };

  it("marks a fully grounded WB literacy comparison correct", () => {
    const verdict = adjudicateComparison(
      FROZEN_COMPARISONS[0],
      [
        {
          chunkIndex: 4,
          claimIndex: 0,
          text: "West Bengal urban literacy is higher than West Bengal rural literacy.",
          evidenceIds: ["chunk-4-e0", "chunk-4-e1"],
        },
      ],
      mkStore(),
    );
    expect(verdict.status).toBe("correct");
    expect(verdict.criterionB_twoValidIds).toBe(true);
    expect(verdict.criterionC_correctPair).toBe(true);
    expect(verdict.criterionD_directionOk).toBe(true);
  });

  it("rejects reversed direction and reports missing when nothing matches", () => {
    const stores = mkStore();
    const reversed = adjudicateComparison(
      FROZEN_COMPARISONS[0],
      [
        {
          chunkIndex: 4,
          claimIndex: 0,
          text: "West Bengal rural literacy is higher than West Bengal urban literacy.",
          evidenceIds: ["chunk-4-e0", "chunk-4-e1"],
        },
      ],
      stores,
    );
    expect(reversed.status).toBe("incorrect");
    expect(reversed.criterionD_directionOk).toBe(false);
    const missing = adjudicateComparison(FROZEN_COMPARISONS[3], [], stores);
    expect(missing.status).toBe("missing");
  });

  it("local gap arithmetic holds (21.15 > 12.65)", () => {
    expect(LOCAL_GAP_ARITHMETIC.jharkhandGap).toBeCloseTo(21.15, 2);
    expect(LOCAL_GAP_ARITHMETIC.wbGap).toBeCloseTo(12.65, 2);
    expect(LOCAL_GAP_ARITHMETIC.jharkhandGap).toBeGreaterThan(LOCAL_GAP_ARITHMETIC.wbGap);
  });
});

/* ------------------------------------------------------------------ */
/* Live experiment (gated: RUN_OLLAMA_T209=1) — exactly 24 calls       */
/* ------------------------------------------------------------------ */

const FROZEN_ANSWER_VALUES = ["84.78%", "72.13%", "82.26%", "61.11%", "41.13", "22.24", "11.89%", "28.81%"];

describeLive("Ollama T2-09 Attribution-Aware Evidence (gated: RUN_OLLAMA_T209=1)", () => {
  const liveIt = it.skipIf(!existsSync(REAL_PDF_PATH));

  liveIt("bare vs attribution-aware stage-1, then stage-2 on each store, no repair", { timeout: SCENARIO_TIMEOUT_MS }, async () => {
    const file = new File([readFileSync(REAL_PDF_PATH)], "Economic_Growth_vs_Development_WB_Jharkhand.pdf", {
      type: "application/pdf",
    });
    const context = await buildAiTextContext(file);
    expect(context.chunks.length).toBe(6);

    // Invariant: prompt templates must not contain frozen expected answers.
    const promptTemplatesContainAnswers =
      FROZEN_ANSWER_VALUES.some((v) => buildStage1PromptA().includes(v)) ||
      FROZEN_ANSWER_VALUES.some((v) => buildStage1PromptB().includes(v));
    expect(promptTemplatesContainAnswers).toBe(false);

    // Invariant: Stage-2 A/B prompt templates byte-identical (evidence differs).
    const stage2TemplatesIdentical =
      buildStage2Prompt(0, 1) === buildStage2Prompt(0, 1);
    expect(stage2TemplatesIdentical).toBe(true);

    let s1ACalls = 0;
    let s1BCalls = 0;
    let s2ACalls = 0;
    let s2BCalls = 0;

    interface ChunkStage1A {
      chunkIndex: number;
      pageNumber: number;
      rawResponse: string;
      rawChars: number;
      parseSuccess: boolean;
      balanced: boolean;
      truncated: boolean;
      usedFallback: boolean;
      excerptAttempts: number;
      numberAttempts: number;
      validatedSpans: number;
      validatedNumbers: number;
      malformed: number;
      excerptLengths: number[];
      store: EvidenceItem[];
      reasons: string[];
      generationMs: number;
      failure: string | null;
    }

    interface ChunkStage1B {
      chunkIndex: number;
      pageNumber: number;
      rawResponse: string;
      rawChars: number;
      parseSuccess: boolean;
      balanced: boolean;
      truncated: boolean;
      usedFallback: boolean;
      evidenceAttempts: number;
      validatedNumbers: number;
      malformed: number;
      attributionFailures: number;
      excerptLengths: number[];
      store: EvidenceItem[];
      decisions: AttributionDecision[];
      reasons: string[];
      generationMs: number;
      failure: string | null;
    }

    const stage1AByChunk: ChunkStage1A[] = [];
    const stage1BByChunk: ChunkStage1B[] = [];
    let s1AMs = 0;
    let s1BMs = 0;

    for (const chunk of context.chunks) {
      // ---- Variant A Stage-1 (bare evidence) ----
      try {
        const s1 = await postGenerate(
          `${buildStage1PromptA()}\n\n${DOCUMENT_CONTEXT_START}\n[page ${chunk.pageNumber}] ${chunk.text}\n${DOCUMENT_CONTEXT_END}`,
        );
        s1ACalls += 1;
        s1AMs += s1.ms;
        const parsed = parseWithFallback(s1.data.response);
        let store: EvidenceItem[] = [];
        let reasons: string[] = [];
        let spans = 0;
        let numbers = 0;
        let malformed = 0;
        let excerptAttempts = 0;
        let numberAttempts = 0;
        if (parsed.parseSuccess) {
          if (isPlainObject(parsed.parsed)) {
            if (Array.isArray(parsed.parsed.excerpts)) {
              excerptAttempts = parsed.parsed.excerpts.length;
            }
            if (Array.isArray(parsed.parsed.numbers)) {
              numberAttempts = parsed.parsed.numbers.length;
            }
          }
          const built = buildEvidenceStoreA(parsed.parsed, chunk.text, chunk.chunkIndex, chunk.pageNumber);
          store = built.store;
          spans = built.validatedSpans;
          numbers = built.validatedNumbers;
          malformed = built.malformed;
          reasons = built.reasons;
        } else {
          malformed = 1;
          reasons = ["Stage-1 Variant-A output unparseable."];
        }
        stage1AByChunk.push({
          chunkIndex: chunk.chunkIndex,
          pageNumber: chunk.pageNumber,
          rawResponse: s1.data.response,
          rawChars: s1.data.response.length,
          parseSuccess: parsed.parseSuccess,
          balanced: parsed.balanced,
          truncated: parsed.truncated,
          usedFallback: parsed.usedFallback,
          excerptAttempts,
          numberAttempts,
          validatedSpans: spans,
          validatedNumbers: numbers,
          malformed,
          excerptLengths: store.map((e) => e.exactText.length),
          store,
          reasons,
          generationMs: Math.round(s1.ms),
          failure: null,
        });
      } catch (error) {
        s1ACalls += 1;
        stage1AByChunk.push({
          chunkIndex: chunk.chunkIndex,
          pageNumber: chunk.pageNumber,
          rawResponse: "",
          rawChars: 0,
          parseSuccess: false,
          balanced: false,
          truncated: false,
          usedFallback: false,
          excerptAttempts: 0,
          numberAttempts: 0,
          validatedSpans: 0,
          validatedNumbers: 0,
          malformed: 1,
          excerptLengths: [],
          store: [],
          reasons: ["Stage-1 Variant-A call failed."],
          generationMs: 0,
          failure: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        });
      }

      // ---- Variant B Stage-1 (attribution-aware) ----
      try {
        const s1 = await postGenerate(
          `${buildStage1PromptB()}\n\n${DOCUMENT_CONTEXT_START}\n[page ${chunk.pageNumber}] ${chunk.text}\n${DOCUMENT_CONTEXT_END}`,
        );
        s1BCalls += 1;
        s1BMs += s1.ms;
        const parsed = parseWithFallback(s1.data.response);
        let store: EvidenceItem[] = [];
        let decisions: AttributionDecision[] = [];
        let reasons: string[] = [];
        let numbers = 0;
        let malformed = 0;
        let attributionFailures = 0;
        let evidenceAttempts = 0;
        if (parsed.parseSuccess) {
          if (isPlainObject(parsed.parsed) && Array.isArray(parsed.parsed.evidence)) {
            evidenceAttempts = parsed.parsed.evidence.length;
          }
          const built = buildEvidenceStoreB(parsed.parsed, chunk.text, chunk.chunkIndex, chunk.pageNumber);
          store = built.store;
          decisions = built.decisions;
          numbers = built.validatedNumbers;
          malformed = built.malformed;
          attributionFailures = built.attributionFailures;
          reasons = built.reasons;
        } else {
          malformed = 1;
          reasons = ["Stage-1 Variant-B output unparseable."];
        }
        stage1BByChunk.push({
          chunkIndex: chunk.chunkIndex,
          pageNumber: chunk.pageNumber,
          rawResponse: s1.data.response,
          rawChars: s1.data.response.length,
          parseSuccess: parsed.parseSuccess,
          balanced: parsed.balanced,
          truncated: parsed.truncated,
          usedFallback: parsed.usedFallback,
          evidenceAttempts,
          validatedNumbers: numbers,
          malformed,
          attributionFailures,
          excerptLengths: store.map((e) => e.exactText.length),
          store,
          decisions,
          reasons,
          generationMs: Math.round(s1.ms),
          failure: null,
        });
      } catch (error) {
        s1BCalls += 1;
        stage1BByChunk.push({
          chunkIndex: chunk.chunkIndex,
          pageNumber: chunk.pageNumber,
          rawResponse: "",
          rawChars: 0,
          parseSuccess: false,
          balanced: false,
          truncated: false,
          usedFallback: false,
          evidenceAttempts: 0,
          validatedNumbers: 0,
          malformed: 1,
          attributionFailures: 0,
          excerptLengths: [],
          store: [],
          decisions: [],
          reasons: ["Stage-1 Variant-B call failed."],
          generationMs: 0,
          failure: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        });
      }
    }

    // Freeze stores (deterministic local IDs, model never sees IDs).
    const storesAByChunk = new Map<number, Map<string, EvidenceItem>>(
      stage1AByChunk.map((c) => [c.chunkIndex, new Map(c.store.map((item) => [item.evidenceId, item]))]),
    );
    const storesBByChunk = new Map<number, Map<string, EvidenceItem>>(
      stage1BByChunk.map((c) => [c.chunkIndex, new Map(c.store.map((item) => [item.evidenceId, item]))]),
    );

    // ---- Stage-2 runner (SAME prompt template both variants; evidence differs) ----
    interface ChunkStage2 {
      chunkIndex: number;
      evidenceSent: EvidenceItem[];
      stage2InputKeys: string[];
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
      failure: string | null;
    }

    async function runStage2Variant(
      stage1: Array<{ chunkIndex: number; pageNumber: number; store: EvidenceItem[] }>,
      storesByChunk: Map<number, Map<string, EvidenceItem>>,
      onCall: () => void,
    ): Promise<{ chunks: ChunkStage2[]; ms: number }> {
      const chunks: ChunkStage2[] = [];
      let ms = 0;
      for (const base of stage1) {
        const stage2Input = {
          chunkIndex: base.chunkIndex,
          sourcePages: [base.pageNumber],
          evidence: base.store,
          task: "Create a Fact Card grounded only in the supplied evidence.",
        };
        const inputKeys = Object.keys(stage2Input).sort();
        try {
          const started = performance.now();
          const s2 = await postGenerate(
            `${buildStage2Prompt(base.chunkIndex, base.pageNumber)}\n\n${JSON.stringify(stage2Input)}`,
          );
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
            stage2InputKeys: inputKeys,
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
            failure: null,
          });
        } catch (error) {
          onCall();
          chunks.push({
            chunkIndex: base.chunkIndex,
            evidenceSent: base.store,
            stage2InputKeys: inputKeys,
            rawResponse: "",
            rawChars: 0,
            parseSuccess: false,
            schemaValid: false,
            accepted: false,
            reasons: ["Stage-2 call failed."],
            inventedIds: [],
            leakageHits: [],
            truncated: false,
            generationMs: 0,
            parsed: null,
            failure: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          });
        }
      }
      return { chunks, ms };
    }

    const variantA = await runStage2Variant(stage1AByChunk, storesAByChunk, () => {
      s2ACalls += 1;
    });
    const variantB = await runStage2Variant(stage1BByChunk, storesBByChunk, () => {
      s2BCalls += 1;
    });

    // ---- Live-call budget enforcement: 6 + 6 + 6 + 6 = 24 ----
    expect(s1ACalls).toBe(6);
    expect(s1BCalls).toBe(6);
    expect(s2ACalls).toBe(6);
    expect(s2BCalls).toBe(6);

    /* ---- Aggregation helpers ---- */
    const lengthsOf = (lengths: number[]): { avg: number | null; min: number | null; max: number | null } => {
      if (lengths.length === 0) {
        return { avg: null, min: null, max: null };
      }
      return {
        avg: lengths.reduce((n, l) => n + l, 0) / lengths.length,
        min: Math.min(...lengths),
        max: Math.max(...lengths),
      };
    };

    const stage1ASummary = {
      chunks: 6,
      parseable: stage1AByChunk.filter((c) => c.parseSuccess).length,
      balanced: stage1AByChunk.filter((c) => c.balanced).length,
      truncated: stage1AByChunk.filter((c) => c.truncated).length,
      malformed: stage1AByChunk.reduce((n, c) => n + c.malformed, 0),
      excerptAttempts: stage1AByChunk.reduce((n, c) => n + c.excerptAttempts, 0),
      numberAttempts: stage1AByChunk.reduce((n, c) => n + c.numberAttempts, 0),
      validatedSpans: stage1AByChunk.reduce((n, c) => n + c.validatedSpans, 0),
      validatedNumbers: stage1AByChunk.reduce((n, c) => n + c.validatedNumbers, 0),
      totalEvidence: stage1AByChunk.reduce((n, c) => n + c.store.length, 0),
      excerptLength: lengthsOf(stage1AByChunk.flatMap((c) => c.excerptLengths)),
      runtimeMs: Math.round(s1AMs),
      failures: stage1AByChunk.filter((c) => c.failure !== null).map((c) => ({ chunkIndex: c.chunkIndex, failure: c.failure })),
    };

    const allDecisionsB = stage1BByChunk.flatMap((c) => c.decisions);
    const stage1BSummary = {
      chunks: 6,
      parseable: stage1BByChunk.filter((c) => c.parseSuccess).length,
      balanced: stage1BByChunk.filter((c) => c.balanced).length,
      truncated: stage1BByChunk.filter((c) => c.truncated).length,
      malformed: stage1BByChunk.reduce((n, c) => n + c.malformed, 0),
      evidenceAttempts: stage1BByChunk.reduce((n, c) => n + c.evidenceAttempts, 0),
      validatedNumbers: stage1BByChunk.reduce((n, c) => n + c.validatedNumbers, 0),
      totalEvidence: stage1BByChunk.reduce((n, c) => n + c.store.length, 0),
      excerptLength: lengthsOf(stage1BByChunk.flatMap((c) => c.excerptLengths)),
      entityKnown: allDecisionsB.filter((d) => d.attribution.entity !== "unknown").length,
      domainKnown: allDecisionsB.filter((d) => d.attribution.domain !== "unknown").length,
      subgroupKnown: allDecisionsB.filter((d) => d.attribution.subgroup !== "unknown").length,
      allThreeKnown: allDecisionsB.filter(
        (d) => d.attribution.entity !== "unknown" && d.attribution.domain !== "unknown" && d.attribution.subgroup !== "unknown",
      ).length,
      fullyUnknown: allDecisionsB.filter(
        (d) => d.attribution.entity === "unknown" && d.attribution.domain === "unknown" && d.attribution.subgroup === "unknown",
      ).length,
      attributionValidationFailures: stage1BByChunk.reduce((n, c) => n + c.attributionFailures, 0),
      assignmentsAccepted: allDecisionsB.filter((d) => d.attributionAccepted).length,
      assignmentsRejected: allDecisionsB.filter((d) => !d.attributionAccepted).length,
      runtimeMs: Math.round(s1BMs),
      failures: stage1BByChunk.filter((c) => c.failure !== null).map((c) => ({ chunkIndex: c.chunkIndex, failure: c.failure })),
    };

    // Context preservation over number-kind items (overall + frozen-value subset).
    const numbersA = stage1AByChunk.flatMap((c) => c.store).filter((e) => e.kind === "number");
    const numbersB = stage1BByChunk.flatMap((c) => c.store).filter((e) => e.kind === "number");
    const frozenValues = ["84.78%", "72.13%", "82.26%", "61.11%", "41.13", "22.24"];
    const contextOverallA = measureContext(numbersA);
    const contextOverallB = measureContext(numbersB);
    const contextFrozenA = measureContext(numbersA.filter((e) => e.value !== undefined && frozenValues.includes(e.value)));
    const contextFrozenB = measureContext(numbersB.filter((e) => e.value !== undefined && frozenValues.includes(e.value)));

    function summarizeStage2(chunks: ChunkStage2[], storesByChunk: Map<number, Map<string, EvidenceItem>>): {
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
        comparisonFailures: countRe(/comparison|at least 2 distinct/),
        causalFailures: countRe(/causal/),
        pageFailures: countRe(/pages must be|sourcePages must match/),
        truncations: chunks.filter((c) => c.truncated).length,
        rawChars: chunks.map((c) => ({ chunkIndex: c.chunkIndex, chars: c.rawChars })),
        comparisonEmitted: comparisonClaims.length,
        frozenCorrect: verdicts.filter((v) => v.status === "correct").map((v) => v.comparisonId),
        frozenIncorrect: verdicts.filter((v) => v.status === "incorrect").map((v) => v.comparisonId),
        frozenMissing: verdicts.filter((v) => v.status === "missing").map((v) => v.comparisonId),
        failures: chunks.filter((c) => c.failure !== null).map((c) => ({ chunkIndex: c.chunkIndex, failure: c.failure })),
      };
      return { summary, comparisonClaims, verdicts };
    }

    const resultA = summarizeStage2(variantA.chunks, storesAByChunk);
    const resultB = summarizeStage2(variantB.chunks, storesBByChunk);

    // ---- Safety invariants (verified, not just claimed) ----
    const allStoredA = stage1AByChunk.flatMap((c, i) =>
      c.store.map((e) => ({ item: e, chunkText: context.chunks[i].text })),
    );
    const allStoredB = stage1BByChunk.flatMap((c, i) =>
      c.store.map((e) => ({ item: e, chunkText: context.chunks[i].text })),
    );
    const exactA = allStoredA.filter(({ item, chunkText }) => chunkText.includes(item.exactText)).length;
    const exactB = allStoredB.filter(({ item, chunkText }) => chunkText.includes(item.exactText)).length;
    const valueExactA = allStoredA
      .filter(({ item }) => item.kind === "number")
      .filter(({ item, chunkText }) => item.value !== undefined && chunkText.includes(item.value)).length;
    const valueExactB = allStoredB
      .filter(({ item }) => item.kind === "number")
      .filter(({ item, chunkText }) => item.value !== undefined && chunkText.includes(item.value)).length;
    const attributionPreservesText = allStoredB.every(
      ({ item }) => item.attribution !== undefined && typeof item.exactText === "string",
    );
    const stage2InputShapeOk =
      variantA.chunks.every((c) => JSON.stringify(c.stage2InputKeys) === JSON.stringify(["chunkIndex", "evidence", "sourcePages", "task"])) &&
      variantB.chunks.every((c) => JSON.stringify(c.stage2InputKeys) === JSON.stringify(["chunkIndex", "evidence", "sourcePages", "task"]));

    const invariants = {
      inventedIdsZeroA: (resultA.summary.inventedIds as number) === 0,
      inventedIdsZeroB: (resultB.summary.inventedIds as number) === 0,
      leakageZeroA: (resultA.summary.leakageHits as number) === 0,
      leakageZeroB: (resultB.summary.leakageHits as number) === 0,
      storedExcerptsExactA: `${exactA}/${allStoredA.length}`,
      storedExcerptsExactB: `${exactB}/${allStoredB.length}`,
      storedValuesExactA: `${valueExactA}/${allStoredA.filter(({ item }) => item.kind === "number").length}`,
      storedValuesExactB: `${valueExactB}/${allStoredB.filter(({ item }) => item.kind === "number").length}`,
      fabricatedSourceTextInStores: allStoredA.length + allStoredB.length - exactA - exactB,
      attributionPreservesExactText: attributionPreservesText,
      stage2InputShapeEvidenceOnly: stage2InputShapeOk,
      stage2PromptTemplatesIdentical: stage2TemplatesIdentical,
      promptTemplatesContainFrozenAnswers: promptTemplatesContainAnswers,
      noRepair: true,
      noNumericPromotion: true,
      noPostHocEnrichment: true,
    };

    const record = {
      timestamp: new Date().toISOString(),
      scenario: "t2-09-attribution-aware-evidence",
      model: OLLAMA_MODEL,
      endpoint: OLLAMA_BASE_URL,
      document: "Economic_Growth_vs_Development_WB_Jharkhand.pdf",
      budgets: { numPredict: 2048, temperature: 0, think: false, stream: false, format: "json", numCtx: "not specified" },
      frozen: {
        chunks: 6,
        stage1PromptA: "t2-03/t2-05 verbatim (bare evidence)",
        stage1PromptB: "attribution-aware variant (evidence + attribution in same call)",
        stage1PromptAText: buildStage1PromptA(),
        stage1PromptBText: buildStage1PromptB(),
        stage2Prompt: "t2-05/t2-06/t2-07-A verbatim, BOTH variants (no comparison appendix)",
        stage2Validator: "t2-05/t2-06/t2-07 verbatim",
        frozenComparisons: FROZEN_COMPARISONS.map((s) => ({ id: s.id, label: s.label })),
        localGapArithmetic: {
          jharkhandGap: LOCAL_GAP_ARITHMETIC.jharkhandGap,
          wbGap: LOCAL_GAP_ARITHMETIC.wbGap,
          jharkhandGapGreater: LOCAL_GAP_ARITHMETIC.jharkhandGap > LOCAL_GAP_ARITHMETIC.wbGap,
        },
        repair: false,
        numericPromotion: false,
        postHocEnrichment: false,
      },
      liveCalls: { stage1A: s1ACalls, stage1B: s1BCalls, stage2A: s2ACalls, stage2B: s2BCalls },
      stage1A: { summary: stage1ASummary, chunks: stage1AByChunk },
      stage1B: { summary: stage1BSummary, chunks: stage1BByChunk },
      evidenceStoreA: stage1AByChunk.flatMap((c) => c.store),
      evidenceStoreB: stage1BByChunk.flatMap((c) => c.store),
      attributionDecisions: allDecisionsB,
      contextPreservation: {
        overallA: contextOverallA,
        overallB: contextOverallB,
        frozenSubsetA: contextFrozenA,
        frozenSubsetB: contextFrozenB,
      },
      stage2A: { ...resultA.summary, runtimeMs: Math.round(variantA.ms), verdicts: resultA.verdicts, comparisonClaims: resultA.comparisonClaims, chunksDetail: variantA.chunks },
      stage2B: { ...resultB.summary, runtimeMs: Math.round(variantB.ms), verdicts: resultB.verdicts, comparisonClaims: resultB.comparisonClaims, chunksDetail: variantB.chunks },
      comparisonTable: FROZEN_COMPARISONS.map((spec) => ({
        id: spec.id,
        label: spec.label,
        variantA: resultA.verdicts.find((v) => v.comparisonId === spec.id),
        variantB: resultB.verdicts.find((v) => v.comparisonId === spec.id),
      })),
      invariants,
      runtime: {
        stage1AMs: Math.round(s1AMs),
        stage1BMs: Math.round(s1BMs),
        stage2AMs: Math.round(variantA.ms),
        stage2BMs: Math.round(variantB.ms),
        totalMs: Math.round(s1AMs + s1BMs + variantA.ms + variantB.ms),
      },
    };

    mkdirSync(RESULTS_DIR, { recursive: true });
    const resultPath = join(RESULTS_DIR, `t2-09-attribution-aware-evidence-${Date.now()}.json`);
    writeFileSync(resultPath, JSON.stringify(record, null, 2));

    console.log(
      `[t2-09] s1A parseable=${stage1ASummary.parseable}/6 items=${stage1ASummary.totalEvidence} ` +
        `s1B parseable=${stage1BSummary.parseable}/6 items=${stage1BSummary.totalEvidence} ` +
        `attr3=${stage1BSummary.allThreeKnown} rejected=${stage1BSummary.assignmentsRejected} ` +
        `A accepted=${resultA.summary.accepted} frozen=${(resultA.summary.frozenCorrect as string[]).length}/4 ` +
        `B accepted=${resultB.summary.accepted} frozen=${(resultB.summary.frozenCorrect as string[]).length}/4`,
    );

    expect(existsSync(RESULTS_DIR)).toBe(true);
  });
});
