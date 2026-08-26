import { describe, expect, it } from "vitest";
import { getSettings } from "./rasterize";

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
