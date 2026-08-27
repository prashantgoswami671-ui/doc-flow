import { describe, expect, it } from "vitest";
import {
  computeSafeRenderScale,
  getSettings,
  MAX_CANVAS_DIMENSION,
  normalizeRotationDegrees,
} from "./rasterize";

/*
 * Phase 3.2 — Light compression setting regression coverage.
 *
 * This only asserts on the concrete scale/quality numbers returned by
 * getSettings(). It intentionally does NOT attempt to exercise the actual
 * canvas/PDF.js rendering + JPEG encoding path (rasterizePDFWithSettings) —
 * that requires a real browser DOM/canvas, which this project's plain-Node
 * vitest environment does not provide.
 *
 * The real-world size/quality effect of these settings must be verified
 * manually in a browser using the Phase 3.2 Light-settings report.
 */
describe("getSettings", () => {
  it("light: uses the validated compression settings", () => {
    const settings = getSettings("light");

    expect(settings.scale).toBe(2.2);
    expect(settings.quality).toBe(0.92);
  });

  it("heavy: unchanged by the Light-settings change", () => {
    const settings = getSettings("heavy");

    expect(settings.scale).toBe(1.0);
    expect(settings.quality).toBe(0.55);
  });

  it("light stays visibly higher-quality than heavy", () => {
    const light = getSettings("light");
    const heavy = getSettings("heavy");

    expect(light.quality).toBeGreaterThan(heavy.quality);
  });
});

/*
 * Phase 3.4 — Rasterizer rotation-metadata preservation.
 *
 * normalizeRotationDegrees() is the pure piece of the Phase 3.4 fix: it
 * turns a PDF.js page's `rotate` value into the 0-359 range used both to
 * pick the render/output viewport rotation and to call
 * outputPage.setRotation(). Unlike the surrounding rasterization (which
 * needs a real browser canvas/DOM — see the file header above), this is
 * plain arithmetic and can be verified directly here.
 */
describe("normalizeRotationDegrees", () => {
  it("passes the four standard page rotations through unchanged", () => {
    expect(normalizeRotationDegrees(0)).toBe(0);
    expect(normalizeRotationDegrees(90)).toBe(90);
    expect(normalizeRotationDegrees(180)).toBe(180);
    expect(normalizeRotationDegrees(270)).toBe(270);
  });

  it("normalizes negative rotations into the 0-359 range", () => {
    expect(normalizeRotationDegrees(-90)).toBe(270);
    expect(normalizeRotationDegrees(-180)).toBe(180);
    expect(normalizeRotationDegrees(-270)).toBe(90);
  });

  it("normalizes rotations at or beyond a full turn", () => {
    expect(normalizeRotationDegrees(360)).toBe(0);
    expect(normalizeRotationDegrees(450)).toBe(90);
  });
});

/*
 * Phase 3.5 — Rasterizer robustness / edge-case hardening.
 *
 * computeSafeRenderScale() is the pure piece of the Phase 3.5 canvas-size
 * guard (PHASE_3_3_INSPECTION_REPORT.md, Risk 3: "Canvas Memory/Size
 * Limits"): it decides what render scale to actually use so a page's
 * rasterized pixel dimensions never exceed a safe canvas ceiling. Like
 * normalizeRotationDegrees above, this is plain arithmetic and doesn't
 * need a real browser canvas/DOM to verify.
 */
describe("computeSafeRenderScale", () => {
  it("returns the requested scale unchanged for normal pages (Letter at Light scale)", () => {
    expect(computeSafeRenderScale(612, 792, 2.2)).toBe(2.2);
  });

  it("returns the requested scale unchanged for the existing 2000x3000pt large-page fixture at Light scale", () => {
    // 2000 * 2.2 = 4400, 3000 * 2.2 = 6600 — both well under the default
    // ceiling, so this existing fixture's rendered resolution must not
    // change as a result of the Phase 3.5 guard.
    expect(computeSafeRenderScale(2000, 3000, 2.2)).toBe(2.2);
  });

  it("returns the requested scale unchanged exactly at the boundary", () => {
    // longestSide === maxDimension should not be treated as "over".
    expect(computeSafeRenderScale(100, 50, 1, 100)).toBe(1);
  });

  it("clamps scale down when the requested render would exceed the max dimension", () => {
    const safeScale = computeSafeRenderScale(20000, 10000, 2.2, MAX_CANVAS_DIMENSION);

    expect(safeScale).toBeLessThan(2.2);

    const renderedWidth = 20000 * safeScale;
    const renderedHeight = 10000 * safeScale;

    expect(Math.max(renderedWidth, renderedHeight)).toBeCloseTo(
      MAX_CANVAS_DIMENSION,
      6,
    );
    // Aspect ratio (2:1) must be preserved by the clamp.
    expect(renderedWidth / renderedHeight).toBeCloseTo(2, 6);
  });

  it("clamps an extreme-aspect-ratio page (very wide, short) without distorting it", () => {
    const pageWidth = 50000;
    const pageHeight = 50;
    const safeScale = computeSafeRenderScale(pageWidth, pageHeight, 2.2);

    const renderedWidth = pageWidth * safeScale;
    const renderedHeight = pageHeight * safeScale;

    expect(renderedWidth).toBeCloseTo(MAX_CANVAS_DIMENSION, 6);
    expect(renderedHeight).toBeCloseTo(
      (pageHeight / pageWidth) * MAX_CANVAS_DIMENSION,
      6,
    );
  });

  it("does not divide by zero or return non-finite scale for a zero-size page", () => {
    expect(computeSafeRenderScale(0, 0, 2.2)).toBe(2.2);
  });

  it("respects a custom maxDimension override", () => {
    expect(computeSafeRenderScale(1000, 1000, 1, 500)).toBeCloseTo(0.5, 6);
  });
});
