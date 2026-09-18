# DocFlow — Status Tracker
Last reconciled: **2026-09-18** (full read-only repository audit against `docs/DocFlow_Master_Roadmap_v5.md` and all source code; `npx tsc --noEmit --incremental false` PASS; `npm test` PASS — 446/458 tests, 12 skipped env-gated Ollama live runs). This pass reconciles all stale claims against the audited repository state. Previous reconciliation: 2026-09-11 (documentation-only). The 2026-09-18 audit confirmed: Tier-1 Browser AI production-integrated; Tier-2 Ollama runtime implemented but **not** production-wired; T2-02→T2-09 research complete with live evidence; no production Evidence Store; no Stage-2 validation in production.

**Roadmap source of truth:** `docs/DocFlow_Master_Roadmap_v6.md` (when created) is the execution source of truth. `DOCFLOW_STATUS.md` tracks the current verified implementation state. Older roadmap/status assumptions that conflict with v6 are stale until explicitly reconciled.

**How this file works:** one section per phase. Each task gets a flat ID (`AI-01`, not `5.1a`). A task is only ✅ Done if there's code + a passing test or explicit verification behind it — matching a file, a comment, or a prior AI's claim is not enough. Update this file, not the roadmap, as work happens. The roadmap only changes when a whole phase opens/closes.

---

## Phase 0 — Foundation & Roadmap Control
**Status: ✅ Done.**

## Phase 1 — Shared UX Consistency
**Status: ✅ Done.** Verified 2026-08-28 (tsc, lint, build, npm test all run + passing; manual browser QA on Organize Pages). Full evidence below.

| ID | Task | Status |
|---|---|---|
| UX-01 | Shared UploadZone adopted by all 14 tools | ✅ **14/14 done.** Confirmed by direct code read 2026-08-28: Organize Pages, Insert Pages, Compress PDF, and Watermark import and use `UploadZone`; Merge PDF and Image→PDF import and use `MultiFileUploadZone`. Combined with the 8 tools already on it (Extract Pages, Split PDF, PDF→Image, Fix Orientation, Repair/Validate, Metadata Editor, Protect PDF, Unlock PDF), all 14 tools are now on a shared upload component. |
| UX-02 | Consistent processing/error/success states | ✅ Done |
| UX-03 | Consistent result/download experience | ✅ Done |
| UX-04 | Thumbnail/preview foundation | ✅ Done |
| UX-05 | Automated tests for the shared UX foundation — UploadZone, MultiFileUploadZone, ProcessingState, ResultPanel, ResultCard, PageThumbnailGrid | ✅ **Done — run and verified 2026-08-28.** 6 colocated `*.test.tsx` files (~38 focused cases) covering disabled-blocks-everything / file-select / drop / keyboard contracts (UploadZone, MultiFileUploadZone), stage>message>nothing precedence (ProcessingState), aria-live + opt-in download/reset actions (ResultPanel), truthful reduction/target-missed messaging + `formatFileSize` (ResultCard), and selection/disabled/fallback-preview contracts (PageThumbnailGrid). `npm install && npm test`: **11/11 test files passed, 125/125 tests passed.** |

### Phase 1 exit review (2026-08-28)

- `npx tsc --noEmit` — **PASS**, no output/errors.
- `npm run lint` — **PASS**, 0 errors, 5 pre-existing warnings (ImageToPdfCard unused eslint-disable directive + three `@next/next/no-img-element` warnings; PdfToImageCard unused eslint-disable directive). Not fixed as part of Phase 1 — pre-existing, out of scope.
- `npm run build` — **PASS**. Next.js 16.3.0, compiled successfully, TypeScript finished successfully, 19/19 static pages generated.
- `npm test` — **PASS**, 11/11 test files, 125/125 tests. (The `compress.test.ts` stderr lines "Trying to parse invalid object" / "Invalid object ref" occur during the encrypted/password-protected PDF test and do not indicate a failure — final result 125/125 passed.)
- Manual browser QA on Organize Pages (`/tools/organize-pages`):
  - Keyboard workflow — controls operable via keyboard.
  - Responsive/device-emulation check — ResultPanel layout and controls stayed usable, no blocking layout issue.
  - Result UX — reaches the shared ResultPanel; displays Original pages / Deleted / Rotated / Cropped / Remaining; "Download PDF Again" and "Organize another PDF" both work.
  - Accessibility — success/error/progress live-region announcements verified; ResultPanel ARIA/live-region attributes inspected and confirmed in DevTools Elements.

**Remaining:** none — all five items above (UX-01 through UX-05) are done and verified.

