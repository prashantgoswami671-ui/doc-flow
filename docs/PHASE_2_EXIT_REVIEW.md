# Phase 2 Exit Review — PDF Reliability & Hardening

Conducted 2026-08-24 by auditing the actual repository (source files +
`toolCatalog.ts`/`toolRegistry.tsx` + git history), not by re-reading prior
status reports. Findings below are what the code on disk actually does as
of commit `337bc975` (`fix: improve watermark preview reliability`,
2026-08-23).

## Queue item 1 — 180° orientation detection fix

**Status: Done, and broadened.** `services/pdf/orientation.ts` no longer
uses the original pixel-density heuristic (see
`docs/archive/orientation-v1-pixel-analysis/`); it now uses OCR at four
candidate rotations via `resolveOcrOrientation`, which is unit-tested
(`orientation.test.ts`, 10 cases) to guarantee inconclusive/tied evidence
resolves to `needs-review`, never to `normal`. This closes a broader bug
class than the original page-9 report — any silent "OCR unsure = treat as
fine" case, not just 180° specifically.

**Gap:** the unit tests exist and are well-written, but `vitest` was
present in `node_modules` while absent from `package.json`/lockfile — no
`npm test` could run them, in this project or in CI. Fixed in this review
(see "Actions taken" below). The manual browser checklist in
`TEST_ORIENTATION_180.html` (upload `test-pdf-orientation.pdf`, confirm
pages 4/9/15) has not been confirmed as actually run against the current
OCR implementation — its expected results are still valid, but execution
against the *current* code is unverified.

## Queue item 2 — Compress PDF: dedicated flow + routing audit

**Status: Done.** `compress-pdf` maps to a real, dedicated `CompressPdfCard`
in `toolRegistry.tsx` — not routed through a generic UploadCard.
`compress.ts` pre-validates the source (encrypted-PDF detection with an
actionable message pointing to Unlock PDF), rejects output that isn't
actually smaller than the input, and Custom mode does a real binary search
against the target size with sane bounds. Light/Heavy/Custom all confirmed
implemented, not stubbed.

## Queue item 3 — Audit all 14 PDF services

**Status: Done — all 14 read and checked against
Input → Processing → Error handling → Output → Edge cases.**

| Tool | Encryption detected w/ clear message | Edge-case validation | Notes |
|---|---|---|---|
| Organize Pages | ✅ | ✅ (delete-all guard, crop-bounds clamp, reorder detection) | Also handles crop coordinate math across rotation/CropBox correctly |
| Extract Pages | ✅ | ✅ (reversed ranges, dup pages, out-of-bounds) | |
| Split PDF | ✅ | ✅ (single-page PDFs rejected, dup/OOB split points) | Re-validates split points against the actually-loaded doc, not just the caller's cached page count |
| Insert Pages | ✅ (both target & source) | ✅ (position bounds) | |
| Merge PDF | ✅ | ✅ (min 2 files, zero-page-total guard) | |
| Image to PDF | n/a (no PDF input) | ✅ (empty image list, embed failure) | |
| PDF to Image | ✅ (via pdf.js load) | ✅ (page bounds, dup selection, JPEG-encode failure) | Per-page resource cleanup in `finally` |
| **Compress PDF** | ✅ | ✅ (see above) | |
| Fix Orientation | ✅ | ✅ | See item 1 |
| Repair & Validate | ✅ (`PasswordProtectedError`) | ✅✅ — 5-strategy fallback pipeline, page-count-mismatch rejection, never trusts `save()` success alone | Strongest file in the repo |
| Metadata | ✅ | n/a (no numeric bounds to violate) | |
| Watermark & Page Numbers | ✅ | ✅ (opacity/font-size/rotation bounds, empty text, clamps to page bounds) | |
| Protect PDF | ✅ (already-encrypted case) | ✅ (empty password) | |
| Unlock PDF | ✅ (probes before decrypting, distinguishes "not protected" from "wrong password") | ✅ | |

