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
import { MAX_CHUNK_CHARACTERS, MAX_CHUNKS_PER_REQUEST, MAX_TOTAL_CONTEXT_CHARACTERS } from "./constants";
import { EvidenceStore } from "./evidence/store";
import type { EvidenceItem } from "./evidence/types";
import { selectCoverageBalancedEvidence } from "./evidence/selection";
import { validateStage2Output } from "./stage2/validation";
import { projectGroundedClaims, type GroundedStage2Claim } from "./stage2/projection";
import { generateStage1SpansText, generateStage2ClaimsText } from "./ollama/structured";
import { OLLAMA_MODEL } from "./ollama/types";
import type { Stage2EvidenceView, Stage2Input } from "./stage2/types";
import {
  buildStage1EvidencePrompt,
  buildStage2SummarizePrompt,
  buildSectionSummarizePrompt,
} from "./stage2/prompts";
import {
  isPartitionExact,
  partitionSelectedEvidence,
  SECTION_MAX_ITEMS,
  SECTION_MAX_PROMPT_CHARS,
  type DocumentSection,
} from "./stage2/sections";
import { Tier2ServiceError, acquireGatedOllamaRuntime } from "./tier2";
import {
  buildTier2CacheKey,
  hashDocumentBytes,
  TIER2_CACHE_PIPELINE_VERSION,
  TIER2_STAGE1_PROMPT_VERSION,
  TIER2_STAGE2_PROMPT_VERSION,
  TIER2_STAGE2_VALIDATOR_VERSION,
  Tier2ResultCache,
  type CachedStage1Chunk,
  type Tier2PipelineFingerprint,
} from "./cache/tier2ResultCache";

export { Tier2ServiceError } from "./tier2";
export {
  Tier2ResultCache,
  buildTier2CacheKey,
  hashDocumentBytes,
  isValidCachedTier2Entry,
} from "./cache/tier2ResultCache";
export type {
  CachedStage1Chunk,
  CachedTier2Artifacts,
  Tier2PipelineFingerprint,
} from "./cache/tier2ResultCache";

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
 * V8-A09 — Live pipeline fingerprint for cache keys, built from the
 * actual production constants (single source of truth). Any change
 * to these values automatically changes the cache key, so stale
 * artifacts can never be reused after a behavior change. Prompt and
 * validator semantics are versioned via the manual `TIER2_*_VERSION`
 * constants in `./cache/tier2ResultCache.ts`, which MUST be bumped
 * alongside the corresponding prompt/validator edits.
 */
export function currentTier2PipelineFingerprint(): Tier2PipelineFingerprint {
  return Object.freeze({
    pipelineVersion: TIER2_CACHE_PIPELINE_VERSION,
    extraction: `chunk-${MAX_CHUNK_CHARACTERS}/${MAX_CHUNKS_PER_REQUEST}/total-${MAX_TOTAL_CONTEXT_CHARACTERS}`,
    stage1: `tok-${STAGE1_MAX_OUTPUT_TOKENS}/prompt-v${TIER2_STAGE1_PROMPT_VERSION}`,
    selection: `budget-${MAX_STAGE2_EVIDENCE_ITEMS}`,
    sectioning: `items-${SECTION_MAX_ITEMS}/chars-${SECTION_MAX_PROMPT_CHARS}`,
    stage2: `tok-${SECTION_STAGE2_MAX_OUTPUT_TOKENS}/prompt-v${TIER2_STAGE2_PROMPT_VERSION}/validator-v${TIER2_STAGE2_VALIDATOR_VERSION}`,
    model: OLLAMA_MODEL,
  });
}

/** V8-A09 cache outcome attached to every result (additive; existing consumers ignore it). */
export type Tier2CacheStatus = "disabled" | "miss" | "hit";

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
  /**
   * V8-A09 reuse metadata (additive). `hit` means every Ollama
   * generation was skipped via a validated cache entry while all
   * deterministic gates (B03/V7-A02/partition/C02/C03) still ran;
   * `avoided*` count the skipped `/api/generate` calls.
   */
  readonly cacheStatus: Tier2CacheStatus;
  readonly avoidedStage1Calls: number;
  readonly avoidedStage2Calls: number;
}