## Phase 2 — PDF Reliability & Hardening
**Status: ✅ Closed.** Full evidence in `docs/PHASE_2_EXIT_REVIEW.md` (written 2026-08-24, independently re-verified 2026-08-27). Do not re-open without new contradicting evidence.

| ID | Task | Status |
|---|---|---|
| REL-01 | 180° orientation detection fix | ✅ Done — OCR-based detector, 12 unit tests |
| REL-02 | Compress PDF dedicated flow + routing audit | ✅ Done |
| REL-03 | Audit all 14 PDF services | ✅ Done |
| REL-04 | Fix edge cases found by audit | ✅ Done |
| REL-05 | Metadata + Watermark to same standard | ✅ Done |
| REL-06 | Phase 2 exit review | ✅ Done |

## Phase 3 — Compression & Optimization
**Status: ✅ Closed.**

| ID | Task | Status |
|---|---|---|
| CMP-01 | Real-rasterizer gap analysis | ✅ Done — `PHASE_3_3_INSPECTION_REPORT.md` |
| CMP-02 | Playwright integration harness (real, non-mocked path) | ✅ Written — `tests/e2e/compression.integration.spec.ts` |
| CMP-03 | Rotation metadata preservation | ✅ Done — `setRotation()` on output |
| CMP-04 | Canvas-overflow guard | ✅ Done — `MAX_CANVAS_DIMENSION` / `computeSafeRenderScale` |
| CMP-05 | Non-finite dimension guard | ✅ Done — `computeSafeCanvasDimension` |
| CMP-06 | Before/after size + % reduction UX | ✅ Done — wired into `CompressPdfCard` |
| CMP-07 | Confirm CMP-02 suite actually passes in a real browser run | ✅ Done — 9/9 real-browser Playwright tests passed |
| CMP-08 | "Quality explanation" UX copy | ✅ Done — Light/Heavy descriptions + traits make the size-vs-quality trade-off explicit; Custom help links target size to compression strength/quality; guarded by `components/CompressPdfCard.test.tsx` |
| CMP-09 | Phase 3 exit review (mirror Phase 2's format) | ✅ Done — Phase 3 exit review completed |

## Phase 4 — Security & Privacy
**Status: ✅ Done — SEC-01 through SEC-07 complete.** A previously-discussed idea to add a dedicated network-interception/regression-test SEC checkpoint is not tracked as a separate unfinished SEC item — the relevant automated guard is implemented and tracked as `AI-21` (Phase 5, below), since it also covers the AI code paths SEC-02's original point-in-time read predates. This is not a new SEC-08.

| ID | Task | Status |
|---|---|---|
| SEC-01 | Dev-only AI tooling (`ai_assistant.py` etc.) isolated from production bundle | ✅ **Re-verified 2026-08-29** — no AI npm dependency in `package.json`/`package-lock.json`; actual tooling is standalone Python (`ai_assistant.py` etc.), not imported anywhere in `app/`/`components/`/`services/`; `.next/` build trace confirms no AI runtime dependency. No implementation change required. |
| SEC-02 | Audit where PDFs are processed / what leaves the browser | ✅ **Re-verified 2026-08-29** — all PDF processing is client-side; no Next.js API routes, route handlers, or server actions process PDFs; uploads and generated outputs are handled via browser File/ArrayBuffer/Blob/object URLs; no PDF bytes, filenames, or metadata are transmitted to third-party services. No implementation change required. |
| SEC-03 | Temp-file cleanup | ✅ **Re-verified 2026-08-29** — direct code read confirms no server-side/filesystem temp-file architecture exists (all PDF processing is client-side); browser object URLs, PDF.js documents/pages/loading tasks, and canvas resources are released in `finally` blocks on success/error/unmount. `rasterizePDFWithSettings` now defaults to `releaseResources = true`, and both call sites in source (`rasterizePDF` in `rasterize.ts`, `compressToCustomTarget` in `compress.ts`) already pass `true` explicitly, so this is a fail-safe default change with no behavior change. Repo owner reports `npm test` (126/126), `tsc --noEmit`, `npm run lint` (0 errors, 5 pre-existing warnings), and `npm run build` all passing — not independently re-run in this session. No further implementation required. |
| SEC-04 | Honest password/protection UX copy | ✅ Done — verified 2026-08-30. Protect/Unlock unit tests: 7/7 passed (protect: 3/3, unlock: 4/4); TypeScript check passed; lint passed with 0 errors and only the existing 5 warnings; production build passed; browser QA passed. Implementation committed as 7e9de11 and pushed to origin/main. |
| SEC-05 | Privacy messaging + documentation (no unverified "100% private" claims) | ✅ Done — verified 2026-08-30. Scoped privacy statement ("Your PDF is processed in your browser and is not uploaded to our servers.") added to the shared `ToolPageShell`, shown on all 14 `/tools/{slug}` pages. Fix Page Orientation additionally discloses that its image-only OCR fallback may load OCR engine/language assets from a third-party CDN (jsDelivr) — confirmed by direct read of the installed `tesseract.js@7` source (`src/worker-script/browser/getCore.js`, `src/worker-script/index.js`): corePath/workerPath/langPath all default to `cdn.jsdelivr.net` unless overridden, and `services/pdf/orientation.ts` never overrides them. Unlock PDF now carries a password-handling reassurance equivalent to Protect PDF's (SEC-04), verified against `services/pdf/unlock.ts` (password never transmitted, never stored). `docs/System-Architecture.md.txt`, `docs/Srs .md.txt`, and `docs/Functional- requiretment.md.txt` marked superseded at the top (server-upload/temp-storage claims that don't match the shipped client-side architecture), historical content preserved. Repo-wide check found no unsupported absolute privacy claims ("100% private", "never leaves your device", "no third-party requests", "zero data", etc.) in user-facing copy; new tests assert the added copy stays scoped and guard against future regression into such claims. Vitest: 18/18 test files passed, 139/139 tests passed. `npx tsc --noEmit` passed. `npm run lint` passed with 0 errors and the existing 5 pre-existing warnings. `npm run build` passed. Manual browser QA passed on Protect PDF, Unlock PDF, Fix Page Orientation, and one additional tool page. |
| SEC-06 | **Scope AI data flow** (client-only PDF processing vs. AI-server processing, retention, transmission, consent) — new in v5, must land before Phase 5 ships anything | ✅ **Done — verified 2026-08-30.** Authoritative policy created at `docs/SEC-06-AI-DATA-POLICY.md`, covering: browser-only-PDF rule, text-egress rule, the three provider categories (local Ollama / self-hosted remote / third-party hosted), retention/logging defaults, server-side API-key boundary, consent/disclosure requirements + exact wording, banned privacy terminology, and the AI-01/AI-02 technical guardrails (provider interface exclusions, egress tests, Ollama URL validation, fail-closed rules) — all 6 SEC-06 completion criteria satisfied. Stale documentation reconciled: `Product-Overview.md.txt` ("Temporary File Management" claim) and `DocFlow_Master_Roadmap_v4.md` (superseded by v5) now carry superseded/historical notices; `Functional- requiretment.md.txt` FR-010 carries a cross-reference to the new policy alongside its existing SEC-05 banner; `System-Architecture.md.txt` and `Srs .md.txt` banners from SEC-05 already covered this and were left as-is. All five files' historical content preserved, nothing deleted. **No AI code was implemented as part of this** — AI-01 through AI-15 remain fully unstarted; this only unblocks Phase 5 from a policy-documentation standpoint. **Verification (repo owner, 2026-08-30):** `npx tsc` clean; `npm run lint` 0 errors (5 pre-existing warnings, unrelated); `npm run build` succeeded (19/19 static pages); Vitest 18/18 test files passed, 139/139 tests passed (matches SEC-05 baseline); `git diff --check` clean (benign LF/CRLF warnings only); `git status` confirms only the 5 intended `docs/` files changed (4 modified + 1 new), nothing under `app/`, `components/`, `services/`, or `lib/`; `git diff --stat` shows 4 files changed, 7 insertions(+), 1 deletion(-). |
| SEC-07 | **Amend SEC-06 for the approved three-tier architecture** (Browser AI category, three-tier framing, BYOK policy decision) + build the AI-01/AI-02 foundation (Checkpoint 1) | ✅ **Done.** `docs/SEC-06-AI-DATA-POLICY.md` amended: added Tier 1 Browser AI (§3.1, no consent required, no unsupported "100% private"-style claims), reframed §3 as three tiers (Browser AI / Ollama / Advanced incl. BYOK), added a BYOK policy decision (§3.5: direct browser→provider allowed, user-supplied key, never sent to DocFlow infra, no DocFlow proxy created, provider terms disclosed, usage may incur charges), and reconciled §9 "Provider separation" to carve out BYOK as a narrow exception. Fail-closed requirements (endpoint validation, consent, prohibited-field rules, retention/logging, security/testing) left intact. No DocFlow backend/proxy was created. See `docs/DOCFLOW_STATUS.md` AI-01/AI-02 rows below for the accompanying foundation code. |

