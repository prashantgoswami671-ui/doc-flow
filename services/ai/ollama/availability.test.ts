import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiAvailability } from "../types";
import { createOllamaClient } from "./client";
import { OLLAMA_CAPABILITIES, OllamaRuntime } from "./runtime";
import { OLLAMA_MODEL, OLLAMA_PROVIDER_ID } from "./types";
import {
  OllamaAvailabilityError,
  getOllamaAvailability,
} from "./availability";

/**
 * V6-D02 — Unit tests for Tier-2 availability handling.
 *
 * No live Ollama: runtimes use the injected `availabilityCheck` seam
 * and the client tests use an injected `fetchImpl`. No generation,
 * no document data, no consent, no UI.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubRuntime(check: () => Promise<unknown>) {
  let calls = 0;
  const runtime = new OllamaRuntime({
    availabilityCheck: (async () => {
      calls += 1;
      return (await check()) as AiAvailability;
    }) as () => Promise<AiAvailability>,
  });
  const generateText = vi.spyOn(runtime, "generateText");
  return { runtime, calls: () => calls, generateText };
}

describe("AVAILABLE", () => {
  it("1. reachable + configured model present → available", async () => {
    const { runtime } = stubRuntime(() => Promise.resolve({ available: true }));
    const result = await getOllamaAvailability(runtime);
    expect(result.status).toBe("available");
    expect(result.reasonCode).toBeUndefined();
  });

  it("2. repeated checks give a deterministic result", async () => {
    const { runtime } = stubRuntime(() => Promise.resolve({ available: true }));
    const first = await getOllamaAvailability(runtime);
    const second = await getOllamaAvailability(runtime);
    expect(second).toEqual(first);
  });
});

describe("SERVICE UNAVAILABLE", () => {
  it("3. unreachable service → unavailable", async () => {
    const { runtime } = stubRuntime(() =>
      Promise.resolve({ available: false, reason: "fetch failed" }),
    );
    const result = await getOllamaAvailability(runtime);
    expect(result.status).toBe("unavailable");
  });

  it("4. reason code identifies service-unreachable", async () => {
    const { runtime } = stubRuntime(() =>
      Promise.resolve({ available: false, reason: "fetch failed" }),
    );
    const result = await getOllamaAvailability(runtime);
    expect(result.reasonCode).toBe("service-unreachable");
  });

  it("5. no generation is attempted during availability handling", async () => {
    const { runtime, generateText } = stubRuntime(() =>
      Promise.resolve({ available: false, reason: "fetch failed" }),
    );
    await getOllamaAvailability(runtime);
    expect(generateText).not.toHaveBeenCalled();
  });
});

describe("MODEL UNAVAILABLE", () => {
  it("6. reachable service + missing model → model-unavailable", async () => {
    const { runtime } = stubRuntime(() =>
      Promise.resolve({ available: false, modelMissing: true, reason: "model missing" }),
    );
    const result = await getOllamaAvailability(runtime);
    expect(result.status).toBe("model-unavailable");
  });

  it("7. deterministic model-missing reason", async () => {
    const { runtime } = stubRuntime(() =>
      Promise.resolve({ available: false, modelMissing: true }),
    );
    const first = await getOllamaAvailability(runtime);
    const second = await getOllamaAvailability(runtime);
    expect(first.reasonCode).toBe("configured-model-missing");
    expect(second).toEqual(first);
  });

  it("8. model-missing is not collapsed into generic unavailable", async () => {
    const { runtime } = stubRuntime(() =>
      Promise.resolve({ available: false, modelMissing: true }),
    );
    const result = await getOllamaAvailability(runtime);
    expect(result.status).not.toBe("unavailable");
    expect(result.status).toBe("model-unavailable");
  });
});

describe("RUNTIME INTERACTION", () => {
  it("9. helper calls runtime.checkAvailability exactly once", async () => {
    const { runtime, calls } = stubRuntime(() => Promise.resolve({ available: true }));
    await getOllamaAvailability(runtime);
    expect(calls()).toBe(1);
  });

  it("10. helper never calls generateText", async () => {
    const { runtime, generateText } = stubRuntime(() => Promise.resolve({ available: true }));
    await getOllamaAvailability(runtime);
    expect(generateText).not.toHaveBeenCalled();
  });

  it("11. helper creates no second client and performs no fetch itself", async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error("no network in tests")));
    vi.stubGlobal("fetch", fetchMock);
    const { runtime } = stubRuntime(() => Promise.resolve({ available: true }));
    await getOllamaAvailability(runtime);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("12. helper never calls fetch directly", async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error("no network in tests")));
    vi.stubGlobal("fetch", fetchMock);
    const { runtime } = stubRuntime(() =>
      Promise.resolve({ available: false, modelMissing: true }),
    );
    await getOllamaAvailability(runtime);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("SECURITY", () => {
  it.each([
    ["13. document input", { file: { name: "x.pdf" } }],
    ["14. File/Blob-like", { blob: { size: 1 } }],
    ["15. ArrayBuffer-like", { arrayBuffer: [0] }],
    ["16. metadata", { metadata: { author: "x" } }],
  ])("%s is rejected, never propagated", async (_label, input) => {
    await expect(getOllamaAvailability(input)).rejects.toBeInstanceOf(
      OllamaAvailabilityError,
    );
  });

  it("exposes no secrets, stacks, or document content in results", async () => {
    const { runtime } = stubRuntime(() =>
      Promise.resolve({ available: false, reason: "fetch failed" }),
    );
    const result = await getOllamaAvailability(runtime);
    expect(JSON.stringify(result)).not.toContain("fetch failed");
    expect(Object.keys(result).sort()).toEqual(["capabilities", "reasonCode", "status"]);
  });
});

describe("SIDE EFFECTS", () => {
  it("17. importing the availability module performs no network request", async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error("no network in tests")));
    vi.stubGlobal("fetch", fetchMock);
    vi.resetModules();
    await import("./availability");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("18. no global cache: changing availability changes the result", async () => {
    let up = true;
    const { runtime } = stubRuntime(() => Promise.resolve({ available: up }));
    expect((await getOllamaAvailability(runtime)).status).toBe("available");
    up = false;
    expect((await getOllamaAvailability(runtime)).status).toBe("unavailable");
  });

  it("19. no polling/timers: no background checks after the call", async () => {
    const { runtime, calls } = stubRuntime(() => Promise.resolve({ available: true }));
    await getOllamaAvailability(runtime);
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(calls()).toBe(1);
  });

  it("20. default runtime is constructed per call, never shared", async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error("no network in tests")));
    vi.stubGlobal("fetch", fetchMock);
    const first = await getOllamaAvailability();
    const second = await getOllamaAvailability();
    // Each call probes (no cache) and fails closed on unreachable service.
    expect(fetchMock).toHaveBeenCalled();
    expect(first.status).toBe("unavailable");
    expect(second).toEqual(first);
  });
});

describe("CAPABILITIES", () => {
  it("21. capability metadata comes from runtime.capabilities", async () => {
    const { runtime } = stubRuntime(() => Promise.resolve({ available: true }));
    const result = await getOllamaAvailability(runtime);
    expect(result.capabilities).toBe(runtime.capabilities);
  });

  it("22. no duplicated capability constants", async () => {
    const { runtime } = stubRuntime(() => Promise.resolve({ available: true }));
    const result = await getOllamaAvailability(runtime);
    expect(result.capabilities).toBe(OLLAMA_CAPABILITIES);
    expect(result.capabilities.providerId).toBe(OLLAMA_PROVIDER_ID);
  });
});

describe("ROBUSTNESS", () => {
  it("23. malformed availability responses handled deterministically", async () => {
    for (const malformed of [null, "yes", 42, [], { available: "yes" }, {}]) {
      const { runtime } = stubRuntime(() => Promise.resolve(malformed));
      const result = await getOllamaAvailability(runtime);
      expect(result.status).toBe("error");
      expect(result.reasonCode).toBe("malformed-availability-response");
    }
  });

  it("24. unexpected thrown errors handled deterministically", async () => {
    const { runtime } = stubRuntime(() => Promise.reject(new Error("boom")));
    const result = await getOllamaAvailability(runtime);
    expect(result.status).toBe("error");
    expect(result.reasonCode).toBe("availability-check-failed");
  });

  it("25. availability failure never becomes available", async () => {
    const failing = stubRuntime(() => Promise.resolve({ available: false }));
    const throwing = stubRuntime(() => Promise.reject(new Error("boom")));
    const malformed = stubRuntime(() => Promise.resolve(null));
    for (const { runtime } of [failing, throwing, malformed]) {
      expect((await getOllamaAvailability(runtime)).status).not.toBe("available");
    }
  });

  it("malformed caller envelopes throw fail-loud", async () => {
    await expect(getOllamaAvailability(null)).rejects.toBeInstanceOf(OllamaAvailabilityError);
    await expect(getOllamaAvailability({})).rejects.toBeInstanceOf(OllamaAvailabilityError);
  });
});

describe("CLIENT structured signal (provider-local V6-D02 change)", () => {
  function tagsFetch(models: Array<{ name: string; model: string }>) {
    return vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ models }),
      }),
    ) as unknown as typeof fetch;
  }

  it("model present → available without modelMissing", async () => {
    const client = createOllamaClient({
      fetchImpl: tagsFetch([{ name: OLLAMA_MODEL, model: OLLAMA_MODEL }]),
    });
    const result = await client.checkAvailability();
    expect(result.available).toBe(true);
    expect(result.modelMissing).toBeUndefined();
  });

  it("model absent → unavailable with structured modelMissing flag", async () => {
    const client = createOllamaClient({
      fetchImpl: tagsFetch([{ name: "other:1b", model: "other:1b" }]),
    });
    const result = await client.checkAvailability();
    expect(result.available).toBe(false);
    expect(result.modelMissing).toBe(true);
  });

  it("unreachable service → unavailable without modelMissing", async () => {
    const client = createOllamaClient({
      fetchImpl: (() => Promise.reject(new Error("fetch failed"))) as unknown as typeof fetch,
    });
    const result = await client.checkAvailability();
    expect(result.available).toBe(false);
    expect(result.modelMissing).toBeUndefined();
  });

  it("end to end: real client model-missing maps to model-unavailable", async () => {
    const fetchImpl = tagsFetch([{ name: "other:1b", model: "other:1b" }]);
    const runtime = new OllamaRuntime({ clientFactory: () => createOllamaClient({ fetchImpl }) });
    const result = await getOllamaAvailability(runtime);
    expect(result.status).toBe("model-unavailable");
    expect(result.reasonCode).toBe("configured-model-missing");
  });
});
