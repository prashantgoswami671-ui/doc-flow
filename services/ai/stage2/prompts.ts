/**
 * V6-E01 — Provider-agnostic Stage-1 / Stage-2 instruction builders.
 *
 * Pure prompt construction only: no provider, no network, no DOM, no
 * PDF parsing, no Evidence Store access. The builders produce the
 * exact model-visible strings; deterministic gates (B03 admission,
 * C02 validation, C03 grounding) remain authoritative downstream.
 *
 * - Stage 1 asks for a bare JSON array of exact source-span strings.
 *   The model never mints IDs, pages, kinds, values, or commentary.
 * - Stage 2 reasons over trusted `Stage2Input` evidence only and must
 *   emit exactly the frozen `Stage2Claim` schema (IDs cited, never
 *   copied text). No raw document context is included. V7-A04: each
 *   evidence entry additionally carries descriptive `sourcePage` /
 *   `chunk` locators (plus the document `sourcePageCount`) for coverage
 *   awareness — context only, never claim fields. (V7-A04.2: named
 *   `sourcePage`, not `page`, per the V7-A04.1 stability finding.)
 */

import type { Stage2Input } from "./types";

/** Thrown for malformed prompt-builder input (caller error, fail-loud). */
export class Stage2PromptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Stage2PromptError";
  }
}

const STAGE1_INSTRUCTION =
  "Copy exact source spans from the document chunk below. " +
  "Return ONLY a JSON array of strings, where each string is copied " +
  "character-for-character from the chunk. " +
  "Rules: identify useful exact source spans; copy them exactly with no " +
  "rewording; return at least 3 independently useful exact spans when " +
  "the chunk contains more than two useful facts; prefer distinct spans " +
  "over duplicate copies; if fewer useful spans exist, return only those; " +
  "return only the array; do not explain, classify, or " +
  "comment on the spans; do not invent IDs, page numbers, values, or " +
  "metadata; do not add surrounding commentary. " +
  'Example output: ["The exact source span...", "Another exact source span..."].';

/**
 * Builds the Stage-1 evidence-acquisition prompt for one chunk.
 * The chunk text is the ONLY document text the model sees in E01.
 */
export function buildStage1EvidencePrompt(chunkText: unknown): string {
  if (typeof chunkText !== "string" || chunkText.length === 0) {
    throw new Stage2PromptError("Stage-1 prompt requires non-empty chunk text.");
  }
  return `${STAGE1_INSTRUCTION}\n\nDocument chunk:\n${chunkText}`;
}

const STAGE2_INSTRUCTION =
  "Reason over the trusted evidence below and produce concise summary claims. " +
  "The pool holds selected document evidence; each entry carries descriptive " +
  "sourcePage (source page number) and chunk locators so the summary can cover the " +
  "whole document broadly — avoid concentrating the entire summary on one page " +
  "when evidence from other pages is available. " +
  "Rules: every claim must cite one or more supplied evidenceIds, copied " +
  "exactly character-for-character from the evidence pool; never invent an " +
  "ID; never emit source excerpts, exact text, pages, values, or units as " +
  "claim fields; sourcePage and chunk locators are context only and must never " +
  "appear as claim fields; claim text is your own concise restatement, never presented " +
  "as source wording; produce ONLY a JSON array of claims with exactly " +
  'these keys: {"kind": "fact" | "conclusion", "text": "...", ' +
  '"evidenceIds": ["..."]}; do not request or perform comparison, ' +
  "attribution, or causal reasoning; no prose, no markdown fences, only the array.";

function assertValidStage2Input(input: unknown): asserts input is Stage2Input {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Stage2PromptError("Stage-2 prompt requires a Stage2Input object.");
  }
  const { evidence, task, sourcePageCount } = input as Record<string, unknown>;
  if (!Array.isArray(evidence) || evidence.length === 0) {
    throw new Stage2PromptError("Stage-2 prompt requires non-empty evidence.");
  }
  if (task !== "summarize") {
    throw new Stage2PromptError("Stage-2 prompt supports the summarize task only.");
  }
  if (!Number.isSafeInteger(sourcePageCount) || (sourcePageCount as number) < 1) {
    throw new Stage2PromptError("Stage-2 prompt requires a positive sourcePageCount.");
  }
  for (const [index, item] of evidence.entries()) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Stage2PromptError(`Stage-2 evidence[${index}] is malformed.`);
    }
    const view = item as Record<string, unknown>;
    if (typeof view["evidenceId"] !== "string" || typeof view["exactText"] !== "string") {
      throw new Stage2PromptError(`Stage-2 evidence[${index}] is malformed.`);
    }
    // Descriptive coverage locators (V7-A04, renamed V7-A04.2):
    // shape-checked here, sourced authoritatively upstream — never
    // trusted from the model.
    if (!Number.isSafeInteger(view["sourcePage"]) || (view["sourcePage"] as number) < 1) {
      throw new Stage2PromptError(`Stage-2 evidence[${index}] needs a positive sourcePage.`);
    }
    if (!Number.isSafeInteger(view["chunk"]) || (view["chunk"] as number) < 0) {
      throw new Stage2PromptError(`Stage-2 evidence[${index}] needs a chunk index.`);
    }
  }
}

/**
 * Builds the Stage-2 summarization prompt from frozen `Stage2Input`.
 * Serializes the evidence views (ID + exact text + kind + value +
 * descriptive sourcePage/chunk locators only — no provenance arrays, no raw
 * chunk text) followed by the claim contract and the document page
 * denominator.
 */
export function buildStage2SummarizePrompt(input: unknown): string {
  assertValidStage2Input(input);
  const pool = (input.evidence as readonly unknown[]).map((entry) => {
    const view = entry as Record<string, unknown>;
    const projected: Record<string, unknown> = {
      evidenceId: view["evidenceId"],
      exactText: view["exactText"],
      kind: view["kind"],
    };
    if (typeof view["value"] === "string") {
      projected["value"] = view["value"];
    }
    projected["sourcePage"] = view["sourcePage"];
    projected["chunk"] = view["chunk"];
    return projected;
  });
  return (
    `${STAGE2_INSTRUCTION}\n\nTrusted evidence pool:\n${JSON.stringify(pool)}\n\n` +
    `Task: ${input.task} (${input.sourcePageCount} pages)`
  );
}
