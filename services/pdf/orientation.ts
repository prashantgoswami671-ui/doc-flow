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

export interface RasterEvidence {
  orientation: "portrait" | "landscape";
}

export interface OCROrientationEvidence {
  bestOrientation: CardinalOrientation;
  confidence: number;
  margin: number;
  scores: Record<CardinalOrientation, number>;
  // Count of words Tesseract actually recognized text for at each
  // orientation (empty/whitespace-only detection boxes are not counted).
  // This is the real-content signal `resolveOcrOrientation` uses to reject
  // an orientation before its `scores` entry is ever compared -- `scores`
  // alone (confidence) is not sufficient, since a near-blank render can
  // still produce a high confidence value.
  wordCounts: Record<CardinalOrientation, number>;
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
// Thresholds for the image-only OCR fallback. These are unchanged from the
// previous implementation's inline literals (0.5 / 0.15) -- only their use
// has been fixed so that failing to clear them means "needs-review", never
// "normal".
const OCR_MIN_CONFIDENCE = 0.5;
const OCR_MIN_CONFIDENCE_MARGIN = 0.15;
// Minimum number of actually-recognized words an orientation must have
// before its confidence score is trusted at all. This exists because
// Tesseract can report a high confidence (e.g. ~0.95) for a bounding box it
// detected but recognized zero characters in -- confidence measures "how
// sure am I this is a text region", not "how much real text did I actually
// read". Without this floor, a near-blank render can outscore a page with
// dozens of genuinely recognized words. This is an eligibility gate, not a
// substitute for OCR_MIN_CONFIDENCE/OCR_MIN_CONFIDENCE_MARGIN below -- it
// only decides which orientations are allowed to compete on confidence in
// the first place. It is also never used to pick a winner by itself (word
// count is not used to decide 0° vs 180°, only to reject non-candidates).
const OCR_MIN_WORD_COUNT = 3;

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

export function getRasterEvidence(
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
 * Pure decision function for the image-only OCR fallback path.
 *
 * The critical rule: OCR that fails to confidently distinguish the four
 * orientations must resolve to `needs-review`, never to `normal`. An
 * inconclusive result is not evidence that the page is upright -- it is an
 * absence of evidence either way.
 *
 * Decision order:
 *   1. Reject any orientation whose recognized word count doesn't clear
 *      `OCR_MIN_WORD_COUNT` -- a confidence score attached to essentially no
 *      recognized text is not a real signal (see `OCR_MIN_WORD_COUNT`).
 *   2. Among the orientations that survive step 1, pick the highest-scoring
 *      one and compute its margin over the next-highest survivor.
 *   3. Apply the existing `OCR_MIN_CONFIDENCE` / `OCR_MIN_CONFIDENCE_MARGIN`
 *      thresholds to that winner, unchanged from before.
 *
 * Word count is only ever used to decide *eligibility* (step 1). It is never
 * used to pick the winning orientation itself -- that is still decided by
 * confidence score among eligible candidates, exactly as before.
 *
 * Exported (not just internal) so this decision logic can be unit-tested
 * directly, without needing a real Tesseract/canvas/browser environment.
 */
export type OcrOrientationDecision =
  | { kind: "rotated"; orientation: CardinalOrientation; confidence: number }
  | { kind: "normal"; confidence: number }
  | { kind: "needs-review" };

export function resolveOcrOrientation(
  ocrEvidence: OCROrientationEvidence | null,
): OcrOrientationDecision {
  if (!ocrEvidence) {
    // OCR did not run or threw. We have no signal, positive or negative --
    // that is not the same as "this page is normal".
    return { kind: "needs-review" };
  }

  const { scores, wordCounts } = ocrEvidence;

  // Step 1: reject candidates with insufficient actual recognized text
  // before their confidence scores are compared at all. This is what stops
  // a near-blank render's spuriously high confidence (e.g. one empty
  // detection box scored ~0.95) from ever being treated as a real signal.
  const eligibleOrientations = CARDINAL_ORIENTATIONS.filter(
    (orientation) => wordCounts[orientation] >= OCR_MIN_WORD_COUNT,
  );

  if (eligibleOrientations.length === 0) {
    // Nothing at any orientation had enough recognizable text to trust.
    // That is not evidence the page is normal, and not evidence it's
    // rotated -- there is simply no usable OCR signal here.
    return { kind: "needs-review" };
  }

  // Step 2: pick the best-scoring eligible orientation and its margin over
  // the next-best *eligible* orientation (rejected candidates don't count
  // toward the margin either -- they were never real contenders).
  const sortedEligible = [...eligibleOrientations].sort(
    (first, second) => scores[second] - scores[first],
  );
  const bestOrientation = sortedEligible[0];
  const confidence = scores[bestOrientation];
  const secondBestScore =
    sortedEligible.length > 1 ? scores[sortedEligible[1]] : 0;
  const margin = confidence - secondBestScore;

  // Step 3: the existing, unchanged confidence/margin thresholds.
  const isConclusive =
    confidence >= OCR_MIN_CONFIDENCE && margin >= OCR_MIN_CONFIDENCE_MARGIN;

  if (!isConclusive) {
    // Tied or near-tied scores (e.g. ~0.95/0.95/0.95 across 90/180/270):
    // there is no reliable separation, so we cannot pick an orientation --
    // including 0°/normal.
    return { kind: "needs-review" };
  }

  return bestOrientation === 0
    ? { kind: "normal", confidence }
    : { kind: "rotated", orientation: bestOrientation, confidence };
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

    // Test OCR at multiple orientations. Each test also reports how many
    // words Tesseract actually recognized text for at that orientation --
    // `resolveOcrOrientation` uses that (not just the confidence score) to
    // decide whether an orientation's score can be trusted at all.
    const scores: Record<CardinalOrientation, number> = {
      0: 0,
      90: 0,
      180: 0,
      270: 0,
    };
    const wordCounts: Record<CardinalOrientation, number> = {
      0: 0,
      90: 0,
      180: 0,
      270: 0,
    };

    for (const angle of CARDINAL_ORIENTATIONS) {
      const result = await testOrientation(Tesseract.default, imageData, angle);
      scores[angle] = result.confidence;
      wordCounts[angle] = result.wordCount;
    }

    // Find best orientation (raw, unfiltered -- used for diagnostics only;
    // the actual decision in `resolveOcrOrientation` recomputes this after
    // filtering out orientations with insufficient recognized text).
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
      wordCounts,
    };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

/**
 * Tests OCR confidence and real recognized-word count at a specific rotation
 * angle. Confidence alone is not trustworthy: Tesseract can report a high
 * confidence for a detection box that contains no actual recognized text
 * (an empty/whitespace string), so callers must also check `wordCount`
 * before trusting `confidence` -- see `OCR_MIN_WORD_COUNT` and
 * `resolveOcrOrientation`.
 */
async function testOrientation(
  TesseractModule: {
    recognize: (
      imageData: string,
      language: string,
      options: Record<string, unknown>,
    ) => Promise<{
      data: { confidence: number; words?: { text?: string }[] };
    }>;
  },
  imageData: string,
  angle: number,
): Promise<{ confidence: number; wordCount: number }> {
  try {
    // Create rotated version of image
    const rotatedImage = await rotateImageData(imageData, angle);

    // Run OCR on rotated image
    const result = await TesseractModule.recognize(rotatedImage, "eng", {
      logger: () => {
        // Suppress logger output
      },
    });

    // Confidence: higher = Tesseract is more sure a region is readable text.
    const confidence = result.data.confidence || 0;

    // Word count: how many of Tesseract's detected boxes actually contain
    // recognized, non-whitespace text. A detection box with an empty string
    // is not a word, regardless of how confident Tesseract was about it.
    const wordCount = (result.data.words ?? []).filter(
      (word) => (word.text ?? "").trim().length > 0,
    ).length;

    return { confidence: Math.min(confidence / 100, 1.0), wordCount };
  } catch {
    // If OCR fails at this orientation, there is no confidence and no
    // recognized text.
    return { confidence: 0, wordCount: 0 };
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
            // This page's raster aspect ratio already matches the document's
            // dominant orientation (the mismatch case was handled above), so
            // OCR is the only remaining signal for a possible 180° flip.
            // Use OCR to detect true orientation of image-only page. OCR
            // itself may throw (e.g. a decode or worker failure); that is
            // treated the same as "OCR returned nothing usable" below --
            // it must not be allowed to crash the whole analysis, and it
            // must not be treated as evidence the page is normal.
            let ocrEvidence: OCROrientationEvidence | null;

            try {
              ocrEvidence = await detectOrientationViaOCR(page);
            } catch (ocrError) {
              console.error("Page orientation OCR error:", ocrError);
              ocrEvidence = null;
            }

            const decision = resolveOcrOrientation(ocrEvidence);

            if (decision.kind === "rotated") {
              pages.push({
                pageNumber,
                detectedOrientation: decision.orientation,
                proposedCorrection: toCorrection(decision.orientation),
                confidence: decision.confidence,
                status: "likely-rotated",
              });
              continue;
            }

            if (decision.kind === "normal") {
              // OCR itself was confident this page reads correctly at 0°.
              // Report OCR's own per-page confidence here -- not the
              // document-level dominant-raster-orientation ratio, which
              // measures how many pages share a raster aspect ratio, not
              // whether this specific page is upright.
              pages.push({
                pageNumber,
                detectedOrientation: 0,
                proposedCorrection: null,
                confidence: decision.confidence,
                status: "normal",
              });
              continue;
            }

            // OCR was inconclusive (tied/near-tied scores, insufficient
            // margin) or failed outright. Neither is evidence that the page
            // is normal -- surface the uncertainty instead of silently
            // reusing the document's dominant-raster confidence as if it
            // were this page's own orientation confidence.
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
