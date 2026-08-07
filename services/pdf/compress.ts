import { PDFDocument } from "pdf-lib";

/** Supported compression presets; real logic will be applied per mode later. */
export type CompressionMode = "light" | "heavy" | "custom";

/**
 * Loads a PDF from an uploaded file, processes it, and returns the serialized bytes.
 *
 * Currently performs a round-trip load/save without altering content.
 * The `mode` parameter is reserved for future compression strategies.
 */
export async function compressPDF(
  file: File,
  mode: CompressionMode,
): Promise<Uint8Array> {
  // Step 1: Read the browser File object into a binary buffer pdf-lib can parse
  const pdfBytes = await file.arrayBuffer();

  // Step 2: Parse the buffer into an in-memory PDFDocument
  const pdfDoc = await PDFDocument.load(pdfBytes);

  // Step 3: Apply compression based on mode (not implemented yet)
  switch (mode) {
    case "light":
      // Future: moderate image downsampling and object cleanup
      break;
    case "heavy":
      // Future: aggressive quality reduction for smallest file size
      break;
    case "custom":
      // Future: iteratively compress toward a user-defined target size
      break;
  }

  // Step 4: Serialize the document back to a compact byte array
  const savedPdfBytes = await pdfDoc.save();

  return savedPdfBytes;
}
