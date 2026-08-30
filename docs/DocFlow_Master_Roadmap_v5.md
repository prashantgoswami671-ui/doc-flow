# DocFlow — Master Product Roadmap (v5)
Single source of truth • Revision date: 2026-08-27 (revision 4 — adds AI Document Intelligence phase; supersedes v4)

**Vision:** A privacy-first PDF workspace with local/self-hosted AI — not a PDF utility site with some AI buttons bolted on.

**This document lists PHASES ONLY.** Detailed task-level status, what's done, what's left, and per-task IDs live in `docs/DOCFLOW_STATUS.md` — that file is updated continuously; this file only changes when a phase is added, closed, or genuinely rescoped. Never add sub-phase numbers here (no "5.1", "5.4a") — that's exactly how the roadmap became untrackable before. Flat task IDs like `AI-01` belong in the status doc only.

**Before starting any new task:** check `lib/toolCatalog.ts` and `components/tools/toolRegistry.tsx` for what's actually built, and check `docs/DOCFLOW_STATUS.md` for what's already done. Do not re-open a phase marked closed without new evidence.

### Revision history
- v1→v2: recognized Organize/Core Tools were already built, added Metadata/Watermark, gave testing/CI its own phase.
- v2→v3: separated hardening/UX/new-capabilities as distinct concerns, added audit checklists, moved Security ahead of SaaS UX.
- v3→v4: reconciled against a live repository audit (git history, test runs, direct code reading) — closed Phase 2 with written evidence, corrected stale test-framework and tesseract.js claims, flagged the Phase 1 UploadZone adoption gap.
- **v4→v5:** inserts a new Phase 5 — AI Document Intelligence, self-hosted via Ollama, scoped deliberately small for v1 (one pipeline + one generic prompt UI, not six separate feature builds) with everything else gated on real usage data. Existing Phase 5 (SaaS UX) and beyond shift down by one. Splits phase-level tracking (this file) from task-level tracking (`DOCFLOW_STATUS.md`) going forward.
- **v5 + SEC-07 amendment (2026-08-31):** re-scopes Phase 5 from "Ollama first" to the approved three-tier architecture (Tier 1 Browser AI, Tier 2 Browser AI + Ollama, Tier 3 advanced local/BYOK, future Cloud AI), staged behind checkpoints/gates starting with Checkpoint 1 (the `AI-01`/`AI-02` provider-agnostic foundation, no provider implemented). Does not change the v1/v1.5/v2 feature staging itself, only which provider(s) sit underneath it. See `docs/SEC-06-AI-DATA-POLICY.md` §3 and `docs/DOCFLOW_STATUS.md` (SEC-07, AI-01, AI-02).

---

## Phase 0 — Foundation & Roadmap Control
Next.js/TS/Tailwind foundation, git workflow, shared component foundation, tool catalog/registry as source of truth.

## Phase 1 — Shared UX Consistency
All 14 tools share upload/processing/error/result patterns.

## Phase 2 — PDF Reliability & Hardening
Make the existing 14 tools trustworthy, not just visually working.

## Phase 3 — Compression & Optimization
Prove the compression engine reliable, then polish its UX.

## Phase 4 — Security & Privacy
Audit where PDFs/text are processed, temp-file cleanup, honest password/protection UX, privacy messaging. **Rescoped in v5:** must now explicitly cover the AI data path too (client-only PDF processing vs. what gets sent to the local AI server, retention, transmission, consent) — not just the browser-only model assumed in v3.

## Phase 5 — AI Document Intelligence *(new in v5, re-scoped by SEC-07)*
A provider-agnostic, local-first AI layer, built behind a capability-based provider/runtime abstraction (`AI-01`) so it is not permanently locked to any single provider. **Re-scoped by SEC-07** (see `docs/SEC-06-AI-DATA-POLICY.md` §3): the architecture is staged into three tiers rather than "Ollama first":

- **Tier 1 — Browser AI:** AI inference that runs entirely inside the browser. No content-bearing data (original PDF or extracted text) ever leaves the browser in this mode, so it requires no remote-provider consent flow — only factual, scoped disclosure (never "100% private"-style claims).
- **Tier 2 — Browser AI + Ollama:** adds a user-controlled local Ollama service (verified loopback/local) as a second, opt-in, consent-gated option alongside Browser AI.
- **Tier 3 — Advanced local/BYOK:** larger/local Ollama models, or a user-supplied BYOK (bring-your-own-key) third-party provider. BYOK may be used directly from the browser to the provider (no DocFlow-controlled proxy), since the key is user-supplied and controlled — never described as local processing.
- **Future — Cloud AI:** a DocFlow-hosted/mediated cloud provider. Not scoped or built as part of Checkpoint 1 or this document's v1/v1.5/v2 staging below.

All AI processing sits on the same local PDF/text-processing foundation: text extraction and chunking happen in the browser (`AI-02`) before anything is ever considered for a Tier 2/3 provider, and only minimized text/chunks (never the original PDF, `File`, password, page images, thumbnails, or metadata) may leave the browser at all — see SEC-06 §1/§2/§9.

Feature scope remains staged as before, now implemented as a series of checkpoints/gates rather than landing all at once:

- **Checkpoint 1 (done):** the provider-agnostic foundation only — `AI-01` (capability-based provider/runtime contract, no provider implemented) and `AI-02` (browser-side text extraction → bounded, page-aware chunking, no provider called). No Browser AI, Ollama, BYOK, tool calling, semantic search, embeddings, or prompt/chat UI exists yet. Gate: explicit review/approval required before Checkpoint 2.
- **v1 (Checkpoint 2 onward, once reached):** one text-extraction → chunking → provider → result pipeline (starting with Browser AI/Tier 1, then Tier 2 Ollama), exposed through a single generic "what do you want done with this PDF?" prompt box with a few preset buttons (Summarize / Translate / Key Points / Ask) that just prefill the box. Not six separate features — one pipeline wearing a few labels.
- **v1.5 (build only if v1 usage justifies it):** dedicated UIs for structured extraction and metadata suggestions, table-of-contents generation, semantic search, redaction (detection + mandatory human confirmation, never automatic).
- **v2 (future):** the **AI PDF Agent** — orchestrates the tools above plus existing PDF services (delete/rotate/translate/summarize/compress in one instruction), always shows its plan and requires confirmation before executing, never silent multi-step execution. Also: multi-document Q&A, enterprise/private deployment (Tier 3/Cloud AI).

Explicitly out of scope indefinitely: AI image generation, general-purpose writing assistant features unrelated to PDFs, rebuilding OCR from scratch, autonomous PDF-modifying agents without confirmation.

## Phase 6 — Unified PDF Workspace & SaaS UX
Professional homepage, unified navigation, consistent tool pages, accessibility — designed around the finished AI tools from Phase 5, not retrofitted after.

## Phase 7 — Automated Testing & CI
Test frameworks, fixtures, browser E2E for every tool (including AI flows), CI pipeline.

## Phase 8 — Production Launch
Deployment, monitoring, domain, privacy policy/terms, final regression pass — including where the Ollama server actually runs in production.

## Phase 9 — Future Product Expansion
Digital signatures, batch processing, user accounts, subscriptions, developer API. (AI Chat/summarization moved out of this phase into Phase 5 in v5 — this phase is now genuinely far-future only.)

---

## Standard Task Workflow
Plan → Design → Implement → Verify (tsc/lint/build) → Browser QA → Review → Commit → Push.

**Decision gate:** before starting anything, check this file for phase order and `docs/DOCFLOW_STATUS.md` for current task status. No phase gets added or reordered here without an explicit decision recorded in the revision history above.
