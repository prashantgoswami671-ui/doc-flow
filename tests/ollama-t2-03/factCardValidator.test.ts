/**
 * T2-03 Fact Card PoC — deterministic validator unit tests (fast, offline).
 *
 * Always run (no Ollama, no env gate). Every validator rejection rule has
 * at least one case here.
 */

import { describe, expect, it } from "vitest";
import { validateFactCard } from "./factCardValidator";
import type { FactCard } from "./factCardSchema";

const CHUNK = {
  chunkIndex: 2,
  pageNumber: 3,
  text: "Economic growth means a rise in GSDP while economic development covers literacy and health. West Bengal urban literacy was 84.78% because government infrastructure spending rose, while rural literacy was 72.13%. Jharkhand urban literacy reached 82.26% and rural literacy only 61.11%.",
};

function validCard(): FactCard {
  return {
    cardId: "chunk-2",
    chunkIndex: 2,
    sourcePages: [3],
    excerpts: [
      "Economic growth means a rise in GSDP while economic development covers literacy and health.",
      "West Bengal urban literacy was 84.78% because government infrastructure spending rose, while rural literacy was 72.13%.",
    ],
    definitions: [
      {
        term: "economic growth",
        definition: "a rise in GSDP",
        excerpt:
          "Economic growth means a rise in GSDP while economic development covers literacy and health.",
      },
    ],
    numbers: [
      {
        value: "84.78%",
        unit: "%",
        excerpt:
          "West Bengal urban literacy was 84.78% because government infrastructure spending rose, while rural literacy was 72.13%.",
      },
    ],
    claims: [
      {
        kind: "comparison",
        text: "WB urban literacy exceeds WB rural literacy.",
        excerpt:
          "West Bengal urban literacy was 84.78% because government infrastructure spending rose, while rural literacy was 72.13%.",
        excerpt2: "West Bengal urban literacy was 84.78%",
        pages: [3],
        causal: false,
      },
    ],
  };
}

