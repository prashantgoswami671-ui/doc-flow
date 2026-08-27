"use client";

import { useEffect, useState } from "react";
import { compressPDF } from "@/services/pdf/compress";
import { rasterizePDF } from "@/services/pdf/rasterize";
import {
  buildExtremeAspectRatioPdfBytes,
  buildImageHeavyPdfBytes,
  buildMixedOrientationPdfBytes,
  buildScannedImageOnlyPdfBytes,
  buildTextVectorPdfBytes,
  buildUnusualPageSizePdfBytes,
  toFile,
} from "@/services/pdf/__fixtures__/pdf";
import { PDFDocument } from "pdf-lib";

/*
 * Phase 3.3 — Real Rasterizer Integration Test Harness
 *
 * Exercises the ACTUAL production compression/rasterization code
 * (services/pdf/compress.ts, services/pdf/rasterize.ts) in a real browser,
 * with no mocks. This page is driven by tests/e2e/compression.integration.spec.ts.
 *
 * IMPORTANT DESIGN NOTE (why some tests call rasterizePDF() directly
 * instead of going through compressPDF()):
 *
 * compressPDF() silently falls back to the ORIGINAL bytes whenever the
 * rasterized output isn't smaller than the source (see compress.ts). For
 * text/vector-only fixtures (buildUnusualPageSizePdfBytes,
 * buildMixedOrientationPdfBytes have little/no image content), that
 * fallback is very likely to trigger under Light settings — which would
 * make a dimensions/rotation test trivially "pass" by returning the
 * source bytes completely untouched, without the real rasterizer ever
 * having been exercised. That is a false positive, not a baseline
 * finding. So:
 *
 *   - Test A (roundtrip) and Tests D/E/F/G (compression behavior) call
 *     compressPDF(), because they're specifically testing the full
 *     pipeline including fallback logic.
 *   - Tests B and C (dimension/rotation baselines) call rasterizePDF()
 *     directly, bypassing compress.ts entirely, so the assertions are
 *     guaranteed to reflect the real rasterizer's behavior.
 */

interface TestResult {
  success: boolean;
  [key: string]: unknown;
}