/** Validated Tier-2 summarize request envelope (still runtime-validated). */
export interface RunTier2ValidatedSummarizeOptions {
  /** Source PDF. Must be a real `File`; validated fail-closed. */
  file: unknown;
  /** Explicit caller-owned in-memory consent store (D03). */
  consentStore: unknown;
  /** Requested action; must resolve to supported summarize (default). */
  action?: unknown;
  /**
   * V8-A09 opt-in reuse: an explicit caller-owned `Tier2ResultCache`
   * instance. Absent (or any non-instance) means no reuse — except
   * that a non-instance non-undefined value is an invalid request.
   * Gating (availability + consent) still runs before every lookup,
   * including warm hits.
   */
  cache?: unknown;
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
  const { file, consentStore, action, cache } = options;
  if (!(file instanceof File)) {
    throw new Tier2ServiceError("invalid-request", "Tier-2 request requires a PDF File.");
  }
  if (cache !== undefined && !(cache instanceof Tier2ResultCache)) {
    throw new Tier2ServiceError("invalid-request", "Tier-2 cache must be a Tier2ResultCache.");
  }
  const resultCache = cache as Tier2ResultCache | undefined;
  // V8-A09 reuse metadata: disabled when no cache instance is
  // supplied; miss once a lookup fails or is absent; hit only via
  // the validated warm path below.
  const missMeta = {
    cacheStatus: (resultCache === undefined ? "disabled" : "miss") as Tier2CacheStatus,
    avoidedStage1Calls: 0,
    avoidedStage2Calls: 0,
  };

