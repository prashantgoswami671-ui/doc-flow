/**
 * V8-A09 — Caller-owned in-memory cache for expensive Tier-2 grounded
 * artifacts (extraction/chunking, RED3 Stage-1, Evidence Store
 * contents, selection, hierarchical section Stage-2 results).
 *
 * This module is identity + keys + storage + entry validation ONLY.
 * It performs no PDF parsing, no model calls, no network, no DOM,
 * and no browser, server, or telemetry persistence: entries live in
 * a caller-owned `Map` (same philosophy as the in-memory
 * `AiConsentStore`), die with the page session, and are never
 * written to persistent web storage, cookies, a server, or
 * telemetry. Raw PDF bytes are never stored — the cache key
 * references a content hash only.
 *
 * Reuse contract (enforced by the orchestrator in
 * `../tier2Summarize.ts`, not here):
 * - A cache HIT only skips Ollama `/api/generate` calls. Every
 *   reused artifact still passes through the real deterministic
 *   gates on the warm path: B03 `admit()` (no raw-item import),
 *   V7-A02 selection verification, section `partitionExact`, C02
 *   `validateStage2Output`, and C03 `projectGroundedClaims`.
 * - Only COMPLETE grounded successes are stored. Limited results
 *   are never cached (a retry must be allowed to recompute).
 * - Any structural, identity, version, or provenance mismatch is a
 *   MISS: the entry is discarded and the pipeline recomputes live.
 *
 * Storage / lifetime / eviction (documented per A09 §5/§18):
 * - Location: in-memory `Map` inside a caller-owned
 *   `Tier2ResultCache` instance (no serialization boundary crossed
 *   at rest, but every entry is plain JSON-serializable data).
 * - Lifetime: the owning JS session (page lifetime). Nothing
 *   survives reload/restart.
 * - Eviction: LRU with `TIER2_CACHE_MAX_ENTRIES` cap (hits refresh
 *   recency; oldest evicted on overflow).
 * - Invalidation: versioned keys — any document-byte or
 *   configuration change yields a different key (old entries become
 *   unreachable and age out via LRU). Corrupt entries fail
 *   validation and are never returned.
 * - Clearing: `clear()` drops everything (page reload also drops
 *   everything); no management UI is provided.
 *
 * Privacy: entries hold extracted chunk text, candidate spans, and
 * model claim texts (document content, local scope only). No PDF
 * bytes, no passwords, no new network destinations, no telemetry.
 * AI-21 is untouched (consent/availability gating still runs before
 * every lookup — including warm hits).
 */

import { isValidEvidenceId } from "../evidence/ids";

/** Thrown for cache misuse (caller error, fail-loud). */
export class Tier2CacheError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Tier2CacheError";
  }
}

/**
 * Cache pipeline version. Bump whenever the CACHED ARTIFACT SHAPE
 * or the reuse contract in this module changes. Production behavior
 * changes in the pipeline itself are versioned through the
 * fingerprint components below (owned by the orchestrator, which
 * holds the constants).
 */
export const TIER2_CACHE_PIPELINE_VERSION = 1;

/**
 * Stage-1 prompt/config version. A RED3 Stage-1 prompt or candidate
 * contract change MUST bump this, or stale spans would be reused.
 */
export const TIER2_STAGE1_PROMPT_VERSION = 1;

/**
 * Section Stage-2 prompt/config version. A section prompt, claim
 * schema, or synthesis contract change MUST bump this, or stale
 * section texts would be reused.
 */
export const TIER2_STAGE2_PROMPT_VERSION = 1;

/**
 * Stage-2 validator version. A C02 semantic change MUST bump this,
 * or section texts validated under older rules would be reused.
 */
export const TIER2_STAGE2_VALIDATOR_VERSION = 1;

/** Maximum cached documents per cache instance (LRU-evicted). */
export const TIER2_CACHE_MAX_ENTRIES = 8;

/**
 * Pipeline fingerprint: every configuration whose semantics feed a
 * cached artifact. The orchestrator builds this from its own live
 * constants (single source of truth — no duplication here), so a
 * budget/token/model change automatically changes the key.
 */
