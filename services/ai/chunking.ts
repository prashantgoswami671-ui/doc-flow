/**
 * AI-02 — Bounded, page-aware chunking.
 *
 * Turns the page-text output of `./extraction.ts` into bounded
 * `AiContextChunk`s (see `./types.ts`) safe to hand to the AI-01
 * abstraction later. Pure, synchronous, dependency-free — no PDF.js, no
 * network, no AI provider call.
 */

import type { PageTextResult } from "./extraction";
import type { AiContextChunk } from "./types";
import {
  MAX_CHUNK_CHARACTERS,
  MAX_CHUNKS_PER_REQUEST,
  MAX_TOTAL_CONTEXT_CHARACTERS,
} from "./constants";

export interface ChunkPageTextsOptions {
  /** Maximum characters per chunk. Defaults to `MAX_CHUNK_CHARACTERS`. */
  maxChunkCharacters?: number;
  /** Maximum number of chunks to produce. Defaults to `MAX_CHUNKS_PER_REQUEST`. */
  maxChunks?: number;
}

export interface ChunkPageTextsResult {
  chunks: AiContextChunk[];
  /** True when chunk generation stopped early because `maxChunks` was reached — later pages/text were not chunked. */
  truncated: boolean;
  totalCharacters: number;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
}

/**
 * Splits each page's extracted text into bounded, page-aware chunks in
 * page order. Chunk boundaries are simple fixed-size character windows —
 * this deliberately does not attempt sentence/paragraph-aware splitting
 * or any semantic retrieval; see AI-02 scope notes in the checkpoint
 * spec ("do not build a full semantic retrieval engine yet").
 */
export function chunkPageTexts(
  pages: PageTextResult[],
  options: ChunkPageTextsOptions = {},
): ChunkPageTextsResult {
  const maxChunkCharacters = options.maxChunkCharacters ?? MAX_CHUNK_CHARACTERS;
  const maxChunks = options.maxChunks ?? MAX_CHUNKS_PER_REQUEST;

  assertPositiveInteger(maxChunkCharacters, "maxChunkCharacters");
  assertPositiveInteger(maxChunks, "maxChunks");

  const chunks: AiContextChunk[] = [];
  let totalCharacters = 0;
  let truncated = false;

  pageLoop: for (const page of pages) {
    if (!page.text) {
      continue;
    }

    let offset = 0;

    while (offset < page.text.length) {
      if (chunks.length >= maxChunks) {
        truncated = true;
        break pageLoop;
      }

      const end = Math.min(offset + maxChunkCharacters, page.text.length);
      const text = page.text.slice(offset, end);

      chunks.push({
        chunkIndex: chunks.length,
        pageNumber: page.pageNumber,
        text,
        startOffset: offset,
        endOffset: end,
      });

      totalCharacters += text.length;
      offset = end;
    }
  }

  return { chunks, truncated, totalCharacters };
}

export interface BoundedChunksResult {
  chunks: AiContextChunk[];
  /** True when one or more trailing chunks were dropped to stay within the total-character budget. */
  truncated: boolean;
  totalCharacters: number;
}

/**
 * Applies a total-character budget across an already-chunked list,
 * dropping trailing chunks (never truncating a chunk's own text) once
 * the budget would be exceeded. Kept separate from `chunkPageTexts` so
 * per-chunk bounds and total-context bounds can be reasoned about and
 * tested independently.
 */
export function applyTotalCharacterBudget(
  chunks: AiContextChunk[],
  maxTotalCharacters: number = MAX_TOTAL_CONTEXT_CHARACTERS,
): BoundedChunksResult {
  assertPositiveInteger(maxTotalCharacters, "maxTotalCharacters");

  const bounded: AiContextChunk[] = [];
  let totalCharacters = 0;
  let truncated = false;

  for (const chunk of chunks) {
    if (totalCharacters + chunk.text.length > maxTotalCharacters) {
      truncated = true;
      break;
    }

    bounded.push(chunk);
    totalCharacters += chunk.text.length;
  }

  return { chunks: bounded, truncated, totalCharacters };
}