## Phase 5 — AI Document Intelligence
**Status: 🟡 Tier-1 Browser AI foundation and production Summarize PDF are implemented and verified. Tier-2 Ollama runtime exists but is NOT production-wired. T2-02→T2-09 research complete. No production Evidence Store or Stage-2 validation exists. See task rows below for precise classification.**

| ID | Task | Status |
|---|---|---|
| AI-01 | Capability-based AI provider/runtime abstraction (contract only — supports Browser AI/Ollama/BYOK/future Cloud AI without redesign) | ✅ **IMPLEMENTED + VERIFIED.** `services/ai/types.ts` defines `AiRuntime`/`AiCapabilities`/`AiTextGenerationRequest` (capability-based, not tier-based); prohibited fields (`file`, `blob`, `fileBytes`, `arrayBuffer`, `password`, `pageImage`, `thumbnail`, `metadata`) are typed `never` and additionally rejected at runtime by `services/ai/validation.ts` (`assertValidAiTextGenerationRequest`, `assertValidAiCapabilities`, `containsDisallowedBinaryPayload` deep scan). Two providers now implement this contract in production-grade code: Browser AI (Tier 1, production-integrated via AI-16) and Ollama (Tier 2, implemented but not production-wired — see T2-01). Tests: `services/ai/validation.test.ts` (passed 2026-09-18 audit run). |
| AI-02 | Text extraction → bounded, page-aware chunking pipeline for AI input (browser-side; calls no AI provider) | ✅ **IMPLEMENTED + VERIFIED.** `services/ai/extraction.ts` extracts page-aware plain text via PDF.js `getTextContent()` (separate from `services/pdf/extract.ts`, which only copies pages); `services/ai/chunking.ts` produces bounded `AiContextChunk`s (`MAX_CHUNK_CHARACTERS`/`MAX_CHUNKS_PER_REQUEST`/`MAX_TOTAL_CONTEXT_CHARACTERS` in `services/ai/constants.ts`); `services/ai/pipeline.ts` (`buildAiTextContext`) wires both together end-to-end. Supports explicit page scope (all/selected/subset). Scanned/image-only pages report `hasExtractableText: false` with no OCR invoked and no fabricated content. No network call anywhere in `services/ai/`. Tests: `services/ai/extraction.test.ts`, `services/ai/chunking.test.ts`, `services/ai/pipeline.test.ts` (all passed 2026-09-18 audit run). |
| T2-01 | Production Ollama AiRuntime (Tier 2), implementing the `AI-01` `AiRuntime` contract | ✅ **IMPLEMENTED (not production-integrated).** `services/ai/ollama/runtime.ts` + `client.ts` + `types.ts` fully implement `AiRuntime` against `http://127.0.0.1:11434` / model `qwen3:4b` (fixed constants, no env override; enforced by `tests/network-egress.test.ts` loopback pin). Non-streaming `/api/generate` with `generateDetailed()` metrics; `contextTruncated` via 32,768-char bound; `dispose()` permanent; `cancel()` no-op (HTTP). `capabilities.requiresConsent = true`. Unit tests: `services/ai/ollama/runtime.test.ts` (~30 cases, passed 2026-09-18 audit run). **Not reachable from any production UI** — no provider-selection UI, no consent/disclosure flow (SEC-06 §6/§7) implemented. |

