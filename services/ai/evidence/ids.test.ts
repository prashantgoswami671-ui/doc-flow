import { describe, expect, it } from "vitest";
import {
  EvidenceIdError,
  createEvidenceId,
  isValidEvidenceId,
  parseEvidenceId,
} from "./ids";

/**
 * V6-B02 — Unit tests for the deterministic evidence-ID primitive.
 *
 * Pure, dependency-free: no Ollama, no Browser AI, no network, no PDF
 * fixtures, no benchmark artifacts.
 */

describe("createEvidenceId", () => {
  it.each([
    [0, 0, "chunk-0-e0"],
    [0, 1, "chunk-0-e1"],
    [1, 0, "chunk-1-e0"],
    [4, 7, "chunk-4-e7"],
  ])("creates %s from chunkIndex=%i sequence=%i", (chunkIndex, sequence, expected) => {
    expect(createEvidenceId(chunkIndex, sequence)).toBe(expected);
  });

  it("is deterministic: repeated calls with the same inputs give identical output", () => {
    expect(createEvidenceId(2, 3)).toBe(createEvidenceId(2, 3));
  });

  it("scopes by chunk: different chunkIndex values give different IDs", () => {
    expect(createEvidenceId(0, 0)).not.toBe(createEvidenceId(1, 0));
  });

  it("scopes by sequence: different sequence values give different IDs", () => {
    expect(createEvidenceId(0, 0)).not.toBe(createEvidenceId(0, 1));
  });

  it("rejects a negative chunkIndex", () => {
    expect(() => createEvidenceId(-1, 0)).toThrow(EvidenceIdError);
  });

  it("rejects a negative sequence", () => {
    expect(() => createEvidenceId(0, -1)).toThrow(EvidenceIdError);
  });

  it("rejects a fractional chunkIndex", () => {
    expect(() => createEvidenceId(1.5, 0)).toThrow(EvidenceIdError);
  });

  it("rejects a fractional sequence", () => {
    expect(() => createEvidenceId(0, 2.5)).toThrow(EvidenceIdError);
  });

  it("rejects NaN inputs", () => {
    expect(() => createEvidenceId(NaN, 0)).toThrow(EvidenceIdError);
    expect(() => createEvidenceId(0, NaN)).toThrow(EvidenceIdError);
  });

  it("rejects Infinity and -Infinity inputs", () => {
    expect(() => createEvidenceId(Infinity, 0)).toThrow(EvidenceIdError);
    expect(() => createEvidenceId(0, Infinity)).toThrow(EvidenceIdError);
    expect(() => createEvidenceId(-Infinity, 0)).toThrow(EvidenceIdError);
    expect(() => createEvidenceId(0, -Infinity)).toThrow(EvidenceIdError);
  });

  it("does not coerce strings, null, undefined, or booleans", () => {
    expect(() => createEvidenceId("0", 0)).toThrow(EvidenceIdError);
    expect(() => createEvidenceId(0, "0")).toThrow(EvidenceIdError);
    expect(() => createEvidenceId(null, 0)).toThrow(EvidenceIdError);
    expect(() => createEvidenceId(0, undefined)).toThrow(EvidenceIdError);
    expect(() => createEvidenceId(true, 0)).toThrow(EvidenceIdError);
    expect(() => createEvidenceId(0, false)).toThrow(EvidenceIdError);
  });
});

describe("parseEvidenceId", () => {
  it.each([
    ["chunk-0-e0", 0, 0],
    ["chunk-0-e1", 0, 1],
    ["chunk-1-e0", 1, 0],
    ["chunk-4-e7", 4, 7],
  ])("parses %s into chunkIndex=%i sequence=%i", (id, chunkIndex, sequence) => {
    expect(parseEvidenceId(id)).toEqual({ chunkIndex, sequence });
  });

  it("round-trips with createEvidenceId", () => {
    const id = createEvidenceId(3, 5);
    const parsed = parseEvidenceId(id);
    expect(parsed.chunkIndex).toBe(3);
    expect(parsed.sequence).toBe(5);
    expect(createEvidenceId(parsed.chunkIndex, parsed.sequence)).toBe(id);
  });

  it.each(["", "chunk-0", "chunk-e0", "chunk-0-e", "chunk-x-ey", "CHUNK-0-E0", "chunk-0-e0-extra", " chunk-0-e0", "chunk-0-e0 ", "evidence-1", "0", "e5"])(
    "rejects malformed ID %s",
    (id) => {
      expect(() => parseEvidenceId(id)).toThrow(EvidenceIdError);
    },
  );

  it("rejects non-string inputs", () => {
    expect(() => parseEvidenceId(null)).toThrow(EvidenceIdError);
    expect(() => parseEvidenceId(undefined)).toThrow(EvidenceIdError);
    expect(() => parseEvidenceId(42)).toThrow(EvidenceIdError);
  });
});

describe("isValidEvidenceId", () => {
  it.each(["chunk-0-e0", "chunk-0-e1", "chunk-1-e0", "chunk-4-e7"])(
    "accepts valid ID %s",
    (id) => {
      expect(isValidEvidenceId(id)).toBe(true);
    },
  );

  it.each(["", "chunk-0", "chunk-e0", "chunk-0-e", "chunk-x-ey", "evidence-1", null, undefined, 42, true])(
    "rejects %s",
    (id) => {
      expect(isValidEvidenceId(id)).toBe(false);
    },
  );
});
