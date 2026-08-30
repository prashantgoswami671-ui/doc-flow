import { describe, expect, it } from "vitest";
import {
  AiRequestValidationError,
  ProhibitedAiRequestFieldError,
  assertValidAiCapabilities,
  assertValidAiTextGenerationRequest,
  containsDisallowedBinaryPayload,
} from "./validation";

/**
 * AI-01 — Capability-based AI provider/runtime abstraction.
 *
 * Focused, dependency-free unit tests for the runtime validation half of
 * the AI-01 contract (see also services/ai/types.ts for the compile-time
 * half). No network, no DOM, no provider implementation is exercised.
 */

function validRequest() {
  return {
    prompt: "Summarize this document.",
    contextChunks: [
      {
        chunkIndex: 0,
        pageNumber: 1,
        text: "Some extracted text.",
        startOffset: 0,
        endOffset: 21,
      },
    ],
    settings: { temperature: 0.2, maxOutputTokens: 500 },
  };
}

function validCapabilities() {
  return {
    providerId: "browser-ai",
    displayName: "Browser AI",
    runtime: "browser",
    isLocal: true,
    requiresConsent: false,
    supportsStreaming: false,
    supportsToolCalling: false,
    supportsTextGeneration: true,
    maxContextCharacters: 8000,
    maxOutputCharacters: 2000,
  };
}

describe("assertValidAiTextGenerationRequest", () => {
  it("accepts a valid text-only request (prompt only, no context)", () => {
    expect(() => assertValidAiTextGenerationRequest({ prompt: "Hello" })).not.toThrow();
  });

  it("accepts a valid request with context chunks and settings", () => {
    expect(() => assertValidAiTextGenerationRequest(validRequest())).not.toThrow();
  });

  it("rejects a missing/empty prompt", () => {
    expect(() => assertValidAiTextGenerationRequest({})).toThrow(AiRequestValidationError);
    expect(() => assertValidAiTextGenerationRequest({ prompt: "   " })).toThrow(
      AiRequestValidationError,
    );
  });

  it.each(PROHIBITED_FIELD_CASES())(
    "rejects a request carrying prohibited field %s",
    (field, value) => {
      const request = { ...validRequest(), [field]: value };

      expect(() => assertValidAiTextGenerationRequest(request)).toThrow(
        ProhibitedAiRequestFieldError,
      );
    },
  );

  it("rejects a File masquerading under an unrelated key name", () => {
    const request = {
      prompt: "Summarize",
      notAKnownKey: new File(["pdf bytes"], "doc.pdf"),
    };

    expect(() => assertValidAiTextGenerationRequest(request)).toThrow(
      AiRequestValidationError,
    );
  });

  it("rejects a raw ArrayBuffer nested inside contextChunks", () => {
    const request = {
      prompt: "Summarize",
      contextChunks: [
        {
          chunkIndex: 0,
          pageNumber: 1,
          text: "hi",
          startOffset: 0,
          endOffset: 2,
          sneaky: new ArrayBuffer(4),
        },
      ],
    };

    expect(() => assertValidAiTextGenerationRequest(request)).toThrow(
      AiRequestValidationError,
    );
  });

  it("rejects malformed context chunk shapes", () => {
    expect(() =>
      assertValidAiTextGenerationRequest({
        prompt: "x",
        contextChunks: [{ chunkIndex: -1, pageNumber: 1, text: "a", startOffset: 0, endOffset: 1 }],
      }),
    ).toThrow(AiRequestValidationError);

    expect(() =>
      assertValidAiTextGenerationRequest({
        prompt: "x",
        contextChunks: [{ chunkIndex: 0, pageNumber: 0, text: "a", startOffset: 0, endOffset: 1 }],
      }),
    ).toThrow(AiRequestValidationError);

    expect(() =>
      assertValidAiTextGenerationRequest({
        prompt: "x",
        contextChunks: [{ chunkIndex: 0, pageNumber: 1, text: 5, startOffset: 0, endOffset: 1 }],
      }),
    ).toThrow(AiRequestValidationError);

    expect(() =>
      assertValidAiTextGenerationRequest({
        prompt: "x",
        contextChunks: [{ chunkIndex: 0, pageNumber: 1, text: "a", startOffset: 5, endOffset: 1 }],
      }),
    ).toThrow(AiRequestValidationError);
  });

  it("rejects malformed settings", () => {
    expect(() =>
      assertValidAiTextGenerationRequest({ prompt: "x", settings: { temperature: "hot" } }),
    ).toThrow(AiRequestValidationError);

    expect(() =>
      assertValidAiTextGenerationRequest({ prompt: "x", settings: { maxOutputTokens: -1 } }),
    ).toThrow(AiRequestValidationError);
  });

  it("rejects non-object requests", () => {
    expect(() => assertValidAiTextGenerationRequest(null)).toThrow(AiRequestValidationError);
    expect(() => assertValidAiTextGenerationRequest("prompt string")).toThrow(
      AiRequestValidationError,
    );
    expect(() => assertValidAiTextGenerationRequest(undefined)).toThrow(
      AiRequestValidationError,
    );
  });
});

