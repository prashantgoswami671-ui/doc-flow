/**
 * Stage A — Deterministic Evidence Ledger (PROTOTYPE ONLY).
 *
 * Principle: DETERMINISTIC SOURCE PRESERVATION -> MODEL SYNTHESIS.
 *
 * This module selects bounded, verbatim excerpts of original document
 * text around numeric content, with provenance (page, chunk, offsets).
 * It deliberately does NOT interpret what any number means — no semantic
 * parsing, no table reconstruction, no "this figure belongs to that
 * entity" claims. A number qualifies for preservation purely because a
 * lexical unit/measure marker (%, ₹, "percent", "lakh", "per", "rate",
 * ...) appears nearby — a dumb, deterministic proxy for "this number is
 * a measurement", nothing more. Interpretation remains entirely with the
 * model at Reduce time; this layer only guarantees that exact source
 * spans — including the label/header text adjacent to the numbers —
 * reach Reduce unmodified.
 *
 * Why left-lookback: AI-02 extraction flattens PDF text items into a
 * single line per page, which separates table headers from their rows.
 * Expanding each numeric cluster LEFTWARD (to the nearest sentence/
 * bullet boundary, within a bound) is the deterministic fix for the
 * "headerless table fragment" failure of the earlier single-excerpt
 * selector: the label text survives flattening as ordinary adjacent
 * characters, so pulling it into the span restores attribution without
 * understanding the table.
 *
 * Pure, synchronous, dependency-free. No Worker, no model, no PDF.js, no
 * network, no DOM. Deterministic: the same chunk list always yields the
 * same ledger, independent of input array order.
 */

import type { AiContextChunk } from "@/services/ai/types";

/**
 * One preserved verbatim source span. `startOffset`/`endOffset` are
 * ABSOLUTE offsets within the page's extracted text (the chunk's own
 * offsets plus the span's local position), so `(pageNumber, startOffset)`
 * uniquely locates the span in the document. `text` is always an exact
 * substring of the source chunk text — never normalized, paraphrased, or
 * re-punctuated (only surrounding whitespace is trimmed, with offsets
 * adjusted so `text.length === endOffset - startOffset` always holds).
 */
export interface EvidenceLedgerEntry {
  pageNumber: number;
  chunkIndex: number;
  startOffset: number;
  endOffset: number;
  text: string;
}

export interface EvidenceLedgerOptions {
  /** Global cap on emitted entries (default 12). */
  maxEntries?: number;
  /** Cap on entries per page (default 3) — guarantees spread across pages. */
  maxEntriesPerPage?: number;
  /** Hard per-entry character bound (default 240). */
  maxEntryCharacters?: number;
  /** A numeric token qualifies only if a unit marker occurs within this many characters (default 32). */
  unitContextCharacters?: number;
  /** Numeric tokens closer together than this merge into one cluster/span (default 32). */
  clusterMergeCharacters?: number;
  /** How far left of a cluster to reach for label/heading text (default 110). */
  leftLookbackCharacters?: number;
  /** How far right of a cluster to include trailing context (default 40). */
  rightLookbackCharacters?: number;
}

export const DEFAULT_MAX_ENTRIES = 12;
export const DEFAULT_MAX_ENTRIES_PER_PAGE = 3;
export const DEFAULT_MAX_ENTRY_CHARACTERS = 240;
export const DEFAULT_UNIT_CONTEXT_CHARACTERS = 32;
export const DEFAULT_CLUSTER_MERGE_CHARACTERS = 32;
export const DEFAULT_LEFT_LOOKBACK_CHARACTERS = 110;
export const DEFAULT_RIGHT_LOOKBACK_CHARACTERS = 40;

/**
 * Lexical unit/measure markers — a deliberately dumb heuristic list. Its
 * only job is to distinguish measurement-like numbers ("17.19" next to
 * "₹ lakh crore", "84.78" next to "%" / "Rate") from incidental digits
 * (list indexes, bare years in a references section). Presence in this
 * list asserts NOTHING about a number's meaning.
 */
export const UNIT_MARKERS: readonly string[] = [
  "%",
  "₹",
  "$",
  "£",
  "€",
  "percent",
  "per cent",
  "per ",
  "lakh",
  "crore",
  "million",
  "billion",
  "trillion",
  "thousand",
  "births",
  "deaths",
  "points",
  "index",
  "rate",
  "ratio",
  "usd",
  "inr",
];

const SENTENCE_BOUNDARY = /[.?!;•]\s/;

