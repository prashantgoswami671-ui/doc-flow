/**
 * Checkpoint 6C-B — Production AI orchestration (provider-agnostic).
 *
 * Flow:
 *   PDF File
 *     -> buildAiTextContext()          (AI-02 extraction/chunking)
 *     -> empty-context guard
 *     -> buildAiInstructionPrompt()    (6C-A instruction builder)
 *     -> injected AiRuntime.generateText()
 *     -> orchestration result
 *
 * Depends on:
 *   - AiRuntime (generic abstraction, NOT BrowserAiRuntime directly)
 *   - BuildAiTextContextResult.truncated  (AI-02 signal)
 *   - optional runtime.contextTruncated   (Browser provider-local signal)
 *
 * Does not know about:
 *   - BrowserAiRuntime/BrowserAiWorker
 *   - document delimiters / system instruction
 *   - model download / Web Worker lifecycle
 */

import { buildAiTextContext, type BuildAiTextContextOptions } from "./pipeline";
import { buildAiInstructionPrompt, type AiPresetAction } from "./instructions";
import type { AiContextChunk, AiRuntime } from "./types";

export class AiEmptyContextError extends Error {
  constructor(message = "No extractable text was found in this document.") {
    super(message);
    this.name = "AiEmptyContextError";
  }
}

export interface RunAiActionOnPdfOptions {
  file: File;
  action: AiPresetAction;
  runtime: AiRuntime;
  userQuestion?: string;
  targetLanguage?: string;
  pageNumbers?: number[];
  contextOptions?: BuildAiTextContextOptions;
}

export interface RunAiActionOnPdfResult {
  text: string;
  providerId: string;
  chunks: AiContextChunk[];
  sourcePageCount: number;
  pagesWithoutText: number[];
  /** True if either AI-02 construction or the runtime truncated its context. */
  truncated: boolean;
}

/**
 * Provider-agnostic orchestration helper. Converts a PDF File into bounded
 * text context (AI-02), guards empty context, builds an action-specific
 * instruction, and delegates to the injected `AiRuntime`.
 *
 * Never passes File/Blob/ArrayBuffer/PDF bytes to the runtime — only
 * `prompt` + `contextChunks`.
 */
export async function runAiActionOnPdf(
  options: RunAiActionOnPdfOptions,
): Promise<RunAiActionOnPdfResult> {
  const { file, action, runtime, userQuestion, targetLanguage, pageNumbers, contextOptions } = options;

  // Merge pageNumbers: explicit top-level takes precedence over contextOptions.
  const effectiveContextOptions: BuildAiTextContextOptions | undefined =
    pageNumbers !== undefined || contextOptions !== undefined
      ? {
          ...contextOptions,
          ...(pageNumbers !== undefined ? { pageNumbers } : {}),
        }
      : undefined;

  const context = await buildAiTextContext(
    file,
    effectiveContextOptions ?? {},
  );

  if (context.chunks.length === 0) {
    throw new AiEmptyContextError();
  }

  const prompt = buildAiInstructionPrompt({
    action,
    userQuestion,
    targetLanguage,
    hasPagesWithoutText: context.pagesWithoutText.length > 0,
    wasTruncated: context.truncated,
  });

  // Do NOT catch — propagate runtime errors/cancellation unchanged.
  const result = await runtime.generateText({
    prompt,
    contextChunks: context.chunks,
  });

  // Dual truncation: AI-02 OR optional runtime field (BrowserAiRuntime)
  // Do not widen shared AiTextGenerationResult; detect safely.
  const runtimeTruncated =
    "contextTruncated" in (result as unknown as Record<string, unknown>) &&
    typeof (result as unknown as Record<string, unknown>).contextTruncated === "boolean"
      ? ((result as unknown as Record<string, unknown>).contextTruncated as boolean)
      : false;

  const truncated = context.truncated || runtimeTruncated;

  return {
    text: result.text,
    providerId: result.providerId,
    chunks: context.chunks,
    sourcePageCount: context.sourcePageCount,
    pagesWithoutText: context.pagesWithoutText,
    truncated,
  };
}