describe("validateFactCard", () => {
  it("accepts a fully grounded card", () => {
    expect(validateFactCard(validCard(), CHUNK, 6)).toEqual({ ok: true, reasons: [] });
  });

  it("rejects a non-object card (malformed structure)", () => {
    const result = validateFactCard("not-a-card", CHUNK, 6);
    expect(result.ok).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("rejects a card with a wrong cardId/chunkIndex mapping", () => {
    const card = { ...validCard(), cardId: "chunk-9", chunkIndex: 9 };
    const result = validateFactCard(card, CHUNK, 6);
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes("cardId"))).toBe(true);
  });

  it("rejects out-of-range sourcePages", () => {
    const card = { ...validCard(), sourcePages: [99] };
    const result = validateFactCard(card, CHUNK, 6);
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes("sourcePages"))).toBe(true);
  });

  it("rejects sourcePages missing the chunk page", () => {
    const card = { ...validCard(), sourcePages: [1] };
    const result = validateFactCard(card, CHUNK, 6);
    expect(result.ok).toBe(false);
  });

  it("rejects excerpts not present in the source chunk", () => {
    const card = { ...validCard(), excerpts: ["This sentence was never in the source document at all."] };
    const result = validateFactCard(card, CHUNK, 6);
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes("excerpts[0]"))).toBe(true);
  });

  it("rejects short excerpts below the minimum length", () => {
    const card = { ...validCard(), excerpts: ["too short"] };
    expect(validateFactCard(card, CHUNK, 6).ok).toBe(false);
  });

  it("rejects numbers whose value is absent from their excerpt", () => {
    const card = {
      ...validCard(),
      numbers: [
        {
          value: "99.99%",
          unit: "%",
          excerpt:
            "West Bengal urban literacy was 84.78% because government infrastructure spending rose, while rural literacy was 72.13%.",
        },
      ],
    };
    const result = validateFactCard(card, CHUNK, 6);
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes("numbers[0].value"))).toBe(true);
  });

  it("rejects number excerpts not present in the source chunk", () => {
    const card = {
      ...validCard(),
      numbers: [{ value: "10.5%", unit: "%", excerpt: "Fabricated evidence invented by the model here." }],
    };
    expect(validateFactCard(card, CHUNK, 6).ok).toBe(false);
  });

  it("rejects claims without source evidence", () => {
    const card = {
      ...validCard(),
      claims: [
        {
          kind: "fact",
          text: "Something unsupported.",
          excerpt: "Completely invented supporting text not in source.",
          pages: [3],
          causal: false,
        },
      ],
    };
    const result = validateFactCard(card, CHUNK, 6);
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes("claims[0].excerpt"))).toBe(true);
  });

  it("rejects comparisons with only one excerpt", () => {
    const card = {
      ...validCard(),
      claims: [
        {
          kind: "comparison",
          text: "Urban exceeds rural.",
          excerpt:
            "West Bengal urban literacy was 84.78% because government infrastructure spending rose, while rural literacy was 72.13%.",
          pages: [3],
          causal: false,
        },
      ],
    };
    const result = validateFactCard(card, CHUNK, 6);
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes("excerpt2"))).toBe(true);
  });

  it("rejects comparisons whose excerpt2 duplicates excerpt", () => {
    const sameEvidence =
      "West Bengal urban literacy was 84.78% because government infrastructure spending rose, while rural literacy was 72.13%.";
    const card = {
      ...validCard(),
      claims: [
        {
          kind: "comparison",
          text: "Urban exceeds rural.",
          excerpt: sameEvidence,
          excerpt2: sameEvidence,
          pages: [3],
          causal: false,
        },
      ],
    };
    const result = validateFactCard(card, CHUNK, 6);
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes("distinct source evidence"))).toBe(true);
  });

  it("rejects kind definition on claims (definitions belong in definitions[])", () => {
    const card = {
      ...validCard(),
      claims: [
        {
          kind: "definition",
          text: "Growth means GSDP rise.",
          excerpt:
            "Economic growth means a rise in GSDP while economic development covers literacy and health.",
          pages: [3],
          causal: false,
        },
      ],
    };
    const result = validateFactCard(card, CHUNK, 6);
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes("claims[0].kind"))).toBe(true);
  });

  it("rejects causal:true without causalExcerpt", () => {
    const card = {
      ...validCard(),
      claims: [
        {
          kind: "fact",
          text: "Spending caused literacy gains.",
          excerpt:
            "West Bengal urban literacy was 84.78% because government infrastructure spending rose, while rural literacy was 72.13%.",
          pages: [3],
          causal: true,
        },
      ],
    };
    const result = validateFactCard(card, CHUNK, 6);
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes("causalExcerpt"))).toBe(true);
  });

  it("rejects causal:true when the causal phrase is not inside the excerpt", () => {
    const card = {
      ...validCard(),
      claims: [
        {
          kind: "fact",
          text: "Spending caused literacy gains.",
          excerpt:
            "West Bengal urban literacy was 84.78% because government infrastructure spending rose, while rural literacy was 72.13%.",
          pages: [3],
          causal: true,
          causalExcerpt: "entirely unrelated phrase due to nothing",
        },
      ],
    };
    expect(validateFactCard(card, CHUNK, 6).ok).toBe(false);
  });

  it("rejects causal:true with a non-connective causalExcerpt (flagged for human review)", () => {
    const card = {
      ...validCard(),
      claims: [
        {
          kind: "fact",
          text: "Spending correlated with literacy.",
          excerpt:
            "West Bengal urban literacy was 84.78% because government infrastructure spending rose, while rural literacy was 72.13%.",
          pages: [3],
          causal: true,
          causalExcerpt: "government infrastructure spending rose",
        },
      ],
    };
    const result = validateFactCard(card, CHUNK, 6);
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes("connective"))).toBe(true);
  });

  it("accepts causal:true with an explicit connective quoted verbatim", () => {
    const card = {
      ...validCard(),
      claims: [
        {
          kind: "fact",
          text: "The source attributes the gain to spending.",
          excerpt:
            "West Bengal urban literacy was 84.78% because government infrastructure spending rose, while rural literacy was 72.13%.",
          pages: [3],
          causal: true,
          causalExcerpt: "because government infrastructure spending rose",
        },
      ],
    };
    expect(validateFactCard(card, CHUNK, 6).ok).toBe(true);
  });

  it("rejects claim pages outside the card sourcePages", () => {
    const card = {
      ...validCard(),
      claims: [
        {
          kind: "fact",
          text: "A fact.",
          excerpt:
            "Economic growth means a rise in GSDP while economic development covers literacy and health.",
          pages: [5],
          causal: false,
        },
      ],
    };
    expect(validateFactCard(card, CHUNK, 6).ok).toBe(false);
  });

  it("extractFirstJsonObject tolerates think-preamble and fences", async () => {
    const { extractFirstJsonObject } = await import("./factCardClient");
    const raw = '<think>reasoning here</think>\n```json\n{"a": 1}\n```\ntrailing';
    expect(extractFirstJsonObject(raw)).toBe('{"a": 1}');
  });
});
