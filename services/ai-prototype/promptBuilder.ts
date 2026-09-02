/**
 * Checkpoint 2A — Prototype prompt construction.
 *
 * Pure, dependency-free, synchronous. Builds the chat-style message list
 * handed to the Transformers.js pipeline's `generateText`/`pipeline()`
 * call for the single "summarize the supplied document context"
 * operation (checkpoint spec §6).
 *
 * Prompt-injection safety (checkpoint spec §18): extracted PDF text is
 * untrusted document data. This module keeps it in a clearly delimited
 * "document context" section, separate from the system instruction, and
 * the system instruction explicitly tells the model not to treat that
 * section as commands. This is NOT a robust defense against a
 * sufficiently adversarial document — no prompt-level delimiting is —
 * but it satisfies the checkpoint's actual requirement: don't construct
 * the prompt so that document content is indistinguishable from system
 * instructions, and don't let model output trigger application actions
 * (this prototype only ever displays text — see browserAiWorkerClient.ts).
 */

import type { AiContextChunk } from "@/services/ai/types";
import { PROTOTYPE_SYSTEM_INSTRUCTION } from "./constants";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

const DOCUMENT_CONTEXT_START = "<<<DOCUMENT_CONTEXT_START>>>";
const DOCUMENT_CONTEXT_END = "<<<DOCUMENT_CONTEXT_END>>>";

/**
 * Renders `AiContextChunk[]` (already-extracted, already-chunked,
 * already-bounded plain text — see `services/ai/pipeline.ts`) into a
 * single delimited block, in chunk order, with lightweight page
 * attribution. Never receives or touches anything but `chunkIndex`,
 * `pageNumber`, and `text` — the exact shape AI-01/AI-02 already
 * restrict document-derived data to.
 */
export function renderDocumentContextBlock(chunks: AiContextChunk[]): string {
  const body = chunks
    .slice()
    .sort((a, b) => a.chunkIndex - b.chunkIndex)
    .map((chunk) => `[page ${chunk.pageNumber}] ${chunk.text}`)
    .join("\n\n");

  return `${DOCUMENT_CONTEXT_START}\n${body}\n${DOCUMENT_CONTEXT_END}`;
}

export interface BuildSummarizePromptOptions {
  chunks: AiContextChunk[];
  /** Whether any pages had no extractable text — surfaced so the model (and the user reading the response) knows the context may be incomplete, rather than silently pretending it's exhaustive. */
  hasPagesWithoutText: boolean;
  /** Whether the context was truncated by AI-02's chunk/character bounds — same rationale. */
  wasTruncated: boolean;
}

/**
 * Builds the fixed three-message chat prompt for the single prototype
 * operation. There is deliberately no user-editable prompt box (that is
 * AI-03, out of scope here) — the "user" message is a fixed instruction,
 * not free text.
 */
export function buildSummarizePrompt(options: BuildSummarizePromptOptions): ChatMessage[] {
  const { chunks, hasPagesWithoutText, wasTruncated } = options;

  if (chunks.length === 0) {
    throw new Error(
      "No extractable text was found for the selected page(s) — nothing to summarize.",
    );
  }

  const caveats: string[] = [];
  if (hasPagesWithoutText) {
    caveats.push(
      "Note: one or more pages had no extractable text (e.g. scanned/image-only) and are not included below.",
    );
  }
  if (wasTruncated) {
    caveats.push(
      "Note: the document context was truncated to stay within this prototype's size bounds; it may not cover the whole document.",
    );
  }

  const documentContextBlock = renderDocumentContextBlock(chunks);
  const userContent = [
    "Summarize the document context below.",
    ...caveats,
    "",
    documentContextBlock,
  ].join("\n");

  return [
    { role: "system", content: PROTOTYPE_SYSTEM_INSTRUCTION },
    { role: "user", content: userContent },
  ];
}

/**
 * Checkpoint 2A/2B — Map -> Reduce experiment (PROTOTYPE ONLY, additive).
 *
 * `buildMapSummarizePrompt` and `buildReducePrompt` below do not change
 * `buildSummarizePrompt` or `renderDocumentContextBlock` above in any
 * way — they are new, separate prompt shapes for the sequential
 * Map -> Reduce architecture being validated (see
 * `./mapReduceRunner.ts`), reusing the same delimited-document-context
 * pattern and the same fixed `PROTOTYPE_SYSTEM_INSTRUCTION` rather than
 * inventing a second system instruction.
 */

