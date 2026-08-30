# DocFlow — Master Product Roadmap (v4)
Single source of truth • Revision date: 2026-08-27 (revision 3 — reconciled against actual repository state via full code/test audit; supersedes v3)

**Vision:** Turn DocFlow from a collection of working PDF utilities into a professional, unified, privacy-focused PDF SaaS.

**Roadmap rule:** If future work starts drifting into unrelated features, return to this document and continue from the next unfinished phase.

**Before starting any new task**, check `lib/toolCatalog.ts` and `components/tools/toolRegistry.tsx` — those files, not memory, are the source of truth for what's actually built. **Also check this document's "Current Sequence" section and `docs/PHASE_2_EXIT_REVIEW.md` before treating any Phase 0–2 item as open — they may already be closed with written evidence.**

### Revision history
- v1 → v2: recognized Organize/Core Tools were already built, added missing tools (Metadata, Watermark), gave testing/CI its own phase, preserved the deferred product vision.
- v2 → v3: distinguished hardening / product UX / new capabilities as separate concerns; added audit checklists; reordered Security & Privacy ahead of SaaS UX polish; restored the note on the tesseract.js dependency.
- **v3 → v4 (this revision):** reconciled the whole document against a live audit of the actual repository (git history, `npm test`, `tsc`, `eslint`, direct code reading) instead of prior status text. Specifically:
  - **Phase 2 moved from "current focus" to CLOSED.** `docs/PHASE_2_EXIT_REVIEW.md` already exists (written 2026-08-24) with a per-tool, evidence-based audit of all 14 services. Independently re-verified — holds up. Do not re-open Phase 2 items without new evidence contradicting that review.
  - **Phase 3 status corrected from "not started" to "substantially in progress."** Six sub-items (informally numbered 3.1–3.6 in code comments) are done and unit-tested: compression baseline tests, Light-setting validation, a real-rasterizer gap-analysis report, rotation-metadata preservation, a canvas-overflow guard, and a non-finite-dimension guard. See Phase 3 section below for what's still open.
  - **Removed the stale Phase 6 claim of "zero test framework."** False as of this revision — `vitest` and `@playwright/test` are both installed and configured, with 75 passing unit tests. What's still genuinely missing for Phase 6 is CI (no `.github/workflows`) and *executed* (not just written) browser E2E confirmation.
  - **Removed the stale Phase 8 claim that tesseract.js is unused.** It's the working engine behind the Phase 2.1 OCR orientation fix.
  - **Added a Phase 1 exit-gate gap** that no prior audit had flagged: only 8 of 14 tool cards use the shared `UploadZone` component. Organize Pages, Insert Pages, Merge PDF, Image→PDF, **Compress PDF**, and Watermark still have custom upload implementations. Phase 1's exit gate cannot be marked fully closed until this is resolved or explicitly deferred.

---

## Phase 0 — Foundation & Roadmap Control
**Status: Complete.**
- Next.js + TypeScript + Tailwind foundation
- Git/GitHub workflow
- Shared UploadZone, ResultPanel/ResultCard, thumbnail/preview foundation *(components exist and are the standard — see Phase 1 for adoption gap)*
- Tool catalog/registry established as source of truth
- Standard workflow: Plan → Design → Implement → Typecheck/Lint/Build → Browser QA → Review → Commit → Push

## Phase 1 — Shared UX Consistency
**Status: Nearly complete — one concrete gap open.**

Confirmed via direct code inspection (2026-08-27):

| Uses shared `UploadZone` | Custom upload implementation |
|---|---|
| Extract Pages, Split PDF, PDF→Image, Fix Orientation, Repair/Validate, Metadata Editor, Protect PDF, Unlock PDF | Organize Pages, Insert Pages, Merge PDF, Image→PDF, **Compress PDF**, Watermark |

