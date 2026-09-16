import { describe, expect, it } from "vitest";
import type { AiContextChunk } from "@/services/ai/types";
import {
  buildEvidenceLedger,
  EvidenceLedgerEntry,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_ENTRIES_PER_PAGE,
  DEFAULT_MAX_ENTRY_CHARACTERS,
  UNIT_MARKERS,
} from "./evidenceLedger";

function chunk(
  chunkIndex: number,
  pageNumber: number,
  text: string,
  startOffset: number = 0,
): AiContextChunk {
  return {
    chunkIndex,
    pageNumber,
    text,
    startOffset,
    endOffset: startOffset + text.length,
  };
}

function customChunk(
  chunkIndex: number,
  pageNumber: number,
  text: string,
  startOffset: number = 0,
): AiContextChunk {
  return {
    chunkIndex,
    pageNumber,
    text,
    startOffset,
    endOffset: startOffset + text.length,
  };
}

describe("buildEvidenceLedger", () => {
  it("returns empty array when no chunks have numeric tokens with unit markers", () => {
    const chunks = [
      chunk(0, 1, "This is just text without numbers."),
      chunk(1, 2, "Also no numbers here at all."),
    ];
    const ledger = buildEvidenceLedger(chunks);
    expect(ledger).toEqual([]);
  });

  it("selects numeric clusters that have a unit marker nearby", () => {
    const chunks = [
      chunk(0, 1, "The GDP was 12345 crore in 2023."),
      chunk(1, 2, "The literacy rate is 84.78%."),
    ];
    const ledger = buildEvidenceLedger(chunks);
    expect(ledger.length).toBeGreaterThan(0);
    // both clusters should qualify (crore, %)
    expect(ledger.every((e) => e.text.length > 0)).toBe(true);
  });

  it("ignores numeric tokens without nearby unit markers", () => {
    const chunks = [
      chunk(0, 1, "The year 2023 was good. Reference [1]."),
    ];
    const ledger = buildEvidenceLedger(chunks);
    // "2023" and "1" are bare numbers without unit markers
    expect(ledger).toEqual([]);
  });

  it("returns exact verbatim substrings of the original chunk text", () => {
    const chunks = [
      chunk(0, 1, "GSDP grew from 17.19 lakh crore to 20.32 lakh crore."),
    ];
    const ledger = buildEvidenceLedger(chunks);
    for (const entry of ledger) {
      expect(entry.text.length).toBe(entry.endOffset - entry.startOffset);
      const sourceText = chunks[0].text.slice(entry.startOffset, entry.endOffset);
      expect(entry.text).toBe(sourceText);
    }
  });

  it("produces entries with correct provenance fields", () => {
    const chunks = [
      customChunk(2, 3, "Literacy rate 84.78% in 2011.", 100),
    ];
    const ledger = buildEvidenceLedger(chunks);
    expect(ledger.length).toBeGreaterThan(0);
    for (const entry of ledger) {
      expect(entry.chunkIndex).toBe(2);
      expect(entry.pageNumber).toBe(3);
      expect(entry.startOffset).toBeGreaterThanOrEqual(100);
      expect(entry.endOffset).toBeLessThanOrEqual(100 + chunks[0].text.length);
    }
  });

  it("merges nearby numeric tokens into one cluster", () => {
    const chunks = [
      chunk(0, 1, "GSDP 17.19 lakh crore 18.80 lakh crore 20.32 lakh crore"),
    ];
    const ledger = buildEvidenceLedger(chunks);
    // All three numbers with "lakh crore" should merge into ONE span
    expect(ledger.length).toBe(1);
    expect(ledger[0].text).toContain("17.19");
    expect(ledger[0].text).toContain("18.80");
    expect(ledger[0].text).toContain("20.32");
  });

  it("left lookback captures preceding label/heading text", () => {
    const chunks = [
      chunk(0, 1, "GSDP (₹ lakh crore)\n2023 17.19\n2024 18.80\n2025 20.32"),
    ];
    const ledger = buildEvidenceLedger(chunks);
    expect(ledger.length).toBeGreaterThan(0);
    // The span should include the header "GSDP (₹ lakh crore)"
    expect(ledger[0].text).toContain("GSDP");
    expect(ledger[0].text).toContain("lakh crore");
  });

  it("right lookback includes trailing context up to sentence boundary", () => {
    const chunks = [
      chunk(0, 1, "The rate is 84.78%. This is a fact."),
    ];
    const ledger = buildEvidenceLedger(chunks);
    expect(ledger.length).toBeGreaterThan(0);
    // Should include up to the period
    expect(ledger[0].text).toContain("84.78%");
  });

  it("trims surrounding whitespace while preserving offset correctness", () => {
    const chunks = [
      chunk(0, 1, "  The value is 12.5% here. "),
    ];
    const ledger = buildEvidenceLedger(chunks);
    expect(ledger.length).toBeGreaterThan(0);
    const entry = ledger[0];
    expect(entry.text.startsWith(" ")).toBe(false);
    expect(entry.text.endsWith(" ")).toBe(false);
    expect(entry.text.length).toBe(entry.endOffset - entry.startOffset);
  });

  it("respects maxEntriesPerPage cap", () => {
    const text = "A 1% B 2% C 3% D 4% E 5% F 6%";
    const chunks = [chunk(0, 1, text)];
    const ledger = buildEvidenceLedger(chunks, { maxEntriesPerPage: 3 });
    expect(ledger.length).toBeLessThanOrEqual(3);
  });

  it("respects global maxEntries cap", () => {
    const text = Array.from({ length: 15 }, (_, i) => ` ${i + 1}%`).join("");
    const chunks = [chunk(0, 1, text)];
    const ledger = buildEvidenceLedger(chunks, { maxEntries: 5, maxEntriesPerPage: 10 });
    expect(ledger.length).toBeLessThanOrEqual(5);
  });

  it("orders entries by page then absolute offset", () => {
    const chunks = [
      chunk(1, 2, "Page two: 10%"),
      chunk(0, 1, "Page one: 5%"),
    ];
    const ledger = buildEvidenceLedger(chunks);
    expect(ledger[0].pageNumber).toBe(1);
    expect(ledger[1].pageNumber).toBe(2);
  });

  it("breaks ties by earliest offset within same page", () => {
    const chunks = [
      chunk(0, 1, "First 5% appears in this sentence. Much later in the document, Second 6% appears."),
    ];
    const ledger = buildEvidenceLedger(chunks, { maxEntriesPerPage: 2 });
    expect(ledger.length).toBe(2);
    expect(ledger[0].startOffset).toBeLessThan(ledger[1].startOffset);
  });

  it("does not exceed maxEntryCharacters per entry", () => {
    const longLabel = "X".repeat(200) + " 50%";
    const chunks = [chunk(0, 1, longLabel)];
    const ledger = buildEvidenceLedger(chunks);
    for (const entry of ledger) {
      expect(entry.text.length).toBeLessThanOrEqual(DEFAULT_MAX_ENTRY_CHARACTERS);
    }
  });

  it("returns empty when only unqualified numbers exist (bare years, refs)", () => {
    const chunks = [
      chunk(0, 1, "See 2023 report. Reference [1]. Year 2024."),
    ];
    const ledger = buildEvidenceLedger(chunks);
    expect(ledger).toEqual([]);
  });

  it("UNIT_MARKERS list is non-empty and used for qualification", () => {
    expect(UNIT_MARKERS.length).toBeGreaterThan(0);
    expect(UNIT_MARKERS).toContain("%");
    expect(UNIT_MARKERS).toContain("lakh");
    expect(UNIT_MARKERS).toContain("crore");
  });

  it("per-entry bounds do not exceed page text", () => {
    const chunks = [
      customChunk(0, 1, "Rate is 12.5% end.", 50),
    ];
    const ledger = buildEvidenceLedger(chunks);
    for (const entry of ledger) {
      expect(entry.startOffset).toBeGreaterThanOrEqual(50);
      expect(entry.endOffset).toBeLessThanOrEqual(50 + chunks[0].text.length);
    }
  });

  it("defaults are positive integers", () => {
    expect(DEFAULT_MAX_ENTRIES).toBeGreaterThan(0);
    expect(DEFAULT_MAX_ENTRIES_PER_PAGE).toBeGreaterThan(0);
    expect(DEFAULT_MAX_ENTRY_CHARACTERS).toBeGreaterThan(0);
  });
});