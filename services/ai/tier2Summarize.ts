/**
 * V6-E01 — First user-facing Tier-2 capability: validated Ollama summarization.
 *
 * Full production flow reusing every established layer (no second pipeline):
 *
 *   PDF → buildAiTextContext (AI-02)
 *     → gated Ollama runtime (tier2.ts: capability + selection +
 *        availability + consent, shared with D04)
 *     → Stage-1 evidence acquisition, one bounded generation per
 *        AI-02 chunk (model sees ONE chunk's raw text; returns a bare
 *        JSON array of exact-span strings; never mints IDs)
 *     → B03 admission per chunk into one B04 EvidenceStore
 *        (exact containment, local IDs, deterministic numerics)
 *     → deterministic evidence budget (coverage-balanced page
 *        spread, V7-A02)
 *     → frozen C01 Stage2Input (no provenance, no raw chunk text)
 *     → Stage-2 summarization generation (evidence pool only)
 *     → C02 validation (invalid claims rejected, siblings survive)
 *     → C03 grounding (store bytes only; model text stays restatement)
 *     → "grounded" result, or an explicit "limited" state when zero
 *        evidence or zero valid claims survive (never raw fallback).
 *
 * Generation settings are deterministic (temperature 0, matching the
 * research runs) with compact per-stage token ceilings.
 */

import type { AiContextChunk } from "./types";
import { buildAiTextContext } from "./pipeline";
import { AiEmptyContextError } from "./orchestration";
import { EvidenceStore } from "./evidence/store";
import type { EvidenceItem } from "./evidence/types";
import { selectCoverageBalancedEvidence } from "./evidence/selection";
import { validateStage2Output } from "./stage2/validation";
import { projectGroundedClaims, type GroundedStage2Claim } from "./stage2/projection";
import { generateStage1SpansText, generateStage2ClaimsText } from "./ollama/structured";
import type { Stage2EvidenceView, Stage2Input } from "./stage2/types";
import { buildStage1EvidencePrompt, buildStage2SummarizePrompt } from "./stage2/prompts";
import { Tier2ServiceError, acquireGatedOllamaRuntime } from "./tier2";

export { Tier2ServiceError } from "./tier2";

/**
 * Deterministic bound on evidence projected into Stage 2
 * (coverage-balanced selection, whole items only). Conservative for
 * local qwen3:4b: keeps the Stage-2 prompt compact with headroom for
 * the 2048-token output ceiling (T2-07 showed added context risks
 * truncation), while the chunk-2 stress case (18 spans) fits without
 * budgeting. Overflow is flagged via `evidenceTruncated`, never
 * silently dropped. V7-A02: the pool is spread across source pages
 * instead of taking the first-N admitted items, so trailing pages
 * are no longer deterministically excluded.
 */
export const MAX_STAGE2_EVIDENCE_ITEMS = 24;

/** Compact ceiling for one chunk's candidate-span output. */
export const STAGE1_MAX_OUTPUT_TOKENS = 1024;

/** Ceiling for the Stage-2 claim-array output. */
export const STAGE2_MAX_OUTPUT_TOKENS = 2048;

/**
 * Explicit limited-result reasons (never a fabricated summary).
 * `malformed-output` (unparseable/wrapped Stage-2 text) is distinct
 * from `no-valid-claims` (parsed but wholly rejected) so the UI can
 * explain output-format failure truthfully (V6-E03).
 */
export type Tier2LimitedReason = "no-evidence" | "malformed-output" | "no-valid-claims";

/** Validated Tier-2 summarize result: grounded claims or explicit limited state. */
export interface Tier2ValidatedSummarizeResult {
  readonly status: "grounded" | "limited";
  readonly reason?: Tier2LimitedReason;
  readonly claims: readonly GroundedStage2Claim[];
  readonly providerId: string;
  readonly runtime: "ollama";
  readonly sourcePageCount: number;
  readonly pagesWithoutText: readonly number[];
  readonly contextTruncated: boolean;
  readonly evidenceAdmitted: number;
  readonly evidenceTruncated: boolean;
  readonly rejectedClaims: number;
  readonly failedChunks: readonly number[];
}

