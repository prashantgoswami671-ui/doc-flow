/**
 * Production Ollama AI (Tier 2) — configuration constants.
 *
 * Fixed endpoint and model per T2-01 specification.
 * Does not import services/ai-prototype/.
 */

export const OLLAMA_BASE_URL = "http://127.0.0.1:11434";

export const OLLAMA_MODEL = "qwen3:4b";

export const OLLAMA_PROVIDER_ID = "ollama";

export const OLLAMA_DISPLAY_NAME = "Ollama (qwen3:4b)";

/** Maximum input context size for qwen3:4b — conservative default. */
export const OLLAMA_MAX_CONTEXT_CHARACTERS = 32768;

/**
 * Advertised character ceiling for generated output (surfaced via
 * capabilities.maxOutputCharacters). Approximate by design: Ollama enforces
 * generation length in *tokens* via num_predict, not characters, so actual
 * output can exceed this ceiling. It is informational only — never used to
 * clamp a request.
 */
export const OLLAMA_MAX_OUTPUT_CHARACTERS = 8192;

/** Default generation parameters for this model. */
export const OLLAMA_DEFAULT_TEMPERATURE = 0.7;
export const OLLAMA_DEFAULT_MAX_TOKENS = 2048;

/**
 * Hard ceiling (in tokens) for the num_predict option sent to Ollama.
 * num_predict counts tokens, not characters; caller requests above this
 * are clamped here before reaching the API.
 */
export const OLLAMA_MAX_OUTPUT_TOKENS = 8192;

/** Ollama API endpoints. */
export const OLLAMA_API_GENERATE = "/api/generate";
export const OLLAMA_API_TAGS = "/api/tags";
export const OLLAMA_API_SHOW = "/api/show";

/** Ollama request/response types (minimal, strictly what we need). */
export interface OllamaGenerateRequest {
  model: string;
  prompt: string;
  stream: false;
  /** Thinking control (V6-F02: `false` for structured Stage-1/Stage-2 calls). */
  think?: boolean;
  /** Structured-output JSON Schema object (never the bare `"json"` mode). */
  format?: OllamaJsonSchema;
  options?: {
    temperature?: number;
    num_predict?: number;
  };
}

/**
 * Provider-local JSON Schema representation for Ollama structured
 * outputs (`format`). Object-only by design: the experiment showed
 * bare `"json"` mode is insufficient for the frozen Stage-1/Stage-2
 * contracts on this setup.
 */
export interface OllamaJsonSchema {
  readonly type: "array" | "object" | "string" | "number" | "boolean" | "integer";
  readonly items?: OllamaJsonSchema;
  readonly properties?: Readonly<Record<string, OllamaJsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly enum?: readonly string[];
}

export interface OllamaGenerateResponse {
  model: string;
  created_at: string;
  response: string;
  done: boolean;
  context?: number[];
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}

export interface OllamaTagsResponse {
  models: Array<{
    name: string;
    model: string;
    modified_at: string;
    size: number;
    digest: string;
    details?: {
      parent_model?: string;
      format?: string;
      family?: string;
      families?: string[];
      parameter_size?: string;
      quantization_level?: string;
    };
  }>;
}

export interface OllamaShowResponse {
  modelfile: string;
  parameters: string;
  template: string;
  details: {
    parent_model?: string;
    format?: string;
    family?: string;
    families?: string[];
    parameter_size?: string;
    quantization_level?: string;
  };
  capabilities?: string[];
  model_info?: Record<string, unknown>;
}