/**
 * V8-A07 — Deterministic section partition for hierarchical Stage-2.
 *
 * Pure and provider-agnostic: no provider, no network, no DOM, no PDF
 * parsing, no model call, no Evidence Store mutation. Groups an
 * already-selected evidence set (V7-A02 output) into page-contiguous
 * sections for per-section Stage-2 synthesis (V8-A06 Architecture D).
 *
 * Trust rules (mirrors the B03/C02 fail-closed philosophy):
 * - Grouping reads ONLY already-authoritative local metadata on each
 *   `EvidenceItem` (`evidenceId`, `chunkIndex`, `sourcePages`). It
 *   derives no new metadata, mints no IDs, rewrites nothing, and
 *   mutates nothing. Returned sections are fresh frozen objects.
 * - Section metadata is DERIVED data, never document truth: page
 *   ranges come from the items' own `sourcePages` (v1: exactly the
 *   owning page) and must never become claim content (C02 still
 *   rejects such fields).
 * - `partitionExact` invariant: the union of all section evidence IDs
 *   must equal the input ID set exactly (no drops, no duplicates).
 *   The orchestrator must treat a violation as fail-closed.
 *
 * Algorithm (deterministic):
 * 1. Stable-sort input positions by (`sourcePages[0]`, admission
 *    order). v1 items carry exactly the owning page; anything else
 *    well-formed still orders deterministically. Items that cannot be
 *    mapped to a positive page are a caller error and throw
 *    `SectionPartitionError` fail-loud (never guessed, never skipped).
 * 2. Pack sorted runs of same-page items greedily into sections
 *    capped at `maxItemsPerSection`. Pages are ATOMIC: a page's items
 *    are never split across sections, so one dense page may produce
 *    an oversized section (kept whole, never redistributed).
 * 3. Sections whose serialized Stage-2 prompt would exceed
 *    `maxPromptChars` are split at the page boundary nearest the
 *    midpoint (recursively). A single atomic page that alone exceeds
 *    the bound is kept whole.
 */

import type { EvidenceItem } from "../evidence/types";
import type { Stage2EvidenceView } from "./types";
import { buildSectionSummarizePrompt } from "./prompts";

/** Thrown for a malformed partition envelope (caller error, fail-loud). */
export class SectionPartitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SectionPartitionError";
  }
}

/**
 * Initial production section-size bounds (V8-A07 §4: experimentally
 * informed by A04/A06, kept as named constants for later validation
 * and tuning — NOT claimed optimal for 30–50 page documents).
 */
export const SECTION_MAX_ITEMS = 16;
export const SECTION_MAX_PROMPT_CHARS = 3500;

/**
 * One deterministic document section: an ordered, page-contiguous
 * slice of the selected evidence pool. `evidenceIds` are the
 * ORIGINAL root IDs in deterministic (sorted-position) order.
 * `pageRange` is the sorted unique owning pages covered.
 */
export interface DocumentSection {
  readonly sectionIndex: number;
  readonly pageRange: readonly number[];
  readonly evidenceIds: readonly string[];
}

/** Per-section synthesis outcome (populated by the orchestrator). */
export interface SectionResult {
  readonly sectionIndex: number;
  readonly groundedClaims: readonly unknown[];
  readonly failed: boolean;
}

/** Assembled hierarchical result (populated by the orchestrator). */
export interface AssembledSummary {
  readonly sectionResults: readonly SectionResult[];
  readonly unsectionableEvidenceIds: readonly string[];
}

