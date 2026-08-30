/**
 * AI-02 — Named safety-bound constants for text extraction/chunking.
 *
 * Kept as a single source of truth so limits aren't scattered as magic
 * numbers across extraction.ts/chunking.ts/pipeline.ts. These are
 * deliberately conservative starting values, not final production-tuned
 * numbers — the repository does not yet define any of these elsewhere, so
 * there is nothing existing to match. Adjust here if a later checkpoint
 * needs different bounds.
 */

/** Maximum characters in a single AiContextChunk. */
export const MAX_CHUNK_CHARACTERS = 4000;

/** Maximum number of chunks produced for a single AI context build. */
export const MAX_CHUNKS_PER_REQUEST = 200;

/** Maximum total characters across all chunks returned for a single AI context build. */
export const MAX_TOTAL_CONTEXT_CHARACTERS = 200_000;
