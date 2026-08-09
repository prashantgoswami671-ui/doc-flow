export type CardinalOrientation = 0 | 90 | 180 | 270;
export type OrientationCorrection = 90 | 180 | 270;
export type OrientationStatus =
  | "normal"
  | "likely-rotated"
  | "likely-misaligned"
  | "needs-review"
  | "unable-to-detect";

export interface PageOrientationResult {
  pageNumber: number;
  detectedOrientation: CardinalOrientation | null;
  proposedCorrection: OrientationCorrection | null;
  confidence: number;
  status: OrientationStatus;
  rasterAssessment?: "landscape-outlier" | "inconclusive";
}

export interface OrientationAnalysisResult {
  pageCount: number;
  pages: PageOrientationResult[];
}

export interface OrientationAnalysisProgress {
  currentPage: number;
  pageCount: number;
}

interface TextItemLike {
  str?: string;
  transform?: number[];
}

interface TextEvidence {
  transform: number[];
  weight: number;
}

interface RasterEvidence {
  orientation: "portrait" | "landscape";
}

interface OCROrientationEvidence {
  bestOrientation: CardinalOrientation;
  confidence: number;
  margin: number;
  scores: Record<CardinalOrientation, number>;
}

const CARDINAL_ORIENTATIONS: CardinalOrientation[] = [0, 90, 180, 270];
const MIN_ALPHANUMERIC_CHARACTERS = 80;
const MIN_TEXT_ITEMS = 8;
const CARDINAL_TOLERANCE_DEGREES = 20;
const MIN_CONFIDENCE = 0.85;
const MIN_CONFIDENCE_MARGIN = 0.2;
const MIN_RASTER_PAGES_FOR_DOMINANCE = 3;
const MIN_DOMINANT_RASTER_RATIO = 0.8;
const MIN_IMAGE_ASPECT_RATIO = 1.15;

function normalizeAngle(angle: number): number {
  return ((angle % 360) + 360) % 360;
}

function multiplyTransforms(first: number[], second: number[]): number[] {
  return [
    first[0] * second[0] + first[2] * second[1],
    first[1] * second[0] + first[3] * second[1],
    first[0] * second[2] + first[2] * second[3],
    first[1] * second[2] + first[3] * second[3],
    first[0] * second[4] + first[2] * second[5] + first[4],
    first[1] * second[4] + first[3] * second[5] + first[5],
  ];
}

function nearestCardinalOrientation(angle: number): CardinalOrientation | null {
  const normalizedAngle = normalizeAngle(angle);
  const nearest = Math.round(normalizedAngle / 90) * 90;
  const orientation = normalizeAngle(nearest) as CardinalOrientation;
  const difference = Math.abs(
    ((normalizedAngle - orientation + 540) % 360) - 180,
  );

  return difference <= CARDINAL_TOLERANCE_DEGREES ? orientation : null;
}

function isTextItem(item: unknown): item is TextItemLike {
  return typeof item === "object" && item !== null && "str" in item;
}

function extractTextEvidence(items: unknown[]): TextEvidence[] {
  const evidence: TextEvidence[] = [];

  for (const item of items) {
    if (!isTextItem(item) || !Array.isArray(item.transform)) {
      continue;
    }

    const alphanumericCharacters = (item.str ?? "").match(/[A-Za-z0-9]/g);

    if (!alphanumericCharacters || item.transform.length < 6) {
      continue;
    }

    const [a, b, c, d] = item.transform;

    if (
      !Number.isFinite(a) ||
      !Number.isFinite(b) ||
      !Number.isFinite(c) ||
      !Number.isFinite(d) ||
      (a === 0 && b === 0) ||
      (c === 0 && d === 0)
    ) {
      continue;
    }

    evidence.push({
      transform: item.transform,
      weight: alphanumericCharacters.length,
    });
  }

  return evidence;
}

function getTextOrientation(transform: number[]): CardinalOrientation | null {
  const baseline = nearestCardinalOrientation(
    (Math.atan2(transform[1], transform[0]) * 180) / Math.PI,
  );
  const glyphUp = nearestCardinalOrientation(
    (Math.atan2(transform[3], transform[2]) * 180) / Math.PI,
  );

  if (baseline === null || glyphUp === null) {
    return null;
  }

  // In viewport coordinates, readable glyphs extend toward negative Y from a
  // left-to-right baseline. Checking both axes keeps a horizontal baseline
  // from being treated as upright when the glyphs themselves are inverted.
  return glyphUp === normalizeAngle(baseline + 270) ? baseline : null;
}

function scoreOrientation(
  viewportTransform: number[],
  evidence: TextEvidence[],
): number {
  let score = 0;

  for (const text of evidence) {
    const transformed = multiplyTransforms(viewportTransform, text.transform);
    const orientation = getTextOrientation(transformed);

    if (orientation === 0) {
      score += text.weight;
    }
  }

  return score;
}

