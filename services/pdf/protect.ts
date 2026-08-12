import { PDFDocument } from "@cantoo/pdf-lib";

export interface ProtectPdfResult {
  bytes: Uint8Array;
  pageCount: number;
  processingTime: number;
}

async function loadUnprotectedPdfOrThrow(file: File): Promise<PDFDocument> {
  let bytes: ArrayBuffer;

  try {
    bytes = await file.arrayBuffer();
  } catch {
    throw new Error(`"${file.name}" could not be read.`);
  }

  try {
    return await PDFDocument.load(bytes);
  } catch (loadError) {
    const message = loadError instanceof Error ? loadError.message : "";

    if (/encrypt/i.test(message)) {
      throw new Error(
        `"${file.name}" is already password protected. Use Unlock PDF first if you want to change its password.`,
      );
    }

    throw new Error(
      `"${file.name}" could not be read as a PDF. It may be corrupted or not a valid PDF file.`,
    );
  }
}

function validatePassword(password: string): void {
  if (password === "") {
    throw new Error("Password is required.");
  }
}

/**
 * Adds password protection to a PDF. The uploaded file is never modified in
 * place — a fresh PDFDocument is loaded, encrypted, and saved as new bytes.
 * The same password is used for both the user (open) password and the
 * owner (permissions) password, since DocFlow does not expose separate
 * permission controls.
 */
export async function protectPDF(
  file: File,
  password: string,
): Promise<ProtectPdfResult> {
  const startTime = performance.now();

  validatePassword(password);

  const pdf = await loadUnprotectedPdfOrThrow(file);
  const pageCount = pdf.getPageCount();

  pdf.encrypt({
    userPassword: password,
    ownerPassword: password,
  });

  let bytes: Uint8Array;

  try {
    bytes = await pdf.save();
  } catch {
    throw new Error("Unable to protect this PDF.");
  }

  return {
    bytes,
    pageCount,
    processingTime: performance.now() - startTime,
  };
}