### Production Evidence Store / Deterministic Architecture (2026-09-18 audit finding)

- **No production Evidence Store currently exists.** The production AI path is still: **PDF → `buildAiTextContext()` (AI-02 extraction/chunking) → instruction → `runtime.generateText()` → answer text**. No `EvidenceItem`, no evidence validation, no immutable store, no claim validation, no evidence-to-claim resolution anywhere in `services/ai/`.
- **Evidence Store exists in research/design fixtures only:**
  - `tests/ollama-t2-04/evidenceHandoff.test.ts` — offline invariant demo (claim→ID→immutable `exactText`, passed 2026-09-18).
  - Per-experiment local stores in `tests/ollama-t2-05` through `tests/ollama-t2-09` — validated items, deterministic IDs, exact-substring gates (live-run once each, results in `benchmark-docs/results/`).
  - `services/ai-prototype/evidenceLedger.ts` — prototype deterministic ledger (explicitly fenced by `browserAiRuntime.test.ts:594` asserting no production import).
  - `docs/OLLAMA_T2-04_EVIDENCE_HANDOFF_DESIGN.md` — full two-stage design (deterministic extraction → evidence validation → Evidence Store → bounded reasoning → deterministic output validation).
- **Deterministic evidence validation is not yet part of the production AI path.** The research validators (exact-substring containment, ID existence, type checks, numeric dual-containment) are proven in fixtures but unbuilt in production.

### Production Stage-2 Validation (2026-09-18 audit finding)

- **Deterministic post-generation Stage-2/output validation is not yet implemented in production.** The only output handling in production is display (`SummarizePdfCard` renders the text). No deterministic post-generation validation of any kind is wired.
- The T2 research validators (containment/ID/type checks) work in fixtures but are **not** part of the production pipeline. Do not imply they are already production-integrated.

