# Browser AI — Checkpoint 2A prototype (PROTOTYPE ONLY)

**This directory is an empirical feasibility spike, not production code.**
See `docs/DOCFLOW_STATUS.md` (Phase 5, Checkpoint 2A) and the checkpoint
authorization document for full scope. Summary of the hard boundary:

- Allowed: one pilot model, one operation ("summarize the supplied
  document context"), Worker execution, WebGPU/WASM path testing, model
  load/cache/cancellation testing, performance/memory observation.
- Not allowed: production AI UI, Summarize/Translate/Key Points/Ask
  product features, Ollama, BYOK, Cloud AI, AI Agent, semantic search,
  embeddings, vector DB, tool calling, multi-document AI, production
  model-selection UX, account/auth, backend/API routes.

Everything in this directory is wired to the **real** AI-01/AI-02
foundation (`services/ai/types.ts`, `services/ai/validation.ts`,
`services/ai/pipeline.ts#buildAiTextContext`) — it does not fabricate
prompt/context data, and it does not send the original PDF, `File`,
`Blob`, `ArrayBuffer`, password, page image, thumbnail, or metadata to
the model. Only `AiContextChunk[]` (already-extracted, already-chunked
plain text) and the user's prompt reach the inference layer.

## Files

- `constants.ts` — pinned runtime package version, model identifier,
  revision, and dtype. Single source of truth so the rest of this
  directory never hardcodes them.
- `promptBuilder.ts` — pure function that assembles the model prompt
  from `AiContextChunk[]`, keeping extracted (untrusted) document text
  clearly delimited from the instruction. See "Prompt-injection safety"
  in the checkpoint spec — this does not make the prototype a safe agent
  system, it only prevents document text from being indistinguishable
  from system instructions in this one prompt.
- `browserAiWorker.ts` — the actual Worker entry point. Loads
  `@huggingface/transformers`, initializes the pilot model (WebGPU with
  WASM fallback), and runs the single "summarize" operation. Uses
  `InterruptableStoppingCriteria` (a real, documented Transformers.js
  API — see the class's own docs) for cancellation, not a fake
  hide-the-response cancel.
- `browserAiWorkerClient.ts` — main-thread wrapper around the Worker.
  Lazily creates the Worker only when explicitly triggered (never on
  page load), exposes a small promise/callback API, and never receives
  or forwards anything but text.

## What this prototype deliberately does NOT do

- No generic prompt box, no chat UI, no preset buttons.
- No second model wired in as a "fallback default" — if a smaller
  benchmark candidate is tested, it is recorded as a benchmark note only
  (see the final report), not adopted here.
- No production model-selection UX, no settings persistence.
- No sharing of AI runtime/worker state with the PDF.js worker
  (`services/pdf/*`) — this Worker is fully independent.

## Test route

`app/test/browser-ai/page.tsx` is the temporary, Playwright-drivable test
harness for this prototype, following the same pattern as
`app/test/compression/page.tsx` (Phase 3.3). It is not linked from any
production navigation.
