/**
 * V7-A02 — Deterministic coverage-balanced evidence selection.
 *
 * Replaces "first-N admitted items" with a page/chunk-spread selection
 * for the Stage-2 evidence pool. Pure and provider-agnostic: no
 * provider, no network, no DOM, no PDF parsing, no model call.
 *
 * Trust rules (mirrors the B03/C02 fail-closed philosophy):
 * - The selector uses ONLY already-authoritative local metadata on
 *   each `EvidenceItem` (`evidenceId`, `chunkIndex`, `sourcePages`,
 *   `exactText`, `kind`, `value`). It derives no new metadata, mints
 *   no IDs, and rewrites nothing.
 * - The input array and the `EvidenceStore` are never mutated. The
 *   returned items are the ORIGINAL objects (identity preserved), in
 *   a fresh frozen array. The store itself is never reordered.
 * - A malformed selection envelope (non-array input, non-positive
 *   `maxItems`, or an item that cannot be mapped to a deterministic
 *   group) is a caller error and throws `EvidenceSelectionError`
 *   fail-loud. Malformed evidence is never repaired or skipped
 *   silently — admission-time validation (B03/B04) remains the only
 *   place items enter the system.
 *
 * Algorithm (largest-remainder quota over deterministic groups):
 * 1. Group items by their authoritative `sourcePages` value (sorted
 *    numerically, joined — v1 production evidence carries exactly the
 *    owning page; multi-page values stay representable without
 *    assuming single-page layout). Items keep input (admission) order
 *    inside each group.
 * 2. Order groups deterministically: lowest page first, then the
 *    earliest-admitted group, so the same input always yields the
 *    same groups.
 * 3. Deal `maxItems` slots largest-remainder style: every group gets
 *    `floor(maxItems / groupCount)`, and the first
 *    `maxItems % groupCount` groups get one extra slot. Thin pages
 *    therefore cannot be starved by dense pages.
 * 4. Take up to quota from each group in input order. Unused quota
 *    (a group holding fewer items than its share) is redistributed
 *    round-robin in group order to groups that still hold items.
 * 5. Stop at exactly `maxItems` (or fewer when the input is
 *    exhausted). The output preserves ORIGINAL INPUT ORDER (a stable
 *    selection, not a regrouped one), so the only behavior change
 *    versus first-N is WHICH items are present.
 *
 * No importance score, no semantic ranking, no fuzzy matching, no
 * model-output scoring, no randomness. Output size is bounded by
 * `maxItems`, so the existing Stage-2 contract needs no change.
 */

import type { EvidenceItem } from "./types";

/** Thrown for a malformed selection envelope (caller error, fail-loud). */
export class EvidenceSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceSelectionError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolves the deterministic group key for one item from its
 * authoritative `sourcePages`. v1 items carry exactly the owning
 * page; anything else well-formed still maps deterministically.
 * Throws (never guesses) when the item cannot be grouped.
 */
function resolveGroupKey(item: unknown, index: number): { key: string; minPage: number } {
  if (!isPlainObject(item)) {
    throw new EvidenceSelectionError(`items[${index}] must be an object.`);
  }
  if (!Number.isSafeInteger(item.chunkIndex) || (item.chunkIndex as number) < 0) {
    throw new EvidenceSelectionError(`items[${index}].chunkIndex must be a non-negative integer.`);
  }
  if (!Array.isArray(item.sourcePages) || item.sourcePages.length === 0) {
    throw new EvidenceSelectionError(`items[${index}].sourcePages must be a non-empty array.`);
  }
  const pages = item.sourcePages as unknown[];
  for (const page of pages) {
    if (!Number.isSafeInteger(page) || (page as number) < 1) {
      throw new EvidenceSelectionError(
        `items[${index}].sourcePages must contain only positive integers.`,
      );
    }
  }
  const sorted = [...(pages as number[])].sort((a, b) => a - b);
  return { key: sorted.join(","), minPage: sorted[0] as number };
}

/**
 * Selects at most `maxItems` evidence items with deliberate
 * page/chunk spread. See the module doc comment for the algorithm.
 * Never mutates the input; returns a fresh frozen array of the
 * original item objects (identity preserved) in original input
 * order.
 */
export function selectCoverageBalancedEvidence(
  items: unknown,
  maxItems: unknown,
): readonly EvidenceItem[] {
  if (!Array.isArray(items)) {
    throw new EvidenceSelectionError("Selection items must be an array.");
  }
  if (!Number.isSafeInteger(maxItems) || (maxItems as number) < 1) {
    throw new EvidenceSelectionError("maxItems must be a positive integer.");
  }
  const budget = maxItems as number;
  const entries = items as EvidenceItem[];

  if (entries.length === 0) {
    return Object.freeze([]);
  }
  // Everything fits: a stable copy, no invention, no reordering.
  if (entries.length <= budget) {
    for (const [index] of entries.entries()) {
      resolveGroupKey(entries[index], index);
    }
    return Object.freeze([...entries]);
  }

  // Group input positions by deterministic page key, preserving
  // input order inside each group.
  const groups = new Map<string, { minPage: number; positions: number[] }>();
  entries.forEach((item, index) => {
    const { key, minPage } = resolveGroupKey(item, index);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { minPage, positions: [index] });
    } else {
      group.positions.push(index);
    }
  });
  const ordered = [...groups.values()].sort((a, b) =>
    a.minPage !== b.minPage
      ? a.minPage - b.minPage
      : // Same lowest page (e.g. "2" vs "2,3"): earliest-admitted
        // group first, keeping the admission-order spirit of the store.
        a.positions[0]! - b.positions[0]!,
  );

  // Largest-remainder quota: base share for every group, one extra
  // slot for the earliest groups while a remainder lasts.
  const base = Math.floor(budget / ordered.length);
  let remainder = budget % ordered.length;
  const taken = new Set<number>();
  const cursors = ordered.map(() => 0);
  ordered.forEach((group, rank) => {
    let quota = base + (remainder > 0 ? 1 : 0);
    if (remainder > 0) {
      remainder -= 1;
    }
    while (quota > 0 && cursors[rank]! < group.positions.length) {
      taken.add(group.positions[cursors[rank]!]!);
      cursors[rank]! += 1;
      quota -= 1;
    }
  });

  // Redistribute unused quota round-robin in group order until the
  // budget is met or every item is taken.
  while (taken.size < budget) {
    let progressed = false;
    for (const [rank, group] of ordered.entries()) {
      if (taken.size >= budget) {
        break;
      }
      if (cursors[rank]! < group.positions.length) {
        taken.add(group.positions[cursors[rank]!]!);
        cursors[rank]! += 1;
        progressed = true;
      }
    }
    if (!progressed) {
      break;
    }
  }

  // Stable output: original input order, original objects.
  return Object.freeze(entries.filter((_, index) => taken.has(index)));
}