**Exit gate (not yet met):** all 14 tools use the shared UploadZone foundation, *or* each remaining custom implementation is reviewed and explicitly accepted as an intentional exception (e.g. Organize Pages' multi-select workspace may have a legitimate reason to differ). Until that review happens, Phase 1 stays open on this one item — everything else (processing/error/success states, result/download experience, thumbnail/preview behavior) is in place.

## Phase 2 — PDF Reliability & Hardening
**Status: 🟢 CLOSED.** See `docs/PHASE_2_EXIT_REVIEW.md` for the full per-tool evidence. Summary:
- 2.1 Orientation: OCR-based detector (`services/pdf/orientation.ts`), 12 unit tests, ties/uncertainty resolve to "needs-review" not "normal."
- 2.2 Compress PDF: genuine dedicated flow via `CompressPdfCard`, Light/Heavy/Custom all real, target-size binary search implemented.
- 2.3 All 14 services individually audited against Input→Processing→Error→Output→Edge-cases.
- 2.4 Malformed/encrypted/empty/out-of-range/duplicate/reversed-range cases explicitly handled across services.
- 2.5 Metadata + Watermark held to the same standard, confirmed.
- 2.6 Exit review written and stands.

**Do not re-open this phase without new contradicting evidence.** The one thing the exit review honestly flagged as unverified (not "not done") — actual browser QA execution against `test-pdf-orientation.pdf`, race conditions, memory behavior — is Phase 6 territory by the roadmap's own sequencing, not a Phase 2 gap.

## Phase 3 — Compression & Optimization
**Status: Substantially in progress.** Only polish compression UX once the engine is proven reliable — the engine side is now proven.

**Done (verified 2026-08-27 via code read + passing tests):**
- Real-rasterizer gap analysis (`PHASE_3_3_INSPECTION_REPORT.md`) and a Playwright integration harness (`tests/e2e/compression.integration.spec.ts`, `app/test/compression/page.tsx`) exercising the actual (non-mocked) canvas/JPEG/pdf-lib path.
- Rotation metadata preservation on compressed output (`outputPage.setRotation(...)`).
- Canvas-overflow guard (`MAX_CANVAS_DIMENSION = 16384`, `computeSafeRenderScale`).
- Non-finite render/canvas-dimension guard (`computeSafeCanvasDimension`).
- Compression UX: before/after size and percentage reduction confirmed wired into `CompressPdfCard`.

**Open / unverified:**
- The Playwright E2E suite above exists and is written to cover the real rasterizer path, but has not been confirmed to actually pass in a real browser run since the 3.4–3.6 fixes landed. Run `npm run test:e2e` once to close this out.
- "Quality explanation" UX copy (per the original roadmap's Phase 3 UX checklist) not confirmed present.

## Phase 4 — Security & Privacy
**Status: Not started, except one item already confirmed.**
- ✅ Confirmed: `ai_assistant.py`, `agent_filesystem.py`, `coding_agent.py` are not imported anywhere in `app/`, `components/`, or `services/` — dev tooling is cleanly separated from the production bundle.
- Not yet audited: where PDFs are processed / whether anything leaves the browser, temp-file cleanup, password/protection UX honesty, privacy messaging and documentation.

## Phase 5 — Unified PDF Workspace & SaaS UX
**Status: Not started.** Unchanged from v3.

## Phase 6 — Automated Testing & CI
**Status: Partially started — corrected from v3's stale "not established."**
- ✅ Vitest installed and configured, 75/75 unit tests passing.
- ✅ Playwright installed and configured, with a real-rasterizer E2E spec already written (see Phase 3).
- ❌ No `.github/workflows` — CI pipeline itself does not exist yet.
- ❌ E2E suite execution not recently confirmed (see Phase 3).

## Phase 7 — Production Launch
**Status: Not started.** Unchanged from v3.

## Phase 8 — Future Product Expansion
**Status: Intentionally deferred.**
- OCR: **tesseract.js is no longer an unused dependency** — it's actively used by the Phase 2.1 orientation detector. Remove this item from any future dead-dependency cleanup task.
- AI Chat with PDF, AI summarization, digital signatures, batch processing, user accounts, subscriptions, developer API — all still deferred, unchanged from v3.

---

## Current Sequence
1. Phase 0 — Foundation & Control — **complete**
2. Phase 1 — Shared UX Consistency — **nearly complete** (UploadZone gap on 6 tools is the one open item)
3. Phase 2 — Reliability & Hardening — **closed** (see exit review)
4. **Phase 3 — Compression & Optimization ← WE ARE HERE** (engine done, E2E confirmation + UX copy remaining)
5. Phase 4 — Security & Privacy — not started
6. Phase 5 — Unified SaaS UX — not started
7. Phase 6 — Testing & CI — partially started (frameworks in place, CI pipeline missing)
8. Phase 7 — Production Launch — not started
9. Phase 8 — Future Expansion — deferred

**Immediate next-phase queue (Phase 3 close-out, in order):**
1. Run `npm run test:e2e` and confirm the real-rasterizer Playwright suite passes against current code.
2. Confirm or write the "quality explanation" UX copy for Compress PDF.
3. Resolve or explicitly defer the Phase 1 UploadZone gap on Organize/Insert/Merge/Image→PDF/Compress/Watermark.
4. Phase 3 exit review (mirror the format of `docs/PHASE_2_EXIT_REVIEW.md`).

This document intentionally stops there. Do not auto-generate Phase 4/5/6 task breakdowns until Phase 3 is formally closed — that's how phase-tracking drift happened before.

---

## Standard Task Workflow
*(unchanged from v3)*

| # | Stage | Rule |
|---|---|---|
| 1 | Plan | Define goal, scope, exclusions and acceptance criteria |
| 2 | Design | Decide UX and architecture before coding |
| 3 | Implement | Smallest required change |
| 4 | Verify | Run tsc, lint and build |
| 5 | Browser QA | Test the affected workflow and edge cases |
| 6 | Review | Separate review agent checks diff, scope, regressions |
| 7 | Commit | Commit only intended files |
| 8 | Push | Push to GitHub and confirm expected status |

**Decision gate:** Before starting a new feature, compare it against this roadmap and against `lib/toolCatalog.ts` / `components/tools/toolRegistry.tsx`. If a task doesn't support the current phase (Phase 3) or a necessary prerequisite, pause and return to this document. **If a task looks like it belongs to Phase 2, check `docs/PHASE_2_EXIT_REVIEW.md` first — it is very likely already done.**
