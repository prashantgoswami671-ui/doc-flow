import { PDFDocument } from "pdf-lib";

/** Editable metadata fields, as plain display strings (empty = not set). */
export interface PdfMetadataFields {
  title: string;
  author: string;
  subject: string;
  keywords: string;
  creator: string;
  producer: string;
}

export interface ReadMetadataResult {
  fields: PdfMetadataFields;
  pageCount: number;
}

export interface UpdateMetadataResult {
  bytes: Uint8Array;
  fields: PdfMetadataFields;
  processingTime: number;
}

function toDisplayString(value: string | undefined): string {
  return value ?? "";
}

async function loadPdf(file: File): Promise<PDFDocument> {
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
        `"${file.name}" is password protected. Use Unlock PDF first, then edit metadata on the unlocked file.`,
      );
    }

    throw new Error(
      `"${file.name}" could not be read as a PDF. It may be corrupted or not a valid PDF file.`,
    );
  }
}

/** Reads a PDF's Info-dictionary metadata without modifying it. */
export async function readPdfMetadata(
  file: File,
): Promise<ReadMetadataResult> {
  const pdf = await loadPdf(file);

  return {
    fields: {
      title: toDisplayString(pdf.getTitle()),
      author: toDisplayString(pdf.getAuthor()),
      subject: toDisplayString(pdf.getSubject()),
      // pdf-lib stores Keywords as a single Info-dict string; getKeywords()
      // returns that raw string rather than an array.
      keywords: toDisplayString(pdf.getKeywords()),
      creator: toDisplayString(pdf.getCreator()),
      producer: toDisplayString(pdf.getProducer()),
    },
    pageCount: pdf.getPageCount(),
  };
}

/**
 * Writes updated metadata into a new copy of the PDF and returns the saved
 * bytes. The original File is never touched — a fresh PDFDocument is loaded,
 * modified, and re-saved. Only the Info-dictionary fields change; page
 * content, structure and fonts are left exactly as pdf-lib loaded them
 * (no rasterizing, no page copying).
 *
 * An empty (trimmed-blank) field is written as an empty string, which
 * clears the field's visible value. Keywords are written back as a single
 * entry via setKeywords, since pdf-lib serializes the Info dictionary's
 * Keywords as one string rather than a true list.
 */
export async function updatePdfMetadata(
  file: File,
  fields: PdfMetadataFields,
): Promise<UpdateMetadataResult> {
  const startTime = performance.now();
  const pdf = await loadPdf(file);

  const trimmedFields: PdfMetadataFields = {
    title: fields.title.trim(),
    author: fields.author.trim(),
    subject: fields.subject.trim(),
    keywords: fields.keywords.trim(),
    creator: fields.creator.trim(),
    producer: fields.producer.trim(),
  };

  pdf.setTitle(trimmedFields.title);
  pdf.setAuthor(trimmedFields.author);
  pdf.setSubject(trimmedFields.subject);
  pdf.setKeywords(trimmedFields.keywords === "" ? [] : [trimmedFields.keywords]);
  pdf.setCreator(trimmedFields.creator);
  pdf.setProducer(trimmedFields.producer);

  let bytes: Uint8Array;

  try {
    bytes = await pdf.save();
  } catch {
    throw new Error("Failed to save the updated PDF metadata.");
  }

  return {
    bytes,
    fields: trimmedFields,
    processingTime: performance.now() - startTime,
  };
}
