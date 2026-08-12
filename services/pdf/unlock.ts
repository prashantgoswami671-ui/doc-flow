import { PDFDocument } from "@cantoo/pdf-lib";

export interface UnlockPdfResult {
  bytes: Uint8Array;
  pageCount: number;
  processingTime: number;
}

function validatePassword(password: string): void {
  if (password === "") {
    throw new Error("Password is required.");
  }
}

/**
 * Removes password protection from a PDF, given its current password. The
 * uploaded file is never modified in place — a fresh PDFDocument is
 * decrypted on load and re-saved without any encryption dictionary, so the
 * output opens with no password at all.
 */
export async function unlockPDF(
  file: File,
  password: string,
): Promise<UnlockPdfResult> {
  const startTime = performance.now();

  validatePassword(password);

  let sourceBytes: ArrayBuffer;

  try {
    sourceBytes = await file.arrayBuffer();
  } catch {
    throw new Error(`"${file.name}" could not be read.`);
  }

  // Probe without decrypting first, so a PDF that was never protected gets
  // a clearer message than a generic "incorrect password" would give.
  let probe: PDFDocument;

  try {
    probe = await PDFDocument.load(sourceBytes, { ignoreEncryption: true });
  } catch {
    throw new Error(
      `"${file.name}" could not be read as a PDF. It may be corrupted or not a valid PDF file.`,
    );
  }

  if (!probe.isEncrypted) {
    throw new Error(`"${file.name}" is not password protected.`);
  }

  let pdf: PDFDocument;

  try {
    pdf = await PDFDocument.load(sourceBytes, { password });
  } catch {
    throw new Error("Incorrect password. Please try again.");
  }

  const pageCount = pdf.getPageCount();

  let bytes: Uint8Array;

  try {
    bytes = await pdf.save();
  } catch {
    throw new Error("Unable to unlock this PDF.");
  }

  return {
    bytes,
    pageCount,
    processingTime: performance.now() - startTime,
  };
}
