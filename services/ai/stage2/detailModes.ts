/**
 * V8-A08 — Deterministic detail-mode projection over an assembled
 * hierarchical grounded claim set (V8-A07 output).
 *
 * Production flow position (no pipeline rerun):
 *
 *   PDF → AI-02 extraction/chunking → RED3 Stage-1 → Evidence Store
 *     → V7-A02 selection → V8-A07 hierarchical section Stage-2
 *     → C02 → C03 → assembled grounded claims
 *     → MODE PROJECTION (this module) → UI
 *
 * Mode selection occurs AFTER the grounded hierarchical claim set
 * exists. Switching modes must NOT rerun extraction, chunking, RED3
 * Stage-1, evidence acquisition, Evidence Store construction,
 * evidence selection, or section Stage-2 calls. This module performs
 * no I/O, no LLM call, and no acquisition: it only selects, orders,
 * and groups already-grounded claims.
 *
 * Mode semantics (grounded information density and coverage — never
 * fixed word counts):
 * - Concise: major claims, broad document coverage, high-value
 *   information, redundant supporting detail removed. NOT the first N
 *   claims: one representative claim per grounded page (round-robin
 *   page coverage), so broad section representation survives.
 * - Detailed: substantially more grounded information than Concise:
 *   every non-redundant claim (near-duplicate suppression only).
 * - Very Detailed: essentially all assembled supported information
 *   (no suppression).
 *
 * Projection rules (hard invariants):
 * - May: select, suppress redundant, order (original order preserved
 *   in output), group, control density.
 * - Must NOT: invent claims, modify validated claim text, invent
 *   evidence IDs, invent pages, create unsupported statements, call
 *   the LLM, or weaken C02/C03 grounding. Output claim objects are
 *   the SAME frozen references (identity-preserved), never copies
 *   with rewritten text.
 * - Every displayed factual claim retains its original root
 *   evidenceIds, resolvable through the Evidence Store
 *   (claim → evidenceId → immutable exactText → source page/chunk).
 *
 * Priority model (deterministic, explainable, no LLM ranking, no
 * magic importance score — lexicographic tuple only):
 * 1. Section/page coverage (greedy page-coverage for Concise).
 * 2. Claim distinctness (token Jaccard < threshold survives).
 * 3. Evidence breadth (distinct pages desc, distinct IDs desc).
 * 4. Supporting evidence count (evidenceIds length desc).
 * 5. Redundancy relationship (near-duplicate of an earlier retained
 *    claim is suppressed in Concise/Detailed).
 * 6. Original section order (approximated by primary page asc).
 * 7. Original claim order (earlier index wins every tie).
 *
 * Coverage behavior: every projection reports selected/displayed
 * claims, distinct cited evidence IDs, grounded pages represented,
 * represented/omitted sections (page-backed when explicit sections
 * are absent), contiguous page gaps, omitted claims, character
 * count, and summary/source ratio (when the source denominator is
 * supplied). Intentional omissions are reported separately from
 * source-document gaps (image-only pages, evidenceless pages,
 * failed sections) and must never be conflated.
 */

import type { GroundedStage2Claim } from "./projection";
import type { DocumentSection } from "./sections";

/** User-facing detail modes. */
export type DetailMode = "concise" | "detailed" | "very-detailed";

/** All modes in stable display order. */
export const DETAIL_MODES: readonly DetailMode[] = Object.freeze([
  "concise",
  "detailed",
  "very-detailed",
]);

/** Thrown for a malformed projection envelope (caller error, fail-loud). */
export class DetailModeProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DetailModeProjectionError";
  }
}

/**
 * Input to mode projection: the ALREADY-assembled grounded claim set
 * plus document-coverage denominators. `claims` must be the exact
 * `Tier2ValidatedSummarizeResult["claims"]` array (identity is
 * preserved, never cloned).
 */
