import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";
import { PDFDocument as EncryptablePDFDocument } from "@cantoo/pdf-lib";
import { bandedGradientPng, solidColorPng } from "./png";

/**
 * Deterministic PDF fixture builders for Phase 3.1 (compression baseline).
 * Test-fixture infrastructure only — never imported by application code
 * under services/pdf/*.ts (excluding this __fixtures__ directory).
 *
 * These build real PDFs via pdf-lib (matching what compress.ts itself
 * loads with plain "pdf-lib"), so structural invariants (page count, page
 * dimensions, rotation, PDF validity) can be checked with pdf-lib after
 * compressPDF() runs, without needing a browser/PDF.js/canvas.
 *
 * Image content uses the zlib-backed PNG encoder in ./png.ts rather than
 * canvas, since canvas/DOM APIs are not available in this project's plain
 * Node vitest environment (no jsdom/canvas package is installed — see
 * docs/PHASE_3_1_COMPRESSION_BASELINE.md for why that's fine here).
 */

const LETTER: [number, number] = [612, 792];
const LETTER_LANDSCAPE: [number, number] = [792, 612];

/** 1. Text/vector PDF: selectable text, headings, paragraphs, vector shapes. */
export async function buildTextVectorPdfBytes(
  pageCount = 3,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdf.embedFont(StandardFonts.HelveticaBold);

  for (let index = 0; index < pageCount; index++) {
    const page = pdf.addPage(LETTER);

    page.drawText(`Section ${index + 1} Heading`, {
      x: 50,
      y: 720,
      size: 22,
      font: boldFont,
    });

    page.drawText(
      "This is a paragraph of selectable body text used as a Phase 3.1 " +
        "fixture. It exists so compression tests can check whether text " +
        "and searchability survive a given compression mode.",
      { x: 50, y: 660, size: 12, font, maxWidth: 500, lineHeight: 16 },
    );

    page.drawLine({
      start: { x: 50, y: 600 },
      end: { x: 550, y: 600 },
      thickness: 2,
      color: rgb(0.2, 0.2, 0.6),
    });

    page.drawRectangle({
      x: 50,
      y: 480,
      width: 200,
      height: 90,
      borderColor: rgb(0.8, 0.2, 0.2),
      borderWidth: 2,
    });

    page.drawEllipse({
      x: 400,
      y: 525,
      xScale: 80,
      yScale: 45,
      borderColor: rgb(0.2, 0.6, 0.3),
      borderWidth: 2,
    });
  }

  return pdf.save();
}

/** 2. Scanned/image-only PDF: full-bleed page images, no selectable text. */
export async function buildScannedImageOnlyPdfBytes(
  pageCount = 2,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();

  for (let index = 0; index < pageCount; index++) {
    const png = bandedGradientPng(850, 1100);
    const image = await pdf.embedPng(png);
    const page = pdf.addPage(LETTER);

    page.drawImage(image, { x: 0, y: 0, width: LETTER[0], height: LETTER[1] });
  }

  return pdf.save();
}

/** 3. Image-heavy PDF: several large photographic-style images per page. */
export async function buildImageHeavyPdfBytes(
  pageCount = 2,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();

  for (let index = 0; index < pageCount; index++) {
    const page = pdf.addPage(LETTER);

    for (let imageIndex = 0; imageIndex < 3; imageIndex++) {
      const png = bandedGradientPng(600, 500);
      const image = await pdf.embedPng(png);

      page.drawImage(image, {
        x: 20 + imageIndex * 15,
        y: 60 + imageIndex * 40,
        width: 300,
        height: 250,
      });
    }
  }

  return pdf.save();
}

/** 4. Mixed PDF: text/vector pages + image-heavy pages + scan-only pages. */
export async function buildMixedPdfBytes(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);

  // Text/vector page.
  const textPage = pdf.addPage(LETTER);
  textPage.drawText("Mixed fixture — text page", {
    x: 50,
    y: 720,
    size: 18,
    font,
  });
  textPage.drawLine({
    start: { x: 50, y: 680 },
    end: { x: 550, y: 680 },
    thickness: 1,
    color: rgb(0.3, 0.3, 0.3),
  });

  // Image-heavy page.
  const imagePage = pdf.addPage(LETTER);
  const heavyPng = bandedGradientPng(500, 400);
  const heavyImage = await pdf.embedPng(heavyPng);
  imagePage.drawImage(heavyImage, { x: 50, y: 300, width: 500, height: 400 });

  // Scan-only page.
  const scanPage = pdf.addPage(LETTER);
  const scanPng = bandedGradientPng(850, 1100);
  const scanImage = await pdf.embedPng(scanPng);
  scanPage.drawImage(scanImage, {
    x: 0,
    y: 0,
    width: LETTER[0],
    height: LETTER[1],
  });

  return pdf.save();
}