function detectCurrentOrientation(
  viewportTransform: number[],
  evidence: TextEvidence[],
): CardinalOrientation | null {
  const votes: Record<CardinalOrientation, number> = {
    0: 0,
    90: 0,
    180: 0,
    270: 0,
  };

  for (const text of evidence) {
    const transformed = multiplyTransforms(viewportTransform, text.transform);
    const orientation = getTextOrientation(transformed);

    if (orientation !== null) {
      votes[orientation] += text.weight;
    }
  }

  const dominantOrientation = CARDINAL_ORIENTATIONS.reduce((best, orientation) =>
    votes[orientation] > votes[best] ? orientation : best,
  );

  return votes[dominantOrientation] > 0 ? dominantOrientation : null;
}

function toCorrection(angle: CardinalOrientation): OrientationCorrection | null {
  return angle === 0 ? null : angle as OrientationCorrection;
}

function correctionForPageRotation(
  pageRotation: CardinalOrientation,
): OrientationCorrection | null {
  return toCorrection(
    normalizeAngle(360 - pageRotation) as CardinalOrientation,
  );
}

function getRasterEvidence(
  operatorList: { fnArray: number[]; argsArray: unknown[][] },
  imagePaintOperators: Set<number>,
): RasterEvidence | null {
  let largestImage: { width: number; height: number; area: number } | null = null;

  for (let index = 0; index < operatorList.fnArray.length; index++) {
    if (!imagePaintOperators.has(operatorList.fnArray[index])) {
      continue;
    }

    const args = operatorList.argsArray[index];
    const width = args?.[1];
    const height = args?.[2];

    if (
      typeof width !== "number" ||
      typeof height !== "number" ||
      width <= 0 ||
      height <= 0
    ) {
      continue;
    }

    const area = width * height;

    if (!largestImage || area > largestImage.area) {
      largestImage = { width, height, area };
    }
  }

  if (!largestImage) {
    return null;
  }

  const aspectRatio = Math.max(largestImage.width, largestImage.height) /
    Math.min(largestImage.width, largestImage.height);

  if (aspectRatio < MIN_IMAGE_ASPECT_RATIO) {
    return null;
  }

  return {
    orientation:
      largestImage.height > largestImage.width ? "portrait" : "landscape",
  };
}

/**
 * Detects orientation of image-only pages using OCR analysis.
 * Renders the page at multiple orientations and evaluates which
 * produces the most readable text (highest confidence score).
 *
 * This approach works for 180° rotation because:
 * - A correctly oriented page produces readable text with high confidence
 * - A 180° rotated page produces unreadable text with low confidence
 * - Comparing confidence scores across orientations reveals the true orientation
 */
