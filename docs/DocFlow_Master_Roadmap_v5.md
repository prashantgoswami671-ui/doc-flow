# DocFlow — Master Product Roadmap (v5)
Single source of truth • Revision date: 2026-08-27 (revision 4 — adds AI Document Intelligence phase; supersedes v4)

**Vision:** A privacy-first PDF workspace with local/self-hosted AI — not a PDF utility site with some AI buttons bolted on.

**This document lists PHASES ONLY.** Detailed task-level status, what's done, what's left, and per-task IDs live in `docs/DOCFLOW_STATUS.md` — that file is updated continuously; this file only changes when a phase is added, closed, or genuinely rescoped. Never add sub-phase numbers here (no "5.1", "5.4a") — that's exactly how the roadmap became untrackable before. Flat task IDs like `AI-01` belong in the status doc only.

**Before starting any new task:** check `lib/toolCatalog.ts` and `components/tools/toolRegistry.tsx` for what's actually built, and check `docs/DOCFLOW_STATUS.md` for what's already done. Do not re-open a phase marked closed without new evidence.

### Revision history
- v1→v2: recognized Organize/Core Tools were already built, added Metadata/Watermark, gave testing/CI its own phase.
- v2→v3: separated hardening/UX/new-capabilities as distinct concerns, added audit checklists, moved Security ahead of SaaS UX.
- v3→v4: reconciled against a live repository audit (git history, test runs, direct code reading) — closed Phase 2 with written evidence, corrected stale test-framework and tesseract.js claims, flagged the Phase 1 UploadZone adoption gap.
- **v4→v5 (this revision):** inserts a new Phase 5 — AI Document Intelligence, self-hosted via Ollama, scoped deliberately small for v1 (one pipeline + one generic prompt UI, not six separate feature builds) with everything else gated on real usage data. Existing Phase 5 (SaaS UX) and beyond shift down by one. Splits phase-level tracking (this file) from task-level tracking (`DOCFLOW_STATUS.md`) going forward.

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

## Phase 5 — AI Document Intelligence *(new in v5)*
Self-hosted AI layer via Ollama, behind a provider abstraction so it's not permanently locked to Ollama. Scope is deliberately staged:

- **v1 (build now, once reached):** one text-extraction → chunking → Ollama → result pipeline, exposed through a single generic "what do you want done with this PDF?" prompt box with a few preset buttons (Summarize / Translate / Key Points / Ask) that just prefill the box. Not six separate features — one pipeline wearing a few labels.
- **v1.5 (build only if v1 usage justifies it):** dedicated UIs for structured extraction and metadata suggestions, table-of-contents generation, semantic search, redaction (detection + mandatory human confirmation, never automatic).
- **v2 (future):** the **AI PDF Agent** — orchestrates the tools above plus existing PDF services (delete/rotate/translate/summarize/compress in one instruction), always shows its plan and requires confirmation before executing, never silent multi-step execution. Also: multi-document Q&A, enterprise/private deployment.

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
