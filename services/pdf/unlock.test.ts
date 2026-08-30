import { describe, expect, it } from "vitest";
import { PDFDocument as EncryptablePDFDocument } from "@cantoo/pdf-lib";
import { unlockPDF } from "./unlock";
import {
  buildEncryptedPdfBytes,
  buildTextVectorPdfBytes,
  ENCRYPTED_FIXTURE_PASSWORD,
  toFile,
} from "./__fixtures__/pdf";

/**
 * SEC-04 — Unlock PDF service coverage.
 *
 * Exercises the real `@cantoo/pdf-lib` load/decrypt path (no mocking),
 * matching the fixture-based approach already used by compress.test.ts
 * for the same encrypted-PDF detection mechanism. Covers the four
 * user-facing outcomes the SEC-04 audit inspected: correct password,
 * wrong password, an already-unprotected source, and an empty password.
 */
describe("unlockPDF", () => {
  it("removes password protection given the correct password", async () => {
    const encryptedBytes = await buildEncryptedPdfBytes();
    const file = toFile(encryptedBytes, "protected.pdf");

    const result = await unlockPDF(file, ENCRYPTED_FIXTURE_PASSWORD);

    expect(result.bytes.length).toBeGreaterThan(0);
    expect(result.pageCount).toBe(1);

    // The output must open with NO password at all. `load()` without
    // `ignoreEncryption` throws EncryptedPDFError purely from its own
    // constructor guard whenever `isEncrypted` is true — that guard fires
    // before this line's own assertion ever runs, which is a false failure
    // for a test that wants to inspect `isEncrypted` rather than have the
    // library pre-empt it. Passing `ignoreEncryption: true` here disables
    // only that constructor throw; it does not affect how `isEncrypted` is
    // computed, so the assertion below is still the real, meaningful proof
    // that no password is required to open the output.
    const reopened = await EncryptablePDFDocument.load(result.bytes, {
      ignoreEncryption: true,
    });
    expect(reopened.isEncrypted).toBe(false);
    expect(reopened.getPageCount()).toBe(1);

    const openedWithoutPassword = await EncryptablePDFDocument.load(
      result.bytes,
    );
    expect(openedWithoutPassword.getPageCount()).toBe(1);
  });

  it("rejects an incorrect password with the existing error message", async () => {
    const encryptedBytes = await buildEncryptedPdfBytes();
    const file = toFile(encryptedBytes, "protected.pdf");

    await expect(unlockPDF(file, "definitely-wrong")).rejects.toThrow(
      "Incorrect password. Please try again.",
    );
  });

  it("rejects a PDF that was never password-protected", async () => {
    const plainBytes = await buildTextVectorPdfBytes(1);
    const file = toFile(plainBytes, "never-protected.pdf");

    await expect(unlockPDF(file, "anything")).rejects.toThrow(
      '"never-protected.pdf" is not password protected.',
    );
  });

  it("rejects an empty password with the existing validation error", async () => {
    const encryptedBytes = await buildEncryptedPdfBytes();
    const file = toFile(encryptedBytes, "protected.pdf");

    await expect(unlockPDF(file, "")).rejects.toThrow(
      "Password is required.",
    );
  });
});