export interface ProjectDetailModeOptions {
  /** Assembled grounded claims (V8-A07 output order). */
  claims: readonly GroundedStage2Claim[];
  /** Document page denominator (one-based page count). */
  sourcePageCount: number;
  /** Image-only pages (never coverable — source gap, not omission). */
  pagesWithoutText?: readonly number[];
  /** Failed section indexes (recorded coverage gaps — never retried). */
  failedSections?: readonly number[];
  /** Deterministic sections (optional; page-backed fallback otherwise). */
  sections?: readonly DocumentSection[];
  /** Total source characters (optional; ratio is null when absent). */
  sourceChars?: number;
}

/** One contiguous page range with no selected claim. */
export type PageGap = readonly number[];

/**
 * Deterministic projection of one mode over the shared claim set.
 * All arrays frozen. `claims` holds the SAME object references as
 * the input (no text/ID rewriting). Index arrays refer to positions
 * in the input `claims` array.
 */
export interface DetailModeProjection {
  readonly mode: DetailMode;
  /** Displayed claims in ORIGINAL input order (subset, same refs). */
  readonly claims: readonly GroundedStage2Claim[];
  /** Input positions displayed. */
  readonly selectedIndexes: readonly number[];
  /** Input positions intentionally omitted (lower priority — NOT a source gap). */
  readonly omittedIndexes: readonly number[];
  /** Sorted distinct root evidence IDs cited by displayed claims. */
  readonly distinctEvidenceIds: readonly string[];
  /** Sorted unique source pages carrying displayed evidence. */
  readonly groundedPages: readonly number[];
  /** Sorted unique source pages carrying ANY assembled claim (mode-independent). */
  readonly fullGroundedPages: readonly number[];
  /** Full-set pages intentionally omitted by this mode (subset of full set). */
  readonly omittedPages: readonly number[];
  /** Image-only pages echoed from input (source gap, never "covered"). */
  readonly imageOnlyPages: readonly number[];
  /** Source pages with no assembled claim and not image-only (evidenceless). */
  readonly evidencelessPages: readonly number[];
  /** Failed sections echoed from input (source gap, never redistributed). */
  readonly failedSections: readonly number[];
  /** Section indexes with ≥1 displayed claim (page-backed when sections absent). */
  readonly representedSections: readonly number[];
  /** Sections with claims in the full set but none displayed (intentional). */
  readonly omittedSections: readonly number[];
  /** Maximal contiguous page ranges with no displayed claim. */
  readonly contiguousPageGaps: readonly PageGap[];
  /** Sum of displayed claim `text.length` (separator-free, documented). */
  readonly characterCount: number;
  /** `characterCount / sourceChars`, or null when the denominator is absent. */
  readonly summarySourceRatio: number | null;
}

/** Near-duplicate threshold on token Jaccard (documented, deterministic). */
export const DETAIL_MODE_REDUNDANCY_JACCARD = 0.6;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertValidClaims(claims: unknown): asserts claims is readonly GroundedStage2Claim[] {
  if (!Array.isArray(claims)) {
    throw new DetailModeProjectionError("Projection claims must be an array.");
  }
  for (let index = 0; index < claims.length; index += 1) {
    const entry = claims[index];
    if (!isPlainObject(entry)) {
      throw new DetailModeProjectionError(`Claim ${index} is malformed.`);
    }
    if (typeof entry.text !== "string" || typeof entry.kind !== "string") {
      throw new DetailModeProjectionError(`Claim ${index} is malformed.`);
    }
    if (!Array.isArray(entry.evidenceIds) || !Array.isArray(entry.evidence)) {
      throw new DetailModeProjectionError(`Claim ${index} is malformed.`);
    }
  }
}

/** Lowercase alphanumeric token set (length > 1) for distinctness. */
function tokensOf(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((token) => token.length > 1);
  return new Set(tokens);
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) {
      intersection += 1;
    }
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Sorted unique source pages carrying one claim's evidence (never invented). */
function claimPages(claim: GroundedStage2Claim): number[] {
  const pages = new Set<number>();
  for (const grounded of claim.evidence) {
    const item = grounded?.item as { sourcePages?: unknown } | undefined;
    const list = item?.sourcePages;
    if (Array.isArray(list)) {
      for (const page of list) {
        if (Number.isSafeInteger(page) && (page as number) >= 1) {
          pages.add(page as number);
        }
      }
    }
  }
  return [...pages].sort((a, b) => a - b);
}