export interface Tier2PipelineFingerprint {
  /** `TIER2_CACHE_PIPELINE_VERSION` — artifact-shape/contract version. */
  readonly pipelineVersion: number;
  /** Extraction/chunking config (bounds that shape chunks). */
  readonly extraction: string;
  /** Stage-1 config (token ceiling + `TIER2_STAGE1_PROMPT_VERSION`). */
  readonly stage1: string;
  /** Selection config (budget that shapes the selected pool). */
  readonly selection: string;
  /** Sectioning config (bounds that shape the partition). */
  readonly sectioning: string;
  /** Stage-2 config (token ceiling + prompt/validator versions). */
  readonly stage2: string;
  /** Model/runtime config the artifact depends on. */
  readonly model: string;
}

/** One cached per-chunk Stage-1 outcome. `candidates: null` = chunk failed. */
export interface CachedStage1Chunk {
  readonly chunkIndex: number;
  readonly candidates: readonly unknown[] | null;
}

/** One cached section descriptor (identity for section-result reuse). */
export interface CachedSection {
  readonly sectionIndex: number;
  readonly pageRange: readonly number[];
  readonly evidenceIds: readonly string[];
}

/** One cached raw section Stage-2 model text (re-validated on reuse). */
export interface CachedSectionText {
  readonly sectionIndex: number;
  readonly text: string;
}

/**
 * Complete cached grounded artifacts for one document + fingerprint.
 * Plain JSON-serializable data only: no `File`, no `Blob`, no PDF
 * bytes, no store instance, no runtime. Chunks carry extracted text
 * (document content, local in-memory scope only).
 */
export interface CachedTier2Artifacts {
  readonly key: string;
  readonly documentHash: string;
  readonly fingerprint: Tier2PipelineFingerprint;
  readonly providerId: string;
  readonly sourcePageCount: number;
  readonly pagesWithoutText: readonly number[];
  readonly contextTruncated: boolean;
  readonly chunks: readonly {
    readonly chunkIndex: number;
    readonly pageNumber: number;
    readonly text: string;
    readonly startOffset: number;
    readonly endOffset: number;
  }[];
  readonly stage1: readonly CachedStage1Chunk[];
  readonly failedChunks: readonly number[];
  readonly evidenceAdmitted: number;
  readonly selectedEvidenceIds: readonly string[];
  readonly evidenceTruncated: boolean;
  readonly sections: readonly CachedSection[];
  readonly sectionTexts: readonly CachedSectionText[];
  readonly rejectedClaims: number;
}

/**
 * Deterministic content hash over raw PDF bytes (cyrb53, 106-bit,
 * hex). Sync and dependency-free so browser, jsdom, and node agree
 * exactly. Content identity: filename/path/object identity never
 * enter the hash — changed bytes always change the digest even when
 * name, path, and page count are identical.
 */
export function hashDocumentBytes(bytes: Uint8Array): string {
  const lo = cyrb53(bytes, 0x9e37);
  const hi = cyrb53(bytes, 0x85eb);
  return `${hi.toString(16).padStart(14, "0")}${lo.toString(16).padStart(14, "0")}`;
}

function cyrb53(bytes: Uint8Array, seed: number): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i] as number;
    h1 = Math.imul(h1 ^ byte, 2654435761);
    h2 = Math.imul(h2 ^ byte, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0) * 4294967296 + (h1 >>> 0);
}

/**
 * Builds the versioned cache key. Pure and deterministic: identical
 * document hash + identical fingerprint always yield the identical
 * key; ANY component change yields a different key (fail-closed
 * against stale reuse — old entries simply never match again).
 */
