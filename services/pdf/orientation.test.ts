import { describe, expect, it } from "vitest";
import {
  getRasterEvidence,
  resolveOcrOrientation,
  type OCROrientationEvidence,
} from "./orientation";

/**
 * Regression tests for the page-9 "inconclusive OCR silently becomes Normal"
 * bug.
 *
 * These target the deterministic decision logic directly (no live
 * Tesseract/canvas/browser needed):
 *
 *  - `resolveOcrOrientation` is the pure function that turns raw OCR
 *    evidence (or its absence) into a page-orientation decision. This is
 *    exactly the logic that used to fall through to "normal" whenever OCR
 *    couldn't confidently pick an orientation.
 *  - `getRasterEvidence` is the unrelated aspect-ratio-based 90/270
 *    detector, included here only to confirm it is unchanged by this fix.
 */

function makeOcrEvidence(
  overrides: Partial<OCROrientationEvidence>,
): OCROrientationEvidence {
  return {
    bestOrientation: 0,
    confidence: 0,
    margin: 0,
    scores: { 0: 0, 90: 0, 180: 0, 270: 0 },
    // Ample recognized-word counts by default so tests that aren't about
    // the word-count gate itself aren't accidentally affected by it -- only
    // the tests below that explicitly override wordCounts exercise that
    // path.
    wordCounts: { 0: 10, 90: 10, 180: 10, 270: 10 },
    ...overrides,
  };
}

describe("resolveOcrOrientation", () => {
  it("returns needs-review for tied/near-tied OCR scores (the page 9 case)", () => {
    // Reproduces the reported page 9 scores: 90/180/270 all ~0.95, no
    // reliable separation between them.
    const evidence = makeOcrEvidence({
      bestOrientation: 180,
      confidence: 0.95,
      margin: 0.0, // best and second-best are effectively tied
      scores: { 0: 0.1, 90: 0.95, 180: 0.95, 270: 0.95 },
    });

    const decision = resolveOcrOrientation(evidence);

    expect(decision.kind).toBe("needs-review");
  });

  it("returns needs-review when confidence clears the bar but margin does not", () => {
    const evidence = makeOcrEvidence({
      bestOrientation: 180,
      confidence: 0.9,
      margin: 0.05, // below the 0.15 margin requirement
      scores: { 0: 0.1, 90: 0.2, 180: 0.9, 270: 0.85 },
    });

    expect(resolveOcrOrientation(evidence).kind).toBe("needs-review");
  });

  it("returns a rotated decision for confidently-detected 180°", () => {
    const evidence = makeOcrEvidence({
      bestOrientation: 180,
      confidence: 0.93,
      margin: 0.4,
      scores: { 0: 0.1, 90: 0.05, 180: 0.93, 270: 0.08 },
    });

    const decision = resolveOcrOrientation(evidence);

    expect(decision).toEqual({
      kind: "rotated",
      orientation: 180,
      confidence: 0.93,
    });
  });

  it("returns a normal decision for a confident 0° result", () => {
    const evidence = makeOcrEvidence({
      bestOrientation: 0,
      confidence: 0.92,
      margin: 0.5,
      scores: { 0: 0.92, 90: 0.1, 180: 0.05, 270: 0.08 },
    });

    const decision = resolveOcrOrientation(evidence);

    expect(decision).toEqual({ kind: "normal", confidence: 0.92 });
  });

  it("returns needs-review, not normal, when OCR fails outright", () => {
    // detectOrientationViaOCR returns/throws null-equivalent when OCR could
    // not run at all (e.g. non-browser context, decode failure, worker
    // crash). This must never be interpreted as "the page is normal".
    const decision = resolveOcrOrientation(null);

    expect(decision.kind).toBe("needs-review");
  });

  it("returns needs-review for a fake high-confidence winner with no recognized text", () => {
    // 180 scores highest by a wide margin -- by confidence alone it would
    // win outright. But its word count is zero: Tesseract found a
    // "readable" region and recognized no actual text in it. That is not a
    // trustworthy signal, so 180 must be excluded as a candidate. What's
    // left (0/90/270) has no reliable separation either, so the result must
    // be needs-review, not normal or rotated.
    const evidence = makeOcrEvidence({
      scores: { 0: 0.1, 90: 0.05, 180: 0.95, 270: 0.08 },
      wordCounts: { 0: 5, 90: 5, 180: 0, 270: 5 },
    });

    const decision = resolveOcrOrientation(evidence);

    expect(decision.kind).toBe("needs-review");
  });

  it("still returns a confident rotated decision when the winner has real recognized text", () => {
    // Same score shape as the confidently-detected-180 test above, but now
    // explicit about word counts: the winning orientation has plenty of
    // genuinely recognized words, so the word-count gate should have no
    // effect on this outcome -- existing confident-winner behavior is
    // unchanged.
    const evidence = makeOcrEvidence({
      scores: { 0: 0.1, 90: 0.05, 180: 0.93, 270: 0.08 },
      wordCounts: { 0: 4, 90: 3, 180: 20, 270: 4 },
    });

    const decision = resolveOcrOrientation(evidence);

    expect(decision).toEqual({
      kind: "rotated",
      orientation: 180,
      confidence: 0.93,
    });
  });

  it("returns needs-review when every orientation has effectively no recognized text", () => {
    // All four orientations fall below the minimum recognized-word floor,
    // regardless of how their confidence scores compare to each other --
    // there is no orientation with enough real OCR content to trust.
    const evidence = makeOcrEvidence({
      scores: { 0: 0.4, 90: 0.9, 180: 0.3, 270: 0.6 },
      wordCounts: { 0: 0, 90: 1, 180: 2, 270: 0 },
    });

    const decision = resolveOcrOrientation(evidence);

    expect(decision.kind).toBe("needs-review");
  });
});

describe("getRasterEvidence (90°/270° aspect-ratio detection, unchanged)", () => {
  const PAINT_IMAGE = 1;
  const imagePaintOperators = new Set<number>([PAINT_IMAGE]);

  it("flags a tall image as portrait", () => {
    const operatorList = {
      fnArray: [PAINT_IMAGE],
      argsArray: [["img", 800, 1200]],
    };

    expect(getRasterEvidence(operatorList, imagePaintOperators)).toEqual({
      orientation: "portrait",
    });
  });

  it("flags a wide image as landscape", () => {
    const operatorList = {
      fnArray: [PAINT_IMAGE],
      argsArray: [["img", 1200, 800]],
    };

    expect(getRasterEvidence(operatorList, imagePaintOperators)).toEqual({
      orientation: "landscape",
    });
  });

  it("returns null when the aspect ratio is too close to square to be conclusive", () => {
    const operatorList = {
      fnArray: [PAINT_IMAGE],
      argsArray: [["img", 1000, 950]], // ratio ~1.05, below the 1.15 threshold
    };

    expect(getRasterEvidence(operatorList, imagePaintOperators)).toBeNull();
  });

  it("ignores non-image operators", () => {
    const operatorList = {
      fnArray: [999],
      argsArray: [["img", 800, 1200]],
    };

    expect(getRasterEvidence(operatorList, imagePaintOperators)).toBeNull();
  });
});
