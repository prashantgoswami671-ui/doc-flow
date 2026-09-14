/**
 * T2-03 Fact Card PoC — structured-output client (PoC-ONLY, isolated).
 *
 * Does NOT modify `OllamaRuntime`, `OllamaClient`, or production Ollama
 * types. Makes a dedicated loopback POST to /api/generate with
 * `format: "json"` (Ollama structured output), reusing only the production
 * endpoint/model constants by read-only import. Production runtime behavior
 * is neither forked nor altered.
 *
 * Policy: at most ONE repair attempt per chunk; never fabricate a card
 * after a failed repair — the chunk is recorded as failed with raw output.
 */

import {
  OLLAMA_API_GENERATE,
  OLLAMA_BASE_URL,
  OLLAMA_MODEL,
} from "../../services/ai/ollama/types";
import { buildFactCardPrompt, buildFactCardRepairPrompt } from "./factCardPrompts";
import { validateFactCard } from "./factCardValidator";
import type { FactCard } from "./factCardSchema";

export interface FactCardChunkInput {
  chunkIndex: number;
  pageNumber: number;
  text: string;
}

export interface FactCardExtractionResult {
  card: FactCard | null;
  ok: boolean;
  /** True when the first response parsed AND validated without repair. */
  firstTryValid: boolean;
  /** True when the accepted card came from the single repair attempt. */
  repaired: boolean;
  reasons: string[];
  rawOutput: string | null;
  repairRawOutput: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  generationMs: number;
}

export interface FactCardClientOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  temperature?: number;
  maxOutputTokens?: number;
}

const DOCUMENT_CONTEXT_START = "<<<DOCUMENT_CONTEXT_START>>>";
const DOCUMENT_CONTEXT_END = "<<<DOCUMENT_CONTEXT_END>>>";

function renderContext(chunk: FactCardChunkInput): string {
  return `${DOCUMENT_CONTEXT_START}\n[page ${chunk.pageNumber}] ${chunk.text}\n${DOCUMENT_CONTEXT_END}`;
}

/** Extracts the first balanced {...} JSON object (tolerates <think> preamble / fences). */
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

interface OllamaJsonResponse {
  response: string;
  done: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

async function postGenerate(
  fetchImpl: typeof fetch,
  baseUrl: string,
  body: Record<string, unknown>,
): Promise<OllamaJsonResponse> {
  const response = await fetchImpl(`${baseUrl}${OLLAMA_API_GENERATE}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    let message = `Ollama request failed: ${response.status} ${response.statusText}`;
    try {
      const errorData = (await response.json()) as { error?: string };
      if (errorData?.error) {
        message = errorData.error;
      }
    } catch {
      // keep status-text message
    }
    throw new Error(message);
  }
  return (await response.json()) as OllamaJsonResponse;
}

function tryParseAndValidate(
  raw: string,
  chunk: FactCardChunkInput,
  sourcePageCount: number,
): { card: FactCard | null; reasons: string[] } {
  const jsonText = extractFirstJsonObject(raw);
  if (!jsonText) {
    return { card: null, reasons: ["Response contained no JSON object."] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText) as unknown;
  } catch (error) {
    return {
      card: null,
      reasons: [`Response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
  const validation = validateFactCard(parsed, chunk, sourcePageCount);
  if (!validation.ok) {
    return { card: null, reasons: validation.reasons };
  }
  return { card: parsed as FactCard, reasons: [] };
}

/**
 * Extracts one Fact Card for a single chunk with at most one repair retry.
 * Throws only on transport/Ollama errors (recorded as failures by the
 * caller); validation failures yield `{ok:false}` with reasons, never a
 * fabricated card.
 */
export async function extractFactCard(
  chunk: FactCardChunkInput,
  sourcePageCount: number,
  options: FactCardClientOptions = {},
): Promise<FactCardExtractionResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? OLLAMA_BASE_URL;
  const temperature = options.temperature ?? 0;
  const maxOutputTokens = options.maxOutputTokens ?? 1024;
  const started = performance.now();

  const firstBody = {
    model: OLLAMA_MODEL,
    prompt: `${buildFactCardPrompt(chunk.chunkIndex, chunk.pageNumber)}\n\n${renderContext(chunk)}`,
    stream: false,
    format: "json",
    options: { temperature, num_predict: maxOutputTokens },
  };
  const first = await postGenerate(fetchImpl, baseUrl, firstBody);
  const firstAttempt = tryParseAndValidate(first.response, chunk, sourcePageCount);
  if (firstAttempt.card) {
    return {
      card: firstAttempt.card,
      ok: true,
      firstTryValid: true,
      repaired: false,
      reasons: [],
      rawOutput: first.response,
      repairRawOutput: null,
      inputTokens: typeof first.prompt_eval_count === "number" ? first.prompt_eval_count : null,
      outputTokens: typeof first.eval_count === "number" ? first.eval_count : null,
      generationMs: performance.now() - started,
    };
  }

  const repairBody = {
    model: OLLAMA_MODEL,
    prompt: `${buildFactCardRepairPrompt(firstAttempt.reasons.join("; "))}\n\n${renderContext(chunk)}`,
    stream: false,
    format: "json",
    options: { temperature: 0, num_predict: maxOutputTokens },
  };
  const repair = await postGenerate(fetchImpl, baseUrl, repairBody);
  const secondAttempt = tryParseAndValidate(repair.response, chunk, sourcePageCount);
  if (secondAttempt.card) {
    return {
      card: secondAttempt.card,
      ok: true,
      firstTryValid: false,
      repaired: true,
      reasons: [],
      rawOutput: first.response,
      repairRawOutput: repair.response,
      inputTokens:
        typeof repair.prompt_eval_count === "number" ? repair.prompt_eval_count : null,
      outputTokens: typeof repair.eval_count === "number" ? repair.eval_count : null,
      generationMs: performance.now() - started,
    };
  }

  return {
    card: null,
    ok: false,
    firstTryValid: false,
    repaired: false,
    reasons: [...firstAttempt.reasons, ...secondAttempt.reasons.map((r) => `repair: ${r}`)],
    rawOutput: first.response,
    repairRawOutput: repair.response,
    inputTokens: null,
    outputTokens: null,
    generationMs: performance.now() - started,
  };
}
