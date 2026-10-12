import { buildAiTextContext } from "./pipeline";
import { buildAiInstructionPrompt } from "./instructions";
import type { AiContextChunk, AiRuntime } from "./types";

export const SUPPORTED_TRANSLATION_LANGUAGES = [
  "English",
  "Hindi",
  "Bengali",
  "Gujarati",
  "Marathi",
  "Tamil",
  "Telugu",
  "Kannada",
  "Malayalam",
  "Punjabi",
  "Urdu",
  "Odia",
  "Spanish",
  "French",
  "German",
  "Portuguese",
  "Arabic",
  "Chinese",
  "Japanese",
  "Korean",
] as const;

export type TranslationLanguage = (typeof SUPPORTED_TRANSLATION_LANGUAGES)[number];

export function isTranslationLanguage(value: unknown): value is TranslationLanguage {
  return (
    typeof value === "string" &&
    (SUPPORTED_TRANSLATION_LANGUAGES as readonly string[]).includes(value)
  );
}

export function assertTranslationLanguage(value: unknown): asserts value is TranslationLanguage {
  if (!isTranslationLanguage(value)) {
    throw new Error("Select one of the supported translation languages.");
  }
}

export type TranslatedChunkStatus = "translated" | "failed" | "cancelled" | "truncated";

/**
 * Phase 0 translation-quality settings. Passed per-request from
 * `translatePdf` so the shared Ollama defaults (temperature 0.7, 2048
 * tokens — tuned for summarization) and the frozen summarization
 * pipeline are untouched.
 *
 * Temperature 0 makes translation deterministic. The output token
 * budget uses the full Ollama ceiling: page-scoped inputs can be
 * several thousand characters, and a cut-off budget produces exactly
 * the silent truncation this phase must surface via done_reason
 * "length" instead.
 */
export const TRANSLATION_TEMPERATURE = 0;
export const TRANSLATION_MAX_OUTPUT_TOKENS = 8192;

export interface TranslatedChunk {
  chunkIndex: number;
  pageNumber: number;
  startOffset: number;
  endOffset: number;
  sourceText: string;
  translatedText: string;
  status: TranslatedChunkStatus;
  error?: string;
}

export interface TranslatePdfResult {
  status: "ready" | "partial" | "cancelled" | "no-text" | "provider-failed";
  targetLanguage: TranslationLanguage;
  chunks: TranslatedChunk[];
  sourcePageCount: number;
  pagesWithoutText: number[];
  truncated: boolean;
  failedChunkIndexes: number[];
  cancelled: boolean;
  providerError?: string;
}

export interface TranslatePdfOptions {
  file: File;
  targetLanguage: TranslationLanguage;
  runtime: AiRuntime;
  onProgress?: (completed: number, total: number) => void;
  isCancellationRequested?: () => boolean;
}

function isCancellationError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /cancelled|canceled|disposed/i.test(`${error.name} ${error.message}`)
  );
}

function isProviderFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /AiRuntimeUnavailableError|AiModelInitializationError|AiGenerationError|OllamaClientError|OllamaModelNotFoundError|OllamaGenerationError|OllamaRuntimeDisposedError|AiRequestValidationError|ProhibitedAiRequestFieldError/i.test(
    error.name,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Translation failed.";
}

function hasUnbalancedDelimiters(text: string): boolean {
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const closers = new Set(Object.values(pairs));
  const stack: string[] = [];
  for (const character of text) {
    if (pairs[character]) stack.push(pairs[character]);
    else if (closers.has(character) && stack.pop() !== character) return true;
  }
  return stack.length > 0;
}

/**
 * True only when the runtime explicitly reported output truncation
 * (Ollama done_reason "length"). Detected safely via an `in`-check so
 * runtimes without the provider-local field (Browser AI) behave
 * exactly as before. Checked after the empty-text guard, so empty
 * output keeps the existing "failed" handling.
 */
function isOutputTruncated(result: { text: string }): boolean {
  return (
    "outputTruncated" in (result as unknown as Record<string, unknown>) &&
    (result as unknown as Record<string, unknown>).outputTruncated === true
  );
}

/**
 * True when the runtime dropped trailing source chunks to fit its own
 * input budget (Ollama `contextTruncated`). Previously ignored by
 * Translate — source content was silently untranslated while the chunk
 * could still be marked "translated". Now surfaces as truncation.
 */
function isSourceTruncated(result: { text: string }): boolean {
  return (
    "contextTruncated" in (result as unknown as Record<string, unknown>) &&
    (result as unknown as Record<string, unknown>).contextTruncated === true
  );
}

/**
 * Phase 0 output validator: reasoning leakage.
 *
 * `think: false` keeps qwen3's reasoning out of the Ollama response
 * envelope, but the model can still emit `<think>` blocks or reasoning
 * prose as response text. Those blocks are removed here; anything that
 * remains must still pass every other validator before it can be
 * marked "translated". A response that is only reasoning cleans down
 * to empty and is handled as "failed" by the caller.
 */