function isWhitespace(char: string | undefined): boolean {
  return char !== undefined && /\s/.test(char);
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
}

/** Index just past the rightmost sentence/bullet boundary in text[from..to), or -1. */
function findSentenceStartAfter(text: string, from: number, to: number): number {
  const window = text.slice(from, to);
  let last = -1;
  const re = /[.?!;•]\s/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(window)) !== null) {
    last = from + match.index;
  }
  return last === -1 ? -1 : last + 2; // skip the terminator + following whitespace
}

/** Index of the first sentence/bullet boundary in text[from..to), or -1. */
function findSentenceEndBefore(text: string, from: number, to: number): number {
  const window = text.slice(from, to);
  const match = /[.?!;•]\s/.exec(window);
  return match === null ? -1 : from + match.index;
}

/** Advance `pos` forward to the start of a word (past any partial word). */
function snapForwardToWordStart(text: string, pos: number, limit: number): number {
  let snapped = pos;
  while (snapped < limit && !isWhitespace(text[snapped - 1]) && snapped > 0) {
    if (isWhitespace(text[snapped])) break;
    snapped += 1;
  }
  return snapped;
}

/** Retreat `pos` backward to the end of a word (before any partial word). */
function snapBackwardToWordEnd(text: string, pos: number, limit: number): number {
  let snapped = pos;
  while (snapped > limit && !isWhitespace(text[snapped - 1])) {
    snapped -= 1;
  }
  return snapped;
}

interface NumericCluster {
  /** Local (within-chunk) start of the first numeric token. */
  start: number;
  /** Local (within-chunk) end of the last numeric token. */
  end: number;
  /** Numeric tokens in this cluster. */
  numericCount: number;
  /** True when at least one token has a unit marker within the context window. */
  qualified: boolean;
}

/** True when a unit marker occurs within `context` chars of the token [start, end). */
function hasUnitContext(text: string, start: number, end: number, context: number): boolean {
  const from = Math.max(0, start - context);
  const to = Math.min(text.length, end + context);
  const window = text.slice(from, to).toLowerCase();
  return UNIT_MARKERS.some((marker) => window.includes(marker));
}

/**
 * Builds the deterministic evidence ledger from the ORIGINAL AI-02 chunks
 * (not the Map batches, not the intermediate summaries). Returns entries
 * sorted by (pageNumber, startOffset) and capped by page/global budgets,
 * choosing the numeric-densest clusters per page (ties -> earliest
 * offset). Returns an empty array when the document contains no
 * qualifying numeric evidence — callers fall back to the exact
 * no-evidence prompt in that case.
 */
