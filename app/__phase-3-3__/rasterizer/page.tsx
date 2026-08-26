"use client";

import { useState } from "react";
import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";
import { compressPDF } from "../../../services/pdf/compress";
import { rasterizePDFWithSettings } from "../../../services/pdf/rasterize";

type TestResult = {
  name: string;
  status: "pass" | "fail";
  detail: string;
};

const LETTER: [number, number] = [612, 792];

function makeFile(bytes: Uint8Array, name: string): File {
  return new File([bytes as BlobPart], name, { type: "application/pdf" });
}

async function createScanPdf(): Promise<Uint8Array> {
  const canvas = document.createElement("canvas");
  canvas.width = 1000;
  canvas.height = 1400;
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("Unable to create source scan canvas.");
  }

  const imageData = context.createImageData(canvas.width, canvas.height);

  // Deterministic high-entropy scan-like content. This intentionally makes
  // PNG input large enough that the real JPEG rasterizer has meaningful work.
  for (let index = 0; index < imageData.data.length; index += 4) {
    const pixel = index / 4;
    const x = pixel % canvas.width;
    const y = Math.floor(pixel / canvas.width);
    const value = (x * 17 + y * 31 + ((x * y) % 251)) % 256;

    imageData.data[index] = value;
    imageData.data[index + 1] = (value * 7) % 256;
    imageData.data[index + 2] = (value * 13) % 256;
    imageData.data[index + 3] = 255;
  }

  context.putImageData(imageData, 0, 0);

  const pngBlob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Unable to encode scan fixture as PNG."));
    }, "image/png");
  });

  const pngBytes = new Uint8Array(await pngBlob.arrayBuffer());
  const pdf = await PDFDocument.create();
  const image = await pdf.embedPng(pngBytes);

  for (let pageIndex = 0; pageIndex < 2; pageIndex += 1) {
    const page = pdf.addPage(LETTER);
    page.drawImage(image, {
      x: 0,
      y: 0,
      width: LETTER[0],
      height: LETTER[1],
    });
  }

  return pdf.save();
}

async function createTextPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  for (let pageIndex = 0; pageIndex < 2; pageIndex += 1) {
    const page = pdf.addPage(LETTER);
    page.drawText(`Text/vector fixture page ${pageIndex + 1}`, {
      x: 50,
      y: 720,
      size: 22,
      font: bold,
    });
    page.drawText(
      "This page deliberately contains selectable text and vector geometry. " +
        "The raster compression path should normally be larger than this " +
        "small source, so compressPDF should fall back to the original bytes.",
      { x: 50, y: 660, size: 12, font, maxWidth: 500, lineHeight: 16 },
    );
    page.drawLine({
      start: { x: 50, y: 600 },
      end: { x: 550, y: 600 },
      thickness: 2,
      color: rgb(0.2, 0.2, 0.7),
    });
  }

  return pdf.save();
}

async function createRotatedPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const rotations = [0, 90, 180, 270] as const;

  for (const rotation of rotations) {
    const page = pdf.addPage(LETTER);
    page.drawText(`Rotation ${rotation}`, { x: 50, y: 720, size: 18, font });
    page.setRotation(degrees(rotation));
  }

  return pdf.save();
}

async function loadPdf(bytes: Uint8Array): Promise<PDFDocument> {
  return PDFDocument.load(bytes);
}