/** 5. Mixed-orientation PDF: portrait, landscape, and rotated pages. */
export async function buildMixedOrientationPdfBytes(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);

  const portrait = pdf.addPage(LETTER);
  portrait.drawText("Portrait, 0deg", { x: 40, y: 720, size: 14, font });

  const landscape = pdf.addPage(LETTER_LANDSCAPE);
  landscape.drawText("Landscape, 0deg", { x: 40, y: 560, size: 14, font });

  const rotated90 = pdf.addPage(LETTER);
  rotated90.drawText("Portrait page, /Rotate 90", {
    x: 40,
    y: 720,
    size: 14,
    font,
  });
  rotated90.setRotation(degrees(90));

  const rotated180 = pdf.addPage(LETTER);
  rotated180.drawText("Portrait page, /Rotate 180", {
    x: 40,
    y: 720,
    size: 14,
    font,
  });
  rotated180.setRotation(degrees(180));

  const rotated270 = pdf.addPage(LETTER_LANDSCAPE);
  rotated270.drawText("Landscape page, /Rotate 270", {
    x: 40,
    y: 560,
    size: 14,
    font,
  });
  rotated270.setRotation(degrees(270));

  return pdf.save();
}

/** 6. Unusual page-size PDF: a small page, a large page, and a mix. */
export async function buildUnusualPageSizePdfBytes(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);

  const small = pdf.addPage([72, 72]); // 1in x 1in
  small.drawText("S", { x: 20, y: 30, size: 10, font });

  const standard = pdf.addPage(LETTER);
  standard.drawText("Standard Letter page", { x: 40, y: 720, size: 14, font });

  const large = pdf.addPage([2000, 3000]);
  large.drawText("Large page", { x: 60, y: 2900, size: 40, font });

  return pdf.save();
}

/** 7. Empty PDF: zero pages. */
export async function buildEmptyPdfBytes(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();

  return pdf.save();
}

/**
 * 8. Encrypted/password-protected PDF, built the same way protectPDF()
 * builds one in production: @cantoo/pdf-lib's `encrypt()`, since plain
 * pdf-lib (what compress.ts loads with) cannot create or decrypt
 * encrypted PDFs — it can only fail to load one, which is the exact
 * behavior compress.ts's encryption detection depends on.
 */
export const ENCRYPTED_FIXTURE_PASSWORD = "phase3-fixture-pass";

export async function buildEncryptedPdfBytes(
  password: string = ENCRYPTED_FIXTURE_PASSWORD,
): Promise<Uint8Array> {
  const pdf = await EncryptablePDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage(LETTER);

  page.drawText("Encrypted fixture content", { x: 40, y: 720, size: 14, font });

  pdf.encrypt({ userPassword: password, ownerPassword: password });

  return pdf.save();
}

/**
 * 9. Malformed/corrupt PDF: a real PDF's bytes, deliberately truncated so
 * the trailer/xref table is cut off. Deterministic and derived from
 * buildTextVectorPdfBytes() rather than hand-written garbage, so it
 * exercises pdf-lib's real parse-failure path the way a partially
 * downloaded/corrupted upload would.
 */
export async function buildMalformedPdfBytes(): Promise<Uint8Array> {
  const validBytes = await buildTextVectorPdfBytes(1);
  const truncateAt = Math.max(10, Math.floor(validBytes.length * 0.5));

  return validBytes.slice(0, truncateAt);
}

/** 10. High-resolution scan: one large image-based page. */
export async function buildHighResScanPdfBytes(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const png = bandedGradientPng(2480, 3508); // ~A4 at 300dpi
  const image = await pdf.embedPng(png);
  const page = pdf.addPage(LETTER);

  page.drawImage(image, { x: 0, y: 0, width: LETTER[0], height: LETTER[1] });

  return pdf.save();
}

/**
 * 11. Extreme-aspect-ratio page: a very wide, very short single page.
 * Phase 3.5 fixture — lets the canvas-size guard (computeSafeRenderScale)
 * be exercised through the real rasterizer (Playwright) cheaply: the
 * width alone (50000pt) already forces the guard to engage at Light's
 * scale 2.2 (a naive 110000px-wide canvas), but because the page is only
 * 50pt tall, the *clamped* render is a tiny image (a few hundred pixels
 * on its long side), so the real render/JPEG-encode stays fast instead of
 * requiring an actual multi-thousand-pixel-square canvas to prove the
 * guard prevents an oversized allocation.
 */
export async function buildExtremeAspectRatioPdfBytes(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([50000, 50]);

  page.drawText("Extreme aspect ratio fixture", { x: 10, y: 15, size: 10, font });

  return pdf.save();
}

/** Wraps fixture bytes as a File, the way the browser upload path does. */
export function toFile(bytes: Uint8Array, name = "fixture.pdf"): File {
  return new File([bytes as BlobPart], name, { type: "application/pdf" });
}

/** Small solid-color PNG re-export, for tests that just need "an image". */
export { solidColorPng };