  // Shared gate sequence (capability → selection → availability →
  // consent); the runtime is fresh per call and disposed before return.
  // V8-A09: gating runs BEFORE every cache lookup, including warm
  // hits — reuse never bypasses availability or consent.
  const { runtime, dispose } = await acquireGatedOllamaRuntime(consentStore, action);
  try {
    // V8-A09 key material: content hash over the PDF bytes (never
    // the bytes themselves) plus the live pipeline fingerprint.
    // A hashing failure degrades to uncached, never to a wrong hit.
    let cacheKey:
      | { documentHash: string; fingerprint: Tier2PipelineFingerprint; key: string }
      | undefined;
    if (resultCache !== undefined) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const documentHash = hashDocumentBytes(bytes);
        const fingerprint = currentTier2PipelineFingerprint();
        cacheKey = { documentHash, fingerprint, key: buildTier2CacheKey(documentHash, fingerprint) };
      } catch {
        cacheKey = undefined;
      }
    }
    // V8-A09 warm path: same logical document + compatible
    // configuration replays recorded model texts through the real
    // B03/V7-A02/partition/C02/C03 gates with zero Ollama
    // generations. Any validation failure returns null and falls
    // through to the live cold path below (never a partial hit).
    if (resultCache !== undefined && cacheKey !== undefined) {
      const warm = await tryWarmTier2Summarize({
        cache: resultCache,
        keyMaterial: cacheKey,
        providerId: runtime.capabilities.providerId,
      });
      if (warm !== null) {
        return warm;
      }
    }

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
    // V8-A09: the parsed candidate outcome per chunk is taped for a
    // possible cache entry (`null` = chunk failed, reproduced exactly
    // on reuse through the same admit/fail logic).
    const failedChunks: number[] = [];
    const stage1Tape: CachedStage1Chunk[] = [];
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
          stage1Tape.push({ chunkIndex: chunk.chunkIndex, candidates: null });
          continue;
        }
        if (!Array.isArray(candidates)) {
          failedChunks.push(chunk.chunkIndex);
          stage1Tape.push({ chunkIndex: chunk.chunkIndex, candidates: null });
          continue;
        }
        // Bare strings enter the B03 gate (non-strings rejected
        // per-item inside admission, never repaired); a malformed
        // envelope fails only this chunk.
        store.admit(chunk.chunkIndex, candidates);
        stage1Tape.push({ chunkIndex: chunk.chunkIndex, candidates: [...candidates] });
      } catch {
        failedChunks.push(chunk.chunkIndex);
        stage1Tape.push({ chunkIndex: chunk.chunkIndex, candidates: null });
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
        undefined,
        missMeta,
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
        missMeta,
        // V8-A09: tape for a possible complete-success cache entry
        // (stored only when every section grounds — see callee).
        cacheTape:
          resultCache !== undefined && cacheKey !== undefined
            ? {
                cache: resultCache,
                keyMaterial: cacheKey,
                chunksData: chunks.map((chunk) => ({
                  chunkIndex: chunk.chunkIndex,
                  pageNumber: chunk.pageNumber,
                  text: chunk.text,
                  startOffset: chunk.startOffset,
                  endOffset: chunk.endOffset,
                })),
                stage1Tape: [...stage1Tape],
              }
            : undefined,
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
        missMeta,
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

    const flatResult: Tier2ValidatedSummarizeResult = Object.freeze({
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
      ...missMeta,
    });

    // V8-A09: record the complete flat success for reuse (complete
    // successes only — partial results always recompute live, so a
    // cache hit can never be worse than a fresh run). A storage
    // failure never fails a good result.
    if (resultCache !== undefined && cacheKey !== undefined && failedChunks.length === 0) {
      try {
        resultCache.store({
          key: cacheKey.key,
          documentHash: cacheKey.documentHash,
          fingerprint: cacheKey.fingerprint,
          providerId: runtime.capabilities.providerId,
          sourcePageCount: context.sourcePageCount,
          pagesWithoutText: [...context.pagesWithoutText],
          contextTruncated: context.truncated,
          chunks: chunks.map((chunk) => ({
            chunkIndex: chunk.chunkIndex,
            pageNumber: chunk.pageNumber,
            text: chunk.text,
            startOffset: chunk.startOffset,
            endOffset: chunk.endOffset,
          })),
          stage1: [...stage1Tape],
          failedChunks: [],
          evidenceAdmitted,
          selectedEvidenceIds: budgeted.map((item) => item.evidenceId),
          evidenceTruncated,
          sections: sections.map((section) => ({
            sectionIndex: section.sectionIndex,
            pageRange: [...section.pageRange],
            evidenceIds: [...section.evidenceIds],
          })),
          sectionTexts: [{ sectionIndex: sections[0]?.sectionIndex ?? 0, text: stage2Text }],
          rejectedClaims,
        });
      } catch {
        // Cache storage is best-effort by design.
      }
    }

    return flatResult;
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
  missMeta: { cacheStatus: Tier2CacheStatus; avoidedStage1Calls: number; avoidedStage2Calls: number };
  /**
   * V8-A09 tape for a possible complete-success cache entry.
   * Recorded only; the entry is stored solely when every section
   * grounds (failedSections empty) and no chunk failed.
   */
  cacheTape?: {
    cache: Tier2ResultCache;
    keyMaterial: { documentHash: string; fingerprint: Tier2PipelineFingerprint; key: string };
    chunksData: readonly {
      readonly chunkIndex: number;
      readonly pageNumber: number;
      readonly text: string;
      readonly startOffset: number;
      readonly endOffset: number;
    }[];
    stage1Tape: readonly CachedStage1Chunk[];
  };
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
    missMeta,
    cacheTape,
  } = options;
  const viewById = new Map(views.map((view) => [view.evidenceId, view]));
  const failedSections: number[] = [];
  const assembled: GroundedStage2Claim[] = [];
  const sectionTexts: { sectionIndex: number; text: string }[] = [];
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
    sectionTexts.push({ sectionIndex: section.sectionIndex, text: sectionText });
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
      missMeta,
    );
  }

  const hierarchicalResult: Tier2ValidatedSummarizeResult = Object.freeze({
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
    ...missMeta,
  });

  // V8-A09: record the complete hierarchical success for reuse
  // (complete successes only — any failed section or failed chunk
  // means live recompute next time, so a hit can never replay a
  // worse result than a fresh run could produce). A storage failure
  // never fails a good result.
  if (
    cacheTape !== undefined &&
    failedSections.length === 0 &&
    failedChunks.length === 0 &&
    sectionTexts.length === sections.length
  ) {
    try {
      const budgetedIds = options.budgeted.map((item) => item.evidenceId);
      cacheTape.cache.store({
        key: cacheTape.keyMaterial.key,
        documentHash: cacheTape.keyMaterial.documentHash,
        fingerprint: cacheTape.keyMaterial.fingerprint,
        providerId: runtime.capabilities.providerId,
        sourcePageCount: context.sourcePageCount,
        pagesWithoutText: [...context.pagesWithoutText],
        contextTruncated: context.truncated,
        chunks: [...cacheTape.chunksData],
        stage1: [...cacheTape.stage1Tape],
        failedChunks: [],
        evidenceAdmitted,
        selectedEvidenceIds: budgetedIds,
        evidenceTruncated,
        sections: sections.map((section) => ({
          sectionIndex: section.sectionIndex,
          pageRange: [...section.pageRange],
          evidenceIds: [...section.evidenceIds],
        })),
        sectionTexts: [...sectionTexts],
        rejectedClaims,
      });
    } catch {
      // Cache storage is best-effort by design.
    }
  }

  return hierarchicalResult;
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
  cacheMeta: {
    cacheStatus: Tier2CacheStatus;
    avoidedStage1Calls: number;
    avoidedStage2Calls: number;
  } = { cacheStatus: "disabled", avoidedStage1Calls: 0, avoidedStage2Calls: 0 },
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
    cacheStatus: cacheMeta.cacheStatus,
    avoidedStage1Calls: cacheMeta.avoidedStage1Calls,
    avoidedStage2Calls: cacheMeta.avoidedStage2Calls,
  });
}

