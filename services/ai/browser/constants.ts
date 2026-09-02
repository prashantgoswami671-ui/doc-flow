/**
 * Production Browser AI (Tier 1) — single pinned model configuration.
 *
 * Chosen from Checkpoint 2A prototype evidence, not from unused
 * experimental candidates:
 * - `onnx-community/Qwen2.5-1.5B-Instruct` first-use download was ~1.79 GB
 *   and is not the production default.
 * - `onnx-community/SmolLM2-360M-Instruct-ONNX` showed token-ID-0
 *   degeneration on WebGPU in the prototype and is not promoted.
 * - `onnx-community/Qwen2.5-0.5B-Instruct` + `q4` is the configuration
 *   that completed controlled WASM generation (see
 *   `docs/AI_BROWSER_PROTOTYPE_BENCHMARK.md`).
 *
 * Device (WebGPU vs WASM) is selected at runtime from a real adapter
 * probe — it is not a second experimental model.
 */

/** Exact `@huggingface/transformers` version pinned in package.json. */
export const TRANSFORMERS_JS_VERSION = "4.2.0";

export const BROWSER_AI_MODEL_ID = "onnx-community/Qwen2.5-0.5B-Instruct";

export const BROWSER_AI_MODEL_DTYPE = "q4";

export const BROWSER_AI_PROVIDER_ID = "browser-ai";

export const BROWSER_AI_DISPLAY_NAME = "Browser AI";

/**
 * Practical v1 generation bound. Matches the prototype's proven
 * `PROTOTYPE_MAX_NEW_TOKENS` — larger outputs dominate WASM latency.
 */
export const BROWSER_AI_MAX_NEW_TOKENS = 256;

/**
 * Honest practical input bound for this runtime/model on WASM, not
 * AI-02's extraction budget (`MAX_TOTAL_CONTEXT_CHARACTERS`). Callers
 * may still pass a valid `AiTextGenerationRequest`; the model tokenizer
 * may truncate.
 */
export const BROWSER_AI_MAX_CONTEXT_CHARACTERS = 8192;

/** Rough character ceiling corresponding to `BROWSER_AI_MAX_NEW_TOKENS`. */
export const BROWSER_AI_MAX_OUTPUT_CHARACTERS = 1024;
