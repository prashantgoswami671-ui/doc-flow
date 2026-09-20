import { describe, expect, it } from "vitest";
import { Stage2CapabilityError, resolveStage2Capability } from "./capability";

/**
 * V6-C04 — Unit tests for the explicit unresolved-capability policy.
 *
 * Pure, dependency-free: no provider, no network, no PDF fixtures,
 * no model output, no UI, no orchestration. Verifies the capability
 * boundary only — never the claim contract (C02) or projection (C03).
 */

describe("SUPPORTED", () => {
  it("1. summarize resolves supported", () => {
    expect(resolveStage2Capability("summarize")).toEqual({
      status: "supported",
      task: "summarize",
      reason: "supported-summarize",
    });
    expect(resolveStage2Capability({ action: "summarize" })).toEqual({
      status: "supported",
      task: "summarize",
      reason: "supported-summarize",
    });
  });

  it("2. supported result is deterministic and frozen", () => {
    const first = resolveStage2Capability({ action: "summarize", task: "summarize" });
    const second = resolveStage2Capability("summarize");
    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
  });
});

describe("UNSUPPORTED", () => {
  it("3. translation is unsupported", () => {
    expect(resolveStage2Capability("translate")).toEqual({
      status: "unsupported",
      reason: "unsupported-translation",
    });
    expect(resolveStage2Capability({ action: "translate" }).status).toBe("unsupported");
  });

  it("4. key-points is unsupported", () => {
    expect(resolveStage2Capability("keyPoints")).toEqual({
      status: "unsupported",
      reason: "unsupported-key-points",
    });
  });

  it("5. Q&A is unsupported", () => {
    expect(resolveStage2Capability("ask")).toEqual({
      status: "unsupported",
      reason: "unsupported-qa",
    });
    expect(resolveStage2Capability({ action: "ask" }).status).toBe("unsupported");
  });

  it("6. comparison is unsupported", () => {
    expect(resolveStage2Capability("comparison")).toEqual({
      status: "unsupported",
      reason: "unsupported-comparison",
    });
    expect(
      resolveStage2Capability({ action: "summarize", comparison: true }).reason,
    ).toBe("unsupported-comparison");
  });

  it("7. attribution is unsupported", () => {
    expect(resolveStage2Capability("attribution")).toEqual({
      status: "unsupported",
      reason: "unsupported-attribution",
    });
    expect(
      resolveStage2Capability({ action: "summarize", attribution: true }).reason,
    ).toBe("unsupported-attribution");
  });

  it("8. causal is unsupported", () => {
    expect(resolveStage2Capability("causal")).toEqual({
      status: "unsupported",
      reason: "unsupported-causal",
    });
    expect(resolveStage2Capability({ action: "summarize", causal: true }).reason).toBe(
      "unsupported-causal",
    );
  });

  it("9. multi-document is unsupported", () => {
    expect(resolveStage2Capability({ action: "summarize", multiDocument: true })).toEqual({
      status: "unsupported",
      reason: "unsupported-multi-document",
    });
    expect(
      resolveStage2Capability({ action: "summarize", documentCount: 2 }).reason,
    ).toBe("unsupported-multi-document");
    expect(
      resolveStage2Capability({ action: "summarize", documentIds: ["a", "b"] }).reason,
    ).toBe("unsupported-multi-document");
  });

  it("10. unknown task is unsupported, never supported", () => {
    const decision = resolveStage2Capability("rewrite");
    expect(decision.status).toBe("unsupported");
    expect(decision.reason).toBe("unsupported-task");
  });
});