export function buildTier2CacheKey(
  documentHash: string,
  fingerprint: Tier2PipelineFingerprint,
): string {
  if (typeof documentHash !== "string" || documentHash.length === 0) {
    throw new Tier2CacheError("Document hash must be a non-empty string.");
  }
  assertFingerprint(fingerprint);
  return [
    `v${fingerprint.pipelineVersion}`,
    `doc=${documentHash}`,
    `ext=${fingerprint.extraction}`,
    `s1=${fingerprint.stage1}`,
    `sel=${fingerprint.selection}`,
    `sec=${fingerprint.sectioning}`,
    `s2=${fingerprint.stage2}`,
    `model=${fingerprint.model}`,
  ].join("|");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertFingerprint(fingerprint: unknown): asserts fingerprint is Tier2PipelineFingerprint {
  if (!isPlainObject(fingerprint)) {
    throw new Tier2CacheError("Pipeline fingerprint must be an object.");
  }
  for (const field of [
    "pipelineVersion",
    "extraction",
    "stage1",
    "selection",
    "sectioning",
    "stage2",
    "model",
  ] as const) {
    const value = fingerprint[field];
    if (field === "pipelineVersion") {
      if (!Number.isSafeInteger(value) || (value as number) < 1) {
        throw new Tier2CacheError("Fingerprint pipelineVersion must be a positive integer.");
      }
    } else if (typeof value !== "string" || (value as string).length === 0) {
      throw new Tier2CacheError(`Fingerprint ${field} must be a non-empty string.`);
    }
  }
}

/**
 * Validates a cached entry against its expected key/hash/fingerprint
 * WITHOUT trusting it: structure, evidence-ID shapes, chunk shapes,
 * section/text coverage, and config identity are all re-checked. Any
 * mismatch returns false (caller treats it as a MISS and recomputes).
 */
export function isValidCachedTier2Entry(
  entry: unknown,
  expected: { key: string; documentHash: string; fingerprint: Tier2PipelineFingerprint },
): entry is CachedTier2Artifacts {
  if (!isPlainObject(entry)) {
    return false;
  }
  if (entry.key !== expected.key || entry.documentHash !== expected.documentHash) {
    return false;
  }
  try {
    assertFingerprint(entry.fingerprint);
  } catch {
    return false;
  }
  if (JSON.stringify(entry.fingerprint) !== JSON.stringify(expected.fingerprint)) {
    return false;
  }
  if (typeof entry.providerId !== "string" || entry.providerId.length === 0) {
    return false;
  }
  if (!Number.isSafeInteger(entry.sourcePageCount) || (entry.sourcePageCount as number) < 1) {
    return false;
  }
  if (
    !Array.isArray(entry.pagesWithoutText) ||
    (entry.pagesWithoutText as unknown[]).some(
      (page) => !Number.isSafeInteger(page) || (page as number) < 1,
    )
  ) {
    return false;
  }
  if (!Array.isArray(entry.chunks) || (entry.chunks as unknown[]).length === 0) {
    return false;
  }
  for (const chunk of entry.chunks as unknown[]) {
    if (
      !isPlainObject(chunk) ||
      !Number.isSafeInteger(chunk.chunkIndex) ||
      !Number.isSafeInteger(chunk.pageNumber) ||
      typeof chunk.text !== "string" ||
      !Number.isSafeInteger(chunk.startOffset) ||
      !Number.isSafeInteger(chunk.endOffset)
    ) {
      return false;
    }
  }
  if (!Array.isArray(entry.stage1) || !Array.isArray(entry.failedChunks)) {
    return false;
  }
  for (const record of entry.stage1 as unknown[]) {
    if (!isPlainObject(record) || !Number.isSafeInteger(record.chunkIndex)) {
      return false;
    }
    if (record.candidates !== null && !Array.isArray(record.candidates)) {
      return false;
    }
  }
  if (
    !Number.isSafeInteger(entry.evidenceAdmitted) ||
    (entry.evidenceAdmitted as number) < 1 ||
    !Array.isArray(entry.selectedEvidenceIds) ||
    (entry.selectedEvidenceIds as unknown[]).length === 0
  ) {
    return false;
  }
  for (const id of entry.selectedEvidenceIds as unknown[]) {
    if (!isValidEvidenceId(id)) {
      return false;
    }
  }
  if (!Array.isArray(entry.sections) || (entry.sections as unknown[]).length === 0) {
    return false;
  }
  const sectionIndexes = new Set<number>();
  for (const section of entry.sections as unknown[]) {
    if (
      !isPlainObject(section) ||
      !Number.isSafeInteger(section.sectionIndex) ||
      !Array.isArray(section.pageRange) ||
      !Array.isArray(section.evidenceIds) ||
      (section.evidenceIds as unknown[]).length === 0
    ) {
      return false;
    }
    for (const id of section.evidenceIds as unknown[]) {
      if (!isValidEvidenceId(id)) {
        return false;
      }
    }
    sectionIndexes.add(section.sectionIndex as number);
  }
  // Every section must carry exactly one raw model text (incomplete
  // section sets are corruption, never a partial hit).
  if (!Array.isArray(entry.sectionTexts)) {
    return false;
  }
  const textIndexes = new Set<number>();
  for (const record of entry.sectionTexts as unknown[]) {
    if (!isPlainObject(record) || !Number.isSafeInteger(record.sectionIndex) || typeof record.text !== "string") {
      return false;
    }
    textIndexes.add(record.sectionIndex as number);
  }
  if (textIndexes.size !== sectionIndexes.size) {
    return false;
  }
  for (const index of sectionIndexes) {
    if (!textIndexes.has(index)) {
      return false;
    }
  }
  return true;
}

/**
 * Caller-owned in-memory result cache. Instances are cheap and
 * isolated: the UI owns one per card, tests own one per case — no
 * global singleton, so no cross-test or cross-document leakage is
 * possible beyond exact key matches. All methods are synchronous.
 */
export class Tier2ResultCache {
  private readonly entries = new Map<string, CachedTier2Artifacts>();
  private readonly maxEntries: number;

  constructor(maxEntries: number = TIER2_CACHE_MAX_ENTRIES) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new Tier2CacheError("Cache capacity must be a positive integer.");
    }
    this.maxEntries = maxEntries;
  }

  /** Validated lookup: returns the frozen entry or `undefined` (MISS). */
  lookup(
    key: string,
    expected: { documentHash: string; fingerprint: Tier2PipelineFingerprint },
  ): CachedTier2Artifacts | undefined {
    if (typeof key !== "string" || key.length === 0) {
      throw new Tier2CacheError("Cache lookup key must be a non-empty string.");
    }
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return undefined;
    }
    if (!isValidCachedTier2Entry(entry, { key, ...expected })) {
      // Corrupt/stale entry: never trusted, evicted immediately.
      this.entries.delete(key);
      return undefined;
    }
    // LRU refresh: hits renew recency.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  /** Stores a complete entry (validated + frozen). Replaces same-key entries. */
  store(entry: CachedTier2Artifacts): void {
    if (
      !isValidCachedTier2Entry(entry, {
        key: (entry as { key?: unknown }).key as string,
        documentHash: (entry as { documentHash?: unknown }).documentHash as string,
        fingerprint: (entry as { fingerprint?: unknown }).fingerprint as Tier2PipelineFingerprint,
      })
    ) {
      throw new Tier2CacheError("Refusing to store an invalid cache entry.");
    }
    const frozen = freezeEntry(entry);
    this.entries.delete(frozen.key);
    this.entries.set(frozen.key, frozen);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) {
        break;
      }
      this.entries.delete(oldest.value);
    }
  }

  /** Drops all entries. */
  clear(): void {
    this.entries.clear();
  }

  /** Current entry count (diagnostics/tests only). */
  get size(): number {
    return this.entries.size;
  }
}

function freezeEntry(entry: CachedTier2Artifacts): CachedTier2Artifacts {
  return Object.freeze({
    ...entry,
    fingerprint: Object.freeze({ ...entry.fingerprint }),
    pagesWithoutText: Object.freeze([...entry.pagesWithoutText]),
    chunks: Object.freeze(entry.chunks.map((chunk) => Object.freeze({ ...chunk }))),
    stage1: Object.freeze(
      entry.stage1.map((record) =>
        Object.freeze({
          ...record,
          candidates:
            record.candidates === null ? null : Object.freeze([...record.candidates]),
        }),
      ),
    ),
    failedChunks: Object.freeze([...entry.failedChunks]),
    selectedEvidenceIds: Object.freeze([...entry.selectedEvidenceIds]),
    sections: Object.freeze(
      entry.sections.map((section) =>
        Object.freeze({
          ...section,
          pageRange: Object.freeze([...section.pageRange]),
          evidenceIds: Object.freeze([...section.evidenceIds]),
        }),
      ),
    ),
    sectionTexts: Object.freeze(entry.sectionTexts.map((record) => Object.freeze({ ...record }))),
  });
}