/** Internal warm-reuse abort: any validation failure falls back to the live cold path. */
class WarmCacheMiss extends Error {
  constructor() {
    super("Warm cache entry unusable; recompute live.");
    this.name = "WarmCacheMiss";
  }
}

/**
 * V8-A09 warm path: replays a validated cache entry with ZERO Ollama
 * generations. Every reused artifact still passes through the real
 * deterministic gates — B03 `admit()` (the store has no raw-item
 * import), V7-A02 selection verification, section `partitionExact`,
 * C02 validation, and C03 grounding — rebuilt against a fresh
 * request EvidenceStore. Returns the grounded result on a full hit,
 * or `null` on ANY mismatch (miss, corruption, provider drift, or
 * revalidation failure) so the caller recomputes live. Never throws
 * outward, never returns a partial result, never caches a failure.
 */
async function tryWarmTier2Summarize(options: {
  cache: Tier2ResultCache;
  keyMaterial: { documentHash: string; fingerprint: Tier2PipelineFingerprint; key: string };
  providerId: string;
}): Promise<Tier2ValidatedSummarizeResult | null> {
  try {
    const { cache, keyMaterial, providerId } = options;
    const entry = cache.lookup(keyMaterial.key, {
      documentHash: keyMaterial.documentHash,
      fingerprint: keyMaterial.fingerprint,
    });
    if (entry === undefined) {
      return null;
    }
    if (entry.providerId !== providerId) {
      throw new WarmCacheMiss();
    }

    // L1 extraction reuse: chunks are recorded data, never reparsed.
    // Fresh (unfrozen) copies keep the cache entry immutable.
    const chunks: AiContextChunk[] = entry.chunks.map((chunk) => ({ ...chunk }));
    const store = EvidenceStore.create({
      chunks: [...chunks],
      sourcePageCount: entry.sourcePageCount,
    });

    // L2 Stage-1 reuse: recorded candidate arrays re-enter through
    // the REAL B03 gate in recorded chunk order, so evidence IDs are
    // deterministically identical. Recorded failures replay exactly.
    const failedChunks: number[] = [];
    for (const record of entry.stage1) {
      if (record.candidates === null) {
        failedChunks.push(record.chunkIndex);
        continue;
      }
      try {
        store.admit(record.chunkIndex, [...record.candidates]);
      } catch {
        failedChunks.push(record.chunkIndex);
      }
    }
    if (
      JSON.stringify(failedChunks) !== JSON.stringify([...entry.failedChunks]) ||
      store.size !== entry.evidenceAdmitted
    ) {
      throw new WarmCacheMiss();
    }

    // L3 selection reuse: the recorded pool identity is verified
    // against live deterministic selection (same code, same budget).
    const snapshot = store.snapshot();
    const budgeted = selectCoverageBalancedEvidence(snapshot, MAX_STAGE2_EVIDENCE_ITEMS);
    const budgetedIds = budgeted.map((item) => item.evidenceId);
    if (JSON.stringify(budgetedIds) !== JSON.stringify([...entry.selectedEvidenceIds])) {
      throw new WarmCacheMiss();
    }
    const views = budgeted.map(toEvidenceView);

    // L4 section reuse: the partition is recomputed and must be
    // exact; every recomputed section must match a recorded section
    // by evidence-ID set (order-insensitive). Anything else is a
    // partition drift → live recompute.
    const sections = partitionSelectedEvidence({
      items: budgeted,
      views,
      sourcePageCount: entry.sourcePageCount,
    });
    if (!isPartitionExact(sections, budgetedIds) || sections.length !== entry.sections.length) {
      throw new WarmCacheMiss();
    }
    const textByEvidenceKey = new Map<string, string>();
    for (const cached of entry.sections) {
      const record = entry.sectionTexts.find(
        (candidate) => candidate.sectionIndex === cached.sectionIndex,
      );
      if (record === undefined) {
        throw new WarmCacheMiss();
      }
      textByEvidenceKey.set([...cached.evidenceIds].sort().join("\u0000"), record.text);
    }
    const sectionTexts = sections.map((section) => {
      const text = textByEvidenceKey.get([...section.evidenceIds].sort().join("\u0000"));
      if (text === undefined) {
        throw new WarmCacheMiss();
      }
      return text;
    });

    // L5 section Stage-2 reuse: recorded RAW model texts go through
    // the unchanged C02/C03 chain. A section that no longer
    // validates or grounds aborts the whole hit (no partial reuse).
    const assembled: GroundedStage2Claim[] = [];
    let rejectedClaims = 0;
    for (const text of sectionTexts) {
      const validated = validateStage2Output(text, { scope: store });
      rejectedClaims += validated.rejected.length;
      if (validated.accepted.length === 0) {
        throw new WarmCacheMiss();
      }
      const grounded = projectGroundedClaims({
        claims: [...validated.accepted],
        store,
        chunks: [...chunks],
      }).grounded;
      assembled.push(...grounded);
    }
    if (assembled.length === 0) {
      throw new WarmCacheMiss();
    }

    return Object.freeze({
      status: "grounded" as const,
      claims: Object.freeze(assembled),
      providerId,
      runtime: "ollama" as const,
      sourcePageCount: entry.sourcePageCount,
      pagesWithoutText: Object.freeze([...entry.pagesWithoutText]),
      contextTruncated: entry.contextTruncated,
      evidenceAdmitted: store.size,
      evidenceTruncated: snapshot.length > MAX_STAGE2_EVIDENCE_ITEMS,
      rejectedClaims,
      failedChunks: Object.freeze(failedChunks),
      sectionCount: sections.length,
      failedSections: Object.freeze([]),
      groundedPages: Object.freeze(groundedPagesOf(assembled, chunks)),
      cacheStatus: "hit" as const,
      avoidedStage1Calls: entry.chunks.length,
      avoidedStage2Calls: entry.sections.length,
    });
  } catch (error) {
    if (error instanceof WarmCacheMiss) {
      return null;
    }
    // Any unexpected failure (including a corrupt entry slipping
    // structural validation) is also a safe miss — never a throw,
    // never a partial display.
    return null;
  }
}