const THINK_BLOCK_PATTERN = /<think\b[^>]*>[\s\S]*?(<\/think\s*>|$)/i;
const THINK_TAG_GLOBAL_PATTERN =
  /<think\b[^>]*>[\s\S]*?(?:<\/think\s*>|$)|<\/?think\b[^>]*>/gi;

export function stripReasoningLeakage(text: string): {
  cleaned: string;
  hadLeakage: boolean;
} {
  const hadLeakage =
    THINK_BLOCK_PATTERN.test(text) || /<\/?think\b/i.test(text);
  const cleaned = text
    .replace(THINK_TAG_GLOBAL_PATTERN, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { cleaned, hadLeakage };
}

function normalizeForComparison(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Phase 0 output validator: untranslated echo.
 *
 * Fails closed when the provider returned the source text unchanged
 * (exact match after case/whitespace normalization), or wrapped it in
 * a short label (output contains the full source and is at most 40
 * characters longer). Longer outputs that merely quote the source are
 * not flagged — this check targets no-translation, not style.
 */
export function isUntranslatedEcho(source: string, cleaned: string): boolean {
  const normalizedSource = normalizeForComparison(source);
  const normalizedCleaned = normalizeForComparison(cleaned);
  if (!normalizedSource || !normalizedCleaned) return false;
  if (normalizedSource === normalizedCleaned) return true;
  return (
    normalizedSource.length >= 20 &&
    normalizedCleaned.includes(normalizedSource) &&
    normalizedCleaned.length <= normalizedSource.length + 40
  );
}

/**
 * Expected script per target language, used to catch the provider
 * answering in the source language (e.g. English output for a Bengali
 * request). Latin-script targets have no entry: English/Spanish/French
 * output cannot be distinguished from untranslated English source by
 * script, so this check skips them rather than guessing.
 *
 * Outputs shorter than `MIN_CHARS_FOR_SCRIPT_CHECK` skip the check:
 * a terse but correct translation ("Sí.") carries no script signal.
 */
const TARGET_SCRIPT_PATTERNS: Partial<Record<TranslationLanguage, RegExp>> = {
  Bengali: /[\u0980-\u09FF]/,
  Hindi: /[\u0900-\u097F]/,
  Marathi: /[\u0900-\u097F]/,
  Gujarati: /[\u0A80-\u0AFF]/,
  Tamil: /[\u0B80-\u0BFF]/,
  Telugu: /[\u0C00-\u0C7F]/,
  Kannada: /[\u0C80-\u0CFF]/,
  Malayalam: /[\u0D00-\u0D7F]/,
  Punjabi: /[\u0A00-\u0A7F]/,
  Urdu: /[\u0600-\u06FF]/,
  Arabic: /[\u0600-\u06FF]/,
  Odia: /[\u0B00-\u0B7F]/,
  Chinese: /[\u4E00-\u9FFF]/,
  Japanese: /[\u3040-\u30FF\u4E00-\u9FFF]/,
  Korean: /[\u1100-\u11FF\uAC00-\uD7AF]/,
};

export const MIN_CHARS_FOR_SCRIPT_CHECK = 24;

export function lacksTargetScript(
  targetLanguage: TranslationLanguage,
  cleaned: string,
): boolean {
  const pattern = TARGET_SCRIPT_PATTERNS[targetLanguage];
  if (!pattern) return false;
  const trimmed = cleaned.trim();
  if (trimmed.length < MIN_CHARS_FOR_SCRIPT_CHECK) return false;
  return !pattern.test(trimmed);
}

/**
 * Short-period loop check: some base string (10-60 chars) tiled from
 * the start covers most of the text. Catches full-output loops whose
 * repeated sentence is too short for the sentence-triplication signal
 * above (e.g. "El informe anual. " x 8). Linear scan, no backtracking.
 */
function hasTiledLoop(text: string): boolean {
  const maxBaseLength = Math.min(60, Math.floor(text.length / 3));
  for (let baseLength = 10; baseLength <= maxBaseLength; baseLength += 1) {
    const base = text.slice(0, baseLength);
    let covered = baseLength;
    while (covered + baseLength <= text.length && text.startsWith(base, covered)) {
      covered += baseLength;
    }
    if (covered >= baseLength * 3 && covered >= text.length * 0.6) return true;
  }
  return false;
}

/**
 * Phase 0 output validator: pathological repetition (model loop).
 *
 * Four independent signals; any one fails the output. Short outputs
 * (< 60 chars) skip the check — legitimate short translations can
 * repeat a word ("yes yes yes") without being a loop.
 */
export function hasPathologicalRepetition(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 60) return false;

  // Same token repeated consecutively 7+ times ("the the the ...").
  if (/\b(\S+)(?:\s+\1){6,}\b/i.test(trimmed)) return true;

  // A full sentence/segment (>= 20 chars) appearing 3+ times.
  const segments = trimmed
    .split(/(?<=[.!?।])\s+|\n+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length >= 20);
  const segmentCounts = new Map<string, number>();
  for (const segment of segments) {
    const count = (segmentCounts.get(segment) ?? 0) + 1;
    if (count >= 3) return true;
    segmentCounts.set(segment, count);
  }

  // Short-period full-output loop (see hasTiledLoop).
  if (hasTiledLoop(trimmed)) return true;

  // A 40-char window recurring 3+ times (covers loops without
  // sentence boundaries). Sampled every 20 chars to stay linear.
  const windowCounts = new Map<string, number>();
  for (let i = 0; i + 40 <= trimmed.length; i += 20) {
    const window = trimmed.slice(i, i + 40);
    if (/^\s*$/.test(window)) continue;
    const count = (windowCounts.get(window) ?? 0) + 1;
    if (count >= 3) return true;
    windowCounts.set(window, count);
  }

  return false;
}

/**
 * Heuristic incompleteness check. Phase 0 extends the previous
 * Browser-only guards (unbalanced delimiters, trailing `,;:`) to every
 * provider — an Ollama response ending mid-structure is truncated no
 * matter which runtime produced it — and adds trailing-dash
 * (cut-off word) plus ellipsis endings.
 */
function isHeuristicallyIncomplete(text: string): boolean {
  const trimmed = text.trim();
  return (
    hasUnbalancedDelimiters(trimmed) ||
    /[,;:\-–—]$/.test(trimmed) ||
    /(?:\.\.\.|…)$/.test(trimmed)
  );
}

/**
 * One translation unit: all of a single page's chunks joined back into
 * page order. Chunks are contiguous slices of the page text, so joining
 * with "" reconstructs the page exactly. Translating per page (rather
 * than per arbitrary 4000-char window) keeps sentences and table rows
 * that fall on chunk boundaries in one model call where feasible.
 */
interface PageTranslationUnit {
  chunkIndex: number;
  pageNumber: number;
  startOffset: number;
  endOffset: number;
  text: string;
}

function groupChunksByPage(chunks: AiContextChunk[]): PageTranslationUnit[] {
  const byPage = new Map<number, AiContextChunk[]>();
  for (const chunk of chunks) {
    const group = byPage.get(chunk.pageNumber);
    if (group) group.push(chunk);
    else byPage.set(chunk.pageNumber, [chunk]);
  }
  return [...byPage.values()]
    .map((group) => {
      const ordered = group.slice().sort((a, b) => a.chunkIndex - b.chunkIndex);
      return {
        chunkIndex: ordered[0].chunkIndex,
        pageNumber: ordered[0].pageNumber,
        startOffset: ordered[0].startOffset,
        endOffset: ordered[ordered.length - 1].endOffset,
        text: ordered.map((chunk) => chunk.text).join(""),
      };
    })
    .sort((a, b) => a.chunkIndex - b.chunkIndex);
}

function toTranslatedChunk(
  chunk: AiContextChunk | PageTranslationUnit,
  translatedText: string,
  status: TranslatedChunkStatus,
  error?: string,
): TranslatedChunk {
  return {
    chunkIndex: chunk.chunkIndex,
    pageNumber: chunk.pageNumber,
    startOffset: chunk.startOffset,
    endOffset: chunk.endOffset,
    sourceText: chunk.text,
    translatedText,
    status,
    ...(error ? { error } : {}),
  };
}

/**
 * Translates one page at a time. Each model call receives a single
 * page's full extracted text (all of that page's AI-02 chunks joined
 * in order) with deterministic translation settings — never the
 * original PDF, never the accumulated output, never an arbitrary
 * 4000-char window split mid-sentence.
 */
export async function translatePdf(options: TranslatePdfOptions): Promise<TranslatePdfResult> {
  assertTranslationLanguage(options.targetLanguage);

  const context = await buildAiTextContext(options.file);
  const translatedChunks: TranslatedChunk[] = [];
  let cancelled = false;
  let truncated = context.truncated;

  const units = groupChunksByPage(context.chunks);
  options.onProgress?.(0, units.length);

  if (units.length === 0) {
    return {
      status: context.sourcePageCount > 0 && context.pagesWithoutText.length > 0 ? "no-text" : "ready",
      targetLanguage: options.targetLanguage,
      chunks: [],
      sourcePageCount: context.sourcePageCount,
      pagesWithoutText: context.pagesWithoutText,
      truncated,
      failedChunkIndexes: [],
      cancelled: false,
    };
  }

  let providerError: string | undefined;

  for (const unit of units) {
    if (options.isCancellationRequested?.()) {
      cancelled = true;
      translatedChunks.push(toTranslatedChunk(unit, "", "cancelled", "Translation cancelled."));
      break;
    }

    const prompt = buildAiInstructionPrompt({
      action: "translate",
      targetLanguage: options.targetLanguage,
      hasPagesWithoutText: context.pagesWithoutText.length > 0,
      wasTruncated: context.truncated,
    });

    // A single-chunk unit keeps the exact AiContextChunk identity so
    // runtimes (and their request validation) see the same shape as
    // before; multi-chunk pages send one joined page unit.
    const requestChunks: AiContextChunk[] =
      context.chunks.filter((chunk) => chunk.pageNumber === unit.pageNumber).length === 1
        ? context.chunks.filter((chunk) => chunk.pageNumber === unit.pageNumber)
        : [
            {
              chunkIndex: unit.chunkIndex,
              pageNumber: unit.pageNumber,
              text: unit.text,
              startOffset: unit.startOffset,
              endOffset: unit.endOffset,
            },
          ];

    try {
      const result = await options.runtime.generateText({
        prompt,
        contextChunks: requestChunks,
        settings: {
          temperature: TRANSLATION_TEMPERATURE,
          maxOutputTokens: TRANSLATION_MAX_OUTPUT_TOKENS,
        },
      });

      if (options.isCancellationRequested?.()) {
        cancelled = true;
        translatedChunks.push(toTranslatedChunk(unit, "", "cancelled", "Translation cancelled."));
        break;
      }

      const { cleaned } = stripReasoningLeakage(result.text);

      if (!cleaned) {
        translatedChunks.push(
          toTranslatedChunk(unit, "", "failed", "The provider returned no usable translation."),
        );
      } else if (isOutputTruncated(result)) {
        truncated = true;
        translatedChunks.push(
          toTranslatedChunk(unit, cleaned, "truncated", "The provider output reached its limit."),
        );
      } else if (isSourceTruncated(result)) {
        truncated = true;
        translatedChunks.push(
          toTranslatedChunk(
            unit,
            cleaned,
            "truncated",
            "Part of the source text was dropped to fit the provider context and was not translated.",
          ),
        );
      } else if (cleaned.length >= options.runtime.capabilities.maxOutputCharacters) {
        truncated = true;
        translatedChunks.push(
          toTranslatedChunk(unit, cleaned, "truncated", "The provider output reached its limit."),
        );
      } else if (isUntranslatedEcho(unit.text, cleaned)) {
        translatedChunks.push(
          toTranslatedChunk(unit, "", "failed", "The provider returned the source text without translating it."),
        );
      } else if (lacksTargetScript(options.targetLanguage, cleaned)) {
        translatedChunks.push(
          toTranslatedChunk(
            unit,
            "",
            "failed",
            `The provider output contains no ${options.targetLanguage} script and looks untranslated.`,
          ),
        );
      } else if (hasPathologicalRepetition(cleaned)) {
        translatedChunks.push(
          toTranslatedChunk(unit, "", "failed", "The provider output degenerated into repetition."),
        );
      } else if (isHeuristicallyIncomplete(cleaned)) {
        truncated = true;
        translatedChunks.push(
          toTranslatedChunk(unit, cleaned, "truncated", "The provider output appears incomplete."),
        );
      } else {
        translatedChunks.push(toTranslatedChunk(unit, cleaned, "translated"));
      }
    } catch (error) {
      if (isCancellationError(error) || options.isCancellationRequested?.()) {
        cancelled = true;
        translatedChunks.push(toTranslatedChunk(unit, "", "cancelled", "Translation cancelled."));
        break;
      }

      if (isProviderFailure(error)) {
        providerError = errorMessage(error);
        break;
      }

      translatedChunks.push(toTranslatedChunk(unit, "", "failed", errorMessage(error)));
    }

    options.onProgress?.(translatedChunks.length, units.length);
  }

  if (cancelled) {
    for (const unit of units.slice(translatedChunks.length)) {
      translatedChunks.push(toTranslatedChunk(unit, "", "cancelled", "Translation cancelled."));
    }
  }

  return {
    status: providerError
      ? "provider-failed"
      : cancelled
        ? "cancelled"
        : truncated || translatedChunks.some((chunk) => chunk.status === "failed" || chunk.status === "truncated")
          ? "partial"
          : "ready",
    targetLanguage: options.targetLanguage,
    chunks: translatedChunks,
    sourcePageCount: context.sourcePageCount,
    pagesWithoutText: context.pagesWithoutText,
    truncated,
    failedChunkIndexes: translatedChunks
      .filter((chunk) => chunk.status === "failed" || chunk.status === "truncated")
      .map((chunk) => chunk.chunkIndex),
    cancelled,
    ...(providerError ? { providerError } : {}),
  };
}