async function detectOrientationViaOCR(
  page: unknown,
): Promise<OCROrientationEvidence | null> {
  // Dynamically import Tesseract and PDF.js
  const Tesseract = await import("tesseract.js");
  await import("pdfjs-dist/legacy/build/pdf.mjs");

  if (typeof window === "undefined") {
    // OCR only works in browser context
    return null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pageObj = page as any;
  
  // Render at low resolution for faster OCR (450px max dimension)
  const baseViewport = pageObj.getViewport({ scale: 1 });
  const scale = Math.min(1, 450 / Math.max(baseViewport.width, baseViewport.height));
  const viewport = pageObj.getViewport({ scale });

  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);

  const context = canvas.getContext("2d");
  if (!context) {
    return null;
  }

  try {
    // Render original page
    await pageObj.render({
      canvas,
      canvasContext: context,
      viewport,
    }).promise;

    // Get canvas image data as image
    const imageData = canvas.toDataURL("image/png");

    // Test OCR at multiple orientations
    const scores: Record<CardinalOrientation, number> = {
      0: 0,
      90: 0,
      180: 0,
      270: 0,
    };

    // Test 0° (original)
    scores[0] = await testOrientation(
      Tesseract.default,
      imageData,
      0,
    );

    // Test 90° clockwise
    scores[90] = await testOrientation(
      Tesseract.default,
      imageData,
      90,
    );

    // Test 180° (upside down) - THIS IS KEY FOR PAGE 9
    scores[180] = await testOrientation(
      Tesseract.default,
      imageData,
      180,
    );

    // Test 270° clockwise
    scores[270] = await testOrientation(
      Tesseract.default,
      imageData,
      270,
    );

    // Find best orientation
    const bestOrientation = (Object.keys(scores) as unknown as CardinalOrientation[]).reduce(
      (best, current) => (scores[current] > scores[best] ? current : best),
      0 as CardinalOrientation,
    );

    // Calculate confidence and margin
    const sortedScores = Object.entries(scores)
      .map(([angle, score]) => ({ angle: parseInt(angle) as CardinalOrientation, score }))
      .sort((a, b) => b.score - a.score);

    const bestScore = sortedScores[0].score;
    const secondBestScore = sortedScores[1]?.score || 0;
    const margin = bestScore - secondBestScore;
    const confidence = Math.min(bestScore, 1.0);

    return {
      bestOrientation,
      confidence,
      margin,
      scores,
    };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

/**
 * Tests OCR confidence at a specific rotation angle.
 * Returns confidence score (0-1) for how well text is readable at that angle.
 */
async function testOrientation(
  TesseractModule: { recognize: (imageData: string, language: string, options: Record<string, unknown>) => Promise<{ data: { confidence: number } }> },
  imageData: string,
  angle: number,
): Promise<number> {
  try {
    // Create rotated version of image
    const rotatedImage = await rotateImageData(imageData, angle);

    // Run OCR on rotated image
    const result = await TesseractModule.recognize(rotatedImage, "eng", {
      logger: () => {
        // Suppress logger output
      },
    });

    // Return confidence (higher = more readable text)
    const confidence = result.data.confidence || 0;
    return Math.min(confidence / 100, 1.0);
  } catch {
    // If OCR fails at this orientation, return 0 confidence
    return 0;
  }
}

/**
 * Rotates image data by the specified angle using canvas.
 */
function rotateImageData(imageDataUrl: string, angle: number): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      const radians = (angle * Math.PI) / 180;
      const sin = Math.abs(Math.sin(radians));
      const cos = Math.abs(Math.cos(radians));

      canvas.width = Math.floor(img.height * sin + img.width * cos);
      canvas.height = Math.floor(img.height * cos + img.width * sin);

      const context = canvas.getContext("2d");
      if (!context) {
        resolve(imageDataUrl);
        return;
      }

      context.translate(canvas.width / 2, canvas.height / 2);
      context.rotate(radians);
      context.drawImage(img, -img.width / 2, -img.height / 2);

      resolve(canvas.toDataURL("image/png"));
    };
    img.src = imageDataUrl;
  });
}

function getDominantRasterOrientation(
  rasterEvidence: Map<number, RasterEvidence>,
): { orientation: RasterEvidence["orientation"]; confidence: number } | null {
  const counts = { portrait: 0, landscape: 0 };

  for (const evidence of rasterEvidence.values()) {
    counts[evidence.orientation] += 1;
  }

  const total = counts.portrait + counts.landscape;

  if (total < MIN_RASTER_PAGES_FOR_DOMINANCE) {
    return null;
  }

  const orientation =
    counts.portrait >= counts.landscape ? "portrait" : "landscape";
  const confidence = counts[orientation] / total;

  return confidence >= MIN_DOMINANT_RASTER_RATIO
    ? { orientation, confidence }
    : null;
}

/**
 * Estimates page orientation from extractable text and, for image-only pages,
 * conservatively identifies strong document-level image-orientation outliers.
 */
