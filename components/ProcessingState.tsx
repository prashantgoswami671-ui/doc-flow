// components/ProcessingState.tsx
"use client";

import type { ReactNode } from "react";

/**
 * A single stage in a multi-stage processing flow (e.g. "preparing",
 * "validating"). Purely presentational — the id is only used as a React
 * key / for the caller's own bookkeeping, it carries no business meaning
 * here.
 */
export interface ProcessingStage {
  id: string;
  label: string;
}

export interface ProcessingStateProps {
  /** Whether processing is currently active. */
  isProcessing: boolean;
  /** Message to display while processing (used when `stage` isn't given). */
  message?: string;
  /**
   * Optional current stage for staged processing flows. When provided,
   * its label takes precedence over `message`.
   */
  stage?: ProcessingStage | null;
  /** Content to render when not processing. Defaults to nothing. */
  children?: ReactNode;
  /** Optional className for the rendered element. */
  className?: string;
}

/**
 * Generic, presentation-only processing/loading indicator.
 *
 * ProcessingState has no knowledge of what is being processed — it only
 * decides HOW to display a processing state that the caller already
 * computed. Callers remain responsible for deciding WHEN they are
 * processing and what message/stage to show.
 */
export default function ProcessingState({
  isProcessing,
  message,
  stage,
  children,
  className,
}: ProcessingStateProps) {
  if (!isProcessing) {
    return children ?? null;
  }

  const label = stage?.label ?? message ?? null;

  if (!label) {
    return null;
  }

  return <span className={className}>{label}</span>;
}