/** Validated Tier-2 summarize request envelope (still runtime-validated). */
export interface RunTier2ValidatedSummarizeOptions {
  /** Source PDF. Must be a real `File`; validated fail-closed. */
  file: unknown;
  /** Explicit caller-owned in-memory consent store (D03). */
  consentStore: unknown;
  /** Requested action; must resolve to supported summarize (default). */
  action?: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toEvidenceView(item: EvidenceItem): Stage2EvidenceView {
  return Object.freeze(
    item.value === undefined
      ? { evidenceId: item.evidenceId, exactText: item.exactText, kind: item.kind }
      : {
          evidenceId: item.evidenceId,
          exactText: item.exactText,
          kind: item.kind,
          value: item.value,
        },
  );
}

/**
 * Runs the validated Tier-2 Ollama summarize. Rejects with
 * `Tier2ServiceError` for request/gating/generation failures;
 * returns an explicit `limited` result (never raw model text) when
 * evidence acquisition or claim validation yields nothing groundable.
 */
export async function runTier2ValidatedSummarize(
  options: unknown,
): Promise<Tier2ValidatedSummarizeResult> {
  if (!isPlainObject(options)) {
    throw new Tier2ServiceError("invalid-request", "Tier-2 request must be an object.");
  }
  const { file, consentStore, action } = options;
  if (!(file instanceof File)) {
    throw new Tier2ServiceError("invalid-request", "Tier-2 request requires a PDF File.");
  }

  // Shared gate sequence (capability → selection → availability →
  // consent); the runtime is fresh per call and disposed before return.
  const { runtime, dispose } = await acquireGatedOllamaRuntime(consentStore, action);
  try {
    // AI-02 extraction/chunking (empty context stays distinguishable).
    let context;
    try {
      context = await buildAiTextContext(file);
    } catch (error) {
      if (error instanceof Tier2ServiceError) {
        throw error;
      }
      throw new Tier2ServiceError("generation-failed", "Tier-2 document processing failed.");
    }
    if (context.chunks.length === 0) {
      throw new Tier2ServiceError("empty-context", "No extractable text was found.");
    }
    const chunks: readonly AiContextChunk[] = Object.freeze([...context.chunks]);

    // One request EvidenceStore bound to the actual chunk context.
    const store = EvidenceStore.create({
      chunks: [...chunks],
      sourcePageCount: context.sourcePageCount,
    });

    // Stage 1: one bounded generation per chunk; per-chunk failures
    // mark the chunk evidence-failed without losing valid siblings.
    const failedChunks: number[] = [];
    for (const chunk of chunks) {
      try {
        const stage1Text = await generateStage1SpansText(
          runtime,
          buildStage1EvidencePrompt(chunk.text),
          STAGE1_MAX_OUTPUT_TOKENS,
        );
        let candidates: unknown;
        try {
          candidates = JSON.parse(stage1Text);
        } catch {
          failedChunks.push(chunk.chunkIndex);
          continue;
        }
        if (!Array.isArray(candidates)) {
          failedChunks.push(chunk.chunkIndex);
          continue;
        }
        // Bare strings enter the B03 gate (non-strings rejected
        // per-item inside admission, never repaired); a malformed
        // envelope fails only this chunk.
        store.admit(chunk.chunkIndex, candidates);
      } catch {
        failedChunks.push(chunk.chunkIndex);
      }
    }

    const evidenceAdmitted = store.size;
    if (evidenceAdmitted === 0) {
      return limited(
        "no-evidence",
        runtime,
        context,
        evidenceAdmitted,
        false,
        0,
        failedChunks,
      );
    }

    // Deterministic evidence budget: coverage-balanced selection
    // across source pages (V7-A02), whole items only, at most
    // MAX_STAGE2_EVIDENCE_ITEMS; the store itself is never mutated
    // or sliced.
    const snapshot = store.snapshot();
    const evidenceTruncated = snapshot.length > MAX_STAGE2_EVIDENCE_ITEMS;
    const budgeted = selectCoverageBalancedEvidence(snapshot, MAX_STAGE2_EVIDENCE_ITEMS);
    const stage2Input: Stage2Input = Object.freeze({
      evidence: Object.freeze(budgeted.map(toEvidenceView)),
      task: "summarize" as const,
    });

    // Stage 2: evidence-pool-only generation, then C02 validation.
    let stage2Text: string;
    try {
      stage2Text = await generateStage2ClaimsText(
        runtime,
        buildStage2SummarizePrompt(stage2Input),
        STAGE2_MAX_OUTPUT_TOKENS,
      );
    } catch {
      throw new Tier2ServiceError("generation-failed", "Tier-2 Ollama generation failed.");
    }
    const validated = validateStage2Output(stage2Text, { scope: store });
    const rejectedClaims = validated.rejected.length;
    if (validated.accepted.length === 0) {
      return limited(
        validated.outputError === "malformed-output" ? "malformed-output" : "no-valid-claims",
        runtime,
        context,
        evidenceAdmitted,
        evidenceTruncated,
        rejectedClaims,
        failedChunks,
      );
    }

    // C03 grounding: the only route from claims to displayed evidence.
    let grounded: readonly GroundedStage2Claim[];
    try {
      grounded = projectGroundedClaims({
        claims: validated.accepted,
        store,
        chunks: [...chunks],
      }).grounded;
    } catch {
      throw new Tier2ServiceError("generation-failed", "Tier-2 claim grounding failed.");
    }

    return Object.freeze({
      status: "grounded" as const,
      claims: grounded,
      providerId: runtime.capabilities.providerId,
      runtime: "ollama" as const,
      sourcePageCount: context.sourcePageCount,
      pagesWithoutText: Object.freeze([...context.pagesWithoutText]),
      contextTruncated: context.truncated,
      evidenceAdmitted,
      evidenceTruncated,
      rejectedClaims,
      failedChunks: Object.freeze(failedChunks),
    });
  } catch (error) {
    if (error instanceof Tier2ServiceError || error instanceof AiEmptyContextError) {
      throw error;
    }
    throw new Tier2ServiceError("generation-failed", "Tier-2 validated summarization failed.");
  } finally {
    dispose();
  }
}

function limited(
  reason: Tier2LimitedReason,
  runtime: { capabilities: { providerId: string } },
  context: {
    sourcePageCount: number;
    pagesWithoutText: number[];
    truncated: boolean;
  },
  evidenceAdmitted: number,
  evidenceTruncated: boolean,
  rejectedClaims: number,
  failedChunks: number[],
): Tier2ValidatedSummarizeResult {
  return Object.freeze({
    status: "limited" as const,
    reason,
    claims: Object.freeze([]),
    providerId: runtime.capabilities.providerId,
    runtime: "ollama" as const,
    sourcePageCount: context.sourcePageCount,
    pagesWithoutText: Object.freeze([...context.pagesWithoutText]),
    contextTruncated: context.truncated,
    evidenceAdmitted,
    evidenceTruncated,
    rejectedClaims,
    failedChunks: Object.freeze(failedChunks),
  });
}