### Production Tier-1 Browser AI — implemented and verified (2026-09-11 documentation correction; 2026-09-18 audit re-verification)

| ID | Task | Status |
|---|---|---|
| AI-16 | Production Browser AI runtime (Tier 1), implementing the `AI-01` `AiRuntime` contract | ✅ **IMPLEMENTED + PRODUCTION-INTEGRATED + VERIFIED.** `services/ai/browser/browserAiRuntime.ts` (`BrowserAiRuntime`) + `browserAiWorker.ts` (Worker thread) + `workerProtocol.ts`. Model `onnx-community/Qwen2.5-0.5B-Instruct`, dtype `q4`, via `@huggingface/transformers` 4.2.0 (`services/ai/browser/constants.ts`; the only AI dependency in `package.json`). Pinned to the `wasm` backend — code comment and `selectBrowserAiDevice()` record that `webgpu` + this model/dtype fails deterministically at ONNX `InferenceSession.create()` with `std::bad_alloc`; the `selectDevice` injection seam for a future per-device WebGPU re-enable is intact and tested. Context bounded to `BROWSER_AI_MAX_CONTEXT_CHARACTERS = 8192` extracted characters (`boundContextChunks()` drops trailing whole chunks, never slices one, reports `contextTruncated`); output bounded to `BROWSER_AI_MAX_NEW_TOKENS = 256` new tokens. Lifecycle/cancellation/disposal implemented and tested: worker-token-gated init, real cancellation via Transformers.js `InterruptableStoppingCriteria`, `dispose()` settles pending init/generation with a distinct `AiRuntimeDisposedError`, thread-crash recovery, and a test proving a stale/disposed worker's late message cannot settle a later generation. Only `prompt` + `AiContextChunk[]` (already-extracted text) can reach this runtime — no PDF bytes, `File`, `Blob`, `ArrayBuffer`, password, page image, or thumbnail. Tests: `services/ai/browser/browserAiRuntime.test.ts` (~44 cases, passed 2026-09-18 audit run; asserts no `ai-prototype` import). |
| AI-17 | Provider-agnostic production AI orchestration + instruction templates (Summarize/Translate/Key Points/Ask) | ✅ **IMPLEMENTED + PRODUCTION-INTEGRATED + VERIFIED.** `services/ai/instructions.ts` (`buildAiInstructionPrompt` — pure, includes a prompt-injection guard and truncation/pages-without-text caveats) and `services/ai/orchestration.ts` (`runAiActionOnPdf`: PDF → `AI-02` context → empty-context guard (`AiEmptyContextError`) → instruction → injected `AiRuntime.generateText()`, propagating cancellation/errors unchanged). Depends only on the generic `AiRuntime` contract, not `BrowserAiRuntime` directly. Tests: `services/ai/instructions.test.ts`, `services/ai/orchestration.test.ts` (passed 2026-09-18 audit run). |
| AI-18 | Production Summarize PDF integration | ✅ **IMPLEMENTED + PRODUCTION-INTEGRATED + VERIFIED.** `components/SummarizePdfCard.tsx`, registered in `lib/toolCatalog.ts` (`summarize-pdf`, category `ai`) and `components/tools/toolRegistry.tsx`, live at `/tools/summarize-pdf`. Wires `AI-17`'s `runAiActionOnPdf` to `AI-16`'s `BrowserAiRuntime` (one instance reused across generations, disposed on unmount). Includes staged loading states, Cancel, per-error-type user messages, a stale-request guard, truncation disclosure, pages-without-extractable-text disclosure, and scoped Tier-1 privacy copy (no absolute "100% private"-style claim, consistent with SEC-06 §3.1/§8). Tests: `components/SummarizePdfCard.test.tsx` (15 cases, passed 2026-09-18 audit run; prior doc said 20). |
| AI-21 | Automated network-egress regression guard covering the AI/Phase 5 code paths | ✅ **IMPLEMENTED + VERIFIED.** `tests/network-egress.test.ts` statically scans `app/`, `components/`, `services/` (including `services/ai/`), and `lib/`; fails on any new `XMLHttpRequest`/`sendBeacon`/`WebSocket`/`FormData`, or on `fetch(` outside the two pre-reviewed call sites: `services/pdf/rasterize.ts` (local `data:` URL) and `services/ai/ollama/client.ts` (loopback Ollama). Includes a recorded Checkpoint 2A investigation confirming the only network activity the Browser AI path triggers is `@huggingface/transformers`' own model-asset download (fixed Hugging Face Hub/CDN destination, no document-derived content attached). This is the automated form of the previously-informal "SEC-02-adjacent network-interception" idea, tracked here as a completed Phase 5 task rather than a new/unfinished SEC checkpoint. Test passed 2026-09-18 audit run. |

