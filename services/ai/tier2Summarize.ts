/**
 * V6-E01 — First user-facing Tier-2 capability: validated Ollama summarization.
 * V8-A07 — Hierarchical default: the selected evidence pool is
 * partitioned into deterministic page-contiguous sections
 * (`./stage2/sections.ts`), each synthesized by its own bounded
 * Stage-2 call through the unchanged C02/C03 chain, then assembled
 * in section order (no second synthesis LLM call). A single section
 * (or an unpartitionable pool) runs the original flat fallback.
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
import {
  buildStage1EvidencePrompt,
  buildStage2SummarizePrompt,
  buildSectionSummarizePrompt,
} from "./stage2/prompts";
import {
  isPartitionExact,
  partitionSelectedEvidence,
  type DocumentSection,
} from "./stage2/sections";
import { Tier2ServiceError, acquireGatedOllamaRuntime } from "./tier2";

export { Tier2ServiceError } from "./tier2";

/**
 * Deterministic bound on evidence projected into Stage 2
 * (coverage-balanced selection, whole items only). V8-A07: the
 * production budget is 64 items (the V8-A02 through V8-A05 validated
 * capacity) instead of the former 24-item cap; the V7-A02 quota
 * mathematics are unchanged, only the budget parameter grew.
 * Overflow is flagged via `evidenceTruncated`, never silently
 * dropped. V7-A02: the pool is spread across source pages instead
 * of taking the first-N admitted items, so trailing pages are no
 * longer deterministically excluded.
 */
export const MAX_STAGE2_EVIDENCE_ITEMS = 64;

/** Compact ceiling for one chunk's candidate-span output. */
export const STAGE1_MAX_OUTPUT_TOKENS = 1024;

/** Ceiling for the Stage-2 claim-array output. */
export const STAGE2_MAX_OUTPUT_TOKENS = 2048;

/**
 * Ceiling for one SECTION-level Stage-2 claim-array output
 * (V8-A07 hierarchical path). Identical to the production flat
 * ceiling: every Stage-2 call in every arm runs under the same
 * validated per-call conditions.
 */
export const SECTION_STAGE2_MAX_OUTPUT_TOKENS = 2048;

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
  /**
   * V8-A07 hierarchical coverage metadata (additive; existing
   * consumers ignore it). `sectionCount` is the number of
   * deterministic sections the selected pool was partitioned into
   * (1 when the flat fallback ran); `failedSections` lists section
   * indexes that contributed no grounded claims (recorded coverage
   * gaps — never retried, never redistributed); `groundedPages` is
   * the sorted unique source pages carrying grounded evidence.
   */
  readonly sectionCount: number;
  readonly failedSections: readonly number[];
  readonly groundedPages: readonly number[];
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

/**
 * Projects one admitted store item to its model-visible view. The
 * descriptive `sourcePage` / `chunk` locators come from the item's own
 * authoritative `sourcePages` / `chunkIndex` (v1: exactly the owning
 * page) — never from model output, never modified, never re-derived.
 * The store item itself is untouched.
 */
