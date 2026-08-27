import { describe, expect, it } from "vitest";
import { getSettings, normalizeRotationDegrees } from "./rasterize";

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
