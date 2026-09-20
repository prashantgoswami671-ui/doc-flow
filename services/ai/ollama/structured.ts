/**
 * V6-F02 — Ollama structured generation for the frozen Stage-1/Stage-2
 * contracts (provider-local).
 *
 * The compatibility investigation on this setup showed `think: false`
 * plus a JSON Schema `format` is required for qwen3:4b to emit the
 * frozen shapes (bare `"json"` mode and unconstrained generation both
 * failed the contract). These schemas constrain model output only —
 * C02/B03 validation remains authoritative downstream, and no repair
 * or fallback lives here.
 *
 * Schema field discipline mirrors the frozen contracts exactly:
 * - Stage-1: bare string array (no IDs, pages, kinds, values).
 * - Stage-2: exactly `kind` (`fact`/`conclusion`), `text`,
 *   `evidenceIds` (string array); `additionalProperties: false`;
 *   no excerpt/pages/value/unit/evidenceId/causal/comparison/
 *   attribution fields anywhere.
 */

import { OllamaRuntime } from "./runtime";
import type { OllamaJsonSchema } from "./types";

/** Thrown for malformed structured-generation input (caller error). */
export class OllamaStructuredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OllamaStructuredError";
  }
}

/**
 * Stage-1 transport schema: EXACTLY the frozen bare string-array
 * candidate contract. Matches the experimentally validated shape.
 */
export const STAGE1_SPANS_SCHEMA: OllamaJsonSchema = Object.freeze({
  type: "array",
  items: Object.freeze({ type: "string" }),
});

/**
 * Stage-2 transport schema: EXACTLY the frozen `Stage2Claim[]`
 * contract (C01). `kind` is closed to `fact`/`conclusion`;
 * `additionalProperties: false` keeps forbidden fields out at the
 * transport layer while C02 stays authoritative.
 */
export const STAGE2_CLAIMS_SCHEMA: OllamaJsonSchema = Object.freeze({
  type: "array",
  items: Object.freeze({
    type: "object",
    properties: Object.freeze({
      kind: Object.freeze({ type: "string", enum: Object.freeze(["fact", "conclusion"]) }),
      text: Object.freeze({ type: "string" }),
      evidenceIds: Object.freeze({
        type: "array",
        items: Object.freeze({ type: "string" }),
      }),
    }),
    required: Object.freeze(["kind", "text", "evidenceIds"]),
    additionalProperties: false,
  }),
});

function assertOllamaRuntime(runtime: unknown): asserts runtime is OllamaRuntime {
  if (!(runtime instanceof OllamaRuntime)) {
    throw new OllamaStructuredError("Structured generation requires an OllamaRuntime.");
  }
}

/**
 * Runs one Stage-1 evidence-acquisition generation with the validated
 * transport (`think: false` + bare-array schema). Returns the raw
 * model text for B03 parsing/admission downstream — unvalidated here.
 */
export async function generateStage1SpansText(
  runtime: unknown,
  prompt: unknown,
  maxOutputTokens: unknown,
): Promise<string> {
  assertOllamaRuntime(runtime);
  if (typeof prompt !== "string" || prompt.length === 0) {
    throw new OllamaStructuredError("Stage-1 structured generation requires a prompt.");
  }
  if (!Number.isSafeInteger(maxOutputTokens) || (maxOutputTokens as number) < 1) {
    throw new OllamaStructuredError("Stage-1 structured generation requires a token bound.");
  }
  return runtime.generateStructuredText({
    prompt,
    format: STAGE1_SPANS_SCHEMA,
    settings: { temperature: 0, maxOutputTokens: maxOutputTokens as number },
  });
}

/**
 * Runs one Stage-2 claim generation with the validated transport
 * (`think: false` + claims schema). Returns the raw model text for
 * C02 validation downstream — unvalidated here.
 */
export async function generateStage2ClaimsText(
  runtime: unknown,
  prompt: unknown,
  maxOutputTokens: unknown,
): Promise<string> {
  assertOllamaRuntime(runtime);
  if (typeof prompt !== "string" || prompt.length === 0) {
    throw new OllamaStructuredError("Stage-2 structured generation requires a prompt.");
  }
  if (!Number.isSafeInteger(maxOutputTokens) || (maxOutputTokens as number) < 1) {
    throw new OllamaStructuredError("Stage-2 structured generation requires a token bound.");
  }
  return runtime.generateStructuredText({
    prompt,
    format: STAGE2_CLAIMS_SCHEMA,
    settings: { temperature: 0, maxOutputTokens: maxOutputTokens as number },
  });
}