function toEvidenceView(item: EvidenceItem): Stage2EvidenceView {
  const sourcePage = item.sourcePages[0] as number;
  const chunk = item.chunkIndex;
  return Object.freeze(
    item.value === undefined
      ? { evidenceId: item.evidenceId, exactText: item.exactText, kind: item.kind, sourcePage, chunk }
      : {
          evidenceId: item.evidenceId,
          exactText: item.exactText,
          kind: item.kind,
          value: item.value,
          sourcePage,
          chunk,
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
    const views = budgeted.map(toEvidenceView);

    // V8-A07 hierarchical partition: the selected pool is divided
    // into deterministic page-contiguous sections. A single section
    // (or an unpartitionable pool) runs the unchanged flat fallback
    // below; several sections run per-section synthesis. A
    // partitionExact violation fails closed — evidence must never be
    // silently dropped or duplicated.
    const sections = partitionSelectedEvidence({
      items: budgeted,
      views,
      sourcePageCount: context.sourcePageCount,
    });
    if (!isPartitionExact(sections, budgeted.map((item) => item.evidenceId))) {
      throw new Tier2ServiceError(
        "generation-failed",
        "Tier-2 evidence partitioning failed integrity check.",
      );
    }
    if (sections.length > 1) {
      // NOTE: `await` (not bare `return`) is load-bearing here: the
      // `finally` below disposes the runtime, and a bare `return` of
      // the pending promise would run disposal immediately while
      // section calls are still in flight.
      return await runHierarchicalSummarize({
        runtime,
        context,
        chunks: [...chunks],
        store,
        budgeted,
        views,
        sections,
        evidenceAdmitted,
        evidenceTruncated,
        failedChunks,
      });
    }

    const stage2Input: Stage2Input = Object.freeze({
      evidence: Object.freeze(views),
      task: "summarize" as const,
      sourcePageCount: context.sourcePageCount,
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
        { sectionCount: sections.length, failedSections: [], groundedPages: [] },
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
      sectionCount: sections.length,
      failedSections: Object.freeze([]),
      groundedPages: Object.freeze(groundedPagesOf(grounded, chunks)),
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

/** Sorted unique source pages carrying grounded evidence (derived, never stored). */
function groundedPagesOf(
  grounded: readonly GroundedStage2Claim[],
  chunks: readonly AiContextChunk[],
): number[] {
  const pageByChunk = new Map(chunks.map((chunk) => [chunk.chunkIndex, chunk.pageNumber]));
  const pages = new Set<number>();
  for (const claim of grounded) {
    for (const item of claim.evidence) {
      const page = pageByChunk.get(item.item.chunkIndex);
      if (page !== undefined) {
        pages.add(page);
      }
    }
  }
  return [...pages].sort((a, b) => a - b);
}

interface HierarchicalRunOptions {
  runtime: { capabilities: { providerId: string } };
  context: {
    sourcePageCount: number;
    pagesWithoutText: number[];
    truncated: boolean;
  };
  chunks: AiContextChunk[];
  store: EvidenceStore;
  budgeted: readonly EvidenceItem[];
  views: readonly Stage2EvidenceView[];
  sections: readonly DocumentSection[];
  evidenceAdmitted: number;
  evidenceTruncated: boolean;
  failedChunks: number[];
}

/**
 * V8-A07 hierarchical synthesis: one bounded Stage-2 call per
 * deterministic section (sequential — the runtime allows a single
 * in-flight generation), each validated through the unchanged
 * C02/C03 chain against the request store, then deterministic
 * page-order assembly (section order, then claim order within each
 * section — no new claims, no ID or text rewriting, no LLM call).
 *
 * Recovery behavior (deterministic, documented): a failed section —
 * transport failure, malformed output, zero accepted claims, or a
 * grounding failure — contributes nothing and is recorded in
 * `failedSections` as an explicit coverage gap. Its evidence IDs are
 * preserved in the partition record but never redistributed into
 * other sections, never retried, and never silently treated as
 * covered. There is no hidden fallback LLM call: a failed section
 * stays failed in A07.
 */
async function runHierarchicalSummarize(
  options: HierarchicalRunOptions,
): Promise<Tier2ValidatedSummarizeResult> {
  const {
    runtime,
    context,
    chunks,
    store,
    views,
    sections,
    evidenceAdmitted,
    evidenceTruncated,
    failedChunks,
  } = options;
  const viewById = new Map(views.map((view) => [view.evidenceId, view]));
  const failedSections: number[] = [];
  const assembled: GroundedStage2Claim[] = [];
  let rejectedClaims = 0;
  let malformedSections = 0;

  for (const section of sections) {
    const sectionViews = section.evidenceIds.map((id) => viewById.get(id));
    if (sectionViews.some((view) => view === undefined)) {
      // partitionExact held, so this is unreachable; fail the section
      // closed rather than guessing.
      failedSections.push(section.sectionIndex);
      continue;
    }
    const sectionInput: Stage2Input = Object.freeze({
      evidence: Object.freeze([...(sectionViews as Stage2EvidenceView[])]),
      task: "summarize" as const,
      sourcePageCount: context.sourcePageCount,
    });
    let sectionText: string;
    try {
      sectionText = await generateStage2ClaimsText(
        runtime,
        buildSectionSummarizePrompt(sectionInput),
        SECTION_STAGE2_MAX_OUTPUT_TOKENS,
      );
    } catch {
      failedSections.push(section.sectionIndex);
      continue;
    }
    const validated = validateStage2Output(sectionText, { scope: store });
    rejectedClaims += validated.rejected.length;
    if (validated.outputError === "malformed-output") {
      malformedSections += 1;
    }
    if (validated.accepted.length === 0) {
      failedSections.push(section.sectionIndex);
      continue;
    }
    let grounded: readonly GroundedStage2Claim[];
    try {
      grounded = projectGroundedClaims({
        claims: [...validated.accepted],
        store,
        chunks: [...chunks],
      }).grounded;
    } catch {
      failedSections.push(section.sectionIndex);
      continue;
    }
    assembled.push(...grounded);
  }

  if (assembled.length === 0) {
    // Every section failed: malformed-output only when every single
    // section failure was a malformed envelope (no transport or
    // empty-accepted failures mixed in).
    const allMalformed =
      failedSections.length === sections.length && malformedSections === sections.length;
    return limited(
      allMalformed ? "malformed-output" : "no-valid-claims",
      runtime,
      context,
      evidenceAdmitted,
      evidenceTruncated,
      rejectedClaims,
      failedChunks,
      {
        sectionCount: sections.length,
        failedSections,
        groundedPages: [],
      },
    );
  }

  return Object.freeze({
    status: "grounded" as const,
    claims: Object.freeze(assembled),
    providerId: runtime.capabilities.providerId,
    runtime: "ollama" as const,
    sourcePageCount: context.sourcePageCount,
    pagesWithoutText: Object.freeze([...context.pagesWithoutText]),
    contextTruncated: context.truncated,
    evidenceAdmitted,
    evidenceTruncated,
    rejectedClaims,
    failedChunks: Object.freeze(failedChunks),
    sectionCount: sections.length,
    failedSections: Object.freeze([...failedSections]),
    groundedPages: Object.freeze(groundedPagesOf(assembled, chunks)),
  });
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
  hierarchical?: {
    sectionCount: number;
    failedSections: number[];
    groundedPages: number[];
  },
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
    sectionCount: hierarchical?.sectionCount ?? 0,
    failedSections: Object.freeze(hierarchical ? [...hierarchical.failedSections] : []),
    groundedPages: Object.freeze(hierarchical ? [...hierarchical.groundedPages] : []),
  });
}