/** Primary page: minimum owning page, or -1 when a claim carries no page (fail-open ordering only). */
function primaryPage(claim: GroundedStage2Claim): number {
  const pages = claimPages(claim);
  return pages.length > 0 ? (pages[0] as number) : -1;
}

interface RankedClaim {
  index: number;
  claim: GroundedStage2Claim;
  pages: number[];
  distinctIds: number;
  evidenceCount: number;
  charLen: number;
  tokens: Set<string>;
}

/**
 * Priority comparison (lower = higher priority). Lexicographic over
 * documented signals only: evidence breadth (pages, then IDs), then
 * supporting count, then informativeness (char length), then original
 * order. No hidden score.
 */
function comparePriority(left: RankedClaim, right: RankedClaim): number {
  if (left.pages.length !== right.pages.length) {
    return right.pages.length - left.pages.length;
  }
  if (left.distinctIds !== right.distinctIds) {
    return right.distinctIds - left.distinctIds;
  }
  if (left.evidenceCount !== right.evidenceCount) {
    return right.evidenceCount - left.evidenceCount;
  }
  if (left.charLen !== right.charLen) {
    return right.charLen - left.charLen;
  }
  return left.index - right.index;
}

function toRanked(claims: readonly GroundedStage2Claim[]): RankedClaim[] {
  return claims.map((claim, index) => ({
    index,
    claim,
    pages: claimPages(claim),
    distinctIds: new Set(claim.evidenceIds as readonly string[]).size,
    evidenceCount: (claim.evidenceIds as readonly string[]).length,
    charLen: claim.text.length,
    tokens: tokensOf(claim.text),
  }));
}

/**
 * Greedy near-duplicate suppression in priority order: a claim is
 * redundant when its token Jaccard against ANY already-retained
 * higher-or-equal-priority claim meets the threshold. Deterministic:
 * priority order is total (ties broken by original index).
 */
function suppressRedundant(ranked: RankedClaim[]): RankedClaim[] {
  const ordered = [...ranked].sort(comparePriority);
  const retained: RankedClaim[] = [];
  for (const candidate of ordered) {
    let redundant = false;
    for (const kept of retained) {
      if (jaccard(candidate.tokens, kept.tokens) >= DETAIL_MODE_REDUNDANCY_JACCARD) {
        redundant = true;
        break;
      }
    }
    if (!redundant) {
      retained.push(candidate);
    }
  }
  return retained;
}

/**
 * Concise selection: one representative claim per grounded page.
 * Within each primary-page group the highest-priority non-redundant
 * claim wins; groups are emitted in page order, and claims keep
 * original relative order in the final output (NOT first-N).
 */
function selectConcise(ranked: RankedClaim[]): Set<number> {
  const survivors = suppressRedundant(ranked);
  const byPage = new Map<number, RankedClaim[]>();
  for (const entry of survivors) {
    const key = primaryPage(entry.claim);
    const group = byPage.get(key);
    if (group) {
      group.push(entry);
    } else {
      byPage.set(key, [entry]);
    }
  }
  const selected = new Set<number>();
  const orderedPages = [...byPage.keys()].sort((a, b) => a - b);
  for (const page of orderedPages) {
    const group = (byPage.get(page) as RankedClaim[]).sort(comparePriority);
    const winner = group[0];
    if (winner) {
      selected.add(winner.index);
    }
  }
  return selected;
}

function sortedUnique(numbers: Iterable<number>): number[] {
  return [...new Set(numbers)].sort((a, b) => a - b);
}

function contiguousRanges(absent: Set<number>, sourcePageCount: number): readonly PageGap[] {
  const ranges: number[][] = [];
  let current: number[] = [];
  for (let page = 1; page <= sourcePageCount; page += 1) {
    if (absent.has(page)) {
      current.push(page);
    } else if (current.length > 0) {
      ranges.push(current);
      current = [];
    }
  }
  if (current.length > 0) {
    ranges.push(current);
  }
  return Object.freeze(ranges.map((range) => Object.freeze(range))) as readonly PageGap[];
}

