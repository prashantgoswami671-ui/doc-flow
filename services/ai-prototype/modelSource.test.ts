import { describe, expect, it } from "vitest";
import {
  BENCHMARK_CANDIDATE_MODEL_ID,
  EXPERIMENT_A_MODEL_ID,
  PILOT_MODEL_ID,
  TRANSFORMERS_JS_VERSION,
} from "./constants";

/**
 * Checkpoint 2A — model-source allowlist guard.
 *
 * SEC-06 §9 requires Ollama URLs to be treated as controlled
 * configuration rather than an arbitrary browser destination. There is
 * no Ollama here, but the analogous risk exists for Browser AI: the
 * model repo identifier is itself a network destination
 * (`@huggingface/transformers` fetches model assets from it). This test
 * pins the two model identifiers this prototype is reviewed against, so
 * a future edit that silently repoints either constant at an unreviewed
 * model source fails a test instead of passing silently — the same
 * "don't allow arbitrary destinations" principle SEC-06 applies to
 * Ollama, applied here to the model source.
 */
describe("Browser AI prototype model source allowlist", () => {
  it("pilot model matches the reviewed onnx-community identifier", () => {
    expect(PILOT_MODEL_ID).toBe("onnx-community/Qwen2.5-1.5B-Instruct");
  });

  it("benchmark candidate matches the reviewed onnx-community identifier", () => {
    expect(BENCHMARK_CANDIDATE_MODEL_ID).toBe("onnx-community/Qwen2.5-0.5B-Instruct");
  });

  it("Experiment A candidate matches the reviewed onnx-community identifier", () => {
    expect(EXPERIMENT_A_MODEL_ID).toBe("onnx-community/SmolLM2-360M-Instruct-ONNX");
  });

  it("all three model identifiers are from the reviewed onnx-community org", () => {
    expect(PILOT_MODEL_ID.startsWith("onnx-community/")).toBe(true);
    expect(BENCHMARK_CANDIDATE_MODEL_ID.startsWith("onnx-community/")).toBe(true);
    expect(EXPERIMENT_A_MODEL_ID.startsWith("onnx-community/")).toBe(true);
  });

  it("runtime version is pinned to an exact version, not a range or 'latest'", () => {
    expect(TRANSFORMERS_JS_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
