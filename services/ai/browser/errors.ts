/** Thrown when `checkAvailability()` reports the runtime cannot operate. */
export class AiRuntimeUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "AiRuntimeUnavailableError";
  }
}

/** Thrown when the ONNX/WASM model fails to load inside the Worker. */
export class AiModelInitializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiModelInitializationError";
  }
}

/** Thrown when generation fails after the model was ready. */
export class AiGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiGenerationError";
  }
}

/**
 * Thrown when an in-flight generation is stopped via `cancel()`.
 * The Worker uses Transformers.js `InterruptableStoppingCriteria`.
 */
export class AiGenerationCancelledError extends Error {
  constructor(message = "Browser AI generation was cancelled.") {
    super(message);
    this.name = "AiGenerationCancelledError";
  }
}

/** Thrown when `generateText()` is called while another generation is running. */
export class AiConcurrentGenerationError extends Error {
  constructor(
    message = "Browser AI supports one in-flight generation at a time.",
  ) {
    super(message);
    this.name = "AiConcurrentGenerationError";
  }
}

/**
 * Thrown to settle a pending `generateText()` call (init or generation
 * phase) when `dispose()` is called while it is still in flight. Distinct
 * from `AiGenerationCancelledError`, which represents an explicit
 * `cancel()` of a running generation rather than teardown of the runtime.
 */
export class AiRuntimeDisposedError extends Error {
  constructor(
    message = "Browser AI runtime was disposed while an operation was pending.",
  ) {
    super(message);
    this.name = "AiRuntimeDisposedError";
  }
}