**Honest supported envelope (Tier-1 Browser AI, as actually enforced in code):**
- Production context is bounded to **~8,192 extracted characters** (`BROWSER_AI_MAX_CONTEXT_CHARACTERS`); output is bounded to **256 new tokens** (`BROWSER_AI_MAX_NEW_TOKENS`). Longer documents are not rejected — they are truncated to this ceiling, and `SummarizePdfCard` discloses this via its truncation notice.
- This does **not** mean Browser AI has been shown to produce high-quality summaries for every document up to 8,192 characters — no committed evidence establishes production-quality output across arbitrary documents at that size; the ceiling describes what the runtime will *attempt*, not a quality guarantee.
- The Checkpoint 2A Map→Reduce prototype (`services/ai-prototype/`) remains **experimental only** — `services/ai/browser/browserAiRuntime.test.ts` asserts production code imports nothing from `ai-prototype`. It is not reachable from any production UI, is not part of the supported path, and is not being promoted based on current evidence (0.5B-model quality limitations on larger/real documents, not an infrastructure gap).

### T2 Research Sequence — T2-02 through T2-09 (all RESEARCH-ONLY)

All experiments are env-gated (`RUN_OLLAMA_T20X=1` / `RUN_OLLAMA_BENCHMARK=1`), use the same 6-page real PDF fixture and 6 AI-02 chunks, and append timestamped JSON evidence to `benchmark-docs/results/` (git-ignored). Live execution evidence exists for every experiment (files dated 2026-09-15→17). **Single-document, single-machine, single-run evidence only — not production readiness.**

| ID | Task | Status |
|---|---|---|
| T2-02 | Real-document Ollama benchmark (qwen3:4b, local) | 🔬 **RESEARCH-ONLY.** Drives production path: `buildAiTextContext` → `buildAiInstructionPrompt` → `OllamaRuntime.generateText` via recording client. 6-page cold ~123s, 3 warm ~106–110s, ~10 tok/s. Synthetic 20/50-page runs all `contextTruncated=true` (intentional boundary test). Sparse 50-page control 49s, no truncation. Live evidence in `benchmark-docs/results/t2-02-*.json`. |
| T2-03 | Fact Card PoC + evidence-fidelity experiment | 🔬 **RESEARCH-ONLY.** Per-chunk `format:"json"` cards → deterministic validator (verbatim excerpts, value-in-excerpt, closed causal list) → accepted cards → final summary. Best full-card run: **1/6 cards accepted**. Evidence-only extraction: **6/6 parseable, 23/23 exact excerpts (100%), 31/31 exact values (100%), 30/31 exact excerpts (~97%), 0 malformed, ~140s vs ~610–810s**. Key anomaly: chunk-2 put 18 numeric spans in `excerpts[]` with zero `numbers[]` entries — evidence located but mis-typed. **Negative finding preserved:** simultaneous find+copy+classify+compare degrades fidelity; separated extraction does not. |
| T2-04 | Evidence handoff design + offline fixture | 🔬 **RESEARCH/DESIGN-ONLY.** Two-stage architecture: Stage 1 evidence extraction → deterministic exact-substring validation → immutable Evidence Store (IDs `chunk-<i>-e<n>`) → Stage 2 fact cards citing IDs, fail-closed validation, no repair. `tests/ollama-t2-04/evidenceHandoff.test.ts` demonstrates the invariant (claim→ID→immutable `exactText`) plus negatives (unknown ID, Stage-2-emitted excerpt, non-verbatim Stage-1 text) — passed 2026-09-18 audit run. No live Ollama runs by design. Open questions: cross-chunk evidence, evidence budget, Stage-2 parseability. |
| T2-05 | Stage-2 evidence-ID reasoning | 🔬 **RESEARCH-ONLY.** Frozen T2-03 Stage-1 prompt → exact-substring validation → local store → Stage 2 fact cards citing `evidenceIds`; single attempt, no repair. Live: Stage 1: 6/6 parseable, 49 validated items. Stage 2: 6/6 parseable, **4/6 accepted, 0 inventedIds, 0 leakage** (~352s total). Supports ID-reference grounding model. |
| T2-06 | Deterministic numeric promotion A/B | 🔬 **RESEARCH-ONLY.** Same Stage-1 responses reused (byte-identical fairness). Variant A = model-typed; Variant B = local conservative promotion. 12/23 spans promoted (52%), **0 incorrect promotions**. Variant A: 5/6 accepted, **18 numericalFailures**; Variant B: 4/6 accepted, **1 numericalFailure**, 1 comparisonFailure. Deterministic typing cut numeric failures 18→1. Strongest positive result; single-doc. |
| T2-07 | Evidence-ID comparison reasoning | 🔬 **RESEARCH-ONLY.** Byte-identical stores. Variant A = frozen prompt; Variant B = prompt + comparison appendix. **All four pre-registered comparisons (WB-literacy, JH-literacy, literacy-gap, JH-IMR) = "missing" in BOTH variants.** Variant B caused 1 truncation. **Negative finding preserved:** comparison appendix did not produce a single signature-matching comparison claim. |
| T2-08 | Provenance enrichment | 🔬 **RESEARCH-ONLY.** Compact local provenance labeling (±250-char window, value-blind, "unknown beats wrong"). 53 items examined; 124 refused; 21 fully unknown. Variants A/B indistinguishable on cards (both 5/6 accepted, 18 numericalFailures). **All four comparisons still "missing".** Invariants held (0 inventedIds, 0 leakage, no repair). **Negative finding preserved:** post-hoc provenance from decontextualized spans does not unlock comparisons. |
| T2-09 | Attribution-aware evidence extraction | 🔬 **RESEARCH-ONLY.** Attribution captured during Stage-1 (24 calls). Stage 1B yield collapsed: **3 validated items vs 51 in 1A**; all attribution decisions rejected as "unsupported". Stage 2B produced **inventedIds = 6 (invariant `inventedIdsZeroB: false`)**; 3/6 accepted. All four comparisons "missing". Stored-text exactness held. **Negative finding preserved:** attribution-aware extraction strictly worse on yield and broke invented-IDs invariant; post-hoc (T2-08) also fails; attribution remains unsolved. |

