import { describe, expect, it } from "vitest";
import {
  Stage2PromptError,
  buildStage1EvidencePrompt,
  buildStage2SummarizePrompt,
} from "./prompts";

/**
 * V6-E01 — Unit tests for the Stage-1 / Stage-2 instruction builders.
 * Pure string construction: no provider, no network, no store.
 */

describe("buildStage1EvidencePrompt", () => {
  it("embeds the chunk text and demands a bare JSON string array", () => {
    const prompt = buildStage1EvidencePrompt("rural literacy is just 61.11%");
    expect(prompt).toContain("rural literacy is just 61.11%");
    expect(prompt).toContain("JSON array of strings");
    expect(prompt.toLowerCase()).toContain("do not invent ids");
  });

  it("forbids classification, IDs, values, and commentary", () => {
    const prompt = buildStage1EvidencePrompt("some text").toLowerCase();
    expect(prompt).toContain("do not explain");
    expect(prompt).toContain("values");
  });

  it("rejects empty and non-string chunk text fail-loud", () => {
    expect(() => buildStage1EvidencePrompt("")).toThrow(Stage2PromptError);
    expect(() => buildStage1EvidencePrompt(null)).toThrow(Stage2PromptError);
    expect(() => buildStage1EvidencePrompt(42)).toThrow(Stage2PromptError);
  });

  it("requests multiple independently useful spans (V7-A10 RED3)", () => {
    const prompt = buildStage1EvidencePrompt("some text").toLowerCase();
    expect(prompt).toContain("at least 3 independently useful exact spans");
  });

  it("prefers distinct spans and keeps three spans non-mandatory", () => {
    const prompt = buildStage1EvidencePrompt("some text").toLowerCase();
    expect(prompt).toContain("prefer distinct spans over duplicate copies");
    expect(prompt).toContain("if fewer useful spans exist, return only those");
  });

  it("still requires exact verbatim reproduction alongside redundancy", () => {
    const prompt = buildStage1EvidencePrompt("some text").toLowerCase();
    expect(prompt).toContain("copied character-for-character");
    expect(prompt).toContain("with no rewording");
  });
});

describe("buildStage2SummarizePrompt", () => {
  function validInput() {
    return {
      evidence: [
        { evidenceId: "chunk-0-e0", exactText: "rural literacy is just 61.11%", kind: "number", value: "61.11%" },
        { evidenceId: "chunk-1-e0", exactText: "survey covered 6 districts", kind: "span" },
      ],
      task: "summarize",
    };
  }

  it("serializes the evidence pool and states the claim contract", () => {
    const prompt = buildStage2SummarizePrompt(validInput());
    expect(prompt).toContain("chunk-0-e0");
    expect(prompt).toContain("rural literacy is just 61.11%");
    expect(prompt).toContain("evidenceIds");
    expect(prompt).toContain("Task: summarize");
  });

  it("exposes only allowed evidence fields (no provenance, no raw chunks)", () => {
    const prompt = buildStage2SummarizePrompt({
      evidence: [
        {
          evidenceId: "chunk-0-e0",
          exactText: "span",
          kind: "span",
          sourcePages: [1],
          chunkIndex: 0,
        },
      ],
      task: "summarize",
    });
    expect(prompt).not.toContain("sourcePages");
    expect(prompt).not.toContain("chunkIndex");
  });

  it("forbids excerpts, invented IDs, and comparison/attribution/causal work", () => {
    const prompt = buildStage2SummarizePrompt(validInput()).toLowerCase();
    expect(prompt).toContain("never invent an");
    expect(prompt).toContain("never emit source excerpts");
    expect(prompt).toContain("comparison");
    expect(prompt).toContain("attribution");
    expect(prompt).toContain("causal");
  });

  it("rejects malformed input fail-loud", () => {
    expect(() => buildStage2SummarizePrompt(null)).toThrow(Stage2PromptError);
    expect(() => buildStage2SummarizePrompt({ evidence: [], task: "summarize" })).toThrow(
      Stage2PromptError,
    );
    expect(() =>
      buildStage2SummarizePrompt({ evidence: validInput().evidence, task: "translate" }),
    ).toThrow(Stage2PromptError);
  });
});