export interface BuildMapSummarizePromptOptions {
  /** The chunks belonging to THIS batch only (already sliced by the caller — see mapReduceRunner.ts). */
  chunks: AiContextChunk[];
  /** Zero-based index of this batch among all Map batches. */
  batchIndex: number;
  /** Total number of Map batches for this run. */
  batchCount: number;
  /** Whether any page in the OVERALL document (not just this batch) had no extractable text. */
  hasPagesWithoutText: boolean;
  /** Whether the OVERALL AI-02 context was truncated by chunk/character bounds. */
  wasTruncated: boolean;
}

/**
 * Builds the chat prompt for a single Map-stage generation: summarize
 * only the chunks in this one bounded batch. Explicitly tells the model
 * it is seeing part of a longer document (not the whole thing) so it
 * does not fabricate coverage of content outside this batch — the
 * resulting intermediate summary is combined with the others later by
 * `buildReducePrompt`.
 */
export function buildMapSummarizePrompt(options: BuildMapSummarizePromptOptions): ChatMessage[] {
  const { chunks, batchIndex, batchCount, hasPagesWithoutText, wasTruncated } = options;

  if (chunks.length === 0) {
    throw new Error("Map batch received no chunks — nothing to summarize.");
  }

  const caveats: string[] = [
    `This is part ${batchIndex + 1} of ${batchCount} of a longer document. Summarize ONLY the ` +
      "portion shown below — do not assume you have seen the rest of the document, and do not " +
      "claim to describe content that is not shown here.",
  ];
  if (hasPagesWithoutText) {
    caveats.push(
      "Note: one or more pages of the overall document had no extractable text (e.g. scanned/image-only) and are not included in this run.",
    );
  }
  if (wasTruncated) {
    caveats.push(
      "Note: the overall document context was truncated to stay within this prototype's size bounds; it may not cover the whole document.",
    );
  }

  const documentContextBlock = renderDocumentContextBlock(chunks);
  const userContent = [
    `Summarize the document context below (part ${batchIndex + 1}/${batchCount}).`,
    ...caveats,
    "",
    documentContextBlock,
  ].join("\n");

  return [
    { role: "system", content: PROTOTYPE_SYSTEM_INSTRUCTION },
    { role: "user", content: userContent },
  ];
}

const INTERMEDIATE_SUMMARIES_START = "<<<INTERMEDIATE_SUMMARIES_START>>>";
const INTERMEDIATE_SUMMARIES_END = "<<<INTERMEDIATE_SUMMARIES_END>>>";

export interface BuildReducePromptOptions {
  /** Intermediate Map-stage summaries, in batch order. */
  summaries: string[];
}

/**
 * Builds the chat prompt for the single Reduce-stage generation:
 * synthesize the ordered intermediate summaries into one coherent final
 * summary. Model-generated intermediate summaries are still treated as
 * data to be delimited (not as instructions), for the same reason
 * extracted document text is delimited in `renderDocumentContextBlock` —
 * see the prompt-injection-safety note at the top of this file.
 */
export function buildReducePrompt(options: BuildReducePromptOptions): ChatMessage[] {
  const { summaries } = options;

  if (summaries.length === 0) {
    throw new Error("Reduce received no intermediate summaries — nothing to combine.");
  }

  const body = summaries
    .map((summary, index) => `[part ${index + 1}/${summaries.length}]\n${summary}`)
    .join("\n\n");
  const summariesBlock = `${INTERMEDIATE_SUMMARIES_START}\n${body}\n${INTERMEDIATE_SUMMARIES_END}`;

  const userContent = [
    `Below are ${summaries.length} partial summaries of consecutive parts of the same document, in order.`,
    "Combine them into a single coherent overall summary of the whole document.",
    "Do not simply concatenate them, and do not repeat the part labels — synthesize one summary.",
    "",
    summariesBlock,
  ].join("\n");

  return [
    { role: "system", content: PROTOTYPE_SYSTEM_INSTRUCTION },
    { role: "user", content: userContent },
  ];
}
