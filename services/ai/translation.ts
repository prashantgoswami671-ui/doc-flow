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
  return /AiRuntimeUnavailableError|AiModelInitializationError|OllamaClientError|OllamaModelNotFoundError|OllamaGenerationError|OllamaRuntimeDisposedError|AiRequestValidationError|ProhibitedAiRequestFieldError/i.test(
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

function isObviouslyTruncated(text: string, runtime: AiRuntime): boolean {
  if (text.length >= runtime.capabilities.maxOutputCharacters) return true;
  if (runtime.capabilities.providerId !== "browser-ai") return false;

  // Browser AI exposes no semantic completion signal. These conservative
  // checks fail closed for outputs that visibly end mid-structure or
  // mid-sentence, rather than claiming completeness.
  const trimmed = text.trim();
  return (
    hasUnbalancedDelimiters(trimmed) ||
    /[,;:]$/.test(trimmed) ||
    /(?:\.\.\.|…)$/.test(trimmed)
  );
}

function toTranslatedChunk(
  chunk: AiContextChunk,
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
 * Translates one AI-02 chunk at a time. The runtime receives only the current
 * extracted-text chunk, never the original PDF or the accumulated output.
 */
export async function translatePdf(options: TranslatePdfOptions): Promise<TranslatePdfResult> {
  assertTranslationLanguage(options.targetLanguage);

  const context = await buildAiTextContext(options.file);
  const translatedChunks: TranslatedChunk[] = [];
  let cancelled = false;
  let truncated = context.truncated;

  options.onProgress?.(0, context.chunks.length);

  if (context.chunks.length === 0) {
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

  for (const chunk of context.chunks) {
    if (options.isCancellationRequested?.()) {
      cancelled = true;
      translatedChunks.push(toTranslatedChunk(chunk, "", "cancelled", "Translation cancelled."));
      break;
    }

    const prompt = buildAiInstructionPrompt({
      action: "translate",
      targetLanguage: options.targetLanguage,
      hasPagesWithoutText: context.pagesWithoutText.length > 0,
      wasTruncated: context.truncated,
    });

    try {
      const result = await options.runtime.generateText({
        prompt,
        contextChunks: [chunk],
      });

      if (options.isCancellationRequested?.()) {
        cancelled = true;
        translatedChunks.push(toTranslatedChunk(chunk, "", "cancelled", "Translation cancelled."));
        break;
      }

      if (!result.text.trim()) {
        translatedChunks.push(toTranslatedChunk(chunk, "", "failed", "The provider returned no translation."));
      } else if (isOutputTruncated(result) || isObviouslyTruncated(result.text, options.runtime)) {
        truncated = true;
        translatedChunks.push(
          toTranslatedChunk(chunk, result.text, "truncated", "The provider output reached its limit."),
        );
      } else {
        translatedChunks.push(toTranslatedChunk(chunk, result.text, "translated"));
      }
    } catch (error) {
      if (isCancellationError(error) || options.isCancellationRequested?.()) {
        cancelled = true;
        translatedChunks.push(toTranslatedChunk(chunk, "", "cancelled", "Translation cancelled."));
        break;
      }

      if (isProviderFailure(error)) {
        providerError = errorMessage(error);
        break;
      }

      translatedChunks.push(toTranslatedChunk(chunk, "", "failed", errorMessage(error)));
    }

    options.onProgress?.(translatedChunks.length, context.chunks.length);
  }

  if (cancelled) {
    for (const chunk of context.chunks.slice(translatedChunks.length)) {
      translatedChunks.push(toTranslatedChunk(chunk, "", "cancelled", "Translation cancelled."));
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