**Aggregate negative findings (must remain visible):**
- Comparison reasoning remains unresolved across T2-07/T2-08/T2-09 (zero pre-registered comparisons emitted).
- Provenance enrichment did not solve comparisons.
- Attribution remains unresolved — both post-hoc and in-extraction approaches failed.
- T2-09 recorded an invented-ID invariant violation (6 invented IDs in Variant B).
- Live research evidence is single-document/single-run; it does not establish general model quality.

| T2-10 | (no repository evidence) | ⚪ **NOT VERIFIABLE** — no reference to T2-10 exists anywhere in the repository (grep across docs/tests/services/components/app/lib returns nothing). Do not recreate. |
| T2-11 | (no repository evidence) | ⚪ **NOT VERIFIABLE** — no reference to T2-11 exists anywhere in the repository. Do not recreate. |

### Tier-2 UI / Consent (2026-09-18 audit finding)

- **Ollama is not reachable from production UI.** `OllamaRuntime` is imported by nothing in `app/`, `components/`, or `lib/` (verified by grep).
- **Provider selection is not implemented.** No UI exists to choose between Browser AI and Ollama.
- **SEC-06 consent/disclosure for Tier 2 is not yet implemented.** `OllamaRuntime.capabilities.requiresConsent = true` exists in metadata, but no consent flow (§6/§7 wording) exists — currently harmless because no UI can invoke Ollama, but this is a prerequisite to satisfy before any Tier-2 UI wiring.

| AI-03 | Generic prompt-box UI (single screen, preset buttons prefill the box) | ⚪ Not started as originally spec'd. A dedicated Summarize card (`AI-18`) shipped instead of the generic single-screen prompt box this task describes — same underlying pipeline, different UI pattern. Translate/Key Points/Ask have no UI at all yet, though their instruction templates already exist (`AI-17`). |
| AI-04 | Preset: Summarize | ⚪ Not started as a preset inside a generic prompt box (AI-03). **Production Summarize capability is live via AI-18** (dedicated card), but the original "preset button prefills a single prompt box" pattern was not built. |
| AI-05 | Preset: Translate (text-first, not layout-preserving) | ⚪ Template only (`services/ai/instructions.ts:98-111`), unit-tested. No UI, no production path. |
| AI-06 | Preset: Key Points | ⚪ Template only (`services/ai/instructions.ts:113-119`), unit-tested. No UI, no production path. |
| AI-07 | Preset: Ask PDF / Q&A | ⚪ Template only (`services/ai/instructions.ts:121-135`), unit-tested. No UI, no production path. |
| — | **v1 exit gate:** AI-01 through AI-07 done, used in production, real usage data collected before anything below is greenlit | |
| AI-08 | Structured extraction (dedicated UI) | ⚪ Deferred to v1.5, gated on AI v1 usage |
| AI-09 | Metadata suggestions (dedicated "apply to fields" UI) | ⚪ Deferred to v1.5 |
| AI-10 | Table of contents generation | ⚪ Deferred to v1.5 |
| AI-11 | Semantic document search | ⚪ Deferred to v1.5 |
| AI-12 | Redaction detection + mandatory human confirmation | ⚪ Deferred to v1.5 |
| AI-13 | **AI PDF Agent** (multi-step orchestration, plan shown + confirmed before execution) | ⚪ Deferred to v2 — depends on AI-01–12 existing as callable tools, not just UI buttons |
| AI-14 | Multi-document Q&A | ⚪ Deferred to v2 |
| AI-15 | Enterprise/private deployment options | ⚪ Deferred to v2 |
| AI-19 | (undefined) | ⚪ **NOT VERIFIABLE** — no definition exists in repository (not in code, roadmap, or this file). Do not invent. |
| AI-20 | (undefined) | ⚪ **NOT VERIFIABLE** — no definition exists in repository. Do not invent. |

