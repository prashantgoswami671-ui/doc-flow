import { describe, expect, it } from "vitest";
import { PDFDocument as EncryptablePDFDocument } from "@cantoo/pdf-lib";
import { protectPDF } from "./protect";
import {
  buildEncryptedPdfBytes,
  buildTextVectorPdfBytes,
  ENCRYPTED_FIXTURE_PASSWORD,
  toFile,
} from "./__fixtures__/pdf";

/**
 * SEC-04 — Protect PDF service coverage.
 *
 * Exercises the real `@cantoo/pdf-lib` encrypt/load path (no mocking) so
 * these tests actually verify the security-relevant behavior the SEC-04
 * audit inspected by direct code read: that protectPDF() produces a
 * genuinely password-protected PDF, that an empty password is rejected,
 * and that an already-protected source PDF is rejected with the intended
 * message rather than silently re-encrypted.
 */
describe("protectPDF", () => {
  it("produces a PDF that requires the chosen password to open", async () => {
    const sourceBytes = await buildTextVectorPdfBytes(2);
    const file = toFile(sourceBytes, "report.pdf");

    const result = await protectPDF(file, "correct horse battery staple");

    expect(result.bytes.length).toBeGreaterThan(0);
    expect(result.pageCount).toBe(2);

    // Confirm the output is actually encrypted (not just returned as-is).
    const probe = await EncryptablePDFDocument.load(result.bytes, {
      ignoreEncryption: true,
    });
    expect(probe.isEncrypted).toBe(true);

    // Confirm the chosen password genuinely opens it.
    const opened = await EncryptablePDFDocument.load(result.bytes, {
      password: "correct horse battery staple",
    });
    expect(opened.getPageCount()).toBe(2);

    // Confirm a wrong password does not open it.
    await expect(
      EncryptablePDFDocument.load(result.bytes, { password: "wrong" }),
    ).rejects.toThrow();
  });

  it("rejects an empty password with the existing validation error", async () => {
    const sourceBytes = await buildTextVectorPdfBytes(1);
    const file = toFile(sourceBytes, "report.pdf");

    await expect(protectPDF(file, "")).rejects.toThrow(
      "Password is required.",
    );
  });

  it("rejects an already password-protected source PDF", async () => {
    const encryptedBytes = await buildEncryptedPdfBytes();
    const file = toFile(encryptedBytes, "already-protected.pdf");

    await expect(
      protectPDF(file, ENCRYPTED_FIXTURE_PASSWORD),
    ).rejects.toThrow(
      '"already-protected.pdf" is already password protected. Use Unlock PDF first if you want to change its password.',
    );
  });
});
