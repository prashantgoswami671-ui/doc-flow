// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import FixPageOrientationCard from "./FixPageOrientationCard";

/**
 * SEC-05 — Truthful third-party-CDN disclosure on Fix Page Orientation.
 *
 * services/pdf/orientation.ts's image-only OCR fallback calls
 * `tesseract.js`, which (confirmed by reading the installed
 * tesseract.js@7 source directly: src/worker-script/browser/getCore.js
 * and src/worker-script/index.js) defaults corePath, workerPath, and
 * langPath to cdn.jsdelivr.net when no override is passed — and
 * orientation.ts never overrides them. This test guards two things:
 * (1) that disclosure is present up front (not hidden behind analysis),
 * and (2) it stays honestly scoped — it must not claim the PDF content
 * itself is uploaded, nor claim zero third-party requests happen at all.
 */
describe("FixPageOrientationCard third-party CDN disclosure", () => {
  afterEach(() => {
    cleanup();
  });

  it("discloses the OCR fallback's third-party CDN use up front", () => {
    render(<FixPageOrientationCard />);

    expect(
      screen.getByText(/your pdf itself is never uploaded/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/third-party cdn \(jsdelivr\)/i),
    ).toBeInTheDocument();
  });

  it("does not claim zero third-party network requests", () => {
    render(<FixPageOrientationCard />);

    const bodyText = (document.body.textContent ?? "").toLowerCase();

    expect(bodyText).not.toMatch(/no third-party requests/);
    expect(bodyText).not.toMatch(/never leaves your (device|browser)/);
  });
});
