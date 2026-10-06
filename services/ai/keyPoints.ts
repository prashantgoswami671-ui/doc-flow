import { buildAiTextContext } from "./pipeline";
import type { AiContextChunk, AiRuntime } from "./types";

export const MAX_KEY_POINTS_PER_CHUNK = 3;
export const MAX_DISPLAY_KEY_POINTS = 20;

export interface KeyPoint {
  pointIndex: number;
  text: string;
  sourceChunkIndex: number;
  sourcePageNumber: number;
  sourceStartOffset: number;
  sourceEndOffset: number;
  sourceText: string;
}

export interface KeyPointsResult {
  status: "ready" | "partial" | "cancelled" | "no-text" | "provider-failed";
  points: KeyPoint[];
  sourcePageCount: number;
  pagesWithoutText: number[];
  truncated: boolean;
  failedChunkIndexes: number[];
  cancelled: boolean;
  providerError?: string;
}

export interface KeyPointsOptions {
  file: File;
  runtime: AiRuntime;
  onProgress?: (completed: number, total: number) => void;
  isCancellationRequested?: () => boolean;
}

/** Strictly accepts the small response contract; prose and bullet lists are rejected. */
export function parseKeyPointsResponse(value: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const points = (parsed as { points?: unknown }).points;
    if (!Array.isArray(points) || points.length === 0 || points.length > MAX_KEY_POINTS_PER_CHUNK) return null;
    if (!points.every((point) => typeof point === "string" && point.trim().length > 0)) return null;
    const normalized = points.map((point) => point.trim());
    if (normalized.some((point) => point.length > 500)) return null;
    return normalized;
  } catch {
    return null;
  }
}

function isCancellationError(error: unknown): boolean {
  return error instanceof Error && /cancelled|canceled|disposed/i.test(`${error.name} ${error.message}`);
}

function isProviderFailure(error: unknown): boolean {
  return error instanceof Error && /AiRuntimeUnavailableError|AiModelInitializationError|AiGenerationError|OllamaClientError|OllamaModelNotFoundError|OllamaGenerationError|OllamaRuntimeDisposedError|AiRequestValidationError|ProhibitedAiRequestFieldError/i.test(error.name);
}

function message(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Key-point generation failed.";
}

function pointFrom(chunk: AiContextChunk, text: string, pointIndex: number): KeyPoint {
  return {
    pointIndex,
    text,
    sourceChunkIndex: chunk.chunkIndex,
    sourcePageNumber: chunk.pageNumber,
    sourceStartOffset: chunk.startOffset,
    sourceEndOffset: chunk.endOffset,
    sourceText: chunk.text,
  };
}

function normalizePoint(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

/**
 * Generates up to three source-language points per bounded chunk. Calls are
 * deliberately sequential so ordering and cancellation remain deterministic.
 */
export async function generateKeyPoints(options: KeyPointsOptions): Promise<KeyPointsResult> {
  const context = await buildAiTextContext(options.file);
  const points: KeyPoint[] = [];
  const failedChunkIndexes: number[] = [];
  let providerError: string | undefined;
  let cancelled = false;
  const seen = new Set<string>();

  options.onProgress?.(0, context.chunks.length);
  if (context.chunks.length === 0) {
    return {
      status: context.sourcePageCount > 0 && context.pagesWithoutText.length > 0 ? "no-text" : "ready",
      points, sourcePageCount: context.sourcePageCount, pagesWithoutText: context.pagesWithoutText,
      truncated: context.truncated, failedChunkIndexes, cancelled: false,
    };
  }

  for (const chunk of context.chunks) {
    if (options.isCancellationRequested?.()) {
      cancelled = true;
      break;
    }
    try {
      const response = await options.runtime.generateText({
        prompt: `Extract at most ${MAX_KEY_POINTS_PER_CHUNK} concise key points from the supplied text. Write each point in the source language. Return only JSON matching {"points":["..."]}; do not add prose or markdown.`,
        contextChunks: [chunk],
        settings: { temperature: 0, maxOutputTokens: 256 },
      });
      if (options.isCancellationRequested?.()) {
        cancelled = true;
        break;
      }
      const parsed = parseKeyPointsResponse(response.text);
      if (!parsed) {
        failedChunkIndexes.push(chunk.chunkIndex);
      } else {
        for (const text of parsed) {
          const normalized = normalizePoint(text);
          if (!seen.has(normalized)) {
            seen.add(normalized);
            points.push(pointFrom(chunk, text, points.length));
          }
        }
      }
    } catch (error) {
      if (isCancellationError(error) || options.isCancellationRequested?.()) {
        cancelled = true;
        break;
      }
      if (isProviderFailure(error)) {
        providerError = message(error);
        break;
      }
      failedChunkIndexes.push(chunk.chunkIndex);
    }
    options.onProgress?.(Math.min(chunk.chunkIndex + 1, context.chunks.length), context.chunks.length);
  }

  const status = providerError
    ? "provider-failed"
    : cancelled
      ? "cancelled"
      : context.truncated || failedChunkIndexes.length > 0
        ? "partial"
        : "ready";
  return {
    status, points, sourcePageCount: context.sourcePageCount, pagesWithoutText: context.pagesWithoutText,
    truncated: context.truncated, failedChunkIndexes, cancelled,
    ...(providerError ? { providerError } : {}),
  };
}
