import { PDFDocument, PDFName, PDFDict } from "pdf-lib";

export type Compressibility = "low" | "medium" | "high";

export interface PdfAnalysis {
  pageCount: number;
  fileSize: number;
  imageCount: number;
  hasImages: boolean;
  estimatedCompressibility: Compressibility;
}

/**
 * Analyzes a PDF without modifying it.
 *
 * This is the first stage of the compression pipeline.
 */
export async function analyzePDF(file: File): Promise<PdfAnalysis> {
  const pdfBytes = await file.arrayBuffer();

  const pdfDoc = await PDFDocument.load(pdfBytes);

  const pages = pdfDoc.getPages();

  let imageCount = 0;

  for (const page of pages) {
    const resources = page.node.Resources();

    if (!resources) {
      continue;
    }

    const xObject = resources.lookup(PDFName.of("XObject"));

    if (!(xObject instanceof PDFDict)) {
      continue;
    }

    const keys = xObject.keys();

    for (const key of keys) {
      const object = xObject.lookup(key);

      /*
       * Images in a PDF are normally represented as
       * XObject objects with Subtype = Image.
       */
      if (object instanceof PDFDict) {
        const subtype = object.get(PDFName.of("Subtype"));

        if (subtype === PDFName.of("Image")) {
          imageCount++;
        }
      }

      /*
       * Some PDFs can contain nested XObject structures.
       * We don't recursively process them yet; that will be
       * handled by the real compression engine.
       */
    }
  }

  const hasImages = imageCount > 0;

  let estimatedCompressibility: Compressibility;

  if (!hasImages) {
    estimatedCompressibility = "low";
  } else if (imageCount <= 5) {
    estimatedCompressibility = "medium";
  } else {
    estimatedCompressibility = "high";
  }

  return {
    pageCount: pages.length,
    fileSize: file.size,
    imageCount,
    hasImages,
    estimatedCompressibility,
  };
}