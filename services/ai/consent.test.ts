import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserAiRuntime } from "./browser/browserAiRuntime";
import { OllamaRuntime } from "./ollama/runtime";
import {
  AiConsentRequiredError,
  AiConsentValidationError,
  assertAiConsent,
  buildAiDisclosure,
  createAiConsentStore,
  evaluateAiConsent,
  grantAiConsent,
  isAiRuntimeLike,
  revokeAiConsent,
} from "./consent";

/**
 * V6-D03 — Unit tests for the Tier-2 consent/disclosure policy layer.
 *
 * No generation, no network, no document data, no persistence, no UI.
 * Real Browser/Ollama runtimes are used for capability decisions;
 * a custom capability-shaped runtime proves nothing is hardcoded.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function customConsentRuntime() {
  return {
    capabilities: {
      providerId: "custom-remote",
      displayName: "Custom Remote",
      runtime: "byok",
      isLocal: false,
      requiresConsent: true,
      supportsStreaming: false,
      supportsToolCalling: false,
      maxContextCharacters: 100,
      maxOutputCharacters: 100,
      supportsTextGeneration: true,
    },
    checkAvailability: () => Promise.resolve({ available: true }),
    generateText: vi.fn(() => Promise.reject(new Error("generation must not run in D03"))),
  };
}

describe("CAPABILITY DECISION", () => {
  it("1. Browser runtime (requiresConsent=false) → not-required", () => {
    const browser = new BrowserAiRuntime();
    const state = evaluateAiConsent(browser, createAiConsentStore());
    expect(state).toEqual({
      status: "not-required",
      providerId: browser.capabilities.providerId,
      displayName: browser.capabilities.displayName,
    });
    browser.dispose();
  });

  it("2. Ollama runtime (requiresConsent=true) → required", () => {
    const ollama = new OllamaRuntime();
    const state = evaluateAiConsent(ollama, createAiConsentStore());
    expect(state.status).toBe("required");
    expect(state.providerId).toBe(ollama.capabilities.providerId);
  });

  it("3. decision uses runtime.capabilities, not hardcoded runtime name", () => {
    const custom = customConsentRuntime();
    const state = evaluateAiConsent(custom, createAiConsentStore());
    expect(state).toEqual({
      status: "required",
      providerId: "custom-remote",
      displayName: "Custom Remote",
    });
  });
});

describe("CONSENT GRANT", () => {
  it("4. grant consent for Ollama → granted", () => {
    const ollama = new OllamaRuntime();
    const store = createAiConsentStore();
    grantAiConsent(store, ollama.capabilities.providerId);
    expect(evaluateAiConsent(ollama, store).status).toBe("granted");
  });

  it("5. granted Ollama consent permits Ollama", () => {
    const ollama = new OllamaRuntime();
    const store = createAiConsentStore();
    grantAiConsent(store, ollama.capabilities.providerId);
    expect(() => assertAiConsent(ollama, store)).not.toThrow();
  });

  it("6. granted Ollama consent does not change Browser logic", () => {
    const browser = new BrowserAiRuntime();
    const ollama = new OllamaRuntime();
    const store = createAiConsentStore();
    grantAiConsent(store, ollama.capabilities.providerId);
    expect(evaluateAiConsent(browser, store).status).toBe("not-required");
    browser.dispose();
  });

  it("7. granted Ollama consent does not permit another provider", () => {
    const ollama = new OllamaRuntime();
    const custom = customConsentRuntime();
    const store = createAiConsentStore();
    grantAiConsent(store, ollama.capabilities.providerId);
    expect(evaluateAiConsent(custom, store).status).toBe("required");
    expect(() => assertAiConsent(custom, store)).toThrow(AiConsentRequiredError);
  });
});

describe("CONSENT BLOCK", () => {
  it("8. required + no consent → blocked with AiConsentRequiredError", () => {
    const ollama = new OllamaRuntime();
    expect(() => assertAiConsent(ollama, createAiConsentStore())).toThrow(
      AiConsentRequiredError,
    );
    try {
      assertAiConsent(ollama, createAiConsentStore());
    } catch (error) {
      expect((error as AiConsentRequiredError).providerId).toBe(
        ollama.capabilities.providerId,
      );
    }
  });

  it("9. required + consent for a different provider → blocked", () => {
    const ollama = new OllamaRuntime();
    const store = createAiConsentStore();
    grantAiConsent(store, "some-other-provider");
    expect(() => assertAiConsent(ollama, store)).toThrow(AiConsentRequiredError);
  });

  it("10. wrong provider ID grant does not satisfy the runtime", () => {
    const ollama = new OllamaRuntime();
    const store = createAiConsentStore();
    grantAiConsent(store, `${ollama.capabilities.providerId}-typo`);
    expect(evaluateAiConsent(ollama, store).status).toBe("required");
  });
});

describe("REVOCATION", () => {
  it("11. grant then revoke → blocked again", () => {
    const ollama = new OllamaRuntime();
    const store = createAiConsentStore();
    grantAiConsent(store, ollama.capabilities.providerId);
    expect(evaluateAiConsent(ollama, store).status).toBe("granted");
    revokeAiConsent(store, ollama.capabilities.providerId);
    expect(evaluateAiConsent(ollama, store).status).toBe("required");
    expect(() => assertAiConsent(ollama, store)).toThrow(AiConsentRequiredError);
  });

  it("12. revoking one provider leaves another provider granted", () => {
    const store = createAiConsentStore();
    grantAiConsent(store, "provider-a");
    grantAiConsent(store, "provider-b");
    revokeAiConsent(store, "provider-a");
    expect(store.isGranted("provider-a")).toBe(false);
    expect(store.isGranted("provider-b")).toBe(true);
  });
});

describe("DISCLOSURE", () => {
  it("13. Ollama disclosure identifies the local Ollama provider", () => {
    const ollama = new OllamaRuntime();
    const disclosure = buildAiDisclosure(ollama);
    expect(disclosure.providerId).toBe(ollama.capabilities.providerId);
    const text = [disclosure.headline, ...disclosure.points].join(" ");
    expect(text).toContain(ollama.capabilities.displayName);
    expect(text.toLowerCase()).toContain("local");
  });

  it("14. disclosure states extracted document text is sent", () => {
    const disclosure = buildAiDisclosure(new OllamaRuntime());
    expect(disclosure.points.join(" ").toLowerCase()).toContain("extracted document text");
  });

  it("15. disclosure states the original PDF is not sent", () => {
    const disclosure = buildAiDisclosure(new OllamaRuntime());
    const text = disclosure.points.join(" ").toLowerCase();
    expect(text).toContain("original pdf");
    expect(text).toContain("not sent");
  });

  it("16. disclosure makes no absolute privacy/offline claim", () => {
    const disclosure = buildAiDisclosure(new OllamaRuntime());
    const text = [disclosure.headline, ...disclosure.points].join(" ").toLowerCase();
    for (const banned of [
      "100% private",
      "nothing leaves your device",
      "zero network",
      "completely offline",
      "never leaves",
      "always local",
    ]) {
      expect(text).not.toContain(banned);
    }
  });

  it("17. Browser disclosure never claims Ollama-style data transmission", () => {
    const browser = new BrowserAiRuntime();
    const disclosure = buildAiDisclosure(browser);
    expect(disclosure.requiresConsent).toBe(false);
    const text = [disclosure.headline, ...disclosure.points].join(" ").toLowerCase();
    expect(text).toContain("browser");
    expect(text).not.toContain("sent to");
    browser.dispose();
  });

  it("18. disclosure metadata comes from runtime.capabilities", () => {
    const custom = customConsentRuntime();
    const disclosure = buildAiDisclosure(custom);
    expect(disclosure.providerId).toBe("custom-remote");
    expect(disclosure.displayName).toBe("Custom Remote");
    expect(disclosure.confirmLabel).toContain("Custom Remote");
    expect(disclosure.cancelLabel).toBe("Cancel");
  });
});

describe("SECURITY", () => {
  it.each([
    ["19. File-like", { file: { name: "x.pdf" } }],
    ["20. Blob-like", { blob: { size: 1 } }],
    ["21. ArrayBuffer-like", { arrayBuffer: [0] }],
    ["22. metadata-like", { metadata: { author: "x" } }],
    ["23. PDF bytes-like", { fileBytes: "JVBERi0" }],
  ])("%s object is rejected by consent evaluation", (_label, input) => {
    expect(() => evaluateAiConsent(input, createAiConsentStore())).toThrow(
      AiConsentValidationError,
    );
  });

  it("24. extracted document text is not accepted by the consent API", () => {
    expect(() =>
      evaluateAiConsent({ text: "some document text" }, createAiConsentStore()),
    ).toThrow(AiConsentValidationError);
  });

  it("25. Stage2 claim object is not accepted by the consent API", () => {
    expect(() =>
      evaluateAiConsent(
        { kind: "fact", text: "T.", evidenceIds: ["chunk-0-e0"] },
        createAiConsentStore(),
      ),
    ).toThrow(AiConsentValidationError);
    expect(isAiRuntimeLike({ kind: "fact", text: "T." })).toBe(false);
    expect(isAiRuntimeLike(new OllamaRuntime())).toBe(true);
  });
});

describe("NO NETWORK / GENERATION", () => {
  it("26. no fetch during consent evaluation", () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error("no network in tests")));
    vi.stubGlobal("fetch", fetchMock);
    const ollama = new OllamaRuntime();
    const store = createAiConsentStore();
    evaluateAiConsent(ollama, store);
    grantAiConsent(store, ollama.capabilities.providerId);
    assertAiConsent(ollama, store);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("27. no network during disclosure generation", () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error("no network in tests")));
    vi.stubGlobal("fetch", fetchMock);
    buildAiDisclosure(new OllamaRuntime());
    const browser = new BrowserAiRuntime();
    buildAiDisclosure(browser);
    browser.dispose();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("28. generateText is never called", () => {
    const browser = new BrowserAiRuntime();
    const ollama = new OllamaRuntime();
    const custom = customConsentRuntime();
    const generateBrowser = vi.spyOn(browser, "generateText");
    const generateOllama = vi.spyOn(ollama, "generateText");
    const store = createAiConsentStore();
    for (const runtime of [browser, ollama, custom] as const) {
      evaluateAiConsent(runtime, store);
      buildAiDisclosure(runtime);
    }
    grantAiConsent(store, ollama.capabilities.providerId);
    assertAiConsent(ollama, store);
    expect(generateBrowser).not.toHaveBeenCalled();
    expect(generateOllama).not.toHaveBeenCalled();
    expect(custom.generateText).not.toHaveBeenCalled();
    browser.dispose();
  });
});

describe("PERSISTENCE", () => {
  it("29-31. consent module uses no web/server persistence APIs", () => {
    const source = readFileSync(join(__dirname, "consent.ts"), "utf8");
    for (const banned of ["localStorage", "IndexedDB", "indexedDB", "document.cookie", "fetch("]) {
      expect(source).not.toContain(banned);
    }
  });

  it("32. consent remains explicitly in-memory (fresh store holds nothing)", () => {
    const ollama = new OllamaRuntime();
    const first = createAiConsentStore();
    grantAiConsent(first, ollama.capabilities.providerId);
    const second = createAiConsentStore();
    expect(evaluateAiConsent(ollama, second).status).toBe("required");
  });
});

describe("IMMUTABILITY / DETERMINISM", () => {
  it("33. consent result is deterministic", () => {
    const ollama = new OllamaRuntime();
    const store = createAiConsentStore();
    grantAiConsent(store, ollama.capabilities.providerId);
    expect(JSON.stringify(evaluateAiConsent(ollama, store))).toBe(
      JSON.stringify(evaluateAiConsent(ollama, store)),
    );
  });

  it("34. disclosure result is deterministic", () => {
    const ollama = new OllamaRuntime();
    expect(JSON.stringify(buildAiDisclosure(ollama))).toBe(
      JSON.stringify(buildAiDisclosure(ollama)),
    );
  });

  it("35. provider identity stays attached to consent", () => {
    const ollama = new OllamaRuntime();
    const store = createAiConsentStore();
    grantAiConsent(store, ollama.capabilities.providerId);
    const state = evaluateAiConsent(ollama, store);
    expect(state.providerId).toBe(ollama.capabilities.providerId);
    expect(store.grantedProviders()).toEqual([ollama.capabilities.providerId]);
  });

  it("36. returned state cannot be mutated to authorize another provider", () => {
    const ollama = new OllamaRuntime();
    const store = createAiConsentStore();
    const state = evaluateAiConsent(ollama, store);
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(store.grantedProviders())).toBe(true);
    expect(store.isGranted("attacker-provider")).toBe(false);
  });
});

describe("FAIL-CLOSED input validation", () => {
  it("37. null runtime throws", () => {
    expect(() => evaluateAiConsent(null, createAiConsentStore())).toThrow(
      AiConsentValidationError,
    );
  });

  it("38. malformed runtime (no capabilities) throws", () => {
    expect(() => evaluateAiConsent({ generateText: () => undefined })).toThrow(
      AiConsentValidationError,
    );
    expect(() => buildAiDisclosure({ providerId: "x" })).toThrow(AiConsentValidationError);
  });

  it("39. runtime with malformed capabilities throws", () => {
    expect(() =>
      evaluateAiConsent(
        { capabilities: { providerId: "", displayName: "", requiresConsent: "yes" } },
        createAiConsentStore(),
      ),
    ).toThrow(AiConsentValidationError);
  });

  it("40. invalid consent store throws instead of silently proceeding", () => {
    const ollama = new OllamaRuntime();
    expect(() => evaluateAiConsent(ollama, null)).toThrow(AiConsentValidationError);
    expect(() => grantAiConsent(null, "ollama")).toThrow(AiConsentValidationError);
    expect(() => grantAiConsent(createAiConsentStore(), "")).toThrow(
      AiConsentValidationError,
    );
  });

  it("41. mismatched providerId stays blocked", () => {
    const ollama = new OllamaRuntime();
    const store = createAiConsentStore();
    grantAiConsent(store, "Ollama");
    expect(evaluateAiConsent(ollama, store).status).toBe("required");
  });

  it("42. malformed disclosure request throws", () => {
    expect(() => buildAiDisclosure(undefined)).toThrow(AiConsentValidationError);
    expect(() => buildAiDisclosure("ollama")).toThrow(AiConsentValidationError);
  });
});
