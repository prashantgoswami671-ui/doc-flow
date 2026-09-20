import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiRuntime } from "./types";
import { BrowserAiRuntime } from "./browser/browserAiRuntime";
import { OllamaRuntime } from "./ollama/runtime";

/**
 * Disposal is a provider-specific lifecycle concern (the generic
 * `AiRuntime` contract does not declare `dispose()`), so tests narrow
 * to the concrete Browser runtime exactly as `SummarizePdfCard` does.
 */
function disposeRuntime(runtime: AiRuntime): void {
  (runtime as BrowserAiRuntime).dispose();
}
import {
  AiRuntimeSelectionError,
  selectAiRuntime,
} from "./providerSelection";

/**
 * V6-D01 — Unit tests for the provider/runtime selection seam.
 *
 * Side-effect-light by construction: no Ollama import, no
 * `checkAvailability()` calls, no `fetch`, no document data. Tests
 * assert selection behavior, centralization, boundaries, capabilities,
 * lifecycle, and invalid input. Production UI is untouched
 * (approach A) — Summarize regression is covered by the existing
 * `SummarizePdfCard`, orchestration, and Browser runtime suites.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SELECTION", () => {
  it("1. automatic/default resolves Browser AI", () => {
    const selection = selectAiRuntime("automatic");
    expect(selection.runtime).toBeInstanceOf(BrowserAiRuntime);
    expect(selection.resolved).toBe("browser");
    disposeRuntime(selection.runtime);
  });

  it("2. explicit browser resolves Browser AI", () => {
    const selection = selectAiRuntime("browser");
    expect(selection.runtime).toBeInstanceOf(BrowserAiRuntime);
    expect(selection.preference).toBe("browser");
    disposeRuntime(selection.runtime);
  });

  it("3. selected runtime implements AiRuntime", () => {
    const selection = selectAiRuntime("automatic");
    expect(typeof selection.runtime.generateText).toBe("function");
    expect(typeof selection.runtime.checkAvailability).toBe("function");
    expect(selection.runtime.capabilities).toBeDefined();
    disposeRuntime(selection.runtime);
  });

  it("4. selected runtime exposes expected capabilities", () => {
    const selection = selectAiRuntime("browser");
    expect(selection.capabilities.runtime).toBe("browser");
    expect(selection.capabilities.supportsTextGeneration).toBe(true);
    expect(typeof selection.capabilities.providerId).toBe("string");
    expect(typeof selection.capabilities.displayName).toBe("string");
    disposeRuntime(selection.runtime);
  });

  it("5. selection result is deterministic", () => {
    const first = selectAiRuntime("automatic");
    const second = selectAiRuntime("automatic");
    expect(second.capabilities).toEqual(first.capabilities);
    expect(second.resolved).toBe(first.resolved);
    disposeRuntime(first.runtime);
    disposeRuntime(second.runtime);
  });
});

describe("CENTRALIZATION", () => {
  it("6. production selection creates BrowserAiRuntime through the selection layer", () => {
    const selection = selectAiRuntime("automatic");
    expect(selection.runtime).toBeInstanceOf(BrowserAiRuntime);
    disposeRuntime(selection.runtime);
  });

  it("7. selection exposes no provider-construction branching to callers", () => {
    // The selection result carries the runtime and its capabilities —
    // no tier/provider discriminator the caller must switch on.
    const selection = selectAiRuntime("browser");
    expect(Object.keys(selection).sort()).toEqual(
      ["capabilities", "preference", "resolved", "runtime"].sort(),
    );
    disposeRuntime(selection.runtime);
  });

  it("8. importing the module constructs nothing eagerly", () => {
    // Construction happens per selectAiRuntime() call (tests 19/21
    // prove distinct instances); import and construction perform no
    // fetch — network begins only at D02/D04 invocation.
    const fetchMock = vi.fn(() => Promise.reject(new Error("no network in tests")));
    vi.stubGlobal("fetch", fetchMock);
    const selection = selectAiRuntime("automatic");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(selection.runtime).toBeInstanceOf(BrowserAiRuntime);
    disposeRuntime(selection.runtime);
  });
});

describe("UNSUPPORTED/FUTURE", () => {
  it("9. internal ollama selection resolves the real Ollama runtime (V6-D04 service path only)", () => {
    // V6-D04 extension: "ollama" is selectable ONLY through the
    // internal production path (still gated by D02 + D03); it never
    // silently becomes Browser and is never the automatic default.
    const selection = selectAiRuntime("ollama");
    expect(selection.runtime).toBeInstanceOf(OllamaRuntime);
    expect(selection.runtime).not.toBeInstanceOf(BrowserAiRuntime);
    expect(selection.resolved).toBe("ollama");
    expect(selectAiRuntime("automatic").resolved).toBe("browser");
  });

  it("10. BYOK does not produce a fake runtime", () => {
    expect(() => selectAiRuntime("byok")).toThrowError(AiRuntimeSelectionError);
    try {
      selectAiRuntime("byok");
    } catch (error) {
      expect((error as AiRuntimeSelectionError).code).toBe("unsupported-runtime");
    }
  });

  it("11. Cloud does not produce a fake runtime", () => {
    expect(() => selectAiRuntime("cloud")).toThrowError(AiRuntimeSelectionError);
  });
});

describe("BOUNDARIES", () => {
  it("12. selection never calls Ollama checkAvailability", () => {
    // The Ollama module is not imported by the selection layer, so no
    // availability probe can occur; selection completes with fetch stubbed out.
    const fetchMock = vi.fn(() => Promise.reject(new Error("no network in tests")));
    vi.stubGlobal("fetch", fetchMock);
    disposeRuntime(selectAiRuntime("automatic").runtime);
    disposeRuntime(selectAiRuntime("browser").runtime);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("13. selection performs no network request", () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error("no network in tests")));
    vi.stubGlobal("fetch", fetchMock);
    const selection = selectAiRuntime("automatic");
    expect(fetchMock).not.toHaveBeenCalled();
    disposeRuntime(selection.runtime);
  });

  it("14. selection implements no consent logic", () => {
    // No consent fields, prompts, or state on the selection result —
    // only the runtime's own capability metadata for later D03 use.
    const selection = selectAiRuntime("automatic") as unknown as Record<string, unknown>;
    expect("consent" in selection).toBe(false);
    expect("requiresConsent" in selection).toBe(false);
    disposeRuntime(selection["runtime"] as AiRuntime);
  });

  it("15. selection neither inspects nor sends document data", () => {
    for (const docLike of [
      { file: { name: "x.pdf" } },
      { blob: { size: 1 } },
      { arrayBuffer: [0] },
      { preference: "browser", metadata: { a: 1 } },
    ]) {
      expect(() => selectAiRuntime(docLike)).toThrowError(AiRuntimeSelectionError);
    }
  });
});

describe("CAPABILITIES", () => {
  it("16. selected runtime exposes capabilities unchanged", () => {
    const selection = selectAiRuntime("browser");
    expect(selection.capabilities).toBe(selection.runtime.capabilities);
    disposeRuntime(selection.runtime);
  });

  it("17. requiresConsent comes from runtime capabilities", () => {
    const selection = selectAiRuntime("automatic");
    expect(selection.capabilities.requiresConsent).toBe(
      selection.runtime.capabilities.requiresConsent,
    );
    disposeRuntime(selection.runtime);
  });

  it("18. isLocal comes from runtime capabilities", () => {
    const selection = selectAiRuntime("automatic");
    expect(selection.capabilities.isLocal).toBe(selection.runtime.capabilities.isLocal);
    disposeRuntime(selection.runtime);
  });
});

describe("LIFECYCLE", () => {
  it("19. no global singleton runtime is shared", () => {
    const first = selectAiRuntime("automatic");
    const second = selectAiRuntime("automatic");
    expect(second.runtime).not.toBe(first.runtime);
    disposeRuntime(first.runtime);
    disposeRuntime(second.runtime);
  });

  it("20. caller can dispose the returned Browser runtime normally", () => {
    const selection = selectAiRuntime("browser");
    expect(() => disposeRuntime(selection.runtime)).not.toThrow();
  });

  it("21. two selections share no hidden mutable global state", () => {
    const first = selectAiRuntime("browser");
    const second = selectAiRuntime("browser");
    expect(second.runtime).not.toBe(first.runtime);
    expect(second.capabilities).toEqual(first.capabilities);
    disposeRuntime(first.runtime);
    disposeRuntime(second.runtime);
  });
});

describe("INVALID INPUT", () => {
  it("22. malformed preferences throw invalid-preference", () => {
    for (const bad of ["BROWSER", " browser", "browser ", "automatic ", ""]) {
      try {
        selectAiRuntime(bad);
        expect.unreachable(`preference ${JSON.stringify(bad)} must throw`);
      } catch (error) {
        expect((error as AiRuntimeSelectionError).code).toBe("invalid-preference");
      }
    }
  });

  it("23. null/undefined preferences throw", () => {
    expect(() => selectAiRuntime(null)).toThrowError(AiRuntimeSelectionError);
    expect(() => selectAiRuntime(undefined)).toThrowError(AiRuntimeSelectionError);
  });

  it("24. arbitrary unsupported runtime names throw", () => {
    try {
      selectAiRuntime("openai-direct");
      expect.unreachable("arbitrary runtime name must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AiRuntimeSelectionError);
      expect((error as AiRuntimeSelectionError).code).toBe("invalid-preference");
    }
  });
});

describe("REGRESSION smoke", () => {
  it("25. orchestration entry point remains intact for future wiring", async () => {
    const { runAiActionOnPdf } = await import("./orchestration");
    expect(typeof runAiActionOnPdf).toBe("function");
  });
});
