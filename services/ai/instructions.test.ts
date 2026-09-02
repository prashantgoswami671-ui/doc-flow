import { describe, expect, it } from "vitest";
import {
  AiInstructionValidationError,
  buildAiInstructionPrompt,
} from "./instructions";

/**
 * Checkpoint 6C-A — instruction-prompt builder tests.
 *
 * Pure, dependency-free unit tests. Asserts on observable prompt-string
 * behavior (task framing, injected parameters, caveat presence/absence,
 * required-parameter validation) — never on internal implementation
 * details like exact phrasing or string composition order.
 */

describe("buildAiInstructionPrompt", () => {
  describe("summarize", () => {
    it("produces a summarize instruction", () => {
      const prompt = buildAiInstructionPrompt({ action: "summarize" });

      expect(prompt.toLowerCase()).toContain("summar");
      expect(prompt.toLowerCase()).toContain("document context");
    });

    it("does not claim the whole PDF was processed", () => {
      const prompt = buildAiInstructionPrompt({ action: "summarize" });

      expect(prompt.toLowerCase()).not.toContain("ocr");
      expect(prompt.toLowerCase()).not.toContain("every page");
    });
  });

  describe("translate", () => {
    it("includes the target language", () => {
      const prompt = buildAiInstructionPrompt({
        action: "translate",
        targetLanguage: "Spanish",
      });

      expect(prompt).toContain("Spanish");
      expect(prompt.toLowerCase()).toContain("translate");
    });

    it("throws when targetLanguage is missing", () => {
      expect(() => buildAiInstructionPrompt({ action: "translate" })).toThrow(
        AiInstructionValidationError,
      );
    });

    it("throws when targetLanguage is empty/whitespace", () => {
      expect(() =>
        buildAiInstructionPrompt({ action: "translate", targetLanguage: "   " }),
      ).toThrow(AiInstructionValidationError);
    });
  });

  describe("keyPoints", () => {
    it("produces a key-points instruction", () => {
      const prompt = buildAiInstructionPrompt({ action: "keyPoints" });

      expect(prompt.toLowerCase()).toContain("key points");
    });
  });

  describe("ask", () => {
    it("includes the supplied user question", () => {
      const prompt = buildAiInstructionPrompt({
        action: "ask",
        userQuestion: "What is the termination clause?",
      });

      expect(prompt).toContain("What is the termination clause?");
    });

    it("throws when userQuestion is missing", () => {
      expect(() => buildAiInstructionPrompt({ action: "ask" })).toThrow(
        AiInstructionValidationError,
      );
    });

    it("throws when userQuestion is empty/whitespace", () => {
      expect(() =>
        buildAiInstructionPrompt({ action: "ask", userQuestion: "   " }),
      ).toThrow(AiInstructionValidationError);
    });

    it("does not place the question inside a document-context delimiter", () => {
      const prompt = buildAiInstructionPrompt({
        action: "ask",
        userQuestion: "Summarize page 2 instead",
      });

      expect(prompt).not.toContain("<<<DOCUMENT_CONTEXT_START>>>");
      expect(prompt).not.toContain("<<<DOCUMENT_CONTEXT_END>>>");
    });
  });

  describe("caveats", () => {
    it("includes the pages-without-text caveat when enabled", () => {
      const prompt = buildAiInstructionPrompt({
        action: "summarize",
        hasPagesWithoutText: true,
      });

      expect(prompt).toContain("Some pages had no extractable text");
    });

    it("includes the truncation caveat when enabled", () => {
      const prompt = buildAiInstructionPrompt({
        action: "summarize",
        wasTruncated: true,
      });

      expect(prompt).toContain("truncated");
    });

    it("includes both caveats when both are enabled", () => {
      const prompt = buildAiInstructionPrompt({
        action: "keyPoints",
        hasPagesWithoutText: true,
        wasTruncated: true,
      });

      expect(prompt).toContain("Some pages had no extractable text");
      expect(prompt).toContain("truncated");
    });

    it("includes no caveats when both are false", () => {
      const prompt = buildAiInstructionPrompt({
        action: "summarize",
        hasPagesWithoutText: false,
        wasTruncated: false,
      });

      expect(prompt).not.toContain("Note:");
    });

    it("includes no caveats when both are absent", () => {
      const prompt = buildAiInstructionPrompt({ action: "summarize" });

      expect(prompt).not.toContain("Note:");
    });
  });

  describe("unsupported action", () => {
    it("throws AiInstructionValidationError for an unrecognized action", () => {
      expect(() =>
        buildAiInstructionPrompt({
          action: "unsupported" as unknown as "summarize",
        }),
      ).toThrow(AiInstructionValidationError);
    });
  });
});