declare global {
  interface Window {
    runCompressionTest?: (testName: string) => Promise<TestResult>;
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export default function CompressionTestPage() {
  const [status, setStatus] = useState("idle");
  const [results, setResults] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ---------------------------------------------------------------------
  // TEST A — Real rasterizer roundtrip
  // ---------------------------------------------------------------------
  async function runTestA(): Promise<TestResult> {
    const sourceBytes = await buildScannedImageOnlyPdfBytes(2);
    const file = toFile(sourceBytes, "scanned-fixture.pdf");

    const sourcePdf = await PDFDocument.load(sourceBytes);
    const sourcePageCount = sourcePdf.getPageCount();
    const sourceDims = sourcePdf.getPages().map((p) => p.getSize());

    // Direct production-rasterizer call — real PDF.js + canvas + JPEG +
    // pdf-lib reconstruction, no compress.ts fallback wrapper involved.
    const outputBytes = await rasterizePDF(file, "light");
    const outputPdf = await PDFDocument.load(outputBytes); // throws if malformed
    const outputPageCount = outputPdf.getPageCount();
    const outputDims = outputPdf.getPages().map((p) => p.getSize());

    const dimensionsPreserved = sourceDims.every((d, i) => {
      const out = outputDims[i];
      return Math.abs(d.width - out.width) < 1 && Math.abs(d.height - out.height) < 1;
    });

    return {
      success: true,
      notEmpty: outputBytes.length > 0,
      loadableByPdfLib: true,
      pageCountPreserved: outputPageCount === sourcePageCount,
      dimensionsPreserved,
      smallerThanOriginal: outputBytes.length < sourceBytes.length,
      pageCount: sourcePageCount,
      outputPageCount,
      originalSize: sourceBytes.length,
      processedSize: outputBytes.length,
    };
  }

  // ---------------------------------------------------------------------
  // TEST B — Physical dimension preservation (unrotated pages only)
  // ---------------------------------------------------------------------
  async function runTestB(): Promise<TestResult> {
    const sourceBytes = await buildUnusualPageSizePdfBytes(); // 1x1in, Letter, 2000x3000pt
    const file = toFile(sourceBytes, "unusual-sizes-fixture.pdf");

    const sourcePdf = await PDFDocument.load(sourceBytes);
    const sourcePages = sourcePdf.getPages();
    const sourceDims = sourcePages.map((p) => ({
      size: p.getSize(),
      rotation: p.getRotation().angle,
    }));

    // Direct rasterizer call (see file header) — none of these fixture
    // pages carry rotation, so raw media-box size is also the visual
    // bounding box; a direct width/height comparison is valid here.
    const outputBytes = await rasterizePDF(file, "light");
    const outputPdf = await PDFDocument.load(outputBytes);
    const outputDims = outputPdf.getPages().map((p) => p.getSize());

    const perPage = sourceDims.map((s, i) => {
      const out = outputDims[i];
      const widthMatch = Math.abs(s.size.width - out.width) < 1;
      const heightMatch = Math.abs(s.size.height - out.height) < 1;
      return {
        sourceWidth: s.size.width,
        sourceHeight: s.size.height,
        outputWidth: out.width,
        outputHeight: out.height,
        widthMatch,
        heightMatch,
      };
    });

    return {
      success: true,
      dimensionsPreserved: perPage.every((p) => p.widthMatch && p.heightMatch),
      pageCount: sourcePages.length,
      perPage,
    };
  }

  // ---------------------------------------------------------------------
  // TEST C — Rotation baseline (the key Phase 3.3 defect-exposure test)
  // ---------------------------------------------------------------------
  async function runTestC(): Promise<TestResult> {
    const sourceBytes = await buildMixedOrientationPdfBytes(); // 0, 0(landscape), 90, 180, 270
    const file = toFile(sourceBytes, "mixed-orientation-fixture.pdf");

    const sourcePdf = await PDFDocument.load(sourceBytes);
    const sourcePages = sourcePdf.getPages();
    const sourceInfo = sourcePages.map((p) => {
      const rotation = p.getRotation().angle;
      const mediaBox = p.getSize(); // raw, UNROTATED media-box dims
      const swapped = rotation === 90 || rotation === 270;
      const visualBoundingBox = swapped
        ? { width: mediaBox.height, height: mediaBox.width }
        : { width: mediaBox.width, height: mediaBox.height };
      return { rotation, mediaBox, visualBoundingBox };
    });

    // Direct rasterizer call — see file header for why this must NOT go
    // through compressPDF(): this fixture is text-only, so compressPDF's
    // "light" mode would very likely fall back to the original bytes and
    // trivially (and falsely) report rotation/dimensions as "preserved".
    const outputBytes = await rasterizePDF(file, "light");
    const outputPdf = await PDFDocument.load(outputBytes);
    const outputPages = outputPdf.getPages();
    const outputInfo = outputPages.map((p) => {
      const rotation = p.getRotation().angle;
      const mediaBox = p.getSize(); // raw, UNROTATED media-box dims
      const swapped = rotation === 90 || rotation === 270;
      const visualBoundingBox = swapped
        ? { width: mediaBox.height, height: mediaBox.width }
        : { width: mediaBox.width, height: mediaBox.height };
      return { rotation, mediaBox, visualBoundingBox };
    });

    // Phase 3.4: rasterize.ts now calls outputPage.setRotation(...) with
    // the source page's own /Rotate value, so this comes back TRUE. See
    // rasterize.ts for the production fix.
    const rotationMetadataPreserved = sourceInfo.every(
      (s, i) => s.rotation === outputInfo[i].rotation,
    );

    // Compares rotation-aware VISUAL bounding boxes on both sides (width/
    // height swapped for 90/270), never the raw media-box — mixing the two
    // up would produce a meaningless assertion in either direction. Since
    // Phase 3.4, the output page's own box is intentionally the
    // *unrotated* intrinsic size (see rasterize.ts), with /Rotate applied
    // separately, so outputInfo's visual box is derived the same way as
    // sourceInfo's rather than read directly off getSize().
    const visualDimensionsPreserved = sourceInfo.every((s, i) => {
      const out = outputInfo[i].visualBoundingBox;
      const widthMatch = Math.abs(s.visualBoundingBox.width - out.width) < 1;
      const heightMatch = Math.abs(s.visualBoundingBox.height - out.height) < 1;
      return widthMatch && heightMatch;
    });

    return {
      success: true,
      rotationMetadataPreserved,
      visualDimensionsPreserved,
      pageCount: sourcePages.length,
      sourceInfo,
      outputInfo,
    };
  }

  // ---------------------------------------------------------------------
  // TEST D — Real scanned compression (through compressPDF, full pipeline)
  // ---------------------------------------------------------------------
  async function runTestD(): Promise<TestResult> {
    const sourceBytes = await buildScannedImageOnlyPdfBytes(2);
    const file = toFile(sourceBytes, "scanned-fixture-full.pdf");

    const result = await compressPDF(file, "light");
    const outputPdf = await PDFDocument.load(result.bytes); // must be loadable
    const pageCount = outputPdf.getPageCount();

    // Proves fallback vs. genuine compression by BYTE EQUALITY, not just
    // a size comparison — output <= original is true in both cases, so
    // size alone can't distinguish them.
    const wasFallback = bytesEqual(result.bytes, new Uint8Array(sourceBytes));

    return {
      success: true,
      pageCountPreserved: pageCount === 2,
      notLarger: result.processedSize <= result.originalSize,
      wasFallback,
      wasGenuineCompression: !wasFallback && result.processedSize < result.originalSize,
      originalSize: result.originalSize,
      processedSize: result.processedSize,
    };
  }

  // ---------------------------------------------------------------------
  // TEST E — Real image-heavy compression
  // ---------------------------------------------------------------------
  async function runTestE(): Promise<TestResult> {
    const sourceBytes = await buildImageHeavyPdfBytes(2);
    const file = toFile(sourceBytes, "image-heavy-fixture.pdf");

    const result = await compressPDF(file, "light");
    const outputPdf = await PDFDocument.load(result.bytes);
    const pageCount = outputPdf.getPageCount();

    return {
      success: true,
      pageCountPreserved: pageCount === 2,
      notLarger: result.processedSize <= result.originalSize,
      originalSize: result.originalSize,
      processedSize: result.processedSize,
    };
  }

  // ---------------------------------------------------------------------
  // TEST F — Text/vector fallback
  // ---------------------------------------------------------------------
  async function runTestF(): Promise<TestResult> {
    const sourceBytes = await buildTextVectorPdfBytes(3);
    const file = toFile(sourceBytes, "text-vector-fixture.pdf");

    const result = await compressPDF(file, "light");
    const outputPdf = await PDFDocument.load(result.bytes);
    const pageCount = outputPdf.getPageCount();

    const wasFallback = bytesEqual(result.bytes, new Uint8Array(sourceBytes));

    return {
      success: true,
      pageCountPreserved: pageCount === 3,
      notLarger: result.processedSize <= result.originalSize,
      // Expected true per the inspection report (rasterizing text/vector
      // content should make it larger, tripping compress.ts's
      // fallback-to-original path) — recorded here, not assumed.
      wasFallback,
      originalSize: result.originalSize,
      processedSize: result.processedSize,
    };
  }

  // ---------------------------------------------------------------------
  // TEST G — Custom compression
  // ---------------------------------------------------------------------
  async function runTestG(): Promise<TestResult> {
    const sourceBytes = await buildImageHeavyPdfBytes(2);
    const file = toFile(sourceBytes, "image-heavy-fixture.pdf");
    const targetBytes = Math.floor(sourceBytes.length * 0.5);
    const targetMb = targetBytes / (1024 * 1024);

    const result = await compressPDF(file, "custom", targetMb);
    const outputPdf = await PDFDocument.load(result.bytes);
    const pageCount = outputPdf.getPageCount();

    // Proves Custom mode actually rasterized (rather than short-circuiting
    // to the original) by byte equality, same reasoning as Test D/F.
    const wasOriginalPassthrough = bytesEqual(result.bytes, new Uint8Array(sourceBytes));

    return {
      success: true,
      pageCountPreserved: pageCount === 2,
      customExecuted: !wasOriginalPassthrough,
      smallerThanOriginal: result.processedSize < result.originalSize,
      targetReached: result.processedSize <= targetBytes,
      originalSize: result.originalSize,
      processedSize: result.processedSize,
      targetBytes,
    };
  }

  // ---------------------------------------------------------------------
  // TEST H — Phase 3.5: extreme-page-size canvas guard doesn't crash and
  // still preserves physical dimensions
  // ---------------------------------------------------------------------
  async function runTestH(): Promise<TestResult> {
    const sourceBytes = await buildExtremeAspectRatioPdfBytes(); // 50000x50pt
    const file = toFile(sourceBytes, "extreme-aspect-ratio-fixture.pdf");

    const sourcePdf = await PDFDocument.load(sourceBytes);
    const sourceDims = sourcePdf.getPages().map((p) => p.getSize());

    // Direct rasterizer call (see file header) — before the Phase 3.5
    // canvas-size guard, this page's width alone at Light's scale 2.2
    // would request a ~110000px-wide canvas. If that throws or hangs,
    // this test's "success" never becomes true and the harness reports it
    // via the error/uncaught-rejection listeners above.
    const outputBytes = await rasterizePDF(file, "light");
    const outputPdf = await PDFDocument.load(outputBytes); // throws if malformed
    const outputDims = outputPdf.getPages().map((p) => p.getSize());

    const dimensionsPreserved = sourceDims.every((d, i) => {
      const out = outputDims[i];
      return Math.abs(d.width - out.width) < 1 && Math.abs(d.height - out.height) < 1;
    });

    return {
      success: true,
      notEmpty: outputBytes.length > 0,
      loadableByPdfLib: true,
      pageCountPreserved: outputPdf.getPageCount() === sourcePdf.getPageCount(),
      dimensionsPreserved,
    };
  }

  // Formats any thrown value (Error or not) into a message+stack string so
  // Playwright can see the *actual* failure instead of just a timeout.
  function describeError(err: unknown): string {
    if (err instanceof Error) {
      return `${err.name}: ${err.message}${err.stack ? `\n${err.stack}` : ""}`;
    }
    try {
      return `Non-Error thrown: ${JSON.stringify(err)}`;
    } catch {
      return `Non-Error thrown: ${String(err)}`;
    }
  }

  // Belt-and-suspenders error capture: if something throws or a promise
  // rejects OUTSIDE the try/catch below (e.g. inside a PDF.js-internal
  // detached promise, or a script error near a page crash), this still
  // flips status to "error" and populates the error testid, instead of the
  // test harness waiting on "results" that will never arrive.
  useEffect(() => {
    const handleWindowError = (event: ErrorEvent) => {
      setError(`Uncaught error: ${describeError(event.error ?? event.message)}`);
      setStatus("error");
    };
    const handleRejection = (event: PromiseRejectionEvent) => {
      setError(`Unhandled promise rejection: ${describeError(event.reason)}`);
      setStatus("error");
    };

    window.addEventListener("error", handleWindowError);
    window.addEventListener("unhandledrejection", handleRejection);

    return () => {
      window.removeEventListener("error", handleWindowError);
      window.removeEventListener("unhandledrejection", handleRejection);
    };
  }, []);

  useEffect(() => {
    window.runCompressionTest = async (testName: string) => {
      setStatus("running");
      setError(null);
      setResults(null);

      try {
        let result: TestResult;

        switch (testName) {
          case "test-a-roundtrip":
            result = await runTestA();
            break;
          case "test-b-dimensions":
            result = await runTestB();
            break;
          case "test-c-rotation":
            result = await runTestC();
            break;
          case "test-d-scanned":
            result = await runTestD();
            break;
          case "test-e-image-heavy":
            result = await runTestE();
            break;
          case "test-f-text-vector":
            result = await runTestF();
            break;
          case "test-g-custom":
            result = await runTestG();
            break;
          case "test-h-extreme-page-size":
            result = await runTestH();
            break;
          default:
            throw new Error(`Unknown test: ${testName}`);
        }

        setResults(result);
        setStatus("complete");
        return result;
      } catch (err) {
        // Explicit, immediate harness failure — the exact error and stack
        // are rendered into data-testid="error" below so Playwright reports
        // the real cause instead of timing out waiting for "results".
        setError(describeError(err));
        setStatus("error");
        throw err;
      }
    };
  }, []);

  return (
    <div style={{ padding: "20px", fontFamily: "monospace" }}>
      <h1>Phase 3.3 Compression Integration Tests</h1>
      <div data-testid="status">{status}</div>
      {error && <div data-testid="error">{error}</div>}
      {results && (
        <div data-testid="results">
          <pre>{JSON.stringify(results, null, 2)}</pre>
        </div>
      )}
      <div style={{ marginTop: "20px" }}>
        <button data-testid="run-test-a" onClick={() => window.runCompressionTest?.("test-a-roundtrip")}>
          Test A: Roundtrip
        </button>
        <button data-testid="run-test-b" onClick={() => window.runCompressionTest?.("test-b-dimensions")}>
          Test B: Dimensions
        </button>
        <button data-testid="run-test-c" onClick={() => window.runCompressionTest?.("test-c-rotation")}>
          Test C: Rotation
        </button>
        <button data-testid="run-test-d" onClick={() => window.runCompressionTest?.("test-d-scanned")}>
          Test D: Scanned
        </button>
        <button data-testid="run-test-e" onClick={() => window.runCompressionTest?.("test-e-image-heavy")}>
          Test E: Image Heavy
        </button>
        <button data-testid="run-test-f" onClick={() => window.runCompressionTest?.("test-f-text-vector")}>
          Test F: Text Vector
        </button>
        <button data-testid="run-test-g" onClick={() => window.runCompressionTest?.("test-g-custom")}>
          Test G: Custom
        </button>
        <button data-testid="run-test-h" onClick={() => window.runCompressionTest?.("test-h-extreme-page-size")}>
          Test H: Extreme Page Size
        </button>
      </div>
    </div>
  );
}