async function runTest(
  name: string,
  test: () => Promise<string>,
): Promise<TestResult> {
  try {
    return { name, status: "pass", detail: await test() };
  } catch (error) {
    return {
      name,
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export default function Phase33RasterizerHarness() {
  const [results, setResults] = useState<TestResult[]>([]);
  const [running, setRunning] = useState(false);

  const runAll = async () => {
    if (running) return;

    setRunning(true);
    setResults([]);

    const nextResults: TestResult[] = [];

    nextResults.push(
      await runTest("Real rasterizer: scanned PDF roundtrip", async () => {
        const sourceBytes = await createScanPdf();
        const outputBytes = await rasterizePDFWithSettings(
          makeFile(sourceBytes, "phase-3-3-scan.pdf"),
          { scale: 1, quality: 0.55 },
          true,
        );

        const source = await loadPdf(sourceBytes);
        const output = await loadPdf(outputBytes);

        if (output.getPageCount() !== source.getPageCount()) {
          throw new Error(
            `page count changed: ${source.getPageCount()} -> ${output.getPageCount()}`,
          );
        }

        for (let index = 0; index < source.getPageCount(); index += 1) {
          const sourcePage = source.getPages()[index];
          const outputPage = output.getPages()[index];

          if (outputPage.getSize().width !== sourcePage.getSize().width) {
            throw new Error(`page ${index + 1} width changed`);
          }
          if (outputPage.getSize().height !== sourcePage.getSize().height) {
            throw new Error(`page ${index + 1} height changed`);
          }
        }

        if (outputBytes.length >= sourceBytes.length) {
          throw new Error(
            `heavy rasterizer did not reduce the scan: ${sourceBytes.length} -> ${outputBytes.length} bytes`,
          );
        }

        return `valid PDF, ${output.getPageCount()} pages, ${sourceBytes.length} -> ${outputBytes.length} bytes`;
      }),
    );
    setResults([...nextResults]);

    nextResults.push(
      await runTest("Real rasterizer: rotation preservation", async () => {
        const sourceBytes = await createRotatedPdf();
        const outputBytes = await rasterizePDFWithSettings(
          makeFile(sourceBytes, "phase-3-3-rotation.pdf"),
          { scale: 1, quality: 0.55 },
          true,
        );

        const source = await loadPdf(sourceBytes);
        const output = await loadPdf(outputBytes);

        for (let index = 0; index < source.getPageCount(); index += 1) {
          const sourcePage = source.getPages()[index];
          const outputPage = output.getPages()[index];

          if (outputPage.getRotation().angle !== sourcePage.getRotation().angle) {
            throw new Error(
              `page ${index + 1} rotation changed: ${sourcePage.getRotation().angle} -> ${outputPage.getRotation().angle}`,
            );
          }

          if (!Object.is(outputPage.getSize().width, sourcePage.getSize().width)) {
            throw new Error(`page ${index + 1} width changed`);
          }
          if (!Object.is(outputPage.getSize().height, sourcePage.getSize().height)) {
            throw new Error(`page ${index + 1} height changed`);
          }
        }

        return "all source rotations and media-box dimensions preserved";
      }),
    );
    setResults([...nextResults]);

    nextResults.push(
      await runTest("Compression engine: text/vector fallback", async () => {
        const sourceBytes = await createTextPdf();
        const result = await compressPDF(
          makeFile(sourceBytes, "phase-3-3-text.pdf"),
          "light",
        );

        if (result.processedSize > result.originalSize) {
          throw new Error("compression returned a larger file");
        }

        if (result.processedSize === result.originalSize) {
          for (let index = 0; index < sourceBytes.length; index += 1) {
            if (result.bytes[index] !== sourceBytes[index]) {
              throw new Error("fallback size matched but bytes changed");
            }
          }
        }

        await loadPdf(result.bytes);

        return `result ${result.originalSize} -> ${result.processedSize} bytes (${result.reductionPercent.toFixed(1)}% reduction)`;
      }),
    );
    setResults([...nextResults]);

    nextResults.push(
      await runTest("Compression engine: reachable custom target", async () => {
        const sourceBytes = await createScanPdf();
        const targetBytes = Math.floor(sourceBytes.length * 0.9);
        const result = await compressPDF(
          makeFile(sourceBytes, "phase-3-3-custom.pdf"),
          "custom",
          targetBytes / (1024 * 1024),
        );

        await loadPdf(result.bytes);

        if (result.processedSize > targetBytes) {
          throw new Error(
            `target missed: ${result.processedSize} > ${targetBytes} bytes`,
          );
        }
        if (result.processedSize >= result.originalSize) {
          throw new Error("custom compression did not reduce the source");
        }

        return `target ${targetBytes} bytes; result ${result.processedSize} bytes`;
      }),
    );
    setResults([...nextResults]);

    setRunning(false);
  };

  const passed = results.filter((result) => result.status === "pass").length;
  const failed = results.filter((result) => result.status === "fail").length;

  return (
    <main className="min-h-screen bg-gray-50 px-4 py-10 text-gray-900">
      <div className="mx-auto max-w-3xl">
        <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-blue-600">
            DocFlow · Phase 3.3
          </p>
          <h1 className="mt-2 text-2xl font-bold">Real Rasterizer Browser Harness</h1>
          <p className="mt-2 text-sm leading-6 text-gray-600">
            This page intentionally exercises the real PDF.js + Canvas + JPEG +
            pdf-lib path. It does not mock rasterizePDFWithSettings() and does
            not modify the compression engine.
          </p>

          <button
            type="button"
            onClick={runAll}
            disabled={running}
            className="mt-6 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-gray-300"
          >
            {running ? "Running real browser tests..." : "Run all Phase 3.3 tests"}
          </button>

          {results.length > 0 && (
            <div className="mt-6 space-y-3">
              <div className="flex gap-4 text-sm font-medium">
                <span className="text-green-700">Passed: {passed}</span>
                <span className="text-red-700">Failed: {failed}</span>
              </div>

              {results.map((result) => (
                <div
                  key={result.name}
                  className={`rounded-lg border px-4 py-3 ${
                    result.status === "pass"
                      ? "border-green-200 bg-green-50"
                      : "border-red-200 bg-red-50"
                  }`}
                >
                  <p className="text-sm font-semibold">
                    {result.status === "pass" ? "PASS" : "FAIL"} — {result.name}
                  </p>
                  <p className="mt-1 text-xs text-gray-700">{result.detail}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
