# DocFlow — Status Tracker
Last reconciled: 2026-08-31 (SEC-07 + AI-01/AI-02 Checkpoint 1), against direct code read of the new `services/ai/` files and `docs/SEC-06-AI-DATA-POLICY.md`; tsc/lint/build/test were not re-run in that session (no execution access) — see the AI-02 row and the Checkpoint 1 report for what still needs to be verified. Prior reconciliation: 2026-08-28, against live repo audit (git log, npm test, tsc, eslint, direct code read) + `docs/DocFlow_Master_Roadmap_v5.md`. **Latest reconciliation: 2026-09-11 (documentation-only correction).** Direct code read found this file understated actual progress: a production Browser AI runtime (`services/ai/browser/`), provider-agnostic orchestration (`services/ai/orchestration.ts`, `instructions.ts`), and a shipped `SummarizePdfCard` (registered in `lib/toolCatalog.ts` / `components/tools/toolRegistry.tsx`, live at `/tools/summarize-pdf`) already exist, each with colocated tests read directly — well past what "Checkpoint 1, no provider implemented" described. This pass corrects Phase 4/5 status to match; it changes no code, tests, or the roadmap. tsc/lint/build/test were not re-run in this session (documentation-only task, no execution access) — treat those as still needing a fresh run, not as re-verified by this update.

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
**Status: 🟡 Tier-1 Browser AI foundation and a production Summarize PDF integration are implemented; closure work remains — see "Tier-1 Browser AI closure status" below.**

| ID | Task | Status |
|---|---|---|
| AI-01 | Capability-based AI provider/runtime abstraction (contract only — supports Browser AI/Ollama/BYOK/future Cloud AI without redesign) | ✅ **Checkpoint 1 done.** `services/ai/types.ts` defines `AiRuntime`/`AiCapabilities`/`AiTextGenerationRequest` (capability-based, not tier-based); prohibited fields (`file`, `blob`, `fileBytes`, `arrayBuffer`, `password`, `pageImage`, `thumbnail`, `metadata`) are typed `never` and additionally rejected at runtime by `services/ai/validation.ts` (`assertValidAiTextGenerationRequest`, `assertValidAiCapabilities`, `containsDisallowedBinaryPayload` deep scan). At Checkpoint 1, no provider was implemented against this contract yet — **that is no longer current**: a Browser AI (Tier 1) provider now implements it in production, see `AI-16` below. Tests: `services/ai/validation.test.ts`. |
| AI-02 | Text extraction → bounded, page-aware chunking pipeline for AI input (browser-side; calls no AI provider) | ✅ **Checkpoint 1 done.** `services/ai/extraction.ts` extracts page-aware plain text via PDF.js `getTextContent()` (separate from `services/pdf/extract.ts`, which only copies pages — no text-extraction logic existed there to reuse); `services/ai/chunking.ts` produces bounded `AiContextChunk`s (`MAX_CHUNK_CHARACTERS`/`MAX_CHUNKS_PER_REQUEST`/`MAX_TOTAL_CONTEXT_CHARACTERS` in `services/ai/constants.ts`); `services/ai/pipeline.ts` (`buildAiTextContext`) wires both together end-to-end. Supports explicit page scope (all/selected/subset). Scanned/image-only pages report `hasExtractableText: false` with no OCR invoked and no fabricated content. No network call anywhere in `services/ai/`. Tests: `services/ai/extraction.test.ts`, `services/ai/chunking.test.ts`, `services/ai/pipeline.test.ts`, reusing existing fixtures from `services/pdf/__fixtures__`. Colocated test files were read directly during the 2026-09-11 documentation pass and exist as described; their current pass/fail status has not been independently re-run as part of that documentation-only update — `npx tsc --noEmit`, `npm run lint`, `npm run build`, and `npm test` (incl. `tests/network-egress.test.ts`) still need a fresh run recorded here. |

### Browser AI prototype / Checkpoint 2A benchmark finding

A controlled Map→Reduce benchmark of the Browser AI (WASM) prototype was run against a synthetic 41-page fixture:

- Map→Reduce prototype successfully processed the controlled 41-page fixture using batch=6.
- 7 Map + 1 Reduce = 8 generations.
- Controlled total: ~29.5 minutes.
- Batch=3 comparison: ~42.4 minutes / 15 generations.
- Conclusion: Map→Reduce is technically viable for bounded-context scaling, but current WASM latency/variability is not production-ready.
- Full data and analysis: `docs/AI_BROWSER_PROTOTYPE_BENCHMARK.md`.