/** Maps an evidence ID to its section index via membership (original root IDs only). */
function sectionOfEvidence(
  sections: readonly DocumentSection[] | undefined,
  evidenceId: string,
): number | undefined {
  if (!sections) {
    return undefined;
  }
  for (const section of sections) {
    if (section.evidenceIds.includes(evidenceId)) {
      return section.sectionIndex;
    }
  }
  return undefined;
}

/** Maps a claim to section indexes via its root evidence IDs. */
function claimSections(
  claim: GroundedStage2Claim,
  sections: readonly DocumentSection[] | undefined,
): number[] {
  if (!sections) {
    return [];
  }
  const found = new Set<number>();
  for (const id of claim.evidenceIds as readonly string[]) {
    const section = sectionOfEvidence(sections, id);
    if (section !== undefined) {
      found.add(section);
    }
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * Projects the shared assembled claim set to one detail mode.
 * Pure, synchronous, deterministic: same input claim set produces
 * the same mode output. No LLM, no acquisition, no mutation.
 */
export function projectDetailMode(
  options: unknown,
  mode: DetailMode,
): DetailModeProjection {
  if (mode !== "concise" && mode !== "detailed" && mode !== "very-detailed") {
    throw new DetailModeProjectionError("Unknown detail mode.");
  }
  if (!isPlainObject(options)) {
    throw new DetailModeProjectionError("Projection options must be an object.");
  }
  const {
    claims,
    sourcePageCount,
    pagesWithoutText = [],
    failedSections = [],
    sections,
    sourceChars,
  } = options as {
    claims: unknown;
    sourcePageCount: unknown;
    pagesWithoutText?: unknown;
    failedSections?: unknown;
    sections?: unknown;
    sourceChars?: unknown;
  };
  assertValidClaims(claims);
  if (!Number.isSafeInteger(sourcePageCount) || (sourcePageCount as number) < 1) {
    throw new DetailModeProjectionError("sourcePageCount must be a positive integer.");
  }
  if (
    pagesWithoutText !== undefined &&
    (!Array.isArray(pagesWithoutText) ||
      pagesWithoutText.some((page) => !Number.isSafeInteger(page) || (page as number) < 1))
  ) {
    throw new DetailModeProjectionError("pagesWithoutText must be an array of positive integers.");
  }
  if (
    failedSections !== undefined &&
    (!Array.isArray(failedSections) ||
      failedSections.some((section) => !Number.isSafeInteger(section) || (section as number) < 0))
  ) {
    throw new DetailModeProjectionError("failedSections must be an array of section indexes.");
  }
  if (
    sections !== undefined &&
    (!Array.isArray(sections) ||
      sections.some(
        (section) =>
          !isPlainObject(section) ||
          !Number.isSafeInteger((section as Record<string, unknown>).sectionIndex) ||
          !Array.isArray((section as Record<string, unknown>).evidenceIds),
      ))
  ) {
    throw new DetailModeProjectionError("sections must be a DocumentSection array.");
  }
  if (
    sourceChars !== undefined &&
    (typeof sourceChars !== "number" || !(sourceChars > 0) || !Number.isFinite(sourceChars))
  ) {
    throw new DetailModeProjectionError("sourceChars must be a positive number when supplied.");
  }

  const pageCount = sourcePageCount as number;
  const imageOnly = sortedUnique((pagesWithoutText ?? []) as number[]);
  const failed = sortedUnique((failedSections ?? []) as number[]);
  const typedSections = sections as readonly DocumentSection[] | undefined;

  const ranked = toRanked(claims);

  // Full-set coverage (mode-independent ground truth for gap labeling).
  const fullPageSet = new Set<number>();
  for (const entry of ranked) {
    for (const page of entry.pages) {
      fullPageSet.add(page);
    }
  }
  const fullGroundedPages = sortedUnique(fullPageSet);

  let selectedSet: Set<number>;
  if (mode === "very-detailed") {
    selectedSet = new Set(ranked.map((entry) => entry.index));
  } else if (mode === "detailed") {
    selectedSet = new Set(suppressRedundant(ranked).map((entry) => entry.index));
  } else {
    selectedSet = selectConcise(ranked);
  }

  const selectedIndexes = Object.freeze(
    ranked
      .map((entry) => entry.index)
      .filter((index) => selectedSet.has(index))
      .sort((a, b) => a - b),
  );
  const omittedIndexes = Object.freeze(
    ranked.map((entry) => entry.index).filter((index) => !selectedSet.has(index)),
  );

  // Identity preservation: SAME frozen claim references, original order.
  const displayed = Object.freeze(selectedIndexes.map((index) => claims[index] as GroundedStage2Claim));

  const idSet = new Set<string>();
  const selectedPageSet = new Set<number>();
  let characterCount = 0;
  for (const claim of displayed) {
    for (const id of claim.evidenceIds as readonly string[]) {
      idSet.add(id);
    }
    for (const page of claimPages(claim)) {
      selectedPageSet.add(page);
    }
    characterCount += claim.text.length;
  }
  const distinctEvidenceIds = Object.freeze([...idSet].sort());
  const groundedPages = sortedUnique(selectedPageSet);
  const omittedPages = Object.freeze(fullGroundedPages.filter((page) => !selectedPageSet.has(page)));

  // Source gaps (document truth — never conflated with intentional omission).
  const imageOnlySet = new Set(imageOnly);
  const evidencelessPages = Object.freeze(
    Array.from({ length: pageCount }, (_, k) => k + 1).filter(
      (page) => !fullPageSet.has(page) && !imageOnlySet.has(page),
    ),
  );

  // Section representation: explicit sections when supplied, else page-backed.
  let representedSections: readonly number[];
  let omittedSections: readonly number[];
  if (typedSections && typedSections.length > 0) {
    const fullBySection = new Map<number, number>();
    for (const entry of ranked) {
      for (const section of claimSections(entry.claim, typedSections)) {
        fullBySection.set(section, (fullBySection.get(section) ?? 0) + 1);
      }
    }
    const selectedBySection = new Set<number>();
    for (const claim of displayed) {
      for (const section of claimSections(claim, typedSections)) {
        selectedBySection.add(section);
      }
    }
    representedSections = Object.freeze([...selectedBySection].sort((a, b) => a - b));
    omittedSections = Object.freeze(
      [...fullBySection.keys()].filter((section) => !selectedBySection.has(section)).sort((a, b) => a - b),
    );
  } else {
    representedSections = Object.freeze([...groundedPages]);
    omittedSections = Object.freeze([...omittedPages]);
  }

  const absentSelected = new Set<number>();
  for (let page = 1; page <= pageCount; page += 1) {
    if (!selectedPageSet.has(page)) {
      absentSelected.add(page);
    }
  }

  return Object.freeze({
    mode,
    claims: displayed,
    selectedIndexes,
    omittedIndexes,
    distinctEvidenceIds,
    groundedPages: Object.freeze(groundedPages),
    fullGroundedPages: Object.freeze(fullGroundedPages),
    omittedPages,
    imageOnlyPages: Object.freeze(imageOnly),
    evidencelessPages,
    failedSections: Object.freeze(failed),
    representedSections,
    omittedSections,
    contiguousPageGaps: contiguousRanges(absentSelected, pageCount),
    characterCount,
    summarySourceRatio:
      sourceChars === undefined ? null : characterCount / (sourceChars as number),
  });
}

/**
 * Projects ALL three modes from the SAME assembled claim set.
 * Convenience for the UI switcher and for validation: one input,
 * three deterministic outputs, zero acquisition.
 */
export function projectAllDetailModes(options: unknown): Record<DetailMode, DetailModeProjection> {
  if (!isPlainObject(options)) {
    throw new DetailModeProjectionError("Projection options must be an object.");
  }
  return Object.freeze({
    concise: projectDetailMode(options, "concise"),
    detailed: projectDetailMode(options, "detailed"),
    "very-detailed": projectDetailMode(options, "very-detailed"),
  });
}