describe("NO DOWNGRADE", () => {
  it("11. translation never becomes summarize", () => {
    const decision = resolveStage2Capability({ action: "translate" });
    expect(decision.status).toBe("unsupported");
    expect(decision).not.toHaveProperty("task", "summarize");
  });

  it("12. Q&A never becomes summarize", () => {
    const decision = resolveStage2Capability({ action: "ask" });
    expect(decision.status).toBe("unsupported");
    expect(decision).not.toHaveProperty("task", "summarize");
  });

  it("13. comparison never becomes fact", () => {
    const decision = resolveStage2Capability({ action: "comparison" });
    expect(decision).toEqual({ status: "unsupported", reason: "unsupported-comparison" });
  });

  it("14. attribution never becomes conclusion", () => {
    const decision = resolveStage2Capability({ action: "attribution" });
    expect(decision).toEqual({ status: "unsupported", reason: "unsupported-attribution" });
  });

  it("15. causal never becomes conclusion", () => {
    const decision = resolveStage2Capability({ action: "causal" });
    expect(decision).toEqual({ status: "unsupported", reason: "unsupported-causal" });
  });

  it("16. key-points never becomes summarize", () => {
    const decision = resolveStage2Capability({ action: "keyPoints" });
    expect(decision.status).toBe("unsupported");
    expect(decision).not.toHaveProperty("task", "summarize");
  });
});

describe("FAIL-CLOSED input validation", () => {
  it("17. null throws", () => {
    expect(() => resolveStage2Capability(null)).toThrow(Stage2CapabilityError);
  });

  it("18. undefined throws", () => {
    expect(() => resolveStage2Capability(undefined)).toThrow(Stage2CapabilityError);
  });

  it("19. non-string primitives throw", () => {
    for (const primitive of [42, true]) {
      expect(() => resolveStage2Capability(primitive)).toThrow(Stage2CapabilityError);
    }
  });

  it("20. malformed object (array) throws", () => {
    expect(() => resolveStage2Capability(["summarize"])).toThrow(Stage2CapabilityError);
  });

  it("21. missing task/action throws", () => {
    expect(() => resolveStage2Capability({})).toThrow(Stage2CapabilityError);
  });

  it("22. arbitrary unknown task resolves unsupported-task, never summarize", () => {
    const decision = resolveStage2Capability({ action: "summarize-ish" });
    expect(decision).toEqual({ status: "unsupported", reason: "unsupported-task" });
  });

  it("23. conflicting task fields throw", () => {
    expect(() =>
      resolveStage2Capability({ action: "summarize", task: "translate" }),
    ).toThrow(Stage2CapabilityError);
  });

  it("24. whitespace/case mutation does not normalize to summarize", () => {
    for (const mutated of [" summarize", "summarize ", "Summarize", "SUMMARIZE"]) {
      const decision = resolveStage2Capability(mutated);
      expect(decision.status).toBe("unsupported");
      expect(decision).not.toHaveProperty("task", "summarize");
    }
  });

  it("non-string action type throws", () => {
    expect(() => resolveStage2Capability({ action: 42 })).toThrow(Stage2CapabilityError);
  });
});

describe("SECURITY boundary", () => {
  it.each([
    ["25. File-like", { action: "summarize", file: { name: "x.pdf" } }],
    ["26. Blob-like", { action: "summarize", blob: { size: 1 } }],
    ["27. ArrayBuffer-like", { action: "summarize", arrayBuffer: [0] }],
    ["28. metadata-like", { action: "summarize", metadata: { a: 1 } }],
    ["29. provider/runtime-like", { action: "summarize", provider: { id: "ollama" } }],
  ])("%s object is rejected, never propagated", (_label, request) => {
    expect(() => resolveStage2Capability(request)).toThrow(Stage2CapabilityError);
  });
});

describe("DETERMINISM", () => {
  it("30. same supported input gives identical result", () => {
    const first = JSON.stringify(resolveStage2Capability({ action: "summarize" }));
    const second = JSON.stringify(resolveStage2Capability({ action: "summarize" }));
    expect(first).toBe(second);
  });

  it("31. same unsupported input gives identical reason", () => {
    const first = resolveStage2Capability({ action: "translate" });
    const second = resolveStage2Capability("translate");
    expect(first).toEqual(second);
    expect(first.reason).toBe("unsupported-translation");
  });
});