describe("containsDisallowedBinaryPayload", () => {
  it("returns false for plain text-only structures", () => {
    expect(containsDisallowedBinaryPayload(validRequest())).toBe(false);
  });

  it("detects a File, Blob, ArrayBuffer, and typed array at any depth", () => {
    expect(containsDisallowedBinaryPayload({ a: { b: new File(["x"], "f.pdf") } })).toBe(true);
    expect(containsDisallowedBinaryPayload({ a: [new Blob(["x"])] })).toBe(true);
    expect(containsDisallowedBinaryPayload({ a: new ArrayBuffer(2) })).toBe(true);
    expect(containsDisallowedBinaryPayload({ a: new Uint8Array([1, 2, 3]) })).toBe(true);
  });

  it("does not infinitely recurse on a cyclic object", () => {
    const cyclic: Record<string, unknown> = { prompt: "hi" };
    cyclic.self = cyclic;

    expect(() => containsDisallowedBinaryPayload(cyclic)).not.toThrow();
    expect(containsDisallowedBinaryPayload(cyclic)).toBe(false);
  });
});

describe("assertValidAiCapabilities", () => {
  it("accepts valid capability metadata", () => {
    expect(() => assertValidAiCapabilities(validCapabilities())).not.toThrow();
  });

  it("rejects an invalid runtime kind", () => {
    expect(() =>
      assertValidAiCapabilities({ ...validCapabilities(), runtime: "quantum" }),
    ).toThrow(AiRequestValidationError);
  });

  it("rejects missing/empty providerId or displayName", () => {
    expect(() =>
      assertValidAiCapabilities({ ...validCapabilities(), providerId: "" }),
    ).toThrow(AiRequestValidationError);

    expect(() =>
      assertValidAiCapabilities({ ...validCapabilities(), displayName: undefined }),
    ).toThrow(AiRequestValidationError);
  });

  it("rejects non-boolean capability flags", () => {
    expect(() =>
      assertValidAiCapabilities({ ...validCapabilities(), isLocal: "yes" }),
    ).toThrow(AiRequestValidationError);
  });

  it("rejects non-positive context/output limits", () => {
    expect(() =>
      assertValidAiCapabilities({ ...validCapabilities(), maxContextCharacters: 0 }),
    ).toThrow(AiRequestValidationError);

    expect(() =>
      assertValidAiCapabilities({ ...validCapabilities(), maxOutputCharacters: -5 }),
    ).toThrow(AiRequestValidationError);
  });

  it("rejects malformed provider configuration wholesale", () => {
    expect(() => assertValidAiCapabilities(null)).toThrow(AiRequestValidationError);
    expect(() => assertValidAiCapabilities("browser-ai")).toThrow(AiRequestValidationError);
  });
});

function PROHIBITED_FIELD_CASES(): Array<[string, unknown]> {
  return [
    ["file", new File(["pdf bytes"], "doc.pdf")],
    ["blob", new Blob(["pdf bytes"])],
    ["fileBytes", new Uint8Array([1, 2, 3])],
    ["arrayBuffer", new ArrayBuffer(8)],
    ["password", "hunter2"],
    ["pageImage", "data:image/png;base64,abc"],
    ["thumbnail", "data:image/png;base64,abc"],
    ["metadata", { author: "someone" }],
  ];
}
