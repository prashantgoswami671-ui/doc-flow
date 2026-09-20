import { describe, expect, it, vi, afterEach } from "vitest";
import { createOllamaClient } from "./client";
import { OllamaRuntime } from "./runtime";
import { OLLAMA_BASE_URL, OLLAMA_MODEL } from "./types";
import {
  OllamaStructuredError,
  STAGE1_SPANS_SCHEMA,
  STAGE2_CLAIMS_SCHEMA,
  generateStage1SpansText,
  generateStage2ClaimsText,
} from "./structured";
import { EvidenceStore } from "../evidence/store";
import type { AiContextChunk } from "../types";

/**
 * V6-F02 — Unit tests for the validated Ollama structured transport.
 * Injected `fetchImpl` throughout: no live Ollama, no network.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function captureClient() {
  const bodies: unknown[] = [];
  const urls: string[] = [];
  const fetchImpl = (async (url: unknown, init?: { body?: unknown }) => {
    urls.push(String(url));
    bodies.push(JSON.parse(String((init?.body ?? "{}") as string)));
    return {
      ok: true,
      json: () =>
        Promise.resolve({ model: OLLAMA_MODEL, created_at: "t", response: "[]", done: true }),
    };
  }) as unknown as typeof fetch;
  const runtime = new OllamaRuntime({ clientFactory: () => createOllamaClient({ fetchImpl }) });
  return { runtime, bodies, urls };
}

function makeChunk(text: string): AiContextChunk {
  return { chunkIndex: 0, pageNumber: 1, text, startOffset: 0, endOffset: text.length };
}

describe("STAGE-1 transport", () => {
  it("1. request includes think:false", async () => {
    const { runtime, bodies } = captureClient();
    await generateStage1SpansText(runtime, "prompt", 1024);
    expect((bodies[0] as Record<string, unknown>)["think"]).toBe(false);
  });

  it("2. request includes the exact string-array JSON Schema", async () => {
    const { runtime, bodies } = captureClient();
    await generateStage1SpansText(runtime, "prompt", 1024);
    expect((bodies[0] as Record<string, unknown>)["format"]).toEqual({
      type: "array",
      items: { type: "string" },
    });
    expect(STAGE1_SPANS_SCHEMA).toEqual({ type: "array", items: { type: "string" } });
  });

  it("3. request keeps temperature 0", async () => {
    const { runtime, bodies } = captureClient();
    await generateStage1SpansText(runtime, "prompt", 1024);
    const options = (bodies[0] as Record<string, Record<string, unknown>>)["options"];
    expect(options["temperature"]).toBe(0);
    expect(options["num_predict"]).toBe(1024);
  });

  it("4-5. request preserves model and loopback endpoint", async () => {
    const { runtime, bodies, urls } = captureClient();
    await generateStage1SpansText(runtime, "prompt", 1024);
    expect((bodies[0] as Record<string, unknown>)["model"]).toBe(OLLAMA_MODEL);
    expect(urls).toHaveLength(1);
    expect(urls[0]?.startsWith(OLLAMA_BASE_URL)).toBe(true);
  });

  it("6. request contains no File/PDF bytes", async () => {
    const { runtime, bodies } = captureClient();
    await generateStage1SpansText(runtime, "prompt", 1024);
    const serialized = JSON.stringify(bodies[0]);
    expect(serialized).not.toContain("JVBER");
    expect(Object.keys(bodies[0] as Record<string, unknown>).sort()).toEqual(
      ["format", "model", "options", "prompt", "stream", "think"].sort(),
    );
  });

  it("7. schema-shaped candidates still enter B03 unchanged", async () => {
    const chunkText = "rural literacy is just 61.11% against 82.26% in urban areas";
    const store = EvidenceStore.create({ chunks: [makeChunk(chunkText)], sourcePageCount: 1 });
    const { admitted, failures } = store.admit(0, ["rural literacy is just 61.11%", "82.26%"]);
    expect(admitted).toHaveLength(2);
    expect(failures).toEqual([]);
    expect(admitted[0]?.kind).toBe("number");
  });

  it("rejects non-Ollama runtimes and malformed input fail-loud", async () => {
    await expect(generateStage1SpansText({}, "prompt", 1024)).rejects.toBeInstanceOf(
      OllamaStructuredError,
    );
    const { runtime } = captureClient();
    await expect(generateStage1SpansText(runtime, "", 1024)).rejects.toBeInstanceOf(
      OllamaStructuredError,
    );
    await expect(generateStage1SpansText(runtime, "prompt", 0)).rejects.toBeInstanceOf(
      OllamaStructuredError,
    );
  });
});

describe("STAGE-2 transport", () => {
  it("8. request includes think:false", async () => {
    const { runtime, bodies } = captureClient();
    await generateStage2ClaimsText(runtime, "prompt", 2048);
    expect((bodies[0] as Record<string, unknown>)["think"]).toBe(false);
  });

  it("9. request includes the exact Stage2Claim[] JSON Schema", async () => {
    const { runtime, bodies } = captureClient();
    await generateStage2ClaimsText(runtime, "prompt", 2048);
    expect((bodies[0] as Record<string, unknown>)["format"]).toEqual({
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["fact", "conclusion"] },
          text: { type: "string" },
          evidenceIds: { type: "array", items: { type: "string" } },
        },
        required: ["kind", "text", "evidenceIds"],
        additionalProperties: false,
      },
    });
  });

  it("10. schema has additionalProperties:false", () => {
    const items = STAGE2_CLAIMS_SCHEMA.items as unknown as Record<string, unknown>;
    expect(items["additionalProperties"]).toBe(false);
  });

  it("11. kind enum is exactly fact/conclusion", () => {
    const items = STAGE2_CLAIMS_SCHEMA.items as unknown as {
      properties: { kind: { enum: string[] } };
    };
    expect(items.properties.kind.enum).toEqual(["fact", "conclusion"]);
  });

  it("12-13. text is string and evidenceIds is a string array", () => {
    const items = STAGE2_CLAIMS_SCHEMA.items as unknown as {
      properties: Record<string, unknown>;
    };
    expect(items.properties["text"]).toEqual({ type: "string" });
    expect(items.properties["evidenceIds"]).toEqual({
      type: "array",
      items: { type: "string" },
    });
  });

  it("14. required fields are enforced", () => {
    const items = STAGE2_CLAIMS_SCHEMA.items as unknown as { required: string[] };
    expect(items.required).toEqual(["kind", "text", "evidenceIds"]);
  });

  it("15. no forbidden claim fields appear anywhere in the schema", () => {
    const serialized = JSON.stringify(STAGE2_CLAIMS_SCHEMA);
    for (const forbidden of [
      "excerpt",
      "exactText",
      "pages",
      "sourcePages",
      "chunkIndex",
      "evidenceId\"",
      "value",
      "unit",
      "causal",
      "comparison",
      "attribution",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("never uses bare json mode", async () => {
    const { runtime, bodies } = captureClient();
    await generateStage2ClaimsText(runtime, "prompt", 2048);
    expect((bodies[0] as Record<string, unknown>)["format"]).not.toBe("json");
    expect(typeof (bodies[0] as Record<string, unknown>)["format"]).toBe("object");
  });
});