Every write-path service shares the same encryption-detection idiom
(explicitly credited in code comments as mirroring `compress.ts`), which is
a good sign of deliberate consistency rather than 14 independently-varying
implementations.

**One inconsistency found:** `rasterize.ts` (the shared engine behind
Compress/Repair raster-salvage) sets
`pdfjsLib.GlobalWorkerOptions.workerSrc` unconditionally, without the
`typeof window !== "undefined"` guard every other pdf.js-consuming service
uses. Not currently reachable outside a browser context in practice (it's
only invoked after a client-side file upload), but it's a latent
inconsistency worth a one-line fix during Phase 3 if `rasterize.ts` is
touched again.

## Queue item 4 — Reliability/edge-case fixes

**Status: Done for the cases exercised by code reading.** Malformed/corrupt
PDFs, encrypted PDFs, empty selections, out-of-range pages, duplicate
pages, reversed ranges, zero-page outputs, and page-count mismatches are
all explicitly handled with actionable errors across the 14 services.
Repair & Validate additionally handles damaged object graphs, missing
catalogs, and orphaned page trees.

**Not verifiable by static reading, and not confirmed done:**
- Actual large-file / many-page performance behavior
- Actual behavior against a real corrupted/malformed PDF file in-browser
  (as opposed to the code paths that are *designed* to handle one)
- Race conditions / cancellation / stale state during an in-flight upload
- Memory behavior over a long session

These require running the app and exercising it, which this audit
(file reading only) cannot do. Flagging as open rather than claiming
false confidence either way.

## Queue item 5 — Metadata + Watermark against the same standard

**Status: Done.** Both confirmed above in the item-3 table. Metadata
correctly treats an empty field as "clear this field" rather than
"leave unchanged." Watermark validates opacity/font-size/rotation ranges,
rejects empty watermark text, and positions text using an actual rotated
bounding-box calculation (not the naive unrotated box) so "Center" stays
centered at 45°/-45°.

## Queue item 6 — Phase 2 exit review

This document. Written 2026-08-24.

## Actions taken during this review

1. Added `vitest` to `package.json` devDependencies and a `test` /
   `test:watch` script — it was physically present in `node_modules` but
   undeclared, so no `npm test` could run and a fresh clone/CI would not
   have had it at all. **You still need to run `npm install` once** to
   reconcile `package-lock.json` with this change (it will not remove
   anything already installed).
2. Moved the five superseded Aug-9 orientation reports into
   `docs/archive/orientation-v1-pixel-analysis/` with a README explaining
   why, since they described a replaced implementation and self-declared
   "ready for production" while their own checklists were unchecked.

## Not addressed (out of scope for Phase 2, flagged for later)

- `erssunitDesktopdoc-flowgit status --short` at the repo root looks like
  an accidentally-created file from a mis-typed terminal command (garbage
  filename). Left in place — not deleted without being asked.
- The roadmap's Phase 8 note that `tesseract.js` is "installed but unused"
  is now **incorrect** — it's the backbone of the current OCR orientation
  detector. Worth correcting in the next roadmap revision (v4).
- `ai_assistant.py`, `agent_filesystem.py`, `coding_agent.py` and the
  `.env` file's NVIDIA key are Phase 4 concerns (confirm separation from
  production bundle), not Phase 2 — untouched here.

## Recommendation

**Phase 2 can reasonably be considered closed.** The service-layer code is
consistently defensive, all 14 tools are for-real wired and implemented,
and the two loose ends found (undeclared test framework, stale docs) are
fixed by this review. The remaining open items (browser QA execution,
performance/race-condition testing) are legitimately Phase 6 (Automated
Testing & CI) territory per the roadmap's own sequencing — Phase 2's job
was to make the code trustworthy, not to build the test infrastructure to
prove it, and the code itself supports that conclusion on inspection.

**One suggested pre-Phase-3 step:** actually run `npm install && npm test`
and open the app once against `test-pdf-orientation.pdf` to close out the
one manual-QA checklist that's never been confirmed against the current
OCR implementation. Five minutes, and it converts "the code looks right"
into "it's verified."