This is prototype evidence only. It does not change the production AI-02 implementation or its constants, and does not mark any new AI task complete beyond what is already recorded above.

### Production Tier-1 Browser AI — implemented (found during 2026-09-11 documentation correction)

The following exists in the repository today, wired to production (not the Checkpoint 2A prototype above), and this file previously did not record it:

| ID | Task | Status |
|---|---|---|
| AI-16 | Production Browser AI runtime (Tier 1), implementing the `AI-01` `AiRuntime` contract | ✅ Done. `services/ai/browser/browserAiRuntime.ts` (`BrowserAiRuntime`) + `browserAiWorker.ts` (Worker thread) + `workerProtocol.ts`. Model `onnx-community/Qwen2.5-0.5B-Instruct`, dtype `q4`, via `@huggingface/transformers` 4.2.0 (`services/ai/browser/constants.ts`; the only AI dependency in `package.json`). Pinned to the `wasm` backend — code comment and `selectBrowserAiDevice()` record that `webgpu` + this model/dtype fails deterministically at ONNX `InferenceSession.create()` with `std::bad_alloc`; the `selectDevice` injection seam for a future per-device WebGPU re-enable is intact and tested. Context bounded to `BROWSER_AI_MAX_CONTEXT_CHARACTERS = 8192` extracted characters (`boundContextChunks()` drops trailing whole chunks, never slices one, reports `contextTruncated`); output bounded to `BROWSER_AI_MAX_NEW_TOKENS = 256` new tokens. Lifecycle/cancellation/disposal implemented and tested: worker-token-gated init, real cancellation via Transformers.js `InterruptableStoppingCriteria`, `dispose()` settles pending init/generation with a distinct `AiRuntimeDisposedError`, thread-crash recovery, and a test proving a stale/disposed worker's late message cannot settle a later generation. Only `prompt` + `AiContextChunk[]` (already-extracted text) can reach this runtime — no PDF bytes, `File`, `Blob`, `ArrayBuffer`, password, page image, or thumbnail. Tests: `services/ai/browser/browserAiRuntime.test.ts`. |
| AI-17 | Provider-agnostic production AI orchestration + instruction templates (Summarize/Translate/Key Points/Ask) | ✅ Done. `services/ai/instructions.ts` (`buildAiInstructionPrompt` — pure, includes a prompt-injection guard and truncation/pages-without-text caveats) and `services/ai/orchestration.ts` (`runAiActionOnPdf`: PDF → `AI-02` context → empty-context guard (`AiEmptyContextError`) → instruction → injected `AiRuntime.generateText()`, propagating cancellation/errors unchanged). Depends only on the generic `AiRuntime` contract, not `BrowserAiRuntime` directly. Tests: `services/ai/instructions.test.ts`, `services/ai/orchestration.test.ts`. |
| AI-18 | Production Summarize PDF integration | ✅ Done. `components/SummarizePdfCard.tsx`, registered in `lib/toolCatalog.ts` (`summarize-pdf`, category `ai`) and `components/tools/toolRegistry.tsx`, live at `/tools/summarize-pdf`. Wires `AI-17`'s `runAiActionOnPdf` to `AI-16`'s `BrowserAiRuntime` (one instance reused across generations, disposed on unmount). Includes staged loading states, Cancel, per-error-type user messages, a stale-request guard, truncation disclosure, pages-without-extractable-text disclosure, and scoped Tier-1 privacy copy (no absolute "100% private"-style claim, consistent with SEC-06 §3.1/§8). Tests: `components/SummarizePdfCard.test.tsx` (20 cases). |
| AI-21 | Automated network-egress regression guard covering the AI/Phase 5 code paths | ✅ Done. `tests/network-egress.test.ts` statically scans `app/`, `components/`, `services/` (including `services/ai/`), and `lib/`; fails on any new `XMLHttpRequest`/`sendBeacon`/`WebSocket`/`FormData`, or on `fetch(` outside the one pre-reviewed local `data:`-URL call in `services/pdf/rasterize.ts`. Includes a recorded Checkpoint 2A investigation confirming the only network activity the Browser AI path triggers is `@huggingface/transformers`' own model-asset download (fixed Hugging Face Hub/CDN destination, no document-derived content attached). This is the automated form of the previously-informal "SEC-02-adjacent network-interception" idea, tracked here as a completed Phase 5 task rather than a new/unfinished SEC checkpoint. |