/** Partition options (still runtime-validated — see below). */
export interface PartitionSectionsOptions {
  /** Selected evidence items (V7-A02 output order = admission order). */
  items: readonly EvidenceItem[];
  /** Model-visible views aligned 1:1 with `items` (for prompt sizing). */
  views: readonly Stage2EvidenceView[];
  /** Document page denominator for prompt sizing. */
  sourcePageCount: number;
  /** Maximum items per section before a page-boundary cut. */
  maxItemsPerSection?: number;
  /** Maximum serialized prompt characters per section. */
  maxPromptChars?: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function owningPage(item: EvidenceItem, index: number): number {
  if (!isPlainObject(item) || typeof item.evidenceId !== "string") {
    throw new SectionPartitionError(`items[${index}] must carry an evidenceId string.`);
  }
  if (!Array.isArray(item.sourcePages) || item.sourcePages.length === 0) {
    throw new SectionPartitionError(
      `items[${index}] must carry a non-empty sourcePages array.`,
    );
  }
  const page = (item.sourcePages as readonly unknown[])[0];
  if (!Number.isSafeInteger(page) || (page as number) < 1) {
    throw new SectionPartitionError(
      `items[${index}] must carry a positive owning page.`,
    );
  }
  return page as number;
}

/**
 * Partitions selected evidence into deterministic page-contiguous
 * sections. Never mutates the input; returns fresh frozen sections
 * in page order. Throws `SectionPartitionError` fail-loud for
 * malformed envelopes or unmappable items.
 */
export function partitionSelectedEvidence(
  options: unknown,
): readonly DocumentSection[] {
  if (!isPlainObject(options)) {
    throw new SectionPartitionError("Partition options must be an object.");
  }
  const { items, views, sourcePageCount } = options as {
    items: unknown;
    views: unknown;
    sourcePageCount: unknown;
  };
  if (!Array.isArray(items) || items.length === 0) {
    throw new SectionPartitionError("Partition items must be a non-empty array.");
  }
  if (!Array.isArray(views) || views.length !== items.length) {
    throw new SectionPartitionError("Partition views must align 1:1 with items.");
  }
  if (!Number.isSafeInteger(sourcePageCount) || (sourcePageCount as number) < 1) {
    throw new SectionPartitionError("sourcePageCount must be a positive integer.");
  }
  const { maxItemsPerSection = SECTION_MAX_ITEMS, maxPromptChars = SECTION_MAX_PROMPT_CHARS } =
    options as { maxItemsPerSection?: unknown; maxPromptChars?: unknown };
  if (
    !Number.isSafeInteger(maxItemsPerSection) ||
    (maxItemsPerSection as number) < 1 ||
    !Number.isSafeInteger(maxPromptChars) ||
    (maxPromptChars as number) < 1
  ) {
    throw new SectionPartitionError("Section size bounds must be positive integers.");
  }
  const budget = maxItemsPerSection as number;
  const charBound = maxPromptChars as number;
  const count = sourcePageCount as number;
  const entries = items as EvidenceItem[];
  const projections = views as Stage2EvidenceView[];

  // Stable sort by (owning page, admission order).
  const order = entries.map((_, index) => index);
  order.sort((a, b) => {
    const pageDifference = owningPage(entries[a] as EvidenceItem, a) - owningPage(entries[b] as EvidenceItem, b);
    return pageDifference !== 0 ? pageDifference : a - b;
  });

  // Group into atomic same-page runs.
  const runs: number[][] = [];
  let currentRun: number[] = [];
  let currentPage = -1;
  for (const position of order) {
    const page = owningPage(entries[position] as EvidenceItem, position);
    if (page !== currentPage) {
      if (currentRun.length > 0) {
        runs.push(currentRun);
      }
      currentRun = [position];
      currentPage = page;
    } else {
      currentRun.push(position);
    }
  }
  if (currentRun.length > 0) {
    runs.push(currentRun);
  }

  // Greedy page-atomic packing capped at the item budget.
  const packed: number[][] = [];
  let current: number[] = [];
  for (const run of runs) {
    if (current.length > 0 && current.length + run.length > budget) {
      packed.push(current);
      current = [];
    }
    current.push(...run);
  }
  if (current.length > 0) {
    packed.push(current);
  }

  // Split prompt-oversize sections at the page boundary nearest the
  // midpoint (recursively). A single atomic page that alone exceeds
  // the bound is kept whole.
  const splitByPrompt = (section: number[]): number[][] => {
    const promptLength = buildSectionSummarizePrompt({
      evidence: section.map((position) => projections[position] as Stage2EvidenceView),
      task: "summarize",
      sourcePageCount: count,
    }).length;
    if (promptLength <= charBound) {
      return [section];
    }
    const boundaries: number[] = [];
    for (let k = 1; k < section.length; k += 1) {
      const before = owningPage(entries[section[k - 1] as number] as EvidenceItem, section[k - 1] as number);
      const after = owningPage(entries[section[k] as number] as EvidenceItem, section[k] as number);
      if (before !== after) {
        boundaries.push(k);
      }
    }
    if (boundaries.length === 0) {
      return [section];
    }
    const midpoint = section.length / 2;
    let best = boundaries[0] as number;
    for (const boundary of boundaries) {
      if (Math.abs(boundary - midpoint) < Math.abs(best - midpoint)) {
        best = boundary;
      }
    }
    return [...splitByPrompt(section.slice(0, best)), ...splitByPrompt(section.slice(best))];
  };

  const sections: DocumentSection[] = [];
  for (const group of packed) {
    for (const part of splitByPrompt(group)) {
      const identifiers = part.map((position) => (entries[position] as EvidenceItem).evidenceId);
      const pages = [...new Set(part.map((position) => owningPage(entries[position] as EvidenceItem, position)))].sort(
        (a, b) => a - b,
      );
      sections.push(
        Object.freeze({
          sectionIndex: sections.length,
          pageRange: Object.freeze(pages),
          evidenceIds: Object.freeze(identifiers),
        }),
      );
    }
  }
  return Object.freeze(sections);
}

/**
 * Verifies the `partitionExact` invariant: the union of all section
 * evidence IDs must equal the input ID set exactly — no drops, no
 * duplicates. Returns true when exact; the orchestrator must fail
 * closed on false.
 */
export function isPartitionExact(
  sections: readonly DocumentSection[],
  inputIds: readonly string[],
): boolean {
  const union = new Set<string>();
  for (const section of sections) {
    for (const id of section.evidenceIds) {
      if (union.has(id)) {
        return false;
      }
      union.add(id);
    }
  }
  if (union.size !== inputIds.length) {
    return false;
  }
  for (const id of inputIds) {
    if (!union.has(id)) {
      return false;
    }
  }
  return true;
}