export async function analyzePdfOrientation(
  file: File,
  onProgress?: (progress: OrientationAnalysisProgress) => void,
): Promise<OrientationAnalysisResult> {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");

  if (typeof window !== "undefined") {
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/legacy/build/pdf.worker.min.mjs",
      import.meta.url,
    ).toString();
  }

  const inputBytes = new Uint8Array(await file.arrayBuffer());
  const loadingTask = pdfjsLib.getDocument({ data: inputBytes });
  let pdf: Awaited<typeof loadingTask.promise> | undefined;

  try {
    pdf = await loadingTask.promise;
    const pages: PageOrientationResult[] = [];
    const rasterEvidence = new Map<number, RasterEvidence>();
    const imagePaintOperators = new Set<number>([
      pdfjsLib.OPS.paintImageXObject,
      pdfjsLib.OPS.paintInlineImageXObject,
      pdfjsLib.OPS.paintImageMaskXObject,
      pdfjsLib.OPS.paintSolidColorImageMask,
    ]);

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);

      try {
        const textContent = await page.getTextContent();

        if (extractTextEvidence(textContent.items).length === 0) {
          const evidence = getRasterEvidence(
            await page.getOperatorList(),
            imagePaintOperators,
          );

          if (evidence) {
            rasterEvidence.set(pageNumber, evidence);
          }
        }
      } finally {
        page.cleanup();
      }
    }

    const dominantRasterOrientation = getDominantRasterOrientation(rasterEvidence);

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);

      try {
        const textContent = await page.getTextContent();
        const evidence = extractTextEvidence(textContent.items);
        const totalTextWeight = evidence.reduce(
          (total, text) => total + text.weight,
          0,
        );

        if (evidence.length === 0) {
          const pageRotation = normalizeAngle(page.rotate) as CardinalOrientation;
          const proposedCorrection = correctionForPageRotation(pageRotation);

          if (proposedCorrection !== null) {
            pages.push({
              pageNumber,
              detectedOrientation: pageRotation,
              proposedCorrection,
              confidence: 1,
              status: "likely-rotated",
            });
            continue;
          }

          const pageRasterEvidence = rasterEvidence.get(pageNumber);

          if (
            dominantRasterOrientation &&
            pageRasterEvidence &&
            pageRasterEvidence.orientation !== dominantRasterOrientation.orientation
          ) {
            pages.push({
              pageNumber,
              detectedOrientation: null,
              proposedCorrection: null,
              confidence: dominantRasterOrientation.confidence,
              status: "likely-misaligned",
              rasterAssessment: "landscape-outlier",
            });
            continue;
          }

          if (pageRasterEvidence && !dominantRasterOrientation) {
            pages.push({
              pageNumber,
              detectedOrientation: null,
              proposedCorrection: null,
              confidence: 0,
              status: "needs-review",
              rasterAssessment: "inconclusive",
            });
            continue;
          }

          if (pageRasterEvidence && dominantRasterOrientation) {
            // Use OCR to detect true orientation of image-only page
            const ocrEvidence = await detectOrientationViaOCR(page);
            
            if (ocrEvidence) {
              const { bestOrientation, confidence, margin } = ocrEvidence;
              
              // Strong confidence and meaningful margin between best and second-best
              if (confidence >= 0.5 && margin >= 0.15) {
                if (bestOrientation !== 0) {
                  // Page needs rotation
                  pages.push({
                    pageNumber,
                    detectedOrientation: bestOrientation,
                    proposedCorrection: toCorrection(bestOrientation),
                    confidence,
                    status: "likely-rotated",
                  });
                  continue;
                }
              }
            }
            
            // No strong OCR evidence, check aspect ratio mismatch
            if (
              pageRasterEvidence.orientation !== dominantRasterOrientation.orientation
            ) {
              // Aspect ratio outlier (90°/270° misalignment)
              pages.push({
                pageNumber,
                detectedOrientation: null,
                proposedCorrection: null,
                confidence: dominantRasterOrientation.confidence,
                status: "likely-misaligned",
                rasterAssessment: "landscape-outlier",
              });
              continue;
            }
            
            // Matches dominant orientation, assume normal
            pages.push({
              pageNumber,
              detectedOrientation: 0,
              proposedCorrection: null,
              confidence: dominantRasterOrientation.confidence,
              status: "normal",
            });
            continue;
          }

          pages.push({
            pageNumber,
            detectedOrientation: null,
            proposedCorrection: null,
            confidence: 0,
            status: "unable-to-detect",
          });
          continue;
        }

        if (
          evidence.length < MIN_TEXT_ITEMS ||
          totalTextWeight < MIN_ALPHANUMERIC_CHARACTERS
        ) {
          pages.push({
            pageNumber,
            detectedOrientation: null,
            proposedCorrection: null,
            confidence: 0,
            status: "needs-review",
          });
          continue;
        }

        const currentViewport = page.getViewport({ scale: 1 });
        const detectedOrientation = detectCurrentOrientation(
          currentViewport.transform,
          evidence,
        );
        const scores = CARDINAL_ORIENTATIONS.map((correction) => ({
          correction,
          score: scoreOrientation(
            page.getViewport({
              scale: 1,
              rotation: normalizeAngle(page.rotate + correction),
            }).transform,
            evidence,
          ),
        }));
        const sortedScores = [...scores].sort((first, second) => second.score - first.score);
        const best = sortedScores[0];
        const secondBest = sortedScores[1];
        const confidence = best.score / totalTextWeight;
        const margin = (best.score - secondBest.score) / totalTextWeight;
        const proposedCorrection = toCorrection(best.correction);
        const isHighConfidence =
          confidence >= MIN_CONFIDENCE && margin >= MIN_CONFIDENCE_MARGIN;

        pages.push({
          pageNumber,
          detectedOrientation,
          proposedCorrection: isHighConfidence ? proposedCorrection : null,
          confidence,
          status:
            isHighConfidence && proposedCorrection !== null
              ? "likely-rotated"
              : isHighConfidence
                ? "normal"
                : "needs-review",
        });
      } finally {
        page.cleanup();
        onProgress?.({ currentPage: pageNumber, pageCount: pdf.numPages });
      }
    }

    return { pageCount: pdf.numPages, pages };
  } finally {
    pdf?.cleanup();
    await loadingTask.destroy();
  }
}
