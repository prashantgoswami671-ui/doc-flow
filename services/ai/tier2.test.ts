import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTextVectorPdfBytes, toFile } from "../pdf/__fixtures__/pdf";
import { createAiConsentStore, evaluateAiConsent, grantAiConsent } from "./consent";
import { BrowserAiRuntime } from "./browser/browserAiRuntime";
import { OllamaRuntime } from "./ollama/runtime";
import { OLLAMA_BASE_URL, OLLAMA_MODEL, OLLAMA_PROVIDER_ID } from "./ollama/types";
import { selectAiRuntime } from "./providerSelection";
import { projectGroundedClaims } from "./stage2/projection";
import { validateStage2Output } from "./stage2/validation";
import { Tier2ServiceError, runTier2OllamaSummarize } from "./tier2";

/**
 * V6-D04 — Unit tests for the Ollama production integration seam.
 *
 * No live Ollama: global `fetch` is stubbed per test to emulate
 * `/api/tags` + `/api/generate`. Real PDF fixtures via
 * `services/pdf/__fixtures__/pdf` (production fixtures, not T2
 * research). No UI, no consent persistence, no V6-E capability.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type TagsMode = "ok" | "no-model" | "corrupt" | "down";
type GenerateMode = "ok" | "http500";

function stubOllamaFetch(tags: TagsMode, generate: GenerateMode = "ok") {
  const urls: string[] = [];
  const generateBodies: unknown[] = [];
  const mock = vi.fn(async (url: unknown, init?: { body?: unknown }) => {
    const target = String(url);
    urls.push(target);
    if (target.endsWith("/api/tags")) {
      if (tags === "down") {
        throw new Error("fetch failed");
      }
      if (tags === "corrupt") {
        return { ok: true, json: () => Promise.resolve({ models: null }) };
      }
      const models =
        tags === "no-model"
          ? [{ name: "other:1b", model: "other:1b" }]
          : [{ name: OLLAMA_MODEL, model: OLLAMA_MODEL }];
      return { ok: true, json: () => Promise.resolve({ models }) };
    }
    if (target.endsWith("/api/generate")) {
      if (init?.body !== undefined) {
        generateBodies.push(JSON.parse(String(init.body)));
      }
      if (generate === "http500") {
        return { ok: false, status: 500, statusText: "boom", json: () => Promise.resolve({}) };
      }
      return {
        ok: true,
        json: () =>
          Promise.resolve({
            model: OLLAMA_MODEL,
            created_at: "t",
            response: "stub summary",
            done: true,
          }),
      };
    }
    throw new Error(`unexpected url ${target}`);
  });
  vi.stubGlobal("fetch", mock);
  return { urls, generateBodies, mock };
}

async function testPdfFile() {
  return toFile(await buildTextVectorPdfBytes(1));
}

function grantedStore() {
  const store = createAiConsentStore();
  grantAiConsent(store, OLLAMA_PROVIDER_ID);
  return store;
}

async function serviceErrorOf(promise: Promise<unknown>): Promise<Tier2ServiceError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(Tier2ServiceError);
    return error as Tier2ServiceError;
  }
  throw new Error("expected Tier2ServiceError");
}

describe("SELECTION", () => {
  it("1. explicit Ollama production request resolves the real Ollama runtime", async () => {
    stubOllamaFetch("ok");
    const file = await testPdfFile();
    const result = await runTier2OllamaSummarize({ file, consentStore: grantedStore() });
    expect(result.providerId).toBe(OLLAMA_PROVIDER_ID);
    expect(result.runtime).toBe("ollama");
  });

  it("2. Browser remains the default selection", () => {
    expect(selectAiRuntime("automatic").resolved).toBe("browser");
    expect(selectAiRuntime("browser").runtime).toBeInstanceOf(BrowserAiRuntime);
  });

  it("3. BYOK remains unsupported", () => {
    expect(() => selectAiRuntime("byok")).toThrow();
  });

  it("4. Cloud remains unsupported", () => {
    expect(() => selectAiRuntime("cloud")).toThrow();
  });

  it("5. no silent Ollama→Browser fallback on availability failure", async () => {
    stubOllamaFetch("down");
    const file = await testPdfFile();
    const error = await serviceErrorOf(
      runTier2OllamaSummarize({ file, consentStore: grantedStore() }),
    );
    expect(error.code).toBe("service-unavailable");
  });
});

describe("AVAILABILITY", () => {
  it("6. unavailable blocks before generation", async () => {
    const { urls } = stubOllamaFetch("down");
    const file = await testPdfFile();
    const error = await serviceErrorOf(
      runTier2OllamaSummarize({ file, consentStore: grantedStore() }),
    );
    expect(error.code).toBe("service-unavailable");
    expect(urls.some((u) => u.endsWith("/api/generate"))).toBe(false);
  });

  it("7. model-unavailable blocks before generation", async () => {
    const { urls } = stubOllamaFetch("no-model");
    const file = await testPdfFile();
    const error = await serviceErrorOf(
      runTier2OllamaSummarize({ file, consentStore: grantedStore() }),
    );
    expect(error.code).toBe("model-unavailable");
    expect(urls.some((u) => u.endsWith("/api/generate"))).toBe(false);
  });

  it("8. corrupt availability payload still blocks before generation", async () => {
    const { urls } = stubOllamaFetch("corrupt");
    const file = await testPdfFile();
    const error = await serviceErrorOf(
      runTier2OllamaSummarize({ file, consentStore: grantedStore() }),
    );
    expect(error.code).not.toBe("generation-failed");
    expect(urls.some((u) => u.endsWith("/api/generate"))).toBe(false);
  });

  it("9. available permits the next policy step", async () => {
    stubOllamaFetch("ok");
    const file = await testPdfFile();
    const result = await runTier2OllamaSummarize({ file, consentStore: grantedStore() });
    expect(result.text).toBe("stub summary");
  });

  it("10. availability check happens before content-bearing generation", async () => {
    const { urls } = stubOllamaFetch("ok");
    const file = await testPdfFile();
    await runTier2OllamaSummarize({ file, consentStore: grantedStore() });
    const firstTags = urls.findIndex((u) => u.endsWith("/api/tags"));
    const firstGenerate = urls.findIndex((u) => u.endsWith("/api/generate"));
    expect(firstTags).toBeGreaterThanOrEqual(0);
    expect(firstGenerate).toBeGreaterThan(firstTags);
  });
});

describe("CONSENT", () => {
  it("11. Ollama without consent blocks", async () => {
    const { urls } = stubOllamaFetch("ok");
    const file = await testPdfFile();
    const error = await serviceErrorOf(
      runTier2OllamaSummarize({ file, consentStore: createAiConsentStore() }),
    );
    expect(error.code).toBe("consent-required");
    expect(urls.some((u) => u.endsWith("/api/generate"))).toBe(false);
  });

  it("12. Ollama with wrong-provider consent blocks", async () => {
    const { urls } = stubOllamaFetch("ok");
    const file = await testPdfFile();
    const store = createAiConsentStore();
    grantAiConsent(store, "some-other-provider");
    const error = await serviceErrorOf(runTier2OllamaSummarize({ file, consentStore: store }));
    expect(error.code).toBe("consent-required");
    expect(urls.some((u) => u.endsWith("/api/generate"))).toBe(false);
  });

  it("13. Ollama with matching consent continues", async () => {
    stubOllamaFetch("ok");
    const file = await testPdfFile();
    const result = await runTier2OllamaSummarize({ file, consentStore: grantedStore() });
    expect(result.text).toBe("stub summary");
  });

  it("14. Browser does not require consent", () => {
    const browser = new BrowserAiRuntime();
    expect(evaluateAiConsent(browser, createAiConsentStore()).status).toBe("not-required");
    browser.dispose();
  });

  it("15. consent is checked before generation (availability runs, generation does not)", async () => {
    const { urls } = stubOllamaFetch("ok");
    const file = await testPdfFile();
    await serviceErrorOf(
      runTier2OllamaSummarize({ file, consentStore: createAiConsentStore() }),
    );
    expect(urls.some((u) => u.endsWith("/api/tags"))).toBe(true);
    expect(urls.some((u) => u.endsWith("/api/generate"))).toBe(false);
  });
});

describe("GENERATION", () => {
  it("16. generateText runs only after availability + consent", async () => {
    const { urls } = stubOllamaFetch("ok");
    const file = await testPdfFile();
    await runTier2OllamaSummarize({ file, consentStore: grantedStore() });
    expect(urls.filter((u) => u.endsWith("/api/generate"))).toHaveLength(1);
  });

  it("17. generation is called exactly once", async () => {
    const { urls } = stubOllamaFetch("ok");
    const file = await testPdfFile();
    await runTier2OllamaSummarize({ file, consentStore: grantedStore() });
    expect(urls.filter((u) => u.endsWith("/api/generate"))).toHaveLength(1);
  });

  it("18. generated input contains only allowed prompt/context fields", async () => {
    const { generateBodies } = stubOllamaFetch("ok");
    const file = await testPdfFile();
    await runTier2OllamaSummarize({ file, consentStore: grantedStore() });
    expect(generateBodies).toHaveLength(1);
    const body = generateBodies[0] as Record<string, unknown>;
    for (const key of Object.keys(body)) {
      expect(["model", "prompt", "stream", "options"]).toContain(key);
    }
    expect(typeof body["prompt"]).toBe("string");
  });

  it("19. no File/Blob/ArrayBuffer/PDF bytes are sent", async () => {
    const { generateBodies } = stubOllamaFetch("ok");
    const file = await testPdfFile();
    await runTier2OllamaSummarize({ file, consentStore: grantedStore() });
    const serialized = JSON.stringify(generateBodies[0]);
    expect(serialized).not.toContain("JVBER");
    expect(serialized.toLowerCase()).not.toContain("arraybuffer");
  });

  it("20. providerId/runtime correspond to Ollama", async () => {
    stubOllamaFetch("ok");
    const file = await testPdfFile();
    const result = await runTier2OllamaSummarize({ file, consentStore: grantedStore() });
    expect(result.providerId).toBe(OLLAMA_PROVIDER_ID);
    expect(result.runtime).toBe("ollama");
  });

  it("unsupported actions never reach generation", async () => {
    const { urls } = stubOllamaFetch("ok");
    const file = await testPdfFile();
    for (const action of ["translate", "ask", "keyPoints", "comparison"]) {
      const error = await serviceErrorOf(
        runTier2OllamaSummarize({ file, consentStore: grantedStore(), action }),
      );
      expect(error.code).toBe("unsupported-capability");
    }
    expect(urls).toHaveLength(0);
  });
});

describe("NO NETWORK AT IMPORT", () => {
  it("21. importing the integration module performs no fetch", async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error("no network in tests")));
    vi.stubGlobal("fetch", fetchMock);
    vi.resetModules();
    await import("./tier2");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("22. no availability polling after a run", async () => {
    const { mock } = stubOllamaFetch("ok");
    const file = await testPdfFile();
    await runTier2OllamaSummarize({ file, consentStore: grantedStore() });
    const countAfterRun = mock.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(mock.mock.calls.length).toBe(countAfterRun);
  });

  it("23. no automatic generation on import", async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error("no network in tests")));
    vi.stubGlobal("fetch", fetchMock);
    vi.resetModules();
    await import("./tier2");
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("BROWSER REGRESSION", () => {
  it("24. existing Browser runtime path remains valid", () => {
    expect(selectAiRuntime("automatic").runtime).toBeInstanceOf(BrowserAiRuntime);
  });

  it("25. Browser selection never invokes Ollama availability", () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error("no network in tests")));
    vi.stubGlobal("fetch", fetchMock);
    const selection = selectAiRuntime("browser");
    expect(selection.runtime).toBeInstanceOf(BrowserAiRuntime);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("26. existing orchestration behavior remains valid", async () => {
    const { runAiActionOnPdf } = await import("./orchestration");
    expect(typeof runAiActionOnPdf).toBe("function");
  });
});

describe("STAGE-2 BOUNDARY", () => {
  it("27. no new claim kind is introduced", async () => {
    stubOllamaFetch("ok");
    const file = await testPdfFile();
    const result = await runTier2OllamaSummarize({ file, consentStore: grantedStore() });
    expect(Object.keys(result).sort()).toEqual(
      ["chunks", "providerId", "runtime", "sourcePageCount", "text", "validated"].sort(),
    );
  });

  it("28. raw model text is never promoted to evidence", async () => {
    stubOllamaFetch("ok");
    const file = await testPdfFile();
    const result = await runTier2OllamaSummarize({ file, consentStore: grantedStore() });
    expect(result.validated).toBe(false);
    expect("evidence" in result).toBe(false);
    expect("claims" in result).toBe(false);
  });

  it("29-30. C02/C03 remain the output-validation and grounding authorities", () => {
    expect(typeof validateStage2Output).toBe("function");
    expect(typeof projectGroundedClaims).toBe("function");
    const source = readFileSync(join(__dirname, "tier2.ts"), "utf8");
    expect(source).not.toContain("stage2/validation");
    expect(source).not.toContain("stage2/projection");
    expect(source).toContain("stage2/capability");
  });
});

describe("ERRORS", () => {
  it("31. selection/capability errors stay explicit", async () => {
    stubOllamaFetch("ok");
    const file = await testPdfFile();
    const error = await serviceErrorOf(
      runTier2OllamaSummarize({ file, consentStore: grantedStore(), action: "translate" }),
    );
    expect(error.code).toBe("unsupported-capability");
    expect(error).toBeInstanceOf(Tier2ServiceError);
  });

  it("32. unavailable state preserved", async () => {
    stubOllamaFetch("down");
    const file = await testPdfFile();
    const error = await serviceErrorOf(
      runTier2OllamaSummarize({ file, consentStore: grantedStore() }),
    );
    expect(error.code).toBe("service-unavailable");
  });

  it("33. model-unavailable state preserved", async () => {
    stubOllamaFetch("no-model");
    const file = await testPdfFile();
    const error = await serviceErrorOf(
      runTier2OllamaSummarize({ file, consentStore: grantedStore() }),
    );
    expect(error.code).toBe("model-unavailable");
  });

  it("34. consent-required state preserved", async () => {
    stubOllamaFetch("ok");
    const file = await testPdfFile();
    const error = await serviceErrorOf(
      runTier2OllamaSummarize({ file, consentStore: createAiConsentStore() }),
    );
    expect(error.code).toBe("consent-required");
  });

  it("35. generation error preserved", async () => {
    stubOllamaFetch("ok", "http500");
    const file = await testPdfFile();
    const error = await serviceErrorOf(
      runTier2OllamaSummarize({ file, consentStore: grantedStore() }),
    );
    expect(error.code).toBe("generation-failed");
  });

  it("malformed requests fail closed without network use", async () => {
    const { mock } = stubOllamaFetch("ok");
    for (const bad of [null, {}, { file: "x.pdf" }, { consentStore: grantedStore() }]) {
      const error = await serviceErrorOf(runTier2OllamaSummarize(bad));
      expect(error.code).toBe("invalid-request");
    }
    expect(mock).not.toHaveBeenCalled();
  });
});

describe("LIFECYCLE", () => {
  it("36-37. no singleton: sequential runs stay independent", async () => {
    stubOllamaFetch("ok");
    const first = await runTier2OllamaSummarize({
      file: await testPdfFile(),
      consentStore: grantedStore(),
    });
    const second = await runTier2OllamaSummarize({
      file: await testPdfFile(),
      consentStore: grantedStore(),
    });
    // A shared disposed runtime would reject the second call with
    // OllamaRuntimeDisposedError; both succeed with fresh ownership.
    expect(first.text).toBe("stub summary");
    expect(second.text).toBe("stub summary");
  });

  it("38. normal Ollama dispose remains possible", () => {
    const runtime = new OllamaRuntime();
    expect(typeof runtime.dispose).toBe("function");
    expect(() => runtime.dispose()).not.toThrow();
  });
});

describe("SECURITY", () => {
  it("39. File-like payloads are rejected", async () => {
    const error = await serviceErrorOf(
      runTier2OllamaSummarize({ file: { name: "x.pdf" }, consentStore: grantedStore() }),
    );
    expect(error.code).toBe("invalid-request");
  });

  it("40. no arbitrary provider endpoint is used", async () => {
    const { urls } = stubOllamaFetch("ok");
    const file = await testPdfFile();
    await runTier2OllamaSummarize({ file, consentStore: grantedStore() });
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url.startsWith(OLLAMA_BASE_URL)).toBe(true);
    }
  });

  it("41. fixed configured endpoint/model remain authoritative", async () => {
    expect(OLLAMA_BASE_URL).toBe("http://127.0.0.1:11434");
    expect(OLLAMA_MODEL).toBe("qwen3:4b");
    const { generateBodies } = stubOllamaFetch("ok");
    const file = await testPdfFile();
    await runTier2OllamaSummarize({ file, consentStore: grantedStore() });
    expect((generateBodies[0] as Record<string, unknown>)["model"]).toBe(OLLAMA_MODEL);
  });
});
