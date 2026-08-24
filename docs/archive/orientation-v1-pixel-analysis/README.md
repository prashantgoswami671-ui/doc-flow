# Archived — superseded by OCR-based orientation detection

The five reports in this folder (`COMPLETE_IMPLEMENTATION_REPORT.md`,
`QUICK_REFERENCE.md`, `ROOT_CAUSE_ANALYSIS.md`, `CODE_CHANGES_DETAILED.md`,
`IMPLEMENTATION_SUMMARY.md`) all document the **first** fix attempt for the
180° orientation bug, dated August 9, 2026: a canvas pixel-content
distribution heuristic (compare dark-pixel density in the top third vs.
bottom third of a rendered page).

That approach was **replaced**, not extended, by the current implementation
in `services/pdf/orientation.ts` (see the `fix: improve page orientation
detection` commit, Aug 22, 2026), which uses OCR (Tesseract) at four
candidate rotations instead of pixel-density heuristics, and — more
importantly — fixes a broader bug class: inconclusive evidence must resolve
to `needs-review`, never silently to `normal`. See
`services/pdf/orientation.test.ts` for the current, unit-tested decision
logic (`resolveOcrOrientation`).

These reports are kept for history only. They no longer describe the code
in `services/pdf/orientation.ts` and should not be used as a reference for
how orientation detection currently works. They also each self-declared
"✅ READY FOR PRODUCTION" / "✅ READY FOR TESTING" while their own testing
checklists were left unchecked — that status was aspirational, not verified,
and should not be treated as evidence the Aug 9 implementation was
QA'd in-browser.

Moved here (not deleted) on 2026-08-24 during the Phase 2 exit audit.