export function buildEvidenceLedger(
  chunks: AiContextChunk[],
  options: EvidenceLedgerOptions = {},
): EvidenceLedgerEntry[] {
  const {
    maxEntries = DEFAULT_MAX_ENTRIES,
    maxEntriesPerPage = DEFAULT_MAX_ENTRIES_PER_PAGE,
    maxEntryCharacters = DEFAULT_MAX_ENTRY_CHARACTERS,
    unitContextCharacters = DEFAULT_UNIT_CONTEXT_CHARACTERS,
    clusterMergeCharacters = DEFAULT_CLUSTER_MERGE_CHARACTERS,
    leftLookbackCharacters = DEFAULT_LEFT_LOOKBACK_CHARACTERS,
    rightLookbackCharacters = DEFAULT_RIGHT_LOOKBACK_CHARACTERS,
  } = options;

  assertPositiveInteger(maxEntries, "maxEntries");
  assertPositiveInteger(maxEntriesPerPage, "maxEntriesPerPage");
  assertPositiveInteger(maxEntryCharacters, "maxEntryCharacters");
  assertPositiveInteger(unitContextCharacters, "unitContextCharacters");
  assertPositiveInteger(clusterMergeCharacters, "clusterMergeCharacters");
  assertPositiveInteger(leftLookbackCharacters, "leftLookbackCharacters");
  assertPositiveInteger(rightLookbackCharacters, "rightLookbackCharacters");

  interface Span extends NumericCluster {
    chunk: AiContextChunk;
    /** Span bounds after lookback expansion (local to the chunk). */
    spanStart: number;
    spanEnd: number;
  }

  const spans: Span[] = [];

  for (const chunk of chunks) {
    const text = chunk.text;
    if (!text) continue;

    // 1. Find all numeric tokens.
    const numericPattern = /\d[\d,]*(?:\.\d+)?/g;
    const tokens: Array<{ start: number; end: number }> = [];
    let match: RegExpExecArray | null;
    while ((match = numericPattern.exec(text)) !== null) {
      tokens.push({ start: match.index, end: match.index + match[0].length });
    }
    if (tokens.length === 0) continue;

    // 2. Merge tokens into clusters by proximity (non-numeric tokens in
    //    the gap are absorbed — table rows contain year/label noise
    //    between the measurement columns).
    const clusters: NumericCluster[] = [];
    let current: NumericCluster | null = null;
    for (const token of tokens) {
      if (current !== null && token.start - current.end <= clusterMergeCharacters) {
        current.end = token.end;
        current.numericCount += 1;
        current.qualified = current.qualified || hasUnitContext(text, token.start, token.end, unitContextCharacters);
      } else {
        if (current !== null) clusters.push(current);
        current = {
          start: token.start,
          end: token.end,
          numericCount: 1,
          qualified: hasUnitContext(text, token.start, token.end, unitContextCharacters),
        };
      }
    }
    if (current !== null) clusters.push(current);

    // 3. Expand each QUALIFIED cluster into a bounded verbatim span.
    for (const cluster of clusters) {
      if (!cluster.qualified) continue;

      // Left: prefer the nearest sentence/bullet boundary within the
      // lookback (captures preceding headings/labels/row headers);
      // otherwise word-snap at the full lookback distance.
      let spanStart: number;
      const sentenceStart = findSentenceStartAfter(
        text,
        Math.max(0, cluster.start - leftLookbackCharacters),
        cluster.start,
      );
      if (sentenceStart !== -1 && sentenceStart <= cluster.start) {
        spanStart = sentenceStart;
      } else {
        spanStart = Math.max(0, cluster.start - leftLookbackCharacters);
        spanStart = snapForwardToWordStart(text, spanStart, cluster.start);
      }

      // Right: prefer the first sentence boundary within the lookahead;
      // otherwise word-snap at the full lookahead distance.
      let spanEnd: number;
      const sentenceEnd = findSentenceEndBefore(
        text,
        cluster.end,
        Math.min(text.length, cluster.end + rightLookbackCharacters),
      );
      if (sentenceEnd !== -1 && sentenceEnd >= cluster.end) {
        spanEnd = sentenceEnd;
      } else {
        spanEnd = Math.min(text.length, cluster.end + rightLookbackCharacters);
        spanEnd = snapBackwardToWordEnd(text, spanEnd, cluster.end);
      }

      // Hard per-entry bound: retreat to a word end, never past the cluster.
      if (spanEnd - spanStart > maxEntryCharacters) {
        spanEnd = snapBackwardToWordEnd(text, spanStart + maxEntryCharacters, cluster.end);
      }

      if (spanEnd > spanStart) {
        spans.push({ ...cluster, chunk, spanStart, spanEnd });
      }
    }
  }

  if (spans.length === 0) return [];

  // 4. Per-page cap: keep the numeric-densest spans (ties -> earliest).
  const byPage = new Map<number, Span[]>();
  for (const span of spans) {
    const page = span.chunk.pageNumber;
    const list = byPage.get(page);
    if (list) {
      list.push(span);
    } else {
      byPage.set(page, [span]);
    }
  }
  const kept: Span[] = [];
  for (const list of byPage.values()) {
    list.sort((a, b) => b.numericCount - a.numericCount || a.spanStart - b.spanStart);
    kept.push(...list.slice(0, maxEntriesPerPage));
  }

  // 5. Global order + cap.
  kept.sort(
    (a, b) =>
      a.chunk.pageNumber - b.chunk.pageNumber ||
      a.chunk.startOffset + a.spanStart - (b.chunk.startOffset + b.spanStart),
  );

  return kept.slice(0, maxEntries).map((span) => {
    // Trim surrounding whitespace while keeping text/offsets consistent.
    let localStart = span.spanStart;
    let localEnd = span.spanEnd;
    const raw = span.chunk.text.slice(localStart, localEnd);
    const lead = raw.length - raw.trimStart().length;
    const trail = raw.length - raw.trimEnd().length;
    localStart += lead;
    localEnd -= trail;
    return {
      pageNumber: span.chunk.pageNumber,
      chunkIndex: span.chunk.chunkIndex,
      startOffset: span.chunk.startOffset + localStart,
      endOffset: span.chunk.startOffset + localEnd,
      text: span.chunk.text.slice(localStart, localEnd),
    };
  });
}