**Blocked by:** SEC-06/SEC-07 (Phase 4) for AI-01/AI-02 — both done. A Browser AI (Tier 1) provider (`AI-16`), production orchestration (`AI-17`), and a shipped Summarize integration (`AI-18`) are implemented and verified. **Ollama (Tier 2) runtime (`T2-01`) exists but is not production-wired; no provider-selection UI, no consent flow.** BYOK/Advanced (Tier 3), Translate/Key Points/Ask UIs, and Cloud AI remain not started.

### Tier-1 Browser AI closure status (2026-09-18 audit reconciliation)

- **Implementation/foundation:** substantially complete and verified (`AI-01`, `AI-02`, `AI-16`, `AI-17`, `AI-21`).
- **Production Summarize PDF integration:** implemented and verified (`AI-18`).
- **Production Summarize PDF E2E regression coverage:** test **exists** at `tests/e2e/summarize-pdf.integration.spec.ts` (exercises the real `/tools/summarize-pdf` route, real PDF upload, production Browser AI/WASM inference, and a non-empty rendered summary without mocks). **Current pass status was NOT established during the 2026-09-18 audit** — the test was not run; `playwright-report/` contains only an `index.html` shell. Do not convert test existence into "verified passing" without a fresh run.
- **User-facing supported-envelope disclosure:** complete — `components/SummarizePdfCard.tsx` states the ~8,192 extracted-character request bound, possible truncation, local-browser processing, and variable quality; `components/SummarizePdfCard.test.tsx` covers that disclosure.
- **READY TO CLOSE TIER-1 BROWSER AI** pending: (a) fresh E2E run on `/tools/summarize-pdf`, (b) Brave browser QA, (c) final review, (d) commit and push.

## Phase 6 — Unified PDF Workspace & SaaS UX
**Status: 🔴 Not started.**

## Phase 7 — Automated Testing & CI
**Status: 🟡 Partially started.**

| ID | Task | Status |
|---|---|---|
| CI-01 | Vitest installed/configured | ✅ Done — 75/75 unit tests passing |
| CI-02 | Playwright installed/configured | ✅ Done |
| CI-03 | Fixtures (normal/large/malformed/encrypted/scanned/etc.) | 🟡 Partial — some exist, not systematically catalogued |
| CI-04 | Browser E2E for every tool | 🟡 Partial — compression covered (CMP-02) and Summarize PDF / Tier-1 Browser AI has production E2E coverage (`tests/e2e/summarize-pdf.integration.spec.ts`); others not confirmed. |
| CI-05 | CI pipeline (`.github/workflows`) | 🔴 Not started — directory doesn't exist |

## Phase 8 — Production Launch
**Status: 🔴 Not started.**

## Phase 9 — Future Product Expansion
**Status: ⚪ Deferred by design.** Digital signatures, batch processing, user accounts, subscriptions, developer API. (tesseract.js is *not* an unused dependency to clean up — it's live in `services/pdf/orientation.ts`; remove that item if it resurfaces.)

---

## Reading this file
- 🟢/✅ Done — code + test/verification exists
- 🟡 Partial — some real evidence, real gap remains, gap is named above
- 🔴 Not done / not started
- ⚪ Deferred by design — not a gap, a deliberate scope decision

**Right now:** Phase 4's SEC-01 through SEC-07 are done. Phase 5's Tier-1 Browser AI foundation (AI-01, AI-02, AI-16, AI-17, AI-21) and the production Summarize PDF integration (AI-18) are implemented and **READY TO CLOSE PHASE 1 / Tier-1 Browser AI** pending final verification, Brave browser QA, final review, commit, and push. Ollama (Tier 2), BYOK/Advanced (Tier 3), Translate/Key Points/Ask UIs, and Cloud AI remain not started.