**Honest supported envelope (Tier-1 Browser AI, as actually enforced in code):**
- Production context is bounded to **~8,192 extracted characters** (`BROWSER_AI_MAX_CONTEXT_CHARACTERS`); output is bounded to **256 new tokens** (`BROWSER_AI_MAX_NEW_TOKENS`). Longer documents are not rejected — they are truncated to this ceiling, and `SummarizePdfCard` discloses this via its truncation notice.
- This does **not** mean Browser AI has been shown to produce high-quality summaries for every document up to 8,192 characters — no committed evidence establishes production-quality output across arbitrary documents at that size; the ceiling describes what the runtime will *attempt*, not a quality guarantee.
- The Checkpoint 2A Map→Reduce prototype (`services/ai-prototype/`) remains **experimental only** — `services/ai/browser/browserAiRuntime.test.ts` asserts production code imports nothing from `ai-prototype`. It is not reachable from any production UI, is not part of the supported path, and is not being promoted based on current evidence (0.5B-model quality limitations on larger/real documents, not an infrastructure gap).

| ID | Task | Status |
|---|---|---|
| AI-03 | Generic prompt-box UI (single screen, preset buttons prefill the box) | ⚪ Not started as originally spec'd. A dedicated Summarize card (`AI-18`) shipped instead of the generic single-screen prompt box this task describes — same underlying pipeline, different UI pattern. Translate/Key Points/Ask have no UI at all yet, though their instruction templates already exist (`AI-17`). |
| AI-04 | Preset: Summarize | ⚪ Not started — prompt template only, on top of AI-01–03 |
| AI-05 | Preset: Translate (text-first, not layout-preserving) | ⚪ Not started |
| AI-06 | Preset: Key Points | ⚪ Not started |
| AI-07 | Preset: Ask PDF / Q&A | ⚪ Not started |
| — | **v1 exit gate:** AI-01 through AI-07 done, used in production, real usage data collected before anything below is greenlit | |
| AI-08 | Structured extraction (dedicated UI) | ⚪ Deferred to v1.5, gated on AI v1 usage |
| AI-09 | Metadata suggestions (dedicated "apply to fields" UI) | ⚪ Deferred to v1.5 |
| AI-10 | Table of contents generation | ⚪ Deferred to v1.5 |
| AI-11 | Semantic document search | ⚪ Deferred to v1.5 |
| AI-12 | Redaction detection + mandatory human confirmation | ⚪ Deferred to v1.5 |
| AI-13 | **AI PDF Agent** (multi-step orchestration, plan shown + confirmed before execution) | ⚪ Deferred to v2 — depends on AI-01–12 existing as callable tools, not just UI buttons |
| AI-14 | Multi-document Q&A | ⚪ Deferred to v2 |
| AI-15 | Enterprise/private deployment options | ⚪ Deferred to v2 |

**Blocked by:** SEC-06/SEC-07 (Phase 4) for AI-01/AI-02 — both done. A Browser AI (Tier 1) provider (`AI-16`), production orchestration (`AI-17`), and a shipped Summarize integration (`AI-18`) have since landed. Ollama (Tier 2), BYOK/advanced local (Tier 3), Translate/Key Points/Ask UIs, and Cloud AI remain not started.

### Tier-1 Browser AI closure status (2026-09-11)

- **Implementation/foundation:** substantially complete (`AI-01`, `AI-02`, `AI-16`, `AI-17`, `AI-21`).
- **Production Summarize PDF integration:** implemented (`AI-18`).
- **Production Summarize PDF E2E regression coverage:** complete — `tests/e2e/summarize-pdf.integration.spec.ts` exercises the real `/tools/summarize-pdf` route, real PDF upload, production Browser AI/WASM inference, and a non-empty rendered summary without mocks.
- **User-facing supported-envelope disclosure:** complete — `components/SummarizePdfCard.tsx` states the ~8,192 extracted-character request bound, possible truncation, local-browser processing, and variable quality; `components/SummarizePdfCard.test.tsx` covers that disclosure.
- **READY TO CLOSE PHASE 1 / Tier-1 Browser AI** pending final verification, Brave browser QA, final review, commit, and push.

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
