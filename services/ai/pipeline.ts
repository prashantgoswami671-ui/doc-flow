/**
 * AI-02 — PDF → browser-side text extraction → bounded chunking → AI-safe
 * text context.
 *
 * This is the orchestration layer that ties `./extraction.ts` and
 * `./chunking.ts` together into the single conceptual pipeline described
 * in the checkpoint spec:
 *
 *   PDF
 *    -> PDF.js text extraction
 *    -> page-aware text representation
 *    -> bounded chunking
 *    -> AI-safe text context
 *
 * Like its two inputs, this module calls no AI provider and makes no
 * network request — it only produces the `AiContextChunk[]` shape AI-01
 * (`./types.ts`) accepts. Wiring this output into an actual
 * `AiRuntime.generateText()` call is future work (a later checkpoint).
 */

import { extractDocumentText } from "./extraction";
import { applyTotalCharacterBudget, chunkPageTexts } from "./chunking";
import type { AiContextChunk } from "./types";
import {
  MAX_CHUNK_CHARACTERS,
  MAX_CHUNKS_PER_REQUEST,
  MAX_TOTAL_CONTEXT_CHARACTERS,
} from "./constants";

export interface BuildAiTextContextOptions {
  /** One-based page numbers to include. Omit for every page — see `ExtractDocumentTextOptions`. */
  pageNumbers?: number[];
  maxChunkCharacters?: number;
  maxChunks?: number;
  maxTotalCharacters?: number;
}

export interface BuildAiTextContextResult {
  chunks: AiContextChunk[];
  sourcePageCount: number;
  /** One-based page numbers that had no extractable text (scanned/image-only, or a per-page extraction failure). */
  pagesWithoutText: number[];
  /** True when either the per-request chunk-count limit or the total-character budget caused chunks to be omitted. */
  truncated: boolean;
  totalCharacters: number;
  processingTime: number;
}

/**
 * Builds a bounded, page-aware AI text context from a PDF file. This is
 * the single entry point future prompt/preset UIs (AI-03 onward) are
 * expected to call before constructing an `AiTextGenerationRequest`.
 */
export async function buildAiTextContext(
  file: File,
  options: BuildAiTextContextOptions = {},
): Promise<BuildAiTextContextResult> {
  const extraction = await extractDocumentText(file, {
    pageNumbers: options.pageNumbers,
  });

  const chunkResult = chunkPageTexts(extraction.pages, {
    maxChunkCharacters: options.maxChunkCharacters ?? MAX_CHUNK_CHARACTERS,
    maxChunks: options.maxChunks ?? MAX_CHUNKS_PER_REQUEST,
  });

  const bounded = applyTotalCharacterBudget(
    chunkResult.chunks,
    options.maxTotalCharacters ?? MAX_TOTAL_CONTEXT_CHARACTERS,
  );

  const pagesWithoutText = extraction.pages
    .filter((page) => !page.hasExtractableText)
    .map((page) => page.pageNumber);

  return {
    chunks: bounded.chunks,
    sourcePageCount: extraction.sourcePageCount,
    pagesWithoutText,
    truncated: chunkResult.truncated || bounded.truncated,
    totalCharacters: bounded.totalCharacters,
    processingTime: extraction.processingTime,
  };
}
